// Placement helpers for Builder C: deterministic biome-driven scattering with spacing,
// obstacle avoidance (tree trunks, colliders, story props) and water-edge finding.
// Pure logic over ctx.world (no rendering), so it runs in node tests.
import { SpatialHash } from '../../core/spatial.js';

/**
 * Placer: keeps every placed thing in a spatial hash so new items respect spacing,
 * and knows about obstacles (tree trunks, colliders, reserved story spots).
 */
export class Placer {
  constructor(world, opts = {}) {
    this.world = world;
    this.hash = new SpatialHash(4);
    this.trees = new SpatialHash(8);
    this.reserved = []; // [{x, z, r}]
    this.colliders = opts.colliders || null;
    this._tmp = [];
  }

  /** Index tree trunks (from ctx.flora.trees) so items never spawn inside a trunk. */
  addTrees(trees) {
    for (const t of trees || []) {
      if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.z)) continue;
      this.trees.insert({ x: t.x, z: t.z, r: 0, trunkR: t.trunkR ?? 0.3, tree: t });
    }
  }

  reserve(x, z, r) {
    this.reserved.push({ x, z, r });
  }

  /** Nearest tree within maxDist (or null). */
  nearestTree(x, z, maxDist, filter = null) {
    this._tmp.length = 0;
    this.trees.query(x, z, maxDist, this._tmp);
    let best = null, bd = Infinity;
    for (const o of this._tmp) {
      if (filter && !filter(o.tree)) continue;
      const d = Math.hypot(o.x - x, o.z - z);
      if (d < bd) (bd = d), (best = o.tree);
    }
    return best;
  }

  /** True if (x,z) is free: spacing r from other items, not in a trunk/collider/reserved spot. */
  free(x, z, r, opts = {}) {
    for (const q of this.reserved) if (Math.hypot(x - q.x, z - q.z) < q.r) return false;
    this._tmp.length = 0;
    this.hash.query(x, z, r + 2, this._tmp);
    for (const o of this._tmp) {
      const need = Math.max(r, o.space);
      if (Math.hypot(o.x - x, o.z - z) < need) return false;
    }
    if (!opts.ignoreTrees) {
      this._tmp.length = 0;
      this.trees.query(x, z, 2, this._tmp);
      for (const o of this._tmp) if (Math.hypot(o.x - x, o.z - z) < o.trunkR + 0.35) return false;
    }
    if (this.colliders && !opts.ignoreColliders) {
      this._tmp.length = 0;
      this.colliders.query(x, z, 0.35, this._tmp);
      for (const c of this._tmp) if (c.tag !== 'res-soft') return false;
    }
    return true;
  }

  mark(x, z, space) {
    this.hash.insert({ x, z, r: 0, space });
  }

  /**
   * Rejection-sample `count` points over the island.
   * filter(x, z, biome) -> bool. Returns [{x, y, z, b}].
   */
  scatter(rand, count, space, filter, maxTries = count * 80) {
    const out = [];
    const W = this.world;
    const R = W.ISLAND_RADIUS * 1.15;
    for (let t = 0; t < maxTries && out.length < count; t++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * R;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const p = this.tryAt(x, z, space, filter);
      if (p) out.push(p);
    }
    return out;
  }

  /** Sample around a center in a ring [rMin, rMax]. */
  around(rand, cx, cz, rMin, rMax, count, space, filter, maxTries = count * 120) {
    const out = [];
    for (let t = 0; t < maxTries && out.length < count; t++) {
      const a = rand() * Math.PI * 2;
      const d = rMin + Math.sqrt(rand()) * (rMax - rMin);
      const p = this.tryAt(cx + Math.cos(a) * d, cz + Math.sin(a) * d, space, filter);
      if (p) out.push(p);
    }
    return out;
  }

  /** Check one candidate; marks it as taken on success. */
  tryAt(x, z, space, filter, opts = {}) {
    const W = this.world;
    const y = W.heightAt(x, z);
    if (y < W.SEA_LEVEL + 0.25 && !opts.allowLow) return null;
    if (!opts.allowWater && W.waterAt(x, z)) return null;
    if (!this.free(x, z, space, opts)) return null;
    const b = W.biomeAt(x, z);
    if (filter && !filter(x, z, b)) return null;
    this.mark(x, z, space);
    return { x, y, z, b };
  }
}

