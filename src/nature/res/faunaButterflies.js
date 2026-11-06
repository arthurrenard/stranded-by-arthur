// Butterflies by day + moths around fires at night (Builder C — fauna). One InstancedMesh, one draw call.
//
// Butterflies spawn around the player where the baked butterfly raster says so (meadows first, then
// grassland and forest edges). Each one wanders near its home with soft steering and a bouncy,
// erratic flight, flaps 6–9 Hz (with short glides for some species), and every few hops lands on a
// flower (yarrow / chamomile from ctx.resources, or ctx.flora.flowerNear if flora offers one, or a
// meadow ground spot) where it basks with slowly opening/closing wings. They flutter off when the
// player comes close (much earlier when sprinting), settle at dusk and hide at night / in rain.
// Moths: at night a few pale moths spiral erratically around nearby campfires / torches.
//
// Wings flap in the vertex shader (patchFlap): per-instance aFlap = (angle, span, tipBend).
import * as THREE from 'three';
import { butterflyGeometry } from './faunaMeshes.js';
import { patchFlap, approach, TAU } from './faunaShared.js';

const T = {
  butterflies: 44,
  moths: 10,
  radius: 64, // butterflies live within this distance of the player
  spawnMin: 14, // spawn at least this far (so they never pop in front of the face)
  spawnPerFrame: 2,
  speed: [1.2, 2.1], // cruise speed (m/s)
  homeLeash: 13, // wander radius around home (m)
  landChance: 0.34, // chance to land on a flower after reaching a wander target
  rest: [3, 12], // basking seconds
  scareWalk: 1.6, // player distance that startles a resting butterfly (m)
  scareSprint: 4.5,
  dayMin: 0.24, // below this daylight they settle and hide
  rainMax: 0.45,
};

// species palette (sRGB) and weights
const SPECIES = [
  [0xff8a1f, 3], // monarch orange
  [0xffe03a, 3], // lemon / brimstone
  [0x3f9dff, 2], // blue
  [0xf8f6ea, 3], // cabbage white
  [0xe8432b, 1.5], // red admiral
  [0xff7ab8, 1], // pink
  [0xb08cff, 1], // lilac
  [0xc6ef5a, 1.2], // green sulphur
];
const MOTH_COLORS = [0xdacdb0, 0xcabda6, 0xe9dfc6, 0xbfae92];

const S_HIDDEN = 0, S_FLY = 1, S_LAND = 2, S_REST = 3;

