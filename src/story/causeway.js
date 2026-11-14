// The Giant's Road (V4-A, SPEC §12): the reward of the rune puzzle. A permanent, walkable stone causeway ~3 m wide,
// ~0.7 m above sea level, from landmarks.launchBeach (main island) to landmarks.isle2Cove (Tempest Isle): one
// InstancedMesh of slabs (one draw call, ~12 tris each, gaps and lower "puddle" slabs for irregularity) + a chain of
// ctx.colliders circles every ~2.2 m (y0 = -2, y1 = deck top, tag 'causeway') so the player walks on it and vehicles
// treat it as a wall. Both ends run a few slabs up onto the beaches.
//
// create(ctx, { from, to, circle }) -> { built, isOn(x,z), solve() -> Promise (the ~30 s skippable cinematic, then the
// road stays), build() (instant, no cinematic), update(dt), dispose(), path }. The pure path builder is exported for tests.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createParticles } from './fx.js';
import { createOverlay } from './overlay.js';

export const CAUSEWAY = {
  width: 3.0, // slab width (m)
  deck: 0.7, // deck top above sea level (m)
  spacing: 2.2, // slab pitch along the path (= collider pitch)
  slabLen: 1.95, // slab length (the rest is a gap)
  thickness: 0.55,
  wobble: 1.6, // lateral meander amplitude (m), zero at both ends
  puddleEvery: 9, // every n-th slab sits lower and wet
  puddleDrop: 0.22,
  inland: 3, // extra slabs past each beach point, up the beach
};
export const SKIP_KEYS = new Set(['Space', 'Enter', 'NumpadEnter', 'Escape']);

/** Solve cinematic timeline (seconds). Exported for tests. */
export const CT = {
  blaze: 0.6, // the stones light one by one from here (0.55 s apart)
  beam: 5.2, // the beam of light leaves the altar
  lookUp: 6.4, // the camera follows it up
  cut: 8.2, // hard cut to the launch beach
  riseStart: 9.0, // the road starts to rise out of the sea
  riseEnd: 24.0, // the far end reaches the cove
  lookBack: 24.5, // wide shot back along the road
  toast: 25.2, // achievement
  fadeOut: 28.6,
  end: 30.0,
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
const easeInOutCubic = (x) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

/**
 * Pure: the slab chain from beach point `a` to beach point `b` ({x,z}). Returns
 * { points: [{ x, z, y (deck top, world), yaw, puddle, k (0..1 along the road) }], dir: {x,z}, len, a, b }.
 * `sea` is the sea level, `rand` a 0..1 function (deterministic jitter). Points run `inland` slabs past each beach point.
 */
export function buildPath(a, b, { sea = 0, rand = Math.random, cfg = CAUSEWAY } = {}) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const dir = { x: dx / len, z: dz / len };
  const nx = -dir.z, nz = dir.x; // left normal
  const n = Math.ceil(len / cfg.spacing);
  const points = [];
  for (let i = -cfg.inland; i <= n + cfg.inland; i++) {
    const s = i * cfg.spacing;
    const t = clamp01(s / len);
    const win = Math.sin(Math.PI * t); // meander fades to zero at both beaches
    const off = cfg.wobble * win * (Math.sin(t * 17.3) * 0.6 + Math.sin(t * 41.7 + 1.0) * 0.4);
    const jit = (rand() - 0.5) * 0.08;
    const puddle = i > 2 && i < n - 2 && i % cfg.puddleEvery === 4;
    points.push({
      x: a.x + dir.x * s + nx * off,
      z: a.z + dir.z * s + nz * off,
      y: sea + cfg.deck + jit - (puddle ? cfg.puddleDrop : 0),
      yaw: Math.atan2(dir.x, dir.z) + (rand() - 0.5) * 0.08,
      puddle,
      k: (i + cfg.inland) / (n + 2 * cfg.inland),
    });
  }
  return { points, dir, len, a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z } };
}

/** Pure: is (x, z) on the road (within half a width + margin of the nearest slab center)? */
export function onPath(path, x, z, margin = 0.35) {
  if (!path) return false;
  const { points, dir, a } = path;
  const s = (x - a.x) * dir.x + (z - a.z) * dir.z;
  const i0 = Math.floor(s / CAUSEWAY.spacing) + CAUSEWAY.inland;
  const r = CAUSEWAY.width / 2 + margin;
  // distance to the nearest centerline segments
  for (let i = Math.max(0, i0 - 1); i <= Math.min(points.length - 2, i0 + 1); i++) {
    const p = points[i], q = points[i + 1];
    const ex = q.x - p.x, ez = q.z - p.z, l2 = ex * ex + ez * ez || 1;
    const u = clamp01(((x - p.x) * ex + (z - p.z) * ez) / l2);
    if (Math.hypot(x - (p.x + ex * u), z - (p.z + ez * u)) <= r) return true;
  }
  return false;
}

