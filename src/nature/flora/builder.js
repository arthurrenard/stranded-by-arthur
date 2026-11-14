// GeoBuilder: tiny indexed-mesh accumulator used to generate every flora "variant" (a tree, a fern,
// a boulder...). Each vertex carries position, linear vertex color, wind weights and a part flag
// (bark vs leaf), and triangles are kept in two index lists (bark first, then leaf) so a fallen tree
// can later be split into a log and a crown.
//
// Wind weights per vertex (baked into the `aWind` attribute, see materials.js):
//   bend    - meters of sway at wind strength 1 (0 at the trunk base, grows with height)
//   flutter - meters of small high-frequency leaf jitter
//
// Primitives: tube (tapered/curved trunks & branches), blob (jittered icosphere crowns & rocks),
// cone (pine tiers), frond (palm & fern leaves), strip (ribbons: willow strands, reeds), octa (fruit),
// disc (lily pads). Thin parts are double-sided by adding both windings (the material is FrontSide).
//
// Low-detail mode (V4-E tree LOD): while withLowDetail(fn) runs, every new GeoBuilder is in low mode.
// Tubes and cones then emit fewer sides (lowSides; long tubes also drop every other inner ring), detail-1 blobs emit only their 12 base icosahedron
// vertices with the detail-0 faces (ICO[1] keeps ICO[0]'s vertices first, so the crown keeps its shape),
// fronds use half the segments, willow strands become one quad (every other one dropped) and fruit
// octahedra are skipped. Every primitive still makes exactly the same rng() / colorFn() calls as in
// full mode, so a variant rebuilt from the same rng fork keeps its branches, blobs and colors.

// ── Icosphere templates (indexed, outward CCW faces) ─────────────────────
const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  const f = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  const norm = (arr) => {
    for (let i = 0; i < arr.length; i += 3) {
      const l = Math.hypot(arr[i], arr[i + 1], arr[i + 2]);
      arr[i] /= l;
      arr[i + 1] /= l;
      arr[i + 2] /= l;
    }
    return arr;
  };
  const d0 = { v: norm(v.slice()), f: f.slice() };
  // one subdivision step with a midpoint cache
  const v1 = d0.v.slice();
  const f1 = [];
  const cache = new Map();
  const mid = (a, b) => {
    const k = a < b ? a * 1000 + b : b * 1000 + a;
    let m = cache.get(k);
    if (m === undefined) {
      const x = v1[a * 3] + v1[b * 3], y = v1[a * 3 + 1] + v1[b * 3 + 1], z = v1[a * 3 + 2] + v1[b * 3 + 2];
      const l = Math.hypot(x, y, z);
      m = v1.length / 3;
      v1.push(x / l, y / l, z / l);
      cache.set(k, m);
    }
    return m;
  };
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i], b = f[i + 1], c = f[i + 2];
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    f1.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
  }
  return [d0, { v: v1, f: f1 }];
})();

let LOW = false;
/** Run fn with every GeoBuilder created inside it in low-detail mode (see the header). */
export function withLowDetail(fn) {
  const prev = LOW;
  LOW = true;
  try {
    return fn();
  } finally {
    LOW = prev;
  }
}
/** Side count of a tube / cone in low-detail mode (7 -> 4 sided trunks, 5 -> 3 sided branches). */
export const lowSides = (s) => (s >= 6 ? 4 : s >= 4 ? 3 : s);

