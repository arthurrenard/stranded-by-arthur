// Rescue (Builder F): the search party. Schedules the passes (CONFIG.rescue.passes in absolute game
// hours, then one every repeatEveryHours with closeness 1), flies the helicopter / sails the search
// boat along their routes (rescueLogic.js math, rescueVehicles.js rigs), integrates the attention
// meter, handles waving (G), flares (flare:fired), slept-through passes and the "spotted" cinematic
// that ends the game with rescue:success { method, passes, kind }.
//
// Events out: rescue:passStart {kind, index, closeness, debug}, rescue:passEnd {kind, index, spotted},
//             rescue:spotted {kind, method}, rescue:success {method, passes, kind}.
// Events in:  time:set (re-sync the schedule), time:skip (passes starting during a sleep are missed),
//             flare:fired {position}.
// Flags:      writes ctx.flags.waving (G held) and ctx.flags.cinematic (spotted cutscene only).
// API:        { activePass (live getter, null when none), attention (0..1), passes, nextPassHours(),
//               debugStartPass(kind = 'helicopter') }
//   nextPassHours() = game hours UNTIL the next scheduled pass starts (0 if it is due now).
import * as THREE from 'three';
import * as L from './rescueLogic.js';
import { createHeliRig, createBoatRig } from './rescueVehicles.js';
import { createArm, getStoryLights } from './models.js';
import { createFlareFx } from './flareFx.js';
import { mulberry32 } from '../core/rng.js';

const ICON = { helicopter: '🚁', boat: '🚤' };
const LOOP = { helicopter: 'rotor', boat: 'engine' };
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => clamp(v, 0, 1);
const smooth = (u) => {
  u = clamp01(u);
  return u * u * (3 - 2 * u);
};
const wrapAngle = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
const damp = (k, dt) => 1 - Math.exp(-k * dt);

