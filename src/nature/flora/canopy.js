// Canopy + trunk index: answers canopyAt(x, z) (0 open sky .. 1 dense shade) and
// nearestTree(x, z, maxDist, filter?) quickly via two spatial hashes. Pure logic (node-testable).
//
// Each crown contributes k = density * falloff(d / crownR) and contributions combine like stacked
// translucent layers: canopy = 1 - prod(1 - k). The falloff is 1 inside ~45 % of the crown radius
// and fades smoothly to 0 at the crown edge, so shade has soft borders.
import { SpatialHash } from '../../core/spatial.js';

export class CanopyIndex {
  constructor() {
    this.crowns = new SpatialHash(10);
    this.trunks = new SpatialHash(8);
    this._near = [];
    this._map = new Map(); // tree -> { crown, trunk }
  }

  /** Index a standing tree entry (needs x, z, ccx, ccz, crownR, canopy). */
  add(t) {
    if (this._map.has(t)) return;
    const crown = { x: t.ccx ?? t.x, z: t.ccz ?? t.z, r: Math.max(0.5, t.crownR), k: t.canopy ?? 0.7, tree: t };
    const trunk = { x: t.x, z: t.z, r: 0, tree: t };
    this.crowns.insert(crown);
    this.trunks.insert(trunk);
    this._map.set(t, { crown, trunk });
  }

  /** Remove a tree (it fell). */
  remove(t) {
    const e = this._map.get(t);
    if (!e) return;
    this.crowns.remove(e.crown);
    this.trunks.remove(e.trunk);
    this._map.delete(t);
  }

  /** Update a tree's crown (growth): call after changing crownR/canopy. */
  refresh(t) {
    this.remove(t);
    this.add(t);
  }

  /** Shade from the sky at (x, z): 0..1. */
  canopyAt(x, z) {
    const near = this._near;
    near.length = 0;
    this.crowns.query(x, z, 0, near);
    let open = 1;
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      const dx = x - c.x, dz = z - c.z;
      const d = Math.sqrt(dx * dx + dz * dz) / c.r;
      if (d >= 1) continue;
      // smoothstep(1, 0.45, d)
      let f = (1 - d) / 0.55;
      if (f > 1) f = 1;
      f = f * f * (3 - 2 * f);
      open *= 1 - c.k * f;
    }
    const v = 1 - open;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /** Nearest standing tree trunk within maxDist, optionally filtered. Returns the tree entry or null. */
  nearestTree(x, z, maxDist = 30, filter = null) {
    const near = this._near;
    near.length = 0;
    this.trunks.query(x, z, maxDist, near);
    let best = null, bd = Infinity;
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (filter && !filter(o.tree)) continue;
      const dx = o.x - x, dz = o.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = o.tree;
      }
    }
    return best;
  }

  /** All standing trees within r of (x, z) (into out). */
  treesNear(x, z, r, out = []) {
    const near = this._near;
    near.length = 0;
    this.trunks.query(x, z, r, near);
    for (let i = 0; i < near.length; i++) out.push(near[i].tree);
    return out;
  }
}
