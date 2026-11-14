// Fresh-water life (Builder C — fauna): lily pads + water lilies, fish shadows, dragonflies, frogs, ripples.
//
// - Lily pads: static patches in the shallows of Mirror Lake and Spring Pond (one InstancedMesh), some
//   with a pink-white water lily that opens by day and closes at night (instance scale, ~2 Hz updates).
// - Fish shadows: soft dark silhouettes gliding just under the surface in loose schools (tail wiggle in
//   the vertex shader), steering away from the shallows; now and then one rises and leaves a ripple.
//   Drawn as a low-alpha decal at level + 0.015 (depthWrite off, renderOrder after the water) so they
//   read whatever the lake shader does (transparent, opaque or none).
// - Dragonflies (day): hover-and-dart over the water near the player, glassy buzzing wings (a second
//   transparent InstancedMesh sharing the body's instance matrices), sometimes dipping to the surface.
// - Frogs: on lily pads and banks. At night they croak (throat sac inflates; ctx.audio 'frog' from frogs
//   within ~40 m, chorus-limited by a global random cooldown). They leap into the water ('splash') when
//   the player comes close (earlier when sprinting) and resurface on their spot later.
// - Ripples: a pool of soft additive rings (fish rising, frogs plopping, dragonflies dipping).
import * as THREE from 'three';
import { smoothstep } from '../../core/util.js';
import {
  lilyPadGeometry, lilyFlowerGeometry, fishShadowGeometry, dragonflyBodyGeometry,
  dragonflyWingGeometry, frogGeometry, rippleGeometry, FROG_SAC_CENTER,
} from './faunaMeshes.js';
import { patchFlap, approach, TAU, pickEdgeNear, playSound } from './faunaShared.js';

const T = {
  padPatches: { lake: 11, pond: 3 },
  flowerChance: 0.22,
  fish: { lake: 16, pond: 5 },
  fishView: 150, // fish update / draw only when the player is this close to the lake (m)
  dragonflies: 14,
  dragonRadius: 55, // dragonflies live at water edges within this distance of the player
  frogs: { lake: 12, pond: 7, river: 10 },
  frogView: 70,
  croakRange: 40, // audible croaks from frogs this close
  ripples: 14,
};

const FROG_TINTS = [0xffffff, 0xd8e8b0, 0xc7b48a, 0xb8d890, 0xe8f0c0];
const DRAGON_COLORS = [0x2f7dff, 0x22c46a, 0xe8452c, 0x19b5c8, 0x8a5cff, 0xf0b020];

/** Vertex-color emissive boost (rigid meshes: no flap). */
function patchGlow(material, key, glow) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = { value: glow };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n  totalEmissiveRadiance += vColor.rgb * uGlow; // fauna-glow\n#endif');
  };
  material.customProgramCacheKey = () => 'fauna-glow-' + key;
  return material;
}

