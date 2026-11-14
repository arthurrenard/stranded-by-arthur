// Procedural low-poly story models (Builder F). No asset files: every mesh is assembled from three
// primitives and hand-lofted triangles, merged into ONE BufferGeometry per model part with
// per-triangle vertex colors (crisp low-poly facets, one draw call per part).
//
// Conventions: model forward = -Z (like the camera at yaw 0), up = +Y, boats float with the
// waterline at local y = 0. Geometries are cached per model key; materials are shared.
//
// Everything here is safe to import in node: canvas textures are only created when a DOM exists
// (without one the models fall back to plain colors), so geometry building can be smoke-tested.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { drawGlyph } from './eggRunes.js';

const HAS_DOM = typeof document !== 'undefined';
const PI = Math.PI;

// ── Small deterministic helpers ──────────────────────────────────────────
/** Hash of a 3D point -> [0,1). Identical points give identical values (crack-free jitter). */
export function h3(x, y, z, seed = 0) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453;
  return s - Math.floor(s);
}
/** Tiny seeded PRNG for build-time variety (mulberry32). */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const _mv = new THREE.Vector3(), _mq = new THREE.Quaternion(), _me = new THREE.Euler(), _ms = new THREE.Vector3();
/** Build-time transform matrix: translate, Euler rotate (XYZ), scale. */
export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(_mv.set(x, y, z), _mq.setFromEuler(_me.set(rx, ry, rz)), _ms.set(sx, sy, sz));
}

// ── Shared materials ─────────────────────────────────────────────────────
let _mats = null;
export function materials() {
  if (_mats) return _mats;
  _mats = {
    vc: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.86, metalness: 0 }),
    vcDouble: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0, side: THREE.DoubleSide }),
    glass: new THREE.MeshStandardMaterial({ color: 0x9ad6b4, transparent: true, opacity: 0.5, roughness: 0.1, metalness: 0.1, depthWrite: false }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xfff1c8, emissive: 0xffc46b, emissiveIntensity: 3 }),
    windowLit: new THREE.MeshStandardMaterial({ color: 0x3a2a18, emissive: 0xffb459, emissiveIntensity: 1.4, flatShading: true }),
    windowDark: new THREE.MeshStandardMaterial({ color: 0x1a2630, roughness: 0.25, metalness: 0.4, flatShading: true }),
    navRed: new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2a1a, emissiveIntensity: 2.5 }),
    navGreen: new THREE.MeshStandardMaterial({ color: 0x003000, emissive: 0x2aff5a, emissiveIntensity: 2.5 }),
    strobe: new THREE.MeshStandardMaterial({ color: 0x808080, emissive: 0xffffff, emissiveIntensity: 0 }),
    blueLight: new THREE.MeshStandardMaterial({ color: 0x0a1a40, emissive: 0x3a7bff, emissiveIntensity: 0 }),
    rotorDisc: new THREE.MeshBasicMaterial({ color: 0x1c1f22, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide }),
  };
  return _mats;
}

// ── Canvas textures (browser only) ───────────────────────────────────────
/** Returns a CanvasTexture drawn by draw(g, w, h), or null without a DOM. */
export function canvasTexture(w, h, draw, srgb = true) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
let _glowTex;
/** Soft radial glow (white center -> transparent), shared by sprites. */
export function glowTexture() {
  if (_glowTex !== undefined) return _glowTex;
  _glowTex = canvasTexture(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  return _glowTex;
}

// ── Geometry builder: merges triangles with per-triangle colors ──────────
const _bc = new THREE.Color();
const _ba = new THREE.Vector3(), _bb = new THREE.Vector3(), _bcv = new THREE.Vector3(), _bn = new THREE.Vector3(), _bt = new THREE.Vector3();
export class Builder {
  constructor(seed = 1, jitter = 0.07) {
    this.p = [];
    this.c = [];
    this.seed = seed;
    this.jitter = jitter; // per-triangle brightness variation (low-poly charm)
    this.n = 0;
  }
  _color(color, cx, cy, cz) {
    if (typeof color === 'function') color(cx, cy, cz, _bc);
    else _bc.set(color);
    const j = 1 + (h3(cx, cy, cz, this.seed + this.n) - 0.5) * this.jitter;
    this.n++;
    return j;
  }
  /** One triangle. hint (Vector3-like) = direction the face should look at; winding is fixed to match. */
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, color, hint) {
    if (hint) {
      _ba.set(bx - ax, by - ay, bz - az);
      _bb.set(cx - ax, cy - ay, cz - az);
      _bn.crossVectors(_ba, _bb);
      if (_bn.x * hint.x + _bn.y * hint.y + _bn.z * hint.z < 0) {
        let t = bx; bx = cx; cx = t;
        t = by; by = cy; cy = t;
        t = bz; bz = cz; cz = t;
      }
    }
    const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;
    const j = this._color(color, mx, my, mz);
    this.p.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    const r = _bc.r * j, g = _bc.g * j, b = _bc.b * j;
    this.c.push(r, g, b, r, g, b, r, g, b);
    return this;
  }
  /** Quad a-b-c-d (any winding) facing `hint`. Points are [x,y,z] arrays. */
  quad(a, b, c, d, color, hint) {
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], color, hint);
    this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], color, hint);
    return this;
  }
  /** Merge a three geometry (not mutated) transformed by matrix m. color: hex | (x,y,z,outColor)=>void */
  add(geo, color, m = null) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const pa = g.attributes.position;
    for (let i = 0; i < pa.count; i += 3) {
      _ba.fromBufferAttribute(pa, i);
      _bb.fromBufferAttribute(pa, i + 1);
      _bcv.fromBufferAttribute(pa, i + 2);
      if (m) {
        _ba.applyMatrix4(m);
        _bb.applyMatrix4(m);
        _bcv.applyMatrix4(m);
      }
      this.tri(_ba.x, _ba.y, _ba.z, _bb.x, _bb.y, _bb.z, _bcv.x, _bcv.y, _bcv.z, color);
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  }
  /** Cylinder between two points. */
  cyl(ax, ay, az, bx, by, bz, r, color, seg = 6, r2 = r) {
    _bt.set(bx - ax, by - ay, bz - az);
    const len = _bt.length();
    if (len < 1e-5) return this;
    const geo = new THREE.CylinderGeometry(r2, r, len, seg, 1);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _bt.clone().normalize());
    const m = new THREE.Matrix4().compose(new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), q, new THREE.Vector3(1, 1, 1));
    return this.add(geo, color, m);
  }
  get empty() {
    return this.p.length === 0;
  }
  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}

/** Non-indexed copy of geo with every vertex displaced by a position hash (shared vertices stay welded). */
export function jittered(geo, amp, seed = 0, fn = null) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const kx = Math.round(x * 1000) / 1000, ky = Math.round(y * 1000) / 1000, kz = Math.round(z * 1000) / 1000;
    let nx = x + (h3(kx, ky, kz, seed) - 0.5) * 2 * amp;
    let ny = y + (h3(kx, ky, kz, seed + 7) - 0.5) * 2 * amp;
    let nz = z + (h3(kx, ky, kz, seed + 13) - 0.5) * 2 * amp;
    if (fn) [nx, ny, nz] = fn(nx, ny, nz, x, y, z);
    p.setXYZ(i, nx, ny, nz);
  }
  geo.dispose();
  return g;
}

