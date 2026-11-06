// Flora placement: pure, deterministic logic over ctx.world (no rendering), so it runs in node tests.
//
// placeTrees(world, rng, lib)  -> { trees, boulders }   (trees = the public ctx.flora.trees entries)
// placeUndergrowth(world, rng, lib, trees, boulders) -> [{ kind, v, x, y, z, rot, s, ... }]
// makeZones(world)             -> keep-clear zones around landmarks (trees and undergrowth radii)
//
// Trees use a shuffled jittered grid (~3.3 m) with biome-driven probability and crown-based spacing
// (a cheap Poisson-disc), so forests are dense, meadows open, beaches carry palms, highlands pines and
// the lake/river banks willows. After the main pass a few guarantees are enforced (apple/chestnut
// counts, every species near the spawn, palms on the spawn beach).
import { SpatialHash } from '../../core/spatial.js';
import { hash2, smoothstep, clamp01 } from '../../core/util.js';

export const TREE_TYPES = ['oak', 'pine', 'birch', 'palm', 'willow', 'apple', 'chestnut', 'snag'];
const TAU = Math.PI * 2;
const EXTENT = 345; // half-size of the scanned square (island radius ~320 + wobble)

/** Smooth value noise in [0,1] (integer lattice hashed with util.hash2). */
export function vnoise(x, z, seed = 0) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed), c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Two-octave value noise in [0,1]. */
export function vfbm(x, z, seed = 0) {
  return vnoise(x, z, seed) * 0.65 + vnoise(x * 2.3 + 17.1, z * 2.3 - 9.4, seed + 1) * 0.35;
}

// ── Keep-clear zones ─────────────────────────────────────────────────────
/**
 * Zones around landmarks. Each zone: { x, z, rt (trees), ru (undergrowth), tag }.
 * blocked(x, z, kind='tree'|'under'|'flower', pad=0) -> true when inside any zone.
 */
export function makeZones(world) {
  const L = world.landmarks || {};
  const zones = [];
  const add = (p, rt, ru, tag) => p && Number.isFinite(p.x) && zones.push({ x: p.x, z: p.z, rt, ru, rf: ru, tag });
  add(L.spawn, 8, 3.5, 'spawn');
  add(L.crate1, 6, 2.5, 'crate1');
  add(L.crate2, 6, 2.5, 'crate2');
  add(L.castawayCamp, 9, 6, 'castawayCamp');
  add(L.bottleBeach, 6, 2.5, 'bottleBeach');
  const sr = (L.summit?.r ?? world.summit?.plateauR ?? 13) + 5;
  add(L.summit, sr, (L.summit?.r ?? 13) + 1.5, 'summit');
  if (L.meadow) zones.push({ x: L.meadow.x, z: L.meadow.z, rt: L.meadow.r * 0.62, ru: L.meadow.r * 0.35, rf: 0, tag: 'meadow' });
  add(L.bambooGrove, (L.bambooGrove?.r ?? 14) + 4, (L.bambooGrove?.r ?? 14) - 2, 'bambooGrove');
  add(L.carvedTree, 8, 1.8, 'carvedTree');
  add(L.duck, 0, 3, 'duck');
  add(L.riverMouth, 4, 0, 'riverMouth');
  return {
    zones,
    blocked(x, z, kind = 'tree', pad = 0) {
      for (const q of zones) {
        const r = (kind === 'tree' ? q.rt : kind === 'flower' ? q.rf : q.ru) + pad;
        if (r <= 0) continue;
        const dx = x - q.x, dz = z - q.z;
        if (dx * dx + dz * dz < r * r) return true;
      }
      return false;
    },
  };
}

/** Lowest ground under a trunk footprint (so the root flare never floats on slopes). */
function baseHeight(world, x, z, r) {
  let y = world.heightAt(x, z);
  y = Math.min(y, world.heightAt(x + r, z), world.heightAt(x - r, z), world.heightAt(x, z + r), world.heightAt(x, z - r));
  return y;
}