/** Common biome filters. */
export const F = {
  forestFloor: (x, z, b) => b.forest > 0.5 && b.slope < 0.35 && b.sand < 0.15 && b.rock < 0.3,
  forestDeep: (x, z, b) => b.forest > 0.72 && b.slope < 0.3 && b.sand < 0.05 && b.rock < 0.2,
  forestEdge: (x, z, b) => b.forest > 0.18 && b.forest < 0.62 && b.sand < 0.3 && b.rock < 0.3 && b.slope < 0.3,
  meadow: (x, z, b) => b.meadow > 0.55 && b.slope < 0.25 && b.sand < 0.1,
  grassland: (x, z, b) => b.forest < 0.45 && b.sand < 0.15 && b.rock < 0.25 && b.slope < 0.28 && b.highland < 0.6,
  beach: (x, z, b) => b.sand > 0.65 && b.h > 0.35 && b.h < 2.6 && b.slope < 0.3,
  waterline: (x, z, b) => b.sand > 0.6 && b.h > 0.12 && b.h < 1.1,
  upperBeach: (x, z, b) => b.sand > 0.25 && b.sand < 0.9 && b.h > 1.0 && b.h < 4.5 && b.slope < 0.3,
  highland: (x, z, b) => b.highland > 0.45 && b.slope < 0.5 && b.sand < 0.1,
  rocky: (x, z, b) => (b.rock > 0.3 || b.highland > 0.65) && b.slope < 0.6 && b.h > 14,
  wet: (x, z, b) => b.wet > 0.4 && b.slope < 0.3 && b.sand < 0.2,
};

/**
 * Points on dry ground right at the edge of fresh water (lakes, pond, river banks).
 * Returns [{x, z, y, waterId, nx, nz}] where (nx,nz) points from the land toward the water.
 */
export function waterEdgePoints(world, rand, { lakeStep = 4, riverStep = 7 } = {}) {
  const out = [];
  const edgeOk = (x, z, surface) => {
    const g = world.heightAt(x, z);
    if (world.waterAt(x, z)) return false;
    return g > surface - 0.05 && g < surface + 0.55;
  };
  for (const L of world.lakes) {
    const n = Math.max(12, Math.round((Math.PI * 2 * L.r) / lakeStep));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand() * 0.2;
      const cx = Math.cos(a), cz = Math.sin(a);
      // march outward from the lake until the first dry ground point
      for (let d = L.r * 0.6; d < L.r * 1.6; d += 0.35) {
        const x = L.x + cx * d, z = L.z + cz * d;
        if (world.waterAt(x, z)) continue;
        const px = x + cx * (0.2 + rand() * 0.6), pz = z + cz * (0.2 + rand() * 0.6);
        if (edgeOk(px, pz, L.level)) out.push({ x: px, z: pz, y: world.heightAt(px, pz), waterId: L.id, nx: -cx, nz: -cz });
        break;
      }
    }
  }
  const pts = world.river.points;
  const lake = world.river.lake;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    acc += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    if (acc < riverStep) continue;
    acc = 0;
    if (Math.hypot(p.x - lake.x, p.z - lake.z) < world.river.startRadius + 4) continue;
    if (p.surface < 0.3) break; // reached the sea
    for (const side of [-1, 1]) {
      const nx = -p.dirZ * side, nz = p.dirX * side; // perpendicular, pointing to this bank
      for (let d = p.w * 0.7; d < p.w + 5; d += 0.3) {
        const x = p.x + nx * d, z = p.z + nz * d;
        if (world.waterAt(x, z)) continue;
        const px = x + nx * (0.15 + rand() * 0.5), pz = z + nz * (0.15 + rand() * 0.5);
        if (edgeOk(px, pz, p.surface)) out.push({ x: px, z: pz, y: world.heightAt(px, pz), waterId: 'river', nx: -nx, nz: -nz, u: p.u });
        break;
      }
    }
  }
  return out;
}

/** River bank points a little further from the water (stones, flint): dry, near the riverbed. */
export function riverBankPoints(world, rand, count) {
  const pts = world.river.points;
  const out = [];
  for (let t = 0; t < count * 30 && out.length < count; t++) {
    const p = pts[Math.floor(rand() * pts.length)];
    if (Math.hypot(p.x - world.river.lake.x, p.z - world.river.lake.z) < world.river.startRadius + 3) continue;
    if (p.surface < 0.2) continue;
    const side = rand() < 0.5 ? -1 : 1;
    const nx = -p.dirZ * side, nz = p.dirX * side;
    const d = p.w + 0.6 + rand() * 2.5;
    const x = p.x + nx * d, z = p.z + nz * d;
    if (world.waterAt(x, z)) continue;
    const g = world.heightAt(x, z);
    if (g > p.surface + 1.4) continue;
    out.push({ x, z, y: g, u: p.u });
  }
  return out;
}