// ── Geometry cache ───────────────────────────────────────────────────────
const _cache = new Map();
function cached(key, fn) {
  if (!_cache.has(key)) _cache.set(key, fn());
  return _cache.get(key);
}
function mesh(geo, mat, { cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

// ── Shared story lights (created once; never added/removed again → no shader recompiles) ──
let _lights = null;
/** { spot, point }: added to the scene once at intensity 0. Users move them and set intensity. */
export function getStoryLights(scene) {
  if (_lights) return _lights;
  const spot = new THREE.SpotLight(0xf4f1ff, 0, 420, 0.24, 0.55, 1.6);
  spot.castShadow = false;
  spot.position.set(0, -500, 0);
  spot.target.position.set(0, -600, 0);
  const point = new THREE.PointLight(0xffc27a, 0, 30, 2);
  point.castShadow = false;
  point.position.set(0, -500, 0);
  scene.add(spot, spot.target, point);
  _lights = { spot, point };
  return _lights;
}

// ── Boat hull loft ───────────────────────────────────────────────────────
/**
 * Adds a lofted boat hull to builder b. Bow at local z = -L/2, stern (transom) at +L/2, waterline y = 0.
 * o: { L, W (half beam), H (freeboard at stern), D (draft), sheer, s0, s1 (station range 0 stern..1 bow),
 *      st (stations), pal: {top, hull, boot, bottom, deck, inner, rail}, bulwark, jag, holes, rand }
 */
export function addHull(b, o) {
  const { L, W, H, D, sheer = 0.45, s0 = 0, s1 = 1, st = 14, pal, bulwark = 0.35, jag = 0, holes = 0, rand = Math.random, transom = true } = o;
  const zAt = (s) => L / 2 - s * L;
  const wAt = (s) => Math.max(0.02, W * (s < 0.55 ? 0.84 + 0.16 * Math.sin((s / 0.55) * PI * 0.5) : Math.pow(Math.cos(((s - 0.55) / 0.45) * PI * 0.5), 0.75)));
  const topAt = (s) => H * (1 + sheer * s * s);
  const keelAt = (s) => -D * (s < 0.8 ? 1 : 1 - 0.75 * ((s - 0.8) / 0.2));
  const shape = (u) => (u <= 0.4 ? 1 - 0.05 * (u / 0.4) : 0.95 * Math.sqrt(Math.max(0, 1 - ((u - 0.4) / 0.6) ** 2)));
  const rings = [];
  for (let i = 0; i <= st; i++) {
    const s = s0 + ((s1 - s0) * i) / st;
    const top = topAt(s), keel = keelAt(s), w = wAt(s);
    let z = zAt(s);
    const levels = [top, top - 0.2, (top - 0.2 + 0.15) / 2, 0.15, -0.04, keel * 0.35 - 0.04, keel * 0.65, keel * 0.88, keel];
    const breakEdge = (i === 0 && s0 > 0) || (i === st && s1 < 1);
    const side = [];
    for (const y of levels) {
      const u = (top - y) / (top - keel);
      side.push([w * shape(u), y]);
    }
    const ring = [];
    for (let k = 0; k < side.length; k++) ring.push([side[k][0], side[k][1], z]);
    for (let k = side.length - 2; k >= 0; k--) ring.push([-side[k][0], side[k][1], z]);
    if (breakEdge && jag > 0) {
      for (const p of ring) {
        p[2] += (rand() - 0.5) * jag;
        p[1] += (rand() - 0.5) * jag * 0.3;
      }
    }
    rings.push({ ring, s, top, w, z, deckY: top - bulwark });
  }
  const segColor = (m) => (m === 0 ? pal.top : m <= 2 ? pal.hull : m === 3 ? pal.boot : pal.bottom);
  const hint = new THREE.Vector3();
  const nSeg = rings[0].ring.length - 1; // 16
  for (let i = 0; i < st; i++) {
    const A = rings[i].ring, B = rings[i + 1].ring;
    for (let k = 0; k < nSeg; k++) {
      if (holes > 0 && rand() < holes) continue;
      const m = k < nSeg / 2 ? k : nSeg - 1 - k;
      const cx = (A[k][0] + A[k + 1][0] + B[k][0]) / 3, cy = (A[k][1] + A[k + 1][1]) / 2;
      hint.set(cx, (cy - 0.2) * 0.6, 0);
      if (hint.lengthSq() < 1e-6) hint.set(0, -1, 0);
      b.quad(A[k], A[k + 1], B[k + 1], B[k], segColor(m), hint);
    }
    // rail cap, inner bulwark, deck
    const ra = rings[i], rb = rings[i + 1];
    for (const sx of [1, -1]) {
      const oa = [sx * ra.w, ra.top, ra.z], ob = [sx * rb.w, rb.top, rb.z];
      const ia = [sx * ra.w * 0.92, ra.top, ra.z], ib = [sx * rb.w * 0.92, rb.top, rb.z];
      const da = [sx * ra.w * 0.92, ra.deckY, ra.z], db = [sx * rb.w * 0.92, rb.deckY, rb.z];
      b.quad(oa, ob, ib, ia, pal.rail, hint.set(0, 1, 0));
      b.quad(ia, ib, db, da, pal.inner, hint.set(-sx, 0, 0));
    }
    const plank = i % 2 ? pal.deck : (x, y, z, out) => out.set(pal.deck).multiplyScalar(0.9);
    b.quad([ra.w * 0.92, ra.deckY, ra.z], [-ra.w * 0.92, ra.deckY, ra.z], [-rb.w * 0.92, rb.deckY, rb.z], [rb.w * 0.92, rb.deckY, rb.z], plank, hint.set(0, 1, 0));
  }
  // transom (flat stern) fan
  if (s0 === 0 && transom) {
    const R = rings[0].ring;
    const cy = (rings[0].top + keelAt(0)) / 2, z = rings[0].z;
    for (let k = 0; k < R.length - 1; k++) {
      const m = k < nSeg / 2 ? k : nSeg - 1 - k;
      b.tri(0, cy, z, R[k][0], R[k][1], R[k][2], R[k + 1][0], R[k + 1][1], R[k + 1][2], segColor(m), hint.set(0, 0, 1));
    }
    b.tri(0, cy, z, R[R.length - 1][0], R[R.length - 1][1], z, R[0][0], R[0][1], z, pal.top, hint.set(0, 0, 1));
  }
  return { topAt, wAt, zAt, keelAt, deckAt: (s) => topAt(s) - bulwark, sAtZ: (z) => (L / 2 - z) / L };
}

function namePlate(text, w, h, weathered = false) {
  const tex = canvasTexture(512, 112, (g, cw, ch) => {
    g.clearRect(0, 0, cw, ch);
    g.font = 'bold 74px Georgia, "Times New Roman", serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = weathered ? 'rgba(236,228,206,0.85)' : '#f3ecd8';
    g.fillText(text, cw / 2, ch / 2 + 4);
    if (weathered) {
      // erode the paint
      g.globalCompositeOperation = 'destination-out';
      const r = prng(7);
      for (let i = 0; i < 260; i++) {
        g.fillStyle = `rgba(0,0,0,${0.3 + r() * 0.7})`;
        g.fillRect(r() * cw, r() * ch, 2 + r() * 14, 1 + r() * 5);
      }
      g.globalCompositeOperation = 'source-over';
    }
  });
  if (!tex) return null;
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
  return mesh(new THREE.PlaneGeometry(w, h), mat, { cast: false });
}

// ── 1. Fishing boat (intro) ──────────────────────────────────────────────
const BOAT_PAL = { top: 0xe9e3d3, hull: 0x2b5f7e, boot: 0xe9e3d3, bottom: 0x9b3426, deck: 0x9c7650, inner: 0xd8d2c2, rail: 0x7a5a3a };
const BOAT_DIM = { L: 11, W: 1.9, H: 1.3, D: 1.4 };

function addBoatTop(b, hull, { broken = false, rand = Math.random } = {}) {
  const dk = (z) => hull.deckAt(hull.sAtZ(z));
  const cabY = dk(1.6);
  // wheelhouse
  b.add(new THREE.BoxGeometry(2.4, 1.95, 2.6), 0xece6d6, M(0, cabY + 0.97, 1.6));
  b.add(new THREE.BoxGeometry(2.66, 0.13, 2.95), BOAT_PAL.hull, M(0, cabY + 2.0, 1.55, broken ? 0.12 : 0, 0, broken ? -0.1 : 0));
  b.add(new THREE.BoxGeometry(0.72, 1.5, 0.05), 0x7a5a3a, M(-0.5, cabY + 0.75, 2.92)); // door
  b.cyl(-0.8, cabY + 2.0, 2.4, -0.8, cabY + 2.75, 2.4, 0.09, 0x1d1d1d, 7); // exhaust
  b.cyl(0.9, cabY + 2.0, 2.6, 0.9, cabY + 3.4, 2.6, 0.015, 0x333333, 4); // antenna
  // life ring on the back wall (orange/white quarters)
  b.add(new THREE.TorusGeometry(0.27, 0.06, 6, 12), (x, y, z, out) => out.set(Math.floor((Math.atan2(y - cabY - 1.3, x - 0.55) + PI) / (PI / 2)) % 2 ? 0xe8742c : 0xf2efe6), M(0.55, cabY + 1.3, 2.97));
  // winch drum + net pile with floats on the aft deck
  const aft = dk(3.6);
  b.add(new THREE.CylinderGeometry(0.26, 0.26, 0.9, 8), 0x8a2f22, M(0, aft + 0.35, 3.35, 0, 0, PI / 2));
  b.add(jittered(new THREE.IcosahedronGeometry(1, 1), 0.12, 3), 0x5f7d6d, M(0.15, aft + 0.22, 4.35, 0, 0.3, 0, 1.15, 0.32, 0.75));
  for (let i = 0; i < 7; i++) {
    const a = i * 2.1, r = 0.35 + (i % 3) * 0.22;
    b.add(new THREE.IcosahedronGeometry(0.09, 0), 0xe8742c, M(0.15 + Math.cos(a) * r, aft + 0.48 - r * 0.15, 4.35 + Math.sin(a) * r * 0.6));
  }
  // fore deck: fish-hold hatch + bitts
  const fore = dk(-2.6);
  b.add(new THREE.BoxGeometry(1.3, 0.25, 1.1), 0x6e5032, M(0, fore + 0.12, -2.6));
  b.add(new THREE.CylinderGeometry(0.08, 0.08, 0.35, 6), 0x2a2a2a, M(0, dk(-4.4) + 0.17, -4.4));
  // mast, spreader, outrigger booms, stays, paravanes
  const mz = -0.8, mBase = dk(mz);
  if (!broken) {
    b.cyl(0, mBase, mz, 0, mBase + 6.4, mz, 0.09, 0xd9d4c6, 7, 0.06);
    b.add(new THREE.BoxGeometry(1.7, 0.06, 0.06), 0xd9d4c6, M(0, mBase + 5.2, mz));
    for (const sx of [1, -1]) {
      const tx = sx * 4.3, ty = mBase + 4.4, tz = mz + 0.3;
      b.cyl(sx * 0.12, mBase + 0.9, mz, tx, ty, tz, 0.055, 0x8c8a84, 6, 0.035);
      b.cyl(0, mBase + 6.3, mz, tx, ty, tz, 0.012, 0x444444, 3);
      b.cyl(tx, ty, tz, tx, ty - 1.9, tz, 0.01, 0x444444, 3);
      b.add(new THREE.ConeGeometry(0.18, 0.5, 5), 0x2c3036, M(tx, ty - 2.1, tz, PI, 0, 0));
    }
    b.cyl(0, mBase + 6.3, mz, 0, hull.topAt(1) + 0.1, -5.4, 0.012, 0x444444, 3); // forestay
    b.cyl(0, mBase + 6.3, mz, 0, cabY + 2.05, 2.8, 0.012, 0x444444, 3); // backstay
  } else {
    b.cyl(0, mBase, mz, 0.1, mBase + 2.3, mz + 0.1, 0.09, 0xb9b3a4, 7, 0.07); // snapped stub
    b.add(new THREE.ConeGeometry(0.1, 0.35, 5), 0xa79f8c, M(0.1, mBase + 2.45, mz + 0.1, 0.3, 0, 0.4));
  }
  void rand;
}

function boatWindows(hull) {
  const b = new Builder(5, 0.02);
  const cabY = hull.deckAt(hull.sAtZ(1.6));
  for (const x of [-0.72, 0, 0.72]) b.add(new THREE.BoxGeometry(0.6, 0.5, 0.05), 0xffffff, M(x, cabY + 1.45, 0.28, -0.12, 0, 0));
  for (const sx of [1, -1]) for (const z of [1.15, 2.1]) b.add(new THREE.BoxGeometry(0.05, 0.45, 0.68), 0xffffff, M(sx * 1.215, cabY + 1.45, z));
  b.add(new THREE.BoxGeometry(0.35, 0.35, 0.05), 0xffffff, M(-0.5, cabY + 1.15, 2.95));
  return b.build();
}

/** The intro's fishing boat "Marguerite". Returns { group, lampLocal (Vector3), lamp }. */
export function createFishingBoat() {
  const geo = cached('boat', () => {
    const b = new Builder(11);
    const hull = addHull(b, { ...BOAT_DIM, pal: BOAT_PAL, st: 16 });
    addBoatTop(b, hull);
    return { body: b.build(), windows: boatWindows(hull), mastTop: hull.deckAt(hull.sAtZ(-0.8)) + 6.4 };
  });
  const mats = materials();
  const group = new THREE.Group();
  group.name = 'fishing-boat';
  group.add(mesh(geo.body, mats.vc));
  group.add(mesh(geo.windows, mats.windowLit, { cast: false }));
  const lamp = mesh(new THREE.SphereGeometry(0.13, 8, 6), mats.lamp, { cast: false });
  lamp.position.set(0, geo.mastTop + 0.12, -0.8);
  group.add(lamp);
  const name = namePlate('MARGUERITE', 2.0, 0.44);
  if (name) {
    name.position.set(0, 0.72, 5.52);
    group.add(name);
  }
  return { group, lamp, lampLocal: lamp.position.clone() };
}

// ── 2. The wreck on the reef (permanent) ─────────────────────────────────
const WRECK_PAL = { top: 0xb6ae9b, hull: 0x48616e, boot: 0xa8a191, bottom: 0x6e3a2c, deck: 0x6b5541, inner: 0x9a9384, rail: 0x5a4532 };
/** Reef rock layout around the wreck center (local x,z, radius, top y). */
export const REEF_ROCKS = [
  { x: 0.5, z: -3.5, r: 3.4, top: 1.5 },
  { x: 5.0, z: -1.0, r: 2.6, top: 0.7 },
  { x: -4.5, z: 1.5, r: 2.8, top: 1.0 },
  { x: 2.5, z: 4.5, r: 2.2, top: 0.2 },
  { x: -3.0, z: -6.0, r: 2.0, top: 0.4 },
  { x: 6.5, z: 4.0, r: 1.8, top: -0.3 },
  { x: -7.0, z: -2.5, r: 1.6, top: -0.1 },
];

/** Wreck group: { group, hull (Group, hidden during the intro), rocks: [{x,z,r,top}] in local coords }. */
export function createWreck() {
  const geo = cached('wreck', () => {
    const r = prng(353);
    // reef rocks: a stretched pillar from the seabed + a boulder cap
    const rb = new Builder(21, 0.12);
    const rockCol = (x, y, z, out) => {
      if (y > 0.45) out.set(0x6c665d).lerp(_tmpCol.set(0x8a847a), Math.min(1, (y - 0.45) / 1.2));
      else if (y > -0.6) out.set(0x3d4733); // wet algae band at the waterline
      else out.set(0x45403a);
    };
    REEF_ROCKS.forEach((k, i) => {
      const hgt = k.top + 10;
      rb.add(jittered(new THREE.IcosahedronGeometry(1, 1), 0.18, i), rockCol, M(k.x, k.top - hgt / 2 - 0.4, k.z, 0, i, 0, k.r * 1.15, hgt / 2, k.r));
      rb.add(jittered(new THREE.IcosahedronGeometry(1, 1), 0.2, i + 40), rockCol, M(k.x + 0.3, k.top - k.r * 0.35, k.z - 0.2, i, i * 2, 0, k.r * 0.95, k.r * 0.55, k.r * 0.85));
    });
    // two hull halves (double-sided so the torn, open shell reads from inside)
    const front = new Builder(31, 0.1);
    const fh = addHull(front, { ...BOAT_DIM, pal: WRECK_PAL, s0: 0.47, s1: 1, st: 9, jag: 0.9, holes: 0.05, rand: r });
    // snapped mast stub on the front half
    const mz = -0.8, mBase = fh.deckAt(fh.sAtZ(mz));
    front.cyl(0, mBase, mz, 0.15, mBase + 2.4, mz + 0.1, 0.09, 0xb9b3a4, 7, 0.07);
    const rear = new Builder(41, 0.1);
    const rh = addHull(rear, { ...BOAT_DIM, pal: WRECK_PAL, s0: 0, s1: 0.5, st: 8, jag: 0.9, holes: 0.06, rand: r });
    addBoatTop(rear, rh, { broken: true, rand: r });
    // debris: torn planks, the fallen mast + an outrigger boom, a net draped on a rock
    const db = new Builder(51, 0.12);
    for (let i = 0; i < 9; i++) {
      const a = r() * PI * 2, d = 1.5 + r() * 5;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const top = REEF_ROCKS.reduce((m, k) => Math.max(m, Math.hypot(x - k.x, z - k.z) < k.r * 0.8 ? k.top : -0.2), -0.2);
      db.add(new THREE.BoxGeometry(0.22, 0.06, 1.4 + r() * 1.6), r() < 0.5 ? 0x6b5541 : 0x48616e, M(x, top + 0.1, z, (r() - 0.5) * 0.5, r() * PI, (r() - 0.5) * 0.6));
    }
    db.cyl(-1.5, 1.8, -2.0, -6.5, -0.4, 2.8, 0.08, 0xb9b3a4, 7, 0.06); // fallen mast
    db.cyl(-6.0, 0.3, -1.0, -9.0, -0.6, 1.5, 0.05, 0x8c8a84, 6, 0.04); // boom
    db.add(jittered(new THREE.IcosahedronGeometry(1, 1), 0.15, 9), 0x4f6b5d, M(-4.4, 1.15, 1.4, 0, 0.5, 0, 1.6, 0.25, 1.2));
    return {
      rocks: rb.build(),
      front: front.build(),
      rear: rear.build(),
      debris: db.build(),
      rearWindows: (() => {
        const w = new Builder(61, 0.02);
        const cabY = rh.deckAt(rh.sAtZ(1.6));
        w.add(new THREE.BoxGeometry(0.6, 0.5, 0.05), 0xffffff, M(0.72, cabY + 1.45, 0.28, -0.12, 0, 0));
        for (const z of [1.15, 2.1]) w.add(new THREE.BoxGeometry(0.05, 0.45, 0.68), 0xffffff, M(1.215, cabY + 1.45, z));
        return w.build();
      })(),
    };
  });
  const mats = materials();
  const group = new THREE.Group();
  group.name = 'wreck';
  group.add(mesh(geo.rocks, mats.vc));
  const hull = new THREE.Group();
  const front = mesh(geo.front, mats.vcDouble);
  front.position.set(-0.4, 0.55, -2.2);
  front.rotation.set(0.27, 0.22, 0.34);
  const rear = new THREE.Group();
  rear.position.set(0.9, -0.55, 3.6);
  rear.rotation.set(-0.1, -0.38, -0.42);
  rear.add(mesh(geo.rear, mats.vcDouble), mesh(geo.rearWindows, mats.windowDark, { cast: false }));
  const name = namePlate('MARGUERITE', 2.0, 0.44, true);
  if (name) {
    name.position.set(0, 0.72, 5.53);
    rear.add(name);
  }
  hull.add(front, rear, mesh(geo.debris, mats.vcDouble));
  group.add(hull);
  return { group, hull, rocks: REEF_ROCKS };
}
const _tmpCol = new THREE.Color();

// ── 3. Search-and-rescue helicopter ──────────────────────────────────────
/** Returns { group, mainRotor, tailRotor, disc, beacon, strobe, spotAnchor, ladderAnchor }. */
export function createHelicopter() {
  const geo = cached('heli', () => {
    const b = new Builder(71, 0.06);
    const RED = 0xc62f28, WHITE = 0xf0efe9, GRAY = 0x9aa0a6, DARK = 0x23272b, GLASS = 0x1a2a3a;
    const livery = (x, y, z, out) => out.set(y < -0.42 ? WHITE : Math.abs(y - 0.05) < 0.14 && z > -1.2 ? WHITE : RED);
    b.add(new THREE.SphereGeometry(1, 14, 9), livery, M(0, 0, 0, 0, 0, 0, 1.35, 1.3, 2.55));
    b.add(new THREE.SphereGeometry(1, 12, 7, 0, PI * 2, 0, PI * 0.55), GLASS, M(0, 0.1, -1.55, -1.25, 0, 0, 1.08, 1.05, 0.95));
    for (const sx of [1, -1]) {
      b.add(new THREE.BoxGeometry(0.06, 0.55, 0.9), GLASS, M(sx * 1.28, 0.25, -0.2));
      b.add(new THREE.BoxGeometry(0.05, 0.5, 0.7), GLASS, M(sx * 1.2, 0.25, 0.85, 0, sx * 0.12, 0));
      b.add(new THREE.BoxGeometry(0.04, 1.2, 1.25), 0xa8241f, M(sx * 1.31, -0.15, 0.4)); // sliding door
    }
    // tail boom with white bands, fin, stabilizer
    b.add(new THREE.CylinderGeometry(0.2, 0.46, 5.3, 8), (x, y, z, out) => out.set(z > 4.4 && z < 5.0 ? WHITE : z > 6.0 ? WHITE : RED), M(0, 0.42, 4.25, PI / 2 + 0.06, 0, 0));
    b.add(new THREE.BoxGeometry(0.1, 1.9, 1.05), (x, y, z, out) => out.set(y > 1.55 ? WHITE : RED), M(0, 1.15, 6.6, -0.38, 0, 0));
    b.add(new THREE.BoxGeometry(1.9, 0.07, 0.5), WHITE, M(0, 0.5, 6.0));
    // engine housing, intakes, rotor mast
    b.add(new THREE.BoxGeometry(1.1, 0.55, 2.3), GRAY, M(0, 1.3, 0.45));
    for (const sx of [1, -1]) b.add(new THREE.BoxGeometry(0.08, 0.3, 0.5), DARK, M(sx * 0.56, 1.32, -0.3));
    b.cyl(0, 1.5, 0, 0, 1.95, 0, 0.13, DARK, 8);
    // skids + struts
    for (const sx of [1, -1]) {
      b.cyl(sx * 1.1, -1.62, 1.8, sx * 1.1, -1.62, -1.7, 0.06, 0x3b3f44, 6);
      b.cyl(sx * 1.1, -1.62, -1.7, sx * 1.1, -1.35, -2.15, 0.06, 0x3b3f44, 6);
      for (const z of [-0.9, 0.9]) b.cyl(sx * 0.75, -0.95, z, sx * 1.1, -1.62, z, 0.05, 0x3b3f44, 5);
    }
    // searchlight housing under the nose + winch arm by the door
    b.cyl(0, -1.05, -1.55, 0, -1.3, -1.6, 0.16, DARK, 8);
    b.cyl(1.0, 0.9, 0.2, 1.65, 0.9, 0.2, 0.05, GRAY, 5);
    b.cyl(1.65, 0.9, 0.2, 1.65, 0.7, 0.2, 0.08, DARK, 6);
    const body = b.build();

    const rb = new Builder(72, 0.04);
    rb.cyl(0, -0.08, 0, 0, 0.14, 0, 0.22, DARK, 8);
    for (let i = 0; i < 4; i++) {
      rb.add(new THREE.BoxGeometry(5.6, 0.05, 0.32), (x, y, z, out) => out.set(Math.hypot(x, z) > 5.2 ? 0xe8c547 : 0x2a2d30), M(Math.cos((i * PI) / 2) * 2.9, 0.05, -Math.sin((i * PI) / 2) * 2.9, 0, (i * PI) / 2, 0.03));
    }
    const rotor = rb.build();
    const tb = new Builder(73, 0.04);
    tb.cyl(-0.1, 0, 0, 0.1, 0, 0, 0.1, DARK, 6);
    for (let i = 0; i < 2; i++) tb.add(new THREE.BoxGeometry(0.04, 1.5, 0.14), (x, y, z, out) => out.set(Math.abs(y) > 0.6 || Math.abs(z) > 0.6 ? 0xf0efe9 : 0x2a2d30), M(0, 0, 0, i * PI * 0.5, 0, 0));
    return { body, rotor, tail: tb.build() };
  });
  const mats = materials();
  const group = new THREE.Group();
  group.name = 'helicopter';
  group.add(mesh(geo.body, mats.vc));
  const mainRotor = mesh(geo.rotor, mats.vc);
  mainRotor.position.set(0, 2.0, 0);
  const disc = mesh(new THREE.CircleGeometry(5.75, 36), mats.rotorDisc, { cast: false, receive: false });
  disc.rotation.x = -PI / 2;
  disc.position.set(0, 2.06, 0);
  const tailRotor = mesh(geo.tail, mats.vc, { cast: false });
  tailRotor.position.set(-0.2, 1.3, 6.85);
  const navR = mesh(new THREE.SphereGeometry(0.07, 6, 4), mats.navRed, { cast: false });
  navR.position.set(-0.95, 0.5, 6.0);
  const navG = mesh(new THREE.SphereGeometry(0.07, 6, 4), mats.navGreen, { cast: false });
  navG.position.set(0.95, 0.5, 6.0);
  const beacon = mesh(new THREE.SphereGeometry(0.1, 6, 4), mats.navRed.clone(), { cast: false });
  beacon.position.set(0, 1.62, 1.4);
  const strobe = mesh(new THREE.SphereGeometry(0.08, 6, 4), mats.strobe, { cast: false });
  strobe.position.set(0, 2.1, 6.95);
  const lens = mesh(new THREE.CircleGeometry(0.15, 10), mats.lamp, { cast: false });
  lens.rotation.x = PI / 2;
  lens.position.set(0, -1.31, -1.6);
  const spotAnchor = new THREE.Object3D();
  spotAnchor.position.set(0, -1.35, -1.6);
  const ladderAnchor = new THREE.Object3D();
  ladderAnchor.position.set(1.65, 0.65, 0.2);
  group.add(mainRotor, disc, tailRotor, navR, navG, beacon, strobe, lens, spotAnchor, ladderAnchor);
  return { group, mainRotor, tailRotor, disc, beacon, strobe, spotAnchor, ladderAnchor };
}

// ── 4. Coast-guard search boat ───────────────────────────────────────────
const SAR_PAL = { top: 0xee6b2b, hull: 0xe25e22, boot: 0xf3efe6, bottom: 0x33383d, deck: 0x8d9296, inner: 0xd9d6cf, rail: 0x2b2f33 };
/** Returns { group, radar, lightBar, spotAnchor }. */
export function createSearchBoat() {
  const geo = cached('sarboat', () => {
    const b = new Builder(81, 0.05);
    const hull = addHull(b, { L: 15, W: 2.5, H: 1.5, D: 1.1, sheer: 0.35, pal: SAR_PAL, st: 16, bulwark: 0.3 });
    const dk = (z) => hull.deckAt(hull.sAtZ(z));
    const cy = dk(-0.6);
    b.add(new THREE.BoxGeometry(3.1, 2.2, 4.6), (x, y, z, out) => out.set(y > cy + 1.25 && y < cy + 1.85 ? 0x1a2630 : 0xf0f0ea), M(0, cy + 1.1, -0.6));
    b.add(new THREE.BoxGeometry(3.3, 0.14, 4.9), 0xee6b2b, M(0, cy + 2.27, -0.6));
    // radar arch
    for (const sx of [1, -1]) b.cyl(sx * 1.2, cy + 2.3, 1.2, sx * 0.9, cy + 3.8, 1.0, 0.07, 0xd9d6cf, 6);
    b.add(new THREE.BoxGeometry(2.0, 0.12, 0.25), 0xd9d6cf, M(0, cy + 3.85, 1.0));
    b.cyl(0, cy + 3.9, 1.0, 0, cy + 4.25, 1.0, 0.06, 0x2b2f33, 6);
    // fenders + life-raft canisters + towing post
    for (const sx of [1, -1]) for (const z of [-3, -1, 1, 3]) b.add(new THREE.CylinderGeometry(0.16, 0.16, 0.6, 7), 0x3a3f44, M(sx * (hull.wAt(hull.sAtZ(z)) + 0.1), 0.85, z));
    for (const x of [-0.8, 0.8]) b.add(new THREE.CylinderGeometry(0.28, 0.28, 0.9, 8), 0xf3efe6, M(x, dk(5.5) + 0.32, 5.5, 0, 0, PI / 2));
    b.cyl(0, dk(6.6), 6.6, 0, dk(6.6) + 0.6, 6.6, 0.12, 0x2b2f33, 7);
    b.add(new THREE.CylinderGeometry(0.22, 0.26, 0.35, 8), 0x2b2f33, M(0.9, cy + 2.5, -2.4)); // searchlight
    const body = b.build();
    const rb = new Builder(82, 0.02);
    rb.add(new THREE.BoxGeometry(1.4, 0.1, 0.16), 0xf0f0ea, M(0, 0, 0));
    return { body, radar: rb.build(), radarY: cy + 4.3, lightY: cy + 2.4 };
  });
  const mats = materials();
  const group = new THREE.Group();
  group.name = 'search-boat';
  group.add(mesh(geo.body, mats.vc));
  const radar = mesh(geo.radar, mats.vc, { cast: false });
  radar.position.set(0, geo.radarY, 1.0);
  const lightBar = mesh(new THREE.BoxGeometry(1.2, 0.14, 0.22), mats.blueLight, { cast: false });
  lightBar.position.set(0, geo.lightY, -2.6);
  const spotAnchor = new THREE.Object3D();
  spotAnchor.position.set(0.9, geo.lightY + 0.15, -2.7);
  group.add(radar, lightBar, spotAnchor);
  for (const sx of [1, -1]) {
    const tex = canvasTexture(512, 96, (g, w, h) => {
      g.fillStyle = '#ee6b2b';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffffff';
      g.font = 'bold 54px "Avenir Next", Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('SEARCH & RESCUE', w / 2, h / 2 + 3);
    });
    if (!tex) break;
    const plate = mesh(new THREE.PlaneGeometry(3.6, 0.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }), { cast: false });
    plate.position.set(sx * 1.56, geo.lightY - 1.85, -0.6);
    plate.rotation.y = sx * PI * 0.5;
    group.add(plate);
  }
  return { group, radar, lightBar, spotAnchor };
}

// ── 5. Wooden crate (searchable) ─────────────────────────────────────────
/** Returns { group, lid (pivot Group; rotate .rotation.x negative to open) }. */
export function createCrate(seed = 1) {
  const geo = cached('crate', () => {
    const b = new Builder(91, 0.12);
    const W = 0.9, H = 0.62, D = 0.62, FR = 0x6e4b2c, PL = 0xa77b4b;
    b.add(new THREE.BoxGeometry(W - 0.04, H - 0.04, D - 0.04), PL, M(0, H / 2, 0));
    for (const y of [0.2, 0.42]) for (const sz of [1, -1]) b.add(new THREE.BoxGeometry(W - 0.06, 0.02, 0.012), 0x5e3f24, M(0, y, sz * (D / 2 - 0.012)));
    for (const sx of [1, -1]) for (const sz of [1, -1]) b.add(new THREE.BoxGeometry(0.07, H, 0.07), FR, M(sx * (W / 2 - 0.03), H / 2, sz * (D / 2 - 0.03)));
    for (const y of [0.035, H - 0.035]) for (const sz of [1, -1]) b.add(new THREE.BoxGeometry(W, 0.07, 0.07), FR, M(0, y, sz * (D / 2 - 0.03)));
    b.add(new THREE.BoxGeometry(0.5, 0.02, 0.014), 0x2f2418, M(0, 0.32, D / 2 + 0.002)); // stencil bar
    const lb = new Builder(92, 0.12);
    lb.add(new THREE.BoxGeometry(W + 0.04, 0.07, D + 0.04), PL, M(0, 0.035, D / 2));
    for (const x of [-0.3, 0, 0.3]) lb.add(new THREE.BoxGeometry(0.03, 0.075, D + 0.02), FR, M(x, 0.04, D / 2));
    return { body: b.build(), lid: lb.build(), H, D };
  });
  const mats = materials();
  const group = new THREE.Group();
  group.add(mesh(geo.body, mats.vc));
  const lid = new THREE.Group();
  lid.position.set(0, geo.H, -geo.D / 2);
  lid.add(mesh(geo.lid, mats.vc));
  group.add(lid);
  group.rotation.set((seed % 3) * 0.04, 0, ((seed % 5) - 2) * 0.03);
  return { group, lid };
}

/** Beach debris (planks, oar, buoy, rope coil, jerrycan) merged into one mesh in WORLD space. */
export function createDebris(world, spots, seed = 5) {
  const r = prng(seed);
  const b = new Builder(seed, 0.12);
  const ground = (x, z) => Math.max(world.heightAt(x, z), world.SEA_LEVEL - 0.2);
  for (const sp of spots) {
    for (let i = 0; i < (sp.n ?? 4); i++) {
      const x = sp.x + (r() - 0.5) * 2 * (sp.r ?? 4), z = sp.z + (r() - 0.5) * 2 * (sp.r ?? 4);
      const y = ground(x, z);
      const kind = r();
      if (kind < 0.45) b.add(new THREE.BoxGeometry(0.2 + r() * 0.1, 0.05, 1.2 + r() * 1.4), r() < 0.5 ? 0x9a8160 : 0x48616e, M(x, y + 0.02, z, (r() - 0.5) * 0.15, r() * PI, (r() - 0.5) * 0.2));
      else if (kind < 0.6) {
        b.add(new THREE.SphereGeometry(0.26, 8, 6), (px, py, pz, out) => out.set(Math.abs(py - y - 0.18) < 0.07 ? 0xf2efe6 : 0xe8742c), M(x, y + 0.18, z));
      } else if (kind < 0.75) b.add(new THREE.TorusGeometry(0.28, 0.05, 5, 12), 0xc9b27a, M(x, y + 0.04, z, PI / 2, 0, 0, 1, 1, 0.6));
      else if (kind < 0.88) b.add(new THREE.BoxGeometry(0.34, 0.42, 0.18), 0xb02a20, M(x, y + 0.15, z, 0.4, r() * PI, PI / 2 - 0.2));
      else {
        b.cyl(x - 0.8, y + 0.05, z, x + 0.7, y + 0.08, z + 0.3, 0.03, 0x9a8160, 5);
        b.add(new THREE.BoxGeometry(0.16, 0.03, 0.5), 0x9a8160, M(x + 0.9, y + 0.07, z + 0.34, 0, 1.4, 0));
      }
    }
  }
  const m = mesh(b.build(), materials().vc);
  m.name = 'beach-debris';
  return m;
}

// ── 6. Message in a bottle ───────────────────────────────────────────────
export function createBottle() {
  const mats = materials();
  const geo = cached('bottle', () => {
    const pts = [[0, 0], [0.05, 0], [0.056, 0.012], [0.056, 0.14], [0.05, 0.172], [0.022, 0.2], [0.018, 0.245], [0.021, 0.255], [0, 0.255]].map(([x, y]) => new THREE.Vector2(x * 1.6, y * 1.6));
    const inner = new Builder(101, 0.05);
    inner.add(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 8), 0xefe3c2, M(0, 0.16, 0));
    inner.add(new THREE.TorusGeometry(0.037, 0.008, 4, 10), 0xa8322a, M(0, 0.16, 0, PI / 2, 0, 0));
    inner.add(new THREE.CylinderGeometry(0.03, 0.026, 0.07, 7), 0xa87b4f, M(0, 0.4, 0));
    return { glass: new THREE.LatheGeometry(pts, 10), inner: inner.build() };
  });
  const group = new THREE.Group();
  const inner = mesh(geo.inner, mats.vc, { cast: false });
  const glass = mesh(geo.glass, mats.glass, { cast: true, receive: false });
  glass.renderOrder = 2;
  group.add(inner, glass);
  return { group };
}