/** True when any water lies within r of (x, z) (center + 4 probes). */
function wetFoot(world, x, z, r) {
  if (world.waterAt(x, z)) return true;
  return !!(world.waterAt(x + r, z) || world.waterAt(x - r, z) || world.waterAt(x, z + r) || world.waterAt(x, z - r));
}

/** Habitat check for a tree of `type` at (x, z) with biome b. */
export function treeHabitatOk(world, type, x, z, b) {
  if (b.water) return false;
  if (b.h < 0.75) return false;
  if (b.slope > 0.43 || b.rock > 0.55) return false;
  const rv = world.riverAt(x, z);
  if (rv && rv.d < rv.w + (type === 'willow' ? 1.3 : 2.2)) return false;
  if (wetFoot(world, x, z, type === 'willow' ? 0.9 : 1.6)) return false;
  if (type === 'palm') return b.sand > 0.3 && b.h < 6.5;
  // no trees on beaches except palms
  if (b.sand > 0.3) return false;
  return true;
}

/** Weighted species choice for a biome sample. n1/n2 are clumping noises in [0,1]. */
function pickSpecies(b, n1, n2, n3, r) {
  if (b.sand > 0.3) return 'palm';
  const hl = b.highland;
  const w = {
    oak: 0.32 * (1 - hl * 0.85) * (0.6 + n2 * 0.8),
    birch: 0.18 * (0.35 + n1 * 1.3) * (1 - hl * 0.4),
    chestnut: 0.13 * (1 - hl) * (0.4 + n3 * 1.2),
    apple: 0.07 * (1 - hl) * (0.6 + b.meadow * 2.5),
    pine: 0.05 + hl * 1.1 + smoothstep(14, 24, b.h) * 0.25,
    snag: 0.045 + hl * 0.05,
    willow: b.wet * 0.9,
  };
  if (b.wet > 0.45) {
    w.willow *= 1.8;
    w.chestnut *= 0.3;
    w.pine *= 0.3;
  }
  if (b.meadow > 0.35) {
    w.apple *= 2.2;
    w.pine *= 0.2;
    w.snag *= 0.4;
  }
  let sum = 0;
  for (const k in w) sum += w[k];
  let t = r * sum;
  for (const k in w) {
    t -= w[k];
    if (t <= 0) return k;
  }
  return 'oak';
}

/** Probability that a jittered grid cell gets a tree. */
function treeDensity(b, x, z, n0) {
  if (b.sand > 0.3) {
    // palms: clumps on the upper beach
    const upper = smoothstep(0.75, 1.6, b.h) * smoothstep(6.5, 4.0, b.h);
    return 0.22 * upper * (0.3 + 1.3 * smoothstep(0.35, 0.75, n0));
  }
  const clump = 0.35 + 0.9 * smoothstep(0.2, 0.75, n0);
  let p = Math.pow(b.forest, 1.15) * 0.62 * clump;
  p += b.highland * (1 - b.rock) * 0.22 * clump; // pine woods on the high slopes
  p += b.meadow * 0.012; // lone trees in open meadows
  p *= 1 - smoothstep(0.25, 0.5, b.rock);
  return Math.min(0.85, p);
}

/**
 * Place every tree and boulder. lib = species.buildLibrary(...) output (variant metadata).
 * Returns { trees, boulders }. Tree entries (public API, see SPEC §6 B):
 *   { id, x, z, y, type, height, trunkR, crownR, alive, standing, v, rot, s, phase,
 *     ccx, ccz (crown center), canopy (0..1 crown density), special? }
 */
