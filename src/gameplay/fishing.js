// Fishing minigame (V4-C, SPEC §12 "Fishing (C)"). ctx.fishing.
// With a fishing_rod, looking at ocean / lake / river water from land, the Tempest Isle dock or a raft / boat:
// "[E] Cast the line" / "[R] Cast the line" (fresh water: R only unless the rod is selected, so drinking keeps E;
// aboard: only when the rod is the selected hotbar item, so the vehicle prompt stays). The float flies out with a plop,
// nibbles dip it (false alarms), then the BITE: "!" + splash + chime, press `reel` (Space / click) within hookWindowSec;
// then the FIGHT: tap reel for progress + tension, the fish runs in bursts (progress drains, the rod tip bends),
// tension ≥ 1 snaps the line (15 % rod loss on a Yellowfin), the timer runs out → it escapes, progress ≥ 1 → landed:
// loot per CONFIG.fishing.loot (+ the rare lore bottle from the old isle2 fishing), toast, 'harvest' {id, n:1, kind:'fishing'}.
// Movement cancels; R while active = "Reel in" (cancel). The rules live in fishing-logic.js (pure, tested).
//
// API: { active, phase, progress, tension, timeLeft, nibble, run, fighting, loot, cast(), reel(), cancel(), provider,
//        setDockTest(fn), state, init(), update(dt), debug: { bite(), catch(), snap() } }
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ITEMS } from '../core/items.js';
import { createFishingLogic, BOTTLE_ID, isFish } from './fishing-logic.js';
import { BOTTLE_MESSAGES } from '../isle2/isle2-logic.js';
import { buildFloat } from '../isle2/isle2-models.js';

const CAST_RANGE = [2.5, 14]; // m from the eye to where the float lands
const SPOT_CACHE_S = 0.12;
const MOVE_CANCEL_M = 0.9; // walking this far from the cast spot reels in
const VEHICLE_CANCEL_SPEED = 0.8; // paddling / motoring this fast reels in

const CATCH_TEXT = {
  raw_fish: 'A Reef Fish! Dinner, once it is grilled.',
  big_fish: 'A Yellowfin! It fought like a demon.',
  crab: 'A Rock Crab, snapping angrily at the hook.',
  old_boot: 'You reel in… an old boot. Classic.',
  rope: 'A length of rope, still good.',
  cloth: 'A strip of sailcloth, snagged on the hook.',
  hull_plank: 'A hull plank from the Marguerite, snagged on your hook!',
  wood: 'A piece of driftwood.',
  bottle_empty: 'An empty bottle. Still useful.',
};
const LOST_TEXT = {
  snap: { text: 'SNAP! The line breaks and the fish is gone.', icon: '💥', kind: 'bad' },
  escaped: { text: 'The fish shook the hook and swam off.', icon: '🐟', kind: 'warn' },
  gone: { text: 'Too slow… it spat the hook out.', icon: '🎣', kind: 'warn' },
  early: { text: 'Too early! You jerked the line and spooked it.', icon: '🎣', kind: 'warn' },
  moved: { text: 'You moved: the line goes slack. Reeled in.', icon: '🎣' },
  cancel: { text: 'You reel in the line. Nothing on the hook.', icon: '🎣' },
  water: { text: 'You are in the water: the line goes slack.', icon: '🎣' },
  norod: { text: 'No rod, no fishing.', icon: '🎣' },
};