// ── 7. Castaway camp props ───────────────────────────────────────────────
/** Volleyball with a red handprint face (the face looks toward local +Z). */
export function createVolleyball() {
  const tex = cached('volleyTex', () =>
    canvasTexture(512, 256, (g, w, h) => {
      g.fillStyle = '#ede6d6';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(120,112,98,0.8)';
      g.lineWidth = 3;
      for (let k = 0; k < 3; k++) {
        g.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const y = h * (0.28 + k * 0.22) + Math.sin((x / w) * PI * 4 + k) * h * 0.06;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
      // handprint face centered at u=0.25 (faces +Z)
      const cx = w * 0.25, cy = h * 0.52;
      g.fillStyle = 'rgba(168,46,34,0.82)';
      g.beginPath();
      g.ellipse(cx, cy + 8, 46, 30, 0, 0, PI * 2);
      g.fill();
      const fingers = [[-38, -44, 0.35], [-14, -58, 0.1], [12, -58, -0.1], [36, -46, -0.35]];
      for (const [dx, dy, a] of fingers) {
        g.beginPath();
        g.ellipse(cx + dx, cy + dy, 9, 24, a, 0, PI * 2);
        g.fill();
      }
      g.beginPath();
      g.ellipse(cx + 54, cy + 14, 9, 20, -1.0, 0, PI * 2);
      g.fill();
      // eyes, nose, smile painted on the palm in darker red
      g.fillStyle = '#5a130e';
      g.strokeStyle = '#5a130e';
      g.lineCap = 'round';
      g.beginPath();
      g.ellipse(cx - 16, cy - 2, 5, 7, 0, 0, PI * 2);
      g.ellipse(cx + 16, cy - 2, 5, 7, 0, 0, PI * 2);
      g.fill();
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(cx, cy + 2);
      g.lineTo(cx - 3, cy + 14);
      g.stroke();
      g.beginPath();
      g.arc(cx, cy + 12, 20, 0.25 * PI, 0.75 * PI);
      g.stroke();
    })
  );
  const mat = cached('volleyMat', () => new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : 0xede6d6, map: tex, roughness: 0.75 }));
  const m = mesh(cached('volleyGeo', () => new THREE.SphereGeometry(0.21, 24, 16)), mat);
  m.name = 'volleyball';
  return m;
}

