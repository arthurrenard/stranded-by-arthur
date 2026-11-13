// Hail (v3, Tempest Isle storms): small white ice pellets that fall around the camera, bounce twice on the
// ground, rest for a moment and melt; they vanish into water. One InstancedMesh (20-triangle pellets), a
// tiny CPU simulation over the active pellets only (no allocations per frame). The ground height of each
// pellet's landing spot is looked up once when it spawns.
import * as THREE from 'three';

const N = 260;
const RADIUS = 12; // m around the camera
const GRAVITY = 24;

export function createHail(ctx, scene) {
  const rng = ctx.rng?.fork ? ctx.rng.fork('weather-hail') : Math.random;
  const geo = new THREE.IcosahedronGeometry(0.032, 0);
  const mat = new THREE.MeshLambertMaterial({ color: 0xeef3f6, emissive: 0x30363c });
  mat.name = 'world-hail';
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.name = 'weather-hail';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; // positions change every frame around the camera
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.count = 0;
  mesh.visible = false;
  scene.add(mesh);

  const M = mesh.instanceMatrix.array;
  const px = new Float32Array(N), py = new Float32Array(N), pz = new Float32Array(N);
  const vx = new Float32Array(N), vy = new Float32Array(N), vz = new Float32Array(N);
  const gy = new Float32Array(N); // landing surface y
  const wet = new Uint8Array(N); // lands in water: vanish on contact
  const phase = new Uint8Array(N); // 0 falling, 1 bouncing, 2 resting
  const bounces = new Uint8Array(N);
  const rest = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = 0.7 + 0.6 * rng(); // size variation lives in the matrix diagonal (set once)
    const o = i * 16;
    M[o] = s;
    M[o + 5] = s;
    M[o + 10] = s;
    M[o + 15] = 1;
    M[o + 13] = -9999;
  }
  let active = 0;

  function spawn(i, cam, wx, wz, hw, spread) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * RADIUS;
    px[i] = cam.x + Math.cos(a) * r;
    pz[i] = cam.z + Math.sin(a) * r;
    py[i] = cam.y + 3 + (spread ? rng() * 12 : 8 + rng() * 6);
    vy[i] = -(13 + 6 * rng());
    vx[i] = wx * hw * (0.8 + 0.4 * rng());
    vz[i] = wz * hw * (0.8 + 0.4 * rng());
    phase[i] = 0;
    bounces[i] = 0;
    // landing spot: where the drift carries it by the time it reaches the camera's feet level
    const W = ctx.world;
    const tf = Math.max(0.05, (py[i] - (cam.y - 1.7)) / -vy[i]);
    const lx = px[i] + vx[i] * tf, lz = pz[i] + vz[i] * tf;
    const g = W?.heightAt?.(lx, lz) ?? 0;
    const w = W?.waterAt?.(lx, lz);
    if (w) {
      wet[i] = 1;
      gy[i] = w.type === 'ocean' ? (W.SEA_LEVEL ?? 0) : Number.isFinite(w.surface) ? w.surface : g;
    } else {
      wet[i] = 0;
      gy[i] = g;
    }
  }

  return {
    mesh,
    /** amount 0..1 (hail at the camera, already masked for shelter/canopy/underwater); wind {x, z, strength}. */
    update(dt, amount, wind) {
      const cam = ctx.camera.position;
      const target = Math.round(N * Math.max(0, Math.min(1, amount)));
      if (target === 0 && active === 0) {
        if (mesh.visible) mesh.visible = false;
        return;
      }
      const wx = wind?.x ?? 0, wz = wind?.z ?? 0, hw = (wind?.strength ?? 0) * 3.5;
      if (target > active) {
        for (let i = active; i < target; i++) spawn(i, cam, wx, wz, hw, true);
      }
      active = target;
      mesh.count = active;
      mesh.visible = active > 0;
      const h = Math.min(dt, 0.05);
      for (let i = 0; i < active; i++) {
        const ph = phase[i];
        if (ph === 2) {
          rest[i] -= h;
          if (rest[i] <= 0) spawn(i, cam, wx, wz, hw, false);
        } else {
          if (ph === 1) vy[i] -= GRAVITY * h;
          px[i] += vx[i] * h;
          py[i] += vy[i] * h;
          pz[i] += vz[i] * h;
          if (py[i] <= gy[i] && vy[i] < 0) {
            if (wet[i]) spawn(i, cam, wx, wz, hw, false);
            else if (bounces[i] < 2) {
              py[i] = gy[i] + 0.01;
              const k = (bounces[i] === 0 ? 0.32 : 0.18) * (0.75 + 0.5 * rng());
              vy[i] = -vy[i] * k;
              const a = rng() * Math.PI * 2, sp = 0.4 + 1.1 * rng();
              vx[i] = Math.cos(a) * sp + wx * 0.3;
              vz[i] = Math.sin(a) * sp + wz * 0.3;
              bounces[i]++;
              phase[i] = 1;
            } else {
              py[i] = gy[i] + 0.02;
              phase[i] = 2;
              rest[i] = 0.5 + rng() * 0.9;
            }
          }
          // walked away from it, or it fell far below (cliff edge): recycle
          const dx = px[i] - cam.x, dz = pz[i] - cam.z;
          if (dx * dx + dz * dz > RADIUS * RADIUS * 2.2 || py[i] < gy[i] - 3) spawn(i, cam, wx, wz, hw, false);
        }
        const o = i * 16;
        M[o + 12] = px[i];
        M[o + 13] = py[i];
        M[o + 14] = pz[i];
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