export function placeTrees(world, rng, lib) {
  const zones = makeZones(world);
  const trees = [];
  const hash = new SpatialHash(10);
  const L = world.landmarks || {};
  const S = L.spawn || { x: 0, z: 0 };

  /** Make (but don't commit) a tree entry. Returns null when spacing fails. */
  function make(type, x, z, opts = {}) {
    const variants = lib[type];
    const v = opts.v ?? Math.floor(rng() * variants.length);
    const V = variants[v];
    let s = opts.s ?? rng.range(0.82, 1.18) * (rng() < 0.08 ? 1.18 : 1);
    if (type === 'palm') s = opts.s ?? rng.range(0.85, 1.15);
    let rot = opts.rot ?? rng() * TAU;
    if (type === 'palm' && opts.rot === undefined) {
      // palms lean toward the sea: local +X (the lean) points away from the island center
      const l = Math.hypot(x, z) || 1;
      rot = Math.atan2(-z / l, x / l) + (rng() - 0.5) * 1.1;
    }
    const c = Math.cos(rot), sn = Math.sin(rot);
    const ccx = (V.crownCX * c + V.crownCZ * sn) * s;
    const ccz = (-V.crownCX * sn + V.crownCZ * c) * s;
    const trunkR = V.trunkR * s;
    const t = {
      id: -1,
      x,
      z,
      y: baseHeight(world, x, z, trunkR * 1.2),
      type,
      height: V.height * s,
      trunkR,
      crownR: V.crownR * s,
      alive: type !== 'snag',
      standing: true,
      v,
      rot,
      s,
      phase: rng(),
      ccx: x + ccx,
      ccz: z + ccz,
      canopy: V.canopy ?? 0.7,
    };
    return t;
  }

  /** Spacing test: crowns may overlap ~45 %, trunks never closer than 1.6 m. */
  const near = [];
  function spaced(t, k = 0.55) {
    near.length = 0;
    hash.query(t.x, t.z, t.crownR + 9, near);
    for (const o of near) {
      const d = Math.hypot(o.x - t.x, o.z - t.z);
      const need = Math.max(1.6 + t.trunkR + o.trunkR, (t.crownR + o.crownR) * k);
      if (d < need) return false;
    }
    return true;
  }
  function commit(t) {
    t.id = trees.length;
    trees.push(t);
    hash.insert(t);
    return t;
  }

  // 1. The carved landmark oak, exactly at landmarks.carvedTree (scale 1, upright, rot 0).
  if (L.carvedTree && lib.carvedOak) {
    const V = lib.carvedOak;
    const x = L.carvedTree.x, z = L.carvedTree.z;
    commit({
      id: -1,
      x,
      z,
      y: baseHeight(world, x, z, V.trunkR * 1.3),
      type: 'oak',
      height: V.height,
      trunkR: V.trunkR,
      crownR: V.crownR,
      alive: true,
      standing: true,
      v: -1,
      rot: 0,
      s: 1,
      phase: 0.37,
      ccx: x + V.crownCX,
      ccz: z + V.crownCZ,
      canopy: V.canopy ?? 0.9,
      special: 'carvedTree',
      // Clean, undecorated bark cylinder for the carving (Builder F): radius trunkR, local y in [0.4, 2.6].
      carve: { radius: V.trunkR, y0: 0.4, y1: 2.6, faceYaw: Math.atan2(S.x - x, S.z - z) },
    });
  }

  // 2. Main pass: shuffled jittered grid.
  const CELL = 3.3;
  const n = Math.ceil((EXTENT * 2) / CELL);
  const order = new Uint32Array(n * n);
  for (let i = 0; i < order.length; i++) order[i] = i;
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  for (let k = 0; k < order.length; k++) {
    const ci = order[k] % n, cj = Math.floor(order[k] / n);
    const x = -EXTENT + (ci + rng()) * CELL;
    const z = -EXTENT + (cj + rng()) * CELL;
    const r0 = rng(), r1 = rng();
    if (x * x + z * z > 380 * 380) continue;
    if (world.heightAt(x, z) < 0.75) continue;
    if (zones.blocked(x, z, 'tree')) continue;
    const b = world.biomeAt(x, z);
    const n0 = vfbm(x * 0.022, z * 0.022, 11);
    if (r0 > treeDensity(b, x, z, n0)) continue;
    const type = pickSpecies(b, vnoise(x * 0.03, z * 0.03, 21), vnoise(x * 0.025, z * 0.025, 31), vnoise(x * 0.028, z * 0.028, 41), r1);
    if (!treeHabitatOk(world, type, x, z, b)) continue;
    const t = make(type, x, z);
    if (!spaced(t, type === 'palm' ? 0.75 : 0.55)) continue;
    commit(t);
  }

  // 3. Guarantees.
  const count = (type) => trees.reduce((a, t) => a + (t.type === type ? 1 : 0), 0);
  /** Try to add `type` trees at random spots within [r0, r1] of (cx, cz). Returns the number added. */
  function addNear(type, cx, cz, r0, r1, want, tries = 1500, extra = null) {
    let added = 0;
    for (let i = 0; i < tries && added < want; i++) {
      const a = rng() * TAU, d = r0 + Math.sqrt(rng()) * (r1 - r0);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (zones.blocked(x, z, 'tree')) continue;
      const b = world.biomeAt(x, z);
      if (!treeHabitatOk(world, type, x, z, b)) continue;
      if (extra && !extra(x, z, b)) continue;
      const t = make(type, x, z);
      if (!spaced(t, 0.5)) continue;
      commit(t);
      added++;
    }
    return added;
  }
  const forestFloor = (x, z, b) => b.forest > 0.25 && b.highland < 0.6;
  for (const [type, min] of [['apple', 30], ['chestnut', 30]]) {
    const have = count(type);
    if (have < min) addNear(type, 0, 0, 20, 300, min - have, 8000, type === 'apple' ? null : forestFloor);
  }
  // Every species within ~150 m of the spawn (palms on the spawn beach, willows by Spring Pond).
  const within = (type, r) => trees.some((t) => t.type === type && Math.hypot(t.x - S.x, t.z - S.z) < r);
  const palmsNear = trees.filter((t) => t.type === 'palm' && Math.hypot(t.x - S.x, t.z - S.z) < 60).length;
  if (palmsNear < 4) {
    const c1 = L.crate1;
    addNear('palm', S.x, S.z, 12, 60, 4 - palmsNear, 3000, (x, z) => !c1 || Math.hypot(x - c1.x, z - c1.z) > 7);
  }
  for (const type of TREE_TYPES) {
    if (within(type, 140)) continue;
    const pond = L.pond;
    if (type === 'willow' && pond && Math.hypot(pond.x - S.x, pond.z - S.z) < 150) {
      if (addNear('willow', pond.x, pond.z, pond.r * 0.8, pond.r + 14, 3, 3000)) continue;
    }
    addNear(type, S.x, S.z, 25, 140, 2, 4000);
  }

  // 4. Boulders: rocky slopes, highlands, riverbeds, mossy ones in the forest.
  const boulders = [];
  const bHash = new SpatialHash(10);
  const BC = 8.5;
  const nb = Math.ceil((EXTENT * 2) / BC);
  for (let cj = 0; cj < nb; cj++) {
    for (let ci = 0; ci < nb; ci++) {
      const x = -EXTENT + (ci + rng()) * BC, z = -EXTENT + (cj + rng()) * BC;
      const r0 = rng(), r1 = rng(), r2 = rng();
      if (x * x + z * z > 380 * 380) continue;
      const h = world.heightAt(x, z);
      if (h < 0.4) continue;
      if (zones.blocked(x, z, 'tree', 2)) continue;
      const b = world.biomeAt(x, z);
      if (b.water) continue;
      const rv = world.riverAt(x, z);
      const bank = rv ? smoothstep(rv.w + 6, rv.w + 1.5, rv.d) * (rv.d > rv.w * 0.6 ? 1 : 0) : 0;
      const p = b.rock * 0.45 + b.highland * 0.13 + b.forest * 0.1 * smoothstep(0.4, 0.8, vnoise(x * 0.04, z * 0.04, 7)) * 3 + bank * 0.22 + (b.sand > 0.5 && b.rn > 0.9 ? 0.015 : 0);
      if (r0 > p) continue;
      const mossy = b.forest > 0.4 || b.wet > 0.5;
      const pool = lib.boulder.length / 2;
      const v = (mossy ? pool : 0) + Math.floor(r1 * pool);
      const size = (b.rock > 0.4 ? 0.9 + r2 * 1.7 : bank > 0.3 ? 0.45 + r2 * 0.6 : 0.55 + r2 * 1.0) * (rng() < 0.06 ? 1.6 : 1);
      // keep clear of trunks and other boulders
      near.length = 0;
      hash.query(x, z, size + 3, near);
      if (near.some((t) => Math.hypot(t.x - x, t.z - z) < t.trunkR + size + 0.6)) continue;
      near.length = 0;
      bHash.query(x, z, size + 4, near);
      if (near.some((o) => Math.hypot(o.x - x, o.z - z) < o.s + size + 0.8)) continue;
      const V = lib.boulder[v];
      const rot = rng() * TAU;
      const y = baseHeight(world, x, z, size * 0.7) - size * 0.18;
      const o = {
        x,
        z,
        y,
        v,
        rot,
        s: size,
        r: size * Math.min(1, V.rz ?? 1) * 0.86,
        top: y + V.height * size,
        mossy,
      };
      boulders.push(o);
      bHash.insert(o);
    }
  }
  // the temporary hashes tag objects with __cell: keep the public entries clean
  for (const t of trees) delete t.__cell;
  for (const o of boulders) delete o.__cell;
  return { trees, boulders, zones };
}