/** A collapsed old lean-to: fallen poles + a heap of sun-dried fronds. Local, sits on y=0. */
export function createLeanToRuin() {
  const geo = cached('leanto', () => {
    const r = prng(202);
    const b = new Builder(202, 0.14);
    const POLE = 0x7a6448, FROND = [0x9c8f5a, 0x8a7d48, 0xb0a06a];
    b.cyl(-1.3, 0, 0, -1.25, 1.7, 0.1, 0.07, POLE, 6); // still-standing forked post
    b.cyl(-1.25, 1.55, 0.1, -1.5, 1.95, 0.1, 0.04, POLE, 5);
    b.cyl(-1.25, 1.55, 0.1, -1.0, 1.9, 0.12, 0.04, POLE, 5);
    b.cyl(1.4, 0.05, 0.3, 2.1, 0.2, 1.6, 0.07, POLE, 6); // fallen post
    b.cyl(-1.25, 1.6, 0.1, 1.6, 0.12, -0.4, 0.06, POLE, 6); // ridge pole slumped to the ground
    for (let i = 0; i < 6; i++) {
      const x = -1.0 + i * 0.5;
      b.cyl(x, 0.05, -1.4 + r() * 0.3, x + (r() - 0.5) * 0.6, 0.12 + r() * 0.5, 0.2 + r() * 0.5, 0.035, POLE, 5);
    }
    for (let i = 0; i < 16; i++) {
      const x = -1.2 + r() * 2.6, z = -1.2 + r() * 1.6;
      b.add(new THREE.OctahedronGeometry(1, 0), FROND[i % 3], M(x, 0.08 + r() * 0.25, z, (r() - 0.5) * 0.5, r() * PI, (r() - 0.5) * 0.4, 0.18, 0.05, 0.9 + r() * 0.5));
    }
    // old fire pit in front: ring of stones + charcoal
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * PI * 2;
      b.add(jittered(new THREE.IcosahedronGeometry(0.14, 0), 0.03, i), 0x8a847a, M(Math.cos(a) * 0.5, 0.07, 1.9 + Math.sin(a) * 0.5));
    }
    for (let i = 0; i < 5; i++) b.add(new THREE.BoxGeometry(0.28, 0.06, 0.07), 0x2a2420, M((r() - 0.5) * 0.4, 0.04, 1.9 + (r() - 0.5) * 0.4, 0, r() * PI, 0));
    // a post with a pinned note (the note itself is a separate mesh so it can be highlighted)
    b.cyl(0.9, 0, 1.0, 0.9, 1.25, 1.0, 0.05, POLE, 6);
    return b.build();
  });
  const group = new THREE.Group();
  group.add(mesh(geo, materials().vc));
  const note = mesh(
    cached('noteGeo', () => new THREE.PlaneGeometry(0.22, 0.28)),
    cached('noteMat', () => new THREE.MeshStandardMaterial({ color: 0xe9dcb8, roughness: 0.95, side: THREE.DoubleSide })),
    { cast: false }
  );
  note.position.set(0.9, 1.0, 1.06);
  note.rotation.z = 0.08;
  group.add(note);
  return { group, notePos: note.position.clone() };
}

