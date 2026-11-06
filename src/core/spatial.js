// Uniform-grid spatial hash on the XZ plane + circle colliders built on top of it.

export class SpatialHash {
  constructor(cellSize = 10) {
    this.s = cellSize;
    this.cells = new Map();
    this.maxR = 0; // largest radius ever inserted (query padding)
    this.size = 0;
  }
  _key(ix, iz) {
    return (ix + 32768) * 65536 + (iz + 32768);
  }
  insert(obj) {
    // obj must have numeric x, z; optional r
    const k = this._key(Math.floor(obj.x / this.s), Math.floor(obj.z / this.s));
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = []));
    cell.push(obj);
    obj.__cell = k;
    if (obj.r && obj.r > this.maxR) this.maxR = obj.r;
    this.size++;
    return obj;
  }
  remove(obj) {
    const cell = this.cells.get(obj.__cell);
    if (!cell) return false;
    const i = cell.indexOf(obj);
    if (i < 0) return false;
    cell[i] = cell[cell.length - 1];
    cell.pop();
    obj.__cell = undefined;
    this.size--;
    return true;
  }
  move(obj, x, z) {
    const k = this._key(Math.floor(x / this.s), Math.floor(z / this.s));
    obj.x = x;
    obj.z = z;
    if (k === obj.__cell) return;
    this.remove(obj);
    this.insert(obj);
  }
  /** Objects whose center lies within r (plus their own radius) of (x,z). */
  query(x, z, r, out = []) {
    const pad = r + this.maxR;
    const x0 = Math.floor((x - pad) / this.s), x1 = Math.floor((x + pad) / this.s);
    const z0 = Math.floor((z - pad) / this.s), z1 = Math.floor((z + pad) / this.s);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const cell = this.cells.get(this._key(ix, iz));
        if (!cell) continue;
        for (const o of cell) {
          const rr = r + (o.r || 0);
          const dx = o.x - x, dz = o.z - z;
          if (dx * dx + dz * dz <= rr * rr) out.push(o);
        }
      }
    }
    return out;
  }
  /** Iterate everything (slow; debug only). */
  *all() {
    for (const cell of this.cells.values()) yield* cell;
  }
}

/**
 * Circle colliders (tree trunks, boulders, structures). Each collider:
 * { x, z, r, y0 = -Infinity, y1 = Infinity, tag?: string, data?: any }
 * The player is a vertical capsule approximated by a circle; colliders whose vertical
 * span [y0,y1] does not overlap the player's [feetY, headY] are ignored (you can jump onto low rocks).
 */
export function createColliders() {
  const hash = new SpatialHash(8);
  const tmp = [];
  return {
    hash,
    add(c) {
      if (c.y0 === undefined) c.y0 = -Infinity;
      if (c.y1 === undefined) c.y1 = Infinity;
      return hash.insert(c);
    },
    remove(c) {
      return hash.remove(c);
    },
    query(x, z, r, out = []) {
      return hash.query(x, z, r, out);
    },
    /**
     * Push a moving circle (pos.x/pos.z, radius) out of all colliders. Mutates pos.
     * Returns the top (y1) of the highest collider we're standing over that is below feetY+0.5,
     * or -Infinity. Used so the player can stand on boulders.
     */
    resolve(pos, radius, feetY = -Infinity, headY = Infinity) {
      tmp.length = 0;
      hash.query(pos.x, pos.z, radius + 0.5, tmp);
      let standTop = -Infinity;
      for (const c of tmp) {
        if (c.y1 < feetY + 0.05 || c.y0 > headY) {
          // above or below us: maybe we're standing on it
          const dx = pos.x - c.x, dz = pos.z - c.z;
          if (c.y1 < feetY + 0.5 && dx * dx + dz * dz < c.r * c.r) standTop = Math.max(standTop, c.y1);
          continue;
        }
        const dx = pos.x - c.x, dz = pos.z - c.z;
        const d = Math.hypot(dx, dz);
        const min = c.r + radius;
        if (d < min) {
          if (d < 1e-5) {
            pos.x += min;
            continue;
          }
          const push = (min - d) / d;
          pos.x += dx * push;
          pos.z += dz * push;
        }
      }
      return standTop;
    },
  };
}