export function create(ctx) {
  const F = CONFIG.fishing || {};
  const W = ctx.world;
  const rand = ctx.rng?.fork?.('fishing') || Math.random;
  const logic = createFishingLogic(F, rand);
  const S = logic.state;

  const _cam = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _tip = new THREE.Vector3();
  const _pos = new THREE.Vector3();
  const spot = { ok: false, x: 0, z: 0, surface: 0, fresh: false, type: 'ocean' };
  let spotAge = 1;
  // the live cast: where the float sits, where we stood, which vehicle we were on
  const cast_ = { x: 0, z: 0, surface: 0, fresh: false, fromX: 0, fromZ: 0, vehicle: null };
  let clock = 0, lastCastAt = -10, shown = false, msgIndex = 0, bend = 0, firstCast = true;
  let dockTest = null;

  // ── Meshes: float, line (2 segments with a sag), a camera-attached rod with a bending tip ────────────────
  let floatMesh = null, line = null, linePos = null, rod = null, rodUpper = null, rodTip = null;
  try {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true });
    floatMesh = new THREE.Mesh(buildFloat(rand), mat);
    floatMesh.name = 'fishing-float';
    floatMesh.visible = false;
    floatMesh.frustumCulled = false;
    const lineGeo = new THREE.BufferGeometry();
    linePos = new Float32Array(12); // tip → mid, mid → float
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
    line = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xe8e8e0, transparent: true, opacity: 0.55 }));
    line.frustumCulled = false;
    line.visible = false;
    line.name = 'fishing-line';
    ctx.scene?.add?.(floatMesh, line);

    const wood = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.8 });
    rod = new THREE.Group();
    rod.name = 'fishing-rod';
    const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.014, 0.7, 6), wood);
    lower.position.y = 0.35;
    rod.add(lower);
    const reelM = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 8), wood);
    reelM.rotation.z = Math.PI / 2;
    reelM.position.set(0.03, 0.18, 0);
    rod.add(reelM);
    rodUpper = new THREE.Group();
    rodUpper.position.y = 0.7;
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.009, 0.6, 5), wood);
    upper.position.y = 0.3;
    rodUpper.add(upper);
    rodTip = new THREE.Object3D();
    rodTip.position.y = 0.6;
    rodUpper.add(rodTip);
    rod.add(rodUpper);
    rod.position.set(0.32, -0.42, -0.55);
    rod.rotation.set(-1.0, 0.15, -0.25);
    rod.visible = false;
    rod.traverse((o) => (o.frustumCulled = false));
    ctx.camera?.add?.(rod);
  } catch (e) {
    console.error('[fishing] meshes failed', e);
  }

  // ── Where would the line land? (cached briefly) ─────────────────────────────────────────────────────────
  function findSpot(force) {
    if (!force && spotAge < SPOT_CACHE_S) return spot.ok ? spot : null;
    spotAge = 0;
    spot.ok = false;
    if (!W?.waterAt || !ctx.camera) return null;
    ctx.camera.getWorldPosition(_cam);
    ctx.camera.getWorldDirection(_dir);
    if (_dir.y > 0.06) return null;
    const [r0, r1] = CAST_RANGE;
    if (_dir.y < -0.03) {
      for (let t = r0; t <= r1; t += 0.5) {
        const x = _cam.x + _dir.x * t, y = _cam.y + _dir.y * t, z = _cam.z + _dir.z * t;
        if (W.heightAt(x, z) > y) return null; // the ray hits the ground first
        const w = W.waterAt(x, z);
        if (w && y <= w.surface + 0.2) return setSpot(x, z, w);
      }
    }
    // near-horizontal: lob it ~9 m ahead
    const hl = Math.hypot(_dir.x, _dir.z) || 1;
    const x = _cam.x + (_dir.x / hl) * 9, z = _cam.z + (_dir.z / hl) * 9;
    const w = W.waterAt(x, z);
    if (w && _cam.y - w.surface < 6) return setSpot(x, z, w);
    return null;
  }
  function setSpot(x, z, w) {
    if (!(w.depth > 0.4)) return null;
    spot.ok = true;
    spot.x = x;
    spot.z = z;
    spot.surface = w.surface;
    spot.fresh = !!w.fresh;
    spot.type = w.type || 'ocean';
    return spot;
  }
  const onDock = (p) => !!(dockTest?.(p.x, p.z, p.y) || ctx.isle2?.isOnDock?.(p.x, p.z, p.y));
  /** From land (beach / shore / bank), the dock, or aboard a raft / boat. Never while swimming. */
  function standingOk(p) {
    const pl = ctx.player || {};
    if (pl.swimming || pl.inWater || pl.diving || pl.headUnderwater) return false;
    if (pl.aboard || ctx.vehicles?.current) return !ctx.vehicles?.current?.capsized;
    if (onDock(p)) return true;
    if (!W) return false;
    const b = W.biomeAt?.(p.x, p.z);
    if (b && b.sand > 0.3) return true;
    if ((W.coastDistance?.(p.x, p.z) ?? 99) < 7) return true;
    for (const l of W.lakes || []) if (Math.hypot(p.x - l.x, p.z - l.z) < (l.waterRadius ?? l.r) + 7) return true;
    const rv = W.riverAt?.(p.x, p.z);
    return !!rv && rv.d < rv.w + 5;
  }

  // ── Interact provider ───────────────────────────────────────────────────────────────────────────────────
  function provider(c) {
    if (c.state !== 'playing' || c.flags?.cinematic) return null;
    if (S.phase !== 'idle') {
      if (S.phase === 'landed' || S.phase === 'lost') return null;
      // secondary-only: Mouse0 stays the reel key (interact ignores a candidate without a primary label)
      return { label: '', secondary: { label: S.phase === 'fight' ? 'Give up' : 'Reel in', onUse: () => cancel('cancel') }, score: 9 };
    }
    if (!c.inventory?.has?.('fishing_rod')) return null;
    const p = c.player?.position;
    if (!p || !standingOk(p)) return null;
    const s = findSpot();
    if (!s) return null;
    const selected = c.inventory.selected === 'fishing_rod';
    const aboard = !!(c.player?.aboard || c.vehicles?.current);
    if (aboard && !selected) return null;
    const sec = { label: 'Cast the line', onUse: cast };
    if (s.fresh && !selected) return { label: '', secondary: sec, score: 0.5 };
    return { label: 'Cast the line', onUse: cast, secondary: sec, score: selected ? 1.6 : 0.65 };
  }

  // ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────
  const toast = (text, opts) => ctx.ui?.toast?.(text, opts);
  const play = (name, opts) => ctx.audio?.play?.(name, opts);

  function cast() {
    if (S.phase !== 'idle' || clock - lastCastAt < 0.6) return false;
    if (ctx.state !== 'playing' || ctx.flags?.cinematic) return false;
    if (!ctx.inventory?.has?.('fishing_rod')) return false;
    const p = ctx.player?.position;
    if (!p || !standingOk(p)) return false;
    const s = findSpot(true);
    if (!s) return false;
    lastCastAt = clock;
    cast_.x = s.x;
    cast_.z = s.z;
    cast_.surface = s.surface;
    cast_.fresh = s.fresh;
    cast_.fromX = p.x;
    cast_.fromZ = p.z;
    cast_.vehicle = ctx.vehicles?.current ?? ctx.player?.aboard ?? null;
    logic.cast();
    show(true);
    bend = 0.05;
    play('whoosh', { volume: 0.35 });
    toast('You cast the line… wait for a bite.', { icon: '🎣', duration: 2.5, key: 'fishing' });
    if (firstCast) {
      firstCast = false;
      ctx.ui?.hint?.('fishing', 'Fishing: wait for the BITE (the float dips hard and a ! appears), then press Space. Tap Space to reel in, but let the tension bar drop when the fish runs or the line snaps. R reels in.');
    }
    return true;
  }
  function reel() {
    return logic.reel();
  }
  function cancel(reason = 'cancel') {
    return logic.cancel(reason);
  }
  function show(on) {
    if (shown === on) return;
    shown = on;
    if (rod) rod.visible = on;
    if (floatMesh) floatMesh.visible = on;
    if (line) line.visible = on;
  }

  function land() {
    const r = S.result;
    if (!r) return;
    let id = r.loot, text = CATCH_TEXT[id], kind = 'good', icon = ITEMS[id]?.icon, bottle = false;
    if (id === BOTTLE_ID) {
      id = 'bottle_empty';
      bottle = true;
      icon = '📜';
      kind = 'story';
      text = 'A message in a bottle!';
    }
    if (!ITEMS[id]) return;
    const added = ctx.inventory?.add?.(id, 1);
    if (typeof added === 'number' && added < 1) {
      const p = ctx.player?.position;
      if (p) ctx.resources?.spawnItem?.(id, p.x + 0.6, p.z + 0.4, 1);
    }
    floatMesh?.getWorldPosition?.(_pos);
    play('splash', { position: floatMesh ? _pos : undefined, volume: 0.5 });
    if (id === 'big_fish') play('chime', { volume: 0.5 });
    toast(text || `You reel in: ${ITEMS[id].name}`, { icon, kind, duration: isFish(id) ? 3.5 : 3 });
    if (bottle) {
      const msg = BOTTLE_MESSAGES[msgIndex < BOTTLE_MESSAGES.length ? msgIndex : Math.floor(rand() * BOTTLE_MESSAGES.length)];
      msgIndex++;
      if (ctx.ui?.subtitle) ctx.ui.subtitle(msg, 9);
      else toast(msg, { icon: '📜', kind: 'story', duration: 9 });
    }
    ctx.events?.emit?.('harvest', { id, n: 1, kind: 'fishing', size: r.size });
  }
  function lost() {
    const r = S.result;
    const L = LOST_TEXT[r?.reason] || LOST_TEXT.cancel;
    toast(L.text, { icon: L.icon, kind: L.kind || 'info', key: 'fishing', duration: 3 });
    if (r?.reason === 'snap') {
      floatMesh?.getWorldPosition?.(_pos);
      play('impact', { position: floatMesh ? _pos : undefined, volume: 0.35 });
      if (r.rodLost && ctx.inventory?.remove?.('fishing_rod', 1)) {
        toast('The rod snapped too. Only a stub is left in your hands.', { icon: '🎣', kind: 'bad', duration: 4.5 });
        ctx.events?.emit?.('fishing:rodLost', {});
      }
    }
  }

  function handleEvents() {
    const ev = S.events;
    if (!ev.length) return;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i];
      if (floatMesh) floatMesh.getWorldPosition(_pos);
      switch (e) {
        case 'plop':
          play('splash', { position: _pos, volume: 0.3 });
          break;
        case 'nibble':
          play('splash', { position: _pos, volume: 0.15 });
          break;
        case 'bite':
          play('splash', { position: _pos, volume: 0.6 });
          play('chime', { volume: 0.45 });
          break;
        case 'hooked':
          play('craft', { volume: 0.3 });
          break;
        case 'run':
          play('splash', { position: _pos, volume: 0.25 });
          break;
        case 'landed':
          land();
          break;
        case 'lost':
          lost();
          break;
        case 'idle':
          show(false);
          break;
      }
    }
    ev.length = 0;
  }

  // ── Per frame ───────────────────────────────────────────────────────────────────────────────────────────
  const input = { reel: false, cancel: false, moved: false };
  function update(dt) {
    clock += dt;
    spotAge += dt;
    if (S.phase === 'idle') return;
    if (ctx.state === 'dead' || ctx.state === 'rescued' || ctx.state === 'title') {
      logic.cancel('cancel');
      S.events.length = 0;
      show(false);
      return;
    }
    if (ctx.state !== 'playing') return; // paused: freeze
    const pl = ctx.player || {};
    const p = pl.position;
    const active = S.phase !== 'landed' && S.phase !== 'lost';
    input.reel = input.cancel = input.moved = false;
    if (active) {
      if (pl.swimming || pl.inWater || pl.headUnderwater) logic.cancel('water');
      else if (!ctx.inventory?.has?.('fishing_rod')) logic.cancel('norod');
      else if (cast_.vehicle) {
        const cur = ctx.vehicles?.current ?? pl.aboard ?? null;
        if (cur !== cast_.vehicle || Math.abs(cast_.vehicle.speed ?? 0) > VEHICLE_CANCEL_SPEED || cast_.vehicle.capsized) input.moved = true;
      } else if (p && Math.hypot(p.x - cast_.fromX, p.z - cast_.fromZ) > MOVE_CANCEL_M) input.moved = true;
      if (!ctx.ui?.menuOpen && !ctx.flags?.cinematic && ctx.input?.wasPressed?.('reel')) input.reel = true;
    }
    logic.tick(dt, input);
    handleEvents();
    if (S.phase === 'idle') return;

    // float + line + rod bend
    const T = clock;
    const ph = S.phase;
    let fx = cast_.x, fz = cast_.z, fy = cast_.surface + 0.02 + Math.sin(T * 2.3) * 0.02;
    if (ph === 'waiting') {
      fy -= 0.1 * S.nibble;
      if (S.flying && rodTip) {
        rodTip.getWorldPosition(_tip);
        const k = Math.min(1, S.t / 0.6);
        fx = _tip.x + (cast_.x - _tip.x) * k;
        fz = _tip.z + (cast_.z - _tip.z) * k;
        fy = _tip.y + (cast_.surface - _tip.y) * k + Math.sin(k * Math.PI) * 1.2;
      }
    } else if (ph === 'bite') fy = cast_.surface - 0.14 + Math.sin(T * 19) * 0.05;
    else if (ph === 'fight') {
      const wob = S.run ? 0.9 : 0.35;
      fx += Math.sin(T * 1.7) * wob;
      fz += Math.cos(T * 1.3) * wob;
      fy = cast_.surface - 0.12 - S.tension * 0.1 + Math.sin(T * 11) * 0.04;
    } else if (ph === 'landed') fy = cast_.surface + 0.3 + S.t * 0.4; // lifted out
    if (floatMesh) floatMesh.position.set(fx, fy, fz);
    const target = ph === 'fight' ? 0.25 + 0.9 * S.tension + (S.run ? 0.35 : 0) : ph === 'bite' ? 0.45 : 0.05;
    bend += (target - bend) * Math.min(1, dt * 9);
    if (rodUpper) rodUpper.rotation.x = -bend * 0.9;
    if (rodTip && linePos) {
      rodTip.getWorldPosition(_tip);
      const sag = ph === 'waiting' ? -0.25 : -0.05 * (1 - S.tension);
      const mx = (_tip.x + fx) * 0.5, my = (_tip.y + fy + 0.1) * 0.5 + sag, mz = (_tip.z + fz) * 0.5;
      linePos[0] = _tip.x;
      linePos[1] = _tip.y;
      linePos[2] = _tip.z;
      linePos[3] = linePos[6] = mx;
      linePos[4] = linePos[7] = my;
      linePos[5] = linePos[8] = mz;
      linePos[9] = fx;
      linePos[10] = fy + 0.1;
      linePos[11] = fz;
      line.geometry.attributes.position.needsUpdate = true;
    }
  }

  function init() {
    ctx.interact?.addProvider?.(provider);
  }

  return {
    init,
    update,
    cast,
    reel,
    cancel,
    provider,
    state: S,
    /** The dock test from isle2 (x, z, y) → bool; isle2-fishing.js hands it over. */
    setDockTest(fn) {
      dockTest = typeof fn === 'function' ? fn : null;
    },
    get active() {
      return S.phase !== 'idle';
    },
    get fighting() {
      return S.phase === 'bite' || S.phase === 'fight';
    },
    get phase() {
      return S.phase;
    },
    get progress() {
      return S.progress;
    },
    get tension() {
      return S.tension;
    },
    get timeLeft() {
      return S.timeLeft;
    },
    get nibble() {
      return S.nibble;
    },
    get run() {
      return S.run;
    },
    get flying() {
      return S.flying;
    },
    get loot() {
      return S.loot;
    },
    get spot() {
      return S.phase === 'idle' ? null : cast_;
    },
    debug: {
      /** Skip the wait: the fish bites now. */
      bite() {
        if (S.phase === 'idle') cast();
        if (S.phase === 'waiting') {
          S.flying = false;
          S.t = S.biteAt;
        }
      },
      /** Land the catch now (optionally a given loot id). */
      catch(id) {
        if (S.phase === 'idle') cast();
        if (id) S.loot = id;
        if (S.phase === 'waiting' || S.phase === 'bite') {
          S.phase = 'fight';
          S.timeLeft = 5;
        }
        if (S.phase === 'fight') {
          S.progress = 0.999;
          S.tension = 0;
          logic.reel();
          handleEvents();
        }
      },
      snap() {
        if (S.phase === 'fight') {
          S.tension = 0.999;
          logic.reel();
          handleEvents();
        }
      },
    },
  };
}