/** Boulder with a flat face carrying tally marks + "43 days" (face toward local +Z). */
export function createTallyRock(glyphs = null) {
  const geo = cached('tallyRock', () => {
    const g = jittered(new THREE.IcosahedronGeometry(0.85, 1), 0.1, 43, (x, y, z) => [x, y, z > 0.5 ? 0.5 + (z - 0.5) * 0.08 : z]);
    const b = new Builder(43, 0.12);
    b.add(g, (x, y, z, out) => out.set(y > 0.45 ? 0x948e82 : 0x837d72), M(0, 0.5, 0, 0, 0, 0, 1.25, 0.85, 1));
    return b.build();
  });
  const group = new THREE.Group();
  group.add(mesh(geo, materials().vc));
  const tex = cached('tallyTex:' + (glyphs ? glyphs.join('') : ''), () =>
    canvasTexture(320, 240, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      const r = prng(43);
      g.lineCap = 'round';
      let n = 0;
      const mark = (x0, y0, x1, y1) => {
        g.strokeStyle = 'rgba(40,36,30,0.55)';
        g.lineWidth = 5;
        g.beginPath();
        g.moveTo(x0 + 1.5, y0 + 1.5);
        g.lineTo(x1 + 1.5, y1 + 1.5);
        g.stroke();
        g.strokeStyle = 'rgba(236,230,214,0.95)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
      };
      for (let row = 0; row < 3 && n < 43; row++) {
        for (let grp = 0; grp < 3 && n < 43; grp++) {
          const gx = 22 + grp * 98, gy = 18 + row * 48;
          const left = Math.min(5, 43 - n);
          for (let k = 0; k < Math.min(4, left); k++) {
            const x = gx + k * 15 + (r() - 0.5) * 3;
            mark(x, gy + (r() - 0.5) * 3, x + (r() - 0.5) * 4, gy + 36);
          }
          if (left === 5) mark(gx - 8, gy + 30, gx + 56, gy + 6);
          n += left;
        }
      }
      g.font = 'italic bold 34px Georgia, serif';
      g.fillStyle = 'rgba(40,36,30,0.55)';
      g.fillText('43 days', 92, 186);
      g.fillStyle = 'rgba(236,230,214,0.95)';
      g.fillText('43 days', 90, 184);
      // v4 clue: a row of four rune glyphs scratched under the tally (the same marks as the standing stones)
      if (glyphs) {
        g.lineCap = 'round';
        g.lineJoin = 'round';
        for (let k = 0; k < glyphs.length; k++) {
          const x = 76 + k * 48, y = 200;
          g.strokeStyle = 'rgba(40,36,30,0.6)';
          g.lineWidth = 5;
          drawGlyph(g, glyphs[k], x + 1.5, y + 1.5, 26, 32);
          g.strokeStyle = 'rgba(236,230,214,0.95)';
          g.lineWidth = 2.6;
          drawGlyph(g, glyphs[k], x, y, 26, 32);
        }
      }
    })
  );
  if (tex) {
    const decal = mesh(
      new THREE.PlaneGeometry(1.0, 0.75),
      new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.05, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false }),
      { cast: false }
    );
    decal.position.set(0, 0.5, 0.52);
    group.add(decal);
  }
  return { group };
}