export function create(ctx, { from, to, circle = null, rand = null } = {}) {
  const scene = ctx.scene;
  const SEA = ctx.config?.world?.seaLevel ?? CONFIG.world?.seaLevel ?? 0;
  const rnd = rand || ctx.rng?.fork?.('causeway') || Math.random;
  const path = from && to ? buildPath(from, to, { sea: SEA, rand: rnd }) : null;
  const n = path ? path.points.length : 0;
  const overlay = createOverlay();
  const cam = ctx.camera;
  const colliders = [];
  let mesh = null, mat = null, geo = null;
  let built = false;
  let risen = -1; // slabs 0..risen are at their final pose (never rewritten again)
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
  const _t = new THREE.Vector3(), _f = new THREE.Vector3();

  function ensureMesh() {
    if (mesh || !path) return;
    geo = new THREE.BoxGeometry(CAUSEWAY.slabLen, CAUSEWAY.thickness, CAUSEWAY.width, 1, 1, 1);
    mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0, flatShading: true });
    mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.name = 'causeway';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    for (let i = 0; i < n; i++) {
      const p = path.points[i];
      const v = 0.86 + (rnd() - 0.5) * 0.16;
      _c.setRGB(0.56 * v, 0.53 * v, 0.47 * v);
      if (p.puddle) _c.multiplyScalar(0.72);
      mesh.setColorAt(i, _c);
      setSlab(i, -3.5); // under the sea until it rises
    }
    mesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene?.add?.(mesh);
  }
  /** Slab i at vertical offset dy from its final pose (0 = final). */
  function setSlab(i, dy) {
    const p = path.points[i];
    _p.set(p.x, p.y - CAUSEWAY.thickness / 2 + dy, p.z);
    _e.set(0, p.yaw, 0);
    _q.setFromEuler(_e);
    _s.set(1 + ((i * 7919) % 13) / 100, 1, 1);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
  }
  /** Rise front: slabs before k are up, the band just behind the front is still coming up. */
  function setRise(k) {
    if (!mesh) return;
    const band = 0.06;
    let contiguous = true;
    for (let i = risen + 1; i < n; i++) {
      const u = clamp01((k - path.points[i].k) / band); // 0 under water, 1 up
      setSlab(i, (1 - easeInOutCubic(u)) * -3.5);
      if (u >= 1 && contiguous) risen = i;
      else contiguous = false;
      if (u <= 0) break; // everything further along is still under the sea, untouched since ensureMesh()
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  function addColliders() {
    if (colliders.length || !path || !ctx.colliders?.add) return;
    for (const p of path.points) {
      // r > width/2 so the chain of circles still covers the slab edges halfway between two centers
      colliders.push(ctx.colliders.add({ x: p.x, z: p.z, r: CAUSEWAY.width / 2 + 0.3, y0: SEA - 2, y1: p.y, tag: 'causeway' }));
    }
  }
  /** The road is there, for good. */
  function build() {
    if (built || !path) return;
    ensureMesh();
    setRise(2);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    addColliders();
    built = true;
    ctx.events?.emit?.('causeway:built', { from: path.a, to: path.b, length: path.len });
  }
  /** World point on the road at fraction k (0 = launch beach, 1 = cove) + `up` m, written into out. */
  function roadPoint(k, up, out, side = 0) {
    const i = Math.min(n - 1, Math.max(0, Math.round(k * (n - 1))));
    const p = path.points[i];
    const nx = -path.dir.z, nz = path.dir.x;
    return out.set(p.x + nx * side, p.y + up, p.z + nz * side);
  }

  // ── Solve cinematic ────────────────────────────────────────────────────
  let active = false, elapsed = 0, cueIndex = 0, offKey = null, resolveFn = null, spray = null, lockOnFinish = false;
  const saved = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, fov: 72, cine: false };
  const stoneLit = new Float32Array(7);
  const beamK = { v: 0 };

  function setFov(f) {
    if (Math.abs(cam.fov - f) < 0.01) return;
    cam.fov = f;
    cam.updateProjectionMatrix();
  }
  function look(x, y, z, tx, ty, tz, roll = 0) {
    cam.position.set(x, Math.max(y, SEA + 0.4), z);
    _t.set(tx, ty, tz);
    cam.up.set(0, 1, 0);
    cam.lookAt(_t);
    if (roll) cam.rotateZ(roll);
  }
  function strike(strength) {
    if (ctx.weather?.lightning) ctx.weather.lightning({ strength, distance: 400 });
    else ctx.sky?.flash?.(strength);
    overlay.flash(0.3 * strength, 0.45);
  }
  const CUES = [
    [0.0, () => ctx.audio?.play?.('shimmer', { volume: 0.7 })],
    [0.5, () => overlay.showSkip(true)],
    [CT.beam, () => {
      ctx.audio?.play?.('whoosh', { volume: 0.9 });
      ctx.audio?.play?.('thunder', { volume: 0.5 });
    }],
    [CT.beam + 0.5, () => strike(0.9)],
    [CT.cut - 0.25, () => ctx.fade?.(1, 0.25)],
    [CT.cut, () => {
      ctx.fade?.(0, 0.5);
      overlay.subtitle('Far below, the sea begins to pull back along a line…', 4.5);
    }],
    [CT.riseStart, () => {
      ctx.audio?.play?.('impact', { volume: 1 });
      ctx.audio?.play?.('thunder', { volume: 0.7 });
    }],
    [CT.riseStart + 6, () => ctx.audio?.play?.('wreck', { volume: 0.6 })],
    [CT.riseStart + 12, () => ctx.audio?.play?.('impact', { volume: 0.7 })],
    [CT.riseEnd, () => {
      ctx.audio?.play?.('crash', { volume: 0.5 });
      strike(0.6);
    }],
    [CT.toast, () => {
      overlay.titleCard('THE GIANT’S ROAD', 'achievement', 4.2);
      ctx.audio?.play?.('secret', { volume: 1 });
      ctx.audio?.play?.('chime', { volume: 1 });
    }],
    [CT.fadeOut, () => ctx.fade?.(1, 0.7)],
  ];

  function stonesWorld() {
    return circle?.stones || [];
  }
  function updateStones(t) {
    // the stones blaze one by one, then all pulse; the beam grows out of the altar
    const stones = stonesWorld();
    for (let i = 0; i < 7; i++) {
      const on = clamp01((t - CT.blaze - i * 0.55) / 0.45);
      stoneLit[i] = Math.max(stoneLit[i], on);
      if (on > 0 && on < 1 && stones[i] && !stones[i]._chimed) {
        stones[i]._chimed = true;
        ctx.audio?.play?.('chime', { volume: 0.8, rate: 0.85 + i * 0.06 });
      }
    }
    beamK.v = clamp01((t - CT.beam) / 1.3);
    circle?.setBlaze?.(stoneLit, beamK.v, t);
  }

  function shot(t, dt) {
    if (!path) return;
    const C = circle || { x: 0, z: 0, y: 0 };
    if (t < CT.cut) {
      // at the circle: a slow push toward the altar, then the eye follows the beam up
      const a = -0.9 + t * 0.05;
      const push = 13 - 4.5 * smooth(t / CT.beam);
      const up = smooth((t - CT.lookUp) / (CT.cut - CT.lookUp));
      const cx = C.x + Math.sin(a) * push, cz = C.z + Math.cos(a) * push;
      const floor = (ctx.world?.heightAt?.(cx, cz) ?? C.y) + 1.3;
      look(cx, Math.max(floor, C.y + 2.2 + up * 1.5), cz, C.x, C.y + 1.2 + up * 140, C.z, Math.sin(t * 0.7) * 0.01);
      setFov(lerp(62, 70, up));
    } else if (t < CT.lookBack) {
      // the road rises: the camera flies above and beside the front, looking down at it
      const kFront = smooth((t - CT.riseStart) / (CT.riseEnd - CT.riseStart));
      const kCam = Math.max(0, kFront - 0.07);
      const settle = smooth((t - CT.cut) / 1.6);
      roadPoint(kCam, lerp(10, 22, settle), _p, lerp(26, 15, settle));
      roadPoint(Math.min(1, kFront + 0.04), 0.5, _t);
      look(_p.x, _p.y, _p.z, _t.x, _t.y, _t.z, Math.sin(t * 0.5) * 0.012);
      setFov(lerp(62, 58, settle));
      // the sea pulls back: foam and spray along the rising front
      if (spray && t >= CT.riseStart && kFront < 1) {
        roadPoint(kFront, 0.2, _f);
        const dx = path.dir.x, dz = path.dir.z, nx = -dz, nz = dx;
        for (let i = 0; i < 7; i++) {
          const side = (Math.random() - 0.5) * 6, along = (Math.random() - 0.5) * 6;
          spray.spawn(_f.x + nx * side + dx * along, _f.y + Math.random() * 0.6, _f.z + nz * side + dz * along, nx * side * 1.2 + (Math.random() - 0.5) * 2, 3 + Math.random() * 6, nz * side * 1.2 + (Math.random() - 0.5) * 2, 1.2 + Math.random() * 1.3, 0.9 + Math.random() * 1.3, 0xdfe9ee, 0.8, 1.6);
        }
      }
    } else {
      // wide shot from above the cove back along the road toward Driftwood Isle
      const u = smooth((t - CT.lookBack) / (CT.fadeOut - CT.lookBack));
      roadPoint(1, 24 + u * 10, _p, 18 - u * 6);
      roadPoint(0.45, 2, _t);
      look(_p.x, _p.y, _p.z, _t.x, _t.y, _t.z);
      setFov(lerp(58, 52, u));
    }
    // the road itself
    if (t >= CT.riseStart) setRise(smooth((t - CT.riseStart) / (CT.riseEnd - CT.riseStart)) * 1.08);
    spray?.update(dt, { gravity: 9.8, drag: 0.6, floorY: SEA });
  }

  function finish() {
    if (!active) return;
    active = false;
    offKey?.();
    offKey = null;
    overlay.hideSubtitle();
    overlay.hideTitle();
    overlay.showSkip(false);
    circle?.setBlaze?.(null, 0, 0);
    if (spray) {
      scene?.remove?.(spray.points);
      spray.points.geometry.dispose();
      spray.points.material.dispose();
      spray = null;
    }
    build();
    cam.position.copy(saved.pos);
    cam.rotation.set(saved.pitch, saved.yaw, 0, 'YXZ');
    setFov(saved.fov);
    if (ctx.player) {
      if ('yaw' in ctx.player) ctx.player.yaw = saved.yaw;
      if ('pitch' in ctx.player) ctx.player.pitch = saved.pitch;
    }
    if (ctx.flags) ctx.flags.cinematic = saved.cine;
    ctx.letterbox?.(false);
    ctx.fade?.(0, 0.8);
    if (lockOnFinish && ctx.input?.lock && !ctx.input.locked) {
      try {
        ctx.input.lock();
      } catch (_) {}
    }
    lockOnFinish = false;
    const r = resolveFn;
    resolveFn = null;
    r?.();
  }

  /** The 30 s cinematic; resolves when the road is built (also on skip). null if it cannot run. */
  function solve() {
    if (built || active || !path) return null;
    if (ctx.state !== 'playing' || ctx.flags?.cinematic) return null;
    active = true;
    elapsed = 0;
    cueIndex = 0;
    stoneLit.fill(0);
    for (const s of stonesWorld()) s._chimed = false;
    saved.pos.copy(cam.position);
    saved.yaw = ctx.player?.yaw ?? cam.rotation.y;
    saved.pitch = ctx.player?.pitch ?? cam.rotation.x;
    saved.fov = cam.fov;
    saved.cine = !!ctx.flags?.cinematic;
    if (ctx.flags) ctx.flags.cinematic = true;
    ctx.letterbox?.(true);
    ctx.ui?.setPrompt?.(null);
    ensureMesh();
    spray = createParticles({ count: 480 });
    spray.setViewport?.(typeof window !== 'undefined' ? window.innerHeight : 720, 60);
    scene?.add?.(spray.points);
    offKey = ctx.input?.onKeyDown?.((code) => {
      if (active && elapsed > 0.5 && SKIP_KEYS.has(code)) {
        lockOnFinish = true;
        finish();
      }
    }) || null;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    shot(0, 0);
    return promise;
  }

  function update(dt) {
    if (!active) return;
    overlay.update(dt);
    if (ctx.state !== 'playing' && ctx.state !== 'paused') {
      finish();
      return;
    }
    if (ctx.state !== 'playing') return;
    dt = Math.min(dt, 0.1);
    elapsed += dt;
    const t = elapsed;
    try {
      while (cueIndex < CUES.length && CUES[cueIndex][0] <= t) {
        const fn = CUES[cueIndex][1];
        cueIndex++;
        fn();
      }
      updateStones(t);
      shot(t, dt);
      if (t >= CT.end) {
        lockOnFinish = true;
        finish();
      }
    } catch (e) {
      console.error('[causeway] cinematic failed, building the road', e);
      finish();
    }
  }

  return {
    path,
    get built() {
      return built;
    },
    get active() {
      return active;
    },
    isOn: (x, z) => built && onPath(path, x, z),
    solve,
    build,
    update,
    dispose() {
      if (active) finish();
      for (const c of colliders) ctx.colliders?.remove?.(c);
      colliders.length = 0;
      if (mesh) {
        scene?.remove?.(mesh);
        geo?.dispose();
        mat?.dispose();
      }
      mesh = null;
      built = false;
      risen = -1;
    },
  };
}
