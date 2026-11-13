// Tempest Isle procedural models (V3-B): the dock, the fisherman's motorboat, the fishing hut (+ its ruins),
// the fishing float and rockfall boulders. No asset files: boxes and cylinders merged per material into a
// few vertex-colored geometries (one draw call each). Coordinates are local to each group; see each builder.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HUT } from './isle2-logic.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();

/** Matrix from position, Euler 'YXZ' rotation (rx, ry, rz) and scale. Reused: consume it right away. */
function xf(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

/** Collects primitives (position + normal + per-face jittered color) and merges them into one geometry. */
export class Bag {
  constructor(rand = Math.random) {
    this.rand = rand;
    this.parts = [];
  }
  add(geo, m, color, jitter = 0.07) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    if (m) g.applyMatrix4(m);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    _c.set(color);
    for (let f = 0; f < n; f += 3) {
      const j = 1 + (this.rand() - 0.5) * 2 * jitter;
      for (let k = 0; k < 3 && f + k < n; k++) {
        const o = (f + k) * 3;
        col[o] = Math.min(1, _c.r * j);
        col[o + 1] = Math.min(1, _c.g * j);
        col[o + 2] = Math.min(1, _c.b * j);
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(g);
    return this;
  }
  /** Box of size (w, h, d) centered at (x, y, z). */
  box(w, h, d, x, y, z, color, rx = 0, ry = 0, rz = 0, jitter) {
    return this.add(new THREE.BoxGeometry(w, h, d), xf(x, y, z, rx, ry, rz), color, jitter);
  }
  /** Cylinder (radius top/bottom, height) centered at (x, y, z). */
  cyl(rt, rb, h, seg, x, y, z, color, rx = 0, ry = 0, rz = 0, jitter) {
    return this.add(new THREE.CylinderGeometry(rt, rb, h, seg), xf(x, y, z, rx, ry, rz), color, jitter);
  }
  /** Low-poly lumpy rock. */
  rock(r, x, y, z, color, sy = 0.7) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const k = 0.8 + 0.4 * this.rand();
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * sy, p.getZ(i) * k);
    }
    g.computeVertexNormals();
    return this.add(g, xf(x, y, z, 0, this.rand() * 6.28), color, 0.12);
  }
  get empty() {
    return this.parts.length === 0;
  }
  build() {
    if (!this.parts.length) return new THREE.BufferGeometry();
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const C = {
  wood: 0x8a6c4f,
  woodGrey: 0x7d7468, // sun-bleached, weathered
  woodDark: 0x4e3c2c,
  woodWet: 0x5a4636,
  post: 0x4a3a2c,
  rope: 0xb59c6a,
  stone: 0x7c776f,
  stoneDark: 0x5a554e,
  iron: 0x3a3c40,
  brass: 0xc9a245,
  cloth: 0x6f7f8c,
  blanket: 0x8c3b2f,
  white: 0xe9e6dc,
  hullBlue: 0x2e5e86,
  red: 0xb8392b,
  char: 0x262220,
  charLight: 0x3b3029,
  ash: 0x55514c,
};
export { C as COLORS };

// ── Dock ──────────────────────────────────────────────────────────────────
/**
 * The pier, in dock-local coordinates: +X = seaward along the dock (t), Z = sideways, Y = world height (sea level 0).
 * deckAt(t) gives the deck top height. Returns { wood: geometry, rope: geometry, bollards: [{t, z}] }.
 */
export function buildDock(rand, { length = 18, start = 0.6, halfW = 1.1, deckY = 0.95, seabed = (t) => -2 } = {}) {
  const b = new Bag(rand);
  const r = new Bag(rand);
  // deck planks across the pier
  const pw = 0.27, gap = 0.035;
  for (let t = start; t < length; t += pw + gap) {
    const tone = rand() < 0.15 ? C.woodGrey : rand() < 0.3 ? C.woodWet : C.wood;
    const l = halfW * 2 * (0.97 + rand() * 0.06);
    b.box(pw, 0.07, l, t + pw / 2, deckY - 0.035, (rand() - 0.5) * 0.06, tone, 0, (rand() - 0.5) * 0.03, (rand() - 0.5) * 0.02);
  }
  // stringers under the deck
  for (const z of [-halfW + 0.15, 0, halfW - 0.15]) b.box(length - start, 0.16, 0.12, (start + length) / 2, deckY - 0.15, z, C.post);
  // posts in pairs, down into the seabed
  for (let t = start + 1.2; t <= length + 0.01; t += 2.4) {
    const tt = Math.min(t, length - 0.15);
    const bed = seabed(tt) - 0.6;
    const h = deckY + 0.25 - bed;
    for (const z of [-halfW - 0.05, halfW + 0.05]) b.cyl(0.11, 0.13, h, 7, tt, bed + h / 2, z, C.post, (rand() - 0.5) * 0.04, 0, (rand() - 0.5) * 0.04);
  }
  // end posts stick up as bollards, with a rope coil next to them
  const bollards = [
    { t: length - 0.25, z: -halfW + 0.12 },
    { t: length - 0.25, z: halfW - 0.12 },
    { t: length - 6.2, z: halfW - 0.12 },
  ];
  for (const bl of bollards) {
    b.cyl(0.12, 0.13, 0.55, 8, bl.t, deckY + 0.27, bl.z, C.post);
    b.cyl(0.15, 0.15, 0.06, 8, bl.t, deckY + 0.56, bl.z, C.woodDark);
  }
  // a coiled rope on the deck
  for (let k = 0; k < 4; k++) {
    const t = new THREE.TorusGeometry(0.24 - k * 0.035, 0.028, 4, 14);
    r.add(t, xf(length - 2.4, deckY + 0.03 + k * 0.035, -0.45, Math.PI / 2, 0, 0), C.rope, 0.05);
  }
  // a crate and a bucket near the end
  b.box(0.55, 0.45, 0.5, length - 3.6, deckY + 0.225, 0.58, C.woodGrey, 0, 0.3);
  b.cyl(0.17, 0.14, 0.32, 9, length - 3.1, deckY + 0.16, 0.2, C.iron);
  // a ladder down into the water at the end
  for (const z of [-0.28, 0.28]) b.box(0.07, 2.2, 0.07, length + 0.05, deckY - 0.9, z, C.post);
  for (let k = 0; k < 4; k++) b.box(0.06, 0.05, 0.56, length + 0.05, deckY - 0.25 - k * 0.42, 0, C.wood);
  return { wood: b.build(), rope: r.build(), bollards };
}

// ── Motorboat ─────────────────────────────────────────────────────────────
/**
 * The fisherman's motorboat, bow along local -Z (so object.rotation.y = heading), waterline at y = 0.
 * Returns { hull, trim, glass } geometries and a few anchor points (cleats, seat).
 */
export function buildMotorboat(rand) {
  const L = 4.6, B = 1.8, Dp = 0.8, draft = 0.32;
  // hull shell: sections from stern (s=0, z=+L/2) to bow (s=1, z=-L/2)
  const N = 14, M = 8;
  const pos = [];
  const idx = [];
  const colors = [];
  const ring = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const z = L / 2 - s * L;
    const bow = Math.pow(Math.sin(Math.min(1, (1 - s) / 0.42) * Math.PI / 2), 0.8);
    const w = Math.max(0.02, (B / 2) * (0.82 + 0.18 * Math.sin(Math.min(1, s / 0.3) * Math.PI / 2)) * bow);
    const sheer = Dp - draft + 0.22 * Math.max(0, s - 0.55) ** 2 * 4;
    const keel = -draft + 0.45 * Math.max(0, s - 0.7) ** 2 * 6;
    const row = [];
    for (let j = 0; j <= M; j++) {
      const a = -1 + (2 * j) / M; // -1 (port gunwale) .. 1 (starboard gunwale)
      const k = Math.abs(a);
      const x = a * w * (0.55 + 0.45 * Math.sqrt(k));
      const y = keel + (sheer - keel) * Math.pow(k, 1.6);
      row.push(pos.length / 3);
      pos.push(x, y, z);
      const stripe = y > sheer - 0.14 ? C.hullBlue : y < 0.02 ? 0x8a3328 : C.white;
      _c.set(stripe);
      const jj = 0.95 + rand() * 0.08;
      colors.push(_c.r * jj, _c.g * jj, _c.b * jj);
    }
    ring.push(row);
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const a = ring[i][j], b = ring[i + 1][j], c = ring[i + 1][j + 1], d = ring[i][j + 1];
      idx.push(a, b, c, a, c, d);
    }
  }
  // transom (flat stern) fan
  const tc = pos.length / 3;
  pos.push(0, (Dp - draft - 0.1) * 0.5, L / 2);
  _c.set(C.white);
  colors.push(_c.r, _c.g, _c.b);
  for (let j = 0; j < M; j++) idx.push(tc, ring[0][j + 1], ring[0][j]);
  const hg = new THREE.BufferGeometry();
  hg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  hg.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  hg.setIndex(idx);
  const hull = hg.toNonIndexed();
  hg.dispose();
  hull.computeVertexNormals();

  const t = new Bag(rand);
  const top = Dp - draft;
  // deck/floor boards, gunwale rails, seats
  t.box(B * 0.72, 0.05, L * 0.78, 0, -draft + 0.24, 0.1, C.woodGrey);
  for (const sx of [-1, 1]) t.box(0.07, 0.07, L * 0.86, sx * B * 0.45, top + 0.02, 0.15, C.woodDark, 0, 0, 0);
  t.box(B * 0.8, 0.07, 0.38, 0, top - 0.32, 1.45, C.woodGrey); // stern bench
  t.box(B * 0.76, 0.07, 0.34, 0, top - 0.32, -0.95, C.woodGrey); // bow bench
  // console with wheel + throttle
  t.box(0.55, 0.62, 0.42, 0.35, -draft + 0.55, 0.05, C.white);
  t.box(0.57, 0.05, 0.44, 0.35, -draft + 0.88, 0.05, C.hullBlue);
  t.add(new THREE.TorusGeometry(0.15, 0.022, 4, 12), xf(0.35, -draft + 0.98, 0.22, -0.9, 0, 0), C.iron, 0.04);
  t.cyl(0.02, 0.02, 0.18, 5, 0.6, -draft + 0.95, 0.2, C.iron, 0.5, 0, 0);
  // outboard motor on the transom
  t.box(0.36, 0.42, 0.44, 0, top + 0.12, L / 2 + 0.12, 0x2b2d31);
  t.box(0.3, 0.08, 0.38, 0, top + 0.36, L / 2 + 0.13, C.red);
  t.box(0.12, 0.85, 0.16, 0, top - 0.42, L / 2 + 0.2, 0x1f2124);
  t.box(0.18, 0.12, 0.26, 0, top - 0.86, L / 2 + 0.2, 0x1f2124);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    t.box(0.04, 0.22, 0.06, Math.cos(a) * 0.1, top - 0.86 + Math.sin(a) * 0.1, L / 2 + 0.36, 0x9a9da3, 0, 0, a);
  }
  // cleats (bow + stern) and fenders
  t.box(0.16, 0.05, 0.05, 0, top + 0.1, -L / 2 + 0.25, C.iron);
  t.box(0.16, 0.05, 0.05, -B * 0.38, top + 0.06, L / 2 - 0.25, C.iron);
  for (const z of [-0.6, 0.7]) t.cyl(0.08, 0.08, 0.36, 8, -(B * 0.5 + 0.03), top - 0.22, z, C.white); // fenders on the port (dock) side
  // windscreen frame
  t.box(0.04, 0.32, 0.04, 0.08, -draft + 1.05, -0.17, C.iron);
  t.box(0.04, 0.32, 0.04, 0.62, -draft + 1.05, -0.17, C.iron);
  const trim = t.build();

  const g = new Bag(rand);
  g.box(0.58, 0.32, 0.02, 0.35, -draft + 1.06, -0.16, 0xbfd6e2, -0.35, 0, 0, 0);
  const glass = g.build();
  return {
    hull,
    trim,
    glass,
    length: L,
    beam: B,
    cleatBow: new THREE.Vector3(0, top + 0.12, -L / 2 + 0.25),
    cleatStern: new THREE.Vector3(-B * 0.38, top + 0.08, L / 2 - 0.25),
  };
}