// ── 7b. Weathered note on a post (v4: the logbook clue at the fishing hut door) ──
/**
 * createNoteSign(glyphs, lines) -> { group, paperPos (Vector3, local) }. A short driftwood post with a torn logbook
 * page nailed to it; the page faces local +Z. `lines` are short handwritten lines, `glyphs` the rune row.
 */
export function createNoteSign(glyphs = [], lines = ['…the four that', 'face the storm.', 'Light them while', 'the island sleeps.']) {
  const geo = cached('noteSignPost', () => {
    const b = new Builder(61, 0.1);
    b.cyl(0, 0, 0, 0.03, 1.15, -0.02, 0.045, 0x6b5238, 6, 0.035);
    b.add(new THREE.BoxGeometry(0.06, 0.05, 0.08), 0x4a3a2a, M(0.02, 0.9, 0.03)); // the nail head
    return b.build();
  });
  const group = new THREE.Group();
  group.add(mesh(geo, materials().vc));
  const tex = canvasTexture(256, 320, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const r = prng(19);
    // torn parchment
    g.fillStyle = 'rgba(224,210,172,0.97)';
    g.beginPath();
    g.moveTo(10, 8);
    for (let x = 10; x <= w - 10; x += 16) g.lineTo(x, 8 + (r() - 0.5) * 8);
    for (let y = 8; y <= h - 10; y += 16) g.lineTo(w - 10 + (r() - 0.5) * 6, y);
    for (let x = w - 10; x >= 10; x -= 16) g.lineTo(x, h - 10 + (r() - 0.5) * 10);
    for (let y = h - 10; y >= 8; y -= 16) g.lineTo(10 + (r() - 0.5) * 6, y);
    g.closePath();
    g.fill();
    // water stains
    for (let i = 0; i < 5; i++) {
      g.fillStyle = `rgba(120,96,60,${0.08 + r() * 0.1})`;
      g.beginPath();
      g.ellipse(30 + r() * (w - 60), 30 + r() * (h - 60), 18 + r() * 30, 12 + r() * 22, r() * 3, 0, PI * 2);
      g.fill();
    }
    // faint ruled lines + handwriting
    g.strokeStyle = 'rgba(90,70,50,0.18)';
    g.lineWidth = 1;
    for (let y = 44; y < h - 20; y += 30) {
      g.beginPath();
      g.moveTo(22, y);
      g.lineTo(w - 22, y);
      g.stroke();
    }
    g.fillStyle = 'rgba(38,30,52,0.88)';
    g.font = 'italic 24px Georgia, "Times New Roman", serif';
    g.textAlign = 'center';
    let y = 62;
    for (let i = 0; i < Math.min(2, lines.length); i++, y += 32) g.fillText(lines[i], w / 2 + (r() - 0.5) * 4, y);
    // the rune row
    g.strokeStyle = 'rgba(38,30,52,0.9)';
    g.lineWidth = 3.2;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const n = glyphs.length || 0, gw = 30, gap = 18;
    const x0 = (w - (n * gw + (n - 1) * gap)) / 2;
    for (let k = 0; k < n; k++) drawGlyph(g, glyphs[k], x0 + k * (gw + gap), y + 2, gw, 40);
    y += 70;
    for (let i = 2; i < lines.length; i++, y += 32) g.fillText(lines[i], w / 2 + (r() - 0.5) * 4, y);
    // nail hole
    g.fillStyle = 'rgba(40,30,20,0.9)';
    g.beginPath();
    g.arc(w / 2, 20, 4, 0, PI * 2);
    g.fill();
  });
  if (tex) {
    const paper = mesh(new THREE.PlaneGeometry(0.3, 0.375), new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.1, roughness: 0.95, side: THREE.DoubleSide }), { cast: false });
    paper.position.set(0.02, 0.73, 0.07);
    paper.rotation.set(0.05, 0, -0.08);
    group.add(paper);
  }
  return { group, paperPos: new THREE.Vector3(0.02, 0.75, 0.1) };
}

