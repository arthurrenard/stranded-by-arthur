// Procedural low-poly geometry toolkit for Builder C (resources + fauna).
//
// GeoBuilder accumulates many small primitives into ONE non-indexed BufferGeometry with:
//   position, normal (flat, per face), color (vertex colors, per-face brightness jitter),
//   aSway (meters of wind displacement at that vertex, read by the sway shader patch),
//   aPbr  (optional vec3: metalness, roughness, sparkle — read by the mineral shader patch).
// One geometry per resource kind -> one InstancedMesh -> one draw call per kind.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

/**
 * Build a Matrix4 from pos [x,y,z], rot [x,y,z] radians and scale (number or [x,y,z]).
 * Euler order 'YXZ': roll (z) first, then tilt (x), then yaw (y) -> 'tilt a leaf, then turn it'.
 */
export function xf(pos = [0, 0, 0], rot = [0, 0, 0], scale = 1) {
  _e.set(rot[0], rot[1], rot[2], 'YXZ');
  _q.setFromEuler(_e);
  if (typeof scale === 'number') _s.set(scale, scale, scale);
  else _s.set(scale[0], scale[1], scale[2]);
  _p.set(pos[0], pos[1], pos[2]);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** Deterministic pseudo-noise of a 3D position -> [0,1). Same input -> same output (crack-free displacement). */
export function hash3(x, y, z) {
  const ix = Math.round(x * 1000), iy = Math.round(y * 1000), iz = Math.round(z * 1000);
  let h = Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * Displace every vertex of a (non-indexed or indexed) geometry with fn(v: Vector3) mutating v.
 * Because fn must be a pure function of the input position, duplicated vertices stay welded.
 */
export function displace(geo, fn) {
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    fn(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  return geo;
}

/** Lumpy rock: radial noise keyed on the original vertex position. */
export function lumpy(geo, amount = 0.2, seed = 0) {
  return displace(geo, (v) => {
    const n = hash3(v.x + seed * 1.7, v.y - seed * 0.9, v.z + seed * 0.3);
    v.multiplyScalar(1 + (n - 0.5) * 2 * amount);
  });
}

/** A tapered, optionally curved blade (grass, leaf, reed) standing on +Y. Double-sided material required. */
export function bladeGeometry(width = 0.05, height = 1, bend = 0.2, segments = 3, tipWidth = 0) {
  const pos = [];
  const rows = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const w = (width * (1 - t) + tipWidth * t) * 0.5;
    const y = height * t;
    const z = bend * t * t * height;
    rows.push([[-w, y, z], [w, y, z]]);
  }
  for (let i = 0; i < segments; i++) {
    const [a, b] = rows[i];
    const [c, d] = rows[i + 1];
    if (i === segments - 1 && tipWidth === 0) {
      pos.push(...a, ...b, (c[0] + d[0]) / 2, c[1], c[2]);
    } else {
      pos.push(...a, ...b, ...d, ...a, ...d, ...c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/** A flat leaf shape lying in the XZ plane (pointing +Z), from an outline function, as a fan. */
export function leafGeometry(length = 0.3, width = 0.12, steps = 6, shape = 'ellipse') {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let w;
    if (shape === 'heart') w = Math.sin(Math.PI * Math.pow(t, 0.75)) * (1.15 - t * 0.6);
    else if (shape === 'lance') w = Math.sin(Math.PI * t) * (1 - t * 0.5);
    else if (shape === 'serrated') w = Math.sin(Math.PI * t) * (i % 2 ? 1.12 : 0.82);
    else w = Math.sin(Math.PI * t);
    pts.push([t * length, w * width * 0.5]);
  }
  const pos = [];
  // fan from the base, split on the midrib so both halves get slightly different normals (bent leaf)
  for (let i = 0; i < steps; i++) {
    const [z0, w0] = pts[i];
    const [z1, w1] = pts[i + 1];
    const y0 = -0.08 * z0, y1 = -0.08 * z1; // slight droop
    // right half
    pos.push(0, y0 + 0.01, z0, w0, y0, z0, w1, y1, z1);
    pos.push(0, y0 + 0.01, z0, w1, y1, z1, 0, y1 + 0.01, z1);
    // left half
    pos.push(0, y0 + 0.01, z0, 0, y1 + 0.01, z1, -w1, y1, z1);
    pos.push(0, y0 + 0.01, z0, -w1, y1, z1, -w0, y0, z0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

/**
 * GeoBuilder: add(geometry, opts) many times, then build().
 * opts:
 *   m:        Matrix4 transform (see xf())
 *   color:    hex | THREE.Color — base color
 *   top:      hex — optional vertical gradient target (color at the part's local top)
 *   jitter:   per-face brightness variation (default 0.07)
 *   sway:     meters of wind sway at the top of the FINAL geometry for this part's vertices
 *             (weight grows with height^1.5); 0 = rigid
 *   pbr:      [metalness, roughness, sparkle] (only used by the mineral material)
 */
export class GeoBuilder {
  constructor(rand = Math.random) {
    this.rand = rand;
    this.parts = [];
  }

  add(geo, opts = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (geo.index) geo.dispose();
    if (opts.m) g.applyMatrix4(opts.m);
    this.parts.push({ g, opts });
    return this;
  }

  build({ swayHeight = null } = {}) {
    let total = 0;
    let maxY = 0.001;
    for (const { g } of this.parts) {
      total += g.attributes.position.count;
      const a = g.attributes.position.array;
      for (let i = 1; i < a.length; i += 3) if (a[i] > maxY) maxY = a[i];
    }
    const H = swayHeight ?? maxY;
    const pos = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const sway = new Float32Array(total);
    const pbr = new Float32Array(total * 3);
    let usePbr = false;
    let o = 0;
    for (const { g, opts } of this.parts) {
      const a = g.attributes.position.array;
      const n = a.length / 3;
      _c.set(opts.color ?? 0xffffff);
      const hasTop = opts.top !== undefined;
      if (hasTop) _c2.set(opts.top);
      // local Y range of this part (for the gradient)
      let y0 = Infinity, y1 = -Infinity;
      if (hasTop) for (let i = 1; i < a.length; i += 3) (y0 = Math.min(y0, a[i])), (y1 = Math.max(y1, a[i]));
      const jitter = opts.jitter ?? 0.07;
      const swayAmp = opts.sway ?? 0;
      const p = opts.pbr ?? [0, 0.9, 0];
      if (opts.pbr) usePbr = true;
      for (let f = 0; f < n; f += 3) {
        const j = 1 + (this.rand() - 0.5) * 2 * jitter; // one brightness per face -> faceted look
        for (let k = 0; k < 3; k++) {
          const vi = f + k;
          const x = a[vi * 3], y = a[vi * 3 + 1], z = a[vi * 3 + 2];
          const w = o + vi;
          pos[w * 3] = x;
          pos[w * 3 + 1] = y;
          pos[w * 3 + 2] = z;
          let r = _c.r, gg = _c.g, b = _c.b;
          if (hasTop) {
            const t = y1 > y0 ? (y - y0) / (y1 - y0) : 0;
            r += (_c2.r - r) * t;
            gg += (_c2.g - gg) * t;
            b += (_c2.b - b) * t;
          }
          col[w * 3] = Math.min(1, r * j);
          col[w * 3 + 1] = Math.min(1, gg * j);
          col[w * 3 + 2] = Math.min(1, b * j);
          sway[w] = swayAmp > 0 ? swayAmp * Math.pow(Math.max(0, y) / H, 1.5) : 0;
          pbr[w * 3] = p[0];
          pbr[w * 3 + 1] = p[1];
          pbr[w * 3 + 2] = p[2];
        }
      }
      o += n;
      g.dispose();
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
    if (usePbr) out.setAttribute('aPbr', new THREE.BufferAttribute(pbr, 3));
    out.computeVertexNormals(); // non-indexed -> flat per-face normals
    out.computeBoundingSphere();
    out.computeBoundingBox();
    this.parts.length = 0;
    return out;
  }
}