export function create(ctx) {
  const R = ctx.config?.rescue || { passes: [], repeatEveryHours: 7, spotThreshold: 100 };
  const THR = R.spotThreshold || 100;
  const world = ctx.world;
  const SEA = world?.SEA_LEVEL ?? 0;

  let built = false;
  let heli = null, boat = null, fx = null, lights = null, coastTable = null, arms = null;
  let nextIndex = null; // index of the next scheduled pass (rescueLogic.passDef)
  let heldBack = false; // the due pass was blocked by an active pass / cinematic / sleep (not a time jump)
  let pass = null; // the active pass (see startPass)
  let passesSeen = 0, debugCount = 0;
  let sleepNote = null; // { kinds, wait } toast shown after waking up
  let loopsOn = false;
  let rescued = false;
  let hazyHintShown = false, hopelessHintShown = false; // v3 one-time difficulty hints
  const watched = []; // fired flares: { h (flareFx handle), seen }

  // scratch (no per-frame allocations)
  const o = {};
  const eye = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
  const spotTarget = new THREE.Vector3(0, -600, 0);
  const pInfo = { d: 0, open: true, exposed: false, waving: false, underwater: false, daylight: 1, inSpotlight: false, sheltered: false, fromBoat: false, vis: 1 };
  const sigList = [], sigPool = [];
  const parts = {};
  const env = { t: 1, open: true, exposed: false };
  const heliOpts = { spot: 0, spotTarget, rain: 0, wash: 0, rotor: 1 };
  const boatOpts = { speed: 0, spot: 0, spotTarget, rain: 0 };

  const ground = (x, z) => Math.max(world.heightAt(x, z), SEA);
  const coastR = (a) => (coastTable ? L.coastRadiusAt(coastTable, a) : 300);
  const toast = (text, opts) => ctx.ui?.toast?.(text, opts);

  function sampleCoast(a) {
    const cx = Math.cos(a), cz = Math.sin(a);
    for (let r = 520; r > 40; r -= 4) if (world.heightAt(cx * r, cz * r) > SEA + 0.2) return r;
    return 60;
  }

  function playerEye(out) {
    const p = ctx.player;
    if (p?.eyePosition) p.eyePosition(out);
    else if (p?.position) out.copy(p.position).setY(p.position.y + 1.6);
    else out.copy(ctx.camera.position);
    return out;
  }
  const playerPos = () => ctx.player?.position || ctx.camera.position;

  function passRand(def) {
    if (!def.debug) {
      const f = ctx.rng?.fork?.('rescue:' + def.index);
      if (typeof f === 'function') return f;
      return mulberry32((0x5eed + def.index * 7919) >>> 0);
    }
    return mulberry32((Math.random() * 4294967296) >>> 0);
  }

  // ── Audio loops ──────────────────────────────────────────────────────────
  function setLoop(kind, vol, pos) {
    if (vol > 0) loopsOn = true;
    ctx.audio?.setLoop?.(LOOP[kind], vol, pos);
  }
  function silenceLoops() {
    if (!loopsOn) return;
    loopsOn = false;
    ctx.audio?.setLoop?.('rotor', 0);
    ctx.audio?.setLoop?.('engine', 0);
  }

  // ── Passes ───────────────────────────────────────────────────────────────
  function startPass(def) {
    const kind = def.kind === 'boat' ? 'boat' : 'helicopter';
    // v3 difficulty (read lazily, per pass): medium = hard to see, hard = never seen + passes stay far out
    const D = L.difficultyRescue(ctx.difficulty);
    const c = L.passCloseness(clamp01(def.closeness ?? 0.5), D.mul);
    const pp = playerPos();
    const rand = passRand(def);
    // same draw order as the balance simulation in tests/rescue.test.mjs
    const duration = L.passDuration(c, rand());
    const route = kind === 'boat' ? L.boatRoute(rand, c, pp.x, pp.z, coastR) : L.heliRoute(rand, c, pp.x, pp.z);
    const path = L.makePath(route.pts);
    const rig = kind === 'boat' ? boat : heli;
    L.samplePath(path, 0, o);
    const g = rig.group;
    const alt = route.alt ?? 0;
    g.position.set(o.x, kind === 'boat' ? SEA : ground(o.x, o.z) + alt, o.z);
    const yaw = Math.atan2(-o.dx, -o.dz);
    g.rotation.set(0, yaw, 0);
    rig.show(true);
    if (kind === 'helicopter') heli.setLadder(0);
    passesSeen++;
    spotTarget.set(o.x, ground(o.x, o.z), o.z);
    pass = {
      index: def.index,
      kind,
      closeness: c,
      at: def.at,
      scripted: !!def.scripted,
      debug: !!def.debug,
      rig,
      path,
      alt,
      duration,
      speed0: path.length / Math.max(1, duration),
      speed: 0,
      dist: 0,
      t: 0,
      position: g.position,
      yaw,
      yawRate: 0,
      roll: 0,
      attention: 0,
      maxAttention: 0,
      rescueMul: D.mul,
      flareRange: D.flareRange,
      closest: Infinity,
      totals: Object.fromEntries(L.METHODS.map((k) => [k, 0])),
      openTime: 0,
      waved: false,
      hadSignalFire: false,
      hadNightLight: false,
      night: (ctx.time?.daylight ?? 1) < 0.3,
      turnToast: false,
      spotted: false,
      method: null,
      cine: null,
      get progress() {
        return this.path.length > 0 ? clamp01(this.dist / this.path.length) : 1;
      },
      get attentionFrac() {
        return clamp01(this.attention / THR);
      },
    };
    const b = L.bearingName(o.x - pp.x, o.z - pp.z);
    const text = kind === 'boat' ? `A boat engine… A search boat, somewhere to the ${b}!` : `You hear a helicopter! It's coming from the ${b}.`;
    toast(text, { icon: ICON[kind], kind: 'story', duration: 6, key: 'rescue' });
    if (D.hazy && !hazyHintShown) {
      hazyHintShown = true;
      toast(L.difficultyHint(D.mul), { icon: '🌫️', kind: 'warn', duration: 10, key: 'rescue-diff' });
    }
    ctx.events.emit('rescue:passStart', { kind, index: def.index, closeness: c, debug: !!def.debug });
    return pass;
  }

  function endPass(silent = false) {
    const p = pass;
    if (!p) return;
    pass = null;
    p.rig.show(false);
    p.rig.off();
    if (p.kind === 'helicopter') heli.setLadder(0);
    setLoop(p.kind, 0, p.position);
    ctx.events.emit('rescue:passEnd', { kind: p.kind, index: p.index, spotted: !!p.spotted });
    if (silent || p.spotted) return;
    if (p.rescueMul <= 0) {
      // hard: they can't see you at all; say it once, then let the passes drift by in silence
      if (!hopelessHintShown) {
        hopelessHintShown = true;
        toast(L.difficultyHint(0), { icon: '🧭', kind: 'story', duration: 10, key: 'rescue' });
      }
      return;
    }
    const text = L.missHint({
      kind: p.kind,
      night: p.night,
      wasOpen: p.openTime >= 0.4 * p.t,
      waved: p.waved,
      hadSignalFire: p.hadSignalFire,
      hadNightLight: p.hadNightLight,
      hasFlare: !!ctx.inventory?.has?.('flare'),
      maxAttention: p.maxAttention,
      threshold: THR,
      closest: p.closest,
      flareRange: p.flareRange,
    });
    toast(text, { icon: ICON[p.kind], kind: 'warn', duration: 9, key: 'rescue' });
  }

  function updateSchedule() {
    const now = ctx.time?.hoursTotal;
    if (typeof now !== 'number' || !Number.isFinite(now)) return;
    if (nextIndex == null) nextIndex = L.firstPassIndexAfter(now, R);
    if (pass || rescued || ctx.flags.cinematic || ctx.flags.sleeping) {
      // a due pass waiting for the current one to finish is started as soon as possible, however late
      if (!rescued && now >= L.passDef(nextIndex, R).at) heldBack = true;
      return;
    }
    const def = L.passDef(nextIndex, R);
    if (now < def.at) {
      heldBack = false;
      return;
    }
    nextIndex++;
    const wasHeld = heldBack;
    heldBack = false;
    if (wasHeld || now - def.at <= 1.5) startPass(def); // passes jumped over (debug speed) are dropped silently
  }

  function onSkip(e) {
    if (rescued) return;
    const from = Number(e?.from), to = Number(e?.to ?? ctx.time?.hoursTotal);
    if (!(to > from)) return;
    if (nextIndex == null) nextIndex = L.firstPassIndexAfter(from, R);
    const kinds = [];
    if (pass && !pass.spotted) {
      kinds.push(pass.kind);
      endPass(true);
    }
    for (let n = 0; n < 64; n++) {
      const d = L.passDef(nextIndex, R);
      if (d.at > to) break;
      nextIndex++;
      if (d.at > from - 1.5) {
        kinds.push(d.kind);
        passesSeen++;
      }
    }
    heldBack = false;
    if (kinds.length) sleepNote = { kinds: sleepNote ? sleepNote.kinds.concat(kinds) : kinds, wait: 2.2 };
  }

  // ── Attention ────────────────────────────────────────────────────────────
  function updateEnv(dt) {
    env.t += dt;
    if (env.t < 0.25) return;
    env.t = 0;
    const pp = playerPos();
    const canopy = ctx.flora?.canopyAt?.(pp.x, pp.z) ?? 0;
    env.open = !(canopy >= 0.4);
    const b = world.biomeAt?.(pp.x, pp.z);
    const s = world.summit;
    const nearSummit = s ? Math.hypot(pp.x - s.x, pp.z - s.z) < (s.plateauR || 15) + 12 : false;
    env.exposed = (b?.sand ?? 0) > 0.45 || nearSummit;
  }

  /** Fills sigList with the active ctx.signals as seen from vp; flags fire / night-light use on the pass. */
  function collectSignals(p, vp, night) {
    sigList.length = 0;
    const sigs = ctx.signals;
    if (sigs) {
      for (const s of sigs) {
        if (!s || !s.position) continue;
        let active = true;
        try {
          active = typeof s.isActive === 'function' ? !!s.isActive() : s.active !== false;
        } catch {
          active = false;
        }
        if (!active) continue;
        if (s.kind === 'signal_fire') p.hadSignalFire = true;
        if (night && (s.kind === 'campfire' || s.kind === 'torch' || s.kind === 'signal_fire')) p.hadNightLight = true;
        if (!L.SIGNAL_WEIGHT[s.kind]) continue;
        const e = sigPool[sigList.length] || (sigPool[sigList.length] = { kind: '', d: 0, strength: 0 });
        e.kind = s.kind;
        e.d = vp.distanceTo(s.position);
        e.strength = Number(s.strength) || 0;
        sigList.push(e);
      }
    }
    if (night && ctx.flags.torchLit) p.hadNightLight = true;
  }

  const spotAmount = () => clamp01((0.42 - (ctx.time?.daylight ?? 1)) / 0.25);

  function updatePass(dt) {
    const p = pass;
    const g = p.rig.group;
    const isHeli = p.kind === 'helicopter';
    p.t += dt;
    // ── move along the route (the crew slows down once they half-notice something)
    const sf = L.speedFactor(p.attention, THR);
    p.speed = p.speed0 * sf;
    p.dist += p.speed * dt;
    L.samplePath(p.path, p.path.length > 0 ? p.dist / p.path.length : 1, o);
    g.position.x = o.x;
    g.position.z = o.z;
    if (isHeli) {
      const gHere = ground(o.x, o.z);
      const gAhead = Math.max(gHere, ground(o.x + o.dx * 45, o.z + o.dz * 45), ground(o.x + o.dx * 90, o.z + o.dz * 90));
      const yT = Math.max(gHere + p.alt, gAhead + 38);
      g.position.y += (yT - g.position.y) * damp(0.9, dt);
    } else {
      g.position.y = SEA - 0.05 + 0.12 * Math.sin(p.t * 1.3);
    }
    const yawT = Math.atan2(-o.dx, -o.dz);
    const step = wrapAngle(yawT - p.yaw) * damp(isHeli ? 1.8 : 1.2, dt);
    p.yaw = wrapAngle(p.yaw + step);
    p.yawRate = dt > 0 ? step / dt : 0;
    if (isHeli) {
      p.roll += (clamp(p.yawRate * 0.6, -0.38, 0.38) - p.roll) * damp(2, dt);
      g.rotation.set(-0.05 - 0.12 * sf, p.yaw, p.roll);
    } else {
      p.roll += (clamp(p.yawRate * 0.25, -0.08, 0.08) - p.roll) * damp(2, dt);
      g.rotation.set(0.035 + 0.02 * Math.sin(p.t * 1.1), p.yaw, p.roll + 0.03 * Math.sin(p.t * 0.83));
    }

    // ── searchlight at night: sweeps, then drifts onto the player as attention builds
    const pp = playerPos();
    const spot = spotAmount();
    let inSpot = false;
    if (spot > 0) {
      let tx, tz;
      if (isHeli) {
        const fx_ = -Math.sin(p.yaw), fz_ = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
        const sw = Math.sin(p.t * 0.55) * 38;
        tx = g.position.x + fx_ * 30 + rx * sw;
        tz = g.position.z + fz_ * 30 + rz * sw;
      } else {
        const l = Math.hypot(g.position.x, g.position.z) || 1;
        const cx = -g.position.x / l, cz = -g.position.z / l; // toward the island
        const reach = 95 + 45 * Math.sin(p.t * 0.4);
        const sw = Math.sin(p.t * 0.7) * 40;
        tx = g.position.x + cx * reach - cz * sw;
        tz = g.position.z + cz * reach + cx * sw;
      }
      const look = smooth((p.attention / THR - 0.3) / 0.4);
      tx += (pp.x - tx) * look;
      tz += (pp.z - tz) * look;
      _v.set(tx, ground(tx, tz), tz);
      spotTarget.lerp(_v, damp(3, dt));
      inSpot = spot > 0.3 && Math.hypot(spotTarget.x - pp.x, spotTarget.z - pp.z) < 15;
    }

    // ── attention
    updateEnv(dt);
    playerEye(eye);
    const d = g.position.distanceTo(eye);
    p.closest = Math.min(p.closest, d);
    const daylight = ctx.time?.daylight ?? 1;
    const night = daylight < 0.3;
    collectSignals(p, g.position, night);
    const w = ctx.weather;
    pInfo.d = d;
    pInfo.open = env.open;
    pInfo.exposed = env.exposed;
    pInfo.waving = !!ctx.flags.waving;
    pInfo.underwater = !!ctx.player?.headUnderwater;
    pInfo.daylight = daylight;
    pInfo.inSpotlight = inSpot;
    pInfo.sheltered = !!ctx.flags.sheltered;
    pInfo.fromBoat = !isHeli;
    pInfo.vis = clamp(1 - 0.3 * (Number(w?.rain) || 0) - 0.25 * (Number(w?.storm) || 0), 0.4, 1);
    const rate = L.attentionRate(pInfo, sigList, !!ctx.flags.blessed, parts, p.rescueMul);
    p.attention = L.stepAttention(p.attention, rate, dt);
    for (const k of L.METHODS) p.totals[k] += (parts[k] || 0) * dt;
    p.maxAttention = Math.max(p.maxAttention, p.attention);
    if (env.open) p.openTime += dt;
    if (pInfo.waving && d < L.K.weakRange + 150) p.waved = true;

    // ── audio
    const remain = (p.path.length - p.dist) / Math.max(1, p.speed);
    setLoop(p.kind, smooth(p.t / 4) * smooth(remain / 6), g.position); // distance falloff: audio.js panner

    // rig options
    if (isHeli) {
      heliOpts.spot = spot;
      heliOpts.wash = 0;
    } else {
      boatOpts.spot = spot;
      boatOpts.speed = p.speed;
    }

    // ── outcome
    if (!p.turnToast && p.attention > 0.5 * THR) {
      p.turnToast = true;
      toast("They're turning toward you!", { icon: '👀', kind: 'good', duration: 4, key: 'rescue-turn' });
    }
    for (const fw of watched) {
      if (fw.h.burning && fw.h.t > 0.9 && L.flareSpots(g.position.distanceTo(fw.h.position), p.flareRange)) {
        spotted('flare');
        return;
      }
    }
    if (p.attention >= THR) {
      spotted(L.dominantMethod(p.totals));
      return;
    }
    if (p.dist >= p.path.length || p.t > p.duration * 1.8 + 10) endPass(false);
  }

  // ── Spotted cinematic ────────────────────────────────────────────────────
  function spotted(method) {
    const p = pass;
    if (!p || p.spotted) return;
    p.spotted = true;
    p.method = method || 'visible';
    p.attention = Math.max(p.attention, THR);
    for (const fw of watched) fw.seen = true;
    ctx.flags.cinematic = true;
    ctx.flags.waving = false;
    ctx.letterbox?.(true);
    ctx.events.emit('rescue:spotted', { kind: p.kind, method: p.method });
    const g = p.rig.group;
    const pp = playerPos();
    const cam = ctx.camera;
    const c = {
      t: 0,
      T: 8,
      from: g.position.clone(),
      to: null,
      ctrl: null,
      path: null,
      lastPos: g.position.clone(),
      speed: p.speed,
      arrived: false,
      tArr: 0,
      sub1: false,
      sub2: false,
      fadeAt: -1,
      wantFinish: false,
      camPos: cam.position.clone(),
      camYaw: cam.rotation.y,
      camPitch: cam.rotation.x,
    };
    if (p.kind === 'helicopter') {
      let hx = g.position.x - pp.x, hz = g.position.z - pp.z;
      const hl = Math.hypot(hx, hz) || 1;
      hx /= hl;
      hz /= hl;
      const tx = pp.x + hx * 14, tz = pp.z + hz * 14;
      const baseY = Math.max(pp.y, ground(pp.x, pp.z), ground(tx, tz));
      c.to = new THREE.Vector3(tx, baseY + 25, tz);
      c.ctrl = new THREE.Vector3().lerpVectors(c.from, c.to, 0.5);
      c.ctrl.y = Math.max(c.from.y, c.to.y) + 6;
      // keep the descent clear of any ridge between the helicopter and the player
      let hm = 0;
      for (let k = 1; k < 8; k++) {
        const u = k / 8;
        hm = Math.max(hm, ground(c.from.x + (c.to.x - c.from.x) * u, c.from.z + (c.to.z - c.from.z) * u));
      }
      c.ctrl.y = Math.max(c.ctrl.y, 2 * (hm + 30) - 0.5 * (c.from.y + c.to.y));
      c.T = clamp(hl / 24, 5, 14);
    } else {
      c.path = boatApproach(g.position, pp);
      c.T = clamp(c.path.length / 18, 6, 22);
    }
    p.cine = c;
  }

  /** Boat route to the nearest deep water off the player: along the coast at a safe radius, then in. */
  function boatApproach(pos, pp) {
    let best = null, bd = Infinity;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU, cx = Math.cos(a), cz = Math.sin(a);
      for (let r = 4; r < Math.min(bd, 460); r += 4) {
        const x = pp.x + cx * r, z = pp.z + cz * r;
        if (world.heightAt(x, z) < SEA - 2) {
          bd = r;
          best = { x, z, cx, cz };
          break;
        }
      }
    }
    if (!best) {
      const a = Math.atan2(pp.z, pp.x), r = coastR(a) + 25;
      best = { x: Math.cos(a) * r, z: Math.sin(a) * r, cx: Math.cos(a), cz: Math.sin(a) };
    }
    const tx = best.x + best.cx * 10, tz = best.z + best.cz * 10;
    const aB = Math.atan2(pos.z, pos.x), aT = Math.atan2(tz, tx);
    const dA = wrapAngle(aT - aB);
    const offB = Math.max(70, Math.hypot(pos.x, pos.z) - coastR(aB));
    const pts = [{ x: pos.x, z: pos.z }];
    const N = Math.ceil(Math.abs(dA) / 0.15);
    for (let k = 1; k <= N; k++) {
      const u = k / N, a = aB + dA * u;
      const r = coastR(a) + offB + (70 - offB) * u;
      pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
    }
    pts.push({ x: tx + best.cx * 40, z: tz + best.cz * 40 }, { x: tx, z: tz });
    return L.makePath(pts);
  }

  function startFade(c) {
    c.fadeAt = c.t;
    let pr = null;
    try {
      pr = ctx.fade?.(1, 2);
    } catch (e) {
      pr = null;
    }
    if (pr && typeof pr.then === 'function') pr.then(finish, finish);
  }

  function finish() {
    if (rescued) return;
    const p = pass;
    if (ctx.state !== 'playing') {
      if (p?.cine) p.cine.wantFinish = true; // main ignores rescue:success outside 'playing'
      return;
    }
    rescued = true;
    silenceLoops();
    if (p) ctx.events.emit('rescue:passEnd', { kind: p.kind, index: p.index, spotted: true });
    ctx.events.emit('rescue:success', { method: p?.method || 'visible', passes: Math.max(1, passesSeen), kind: p?.kind || 'helicopter' });
    pass = null;
    // flags.cinematic stays on: the game is over (state 'rescued'), the HUD stays hidden under the win screen
    ctx.letterbox?.(false);
  }

  function updateCine(dt) {
    const p = pass, c = p.cine, g = p.rig.group;
    const isHeli = p.kind === 'helicopter';
    c.t += dt;
    p.t += dt;
    const pp = playerPos();
    if (isHeli) {
      const u = smooth(c.t / c.T), iu = 1 - u;
      _v.set(0, 0, 0)
        .addScaledVector(c.from, iu * iu)
        .addScaledVector(c.ctrl, 2 * iu * u)
        .addScaledVector(c.to, u * u);
      if (u >= 1) {
        if (!c.arrived) {
          c.arrived = true;
          c.tArr = c.t;
        }
        const h = c.t - c.tArr;
        _v.y += Math.sin(h * 1.3) * 0.35;
        _v.x += Math.sin(h * 0.7) * 0.4;
      }
    } else {
      const u = smooth(c.t / c.T);
      L.samplePath(c.path, u, o);
      _v.set(o.x, SEA - 0.05 + 0.12 * Math.sin(p.t * 1.3), o.z);
      if (u < 0.995) {
        const step = wrapAngle(Math.atan2(-o.dx, -o.dz) - p.yaw) * damp(2.2, dt);
        p.yaw = wrapAngle(p.yaw + step);
      } else if (!c.arrived) {
        c.arrived = true;
        c.tArr = c.t;
      }
    }
    const vel = dt > 0 ? Math.hypot(_v.x - c.lastPos.x, _v.z - c.lastPos.z) / dt : 0;
    c.speed += (vel - c.speed) * damp(4, dt);
    c.lastPos.copy(_v);
    g.position.copy(_v);
    if (isHeli) {
      const yawT = Math.atan2(-(pp.x - g.position.x), -(pp.z - g.position.z));
      p.yaw = wrapAngle(p.yaw + wrapAngle(yawT - p.yaw) * damp(1.6, dt));
      p.roll += (0 - p.roll) * damp(2, dt);
      g.rotation.set(-clamp(c.speed / 45, 0, 0.22), p.yaw, p.roll);
      if (c.arrived) heli.setLadder(clamp01((c.t - c.tArr - 0.6) / 3));
      heliOpts.wash = c.arrived ? 0.7 : 0;
      heliOpts.spot = spotAmount();
    } else {
      g.rotation.set(0.03 + 0.02 * Math.sin(p.t * 1.1) + Math.min(0.05, c.speed * 0.002), p.yaw, 0.03 * Math.sin(p.t * 0.83));
      boatOpts.speed = c.speed;
      boatOpts.spot = spotAmount();
    }
    _w.set(pp.x, ground(pp.x, pp.z), pp.z);
    spotTarget.lerp(_w, damp(3, dt));

    // subtitles, fade, success
    if (!c.sub1 && c.t > 0.4) {
      c.sub1 = true;
      ctx.ui?.subtitle?.("They've seen you!", 3.4);
    }
    if (c.arrived && !c.sub2 && c.t - c.tArr > (isHeli ? 1.2 : 0.6)) {
      c.sub2 = true;
      ctx.ui?.subtitle?.(isHeli ? 'A rope ladder drops down…' : 'A dinghy splashes down and heads for the beach…', 4.2);
    }
    if (c.fadeAt < 0 && ((c.arrived && c.t - c.tArr > (isHeli ? 5 : 4.6)) || c.t > 40)) startFade(c);
    if (c.wantFinish || (c.fadeAt >= 0 && c.t - c.fadeAt > 2.6)) finish();
    if (rescued) return;

    // camera looks up at the vehicle (the controller leaves the camera alone while cinematic)
    const cam = ctx.camera;
    const dx = g.position.x - c.camPos.x, dy = g.position.y - (isHeli ? 1 : 0) - c.camPos.y, dz = g.position.z - c.camPos.z;
    const yawT = Math.atan2(-dx, -dz);
    const pitchT = clamp(Math.atan2(dy, Math.hypot(dx, dz)), -1.2, 1.35);
    const k = damp(c.t < 1.5 ? 1.4 : 2.4, dt);
    c.camYaw = wrapAngle(c.camYaw + wrapAngle(yawT - c.camYaw) * k);
    c.camPitch += (pitchT - c.camPitch) * k;
    cam.rotation.order = 'YXZ';
    cam.rotation.set(c.camPitch, c.camYaw, 0);
    const near = clamp01(1 - g.position.distanceTo(c.camPos) / 60);
    const sh = (isHeli ? 0.03 : 0.01) * near;
    cam.position.copy(c.camPos);
    cam.position.x += Math.sin(c.t * 31) * sh;
    cam.position.y += Math.sin(c.t * 27 + 1.3) * sh;
    cam.position.z += Math.sin(c.t * 23 + 2.1) * sh;

    // audio fades with the picture
    const fadeK = c.fadeAt >= 0 ? clamp01(1 - (c.t - c.fadeAt) / 2) : 1;
    setLoop(p.kind, fadeK, g.position);
  }

  // ── Waving arms (G) ──────────────────────────────────────────────────────
  function buildArms() {
    const root = new THREE.Group();
    root.name = 'wavingArms';
    root.visible = false;
    const r = createArm(1), l = createArm(-1);
    r.position.set(0.3, -1.25, -0.42);
    l.position.set(-0.3, -1.25, -0.42);
    root.add(r, l);
    ctx.camera.add(root);
    arms = { root, r, l, w: 0, t: 0 };
  }

  function updateWave(dt) {
    const can = !ctx.flags.cinematic && !ctx.flags.sleeping && !ctx.ui?.menuOpen && !ctx.stats?.dead;
    const held = can && !!ctx.input?.isDown?.('wave');
    ctx.flags.waving = held && !ctx.player?.headUnderwater;
    if (!arms) return;
    const target = ctx.flags.waving ? 1 : 0;
    arms.w += (target - arms.w) * damp(target ? 9 : 7, dt);
    arms.root.visible = arms.w > 0.02;
    if (!arms.root.visible) return;
    arms.t += dt;
    const y = -1.25 + 0.75 * smooth(arms.w);
    const s = Math.sin(arms.t * 7.5);
    arms.r.position.y = y;
    arms.l.position.y = y;
    arms.r.rotation.set(-0.32, 0, -(0.32 + 0.3 * s));
    arms.l.rotation.set(-0.32, 0, 0.32 + 0.3 * s);
  }

  function idle() {
    ctx.flags.waving = false;
    if (arms) {
      arms.w = 0;
      arms.root.visible = false;
    }
    silenceLoops();
  }

  // ── Flares ───────────────────────────────────────────────────────────────
  function onFlare(e) {
    if (!fx || rescued) return;
    const pos = e?.position?.isVector3 ? e.position : playerEye(eye).clone();
    ctx.camera.getWorldDirection(_w);
    watched.push({ h: fx.fire(pos, _w), seen: !!pass?.spotted });
  }

  function updateFlares() {
    for (let i = watched.length - 1; i >= 0; i--) {
      const fw = watched[i];
      if (!fw.h.done) continue;
      watched.splice(i, 1);
      if (!fw.seen && !rescued && !pass?.spotted) {
        const never = L.difficultyRescue(ctx.difficulty).flareRange <= 0;
        toast(never ? 'No one saw it… Nobody is searching close enough to see a flare.' : 'No one saw it… Save your next flare for when the search party is close.', {
          icon: '🧨',
          kind: 'warn',
          duration: 6,
          key: 'flare',
        });
      }
    }
  }

  // ── Module API ───────────────────────────────────────────────────────────
  const api = {
    init() {
      if (built) return;
      built = true;
      lights = getStoryLights(ctx.scene);
      heli = createHeliRig(ctx, lights);
      boat = createBoatRig(ctx, lights);
      fx = createFlareFx(ctx, { light: lights.point });
      fx.init();
      try {
        coastTable = L.buildCoastTable(sampleCoast, 72, 3);
      } catch (e) {
        console.warn('[rescue] coast table failed, using a 300 m circle', e);
        coastTable = null;
      }
      buildArms();
      ctx.events.on('time:set', () => {
        const h = ctx.time?.hoursTotal;
        if (typeof h === 'number') nextIndex = L.firstPassIndexAfter(h, R);
        heldBack = false;
      });
      ctx.events.on('time:skip', onSkip);
      ctx.events.on('flare:fired', onFlare);
      const h = ctx.time?.hoursTotal;
      if (typeof h === 'number') nextIndex = L.firstPassIndexAfter(h, R);
    },

    update(dt) {
      if (!built) return;
      dt = clamp(Number(dt) || 0, 0, 0.1);
      if (ctx.state !== 'playing') {
        idle();
        return;
      }
      updateWave(dt);
      updateSchedule();
      heliOpts.spot = 0;
      boatOpts.spot = 0;
      if (pass) {
        if (pass.spotted) {
          try {
            updateCine(dt);
          } catch (e) {
            console.error('[rescue] cinematic failed, finishing', e);
            finish();
          }
        } else {
          updatePass(dt);
        }
      }
      const rain = Number(ctx.weather?.rain) || 0;
      heliOpts.rain = rain;
      boatOpts.rain = rain;
      heli.update(dt, heliOpts);
      boat.update(dt, boatOpts);
      fx.update(dt);
      updateFlares();
      if (sleepNote) {
        if (ctx.flags.sleeping) sleepNote.wait = Math.max(sleepNote.wait, 2);
        else if ((sleepNote.wait -= dt) <= 0) {
          toast(L.sleptThroughText(sleepNote.kinds), { icon: '😴', kind: 'warn', duration: 8, key: 'rescue-sleep' });
          sleepNote = null;
        }
      }
    },

    /** The active pass (null when none). Live: read it when you need it. */
    get activePass() {
      return pass;
    },
    /** 0..1 attention of the active pass (0 when none). */
    get attention() {
      return pass ? clamp01(pass.attention / THR) : 0;
    },
    /** Passes that came by so far (including slept-through ones). */
    get passes() {
      return passesSeen;
    },
    /** Game hours until the next scheduled pass starts (0 when it is due). */
    nextPassHours() {
      const now = ctx.time?.hoursTotal ?? 0;
      const i = nextIndex ?? L.firstPassIndexAfter(now, R);
      return Math.max(0, L.passDef(i, R).at - now);
    },
    /** Debug: a close pass (closeness 1) right now. Ends any unspotted active pass first. */
    debugStartPass(kind = 'helicopter') {
      if (!built || rescued) return null;
      if (pass) {
        if (pass.spotted) return pass;
        endPass(true);
      }
      return startPass({ index: -1 - debugCount++, kind: kind === 'boat' ? 'boat' : 'helicopter', at: ctx.time?.hoursTotal ?? 0, closeness: 1, scripted: false, debug: true });
    },
  };
  return api;
}