// ── 8. Standing stones (circle of 7) ─────────────────────────────────────
/**
 * Returns { group (local, centered), runeMats[7] (per stone: animate .color/.opacity), haloMats[7] (additive halo behind
 * each rune, mesh hidden while opacity 0: see group children userData.mat), glowMat (ground ring), beam + beamMat
 * (light pillar over the altar, hidden), stones: [{x,z,r,top}] }. runeMat = runeMats[0] (compat).
 * heightAt(x,z) world function + center are needed so each stone sits on the plateau.
 */
export function createStoneCircle(heightAt, cx, cz, R = 8.5) {
  const r = prng(7777);
  const sb = new Builder(77, 0.14);
  const stones = [];
  const runeGeos = [], haloGeos = [];
  const baseY = heightAt(cx, cz);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * PI * 2 + 0.2;
    const x = Math.cos(a) * R, z = Math.sin(a) * R;
    const y = heightAt(cx + x, cz + z) - baseY - 0.25;
    const hgt = 2.6 + r() * 1.1, wid = 0.95 + r() * 0.35;
    const faceY = Math.atan2(-x, -z); // local +Z faces the center
    const lean = (r() - 0.5) * 0.12;
    const g = jittered(new THREE.BoxGeometry(wid, hgt, 0.6, 2, 4, 1), 0.07, i * 3, (px, py, pz, ox, oy, oz) => {
      const t = (oy + hgt / 2) / hgt; // taper towards the top
      return [px * (1 - 0.22 * t), py, oz > 0 ? 0.29 + (pz - oz) * 0.15 : pz * (1 - 0.15 * t)];
    });
    const m = M(x, y + hgt / 2, z, lean, faceY, (r() - 0.5) * 0.1);
    sb.add(g, (px, py, pz, out) => out.set(h3(Math.round(px * 3), Math.round(py * 3), Math.round(pz * 3), i) > 0.78 ? 0x77805e : py > hgt * 0.8 ? 0x928c80 : 0x837d72), m);
    stones.push({ x: cx + x, z: cz + z, r: 0.6, top: baseY + y + hgt });
    // rune plane on the inner face (column i of the glyph atlas; its own material so each stone can light up)
    const pg = new THREE.PlaneGeometry(0.5, 1.5);
    const uv = pg.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / 7);
    pg.applyMatrix4(new THREE.Matrix4().multiplyMatrices(m, M(0, -hgt / 2 + 1.35, 0.33)));
    runeGeos.push(pg);
    const hg = new THREE.PlaneGeometry(2.4, 3.4);
    hg.applyMatrix4(new THREE.Matrix4().multiplyMatrices(m, M(0, -hgt / 2 + 1.45, 0.5)));
    haloGeos.push(hg);
  }
  // flat altar stone in the middle
  sb.add(jittered(new THREE.CylinderGeometry(1.1, 1.3, 0.45, 7), 0.05, 99), 0x7c766b, M(0, 0.05, 0));
  const group = new THREE.Group();
  group.add(mesh(sb.build(), materials().vc));
  // 7 distinct glyphs (eggRunes.js), one per column
  const runeTex = canvasTexture(7 * 64, 192, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.shadowColor = '#ffffff';
    g.shadowBlur = 9;
    for (let i = 0; i < 7; i++) drawGlyph(g, i, i * 64 + 11, 26, 42, 140);
  });
  const runeMats = [], haloMats = [];
  const halo = glowTexture();
  for (let i = 0; i < 7; i++) {
    const rm = new THREE.MeshBasicMaterial({ color: 0x4a4640, map: runeTex, transparent: true, opacity: runeTex ? 0.7 : 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, fog: true });
    const r = mesh(runeGeos[i], rm, { cast: false, receive: false });
    r.renderOrder = 3;
    group.add(r);
    runeMats.push(rm);
    const hm = new THREE.MeshBasicMaterial({ color: 0x8ffbe8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, map: halo, side: THREE.DoubleSide });
    const hmesh = mesh(haloGeos[i], hm, { cast: false, receive: false });
    hmesh.renderOrder = 4;
    hmesh.visible = false;
    hmesh.userData.mat = hm;
    group.add(hmesh);
    haloMats.push(hm);
  }
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x6ff0d8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, map: halo });
  const ring = mesh(new THREE.PlaneGeometry(7, 7), glowMat, { cast: false, receive: false });
  ring.rotation.x = -PI / 2;
  ring.position.y = 0.32;
  group.add(ring);
  // tall beam of light over the altar (the solve cinematic turns it on: scale.y + opacity)
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xa8fff0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const beam = mesh(new THREE.CylinderGeometry(0.35, 1.0, 1, 10, 1, true), beamMat, { cast: false, receive: false });
  beam.position.y = 0.5;
  beam.scale.y = 1;
  beam.visible = false;
  group.add(beam);
  return { group, runeMat: runeMats[0], runeMats, haloMats, glowMat, beam, beamMat, stones };
}