export function createWaterLife(ctx, shared) {
  const rand = shared.rand;
  const rr = (a, b) => a + (b - a) * rand();
  const group = [];
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler(0, 0, 0, 'YXZ');
  const _s = new THREE.Vector3();
  const _c = new THREE.Color();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const _white = new THREE.Color(1, 1, 1);
  const W = () => ctx.world;

  function compose(x, y, z, yaw, pitch, roll, sx, sy = sx, sz = sx) {
    _p.set(x, y, z);
    _e.set(pitch, yaw, roll, 'YXZ');
    _q.setFromEuler(_e);
    _s.set(sx, sy, sz);
    return _m.compose(_p, _q, _s);
  }

  // ── meshes (created up front; filled in init) ─────────────────────────
  const MAX_PADS = 200;
  const padMesh = new THREE.InstancedMesh(
    lilyPadGeometry(shared.geoRand),
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    MAX_PADS
  );
  padMesh.name = 'lilypads';
  padMesh.receiveShadow = true;
  padMesh.count = 0;
  const flowerMesh = new THREE.InstancedMesh(lilyFlowerGeometry(shared.geoRand), patchGlow(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'lily', 0.12), 60);
  flowerMesh.name = 'waterlilies';
  flowerMesh.count = 0;

  const fishMat = new THREE.MeshBasicMaterial({
    color: 0x0c2632, transparent: true, opacity: 0.32, depthWrite: false, vertexColors: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
  fishMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
// fauna-fish: swimming wiggle, stronger toward the tail (-Z)
#ifdef USE_INSTANCING
  float fph = instanceMatrix[3].x * 1.37 + instanceMatrix[3].z * 0.71;
#else
  float fph = 0.0;
#endif
float ftail = 1.0 - smoothstep( -0.3, 0.12, position.z ); // GLSL smoothstep needs edge0 < edge1
transformed.x += sin( uTime * 6.5 + fph - position.z * 9.0 ) * ( 0.01 + 0.05 * ftail );`
      );
  };
  fishMat.customProgramCacheKey = () => 'fauna-fish';
  const NF = T.fish.lake + T.fish.pond;
  const fishMesh = new THREE.InstancedMesh(fishShadowGeometry(), fishMat, NF);
  fishMesh.name = 'fish';
  fishMesh.renderOrder = 2;
  fishMesh.frustumCulled = false;

  const ND = T.dragonflies;
  const dBody = new THREE.InstancedMesh(dragonflyBodyGeometry(shared.geoRand), patchGlow(new THREE.MeshLambertMaterial({ vertexColors: true }), 'dragonfly', 0.28), ND);
  const wingGeo = dragonflyWingGeometry(shared.geoRand);
  const dFlap = new Float32Array(ND * 3);
  const aDFlap = new THREE.InstancedBufferAttribute(dFlap, 3).setUsage(THREE.DynamicDrawUsage);
  wingGeo.setAttribute('aFlap', aDFlap);
  const wingMat = patchFlap(
    new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
    'dragonfly-wing',
    { glow: 0.35 }
  );
  const dWing = new THREE.InstancedMesh(wingGeo, wingMat, ND);
  dWing.instanceMatrix = dBody.instanceMatrix; // wings share the body transforms
  dBody.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dBody.name = 'dragonflies';
  dWing.name = 'dragonfly-wings';
  dBody.frustumCulled = dWing.frustumCulled = false;
  dWing.renderOrder = 3;

  const frogMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  frogMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSac;\nattribute float aCroak;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
// fauna-frog: inflate the throat sac while croaking
if ( aSac > 0.5 ) {
  vec3 sacC = vec3( ${FROG_SAC_CENTER.map((v) => v.toFixed(4)).join(', ')} );
  transformed = sacC + ( transformed - sacC ) * ( 0.75 + aCroak * 1.9 );
}`
      );
  };
  frogMat.customProgramCacheKey = () => 'fauna-frog';
  const NFR = T.frogs.lake + T.frogs.pond + T.frogs.river;
  const frogGeo = frogGeometry(shared.geoRand);
  const croak = new Float32Array(NFR);
  const aCroak = new THREE.InstancedBufferAttribute(croak, 1).setUsage(THREE.DynamicDrawUsage);
  frogGeo.setAttribute('aCroak', aCroak);
  const frogMesh = new THREE.InstancedMesh(frogGeo, frogMat, NFR);
  frogMesh.name = 'frogs';
  frogMesh.frustumCulled = false;
  frogMesh.castShadow = false;

  const NR = T.ripples;
  const rippleMesh = new THREE.InstancedMesh(
    rippleGeometry(),
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    NR
  );
  rippleMesh.name = 'ripples';
  rippleMesh.frustumCulled = false;
  rippleMesh.renderOrder = 3;

  for (const m of [padMesh, flowerMesh, fishMesh, dBody, dWing, frogMesh, rippleMesh]) {
    m.raycast = () => {};
    m.castShadow = false;
    group.push(m);
  }
  for (const m of [fishMesh, dBody, frogMesh, rippleMesh]) for (let i = 0; i < m.count; i++) m.setMatrixAt(i, zero);

  // ── ripples ───────────────────────────────────────────────────────────
  const ripples = [];
  for (let i = 0; i < NR; i++) ripples.push({ on: false, x: 0, y: 0, z: 0, t: 0, dur: 2, size: 1, k: 1 });
  let rippleCursor = 0;
  function ripple(x, y, z, size = 1, strength = 1) {
    const r = ripples[rippleCursor];
    rippleCursor = (rippleCursor + 1) % NR;
    r.on = true;
    r.x = x;
    r.y = y + 0.02;
    r.z = z;
    r.t = 0;
    r.dur = 1.6 + size * 0.9;
    r.size = size;
    r.k = strength;
  }
  function updateRipples(dt, fr) {
    const light = 0.18 + 0.55 * fr.daylight;
    for (let i = 0; i < NR; i++) {
      const r = ripples[i];
      if (!r.on) {
        rippleMesh.setMatrixAt(i, zero);
        continue;
      }
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) {
        r.on = false;
        rippleMesh.setMatrixAt(i, zero);
        continue;
      }
      const s = r.size * (0.12 + 1.1 * Math.sqrt(k));
      rippleMesh.setMatrixAt(i, compose(r.x, r.y, r.z, 0, 0, 0, s, 1, s));
      const b = r.k * light * Math.pow(1 - k, 1.6);
      _c.setRGB(0.75 * b, 0.9 * b, 1.0 * b);
      rippleMesh.setColorAt(i, _c);
    }
    rippleMesh.instanceMatrix.needsUpdate = true;
    if (rippleMesh.instanceColor) rippleMesh.instanceColor.needsUpdate = true;
  }

  // ── lily pads + flowers (static) ──────────────────────────────────────
  const pads = [];
  const flowers = [];
  let flowerT = 0;
  let lastOpen = -1;
  function placePads() {
    const duck = W().landmarks?.duck;
    for (const L of W().lakes) {
      const edges = shared.edges.filter((e) => e.waterId === L.id);
      if (!edges.length) continue;
      const patches = T.padPatches[L.id] ?? 3;
      for (let p = 0; p < patches; p++) {
        const e = edges[Math.floor(rand() * edges.length)];
        const out = rr(2.5, L.id === 'pond' ? 4.5 : 8);
        const cx = e.x + e.nx * out, cz = e.z + e.nz * out;
        const n = L.id === 'pond' ? Math.round(rr(5, 9)) : Math.round(rr(6, 15));
        for (let k = 0; k < n * 3 && pads.length < MAX_PADS && n > 0; k++) {
          const a = rand() * TAU, d = Math.sqrt(rand()) * (L.id === 'pond' ? 2.2 : 3.4);
          const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
          const w = W().waterAt(x, z);
          if (!w || w.id !== L.id || w.depth < 0.25 || w.depth > 2.8) continue;
          if (duck && Math.hypot(x - duck.x, z - duck.z) < 3) continue;
          const r = rr(0.32, 0.7);
          let clash = false;
          for (let q = pads.length - 1; q >= 0 && q > pads.length - 40; q--) {
            const o = pads[q];
            if (Math.hypot(o.x - x, o.z - z) < (o.r + r) * 0.92) {
              clash = true;
              break;
            }
          }
          if (clash) continue;
          pads.push({ x, z, r, y: L.level + 0.03, yaw: rand() * TAU, lake: L.id, frog: false });
          if (pads.length % 40 === 0) break;
        }
      }
    }
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      padMesh.setMatrixAt(i, compose(p.x, p.y, p.z, p.yaw, 0, 0, p.r, 1, p.r));
      const k = rr(0.78, 1.15); // brightness / warmth tint around 1.0 (vertex colors carry the green)
      _c.setRGB(k * rr(0.9, 1.15), k, k * rr(0.85, 1.05));
      padMesh.setColorAt(i, _c);
      if (flowers.length < flowerMesh.instanceMatrix.count && rand() < T.flowerChance) {
        const a = rand() * TAU;
        flowers.push({ x: p.x + Math.cos(a) * p.r * 0.3, z: p.z + Math.sin(a) * p.r * 0.3, y: p.y + 0.005, yaw: rand() * TAU, s: rr(0.85, 1.25) });
      }
    }
    padMesh.count = pads.length;
    padMesh.instanceMatrix.needsUpdate = true;
    if (padMesh.instanceColor) padMesh.instanceColor.needsUpdate = true;
    padMesh.computeBoundingSphere();
    flowerMesh.count = flowers.length;
    for (let i = 0; i < flowers.length; i++) {
      _c.setHSL(0.92 + rr(-0.04, 0.05), 0.5, 0.95);
      _c.lerp(_white, 0.6);
      flowerMesh.setColorAt(i, _c);
    }
    if (flowerMesh.instanceColor) flowerMesh.instanceColor.needsUpdate = true;
    writeFlowers(1);
    flowerMesh.computeBoundingSphere();
  }
  function writeFlowers(open) {
    for (let i = 0; i < flowers.length; i++) {
      const f = flowers[i];
      const sxz = f.s * (0.5 + 0.5 * open), sy = f.s * (1.25 - 0.25 * open);
      flowerMesh.setMatrixAt(i, compose(f.x, f.y, f.z, f.yaw, 0, 0, sxz, sy, sxz));
    }
    flowerMesh.instanceMatrix.needsUpdate = true;
  }

  // ── fish shadows ──────────────────────────────────────────────────────
  const fish = [];
  const schools = [];
  function lakeById(id) {
    return W().lakes.find((l) => l.id === id);
  }
  /** Deep enough water of lake L at (x, z)? */
  function deepOk(L, x, z, margin = 1.0) {
    if (Math.hypot(x - L.x, z - L.z) > L.waterRadius - 1) return false;
    return W().heightAt(x, z) < L.level - margin;
  }
  function placeFish() {
    for (const id of ['lake', 'pond']) {
      const L = lakeById(id);
      if (!L) continue;
      const nSchools = id === 'lake' ? 3 : 1;
      const sc = [];
      for (let s = 0; s < nSchools; s++) {
        const school = { L, x: L.x, z: L.z, tx: L.x, tz: L.z, t: 0 };
        for (let t = 0; t < 40; t++) {
          const a = rand() * TAU, d = Math.sqrt(rand()) * L.waterRadius * 0.7;
          const x = L.x + Math.cos(a) * d, z = L.z + Math.sin(a) * d;
          if (deepOk(L, x, z, id === 'pond' ? 0.7 : 1.2)) {
            school.x = school.tx = x;
            school.z = school.tz = z;
            break;
          }
        }
        sc.push(school);
        schools.push(school);
      }
      const n = T.fish[id];
      for (let i = 0; i < n; i++) {
        const school = sc[i % sc.length];
        fish.push({
          L, school, x: school.x + rr(-3, 3), z: school.z + rr(-3, 3), yaw: rand() * TAU,
          speed: rr(0.35, 0.8), base: rr(0.35, 0.8), s: id === 'pond' ? rr(0.5, 0.8) : rr(0.7, 1.35),
          wph: rand() * TAU, riseT: rr(6, 30), dart: 0,
        });
      }
    }
  }
  function updateSchoolTarget(s) {
    const L = s.L;
    for (let t = 0; t < 10; t++) {
      const a = rand() * TAU, d = Math.sqrt(rand()) * L.waterRadius * 0.75;
      const x = L.x + Math.cos(a) * d, z = L.z + Math.sin(a) * d;
      if (deepOk(L, x, z, L.id === 'pond' ? 0.7 : 1.2)) {
        s.tx = x;
        s.tz = z;
        break;
      }
    }
    s.t = rr(10, 25);
  }
  function updateFish(dt, fr) {
    const f = shared.focus;
    const lakeNear = (L) => Math.hypot(f.x - L.x, f.z - L.z) < T.fishView + L.waterRadius;
    for (const s of schools) {
      if (!lakeNear(s.L)) continue;
      s.t -= dt;
      if (s.t <= 0) updateSchoolTarget(s);
      const dx = s.tx - s.x, dz = s.tz - s.z, d = Math.hypot(dx, dz);
      if (d > 0.3) {
        s.x += (dx / d) * Math.min(d, 0.5 * dt);
        s.z += (dz / d) * Math.min(d, 0.5 * dt);
      }
    }
    fishMat.opacity = 0.3 * (0.35 + 0.65 * fr.daylight);
    for (let i = 0; i < fish.length; i++) {
      const F = fish[i];
      const L = F.L;
      if (!lakeNear(L)) {
        fishMesh.setMatrixAt(i, zero);
        continue;
      }
      // steering: toward the school, a lazy wander, and away from the shallows
      F.wph += dt * 0.6;
      let want = Math.atan2(F.school.x - F.x, F.school.z - F.z);
      const toSchool = Math.hypot(F.school.x - F.x, F.school.z - F.z);
      let wDes = toSchool > 4 ? 0.6 : 0.15;
      const ahead = 1.6 * F.s + 0.8;
      const ax = F.x + Math.sin(F.yaw) * ahead, az = F.z + Math.cos(F.yaw) * ahead;
      if (!deepOk(L, ax, az, 0.6)) {
        want = Math.atan2(L.x - F.x, L.z - F.z);
        wDes = 2.5;
      }
      let dYaw = want - F.yaw;
      if (dYaw > Math.PI) dYaw -= TAU;
      if (dYaw < -Math.PI) dYaw += TAU;
      F.yaw += (dYaw * wDes + Math.sin(F.wph * 1.3 + i) * 0.35) * dt;
      // occasional burst of speed
      if (F.dart > 0) F.dart -= dt;
      else if (rand() < dt * 0.04) F.dart = rr(0.4, 1.0);
      const sp = F.dart > 0 ? F.base * 3 : F.base;
      F.speed += (sp - F.speed) * approach(3, dt);
      F.x += Math.sin(F.yaw) * F.speed * dt;
      F.z += Math.cos(F.yaw) * F.speed * dt;
      // a fish rises now and then (ripple)
      F.riseT -= dt;
      if (F.riseT <= 0) {
        F.riseT = rr(10, 40);
        if (Math.hypot(F.x - f.x, F.z - f.z) < 70) ripple(F.x + Math.sin(F.yaw) * 0.2 * F.s, L.level, F.z + Math.cos(F.yaw) * 0.2 * F.s, 0.5 + F.s * 0.5, 0.9);
      }
      fishMesh.setMatrixAt(i, compose(F.x, L.level + 0.015, F.z, F.yaw, 0, 0, F.s));
    }
    fishMesh.instanceMatrix.needsUpdate = true;
  }

  // ── dragonflies ───────────────────────────────────────────────────────
  const dragons = [];
  for (let i = 0; i < ND; i++) {
    dragons.push({
      on: false, vis: 0, e: null, x: 0, y: -50, z: 0, ox: 0, oy: 0, oz: 0, tx: 0, ty: 0, tz: 0,
      yaw: 0, roll: 0, hover: rr(0.3, 2), dart: -1, dur: 0.5, ph: rand() * TAU, dip: false, bob: rand() * TAU,
    });
  }
  function dragonTarget(D) {
    const e = D.e;
    const along = rr(-5, 5), out = rr(0.6, 6);
    const tx = e.x + e.nx * out - e.nz * along, tz = e.z + e.nz * out + e.nx * along;
    const w = W().waterAt(tx, tz);
    D.tx = tx;
    D.tz = tz;
    if (w && w.fresh) {
      D.dip = rand() < 0.1;
      D.ty = w.surface + (D.dip ? 0.03 : rr(0.25, 1.2));
    } else {
      D.dip = false;
      D.ty = W().heightAt(tx, tz) + rr(0.6, 1.4);
    }
  }
  function spawnDragon(D) {
    const f = shared.focus;
    const e = pickEdgeNear(shared.edges, rand, f.x, f.z, T.dragonRadius);
    if (!e) return false;
    D.e = e;
    D.on = true;
    D.vis = 0;
    dragonTarget(D);
    D.x = D.tx;
    D.y = D.ty + 0.3;
    D.z = D.tz;
    D.dart = -1;
    D.hover = rr(0.3, 1.5);
    return true;
  }
  let dragonSpawnT = 0;
  function updateDragons(dt, fr) {
    const active = fr.daylight > 0.35 && fr.rain < 0.5;
    const f = shared.focus;
    dragonSpawnT -= dt;
    const trySpawn = active && dragonSpawnT <= 0;
    if (trySpawn) dragonSpawnT = 0.5;
    let spawned = false;
    for (let i = 0; i < ND; i++) {
      const D = dragons[i];
      if (fr.jumped) D.on = false;
      if (!D.on) {
        if ((trySpawn && !spawned) || (fr.jumped && active)) {
          spawned = spawnDragon(D);
        }
        if (!D.on) {
          dBody.setMatrixAt(i, zero);
          continue;
        }
      }
      if (Math.hypot(D.e.x - f.x, D.e.z - f.z) > T.dragonRadius + 15) {
        D.on = false;
        dBody.setMatrixAt(i, zero);
        continue;
      }
      D.vis += ((active ? 1 : 0) - D.vis) * approach(1.5, dt);
      if (!active && D.vis < 0.02) {
        D.on = false;
        dBody.setMatrixAt(i, zero);
        continue;
      }
      // curious but quick: dart away if the player gets very close
      if (fr.playing && D.dart < 0 && Math.hypot(D.x - fr.px, D.z - fr.pz) < 1.3 && Math.abs(D.y - fr.py - 1) < 1.5) D.hover = 0;
      if (D.dart < 0) {
        D.hover -= dt;
        D.bob += dt;
        D.yaw += Math.sin(D.bob * 0.7 + i) * 0.4 * dt;
        D.roll *= 1 - approach(5, dt);
        if (D.hover <= 0) {
          D.ox = D.x;
          D.oy = D.y;
          D.oz = D.z;
          dragonTarget(D);
          const dist = Math.hypot(D.tx - D.x, D.ty - D.y, D.tz - D.z);
          D.dur = Math.max(0.18, dist / rr(5, 8));
          D.dart = 0;
          const ny = Math.atan2(D.tx - D.x, D.tz - D.z);
          let dy = ny - D.yaw;
          if (dy > Math.PI) dy -= TAU;
          if (dy < -Math.PI) dy += TAU;
          D.roll = -dy * 0.25;
          D.yaw = ny;
        }
      } else {
        D.dart += dt / D.dur;
        const k = Math.min(1, D.dart);
        const e = k * k * (3 - 2 * k);
        D.x = D.ox + (D.tx - D.ox) * e;
        D.y = D.oy + (D.ty - D.oy) * e;
        D.z = D.oz + (D.tz - D.oz) * e;
        if (D.dart >= 1) {
          D.dart = -1;
          D.hover = rr(0.4, 2.4);
          if (D.dip) {
            if (Math.hypot(D.x - f.x, D.z - f.z) < 50) ripple(D.x, D.y - 0.03, D.z, 0.35, 0.8);
            D.hover = 0.12; // touch and go
          }
        }
      }
      const by = D.dart < 0 ? Math.sin(D.bob * 3.1 + i) * 0.03 : 0;
      D.ph += dt * TAU * 27;
      dFlap[i * 3] = 0.12 + 0.38 * Math.sin(D.ph);
      dFlap[i * 3 + 1] = 1;
      dFlap[i * 3 + 2] = 0.1;
      const s = D.vis * 1.15;
      dBody.setMatrixAt(i, compose(D.x, D.y + by, D.z, D.yaw, 0, D.roll, s));
    }
    dBody.instanceMatrix.needsUpdate = true;
    aDFlap.needsUpdate = true;
  }

  // ── frogs ─────────────────────────────────────────────────────────────
  const frogs = [];
  const F_SIT = 0, F_JUMP = 1, F_UNDER = 2, F_UP = 3;
  let chorusCD = 0;
  let splashCD = 0;
  function placeFrogs() {
    const edges = shared.edges;
    const add = (x, y, z, yaw, wx, wz, surface, onPad) => {
      frogs.push({
        x, y, z, yaw, wx, wz, surface, onPad, state: F_SIT, t: 0, vis: 1, s: rr(0.85, 1.3),
        croakT: rr(1, 12), pulses: 0, pulseT: 0, cx: x, cy: y, cz: z, breathe: rand() * TAU, look: 0,
      });
    };
    for (const id of ['lake', 'pond', 'river']) {
      let n = T.frogs[id];
      // on lily pads (lakes)
      if (id !== 'river') {
        const cand = pads.filter((p) => p.lake === id && p.r > 0.42 && !p.frog);
        for (let k = 0; k < Math.ceil(n / 2) && cand.length; k++) {
          const p = cand.splice(Math.floor(rand() * cand.length), 1)[0];
          p.frog = true;
          add(p.x, p.y + 0.012, p.z, rand() * TAU, p.x + rr(-1, 1), p.z + rr(-1, 1), p.y - 0.03, true);
          n--;
        }
      }
      const es = edges.filter((e) => e.waterId === id);
      for (let k = 0; k < n && es.length; k++) {
        const e = es.splice(Math.floor(rand() * es.length), 1)[0];
        const yaw = Math.atan2(e.nx, e.nz) + rr(-0.6, 0.6); // facing the water
        add(e.x, W().heightAt(e.x, e.z), e.z, yaw, e.x + e.nx * 1.4, e.z + e.nz * 1.4, e.surface, false);
      }
    }
    for (let i = 0; i < frogs.length; i++) {
      _c.set(FROG_TINTS[i % FROG_TINTS.length]);
      frogMesh.setColorAt(i, _c);
    }
    if (frogMesh.instanceColor) frogMesh.instanceColor.needsUpdate = true;
    frogMesh.count = frogs.length;
  }
  function updateFrogs(dt, fr) {
    const f = shared.focus;
    const night = fr.daylight < 0.3;
    chorusCD -= dt;
    splashCD -= dt;
    for (let i = 0; i < frogs.length; i++) {
      const G = frogs[i];
      const dF = Math.hypot(G.x - f.x, G.z - f.z);
      if (dF > T.frogView) {
        frogMesh.setMatrixAt(i, zero);
        croak[i] = 0;
        continue;
      }
      const dP = Math.hypot(G.x - fr.px, G.z - fr.pz);
      if (G.state === F_SIT) {
        // startled -> leap into the water
        if (fr.playing && dP < (fr.sprinting ? 6 : 2.6)) {
          G.state = F_JUMP;
          G.t = 0;
          G.pulses = 0;
          G.yaw = Math.atan2(G.wx - G.x, G.wz - G.z);
        } else {
          // croaking at night: a few throat pulses; audible from the nearest frogs (chorus cooldown)
          G.croakT -= dt;
          if (G.croakT <= 0 && G.pulses <= 0) {
            if (night) {
              const audible = dP < T.croakRange && fr.playing;
              if (!audible || chorusCD <= 0) {
                G.pulses = 2 + Math.floor(rand() * 3);
                G.pulseT = 0;
                if (audible) {
                  chorusCD = rr(1.5, 6);
                  _p.set(G.x, G.y + 0.05, G.z);
                  playSound(ctx, 'frog', { position: _p.clone(), volume: 0.35 + 0.5 * (1 - dP / T.croakRange), rate: 0.85 + G.s * 0.2 });
                }
                G.croakT = rr(4, 14);
              } else G.croakT = rr(0.4, 2);
            } else G.croakT = rr(5, 20);
          }
          if (G.pulses > 0) {
            G.pulseT += dt / 0.3;
            croak[i] = Math.sin(Math.min(1, G.pulseT) * Math.PI);
            if (G.pulseT >= 1) {
              G.pulseT = 0;
              G.pulses--;
            }
          } else croak[i] = 0;
          // idle: breathe, glance around
          G.breathe += dt * 2.2;
          G.look -= dt;
          if (G.look <= 0) {
            G.look = rr(3, 12);
            G.yaw += rr(-0.5, 0.5);
          }
        }
        G.cx = G.x;
        G.cy = G.y;
        G.cz = G.z;
      } else if (G.state === F_JUMP) {
        G.t += dt / 0.45;
        const k = Math.min(1, G.t);
        G.cx = G.x + (G.wx - G.x) * k;
        G.cz = G.z + (G.wz - G.z) * k;
        G.cy = G.y + (G.surface - G.y) * k + Math.sin(k * Math.PI) * 0.4;
        croak[i] = 0;
        if (k >= 1) {
          G.state = F_UNDER;
          G.t = rr(15, 35);
          if (dF < 60) ripple(G.wx, G.surface, G.wz, 0.6, 1.2);
          if (splashCD <= 0 && fr.playing) {
            splashCD = 0.3;
            _p.set(G.wx, G.surface, G.wz);
            playSound(ctx, 'splash', { position: _p.clone(), volume: 0.22 });
          }
        }
      } else if (G.state === F_UNDER) {
        G.t -= dt;
        if (G.t <= 0 && dP > 8) {
          G.state = F_UP;
          G.vis = 0;
          if (G.onPad) ripple(G.x, G.surface, G.z, 0.4, 0.6);
        }
      } else if (G.state === F_UP) {
        G.vis = Math.min(1, G.vis + dt * 1.5);
        G.cx = G.x;
        G.cy = G.y;
        G.cz = G.z;
        if (G.vis >= 1) {
          G.state = F_SIT;
          G.croakT = rr(2, 8);
        }
      }
      if (G.state === F_UNDER) {
        frogMesh.setMatrixAt(i, zero);
        continue;
      }
      const br = G.state === F_SIT ? 1 + Math.sin(G.breathe) * 0.025 : 1;
      const pitch = G.state === F_JUMP ? -0.5 + G.t * 0.9 : 0;
      const s = G.s * (G.state === F_UP ? G.vis : 1);
      frogMesh.setMatrixAt(i, compose(G.cx, G.cy, G.cz, G.yaw, pitch, 0, s, s * br, s));
    }
    frogMesh.instanceMatrix.needsUpdate = true;
    aCroak.needsUpdate = true;
  }

  return {
    object: group,
    ripple,
    init() {
      placePads();
      placeFish();
      placeFrogs();
      for (let i = 0; i < NR; i++) {
        _c.setRGB(0, 0, 0);
        rippleMesh.setColorAt(i, _c);
      }
      for (let i = 0; i < ND; i++) {
        _c.set(DRAGON_COLORS[i % DRAGON_COLORS.length]);
        dBody.setColorAt(i, _c);
        _c.setHSL(0.55 + rr(-0.08, 0.08), 0.35, 0.92);
        dWing.setColorAt(i, _c);
      }
      dBody.instanceColor.needsUpdate = true;
      dWing.instanceColor.needsUpdate = true;
    },
    update(dt, fr) {
      // water lilies open by day
      flowerT -= dt;
      if (flowerT <= 0) {
        flowerT = 0.5;
        const open = Math.round(smoothstep(0.12, 0.6, fr.daylight) * 50) / 50;
        if (open !== lastOpen) {
          lastOpen = open;
          writeFlowers(open);
        }
      }
      updateFish(dt, fr);
      updateDragons(dt, fr);
      updateFrogs(dt, fr);
      // V4-E: no draw call (and no instance upload) for empty ripple / dragonfly sets
      let anyR = false;
      for (let i = 0; i < NR; i++) {
        if (ripples[i].on) {
          anyR = true;
          break;
        }
      }
      if (anyR || rippleMesh.visible) updateRipples(dt, fr);
      rippleMesh.visible = anyR;
      let anyD = false;
      for (let i = 0; i < ND; i++) {
        if (dragons[i].on) {
          anyD = true;
          break;
        }
      }
      dBody.visible = dWing.visible = anyD;
    },
    count: () => ({
      pads: pads.length,
      lilies: flowers.length,
      fish: fish.length,
      dragonflies: dragons.filter((d) => d.on).length,
      frogs: frogs.filter((g) => g.state !== F_UNDER).length,
      ripples: ripples.filter((r) => r.on).length,
    }),
    debug: () => ({
      frogs: frogs.map((g) => ({ x: Math.round(g.x), z: Math.round(g.z), state: g.state, pad: g.onPad })),
    }),
  };
}