// ── Fishing hut ───────────────────────────────────────────────────────────
// Hut-local coordinates: x = u (toward the door), y = up from the floor top, z = -v (so the group's
// rotation.y = atan2(-fz, fx) maps local +X to the door direction f).
const P = (u, y, v) => [u, y, -v];

/** Horizontal wall boards along one wall, skipping openings [{a0, a1, y0, y1}] (a = position along the wall). */
function boardWall(bag, rand, { a0, a1, fixed, alongU, openings = [], H = HUT.wallH, t = HUT.wallT, color = C.woodGrey }) {
  const bh = 0.23;
  for (let y = 0; y < H - 0.01; y += bh) {
    const yc = y + bh / 2;
    // cut list
    let segs = [[a0, a1]];
    for (const o of openings) {
      if (yc < o.y0 || yc > o.y1) continue;
      const next = [];
      for (const [s0, s1] of segs) {
        if (o.a1 <= s0 || o.a0 >= s1) next.push([s0, s1]);
        else {
          if (o.a0 > s0) next.push([s0, o.a0]);
          if (o.a1 < s1) next.push([o.a1, s1]);
        }
      }
      segs = next;
    }
    for (const [s0, s1] of segs) {
      const len = s1 - s0;
      if (len < 0.05) continue;
      const mid = (s0 + s1) / 2;
      const tone = rand() < 0.2 ? C.wood : rand() < 0.25 ? C.woodDark : color;
      const [x, yy, z] = alongU ? P(mid, yc, fixed) : P(fixed, yc, mid);
      const off = (rand() - 0.5) * 0.02;
      if (alongU) bag.box(len, bh - 0.02, t, x, yy, z + off, tone, 0, 0, (rand() - 0.5) * 0.01);
      else bag.box(t, bh - 0.02, len, x + off, yy, z, tone, (rand() - 0.5) * 0.01);
    }
  }
}

