// Birds (Builder C — fauna): every bird is one instance of ONE InstancedMesh (one draw call).
//
// Flocks (each a small state machine: air -> descend -> ground -> (flush | lift) -> air):
//   swift  high flocks circling 30–50 m above the terrain under them, flap-and-glide, never land
//   song   small songbird flocks circling low over open ground, landing to forage (hop, peck, turn)
//   gull   gulls soaring over the surf line of the beach nearest the player (long glides, "M" wings),
//          standing on the beach now and then; they call ('gull' sound) when the player is around
//   hawk   one big raptor soaring slow, wide circles very high up
//   bat    dusk/night only: erratic, fast-flapping little bats flitting near the player
// Scatter: a grounded flock flushes (bursts up and away, 'birds_flush' sound) when the player sprints
// within ~18 m or walks within ~6 m; a low flock in the air veers off when the player sprints under it.
// Day birds fade out at night, bats fade in. Flocks relocate near the player when left far behind.
// Wings flap in the vertex shader (patchFlap): aFlap = (angle, span, tipBend) per instance.
import * as THREE from 'three';
import { birdGeometry } from './faunaMeshes.js';
import { patchFlap, approach, TAU, nearestCoastIndex, playSound } from './faunaShared.js';

// Per-kind tunables. alt = height above the reference ground (m), R = circle radius (m), hz = flap rate.
const KINDS = {
  swift: { flocks: 2, size: 8, scale: [0.9, 1.1], colors: [0x2b2b31, 0x35343a, 0x3a3530], alt: [30, 48], R: [16, 32], speed: 10, hz: 6.5, amp: 0.8, flapT: [0.5, 1.4], glideT: [0.8, 2.2], ground: null, day: true, relocate: 260, spread: 0.55 },
  song: { flocks: 2, size: 6, scale: [0.55, 0.68], colors: [0x8a6a48, 0x9c7a50, 0x6f5a44, 0xa88458], alt: [5, 9], R: [6, 11], speed: 6.5, hz: 13, amp: 0.9, flapT: [0.35, 0.6], glideT: [0.18, 0.3], fold: true, ground: 'open', landEvery: [12, 30], groundTime: [25, 70], day: true, relocate: 130, spread: 0.35 },
  gull: { flocks: 2, size: 4, scale: [1.4, 1.65], colors: [0xf4f4f2, 0xeceef0, 0xdfe3e6], alt: [9, 20], R: [12, 26], speed: 7, hz: 2.6, amp: 0.65, flapT: [0.8, 1.8], glideT: [2.5, 6], gull: true, ground: 'beach', landEvery: [35, 80], groundTime: [30, 80], day: true, relocate: 300, spread: 1 },
  hawk: { flocks: 1, size: 1, scale: [2.3, 2.3], colors: [0x6e4c2f], alt: [58, 72], R: [38, 55], speed: 8, hz: 3, amp: 0.55, flapT: [0.6, 1.0], glideT: [6, 12], ground: null, day: true, relocate: 300, spread: 1 },
  bat: { flocks: 1, size: 5, scale: [0.42, 0.52], colors: [0x2b231e, 0x241f1c], alt: [3, 8], R: [5, 11], speed: 6.5, hz: 10, amp: 0.95, flapT: [5, 9], glideT: [0.05, 0.1], ground: null, day: false, bat: true, relocate: 60, spread: 1 },
};

const A_AIR = 0, A_DESCEND = 1, A_GROUND = 2, A_FLUSH = 3;
const M_FLAP = 0, M_GLIDE = 1, M_FOLD = 2;
const SCARE_SPRINT = 18, SCARE_WALK = 6, SCARE_ANY = 3;

