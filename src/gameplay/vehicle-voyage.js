// Builder V3-C — the finished Boatyard boat's trips to Tempest Isle (used by raft.js, SPEC §11).
// [R] "Sail to Tempest Isle" at the Boatyard (refused at night or while stormAt(cove) > 0.3): fade, ~1.5 game h,
// the boat is moored at wading depth beside the cove's dock and the player stands on the cove beach.
// At the mooring: [E] "Sail home" (sail-away cinematic -> host.onSailed(), the normal raft:sailed win) and
// [R] "Sail back to the Boatyard". A Tempest Isle storm (> 0.5) can flip the moored raft or sailboat
// ("Your boat was flipped by the storm!"); [E] "Right the boat (1 h)" once stormAt < 0.3. The hard-mode motor
// launch never flips (motorboats don't capsize).
//
// createVoyage(ctx, host) host = {
//   boat() -> { group, spec } | null, planId() -> id, planName() -> string, speed() -> cinematic top speed,
//   site (Vector3), siteInfo() -> { yaw, dirX, dirZ }, fadeTo(to, s) -> Promise,
//   hideYardBoat(), showYardBoat() (colliders + yard pose), onSailed() }
// The Boatyard boat's yaw convention is raft.js's: bow toward local +Z, forward = (sin h, cos h).
import * as V from './vehicle-logic.js';
import { isWorkHour, buildDrain } from './raft-logic.js';
import { createSailAway } from './vehicle-cine.js';
import { CONFIG } from '../config.js';