// ── 9. Rubber duck ───────────────────────────────────────────────────────
export function createRubberDuck() {
  const geo = cached('duck', () => {
    const b = new Builder(303, 0.04);
    const Y = 0xf6d13a;
    b.add(new THREE.SphereGeometry(0.2, 12, 9), Y, M(0, 0.1, 0.03, 0, 0, 0, 1.0, 0.72, 1.3));
    b.add(new THREE.SphereGeometry(0.125, 12, 9), Y, M(0, 0.3, -0.14));
    b.add(new THREE.SphereGeometry(0.06, 8, 6), 0xf08a24, M(0, 0.28, -0.26, 0, 0, 0, 1.2, 0.45, 1.1));
    for (const sx of [1, -1]) {
      b.add(new THREE.SphereGeometry(0.02, 6, 4), 0x111111, M(sx * 0.065, 0.34, -0.23));
      b.add(new THREE.SphereGeometry(0.008, 4, 3), 0xffffff, M(sx * 0.07, 0.35, -0.245));
      b.add(new THREE.SphereGeometry(0.07, 8, 6), 0xe8c22e, M(sx * 0.17, 0.12, 0.06, 0, 0, 0, 0.35, 0.6, 1.1)); // wings
    }
    b.add(new THREE.ConeGeometry(0.06, 0.14, 6), Y, M(0, 0.18, 0.27, -1.0, 0, 0));
    return b.build();
  });
  const m = mesh(geo, materials().vc);
  m.name = 'rubber-duck';
  return m;
}

// ── 10. Golden butterfly ─────────────────────────────────────────────────
/** Returns { group, left, right (wing pivots), glow (Sprite|null), mat }. Wingspan ~0.2 m. */
export function createGoldenButterfly() {
  const wingGeo = cached('bflyWing', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.bezierCurveTo(0.04, 0.05, 0.11, 0.09, 0.1, 0.02);
    s.bezierCurveTo(0.1, -0.01, 0.06, -0.02, 0.07, -0.05);
    s.bezierCurveTo(0.06, -0.09, 0.02, -0.07, 0, -0.02);
    s.lineTo(0, 0);
    const g = new THREE.ShapeGeometry(s, 6);
    g.rotateX(-PI / 2); // lie flat (XZ plane), extends toward +X
    return g;
  });
  const mat = cached('bflyMat', () => new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc93a).multiplyScalar(1.7), side: THREE.DoubleSide, transparent: true, opacity: 0.95, fog: true }));
  const group = new THREE.Group();
  const body = mesh(new THREE.CylinderGeometry(0.008, 0.006, 0.07, 5), new THREE.MeshBasicMaterial({ color: 0x5a3a10 }), { cast: false });
  body.rotation.x = PI / 2;
  const left = new THREE.Group(), right = new THREE.Group();
  const wl = mesh(wingGeo, mat, { cast: false });
  wl.scale.x = -1;
  left.add(wl);
  right.add(mesh(wingGeo, mat, { cast: false }));
  group.add(body, left, right);
  let glow = null;
  const gt = glowTexture();
  if (gt) {
    glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: gt, color: 0xffd25a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 }));
    glow.scale.setScalar(0.7);
    group.add(glow);
  }
  return { group, left, right, glow, mat };
}

// ── 11. First-person arm (waving / butterfly landing) ────────────────────
/** Arm pivoting at the shoulder (origin), extending along +Y. side = 1 right, -1 left. */
export function createArm(side = 1) {
  const geo = cached('arm' + side, () => {
    const b = new Builder(400 + side, 0.05);
    const SKIN = 0xd9a27a, SLEEVE = 0x4a6a8a;
    b.cyl(0, 0, 0, 0, 0.36, 0, 0.062, SLEEVE, 7, 0.055);
    b.add(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 7), 0x3d5a78, M(0, 0.36, 0)); // torn cuff
    b.cyl(0, 0.37, 0, 0, 0.66, 0, 0.045, SKIN, 7, 0.04);
    b.add(new THREE.BoxGeometry(0.085, 0.1, 0.032), SKIN, M(0, 0.72, 0));
    for (let i = 0; i < 4; i++) b.add(new THREE.BoxGeometry(0.017, 0.07, 0.02), SKIN, M(-0.03 + i * 0.02, 0.8, 0, 0, 0, (i - 1.5) * 0.06));
    b.add(new THREE.BoxGeometry(0.02, 0.06, 0.02), SKIN, M(side * -0.05, 0.71, 0.01, 0, 0, side * 0.8));
    return b.build();
  });
  const m = mesh(geo, materials().vc, { cast: false, receive: false });
  const pivot = new THREE.Group();
  pivot.add(m);
  return pivot;
}

// ── 12. Rope ladder (unit: 20 m long, hangs down from its origin) ────────
export function createRopeLadder(length = 20) {
  const geo = cached('ladder' + length, () => {
    const b = new Builder(500, 0.06);
    for (const sx of [1, -1]) b.cyl(sx * 0.22, 0, 0, sx * 0.22, -length, 0, 0.02, 0xc9b27a, 4);
    for (let y = -0.4; y > -length; y -= 0.38) b.add(new THREE.BoxGeometry(0.5, 0.04, 0.05), 0x8a6a44, M(0, y, 0));
    return b.build();
  });
  return mesh(geo, materials().vc, { cast: true, receive: false });
}

// ── 13. Fallback tree for the carved initials (only if flora has none there) ──
export function createOldTree() {
  const geo = cached('oldTree', () => {
    const b = new Builder(600, 0.12);
    b.cyl(0, -0.3, 0, 0, 4.6, 0, 0.4, 0x6b4f36, 9, 0.26);
    b.cyl(0, 3.2, 0, 1.4, 5.2, 0.3, 0.14, 0x6b4f36, 6, 0.08);
    b.cyl(0, 3.6, 0, -1.2, 5.4, -0.4, 0.13, 0x6b4f36, 6, 0.08);
    const LEAF = [0x4f8a35, 0x5b9a3c, 0x447a2e];
    [[0, 6.2, 0, 2.6], [1.5, 5.6, 0.4, 1.9], [-1.4, 5.8, -0.5, 2.0], [0.3, 5.3, -1.5, 1.7], [-0.2, 5.4, 1.5, 1.8]].forEach(([x, y, z, s], i) =>
      b.add(jittered(new THREE.IcosahedronGeometry(1, 1), 0.14, i), LEAF[i % 3], M(x, y, z, 0, i, 0, s, s * 0.75, s))
    );
    return b.build();
  });
  return { mesh: mesh(geo, materials().vc), trunkR: 0.36, height: 7 };
}