export function createBirds(ctx, shared) {
  const rand = shared.rand;
  const rr = (a, b) => a + (b - a) * rand();
  let total = 0;
  for (const k in KINDS) total += KINDS[k].flocks * KINDS[k].size;

  const geo = birdGeometry(shared.geoRand);
  const flap = new Float32Array(total * 3);
  const aFlap = new THREE.InstancedBufferAttribute(flap, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aFlap', aFlap);
  const mat = patchFlap(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'bird', { glow: 0.04 });
  const mesh = new THREE.InstancedMesh(geo, mat, total);
  mesh.name = 'birds';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.raycast = () => {};

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const _s = new THREE.Vector3();
  const _c = new THREE.Color();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  let frameN = 0;
  const tmp = { x: 0, z: 0, w: 0 };

  const flocks = [];
  const birds = [];
  {
    let idx = 0;
    for (const key in KINDS) {
      const K = KINDS[key];
      for (let f = 0; f < K.flocks; f++) {
        const fl = {
          drawn: -1, // V4-E: -1 unknown, 0 zeroed (hidden), 1 drawn
          key, K, birds: [], state: A_AIR, vis: 0,
          cx: 0, cy: 30, cz: 0, tx: 0, tz: 0, dir: rand() < 0.5 ? -1 : 1, theta: rand() * TAU,
          R: rr(K.R[0], K.R[1]), alt: rr(K.alt[0], K.alt[1]),
          retargetT: 0, altT: 0, timer: K.landEvery ? rr(K.landEvery[0], K.landEvery[1]) : 0,
          gx: 0, gy: 0, gz: 0, flushT: 0, callT: rr(8, 25), coastIdx: 0, veerT: 0, placed: false,
          side: f % 2 ? 1 : -1,
        };
        for (let b = 0; b < K.size; b++) {
          const bird = {
            i: idx++, fl,
            x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0,
            yaw: rand() * TAU, pitch: 0, roll: 0,
            scale: rr(K.scale[0], K.scale[1]),
            r: rr(0.72, 1.28), a0: (b / K.size) * TAU * K.spread + rr(-0.2, 0.2), h: rr(-3, 3),
            ph: rand() * TAU, hz: K.hz * rr(0.85, 1.15), mode: M_FLAP, modeT: rr(0.2, 1.5),
            gx: 0, gz: 0, gy: 0, landed: false, hopT: rr(0.5, 3), hop: -1, ax: 0, az: 0, bx: 0, bz: 0, peck: 0,
          };
          _c.set(K.colors[b % K.colors.length]);
          mesh.setColorAt(bird.i, _c);
          mesh.setMatrixAt(bird.i, zero);
          fl.birds.push(bird);
          birds.push(bird);
        }
        flocks.push(fl);
      }
    }
    mesh.instanceColor.needsUpdate = true;
  }

  // ── flock placement ───────────────────────────────────────────────────
  const W = () => ctx.world;
  /** Ground or sea/lake surface at x,z. */
  function surfaceAt(x, z) {
    const g = W().heightAt(x, z);
    return Math.max(g, 0, g < 16 ? (W().waterAt(x, z)?.surface ?? -1e9) : -1e9);
  }
  /** Highest surface around a circle (so high flocks clear the summit). */
  function maxAround(cx, cz, R) {
    let m = surfaceAt(cx, cz);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      m = Math.max(m, surfaceAt(cx + Math.cos(a) * R, cz + Math.sin(a) * R));
    }
    return m;
  }

  /** Choose a new center target for a flock in the air. */
  function retarget(fl) {
    const f = shared.focus;
    const K = fl.K;
    if (fl.key === 'gull') {
      const ring = shared.ring;
      const base = nearestCoastIndex(ring, f.x, f.z);
      // each gull flock keeps to its own side of the player's beach
      fl.coastIdx = (base + fl.side * Math.round(rr(1, 4)) + ring.length) % ring.length;
      const c = ring[fl.coastIdx];
      const out = rr(4, 14);
      fl.tx = c.x + c.ox * out;
      fl.tz = c.z + c.oz * out;
    } else if (fl.key === 'song') {
      const H = shared.habitat;
      if (H.pick(H.open, rand, f.x, f.z, 20, 75, 10, tmp)) {
        fl.tx = tmp.x;
        fl.tz = tmp.z;
      } else {
        const a = rand() * TAU, d = rr(25, 60);
        fl.tx = f.x + Math.cos(a) * d;
        fl.tz = f.z + Math.sin(a) * d;
      }
    } else if (fl.key === 'bat') {
      const a = rand() * TAU, d = rr(5, 16);
      fl.tx = f.x + Math.cos(a) * d;
      fl.tz = f.z + Math.sin(a) * d;
    } else {
      // swifts / hawk: somewhere over the island near the player
      const a = rand() * TAU, d = fl.key === 'hawk' ? rr(30, 120) : rr(30, 150);
      fl.tx = f.x + Math.cos(a) * d;
      fl.tz = f.z + Math.sin(a) * d;
      const r = Math.hypot(fl.tx, fl.tz);
      if (r > 300) {
        fl.tx *= 300 / r;
        fl.tz *= 300 / r;
      }
    }
    fl.retargetT = fl.key === 'bat' ? rr(3, 7) : rr(30, 75);
  }

  /** Teleport a flock (and its birds) to a fresh spot near the focus, circling. */
  function place(fl) {
    retarget(fl);
    fl.cx = fl.tx;
    fl.cz = fl.tz;
    updateAlt(fl);
    fl.state = A_AIR;
    fl.placed = true;
    for (const b of fl.birds) {
      const a = fl.theta + b.a0;
      b.x = fl.cx + Math.cos(a) * fl.R * b.r;
      b.z = fl.cz + Math.sin(a) * fl.R * b.r;
      b.y = fl.cy + b.h;
      b.vx = -Math.sin(a) * fl.K.speed * fl.dir;
      b.vz = Math.cos(a) * fl.K.speed * fl.dir;
      b.vy = 0;
      b.landed = false;
    }
  }

  function updateAlt(fl) {
    const high = fl.key === 'swift' || fl.key === 'hawk';
    fl.cy = (high ? maxAround(fl.cx, fl.cz, fl.R + 6) : maxAround(fl.cx, fl.cz, fl.R * 0.6)) + fl.alt;
    fl.altT = high ? 2.5 : 0.8;
  }

  /** Try to start a landing: pick a ground spot + per-bird spots. */
  function tryLand(fl, fr) {
    const f = shared.focus;
    let gx = 0, gz = 0, ok = false;
    if (fl.K.ground === 'open') {
      const H = shared.habitat;
      for (let t = 0; t < 4 && !ok; t++) {
        if (!H.pick(H.open, rand, f.x, f.z, 22, 70, 8, tmp)) continue;
        if (W().waterAt(tmp.x, tmp.z)) continue;
        if ((ctx.flora?.canopyAt?.(tmp.x, tmp.z) ?? 0) > 0.3) continue;
        gx = tmp.x;
        gz = tmp.z;
        ok = true;
      }
    } else if (fl.K.ground === 'beach') {
      const ring = shared.ring;
      for (let t = 0; t < 5 && !ok; t++) {
        const c = ring[(fl.coastIdx + fl.side * Math.round(rr(0, 2)) + ring.length) % ring.length];
        if (!c.landOk) continue;
        const d = Math.hypot(c.landX - fr.px, c.landZ - fr.pz);
        if (d < 22) continue;
        gx = c.landX;
        gz = c.landZ;
        ok = true;
      }
    }
    if (!ok) return false;
    fl.gx = gx;
    fl.gz = gz;
    fl.gy = W().heightAt(gx, gz);
    for (const b of fl.birds) {
      for (let t = 0; t < 4; t++) {
        const a = rand() * TAU, d = Math.sqrt(rand()) * (fl.key === 'gull' ? 4 : 2.6);
        b.gx = gx + Math.cos(a) * d;
        b.gz = gz + Math.sin(a) * d;
        if (!W().waterAt(b.gx, b.gz)) break;
        b.gx = gx;
        b.gz = gz;
      }
      b.gy = W().heightAt(b.gx, b.gz);
      b.landed = false;
    }
    fl.state = A_DESCEND;
    fl.timer = 14; // landing timeout
    return true;
  }

  function flush(fl, fr, scared) {
    fl.state = A_FLUSH;
    fl.flushT = 2.2;
    const ax = fl.gx - fr.px, az = fl.gz - fr.pz;
    const d = Math.hypot(ax, az) + 1e-3;
    const ux = ax / d, uz = az / d;
    for (const b of fl.birds) {
      const s = scared ? rr(4, 7) : rr(1.5, 3);
      b.vx = ux * s + rr(-2, 2);
      b.vz = uz * s + rr(-2, 2);
      b.vy = scared ? rr(4, 6.5) : rr(2.5, 4);
      b.landed = false;
      b.mode = M_FLAP;
      b.modeT = 1.5;
    }
    // the next circle: away from the player
    fl.tx = fl.cx = fl.gx + ux * (scared ? 35 : 15);
    fl.tz = fl.cz = fl.gz + uz * (scared ? 35 : 15);
    updateAlt(fl);
    fl.retargetT = rr(20, 40);
    fl.timer = rr(fl.K.landEvery[0], fl.K.landEvery[1]) * (scared ? 1.6 : 1);
    if (scared && fr.playing) {
      _p.set(fl.gx, fl.gy + 1, fl.gz);
      playSound(ctx, 'birds_flush', { position: _p.clone(), volume: fl.key === 'gull' ? 0.7 : 0.5 });
      if (fl.key === 'gull') playSound(ctx, 'gull', { position: _p.clone(), volume: 0.8 });
    }
  }

  // ── per-bird motion ───────────────────────────────────────────────────
  function flyCircle(b, fl, dt, t) {
    const K = fl.K;
    const a = fl.theta + b.a0;
    const R = fl.R * b.r;
    let tx = fl.cx + Math.cos(a) * R;
    let tz = fl.cz + Math.sin(a) * R;
    let ty = fl.cy + b.h + Math.sin(t * 0.45 + b.ph) * 1.5;
    const w = (K.speed / fl.R) * fl.dir;
    let tvx = -Math.sin(a) * R * w, tvz = Math.cos(a) * R * w;
    if (K.bat) {
      // erratic flitting
      tx += Math.sin(t * 2.3 + b.ph) * 2.6 + Math.sin(t * 5.1 + b.ph * 2) * 0.8;
      tz += Math.cos(t * 2.7 + b.ph * 1.3) * 2.6 + Math.sin(t * 4.4 + b.ph) * 0.8;
      ty += Math.sin(t * 3.7 + b.ph) * 1.4;
      tvx *= 0.6;
      tvz *= 0.6;
    }
    steer(b, tx, ty, tz, tvx, tvz, K.speed * (K.bat ? 2.2 : 1.7), K.bat ? 3.2 : 2.0, dt);
  }

  function steer(b, tx, ty, tz, tvx, tvz, maxV, lambda, dt) {
    let dvx = (tx - b.x) * 1.1 + tvx;
    let dvy = (ty - b.y) * 1.1;
    let dvz = (tz - b.z) * 1.1 + tvz;
    const m = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
    if (m > maxV) {
      const k = maxV / m;
      dvx *= k;
      dvy *= k;
      dvz *= k;
    }
    const k = approach(lambda, dt);
    b.vx += (dvx - b.vx) * k;
    b.vy += (dvy - b.vy) * k;
    b.vz += (dvz - b.vz) * k;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    const floor = W().heightAt(b.x, b.z) + 1.5;
    if (b.y < floor && b.fl.state !== A_DESCEND) {
      b.y = floor;
      if (b.vy < 0) b.vy = 0;
    }
  }

  /** Heading / bank / pitch from the velocity. */
  function orient(b, dt) {
    const hs = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
    if (hs > 0.2) {
      const yaw = Math.atan2(b.vx, b.vz);
      let d = yaw - b.yaw;
      if (d > Math.PI) d -= TAU;
      if (d < -Math.PI) d += TAU;
      const turn = d * approach(6, dt);
      b.yaw += turn;
      const rate = dt > 0 ? turn / dt : 0;
      const bank = Math.max(-0.9, Math.min(0.9, -rate * hs * 0.09));
      b.roll += (bank - b.roll) * approach(4, dt);
    }
    const p = -Math.atan2(b.vy, hs + 0.5) * 0.7;
    b.pitch += (p - b.pitch) * approach(5, dt);
  }

  /** Flap / glide / fold cycling in the air. */
  function wings(b, K, dt, forceFlap) {
    b.modeT -= dt;
    if (b.modeT <= 0) {
      if (b.mode === M_FLAP) {
        b.mode = K.fold ? M_FOLD : M_GLIDE;
        b.modeT = rr(K.glideT[0], K.glideT[1]);
      } else {
        b.mode = M_FLAP;
        b.modeT = rr(K.flapT[0], K.flapT[1]);
      }
    }
    const o = b.i * 3;
    if (b.mode === M_FLAP || forceFlap) {
      b.ph += dt * b.hz * TAU * (forceFlap ? 1.35 : 1);
      const s = Math.sin(b.ph);
      flap[o] = 0.12 + K.amp * s;
      flap[o + 1] = 1;
      flap[o + 2] = (K.gull ? -0.5 : -0.3) * Math.cos(b.ph);
    } else if (b.mode === M_FOLD) {
      flap[o] = -0.05;
      flap[o + 1] = 0.4;
      flap[o + 2] = 0;
    } else {
      // glide: gulls hold the "M" (inner up, hands down), others a flat dihedral
      flap[o] += ((K.gull ? 0.2 : 0.1) - flap[o]) * approach(6, dt);
      flap[o + 1] = 1;
      flap[o + 2] += ((K.gull ? -0.42 : -0.06) - flap[o + 2]) * approach(6, dt);
    }
  }

  function groundBird(b, fl, dt, t) {
    const o = b.i * 3;
    flap[o] = -0.12;
    flap[o + 1] = 0.32;
    flap[o + 2] = 0;
    b.roll *= 1 - approach(6, dt);
    if (b.hop >= 0) {
      // hop (songbirds) / step (gulls) from a to b
      const dur = fl.key === 'gull' ? 0.9 : 0.22;
      b.hop += dt / dur;
      const k = Math.min(1, b.hop);
      b.x = b.ax + (b.bx - b.ax) * k;
      b.z = b.az + (b.bz - b.az) * k;
      const g = W().heightAt(b.x, b.z);
      b.y = g + (fl.key === 'gull' ? 0 : Math.sin(k * Math.PI) * 0.09 * b.scale);
      if (fl.key !== 'gull') {
        flap[o] = 0.2 * Math.sin(k * Math.PI); // a little wing flick on each hop
        flap[o + 1] = 0.45;
      }
      if (b.hop >= 1) b.hop = -1;
    } else {
      b.y = W().heightAt(b.x, b.z);
      b.hopT -= dt;
      if (b.hopT <= 0) {
        b.hopT = fl.key === 'gull' ? rr(2, 7) : rr(0.4, 2.2);
        const r = rand();
        if (r < 0.55) {
          // hop/step toward a point near the bird's spot
          const a = rand() * TAU, d = fl.key === 'gull' ? rr(0.3, 1.2) : rr(0.15, 0.5);
          let nx = b.x + Math.cos(a) * d, nz = b.z + Math.sin(a) * d;
          if ((nx - b.gx) ** 2 + (nz - b.gz) ** 2 > 4) {
            nx = b.x + (b.gx - b.x) * 0.3;
            nz = b.z + (b.gz - b.z) * 0.3;
          }
          b.ax = b.x;
          b.az = b.z;
          b.bx = nx;
          b.bz = nz;
          b.hop = 0;
          b.yaw = Math.atan2(nx - b.x, nz - b.z);
        } else if (r < 0.85) b.peck = fl.key === 'gull' ? 0.5 : 0.35;
        else b.yaw += rr(-1.2, 1.2);
      }
    }
    // pecking: nose dips
    if (b.peck > 0) b.peck -= dt;
    const want = b.peck > 0 ? 0.55 * Math.sin(Math.min(1, b.peck * 4) * Math.PI) + 0.25 : -0.05;
    b.pitch += (want - b.pitch) * approach(14, dt);
  }

  // ── flock update ──────────────────────────────────────────────────────
  function updateFlock(fl, dt, fr) {
    const K = fl.K;
    const t = fr.t;
    // time of day visibility
    const active = K.day ? fr.daylight > 0.22 && fr.rain < 0.7 : fr.daylight < 0.4;
    fl.vis += ((active ? 1 : 0) - fl.vis) * approach(active ? 0.7 : 1.2, dt);
    if (!active && fl.vis < 0.01) {
      fl.vis = 0;
      fl.placed = false;
      return;
    }
    if (!fl.placed || fr.jumped) place(fl);
    const f = shared.focus;
    // left far behind: relocate (only when airborne)
    if (fl.state === A_AIR) {
      const dc = Math.hypot(fl.cx - f.x, fl.cz - f.z);
      if (dc > K.relocate) place(fl);
    } else if (fl.state === A_GROUND || fl.state === A_DESCEND) {
      if (Math.hypot(fl.gx - f.x, fl.gz - f.z) > K.relocate) place(fl);
    }
    if (!active && fl.state !== A_AIR && fl.state !== A_FLUSH) {
      fl.state = A_AIR; // dusk: lift off and fade out in the air
      for (const b of fl.birds) b.landed = false;
    }

    // gull calls
    if (fl.key === 'gull' && fr.playing && active) {
      fl.callT -= dt;
      if (fl.callT <= 0) {
        fl.callT = rr(12, 32);
        const b = fl.birds[Math.floor(rand() * fl.birds.length)];
        if (Math.hypot(b.x - fr.px, b.z - fr.pz) < 90) {
          _p.set(b.x, b.y, b.z);
          playSound(ctx, 'gull', { position: _p.clone(), volume: 0.6 });
        }
      }
    }

    const scareR = fr.sprinting ? SCARE_SPRINT : SCARE_WALK;
    if (fl.state === A_AIR) {
      fl.retargetT -= dt;
      if (fl.retargetT <= 0) retarget(fl);
      // the circle center drifts toward its target
      const dx = fl.tx - fl.cx, dz = fl.tz - fl.cz;
      const d = Math.hypot(dx, dz);
      const cs = (K.bat ? 3.5 : 2.2) * dt;
      if (d > 0.5) {
        fl.cx += (dx / d) * Math.min(d, cs);
        fl.cz += (dz / d) * Math.min(d, cs);
      }
      fl.altT -= dt;
      if (fl.altT <= 0) updateAlt(fl);
      fl.theta += (K.speed / fl.R) * fl.dir * dt;
      // a low flock veers off when the player sprints underneath
      if (fr.playing && fr.sprinting && (fl.key === 'song' || fl.key === 'gull') && fl.veerT <= 0) {
        if (Math.hypot(fl.cx - fr.px, fl.cz - fr.pz) < fl.R + 10) {
          const ax = fl.cx - fr.px, az = fl.cz - fr.pz;
          const al = Math.hypot(ax, az) + 1e-3;
          fl.tx = fl.cx + (ax / al) * 40;
          fl.tz = fl.cz + (az / al) * 40;
          fl.cy += 5;
          fl.veerT = 8;
        }
      }
      if (fl.veerT > 0) fl.veerT -= dt;
      // time to land?
      if (K.ground && active) {
        fl.timer -= dt;
        if (fl.timer <= 0) {
          if (!tryLand(fl, fr)) fl.timer = rr(5, 12);
        }
      }
      for (const b of fl.birds) {
        flyCircle(b, fl, dt, t);
        orient(b, dt);
        wings(b, K, dt, b.vy > 2.5);
      }
    } else if (fl.state === A_DESCEND) {
      fl.timer -= dt;
      let allDown = true;
      for (const b of fl.birds) {
        if (b.landed) {
          groundBird(b, fl, dt, t);
          continue;
        }
        allDown = false;
        const dx = b.gx - b.x, dz = b.gz - b.z;
        const hd = Math.hypot(dx, dz);
        // glide down on a slope, flare at the end
        const ty = b.gy + Math.min(hd * 0.45, 25);
        steer(b, b.gx, ty, b.gz, 0, 0, Math.max(1.2, Math.min(K.speed, hd * 0.9)), 2.6, dt);
        orient(b, dt);
        wings(b, K, dt, hd < 3);
        if (hd < 0.35 && b.y - b.gy < 0.4) {
          b.landed = true;
          b.x = b.gx;
          b.z = b.gz;
          b.y = b.gy;
          b.vx = b.vy = b.vz = 0;
          b.pitch = 0;
        }
      }
      if (allDown || fl.timer <= 0) {
        fl.state = A_GROUND;
        fl.timer = rr(K.groundTime[0], K.groundTime[1]);
        for (const b of fl.birds) {
          if (!b.landed) {
            b.landed = true;
            b.x = b.gx;
            b.z = b.gz;
            b.y = b.gy;
          }
        }
      }
      if (fr.playing && Math.hypot(fl.gx - fr.px, fl.gz - fr.pz) < scareR + 4) flush(fl, fr, true);
    } else if (fl.state === A_GROUND) {
      fl.timer -= dt;
      for (const b of fl.birds) groundBird(b, fl, dt, t);
      // scared by the player?
      if (fr.playing) {
        let near = Math.hypot(fl.gx - fr.px, fl.gz - fr.pz) < scareR;
        if (!near) {
          for (const b of fl.birds) {
            if (Math.hypot(b.x - fr.px, b.z - fr.pz) < SCARE_ANY) {
              near = true;
              break;
            }
          }
        }
        if (near) flush(fl, fr, true);
      }
      if (fl.state === A_GROUND && fl.timer <= 0) flush(fl, fr, false);
    } else if (fl.state === A_FLUSH) {
      fl.flushT -= dt;
      const drag = 1 - approach(0.9, dt);
      for (const b of fl.birds) {
        b.vy += 2.5 * dt; // flapping lift
        b.vx *= drag;
        b.vz *= drag;
        b.vy *= drag;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        orient(b, dt);
        wings(b, K, dt, true);
      }
      if (fl.flushT <= 0) fl.state = A_AIR;
    }
  }

  function write(b) {
    const fl = b.fl;
    if (fl.vis < 0.01 || !fl.placed) {
      mesh.setMatrixAt(b.i, zero);
      return;
    }
    _p.set(b.x, b.y, b.z);
    _e.set(b.pitch, b.yaw, b.roll, 'YXZ');
    _q.setFromEuler(_e);
    const s = b.scale * fl.vis;
    _s.set(s, s, s);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(b.i, _m);
  }

  return {
    object: mesh,
    init() {
      for (const fl of flocks) fl.placed = false;
    },
    update(dt, fr) {
      for (let k = 0; k < flocks.length; k++) updateFlock(flocks[k], dt, fr);
      // V4-E: hidden flocks are zeroed once, flocks farther than fr.near2 from the camera refresh their
      // matrices every 3rd frame only, and the mesh isn't drawn while no flock is out.
      frameN++;
      let live = 0, dirty = false;
      for (let k = 0; k < flocks.length; k++) {
        const fl = flocks[k];
        const B = fl.birds;
        if (fr.jumped) fl.drawn = -1;
        if (fl.vis < 0.01 || !fl.placed || !B.length) {
          if (fl.drawn !== 0) {
            for (let j = 0; j < B.length; j++) mesh.setMatrixAt(B[j].i, zero);
            fl.drawn = 0;
            dirty = true;
          }
          continue;
        }
        live++;
        const b0 = B[0];
        const dx = b0.x - fr.camX, dy = b0.y - fr.camY, dz = b0.z - fr.camZ;
        if (fl.drawn === 1 && !(dx * dx + dy * dy + dz * dz < fr.near2) && (frameN + k) % 3 !== 0) continue;
        for (let j = 0; j < B.length; j++) write(B[j]);
        fl.drawn = 1;
        dirty = true;
      }
      if (dirty) {
        mesh.instanceMatrix.needsUpdate = true;
        aFlap.needsUpdate = true;
      }
      mesh.visible = live > 0;
    },
    count: () => flocks.reduce((n, fl) => n + (fl.vis > 0.01 && fl.placed ? fl.birds.length : 0), 0),
    /** Debug: flock states, e.g. __game.fauna.debugBirds() */
    debug: () => flocks.map((fl) => ({ kind: fl.key, state: ['air', 'descend', 'ground', 'flush'][fl.state], vis: +fl.vis.toFixed(2), x: Math.round(fl.state >= 1 && fl.state <= 2 ? fl.gx : fl.cx), z: Math.round(fl.state >= 1 && fl.state <= 2 ? fl.gz : fl.cz), y: Math.round(fl.cy) })),
  };
}
