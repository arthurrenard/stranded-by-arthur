// The island's shape: one deterministic heightfield that every module queries.
// The terrain MESH is built from exactly this grid (buildGeometry) and heightAt() interpolates
// over the same triangles, so feet, plants and rocks sit exactly on the rendered ground.
//
// Compass: north = -Z, east = +X. Bearings are degrees clockwise from north.
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { CONFIG } from '../config.js';
import { createRng } from '../core/rng.js';
import { clamp, lerp, smoothstep, fbm } from '../core/util.js';

export function createHeightfield() {
  const { size, cells, islandRadius: R, seaLevel: SEA } = CONFIG.world;
  const HALF = size / 2;
  const CELL = size / cells;
  const N1 = cells + 1;
  const rng = createRng(CONFIG.seed).fork('terrain');
  const nCoast = createNoise2D(rng);
  const nHills = createNoise2D(rng);
  const nDetail = createNoise2D(rng);
  const nMeadow = createNoise2D(rng);
  const nMount = createNoise2D(rng);
  const nLake = createNoise2D(rng);
  const nForest = createNoise2D(rng);

  const SUMMIT = { x: 95, z: -105, h: 56, r: 125, plateauR: 13, height: 0 };

  // ── Base island shape ──────────────────────────────────────────────────
  function coastWobble(x, z) {
    const a = Math.atan2(z, x);
    const c = Math.cos(a), s = Math.sin(a);
    return 1 + 0.11 * nCoast(c * 1.2, s * 1.2) + 0.06 * nCoast(c * 3.1 + 7.3, s * 3.1 + 7.3) + 0.025 * nDetail(x * 0.02, z * 0.02);
  }
  function islandness(x, z) {
    return Math.hypot(x, z) / (R * coastWobble(x, z)); // 0 center .. 1 coastline
  }
  function baseHeight(x, z, noPlateau = false) {
    const rn = islandness(x, z);
    let coastal;
    if (rn <= 1) coastal = 2.6 * smoothstep(1.0, 0.85, rn);
    else coastal = -26 * smoothstep(1.0, 1.4, rn) - 1.2 * smoothstep(1.0, 1.06, rn);
    const inland = smoothstep(0.92, 0.6, rn);
    const hills = fbm(nHills, x, z, 5, 0.0065);
    const detail = fbm(nDetail, x, z, 3, 0.03) * 0.8;
    let h = coastal + inland * (5 + 9 * (hills * 0.5 + 0.5)) + detail * smoothstep(1.03, 0.9, rn);
    const dm = Math.hypot(x - SUMMIT.x, z - SUMMIT.z);
    const m = clamp(1 - dm / SUMMIT.r, 0, 1);
    if (m > 0) {
      const mm = Math.min(m / 0.9, 1);
      const ridges = 1 - Math.abs(nMount(x * 0.018, z * 0.018));
      const flat = smoothstep(0.8, 0.93, m);
      h += SUMMIT.h * Math.pow(mm, 1.7) * ((1 - flat) * (0.88 + 0.12 * ridges) + flat) + ridges * 2.5 * m * (1 - flat);
    }
    if (!noPlateau && dm < SUMMIT.plateauR + 6) {
      h = lerp(h, SUMMIT.height, smoothstep(SUMMIT.plateauR + 6, SUMMIT.plateauR - 4, dm));
    }
    return h;
  }
  SUMMIT.height = baseHeight(SUMMIT.x, SUMMIT.z, true);

  // ── Lakes ──────────────────────────────────────────────────────────────
  const lakes = [
    { id: 'lake', name: 'Mirror Lake', x: -60, z: -40, r: 38, depth: 5.5, levelOffset: 0.5 },
    { id: 'pond', name: 'Spring Pond', x: 72, z: 228, r: 10, depth: 2.2, levelOffset: -0.3 },
  ];
  for (const L of lakes) {
    L.level = baseHeight(L.x, L.z) + L.levelOffset;
    L.rim = L.level + 0.8;
    L.seed = rng() * 100;
    L.waterRadius = L.r * 1.3; // radius of the flat water disc to render (terrain hides the excess)
  }
  function lakeShoreRadius(L, x, z) {
    const a = Math.atan2(z - L.z, x - L.x);
    return L.r * (1 + 0.13 * nLake(Math.cos(a) * 1.6 + L.seed, Math.sin(a) * 1.6));
  }
  function applyLakes(h, x, z) {
    for (const L of lakes) {
      const dl = Math.hypot(x - L.x, z - L.z);
      const outer = L.r * 2.4;
      if (dl >= outer) continue;
      const re = lakeShoreRadius(L, x, z);
      const basin = L.rim + Math.max(0, dl - re) * 0.2;
      let hh = lerp(h, basin, smoothstep(outer, re, dl));
      if (dl < re) {
        const k = dl / re;
        const bed = L.level - L.depth * (1 - k * k);
        hh = lerp(bed, L.rim, smoothstep(0.72, 1.0, k));
      } else if (dl < L.r * 1.5) hh = Math.max(hh, L.level + 0.3);
      h = hh;
    }
    return h;
  }

  // ── River (from Mirror Lake to the south-west coast) ───────────────────
  const mainLake = lakes[0];
  const ctrl = [
    [mainLake.x, mainLake.z],
    [-92, 2],
    [-108, 55],
    [-142, 112],
    [-160, 175],
    [-196, 235],
    [-232, 290],
    [-262, 335],
  ];
  const riverPts = []; // full polyline (starts at lake center), used for carving
  {
    const P = ctrl.map(([x, z]) => new THREE.Vector2(x, z));
    const ext = [P[0].clone().multiplyScalar(2).sub(P[1]), ...P, P[P.length - 1].clone().multiplyScalar(2).sub(P[P.length - 2])];
    for (let i = 1; i < ext.length - 2; i++) {
      const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
      const segLen = p1.distanceTo(p2);
      const steps = Math.max(2, Math.ceil(segLen / 2.5));
      for (let k = 0; k < steps; k++) {
        const t = k / steps, t2 = t * t, t3 = t2 * t;
        const x = 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
        const z = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
        riverPts.push({ x, z });
      }
    }
    riverPts.push({ x: ctrl[ctrl.length - 1][0], z: ctrl[ctrl.length - 1][1] });
    let s = 0;
    for (let i = 0; i < riverPts.length; i++) {
      if (i > 0) s += Math.hypot(riverPts[i].x - riverPts[i - 1].x, riverPts[i].z - riverPts[i - 1].z);
      riverPts[i].s = s;
    }
    const total = s;
    // Surface: lake level inside the lake zone, then monotonic descent following the ground.
    let prev = mainLake.level;
    for (const p of riverPts) {
      const dl = Math.hypot(p.x - mainLake.x, p.z - mainLake.z);
      const g = applyLakes(baseHeight(p.x, p.z), p.x, p.z);
      p.surface = dl < mainLake.waterRadius ? mainLake.level : Math.max(-0.5, Math.min(prev, g - 0.7));
      prev = p.surface;
      p.u = p.s / total;
      p.w = lerp(3.2, 6.5, p.u); // half-width
    }
    // Smooth while staying monotonic
    for (let it = 0; it < 6; it++) {
      for (let i = 1; i < riverPts.length - 1; i++) {
        const dl = Math.hypot(riverPts[i].x - mainLake.x, riverPts[i].z - mainLake.z);
        if (dl < mainLake.waterRadius) continue;
        riverPts[i].surface = (riverPts[i - 1].surface + riverPts[i].surface * 2 + riverPts[i + 1].surface) / 4;
      }
      for (let i = 1; i < riverPts.length; i++) riverPts[i].surface = Math.min(riverPts[i].surface, riverPts[i - 1].surface);
    }
    for (let i = 0; i < riverPts.length; i++) {
      const a = riverPts[Math.max(0, i - 1)], b = riverPts[Math.min(riverPts.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      riverPts[i].dirX = dx / l;
      riverPts[i].dirZ = dz / l;
    }
  }
  const riverBBox = riverPts.reduce(
    (b, p) => ({ x0: Math.min(b.x0, p.x), x1: Math.max(b.x1, p.x), z0: Math.min(b.z0, p.z), z1: Math.max(b.z1, p.z) }),
    { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity }
  );
  const RIVER_DEPTH = 1.4;
  /** Exact closest point on the river polyline: { d, s, i, t } (i = segment index). */
  function riverClosest(x, z) {
    let best = Infinity, bi = 0, bt = 0;
    for (let i = 0; i < riverPts.length - 1; i++) {
      const a = riverPts[i], b = riverPts[i + 1];
      const abx = b.x - a.x, abz = b.z - a.z;
      const l2 = abx * abx + abz * abz || 1e-6;
      let t = ((x - a.x) * abx + (z - a.z) * abz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + abx * t - x, pz = a.z + abz * t - z;
      const d2 = px * px + pz * pz;
      if (d2 < best) {
        best = d2;
        bi = i;
        bt = t;
      }
    }
    return { d: Math.sqrt(best), i: bi, t: bt };
  }
  function riverAttrAt(i, t) {
    const a = riverPts[i], b = riverPts[Math.min(i + 1, riverPts.length - 1)];
    return { surface: lerp(a.surface, b.surface, t), w: lerp(a.w, b.w, t), s: lerp(a.s, b.s, t), u: lerp(a.u, b.u, t) };
  }
  function applyRiver(h, x, z, rc) {
    const { surface, w } = riverAttrAt(rc.i, rc.t);
    const d = rc.d;
    const outer = w * 4.5;
    if (d >= outer) return h;
    const dl = Math.hypot(x - mainLake.x, z - mainLake.z);
    const bankW = smoothstep(mainLake.r * 1.05, mainLake.r * 1.45, dl);
    let banked = h;
    if (d < w) {
      const bed = surface + 0.35 - (RIVER_DEPTH + 0.35) * (1 - (d / w) * (d / w));
      banked = Math.min(h, bed);
      // inside the lake zone only carve, never raise
      return lerp(Math.min(h, bed), banked, bankW);
    }
    const target = surface + 0.35 + (d - w) * 0.28;
    banked = lerp(target, h, smoothstep(w, outer, d));
    return lerp(h, banked, bankW);
  }

  // ── Build the grid ─────────────────────────────────────────────────────
  const heights = new Float32Array(N1 * N1);
  const riverD = new Float32Array(N1 * N1);
  const riverI = new Float32Array(N1 * N1); // segment index + t (fractional)
  const PAD = 45;
  for (let j = 0; j < N1; j++) {
    const z = -HALF + j * CELL;
    for (let i = 0; i < N1; i++) {
      const x = -HALF + i * CELL;
      let h = baseHeight(x, z);
      h = applyLakes(h, x, z);
      const idx = j * N1 + i;
      if (x > riverBBox.x0 - PAD && x < riverBBox.x1 + PAD && z > riverBBox.z0 - PAD && z < riverBBox.z1 + PAD) {
        const rc = riverClosest(x, z);
        riverD[idx] = rc.d;
        riverI[idx] = rc.i + rc.t;
        h = applyRiver(h, x, z, rc);
      } else {
        riverD[idx] = 1e4;
        riverI[idx] = 0;
      }
      heights[idx] = h;
    }
  }

  // ── Tempest Isle: a smaller, stormy second island to the north-east ──────
  // It has its own grid with the same 2.5 m spacing. heightAt() merges both grids with max(); where they
  // overlap both lie on the ~-27 m ocean floor, so the seam is invisible. It sits ~460 m of open sea away
  // from the nearest main-island beach (landmarks.launchBeach): too far to swim, reachable by raft or boat.
  const ISLE2 = { id: 'isle2', name: 'Tempest Isle', x: 660, z: -640, R: 150, half: 240 };
  ISLE2.cells = Math.round((ISLE2.half * 2) / CELL);
  ISLE2.cell = (ISLE2.half * 2) / ISLE2.cells;
  ISLE2.N1 = ISLE2.cells + 1;
  ISLE2.x0 = ISLE2.x - ISLE2.half;
  ISLE2.z0 = ISLE2.z - ISLE2.half;
  {
    const l = Math.hypot(ISLE2.x, ISLE2.z);
    ISLE2.toMain = { x: -ISLE2.x / l, z: -ISLE2.z / l }; // unit vector from Tempest Isle toward the main island
  }
  // The "dangerous mountain": a steep peak with a fishing hut on its small summit plateau. The face toward
  // the cove is a steep but walkable ridge; the other faces are terraced cliffs.
  const PEAK2 = { x: ISLE2.x + 22, z: ISLE2.z - 18, h: 82, r: 118, plateauR: 9, height: 0 };
  function isle2Wobble(x, z) {
    const a = Math.atan2(z - ISLE2.z, x - ISLE2.x);
    const c = Math.cos(a), s = Math.sin(a);
    return 1 + 0.14 * nCoast(c * 1.4 + 31.7, s * 1.4 - 12.2) + 0.06 * nCoast(c * 3.3 - 8.1, s * 3.3 + 4.4);
  }
  function isle2ness(x, z) {
    return Math.hypot(x - ISLE2.x, z - ISLE2.z) / (ISLE2.R * isle2Wobble(x, z));
  }
  /** 1 inside the sheltered cove facing the main island (beach + dock), 0 on the cliff coasts. */
  function isle2Cove(x, z) {
    const dx = x - ISLE2.x, dz = z - ISLE2.z, d = Math.hypot(dx, dz) || 1;
    return smoothstep(0.62, 0.86, (dx * ISLE2.toMain.x + dz * ISLE2.toMain.z) / d);
  }
  function isle2Base(x, z, noPlateau = false) {
    const rn = isle2ness(x, z);
    const cove = isle2Cove(x, z);
    const beach = rn <= 1 ? 2.4 * smoothstep(1.0, 0.86, rn) : -24 * smoothstep(1.0, 1.35, rn) - 1.4 * smoothstep(1.0, 1.05, rn);
    const cliff = rn <= 1 ? 2 + 10 * smoothstep(1.0, 0.9, rn) : 2 - 29 * smoothstep(1.0, 1.1, rn);
    let h = lerp(cliff, beach, cove);
    const inland = smoothstep(0.92, 0.55, rn);
    const hills = fbm(nHills, x + 913, z - 377, 4, 0.009);
    h += inland * (3 + 6 * (hills * 0.5 + 0.5)) + fbm(nDetail, x, z, 3, 0.035) * 0.9 * smoothstep(1.03, 0.9, rn);
    const dx = x - PEAK2.x, dz = z - PEAK2.z, dm = Math.hypot(dx, dz);
    const m = clamp(1 - dm / PEAK2.r, 0, 1);
    if (m > 0) {
      const mm = Math.min(m / 0.92, 1);
      const face = dm > 1e-3 ? (dx * ISLE2.toMain.x + dz * ISLE2.toMain.z) / dm : 1;
      const smoothFace = smoothstep(0.35, 0.85, face);
      const ridges = 1 - Math.abs(nMount(x * 0.03 + 50, z * 0.03 - 20));
      const terraces = 0.075 * Math.sin(mm * Math.PI * 7) * (1 - smoothFace) * mm;
      const flat = smoothstep(0.86, 0.95, m);
      h += PEAK2.h * (Math.pow(mm, 1.3) + terraces) * ((1 - flat) * (0.9 + 0.1 * ridges) + flat);
    }
    if (!noPlateau && dm < PEAK2.plateauR + 5) h = lerp(h, PEAK2.height, smoothstep(PEAK2.plateauR + 5, PEAK2.plateauR - 3, dm));
    return h;
  }
  PEAK2.height = isle2Base(PEAK2.x, PEAK2.z, true);
  // a small freshwater spring pool near the cove (drinkable)
  {
    const tm = ISLE2.toMain, perp = { x: tm.z, z: -tm.x };
    const P = { id: 'isle2pond', name: 'Rain Pool', island: 'isle2', r: 6, depth: 1.8, levelOffset: -0.25 };
    P.x = ISLE2.x + tm.x * 92 + perp.x * 22;
    P.z = ISLE2.z + tm.z * 92 + perp.z * 22;
    P.level = isle2Base(P.x, P.z) + P.levelOffset;
    P.rim = P.level + 0.8;
    P.seed = rng() * 100;
    P.waterRadius = P.r * 1.3;
    lakes.push(P);
  }
  for (const L of lakes) L.island ??= 'main';
  const heights2 = new Float32Array(ISLE2.N1 * ISLE2.N1);
  for (let j = 0; j < ISLE2.N1; j++) {
    const z = ISLE2.z0 + j * ISLE2.cell;
    for (let i = 0; i < ISLE2.N1; i++) {
      const x = ISLE2.x0 + i * ISLE2.cell;
      heights2[j * ISLE2.N1 + i] = applyLakes(isle2Base(x, z), x, z);
    }
  }
  const GRIDS = [
    { id: 'main', heights, x0: -HALF, z0: -HALF, cell: CELL, cells, N1 },
    { id: 'isle2', heights: heights2, x0: ISLE2.x0, z0: ISLE2.z0, cell: ISLE2.cell, cells: ISLE2.cells, N1: ISLE2.N1 },
  ];

  // ── Queries ────────────────────────────────────────────────────────────
  /** Height from one grid (triangle interpolation, same diagonal as buildGeometry), or NaN outside it. */
  function gridHeight(G, x, z) {
    const fx = (x - G.x0) / G.cell, fz = (z - G.z0) / G.cell;
    if (fx < 0 || fz < 0 || fx >= G.cells || fz >= G.cells) return NaN;
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const n1 = G.N1, hs = G.heights;
    const k = j * n1 + i;
    const h00 = hs[k], h10 = hs[k + 1], h01 = hs[k + n1], h11 = hs[k + n1 + 1];
    if (v > u) return h00 + (h11 - h01) * u + (h01 - h00) * v;
    return h00 + (h10 - h00) * u + (h11 - h10) * v;
  }
  /** Ground height, exactly matching the rendered terrain triangles (both islands). -30 off every grid. */
  function heightAt(x, z) {
    const a = gridHeight(GRIDS[0], x, z);
    const b = gridHeight(GRIDS[1], x, z);
    if (a !== a) return b !== b ? -30 : b; // NaN checks
    if (b !== b) return a;
    return a > b ? a : b;
  }
  /** 'main' | 'isle2' | null (open sea): which island a point belongs to (coastline + ~8 % margin). */
  function islandAt(x, z) {
    if (islandness(x, z) < 1.08) return 'main';
    if (isle2ness(x, z) < 1.08) return 'isle2';
    return null;
  }
  function gridBilinear(arr, x, z) {
    const fx = clamp((x + HALF) / CELL, 0, cells - 1e-4), fz = clamp((z + HALF) / CELL, 0, cells - 1e-4);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const k = j * N1 + i;
    return lerp(lerp(arr[k], arr[k + 1], u), lerp(arr[k + N1], arr[k + N1 + 1], u), v);
  }
  const _n = new THREE.Vector3();
  /** Unit ground normal (returns a shared vector unless `out` is given). */
  function normalAt(x, z, out = _n) {
    const e = 1.0;
    const hl = heightAt(x - e, z), hr = heightAt(x + e, z), hd = heightAt(x, z - e), hu = heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }
  /** 0 flat .. 1 vertical */
  function slopeAt(x, z) {
    return 1 - normalAt(x, z).y;
  }
  /** Approximate river info at a point: { d (distance to centerline), surface, w, u (0 source..1 mouth) }. */
  function riverAt(x, z) {
    if (x < riverBBox.x0 - PAD || x > riverBBox.x1 + PAD || z < riverBBox.z0 - PAD || z > riverBBox.z1 + PAD) return null;
    const d = gridBilinear(riverD, x, z);
    if (d > 60) return null;
    // fractional segment index is not linear-safe across the medial axis; use nearest vertex's value
    const fx = Math.round((x + HALF) / CELL), fz = Math.round((z + HALF) / CELL);
    const fi = riverI[clamp(fz, 0, cells) * N1 + clamp(fx, 0, cells)];
    const i = Math.min(Math.floor(fi), riverPts.length - 2);
    const a = riverAttrAt(i, fi - i);
    return { d, ...a };
  }
  /**
   * Water at a point, or null if dry ground.
   * { type: 'ocean'|'lake'|'river', fresh: bool, surface: y of water surface, depth: surface-ground, id? }
   */
  function waterAt(x, z) {
    const g = heightAt(x, z);
    for (const L of lakes) {
      const dl = Math.hypot(x - L.x, z - L.z);
      if (dl < L.waterRadius && g < L.level) return { type: 'lake', fresh: true, surface: L.level, depth: L.level - g, id: L.id, name: L.name };
    }
    const r = riverAt(x, z);
    if (r && r.d < r.w * 1.05 && g < r.surface && r.surface > SEA + 0.05) {
      return { type: 'river', fresh: true, surface: r.surface, depth: r.surface - g, id: 'river' };
    }
    if (g < SEA) return { type: 'ocean', fresh: false, surface: SEA, depth: SEA - g, id: 'ocean' };
    return null;
  }
  /** Positive inland (meters to the nominal coastline), negative at sea. Approximate. */
  function coastDistance(x, z) {
    const a = R * coastWobble(x, z) - Math.hypot(x, z);
    const b = ISLE2.R * isle2Wobble(x, z) - Math.hypot(x - ISLE2.x, z - ISLE2.z);
    return a > b ? a : b;
  }
  /**
   * Biome weights at a point (all 0..1): sand, rock, highland, meadow, wet, forest.
   * Plus h (height), slope, rn (islandness), water (waterAt result or null).
   */
  function biomeAt(x, z) {
    const h = heightAt(x, z);
    const slope = slopeAt(x, z);
    const rn = Math.min(islandness(x, z), isle2ness(x, z)); // whichever island this point belongs to
    const water = waterAt(x, z);
    const sand = rn > 0.74 ? smoothstep(3.5, 2.2, h) * smoothstep(0.74, 0.86, rn) : 0;
    const rock = Math.max(smoothstep(0.32, 0.52, slope), smoothstep(47, 55, h));
    const highland = smoothstep(20, 34, h);
    let wet = 0;
    for (const L of lakes) {
      const dl = Math.hypot(x - L.x, z - L.z);
      wet = Math.max(wet, smoothstep(L.r * 1.15 + 14, L.r * 1.1, dl));
    }
    const rv = riverAt(x, z);
    if (rv) wet = Math.max(wet, smoothstep(rv.w + 12, rv.w + 1, rv.d));
    const md = Math.hypot(x - LANDMARKS.meadow.x, z - LANDMARKS.meadow.z);
    let meadow = smoothstep(0.12, 0.38, fbm(nMeadow, x, z, 3, 0.0045));
    meadow = Math.max(meadow, smoothstep(LANDMARKS.meadow.r, LANDMARKS.meadow.r * 0.6, md));
    meadow *= (1 - sand) * (1 - highland * 0.6) * (1 - rock);
    const forestNoise = 0.65 + 0.35 * fbm(nForest, x, z, 2, 0.012);
    const forest = clamp((1 - sand * 1.2 - rock - meadow * 0.85) * forestNoise, 0, 1) * (water ? 0 : 1);
    return { h, slope, rn, water, sand, rock, highland, meadow, wet, forest };
  }

  // ── Landmarks ──────────────────────────────────────────────────────────
  function bearingDir(deg) {
    const b = (deg * Math.PI) / 180;
    return { x: Math.sin(b), z: -Math.cos(b) };
  }
  /** March outward along a compass bearing; returns the first point whose ground drops below targetH. */
  function coastPoint(bearingDeg, targetH = 1.0, startD = 120) {
    const dir = bearingDir(bearingDeg);
    for (let d = startD; d < HALF - 5; d += 0.5) {
      const x = dir.x * d, z = dir.z * d;
      if (heightAt(x, z) < targetH && !waterAt(x, z)?.fresh) return { x, z, d, bearing: bearingDeg };
      if (heightAt(x, z) < targetH && waterAt(x, z)?.type === 'ocean') return { x, z, d, bearing: bearingDeg };
    }
    return { x: dir.x * R, z: dir.z * R, d: R, bearing: bearingDeg };
  }
  function offshore(p, meters) {
    const dir = bearingDir(p.bearing);
    return { x: p.x + dir.x * meters, z: p.z + dir.z * meters };
  }
  const LANDMARKS = {
    meadow: { x: 30, z: 140, r: 55 },
  };
  {
    const spawnBeach = coastPoint(178, 1.3);
    LANDMARKS.spawn = { x: spawnBeach.x, z: spawnBeach.z, yaw: 0.25 }; // yaw 0 = facing north (into the island)
    LANDMARKS.wreck = { ...offshore(spawnBeach, 62), bearing: 178 };
    const c1 = coastPoint(183, 1.0);
    LANDMARKS.crate1 = { x: c1.x + 6, z: c1.z };
    LANDMARKS.crate2 = coastPoint(212, 0.9);
    LANDMARKS.castawayCamp = coastPoint(352, 2.2);
    LANDMARKS.bottleBeach = coastPoint(96, 0.5);
    LANDMARKS.carvedTree = { x: -10, z: -26 };
    LANDMARKS.summit = { x: SUMMIT.x, z: SUMMIT.z, y: SUMMIT.height, r: SUMMIT.plateauR };
    LANDMARKS.stoneCircle = LANDMARKS.summit;
    LANDMARKS.lake = { x: mainLake.x, z: mainLake.z, r: mainLake.r, level: mainLake.level };
    LANDMARKS.pond = { x: lakes[1].x, z: lakes[1].z, r: lakes[1].r, level: lakes[1].level };
    LANDMARKS.duck = { x: mainLake.x + 9, z: mainLake.z - 6 };
    const mid = riverPts[Math.floor(riverPts.length * 0.33)];
    LANDMARKS.bambooGrove = { x: mid.x + mid.dirZ * 20, z: mid.z - mid.dirX * 20, r: 14 };
    const mouth = riverPts.find((p) => p.surface < 0.3) || riverPts[riverPts.length - 1];
    LANDMARKS.riverMouth = { x: mouth.x, z: mouth.z };
    // ── Tempest Isle ──
    const tm = ISLE2.toMain;
    let cove = null;
    for (let d = 40; d < ISLE2.half - 5 && !cove; d += 0.5) {
      const x = ISLE2.x + tm.x * d, z = ISLE2.z + tm.z * d;
      if (heightAt(x, z) < 1.3 && !waterAt(x, z)?.fresh) cove = { x, z };
    }
    cove ??= { x: ISLE2.x + tm.x * ISLE2.R, z: ISLE2.z + tm.z * ISLE2.R };
    LANDMARKS.isle2 = { x: ISLE2.x, z: ISLE2.z, r: ISLE2.R, name: ISLE2.name };
    LANDMARKS.isle2Cove = { x: cove.x - tm.x * 4, z: cove.z - tm.z * 4 }; // dry landing beach in the cove
    // the dock: starts on the beach at the waterline and runs `length` m out to sea along (dirX, dirZ)
    LANDMARKS.isle2Dock = { x: cove.x, z: cove.z, dirX: tm.x, dirZ: tm.z, length: 18 };
    LANDMARKS.isle2Hut = { x: PEAK2.x, z: PEAK2.z, y: PEAK2.height, r: PEAK2.plateauR };
    const P2 = lakes.find((l) => l.id === 'isle2pond');
    LANDMARKS.isle2Pond = { x: P2.x, z: P2.z, r: P2.r, level: P2.level };
    // the main-island beach closest to Tempest Isle (where a raft trip makes sense)
    const brg = (Math.atan2(ISLE2.x, -ISLE2.z) * 180) / Math.PI;
    const lb = coastPoint(brg, 1.3);
    LANDMARKS.launchBeach = { x: lb.x, z: lb.z, bearing: brg };
    for (const k in LANDMARKS) LANDMARKS[k].y ??= heightAt(LANDMARKS[k].x, LANDMARKS[k].z);
  }

  /** Rejection-sample a dry land point. filter(x, z, biome) -> bool. Returns null after maxTries. */
  function randomLandPoint(rand, filter = null, maxTries = 60, island = 'main') {
    const I = island === 'isle2' ? { x: ISLE2.x, z: ISLE2.z, r: ISLE2.R * 1.15 } : { x: 0, z: 0, r: R * 1.15 };
    for (let t = 0; t < maxTries; t++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * I.r;
      const x = I.x + Math.cos(a) * d, z = I.z + Math.sin(a) * d;
      const g = heightAt(x, z);
      if (g < SEA + 0.4) continue;
      if (waterAt(x, z)) continue;
      if (filter && !filter(x, z, biomeAt(x, z))) continue;
      return { x, z, y: g };
    }
    return null;
  }

  /** Terrain mesh geometry (positions + normals + index). Add your own color attribute. */
  function buildGeometry(id = 'main') {
    const G = GRIDS.find((g) => g.id === id) || GRIDS[0];
    const N1 = G.N1, cells = G.cells, CELL = G.cell, heights = G.heights;
    const pos = new Float32Array(N1 * N1 * 3);
    const nor = new Float32Array(N1 * N1 * 3);
    const uv = new Float32Array(N1 * N1 * 2);
    for (let j = 0; j < N1; j++) {
      for (let i = 0; i < N1; i++) {
        const k = j * N1 + i;
        const x = G.x0 + i * CELL, z = G.z0 + j * CELL;
        pos[k * 3] = x;
        pos[k * 3 + 1] = heights[k];
        pos[k * 3 + 2] = z;
        const hl = heights[j * N1 + Math.max(0, i - 1)], hr = heights[j * N1 + Math.min(cells, i + 1)];
        const hd = heights[Math.max(0, j - 1) * N1 + i], hu = heights[Math.min(cells, j + 1) * N1 + i];
        const nx = hl - hr, ny = 2 * CELL, nz = hd - hu;
        const l = Math.hypot(nx, ny, nz);
        nor[k * 3] = nx / l;
        nor[k * 3 + 1] = ny / l;
        nor[k * 3 + 2] = nz / l;
        uv[k * 2] = i / cells;
        uv[k * 2 + 1] = j / cells;
      }
    }
    const idx = new Uint32Array(cells * cells * 6);
    let p = 0;
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const v00 = j * N1 + i, v10 = v00 + 1, v01 = v00 + N1, v11 = v01 + 1;
        idx[p++] = v00; idx[p++] = v01; idx[p++] = v11;
        idx[p++] = v00; idx[p++] = v11; idx[p++] = v10;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }

  return {
    SEA_LEVEL: SEA,
    ISLAND_RADIUS: R,
    SIZE: size,
    CELLS: cells,
    CELL,
    heights, // MAIN island grid: Float32Array, row-major [j*(cells+1)+i], x = -size/2 + i*CELL, z = -size/2 + j*CELL
    /** Every terrain grid: [{ id: 'main'|'isle2', heights, x0, z0, cell, cells, N1 }]. buildGeometry(id) builds one. */
    grids: GRIDS,
    /** Tempest Isle: { id, name, x, z, R, half, x0, z0, cell, cells, N1, toMain, heights, peak: { x, z, height, plateauR } } */
    isle2: { ...ISLE2, heights: heights2, peak: PEAK2 },
    islandAt,
    isle2ness,
    heightAt,
    normalAt,
    slopeAt,
    waterAt,
    riverAt,
    biomeAt,
    islandness,
    coastDistance,
    coastPoint,
    bearingDir,
    randomLandPoint,
    buildGeometry,
    lakes, // [{ id, name, x, z, r, depth, level, rim, waterRadius }]
    river: { points: riverPts, depth: RIVER_DEPTH, startRadius: mainLake.waterRadius, lake: mainLake },
    summit: SUMMIT,
    landmarks: LANDMARKS,
  };
}