// ── Undergrowth ──────────────────────────────────────────────────────────
/**
 * Ferns (shady forest), bushes (forest edges, flowering ones near meadows), reeds (water edges),
 * lily pads (lake + pond), meadow flowers (color patches) and small rocks.
 * Returns [{ kind, v, x, y, z, rot, s }] where kind in fern|bush|reeds|lily|flower|rock and v indexes lib[kind].
 */
export function placeUndergrowth(world, rng, lib, trees, boulders) {
  const zones = makeZones(world);
  const out = [];
  const trunks = new SpatialHash(8);
  for (const t of trees) trunks.insert({ x: t.x, z: t.z, r: 0, tr: t.trunkR });
  for (const o of boulders || []) trunks.insert({ x: o.x, z: o.z, r: 0, tr: o.r + 0.3 });
  const near = [];
  const clearOfTrunks = (x, z, pad) => {
    near.length = 0;
    trunks.query(x, z, pad + 4, near);
    for (const o of near) if (Math.hypot(o.x - x, o.z - z) < o.tr + pad) return false;
    return true;
  };
  const push = (kind, x, z, s, y = null, extra = null) => {
    const v = Math.floor(rng() * lib[kind].length);
    const it = { kind, v, x, y: y ?? world.heightAt(x, z), z, rot: rng() * TAU, s };
    if (extra) Object.assign(it, extra);
    out.push(it);
    return it;
  };
  const nFlowerColors = lib.flower.length ? Math.max(...lib.flower.map((f) => f.colorIdx)) + 1 : 1;
  const flowersOf = (c) => lib.flower.map((f, i) => (f.colorIdx === c ? i : -1)).filter((i) => i >= 0);
  const flowerIdx = Array.from({ length: nFlowerColors }, (_, c) => flowersOf(c));

  // Jittered 2.5 m grid over the island: one biome sample per cell decides the cell's plants.
  const CELL = 2.5;
  const n = Math.ceil((EXTENT * 2) / CELL);
  for (let cj = 0; cj < n; cj++) {
    for (let ci = 0; ci < n; ci++) {
      const x = -EXTENT + (ci + rng()) * CELL, z = -EXTENT + (cj + rng()) * CELL;
      const r0 = rng(), r1 = rng(), r2 = rng();
      if (x * x + z * z > 375 * 375) continue;
      const h = world.heightAt(x, z);
      if (h < 0.5) continue;
      const b = world.biomeAt(x, z);
      if (b.water || b.slope > 0.5) continue;
      const shade = vfbm(x * 0.05, z * 0.05, 51);
      // Meadow flowers: dense patches of a single color, mixed at the edges.
      const fm = b.meadow * (1 - b.sand) * (1 - b.rock);
      if (fm > 0.3 && !zones.blocked(x, z, 'flower')) {
        const dens = smoothstep(0.3, 0.75, fm) * (0.35 + 0.75 * vnoise(x * 0.09, z * 0.09, 61));
        const nf = dens > 0.8 ? 2 : dens > 0.42 && r2 < 0.75 ? 1 : 0;
        const patch = vnoise(x * 0.045, z * 0.045, 71);
        for (let k = 0; k < nf; k++) {
          const fx = x + (rng() - 0.5) * CELL, fz = z + (rng() - 0.5) * CELL;
          if (!clearOfTrunks(fx, fz, 0.5)) continue;
          let c = Math.floor(patch * nFlowerColors * 1.999) % nFlowerColors;
          if (rng() < 0.22) c = Math.floor(rng() * nFlowerColors);
          const list = flowerIdx[c];
          if (!list.length) continue;
          const v = list[Math.floor(rng() * list.length)];
          out.push({ kind: 'flower', v, x: fx, y: world.heightAt(fx, fz), z: fz, rot: rng() * TAU, s: 0.85 + rng() * 0.6 });
        }
      }
      if (zones.blocked(x, z, 'under')) continue;
      // Ferns: shady forest floor, in drifts.
      const pf = b.forest * (1 - b.highland * 0.6) * smoothstep(0.3, 0.7, shade) * 0.55;
      if (r0 < pf && b.sand < 0.2 && clearOfTrunks(x, z, 0.7)) {
        push('fern', x, z, 0.75 + r2 * 0.65);
        continue;
      }
      // Bushes: forest edges (forest 0.2..0.7) and meadow fringes.
      const edge = smoothstep(0.12, 0.35, b.forest) * smoothstep(0.85, 0.5, b.forest);
      const pb = edge * 0.07 + b.meadow * (1 - fm * 0.6) * 0.012 + b.forest * 0.012;
      if (r1 < pb && b.sand < 0.25 && clearOfTrunks(x, z, 1.1)) {
        // flowering variants (the last two) near meadows
        const flowering = b.meadow > 0.25 || rng() < 0.12;
        const nb = lib.bush.length;
        const v = flowering ? nb - 1 - Math.floor(rng() * 2) : Math.floor(rng() * Math.max(1, nb - 2));
        out.push({ kind: 'bush', v, x, y: world.heightAt(x, z) - 0.05, z, rot: rng() * TAU, s: 0.8 + r2 * 0.7 });
        continue;
      }
      // Small rocks: beaches near rock, rocky ground, highlands.
      const pr = b.rock * 0.12 + b.highland * 0.03 + (b.sand > 0.5 ? 0.006 : 0) + b.forest * 0.004;
      if (r2 < pr && clearOfTrunks(x, z, 0.5)) {
        push('rock', x, z, 0.25 + rng() * 0.45, world.heightAt(x, z) - 0.06);
      }
    }
  }

  // Reeds along the lake/pond rims and both river banks.
  const reedOk = (x, z) => {
    if (zones.blocked(x, z, 'under')) return false;
    const w = world.waterAt(x, z);
    const g = world.heightAt(x, z);
    if (w && w.depth > 0.45) return false; // shallow water or the dry bank only
    if (!w) {
      const b = world.biomeAt(x, z);
      if (b.wet < 0.5 || b.slope > 0.45) return false;
    }
    return g > -0.5 && clearOfTrunks(x, z, 0.6);
  };
  for (const Lk of world.lakes || []) {
    const ring = Math.round(Lk.waterRadius * TAU * 1.1);
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * TAU + rng() * 0.05;
      if (vnoise(Math.cos(a) * 5 + Lk.x * 0.1, Math.sin(a) * 5, 81) < 0.36) continue; // clumps, with gaps
      const d = Lk.waterRadius + (rng() - 0.65) * 3.2;
      const x = Lk.x + Math.cos(a) * d, z = Lk.z + Math.sin(a) * d;
      if (!reedOk(x, z)) continue;
      push('reeds', x, z, 0.8 + rng() * 0.5, Math.max(world.heightAt(x, z), Lk.level - 0.35) - 0.03);
    }
  }
  const rp = world.river?.points || [];
  for (let i = 0; i < rp.length; i++) {
    const p = rp[i];
    if (p.surface < 0.3) break;
    for (const side of [-1, 1]) {
      if (rng() < 0.35) continue;
      const off = p.w + (rng() - 0.3) * 2.2;
      const x = p.x - p.dirZ * off * side + (rng() - 0.5) * 1.5;
      const z = p.z + p.dirX * off * side + (rng() - 0.5) * 1.5;
      if (!reedOk(x, z)) continue;
      push('reeds', x, z, 0.75 + rng() * 0.45, Math.max(world.heightAt(x, z), p.surface - 0.3) - 0.03);
    }
  }

  // Lily pads floating on Mirror Lake and Spring Pond (near the shores, clear of the duck).
  for (const Lk of world.lakes || []) {
    const want = Lk.id === 'lake' ? 120 : 26;
    let got = 0;
    for (let i = 0; i < want * 12 && got < want; i++) {
      const a = rng() * TAU, d = Lk.waterRadius * (0.35 + Math.sqrt(rng()) * 0.55);
      const x = Lk.x + Math.cos(a) * d, z = Lk.z + Math.sin(a) * d;
      if (vnoise(x * 0.12, z * 0.12, 91) < 0.45) continue;
      const w = world.waterAt(x, z);
      if (!w || !w.fresh || w.type === 'river' || w.depth < 0.35) continue;
      if (zones.blocked(x, z, 'under')) continue;
      push('lily', x, z, 0.8 + rng() * 0.6, w.surface + 0.015);
      got++;
    }
  }
  return out;
}

/**
 * Candidate clearing spots for saplings: low canopy, grassy, dry, outside the keep-clear zones.
 * canopyAt is ctx.flora.canopyAt (or the CanopyIndex method). Returns [{x, y, z}].
 */
export function findClearings(world, rng, canopyAt, count, opts = {}) {
  const zones = makeZones(world);
  const out = [];
  const cx = opts.x ?? 0, cz = opts.z ?? 0, r0 = opts.r0 ?? 0, r1 = opts.r1 ?? 330;
  for (let i = 0; i < count * 60 && out.length < count; i++) {
    const a = rng() * TAU, d = r0 + Math.sqrt(rng()) * (r1 - r0);
    const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
    if (zones.blocked(x, z, 'tree', 1)) continue;
    const b = world.biomeAt(x, z);
    if (!treeHabitatOk(world, 'oak', x, z, b)) continue;
    if (b.highland > 0.8 || b.forest + b.meadow < 0.3) continue;
    const c = canopyAt(x, z);
    if (c > 0.35) continue;
    if (opts.avoid && !opts.avoid(x, z)) continue;
    out.push({ x, y: world.heightAt(x, z), z, conifer: b.highland > 0.45 || rng() < 0.18, edge: clamp01(b.forest) });
  }
  return out;
}