const CROSS_HOURS = 1.5;
const RIGHT_HOURS = 1;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createVoyage(ctx, host) {
  const IC = ctx.config?.isle2 || CONFIG.isle2;
  const SC = ctx.config?.stats || CONFIG.stats;
  const toast = (text, opts) => ctx.ui?.toast?.(text, opts);
  const play = (name, opts) => ctx.audio?.play?.(name, opts);
  const rand = typeof ctx.rng?.fork === 'function' ? ctx.rng.fork('voyage') : Math.random;
  let away = false, capsized = false, flip = null, busy = false, cine = null, t = 0;
  const moor = { x: 0, z: 0, heading: 0, y: 0 };
  const posTmp = { x: 0, y: 0, z: 0 };

  const LM = () => ctx.world?.landmarks || {};
  const stormAt = (p) => {
    const s = p ? ctx.weather?.stormAt?.(p.x, p.z) : 0;
    return Number.isFinite(s) ? s : 0;
  };
  const canFlip = () => host.planId() !== 'motorboat';
  const playerDist = (p) => {
    const q = ctx.player?.position;
    return q && p ? Math.hypot(p.x - q.x, p.z - q.z) : Infinity;
  };

  async function withFade(fn) {
    busy = true;
    const prev = ctx.flags.cinematic;
    ctx.flags.cinematic = true;
    try {
      await host.fadeTo(1, 0.9);
      if (!ctx.stats?.dead) fn();
      await host.fadeTo(0, 1);
    } finally {
      ctx.flags.cinematic = prev;
      busy = false;
    }
  }

  function refuse(where) {
    if (ctx.vehicles?.current) {
      toast('Get off the raft first.', { icon: '🛶', kind: 'warn', key: 'voyage' });
      return true;
    }
    if (!isWorkHour(ctx.time?.hour ?? 12)) {
      toast('Too dark to sail: wait for dawn (05:00)', { icon: '🌙', kind: 'warn', key: 'voyage' });
      return true;
    }
    if (stormAt(where) > V.RIGHT_STORM) {
      toast('A storm rages over Tempest Isle: wait it out', { icon: '⛈️', kind: 'warn', key: 'voyage' });
      return true;
    }
    return false;
  }

  function drain(hours) {
    ctx.stats?.applyEffects?.(buildDrain(hours, SC, ctx.difficulty), 'work');
  }

  async function sailToIsle() {
    if (busy || away || cine) return;
    const L = LM(), cove = L.isle2Cove, dock = L.isle2Dock;
    if (!cove || !dock || !host.boat()) return;
    if (refuse(cove)) return;
    play('splash', { position: host.site, volume: 0.8 });
    await withFade(() => {
      ctx.time?.skipHours?.(CROSS_HOURS);
      drain(CROSS_HOURS * 0.5);
      if (ctx.stats?.dead) return;
      const m = V.findMooring(ctx.world, dock, -1);
      moor.x = m.x;
      moor.z = m.z;
      moor.heading = Math.atan2(dock.dirX, dock.dirZ); // bow out to sea, toward home
      host.hideYardBoat();
      away = true;
      capsized = false;
      flip = null;
      placeBoat(0);
      ctx.player?.teleport?.(cove.x, cove.z, V.headingTo(cove.x, cove.z, moor.x, moor.z));
    });
    if (!away || ctx.stats?.dead) return;
    toast(`You sail the ${host.planName()} across to Tempest Isle and moor it off the cove. Wade out to it (E) to sail home, or back to the Boatyard (R).`, {
      icon: '⛵',
      kind: 'story',
      duration: 8,
    });
    ctx.events?.emit?.('raft:voyage', { to: 'isle2' });
  }

  async function sailBack() {
    if (busy || !away || cine) return;
    if (refuse(moor)) return;
    await withFade(() => {
      ctx.time?.skipHours?.(CROSS_HOURS);
      drain(CROSS_HOURS * 0.5);
      if (ctx.stats?.dead) return;
      away = false;
      capsized = false;
      flip = null;
      host.showYardBoat();
      const S = host.site, I = host.siteInfo();
      const px = S.x - I.dirX * 4.5, pz = S.z - I.dirZ * 4.5;
      ctx.player?.teleport?.(px, pz, V.headingTo(px, pz, S.x, S.z));
    });
    if (away || ctx.stats?.dead) return;
    toast('Back at the Boatyard, the boat safe on its cradle.', { icon: '⛵', kind: 'good', key: 'voyage' });
    ctx.events?.emit?.('raft:voyage', { to: 'main' });
  }

  async function rightBoat() {
    if (busy || !away || !capsized || flip || cine) return;
    if (!V.canRight(stormAt(moor))) {
      toast('The storm is still raging: wait for it to pass before you try to right the boat.', { icon: '⛈️', kind: 'warn', key: 'voyage' });
      return;
    }
    await withFade(() => {
      ctx.time?.skipHours?.(RIGHT_HOURS);
      drain(RIGHT_HOURS);
      if (ctx.stats?.dead) return;
      capsized = false;
      flip = null;
      placeBoat(0);
    });
    if (capsized || ctx.stats?.dead) return;
    toast('An hour of heaving and bailing later, the boat floats upright again.', { icon: '⛵', kind: 'good', key: 'voyage', duration: 6 });
  }

  function sailHome() {
    if (busy || !away || cine || capsized) return;
    if (refuse(moor)) return;
    const b = host.boat();
    if (!b) return;
    const isle = ctx.world.isle2;
    const x = moor.x, z = moor.z;
    let dx = x / (Math.hypot(x, z) || 1), dz = z / (Math.hypot(x, z) || 1);
    if (isle) {
      const di = Math.hypot(x - isle.x, z - isle.z) || 1;
      dx += (x - isle.x) / di;
      dz += (z - isle.z) / di;
    }
    const engine = host.planId() === 'motorboat';
    ctx.ui?.setPrompt?.(null);
    play('splash', { position: b.group.position, volume: 1 });
    cine = createSailAway(ctx, {
      object: b.group,
      heading: moor.heading + Math.PI, // raft heading -> yaw heading
      target: Math.atan2(-dx, -dz),
      yawOffset: -Math.PI,
      y: (ctx.world.SEA_LEVEL ?? 0) - b.spec.draft,
      vmax: host.speed(),
      speed0: 0.6,
      engine,
      duration: 10.5,
      subtitles: [
        [0.8, 'Tempest Isle shrinks behind you…', 4],
        [5, 'Its storms will have to rage without you.', 3.6],
        [8.3, 'Home is that way.', 3],
      ],
      onDone: () => host.onSailed(),
    });
  }

  function capsize() {
    if (capsized || !away) return;
    capsized = true;
    flip = { t: 0, dur: 1.6, from: 0, to: Math.PI };
    const b = host.boat();
    if (b) play('splash', { position: b.group.position, volume: 1.2 });
    if (playerDist(moor) < 700) toast('Your boat was flipped by the storm!', { icon: '⛈️', kind: 'bad', key: 'voyage-flip', duration: 6 });
    ctx.events?.emit?.('vehicle:capsized', { type: 'boat' });
  }

  function placeBoat(dt) {
    const b = host.boat();
    if (!b) return;
    const g = b.group, sp = b.spec;
    const sea = ctx.world?.SEA_LEVEL ?? 0;
    let wv = Math.sin(t * 1.2) * 0.05;
    const w = ctx.water?.waveHeightAt;
    if (w) {
      try {
        const v = w.call(ctx.water, moor.x, moor.z);
        if (Number.isFinite(v)) wv = v;
      } catch (e) {
        /* keep the fallback */
      }
    }
    const upY = sea - sp.draft + wv, downY = sea + sp.depth * 0.45 + wv;
    let roll = Math.sin(t * 1.1) * 0.04, y = upY;
    if (flip) {
      flip.t += dt;
      const k = clamp01(flip.t / flip.dur), e = k * k * (3 - 2 * k);
      roll = flip.from + (flip.to - flip.from) * e;
      y = upY + (downY - upY) * e + Math.sin(k * Math.PI) * 0.8;
      if (k >= 1) flip = null;
    } else if (capsized) {
      roll = Math.PI + Math.sin(t * 0.9) * 0.03;
      y = downY;
    }
    g.position.set(moor.x, y, moor.z);
    g.rotation.set(Math.sin(t * 1.3) * 0.02, moor.heading, roll);
    moor.y = y;
  }

  function provider() {
    if (!away || busy || cine || flip || ctx.state !== 'playing' || ctx.vehicles?.current) return null;
    const b = host.boat();
    if (!b) return null;
    const d = playerDist(moor);
    if (d > b.spec.length / 2 + 3.5) return null;
    const q = ctx.player.position, yaw = ctx.player.yaw ?? 0;
    const fx = (moor.x - q.x) / (d || 1), fz = (moor.z - q.z) / (d || 1);
    const score = 2.6 + (-Math.sin(yaw) * fx - Math.cos(yaw) * fz) * 0.8;
    if (capsized) {
      const ok = V.canRight(stormAt(moor));
      return { label: ok ? 'Right the boat (1 h)' : 'Right the boat (wait for the storm to pass)', onUse: rightBoat, score };
    }
    return {
      label: isWorkHour(ctx.time?.hour ?? 12) ? 'Sail home' : 'Too dark to sail: wait for dawn',
      onUse: sailHome,
      secondary: { label: 'Sail back to the Boatyard', onUse: sailBack },
      score,
    };
  }

  return {
    get away() {
      return away;
    },
    get capsized() {
      return capsized;
    },
    /** A fade or the sail-away cinematic is running. */
    get active() {
      return busy || !!cine;
    },
    /** Where the boat is moored at Tempest Isle (valid while away). */
    get position() {
      posTmp.x = moor.x;
      posTmp.y = moor.y;
      posTmp.z = moor.z;
      return posTmp;
    },
    sailToIsle,
    sailBack,
    debugCapsize: capsize,
    init() {
      ctx.interact?.addProvider?.(provider);
    },
    update(dt) {
      t += dt;
      if (cine) {
        cine.update(dt);
        if (cine.done) cine = null;
        return;
      }
      if (!away) return;
      if (!capsized && !busy && canFlip()) {
        const s = stormAt(moor);
        if (s > V.CAPSIZE_STORM && rand() < V.capsizeChance(s, dt, IC.capsizePerSec)) capsize();
      }
      placeBoat(dt);
    },
  };
}