/**
 * The fishing hut. Returns geometries { shell, roof, stone, glass, lanternGlow, props: {rods, key, jerrycan, compass, logbook,
 * firewood}, ruins, ash } and hut-local anchor points (u, y, v) used by isle2-hut.js.
 */
export function buildHut(rand) {
  const D2 = HUT.D / 2, W2 = HUT.W / 2, T = HUT.wallT;
  const shell = new Bag(rand);
  const stone = new Bag(rand);
  const roof = new Bag(rand);
  const { door, window: win } = HUT;
  // floor + foundation stones
  shell.box(HUT.D - 0.05, 0.1, HUT.W - 0.05, 0, -0.05, 0, C.woodDark);
  for (const su of [-1, 1]) for (const sv of [-1, 0, 1]) stone.rock(0.32, su * (D2 - 0.1), -0.15, -sv * (W2 - 0.1), C.stoneDark, 0.6);
  // walls
  const fu = D2 - T / 2, sv = W2 - T / 2;
  boardWall(shell, rand, { a0: -W2, a1: W2, fixed: fu, alongU: false, openings: [{ a0: door.v0, a1: door.v1, y0: -1, y1: door.h }, { a0: win.v0, a1: win.v1, y0: win.y0, y1: win.y1 }] });
  boardWall(shell, rand, { a0: -W2, a1: W2, fixed: -fu, alongU: false });
  boardWall(shell, rand, { a0: -D2 + T, a1: D2 - T, fixed: sv, alongU: true, openings: [{ a0: -0.4, a1: 0.4, y0: 1.1, y1: 1.62 }] });
  boardWall(shell, rand, { a0: -D2 + T, a1: D2 - T, fixed: -sv, alongU: true });
  // gables on the side walls (the ridge runs along v)
  const rise = HUT.ridgeH - HUT.wallH;
  for (const side of [-1, 1]) {
    for (let y = HUT.wallH; y < HUT.ridgeH - 0.05; y += 0.23) {
      const k = 1 - (y + 0.115 - HUT.wallH) / rise;
      const len = Math.max(0.1, (HUT.D - 2 * T) * k);
      const [x, yy, z] = P(0, y + 0.115, side * sv);
      shell.box(len, 0.21, T, x, yy, z, rand() < 0.3 ? C.wood : C.woodGrey);
    }
  }
  // corner posts, door frame, window frame + shutters
  for (const su of [-1, 1]) for (const s of [-1, 1]) {
    const [x, y, z] = P(su * (D2 - 0.05), 1.2, s * (W2 - 0.05));
    shell.box(0.2, 2.42, 0.2, x, y, z, C.post);
  }
  for (const v of [door.v0 - 0.06, door.v1 + 0.06]) {
    const [x, y, z] = P(fu, door.h / 2, v);
    shell.box(0.22, door.h + 0.05, 0.12, x, y, z, C.post);
  }
  {
    const [x, y, z] = P(fu, door.h + 0.06, (door.v0 + door.v1) / 2);
    shell.box(0.22, 0.12, door.v1 - door.v0 + 0.3, x, y, z, C.post);
    // the door leaf, swung open inward against the front wall
    const [dx, dy, dz] = P(fu - 0.14, door.h / 2 - 0.02, door.v0 - 0.44);
    shell.box(0.05, door.h - 0.08, 0.86, dx, dy, dz, C.woodDark, 0, 0.06);
  }
  {
    const vm = (win.v0 + win.v1) / 2, wl = win.v1 - win.v0;
    let [x, y, z] = P(fu + 0.04, win.y0 - 0.04, vm);
    shell.box(0.24, 0.07, wl + 0.2, x, y, z, C.post);
    [x, y, z] = P(fu + 0.04, win.y1 + 0.04, vm);
    shell.box(0.24, 0.07, wl + 0.2, x, y, z, C.post);
    for (const s of [-1, 1]) {
      [x, y, z] = P(fu + 0.1, (win.y0 + win.y1) / 2, vm + s * (wl / 2 + 0.28));
      shell.box(0.04, win.y1 - win.y0 + 0.1, 0.4, x, y, z, C.woodDark, 0, s * 0.25);
    }
  }
  // porch
  for (let k = 0; k < 6; k++) {
    const [x, y, z] = P(D2 + 0.12 + k * 0.17, 0.02, -0.9);
    shell.box(0.15, 0.06, 2.6, x, y, z, k % 2 ? C.woodGrey : C.wood);
  }
  // roof: planks down both slopes, ridge beam, rafters
  const over = 0.38, slope = Math.atan2(rise, D2);
  const runU = D2 + over, len = runU / Math.cos(slope);
  for (const su of [-1, 1]) {
    for (let v = -W2 - 0.3; v < W2 + 0.3; v += 0.31) {
      const tone = rand() < 0.25 ? C.woodDark : rand() < 0.3 ? C.wood : C.woodGrey;
      const um = (su * runU) / 2;
      const ym = HUT.ridgeH - (runU / 2) * Math.tan(slope) + 0.1;
      const [x, y, z] = P(um, ym, v + 0.15);
      roof.box(len, 0.06, 0.29, x, y + (rand() - 0.5) * 0.02, z, tone, 0, 0, -su * slope + (rand() - 0.5) * 0.015);
    }
  }
  {
    const [x, y, z] = P(0, HUT.ridgeH + 0.14, 0);
    roof.box(0.2, 0.16, HUT.W + 0.7, x, y, z, C.post);
  }
  // ── interior ──
  // bunk along the back wall
  const bunk = { u: -1.39, v: 1.37, y: 0.52 };
  {
    const u0 = -1.84, u1 = -0.94, v0 = 0.4, v1 = 2.34;
    for (const u of [u0 + 0.06, u1 - 0.06]) for (const v of [v0 + 0.06, v1 - 0.06]) {
      const [x, y, z] = P(u, 0.26, v);
      shell.box(0.08, 0.52, 0.08, x, y, z, C.post);
    }
    let [x, y, z] = P((u0 + u1) / 2, 0.42, (v0 + v1) / 2);
    shell.box(u1 - u0, 0.1, v1 - v0, x, y, z, C.wood);
    [x, y, z] = P((u0 + u1) / 2, 0.53, (v0 + v1) / 2);
    shell.box(u1 - u0 - 0.06, 0.12, v1 - v0 - 0.06, x, y, z, C.cloth);
    [x, y, z] = P((u0 + u1) / 2 + 0.02, 0.61, (v0 + v1) / 2 - 0.25);
    shell.box(u1 - u0 - 0.02, 0.06, 1.25, x, y, z, C.blanket, 0, 0, 0.03);
    [x, y, z] = P((u0 + u1) / 2, 0.64, v1 - 0.28);
    shell.box(0.52, 0.12, 0.32, x, y, z, C.white);
  }
  // table + stool + logbook + lantern
  const table = { u: 0.25, v: 1.55, y: 0.8 };
  {
    let [x, y, z] = P(table.u, 0.78, table.v);
    shell.box(1.0, 0.06, 0.75, x, y, z, C.wood);
    for (const su of [-1, 1]) for (const s of [-1, 1]) {
      [x, y, z] = P(table.u + su * 0.43, 0.38, table.v + s * 0.31);
      shell.box(0.06, 0.76, 0.06, x, y, z, C.post);
    }
    [x, y, z] = P(table.u - 0.1, 0.25, table.v - 0.75);
    shell.cyl(0.19, 0.17, 0.5, 8, x, y, z, C.woodDark);
  }
  const lantern = { u: 0.6, v: 1.78, y: 0.81 };
  {
    let [x, y, z] = P(lantern.u, lantern.y + 0.03, lantern.v);
    shell.cyl(0.09, 0.1, 0.06, 8, x, y, z, C.iron);
    [x, y, z] = P(lantern.u, lantern.y + 0.32, lantern.v);
    shell.cyl(0.07, 0.09, 0.06, 8, x, y, z, C.iron);
    shell.add(new THREE.TorusGeometry(0.06, 0.01, 4, 10), xf(x, y + 0.08, z, 0, 0, 0), C.iron, 0.02);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      shell.box(0.012, 0.26, 0.012, x + Math.cos(a) * 0.075, lantern.y + 0.18, z + Math.sin(a) * 0.075, C.iron);
    }
  }
  const lg = new Bag(rand);
  {
    const [x, y, z] = P(lantern.u, lantern.y + 0.17, lantern.v);
    lg.cyl(0.055, 0.065, 0.24, 8, x, y, z, 0xffffff, 0, 0, 0, 0);
  }
  // shelves on the side wall by the front
  const shelves = { u: 1.35, v: 2.1, y: 1.0 };
  {
    const u0 = 0.9, u1 = 1.82, vb = 2.34, d = 0.36;
    for (const u of [u0, u1]) {
      const [x, y, z] = P(u, 0.95, vb - d / 2);
      shell.box(0.05, 1.9, d, x, y, z, C.woodDark);
    }
    for (const y0 of [0.3, 0.75, 1.2, 1.65]) {
      const [x, y, z] = P((u0 + u1) / 2, y0, vb - d / 2);
      shell.box(u1 - u0, 0.04, d, x, y, z, C.wood);
    }
    // jars and tins (decor)
    for (let k = 0; k < 5; k++) {
      const [x, y, z] = P(u0 + 0.12 + k * 0.17, k < 3 ? 0.84 : 1.74, vb - 0.17);
      shell.cyl(0.05, 0.05, 0.16 + (k % 2) * 0.05, 7, x, y + 0.02, z, k % 2 ? 0x7d8a5a : 0x9a6a3a);
    }
  }
  // rod rack on the back wall
  const rack = { u: -1.75, v: -0.5, y: 1.1 };
  {
    const [x, y, z] = P(-1.84, 1.6, -0.5);
    shell.box(0.06, 0.1, 0.95, x, y, z, C.woodDark);
    const [x2, y2, z2] = P(-1.84, 0.3, -0.5);
    shell.box(0.06, 0.1, 0.95, x2, y2, z2, C.woodDark);
  }
  const rods = new Bag(rand);
  for (const dv of [-0.22, 0.2]) {
    const [x, y, z] = P(-1.72, 1.12, -0.5 + dv);
    rods.cyl(0.012, 0.025, 2.1, 5, x, y, z, 0x6a4a2a, 0, 0, 0.12);
    rods.cyl(0.05, 0.05, 0.07, 8, x + 0.07, 0.62, z, 0x9a9da3, Math.PI / 2, 0, 0);
  }
  // key hook by the door (front wall, right of the door, inside)
  const hook = { u: 1.8, v: 0.1, y: 1.45 };
  {
    const [x, y, z] = P(1.82, 1.5, 0.1);
    shell.box(0.03, 0.14, 0.3, x, y, z, C.woodDark);
  }
  const key = new Bag(rand);
  {
    const [x, y, z] = P(1.79, 1.38, 0.1);
    key.cyl(0.03, 0.03, 0.015, 8, x, y + 0.04, z, C.brass, 0, 0, Math.PI / 2);
    key.box(0.012, 0.09, 0.016, x, y - 0.02, z, C.brass);
    key.box(0.04, 0.07, 0.04, x, y - 0.11, z, 0xe8792a); // cork float keyring
  }
  const jer = new Bag(rand);
  {
    const [x, y, z] = P(1.4, 0.0, 1.88);
    jer.box(0.34, 0.44, 0.17, x, y + 0.22, z, C.red, 0, 0.5);
    jer.box(0.06, 0.07, 0.06, x + 0.1, y + 0.47, z, 0x222222, 0, 0.5);
    jer.box(0.16, 0.04, 0.04, x - 0.05, y + 0.46, z, C.red, 0, 0.5);
  }
  const comp = new Bag(rand);
  {
    const [x, y, z] = P(1.2, 1.22, 2.16);
    comp.cyl(0.075, 0.075, 0.04, 12, x, y + 0.02, z, C.brass);
    comp.cyl(0.06, 0.06, 0.005, 12, x, y + 0.042, z, 0xf2ead2);
  }
  const book = new Bag(rand);
  {
    const [x, y, z] = P(table.u + 0.05, 0.82, table.v - 0.1);
    book.box(0.3, 0.025, 0.4, x, y, z, 0x5a2e1e, 0, 0.3);
    book.box(0.28, 0.012, 0.38, x, y + 0.018, z, 0xece2c6, 0, 0.3);
  }
  // stone hearth in the back corner, against the side wall (v = -W/2), chimney up through the roof
  const hearth = { u: -1.2, v: -1.92, y: 0.42 };
  {
    const vb = -W2 + T / 2 + 0.01;
    let [x, y, z] = P(-1.2, 0.2, -1.97);
    stone.box(0.95, 0.4, 0.74, x, y, z, C.stone, 0, 0, 0, 0.14);
    [x, y, z] = P(-1.2, 0.8, vb + 0.1);
    stone.box(0.95, 0.85, 0.2, x, y, z, C.stoneDark, 0, 0, 0, 0.14);
    for (const du of [-0.42, 0.42]) {
      [x, y, z] = P(-1.2 + du, 0.72, -1.95);
      stone.box(0.13, 0.68, 0.6, x, y, z, C.stone, 0, 0, 0, 0.14);
    }
    [x, y, z] = P(-1.2, 1.15, -1.95);
    shell.box(1.1, 0.1, 0.66, x, y, z, C.post);
    [x, y, z] = P(-1.2, 2.75, -2.05);
    stone.box(0.62, 3.1, 0.5, x, y, z, C.stone, 0, 0, 0, 0.14);
    [x, y, z] = P(-1.2, 4.35, -2.05);
    stone.box(0.7, 0.12, 0.58, x, y, z, C.stoneDark);
  }
  // firewood stacked by the hearth inside, and a woodpile outside (decor)
  const firewood = { u: -0.3, v: -2.1, y: 0.2 };
  const fw = new Bag(rand);
  for (let k = 0; k < 7; k++) {
    const row = k < 4 ? 0 : 1;
    const [x, y, z] = P(-0.3 + (row ? (k - 5) * 0.11 + 0.05 : (k - 1.5) * 0.11), 0.06 + row * 0.1, -2.1);
    fw.cyl(0.05, 0.05, 0.5, 6, x, y, z, k % 2 ? 0x8a6a48 : 0x6e5238, Math.PI / 2, 0, 0);
  }
  for (let k = 0; k < 14; k++) {
    const row = Math.floor(k / 5);
    const [x, y, z] = P(-1.2 + (k % 5) * 0.2 + row * 0.1, 0.1 + row * 0.18, -W2 - 0.35);
    shell.cyl(0.09, 0.09, 0.62, 6, x, y, z, k % 3 ? 0x8a6a48 : 0x6e5238, 0, 0, Math.PI / 2);
  }
  // rug
  {
    const [x, y, z] = P(0.6, 0.012, -0.6);
    shell.box(1.4, 0.015, 1.0, x, y, z, 0x7a5a3a, 0, 0.1);
  }
  // window glass (front + side)
  const glass = new Bag(rand);
  {
    const vm = (win.v0 + win.v1) / 2;
    let [x, y, z] = P(fu, (win.y0 + win.y1) / 2, vm);
    glass.box(0.02, win.y1 - win.y0, win.v1 - win.v0, x, y, z, 0xffffff, 0, 0, 0, 0);
    [x, y, z] = P(0, 1.36, sv);
    glass.box(0.8, 0.52, 0.02, x, y, z, 0xffffff, 0, 0, 0, 0);
  }

  // ── ruins (shown after the fire) ──
  const ruins = new Bag(rand);
  for (const su of [-1, 1]) for (const s of [-1, 1]) {
    const h = 0.6 + rand() * 1.3;
    const [x, y, z] = P(su * (D2 - 0.05), h / 2, s * (W2 - 0.05));
    ruins.box(0.2, h, 0.2, x, y, z, C.char, (rand() - 0.5) * 0.25, 0, (rand() - 0.5) * 0.25);
  }
  for (let k = 0; k < 16; k++) {
    const u = (rand() - 0.5) * HUT.D * 1.1, v = (rand() - 0.5) * HUT.W * 1.1;
    const [x, y, z] = P(u, 0.08 + rand() * 0.25, v);
    ruins.box(0.6 + rand() * 1.8, 0.1, 0.18, x, y, z, rand() < 0.3 ? C.charLight : C.char, (rand() - 0.5) * 0.4, rand() * 3.14, (rand() - 0.5) * 0.3);
  }
  for (const side of [-1, 1]) {
    // a collapsed roof slab leaning on the rubble
    const [x, y, z] = P(side * 0.9, 0.55, side * 0.4);
    ruins.box(2.2, 0.08, 2.6, x, y, z, C.char, 0, 0.2 * side, side * 0.45);
  }
  // the bunk frame and table, charred
  {
    const [x, y, z] = P(bunk.u, 0.25, bunk.v);
    ruins.box(0.85, 0.12, 1.8, x, y, z, C.char, 0.08, 0, 0.1);
    const [x2, y2, z2] = P(table.u, 0.3, table.v);
    ruins.box(0.9, 0.06, 0.6, x2, y2, z2, C.charLight, 0.4, 0.3, 0.2);
  }
  const ash = new Bag(rand);
  ash.cyl(HUT.W * 0.62, HUT.W * 0.66, 0.04, 14, 0, 0.0, 0, C.ash, 0, 0, 0, 0.1);

  return {
    shell: shell.build(),
    roof: roof.build(),
    stone: stone.build(),
    glass: glass.build(),
    lanternGlow: lg.build(),
    props: { rods: rods.build(), key: key.build(), jerrycan: jer.build(), compass: comp.build(), logbook: book.build(), firewood: fw.build() },
    ruins: ruins.build(),
    ash: ash.build(),
    anchors: { bunk, table, lantern, shelves, rack, hook, hearth, firewood, door: { u: D2 + 0.25, y: 1.0, v: (door.v0 + door.v1) / 2 } },
  };
}

// ── Small things ──────────────────────────────────────────────────────────
/** The fishing float (red top, white bottom), ~12 cm. */
export function buildFloat(rand) {
  const b = new Bag(rand);
  b.add(new THREE.SphereGeometry(0.06, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), null, C.red, 0.02);
  b.add(new THREE.SphereGeometry(0.06, 8, 4, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), null, C.white, 0.02);
  b.cyl(0.006, 0.006, 0.12, 4, 0, 0.1, 0, 0x222222);
  return b.build();
}

/** A rockfall boulder (unit radius; scale per instance). */
export function buildBoulder(rand) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 0.82 + 0.3 * Math.abs(Math.sin(v.x * 3.1 + v.y * 1.7) * Math.cos(v.z * 2.3 - v.x));
    p.setXYZ(i, v.x * n, v.y * n * 0.85, v.z * n);
  }
  const b = new Bag(rand);
  b.add(g, null, C.stone, 0.16);
  const out = b.build();
  out.computeVertexNormals();
  return out;
}