export function createButterflies(ctx, shared) {
  const NB = T.butterflies, NM = T.moths, N = NB + NM;
  const geo = butterflyGeometry(shared.geoRand);
  const flap = new Float32Array(N * 3);
  const aFlap = new THREE.InstancedBufferAttribute(flap, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aFlap', aFlap);
  const mat = patchFlap(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'butterfly', { glow: 0.2 });
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.name = 'butterflies';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.raycast = () => {};

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const _s = new THREE.Vector3();
  const _c = new THREE.Color();
  const tmp = { x: 0, z: 0, w: 0 };
  const spot = { x: 0, y: 0, z: 0 };
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);

  const bugs = [];
  let flowers = []; // resource instances (yarrow, chamomile) for landing
  const mothSources = []; // [{x,y,z,kind}] refreshed ~1 Hz
  let mothTimer = 0;

  function makeBug(i, moth) {
    return {
      i, moth, state: S_HIDDEN, vis: 0,
      x: 0, y: -100, z: 0, vx: 0, vy: 0, vz: 0,
      hx: 0, hz: 0, tx: 0, ty: 0, tz: 0,
      floorY: 0, floorT: 0, timer: 0,
      yaw: 0, pitch: 0, roll: 0, size: 1, speed: 1.5,
      ph: 0, rate: 8, glide: 0, glideT: 0, glider: false,
      angle: 1.3, jit: 0, orbitA: 0, orbitR: 0.8, src: -1,
    };
  }

  /** Ground (or water surface) height at x,z. */
  function floorAt(x, z) {
    const W = ctx.world;
    const g = W.heightAt(x, z);
    const w = g < 16 ? W.waterAt(x, z) : null; // water only exists below ~16 m on this island
    return w ? Math.max(g, w.surface) : g;
  }

  function newWanderTarget(b) {
    const rand = shared.rand;
    const a = rand() * TAU, r = 1.5 + rand() * (T.homeLeash - 3);
    b.tx = b.hx + Math.cos(a) * r;
    b.tz = b.hz + Math.sin(a) * r;
    b.ty = floorAt(b.tx, b.tz) + 0.45 + rand() * rand() * 2.2;
  }

  /** Find a flower near (x, z) into `spot`. Returns true if found. */
  function findFlower(x, z, r) {
    const fl = ctx.flora?.flowerNear?.(x, z, r);
    if (fl && Number.isFinite(fl.x)) {
      spot.x = fl.x;
      spot.z = fl.z;
      spot.y = Number.isFinite(fl.y) ? fl.y : ctx.world.heightAt(fl.x, fl.z) + 0.3;
      return true;
    }
    // resources: reservoir-sample a blooming yarrow / chamomile within r
    const rand = shared.rand;
    let n = 0, best = null;
    const r2 = r * r;
    for (let k = 0; k < flowers.length; k++) {
      const f = flowers[k];
      if (f.harvestedAt >= 0) continue;
      const d2 = (f.x - x) ** 2 + (f.z - z) ** 2;
      if (d2 > r2) continue;
      n++;
      if (rand() * n < 1) best = f;
    }
    if (best) {
      spot.x = best.x + (rand() - 0.5) * 0.08;
      spot.z = best.z + (rand() - 0.5) * 0.08;
      spot.y = best.y + (best.kind?.iy ?? 0.25) * 1.35;
      return true;
    }
    // fallback: a flowery meadow ground spot
    const H = shared.habitat;
    if (H.pick(H.butterfly, rand, x, z, 0, Math.min(r, 5), 6, tmp, 1.5)) {
      spot.x = tmp.x;
      spot.z = tmp.z;
      spot.y = ctx.world.heightAt(tmp.x, tmp.z) + 0.28;
      return true;
    }
    return false;
  }

  function spawnBug(b, rMin) {
    const H = shared.habitat;
    const f = shared.focus;
    const rand = shared.rand;
    if (!H.pick(H.butterfly, rand, f.x, f.z, rMin, T.radius - 4, 8, tmp, 1.4)) return false;
    if (ctx.world.waterAt(tmp.x, tmp.z)) return false;
    b.hx = tmp.x;
    b.hz = tmp.z;
    b.x = tmp.x;
    b.z = tmp.z;
    b.floorY = floorAt(b.x, b.z);
    b.y = b.floorY + 0.6 + rand() * 1.2;
    const a = rand() * TAU;
    b.speed = T.speed[0] + rand() * (T.speed[1] - T.speed[0]);
    b.vx = Math.cos(a) * b.speed;
    b.vz = Math.sin(a) * b.speed;
    b.vy = 0;
    b.state = S_FLY;
    b.vis = 0;
    b.ph = rand() * TAU;
    newWanderTarget(b);
    return true;
  }

  function startRest(b) {
    b.state = S_REST;
    b.x = b.tx;
    b.y = b.ty;
    b.z = b.tz;
    b.vx = b.vy = b.vz = 0;
    b.timer = T.rest[0] + shared.rand() * (T.rest[1] - T.rest[0]);
    b.roll = 0;
    b.pitch = -0.05;
  }

  function takeOff(b, awayX, awayZ, strength) {
    const rand = shared.rand;
    b.state = S_FLY;
    const a = rand() * TAU;
    b.vx = Math.cos(a) * 0.6 + awayX * strength;
    b.vz = Math.sin(a) * 0.6 + awayZ * strength;
    b.vy = 1.0 + rand() * 0.6;
    newWanderTarget(b);
  }

  // ── per-butterfly update ──────────────────────────────────────────────
  function updateBug(b, dt, fr) {
    const rand = shared.rand;
    const f = shared.focus;
    const dxF = b.x - f.x, dzF = b.z - f.z;
    const settle = fr.daylight < T.dayMin || fr.rain > T.rainMax;

    if (b.state === S_HIDDEN) return;
    // left behind -> recycle
    if (dxF * dxF + dzF * dzF > (T.radius + 8) ** 2) {
      b.state = S_HIDDEN;
      b.vis = 0;
      return;
    }
    // visibility fade (in on spawn, out when hiding at night)
    const wantVis = settle && fr.daylight < T.dayMin * 0.5 ? 0 : 1;
    b.vis += (wantVis - b.vis) * approach(wantVis ? 3 : 0.8, dt);
    if (!wantVis && b.vis < 0.02) {
      b.state = S_HIDDEN;
      b.vis = 0;
      return;
    }

    // player proximity (startle)
    let scare = 0, awayX = 0, awayZ = 0;
    if (fr.playing) {
      const px = b.x - fr.px, pz = b.z - fr.pz, py = b.y - (fr.py + 1);
      const d = Math.sqrt(px * px + pz * pz + py * py * 0.5) + 1e-4;
      const R = fr.sprinting ? T.scareSprint : T.scareWalk;
      if (d < R) {
        scare = 1 - d / R;
        awayX = px / d;
        awayZ = pz / d;
      }
    }

    if (b.state === S_REST) {
      b.timer -= dt;
      // basking: wings mostly closed, slowly opening and closing
      const bask = 0.5 - 0.5 * Math.cos(fr.t * 1.5 + b.ph);
      b.angle = 1.38 - 1.15 * bask * bask;
      if (scare > 0) takeOff(b, awayX, awayZ, 2.2);
      else if (b.timer <= 0 && !settle) takeOff(b, 0, 0, 0);
      return;
    }

    // flying / landing
    b.floorT -= dt;
    if (b.floorT <= 0) {
      b.floorT = 0.25 + rand() * 0.1;
      b.floorY = floorAt(b.x, b.z);
    }
    let dx = b.tx - b.x, dy = b.ty - b.y, dz = b.tz - b.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-5;
    let speed = b.speed;
    if (b.state === S_LAND) {
      speed = Math.min(b.speed, 0.25 + dist * 1.8); // arrive gently
      if (dist < 0.07) {
        startRest(b);
        return;
      }
    } else if (dist < 0.7) {
      // reached a wander point: maybe land on a flower, else wander on
      if ((settle || rand() < T.landChance) && findFlower(b.x, b.z, settle ? 14 : 8)) {
        b.state = S_LAND;
        b.tx = spot.x;
        b.ty = spot.y;
        b.tz = spot.z;
      } else newWanderTarget(b);
      dx = b.tx - b.x;
      dy = b.ty - b.y;
      dz = b.tz - b.z;
    }
    // leash to home
    const hx = b.x - b.hx, hz = b.z - b.hz;
    if (b.state === S_FLY && hx * hx + hz * hz > T.homeLeash * T.homeLeash * 1.6) {
      b.tx = b.hx;
      b.tz = b.hz;
      b.ty = floorAt(b.hx, b.hz) + 1;
    }
    const inv = speed / (Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-5);
    // erratic, bouncy flight: a sideways wobble and vertical hops on top of the steering
    b.jit += dt * (2.2 + (b.i % 5) * 0.3);
    const wob = Math.sin(b.jit * 1.7 + b.ph) * 0.9 + Math.sin(b.jit * 3.9) * 0.5;
    const desX = dx * inv - dz * inv * wob * 0.45 + awayX * scare * 4;
    const desZ = dz * inv + dx * inv * wob * 0.45 + awayZ * scare * 4;
    const desY = dy * inv + Math.sin(b.jit * 2.6 + b.ph * 2) * 0.55 + scare * 1.5;
    const k = approach(b.state === S_LAND ? 4 : 2.4, dt);
    b.vx += (desX - b.vx) * k;
    b.vy += (desY - b.vy) * k;
    b.vz += (desZ - b.vz) * k;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    const minY = b.floorY + (b.state === S_LAND ? 0.05 : 0.22);
    if (b.y < minY) {
      b.y = minY;
      if (b.vy < 0) b.vy *= -0.3;
    }
    // orientation from velocity
    const hs = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
    if (hs > 0.05) {
      const yaw = Math.atan2(b.vx, b.vz);
      let dyaw = yaw - b.yaw;
      if (dyaw > Math.PI) dyaw -= TAU;
      if (dyaw < -Math.PI) dyaw += TAU;
      b.yaw += dyaw * approach(8, dt);
      b.roll += (-dyaw * 0.8 - b.roll) * approach(5, dt);
    }
    b.pitch += (-0.28 - Math.atan2(b.vy, hs + 0.3) * 0.5 - b.pitch) * approach(6, dt);
    // flapping (+ short glides for the glider species)
    if (b.glider) {
      b.glideT -= dt;
      if (b.glideT <= 0) {
        b.glide = b.glide ? 0 : 1;
        b.glideT = b.glide ? 0.25 + rand() * 0.5 : 0.8 + rand() * 1.6;
      }
    }
    if (b.glide && b.state === S_FLY) b.angle += (0.12 - b.angle) * approach(12, dt);
    else {
      b.ph += dt * b.rate * TAU;
      b.angle = 0.32 + 0.98 * Math.sin(b.ph);
    }
  }

  // ── moths around heat sources ─────────────────────────────────────────
  function refreshMothSources() {
    mothSources.length = 0;
    const hs = ctx.heatSources;
    if (!hs || !hs.size) return;
    const f = shared.focus;
    for (const h of hs) {
      const p = h?.position;
      if (!p) continue;
      if ((p.x - f.x) ** 2 + (p.z - f.z) ** 2 > 50 * 50) continue;
      mothSources.push(h);
      if (mothSources.length >= 4) break;
    }
  }

  function updateMoth(b, dt, fr) {
    const night = fr.daylight < 0.35;
    const src = night && mothSources.length ? mothSources[b.i % mothSources.length] : null;
    const want = src ? 1 : 0;
    b.vis += (want - b.vis) * approach(want ? 1.2 : 2.5, dt);
    if (!src) {
      if (b.vis < 0.02) b.state = S_HIDDEN;
      b.angle = 0.3 + 0.9 * Math.sin((b.ph += dt * 13 * TAU));
      return;
    }
    const rand = shared.rand;
    const p = src.position;
    const torch = src.kind === 'torch';
    const cy = p.y + (torch ? 0.35 : 0.9);
    if (b.state === S_HIDDEN) {
      b.state = S_FLY;
      b.x = p.x + (rand() - 0.5) * 3;
      b.y = cy + rand();
      b.z = p.z + (rand() - 0.5) * 3;
      b.orbitA = rand() * TAU;
      b.orbitR = 0.35 + rand() * 0.8;
    }
    b.jit += dt;
    b.orbitA += dt * (2.2 + Math.sin(b.jit * 1.3 + b.ph) * 1.4) * (b.i % 2 ? 1 : -1);
    const r = b.orbitR * (0.75 + 0.45 * Math.sin(b.jit * 2.1 + b.ph));
    const tx = p.x + Math.cos(b.orbitA) * r + Math.sin(b.jit * 7.3) * 0.08;
    const tz = p.z + Math.sin(b.orbitA) * r + Math.cos(b.jit * 6.1) * 0.08;
    const ty = cy + Math.sin(b.jit * 1.7 + b.ph) * 0.35 + Math.sin(b.jit * 9.1) * 0.05;
    const k = approach(5, dt);
    const ox = b.x, oz = b.z;
    b.x += (tx - b.x) * k;
    b.y += (ty - b.y) * k;
    b.z += (tz - b.z) * k;
    const vx = b.x - ox, vz = b.z - oz;
    if (vx * vx + vz * vz > 1e-8) b.yaw = Math.atan2(vx, vz);
    b.pitch = -0.35;
    b.roll = Math.sin(b.jit * 3) * 0.3;
    b.ph += dt * 13 * TAU;
    b.angle = 0.3 + 0.9 * Math.sin(b.ph);
  }

  function write(b) {
    const o = b.i * 3;
    if (b.state === S_HIDDEN || b.vis < 0.01) {
      mesh.setMatrixAt(b.i, zero);
      return;
    }
    const bob = b.state === S_REST ? 0 : Math.cos(b.ph) * 0.012 * b.size;
    _p.set(b.x, b.y + bob, b.z);
    _e.set(b.pitch, b.yaw, b.roll, 'YXZ');
    _q.setFromEuler(_e);
    const s = b.size * b.vis;
    _s.set(s, s, s);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(b.i, _m);
    flap[o] = b.angle;
    flap[o + 1] = 1;
    flap[o + 2] = 0;
  }

  return {
    object: mesh,
    init() {
      const rand = shared.rand;
      let wsum = 0;
      for (const [, w] of SPECIES) wsum += w;
      for (let i = 0; i < N; i++) {
        const moth = i >= NB;
        const b = makeBug(i, moth);
        if (moth) {
          _c.set(MOTH_COLORS[i % MOTH_COLORS.length]);
          b.size = 0.55 + rand() * 0.25;
        } else {
          let r = rand() * wsum, hex = SPECIES[0][0], sp = 0;
          for (let k = 0; k < SPECIES.length; k++) {
            r -= SPECIES[k][1];
            if (r <= 0) {
              hex = SPECIES[k][0];
              sp = k;
              break;
            }
          }
          _c.set(hex).offsetHSL((rand() - 0.5) * 0.03, 0, (rand() - 0.5) * 0.06);
          b.size = 0.85 + rand() * 0.5;
          b.rate = 6 + rand() * 3;
          b.glider = sp === 0 || sp === 4 || rand() < 0.15; // monarchs / admirals glide between flaps
        }
        b.ph = rand() * TAU;
        mesh.setColorAt(i, _c);
        mesh.setMatrixAt(i, zero);
        bugs.push(b);
      }
      mesh.instanceColor.needsUpdate = true;
      // landing flowers from the finished resources system (yarrow + chamomile instances)
      const kinds = ctx.resources?.kinds;
      if (kinds) {
        for (const key of ['yarrow', 'chamomile']) {
          const insts = kinds[key]?.instances;
          if (Array.isArray(insts)) flowers = flowers.concat(insts.filter((s) => s && Number.isFinite(s.x)));
        }
      }
    },
    update(dt, fr) {
      const canFly = fr.daylight > T.dayMin + 0.06 && fr.rain < T.rainMax;
      // spawn a couple of hidden butterflies per frame (all at once after a teleport)
      let budget = fr.jumped ? NB : canFly ? T.spawnPerFrame : 0;
      for (let k = 0; k < NB && budget > 0; k++) {
        const b = bugs[k];
        if (fr.jumped && b.state !== S_HIDDEN) b.state = S_HIDDEN;
        if (b.state !== S_HIDDEN) continue;
        budget--;
        if (canFly) spawnBug(b, fr.jumped ? 3 : T.spawnMin);
      }
      for (let k = 0; k < NB; k++) updateBug(bugs[k], dt, fr);
      mothTimer -= dt;
      if (mothTimer <= 0) {
        mothTimer = 1;
        refreshMothSources();
      }
      for (let k = NB; k < N; k++) updateMoth(bugs[k], dt, fr);
      for (let k = 0; k < N; k++) write(bugs[k]);
      mesh.instanceMatrix.needsUpdate = true;
      aFlap.needsUpdate = true;
    },
    count: () => bugs.filter((b) => b.state !== S_HIDDEN).length,
    /** Debug: state histogram, e.g. __game.fauna.debug('butterflies') */
    debug: () => {
      const h = { hidden: 0, fly: 0, landing: 0, rest: 0, moths: 0 };
      for (const b of bugs) {
        if (b.moth) h.moths += b.state !== S_HIDDEN ? 1 : 0;
        else h[['hidden', 'fly', 'landing', 'rest'][b.state]]++;
      }
      return h;
    },
  };
}