export class GeoBuilder {
  constructor() {
    this.lod = LOW; // low-detail mode (fixed at construction)
    this.strand = 0; // strip counter (low mode keeps every other strip)
    this.p = []; // positions
    this.c = []; // colors
    this.w = []; // bend, flutter
    this.pt = []; // part flag per vertex (1 = leaf)
    this.ib = []; // bark indices
    this.il = []; // leaf indices
    this.leaf = false;
    /** (x, y, z) -> bend weight in meters. Set per object. */
    this.bendFn = null;
    this.flutter = 0;
    /** Optional per-vertex vec4 (flowers): xyz = offset to the CLOSED pose, w = per-flower phase. */
    this.cl = null;
    this.closeCur = [0, 0, 0, 0];
  }
  get n() {
    return this.p.length / 3;
  }
  /** Switch the current part ('bark' or 'leaf') for following vertices/triangles. */
  part(name) {
    this.leaf = name === 'leaf';
    return this;
  }
  /** Add a vertex; returns its index. */
  v(x, y, z, col, flutter = this.flutter, bend) {
    this.p.push(x, y, z);
    this.c.push(col[0], col[1], col[2]);
    this.w.push(bend ?? (this.bendFn ? this.bendFn(x, y, z) : 0), flutter);
    this.pt.push(this.leaf ? 1 : 0);
    if (this.cl) this.cl.push(this.closeCur[0], this.closeCur[1], this.closeCur[2], this.closeCur[3]);
    return this.n - 1;
  }
  tri(a, b, c) {
    (this.leaf ? this.il : this.ib).push(a, b, c);
  }
  /** Double-sided triangle (both windings). */
  tri2(a, b, c) {
    const L = this.leaf ? this.il : this.ib;
    L.push(a, b, c, a, c, b);
  }
  quad(a, b, c, d) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }
  quad2(a, b, c, d) {
    this.tri2(a, b, c);
    this.tri2(a, c, d);
  }

  /**
   * Finalize into typed arrays. Also computes smooth vertex normals (used only for the shadow
   * normal bias; shading is flat via derivatives) and bounds metadata.
   */
  finish(meta = {}) {
    const nV = this.n;
    const pos = new Float32Array(this.p);
    const col = new Float32Array(this.c);
    const wind = new Float32Array(this.w);
    const leaf = new Uint8Array(this.pt);
    const nb = this.ib.length;
    const index = new Uint32Array(nb + this.il.length);
    index.set(this.ib, 0);
    index.set(this.il, nb);
    const nrm = new Float32Array(nV * 3);
    // area-weighted face normals; skip the mirrored copy of double-sided triangles
    const seen = new Set();
    for (let i = 0; i < index.length; i += 3) {
      const a = index[i], b = index[i + 1], c = index[i + 2];
      const key = a < b ? (a < c ? `${a},${b < c ? b : c},${b < c ? c : b}` : `${c},${a},${b}`) : b < c ? `${b},${a < c ? a : c},${a < c ? c : a}` : `${c},${b},${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
      const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) {
        nrm[k * 3] += nx;
        nrm[k * 3 + 1] += ny;
        nrm[k * 3 + 2] += nz;
      }
    }
    for (let k = 0; k < nV; k++) {
      const l = Math.hypot(nrm[k * 3], nrm[k * 3 + 1], nrm[k * 3 + 2]);
      if (l < 1e-9) {
        nrm[k * 3 + 1] = 1;
      } else {
        nrm[k * 3] /= l;
        nrm[k * 3 + 1] /= l;
        nrm[k * 3 + 2] /= l;
      }
    }
    // bounds
    let top = -Infinity, crownR = 0, cx = 0, cz = 0, cy = 0, nl = 0, bottomLeaf = Infinity;
    for (let k = 0; k < nV; k++) {
      const y = pos[k * 3 + 1];
      if (y > top) top = y;
      if (leaf[k]) {
        cx += pos[k * 3];
        cy += y;
        cz += pos[k * 3 + 2];
        nl++;
        if (y < bottomLeaf) bottomLeaf = y;
      }
    }
    if (nl) {
      cx /= nl;
      cy /= nl;
      cz /= nl;
      for (let k = 0; k < nV; k++) {
        if (!leaf[k]) continue;
        const r = Math.hypot(pos[k * 3] - cx, pos[k * 3 + 2] - cz);
        if (r > crownR) crownR = r;
      }
    }
    return {
      pos,
      col,
      wind,
      leaf,
      nrm,
      index,
      barkCount: nb,
      nVerts: nV,
      nIdx: index.length,
      height: top,
      crownR,
      crownCX: cx,
      crownCY: cy,
      crownCZ: cz,
      crownBottom: nl ? bottomLeaf : top,
      close: this.cl ? new Float32Array(this.cl) : null,
      ...meta,
    };
  }
}

// ── small vector helpers (arrays [x,y,z]) ───────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrmz = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const vec = { sub, cross, dot, nrmz };

/**
 * Tube along a polyline. pts: [{x,y,z,r}] (r = radius at that ring).
 * colorFn(ringIndex, sideIndex, angle) -> [r,g,b]. opts: { twist, capTop, tipPoint, jitter, rng }
 * The last ring collapses to a single tip vertex when its r <= 0.001 (or opts.tipPoint).
 * Returns { rings: [[idx...]...] }.
 */
export function tube(b, pts, sides, colorFn, opts = {}) {
  const rings = [];
  let N = null;
  const n = pts.length;
  const rng = opts.rng;
  const S = b.lod ? lowSides(sides) : sides;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const pa = pts[Math.max(0, i - 1)], pb = pts[Math.min(n - 1, i + 1)];
    const T = nrmz([pb.x - pa.x, pb.y - pa.y, pb.z - pa.z]);
    if (!N) {
      const ref = Math.abs(T[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      N = nrmz(cross(cross(T, ref), T));
    } else {
      const d = dot(N, T);
      N = nrmz([N[0] - T[0] * d, N[1] - T[1] * d, N[2] - T[2] * d]);
    }
    const B = cross(T, N);
    const last = i === n - 1;
    if (last && (p.r <= 0.001 || opts.tipPoint)) {
      rings.push([b.v(p.x, p.y, p.z, colorFn(i, 0, 0))]);
      continue;
    }
    const ring = [];
    const tw = (opts.twist || 0) * i;
    if (b.lod && n >= 5 && i % 2 === 1 && !last) {
      // low detail: drop this inner ring, keeping its rng/colorFn calls
      for (let j = 0; j < sides; j++) {
        if (rng && opts.jitter) rng();
        colorFn(i, j, (j / sides) * Math.PI * 2 + tw);
      }
      continue;
    }
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2 + tw;
      const jr = rng && opts.jitter ? 1 + (rng() - 0.5) * 2 * opts.jitter : 1;
      if (j >= S) {
        colorFn(i, j, a); // low detail: same calls as the full ring, nothing emitted
        continue;
      }
      const r = p.r * jr;
      const ag = S === sides ? a : (j / S) * Math.PI * 2 + tw;
      const ca = Math.cos(ag), sa = Math.sin(ag);
      ring.push(
        b.v(p.x + (N[0] * ca + B[0] * sa) * r, p.y + (N[1] * ca + B[1] * sa) * r, p.z + (N[2] * ca + B[2] * sa) * r, colorFn(i, j, a))
      );
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    const A = rings[i], Bn = rings[i + 1];
    if (Bn.length === 1) {
      for (let j = 0; j < A.length; j++) b.tri(A[j], A[(j + 1) % A.length], Bn[0]);
      continue;
    }
    for (let j = 0; j < A.length; j++) {
      const j1 = (j + 1) % A.length;
      b.tri(A[j], A[j1], Bn[j]);
      b.tri(A[j1], Bn[j1], Bn[j]);
    }
  }
  if (opts.capTop) {
    const R = rings[rings.length - 1];
    if (R.length > 1) {
      const p = pts[n - 1];
      const c = b.v(p.x, p.y + (opts.capLift || 0), p.z, opts.capColor || colorFn(n - 1, 0, 0));
      for (let j = 0; j < R.length; j++) b.tri(c, R[j], R[(j + 1) % R.length]);
    }
  }
  return { rings };
}

/**
 * Jittered icosphere blob (crowns, bushes, rocks).
 * opts: { detail 0|1, jitter, flatBottom (0..1), colorFn(nx,ny,nz,x,y,z) -> color, rng }
 */
export function blob(b, cx, cy, cz, rx, ry, rz, opts) {
  const T = ICO[opts.detail ?? 1];
  const rng = opts.rng;
  const jitter = opts.jitter ?? 0.15;
  const flat = opts.flatBottom ?? 0.35;
  const base = b.n;
  // low detail: a detail-1 blob keeps its 12 base vertices (same jitter/colors) and the detail-0 faces
  const nKeep = b.lod && T === ICO[1] ? ICO[0].v.length : T.v.length;
  const F = nKeep < T.v.length ? ICO[0].f : T.f;
  for (let i = 0; i < T.v.length; i += 3) {
    let nx = T.v[i], ny = T.v[i + 1], nz = T.v[i + 2];
    const k = 1 + (rng() - 0.5) * 2 * jitter;
    let y = ny;
    if (y < 0) y *= 1 - flat;
    const x = cx + nx * rx * k, yy = cy + y * ry * k, z = cz + nz * rz * k;
    const col = opts.colorFn(nx, ny, nz, x, yy, z);
    if (i < nKeep) b.v(x, yy, z, col);
  }
  for (let i = 0; i < F.length; i += 3) b.tri(base + F[i], base + F[i + 1], base + F[i + 2]);
}

/**
 * Cone (pine tier): rim at y=cy, apex at cy+h, closed underside.
 * opts: { sides, droop (m), jitter, rng, colRim, colApex, colUnder }
 */
export function cone(b, cx, cy, cz, r, h, opts) {
  const sides = opts.sides ?? 7;
  const S = b.lod ? lowSides(sides) : sides;
  const rng = opts.rng;
  const rot = rng() * Math.PI * 2;
  const rim = [];
  for (let j = 0; j < sides; j++) {
    const a = rot + (j / S) * Math.PI * 2;
    const rr = r * (1 + (rng() - 0.5) * 2 * (opts.jitter ?? 0.12));
    const y = cy - (opts.droop ?? 0) * (0.7 + rng() * 0.6);
    const col = opts.colRim();
    if (j < S) rim.push(b.v(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr, col)); // low detail: calls only
  }
  const apex = b.v(cx + (rng() - 0.5) * r * 0.1, cy + h, cz + (rng() - 0.5) * r * 0.1, opts.colApex());
  const under = b.v(cx, cy + h * 0.12, cz, opts.colUnder());
  for (let j = 0; j < S; j++) {
    const j1 = (j + 1) % S;
    b.tri(rim[j], apex, rim[j1]);
    b.tri(rim[j], rim[j1], under);
  }
}

/**
 * Feather-like leaf (palm frond / fern frond): a drooping spine with serrated leaflets on both
 * sides, double-sided. dir is a horizontal unit [x,z]. Returns nothing.
 * opts: { len, width, lift, droop, segs, colBase, colTip, flutter, sideDrop, rng }
 */
export function frond(b, bx, by, bz, dir, opts) {
  const { len, width } = opts;
  // low detail: half the segments, then burn the rng draws the missing ones would make (3 per segment)
  const segs = b.lod ? Math.max(2, Math.ceil(opts.segs / 2)) : opts.segs;
  const lift = opts.lift ?? 0.3, droop = opts.droop ?? 0.8;
  const rng = opts.rng;
  const dx = dir[0], dz = dir[1];
  const sx = -dz, sz = dx; // side vector (horizontal, perpendicular)
  const spine = [];
  const P = (t) => [bx + dx * len * t, by + len * (lift * t - droop * t * t), bz + dz * len * t];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const p = P(t);
    const col = mixc(opts.colBase, opts.colTip, t, rng);
    spine.push(b.v(p[0], p[1], p[2], col, (opts.flutter ?? 0) * t));
  }
  const sideDrop = opts.sideDrop ?? 0.35;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs, tm = (t0 + t1) * 0.5 + 0.15 / segs;
    const w = width * Math.sin(Math.PI * Math.min(1, tm * 1.08)) * (0.85 + rng() * 0.3);
    const pm = P(Math.min(1, tm + 0.35 / segs));
    const col = mixc(opts.colBase, opts.colTip, tm, rng, 0.9);
    const fl = (opts.flutter ?? 0) * tm * 1.2;
    const L = b.v(pm[0] + sx * w, pm[1] - w * sideDrop, pm[2] + sz * w, col, fl);
    const R = b.v(pm[0] - sx * w, pm[1] - w * sideDrop, pm[2] - sz * w, col, fl);
    b.tri2(spine[i], L, spine[i + 1]);
    b.tri2(spine[i], spine[i + 1], R);
  }
  if (rng) for (let k = 3 * (opts.segs - segs); k > 0; k--) rng();
}

function mixc(a, c, t, rng, k = 1) {
  const j = rng ? 1 + (rng() - 0.5) * 0.12 : 1;
  return [(a[0] + (c[0] - a[0]) * t) * j * k, (a[1] + (c[1] - a[1]) * t) * j * k, (a[2] + (c[2] - a[2]) * t) * j * k];
}

/**
 * Double-sided ribbon along a polyline. pts: [[x,y,z]...], widths: per point, side: [x,y,z] unit.
 * colorFn(t) -> color, flutterFn(t) -> m. The last point becomes a single tip when widths ends at 0.
 */
export function strip(b, pts, widths, side, colorFn, flutterFn) {
  const n = pts.length;
  if (b.lod) return stripLow(b, pts, widths, side, colorFn, flutterFn);
  let prevL = -1, prevR = -1;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const p = pts[i];
    const w = widths[i] * 0.5;
    const col = colorFn(t);
    const fl = flutterFn ? flutterFn(t) : 0;
    if (w <= 1e-4) {
      const tip = b.v(p[0], p[1], p[2], col, fl);
      if (prevL >= 0) b.tri2(prevL, prevR, tip);
      prevL = prevR = -1;
      continue;
    }
    const L = b.v(p[0] + side[0] * w, p[1] + side[1] * w, p[2] + side[2] * w, col, fl);
    const R = b.v(p[0] - side[0] * w, p[1] - side[1] * w, p[2] - side[2] * w, col, fl);
    if (prevL >= 0) b.quad2(prevL, prevR, R, L);
    prevL = L;
    prevR = R;
  }
}

/** Low-detail strip: the same colorFn/flutterFn calls, one segment from the first to the last point, every other strip skipped. */
function stripLow(b, pts, widths, side, colorFn, flutterFn) {
  const n = pts.length;
  let c0 = null, c1 = null, f0 = 0, f1 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const col = colorFn(t);
    const fl = flutterFn ? flutterFn(t) : 0;
    if (i === 0) (c0 = col), (f0 = fl);
    if (i === n - 1) (c1 = col), (f1 = fl);
  }
  if ((b.strand++ & 1) === 1 || n < 2) return;
  const p0 = pts[0], p1 = pts[n - 1];
  const w0 = widths[0] * 0.5, w1 = widths[n - 1] * 0.5;
  const L0 = b.v(p0[0] + side[0] * w0, p0[1] + side[1] * w0, p0[2] + side[2] * w0, c0, f0);
  const R0 = b.v(p0[0] - side[0] * w0, p0[1] - side[1] * w0, p0[2] - side[2] * w0, c0, f0);
  if (w1 <= 1e-4) {
    b.tri2(L0, R0, b.v(p1[0], p1[1], p1[2], c1, f1));
    return;
  }
  const L1 = b.v(p1[0] + side[0] * w1, p1[1] + side[1] * w1, p1[2] + side[2] * w1, c1, f1);
  const R1 = b.v(p1[0] - side[0] * w1, p1[1] - side[1] * w1, p1[2] - side[2] * w1, c1, f1);
  b.quad2(L0, R0, R1, L1);
}

/** Small octahedron (fruit, berries, blossoms). sy stretches it vertically. Skipped in low-detail mode. */
export function octa(b, cx, cy, cz, r, col, sy = 1, flutter = 0) {
  if (b.lod) return;
  const i0 = b.v(cx + r, cy, cz, col, flutter);
  const i1 = b.v(cx - r, cy, cz, col, flutter);
  const i2 = b.v(cx, cy + r * sy, cz, mulc(col, 1.15), flutter);
  const i3 = b.v(cx, cy - r * sy, cz, mulc(col, 0.7), flutter);
  const i4 = b.v(cx, cy, cz + r, col, flutter);
  const i5 = b.v(cx, cy, cz - r, col, flutter);
  // outward faces
  b.tri(i0, i2, i4);
  b.tri(i4, i2, i1);
  b.tri(i1, i2, i5);
  b.tri(i5, i2, i0);
  b.tri(i0, i4, i3);
  b.tri(i4, i1, i3);
  b.tri(i1, i5, i3);
  b.tri(i5, i0, i3);
}
const mulc = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

/**
 * Upward-facing disc (lily pad) with an optional notch. Slightly cupped (rim raised by `cup`).
 */
export function disc(b, cx, cy, cz, r, segs, colCenter, colRim, opts = {}) {
  const c = b.v(cx, cy, cz, colCenter, opts.flutter ?? 0);
  const notch = opts.notch ?? 0;
  const rot = opts.rot ?? 0;
  const rim = [];
  for (let j = 0; j <= segs; j++) {
    const a = rot + notch * 0.5 + (j / segs) * (Math.PI * 2 - notch);
    rim.push(b.v(cx + Math.cos(a) * r, cy + (opts.cup ?? 0), cz + Math.sin(a) * r, colRim, opts.flutter ?? 0));
  }
  for (let j = 0; j < segs; j++) b.tri(c, rim[j + 1], rim[j]);
}
