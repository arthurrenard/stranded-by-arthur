// Procedural models for the boat-repair goal (Builder V2-B): part pickups, the buried mound, the cracked
// boulder, the Boatyard props + signpost, the staged boat for each plan, the launch wake and dig puffs.
// Nothing here runs at import time (node imports this file in scripts/check.mjs).
import * as THREE from 'three';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

// ── shared geometries / materials ─────────────────────────────────────────
const G = {};
const geo = (key, make) => G[key] || (G[key] = make());
const box = () => geo('box', () => new THREE.BoxGeometry(1, 1, 1));
const cyl = () => geo('cyl', () => new THREE.CylinderGeometry(1, 1, 1, 8));
const cone = () => geo('cone', () => new THREE.ConeGeometry(1, 1, 8));
const torus = () => geo('torus', () => new THREE.TorusGeometry(1, 0.22, 5, 12));

let MATS = null;
export function createRaftMaterials() {
  if (MATS) return MATS;
  const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0, flatShading: true, ...o });
  const dot = makeDotTexture();
  const sprite = (color) =>
    new THREE.SpriteMaterial({ map: dot, color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.8 });
  MATS = {
    wood: std(0x8a6a48),
    woodDark: std(0x5e4630),
    drift: std(0xb9a58a),
    plank: std(0x9b7652),
    hullWood: std(0x8f6c49, { side: THREE.DoubleSide }),
    hullPaint: std(0xdfe4e2, { side: THREE.DoubleSide, roughness: 0.75 }),
    trim: std(0x2f5d7a),
    bamboo: std(0xc8b56a),
    rope: std(0xcdb88a),
    cloth: std(0xece3cf, { side: THREE.DoubleSide }),
    metal: std(0x4a4d52, { metalness: 0.5, roughness: 0.55 }),
    cover: std(0xd8d8d2, { roughness: 0.6 }),
    brass: std(0xc9a34a, { metalness: 0.7, roughness: 0.4 }),
    glass: std(0xcfe8ee, { roughness: 0.2 }),
    red: std(0xb8332a, { roughness: 0.7 }),
    black: std(0x232323, { roughness: 0.8 }),
    sand: std(0xbfa77d),
    stone: std(0x8a847a),
    stoneDark: std(0x5d5750),
    crack: new THREE.MeshBasicMaterial({ color: 0x1d1916 }),
    wake: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }),
    puff: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }),
    glintRock: sprite(0xfff0b8),
    glintSea: sprite(0x9ff4ff),
    glow: new Set(), // emissive clones used by sunken parts (pulsed by raft.js)
  };
  return MATS;
}

function makeDotTexture(n = 32) {
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5, dy = (y + 0.5) / n - 0.5;
      const r = Math.min(1, Math.hypot(dx, dy) * 2);
      const k = (y * n + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255;
      data[k + 3] = Math.round(255 * Math.pow(1 - r, 2.2));
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

// ── mesh helpers ──────────────────────────────────────────────────────────
function put(parent, g, m, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.scale.set(sx, sy, sz);
  o.rotation.set(rx, ry, rz);
  o.castShadow = true;
  o.receiveShadow = true;
  parent.add(o);
  return o;
}
const bx = (p, m, x, y, z, w, h, d, rx, ry, rz) => put(p, box(), m, x, y, z, w, h, d, rx, ry, rz);
/** Cylinder along Y (rx = PI/2 turns it along Z, rz = PI/2 along X). */
const cy = (p, m, x, y, z, r, len, rx, ry, rz) => put(p, cyl(), m, x, y, z, r, len, r, rx, ry, rz);
/** Cylinder between two points. */
function strut(p, m, ax, ay, az, bx_, by, bz, r) {
  _a.set(ax, ay, az);
  _b.set(bx_ - ax, by - ay, bz - az);
  const len = _b.length() || 0.001;
  const o = put(p, cyl(), m, ax + _b.x / 2, ay + _b.y / 2, az + _b.z / 2, r, len, r);
  o.quaternion.setFromUnitVectors(UP, _b.normalize());
  return o;
}
const grp = (parent, name) => {
  const g = new THREE.Group();
  if (name) g.name = name;
  if (parent) parent.add(g);
  return g;
};

// ── part pickups (origin = ground contact) ────────────────────────────────
export function makePartMesh(id, mats = createRaftMaterials()) {
  const g = grp(null, 'raft-part-' + id);
  switch (id) {
    case 'hull_plank':
      for (let k = -1; k <= 1; k++) bx(g, mats.plank, k * 0.6, 0.05 + Math.abs(k) * 0.035, 0, 0.62, 0.05, 0.26, 0, 0, -k * 0.12);
      bx(g, mats.woodDark, 0.25, 0.085, 0, 0.04, 0.012, 0.2);
      break;
    case 'mast_pole':
      cy(g, mats.drift, 0, 0.07, 0, 0.07, 3.4, 0, 0, Math.PI / 2);
      put(g, torus(), mats.rope, 1.45, 0.07, 0, 0.09, 0.09, 0.09, 0, Math.PI / 2, 0);
      break;
    case 'cloth':
      bx(g, mats.cloth, 0, 0.07, 0, 0.55, 0.13, 0.42, 0, 0.3, 0);
      bx(g, mats.cloth, 0.12, 0.16, 0.04, 0.36, 0.08, 0.3, 0.1, -0.2, 0.08);
      bx(g, mats.rope, 0, 0.1, 0, 0.04, 0.16, 0.46, 0, 0.3, 0);
      break;
    case 'rudder':
      bx(g, mats.wood, 0, 0.03, 0, 0.42, 0.05, 0.75, 0, 0.4, 0);
      cy(g, mats.woodDark, -0.05, 0.05, 0.1, 0.04, 1.0, Math.PI / 2, 0.4, 0);
      break;
    case 'compass':
      cy(g, mats.brass, 0, 0.03, 0, 0.1, 0.06);
      cy(g, mats.glass, 0, 0.065, 0, 0.082, 0.01);
      bx(g, mats.red, 0, 0.075, 0, 0.012, 0.006, 0.12);
      break;
    case 'fuel_can':
      bx(g, mats.red, 0, 0.2, 0, 0.32, 0.4, 0.16, 0, 0, 0.12);
      bx(g, mats.red, 0.02, 0.43, 0, 0.16, 0.05, 0.05, 0, 0, 0.12);
      cy(g, mats.black, 0.13, 0.42, 0, 0.025, 0.06, 0, 0, 0.12);
      break;
    case 'spark_plug':
      bx(g, mats.metal, 0, 0.04, 0, 0.18, 0.07, 0.12);
      bx(g, mats.red, 0, 0.08, 0, 0.18, 0.012, 0.12);
      break;
    case 'engine_block': {
      const e = grp(g);
      bx(e, mats.cover, 0, 0.25, 0, 0.36, 0.42, 0.46);
      cy(e, mats.metal, 0, -0.25, 0.05, 0.05, 0.7);
      bx(e, mats.metal, 0, -0.6, 0.05, 0.1, 0.12, 0.2);
      e.rotation.z = 1.35;
      e.position.y = 0.2;
      break;
    }
    case 'propeller':
      cy(g, mats.brass, 0, 0.1, 0, 0.06, 0.14, Math.PI / 2, 0, 0);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU;
        bx(g, mats.brass, Math.cos(a) * 0.13, 0.1 + Math.sin(a) * 0.13, 0, 0.18, 0.025, 0.09, 0, 0.3, a);
      }
      break;
    default:
      bx(g, mats.wood, 0, 0.1, 0, 0.3, 0.2, 0.3);
  }
  return g;
}

/** Make a part mesh glow (emissive clones shared per source material, pulsed via mats.glow). */
export function glowify(obj, mats = createRaftMaterials()) {
  const cache = glowify.cache || (glowify.cache = new Map());
  obj.traverse((o) => {
    if (!o.isMesh || !o.material?.isMeshStandardMaterial) return;
    let m = cache.get(o.material);
    if (!m) {
      m = o.material.clone();
      m.emissive = new THREE.Color(0x66e0ff).lerp(o.material.color, 0.4);
      m.emissiveIntensity = 0.4;
      cache.set(o.material, m);
      mats.glow.add(m);
    }
    o.material = m;
  });
  return obj;
}

export function makeGlint(mats = createRaftMaterials(), sea = false) {
  const s = new THREE.Sprite(sea ? mats.glintSea : mats.glintRock);
  s.scale.setScalar(sea ? 1.4 : 0.5);
  s.renderOrder = 2;
  return s;
}

/** Raised sand mound with a cross of driftwood sticks. -> { group, mound, sticks } */
export function makeMound(mats = createRaftMaterials(), rand = Math.random) {
  const g = grp(null, 'raft-mound');
  const hemi = geo('hemi', () => new THREE.SphereGeometry(1, 10, 5, 0, TAU, 0, Math.PI / 2));
  const mound = put(g, hemi, mats.sand, 0, -0.02, 0, 0.95, 0.3, 0.8, 0, rand() * TAU, 0);
  const sticks = grp(g);
  strut(sticks, mats.drift, -0.32, 0.0, 0.05, 0.34, 1.05, -0.05, 0.035);
  strut(sticks, mats.drift, 0.32, 0.0, 0.05, -0.34, 1.05, -0.05, 0.035);
  bx(sticks, mats.rope, 0, 0.52, 0, 0.09, 0.09, 0.09, 0, 0, Math.PI / 4);
  sticks.rotation.y = rand() * TAU;
  sticks.position.y = 0.1;
  return { group: g, mound, sticks };
}

/** Cracked boulder with a glint in the crack and hidden rubble. -> { group, boulder, rubble, glint } */
export function makeBoulder(mats = createRaftMaterials(), rand = Math.random) {
  const g = grp(null, 'raft-boulder');
  const ig = new THREE.IcosahedronGeometry(1, 1);
  const p = ig.attributes.position;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let k = seen.get(key);
    if (k === undefined) seen.set(key, (k = 0.82 + rand() * 0.3));
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  ig.computeVertexNormals();
  const boulder = grp(g);
  put(boulder, ig, mats.stone, 0, 0.55, 0, 1.15, 0.85, 1.0);
  bx(boulder, mats.crack, 0.05, 0.75, 0.86, 0.07, 0.95, 0.06, 0, 0, 0.18);
  bx(boulder, mats.crack, 0.25, 0.95, 0.8, 0.05, 0.4, 0.05, 0, 0, -0.7);
  const glint = makeGlint(mats, false);
  glint.position.set(0.08, 0.8, 0.95);
  boulder.add(glint);
  const rubble = grp(g);
  const rg = geo('rubble', () => new THREE.IcosahedronGeometry(0.32, 0));
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * TAU + rand() * 0.6, r = 0.4 + rand() * 0.6, s = 0.6 + rand() * 0.7;
    put(rubble, rg, k % 2 ? mats.stoneDark : mats.stone, Math.cos(a) * r, 0.12 * s, Math.sin(a) * r, s, s * 0.7, s, rand(), rand() * TAU, rand());
  }
  rubble.visible = false;
  return { group: g, boulder, rubble, glint };
}

/** Wooden signpost reading "BOATYARD" (text face toward local +Z and -Z). */
export function makeSign(mats = createRaftMaterials(), text = 'BOATYARD') {
  const g = grp(null, 'raft-sign');
  cy(g, mats.woodDark, 0, 0.85, 0, 0.06, 1.7);
  let face = mats.wood;
  if (typeof document !== 'undefined') {
    try {
      const c = document.createElement('canvas');
      c.width = 256;
      c.height = 84;
      const x = c.getContext('2d');
      x.fillStyle = '#9b7652';
      x.fillRect(0, 0, 256, 84);
      x.strokeStyle = '#5e4630';
      x.lineWidth = 6;
      x.strokeRect(4, 4, 248, 76);
      x.fillStyle = '#2d1f12';
      x.font = 'bold 36px Georgia, serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillText(text, 128, 45);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
    } catch (e) {
      face = mats.wood;
    }
  }
  const board = new THREE.Mesh(box(), [mats.wood, mats.wood, mats.wood, mats.wood, face, face]);
  board.position.set(0, 1.45, 0);
  board.scale.set(1.1, 0.36, 0.05);
  board.castShadow = true;
  g.add(board);
  return g;
}

// ── boats ─────────────────────────────────────────────────────────────────
export const BOAT_SPECS = {
  raft: { length: 4.4, beam: 2.4, depth: 0.32, draft: 0.17, cradle: 0.18 },
  sailboat: { length: 6.0, beam: 0.95, depth: 0.62, draft: 0.28, cradle: 0.42, sheerBow: 0.32, sheerStern: 0.32, transom: 0, flat: 0.85, rig: 1.95 },
  motorboat: { length: 5.6, beam: 1.9, depth: 0.85, draft: 0.34, cradle: 0.42, sheerBow: 0.3, sheerStern: 0.04, transom: 0.82, flat: 0.55, rig: 2.4 },
};

/** Half-beam factor (0..1) at t (0 stern .. 1 bow). */
export function hullProfile(t, transom = 0) {
  const s = (u) => Math.sin(Math.min(1, Math.max(0, u)) * Math.PI / 2);
  const bow = Math.pow(s((1 - t) / 0.5), 0.75);
  const stern = transom > 0 ? transom + (1 - transom) * Math.pow(s(t / 0.4), 0.9) : Math.pow(s(t / 0.5), 0.75);
  return bow * stern;
}

/** Open hull shell (keel at y = 0 midships, +Z = bow). */
export function hullGeometry(spec, N = 18, M = 10) {
  const { length: L, beam: B, depth: D, sheerBow = 0, sheerStern = 0, transom = 0, flat = 1 } = spec;
  const pos = [];
  const idx = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, z = (t - 0.5) * L;
    const wf = hullProfile(t, transom), w = Math.max(0.012, (B / 2) * wf);
    const top = D + sheerBow * Math.max(0, (t - 0.5) * 2) ** 2 + sheerStern * Math.max(0, (0.5 - t) * 2) ** 2;
    const d = top * (0.35 + 0.65 * Math.sqrt(wf));
    for (let j = 0; j <= M; j++) {
      const a = -Math.PI / 2 + (Math.PI * j) / M;
      pos.push(w * Math.sin(a), top - d * Math.pow(Math.max(0, Math.cos(a)), flat), z);
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * (M + 1) + j, b = a + M + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  if (transom > 0) {
    let cyy = 0;
    for (let j = 0; j <= M; j++) cyy += pos[j * 3 + 1];
    cyy /= M + 1;
    const c0 = pos.length / 3;
    pos.push(0, cyy, -L / 2);
    for (let j = 0; j < M; j++) idx.push(c0, j, j + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function supplies(p, mats, x, y, z) {
  const s = grp(p, 'supplies');
  cy(s, mats.bamboo, x, y + 0.16, z, 0.05, 0.32);
  cy(s, mats.bamboo, x + 0.13, y + 0.16, z + 0.04, 0.05, 0.32);
  bx(s, mats.cloth, x - 0.22, y + 0.09, z - 0.05, 0.3, 0.18, 0.26, 0, 0.3, 0);
  put(s, torus(), mats.rope, x + 0.05, y + 0.03, z - 0.32, 0.13, 0.13, 0.13, Math.PI / 2, 0, 0);
  return s;
}
function compassOn(p, mats, x, y, z) {
  cy(p, mats.brass, x, y + 0.03, z, 0.09, 0.06);
  cy(p, mats.glass, x, y + 0.065, z, 0.075, 0.01);
}
function rudderAt(p, mats, x, z, top, depthBelow) {
  const r = grp(p, 'rudder');
  bx(r, mats.wood, x, top * 0.5 - depthBelow * 0.3, z - 0.18, 0.05, top + depthBelow * 0.6, 0.42);
  cy(r, mats.woodDark, x, top * 0.55, z - 0.02, 0.035, top * 0.9 + 0.3);
  bx(r, mats.woodDark, x, top + 0.12, z + 0.45, 0.05, 0.05, 0.9);
  return r;
}
function outrigger(p, mats, spec) {
  const o = grp(p, 'outrigger');
  const X = spec.rig, len = spec.length * 0.62, yA = spec.draft - 0.02, top = spec.depth + 0.03;
  cy(o, mats.wood, X, yA, 0, 0.13, len, Math.PI / 2, 0, 0);
  put(o, cone(), mats.wood, X, yA, len / 2 + 0.2, 0.13, 0.4, 0.13, Math.PI / 2, 0, 0);
  put(o, cone(), mats.wood, X, yA, -len / 2 - 0.2, 0.13, 0.4, 0.13, -Math.PI / 2, 0, 0);
  for (const z of [-len * 0.3, len * 0.3]) {
    cy(o, mats.bamboo, X / 2 + 0.05, top, z, 0.05, X + 0.4, 0, 0, Math.PI / 2);
    strut(o, mats.bamboo, X, yA + 0.1, z, X, top, z, 0.035);
    strut(o, mats.rope, X - 0.15, top, z, X, yA + 0.12, z, 0.015);
  }
  return o;
}

/**
 * makeBoat(planId) -> { group, parts: { [stageId]: Object3D }, spec }
 * Local frame: keel bottom at y = 0, +Z = bow. Every stage object starts hidden.
 */
export function makeBoat(planId, mats = createRaftMaterials(), rand = Math.random) {
  const spec = BOAT_SPECS[planId] || BOAT_SPECS.raft;
  const group = grp(null, 'raft-boat-' + planId);
  const parts = {};
  const L = spec.length, D = spec.depth;
  if (planId === 'raft' || !BOAT_SPECS[planId]) {
    const hull = (parts.hull = grp(group, 'hull'));
    for (let i = 0; i < 7; i++) {
      const len = 4.0 + rand() * 0.45;
      cy(hull, i % 2 ? mats.drift : mats.wood, -1.02 + i * 0.34, 0.16, (rand() - 0.5) * 0.25, 0.16, len, Math.PI / 2, 0, 0);
    }
    for (const z of [-1.5, 1.5]) {
      cy(hull, mats.woodDark, 0, 0.36, z, 0.07, 2.5, 0, 0, Math.PI / 2);
      bx(hull, mats.rope, 0, 0.34, z, 2.42, 0.05, 0.2);
    }
    for (const x of [-0.35, 0, 0.35]) bx(hull, mats.plank, x, 0.345, 0, 0.3, 0.05, 1.8);
    const mast = (parts.mast = grp(group, 'mast'));
    const mz = 0.35, mtop = D + 3.4;
    cy(mast, mats.drift, 0, D + 1.7, mz, 0.065, 3.4);
    strut(mast, mats.rope, 0, mtop - 0.2, mz, -1.0, D + 0.05, -1.7, 0.012);
    strut(mast, mats.rope, 0, mtop - 0.2, mz, 1.0, D + 0.05, -1.7, 0.012);
    strut(mast, mats.rope, 0, mtop - 0.2, mz, 0, D + 0.05, 2.0, 0.012);
    const sail = (parts.sail = grp(group, 'sail'));
    cy(sail, mats.drift, 0, mtop - 0.3, mz + 0.08, 0.04, 2.3, 0, 0, Math.PI / 2);
    const sg = new THREE.PlaneGeometry(2.0, 2.1, 4, 4);
    const sp = sg.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const u = sp.getX(i) / 2.0 + 0.5, v = sp.getY(i) / 2.1 + 0.5;
      sp.setZ(i, 0.22 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v));
    }
    sg.computeVertexNormals();
    put(sail, sg, mats.cloth, 0, mtop - 0.35 - 1.05, mz + 0.1, 1, 1, 1);
    parts.supplies = supplies(group, mats, 0.55, 0.37, -1.0);
  } else {
    const hull = (parts.hull = grp(group, 'hull'));
    put(hull, hullGeometry(spec), planId === 'motorboat' ? mats.hullPaint : mats.hullWood, 0, 0, 0, 1, 1, 1);
    bx(hull, mats.woodDark, 0, 0.03, 0, 0.07, 0.06, L * 0.82);
    for (const t of [0.3, 0.5, 0.72]) {
      const w = spec.beam * hullProfile(t, spec.transom);
      bx(hull, mats.plank, 0, D - 0.1, (t - 0.5) * L, w * 0.98, 0.05, 0.22);
    }
    if (planId === 'motorboat') {
      bx(hull, mats.plank, 0, 0.14, -0.2, spec.beam * 0.62, 0.04, L * 0.7);
      bx(hull, mats.trim, 0, D + 0.01, -L / 2 + 0.02, spec.beam * spec.transom * 0.98, 0.06, 0.06);
    }
    parts.outrigger = outrigger(group, mats, spec);
    parts.rudder = rudderAt(group, mats, planId === 'motorboat' ? 0.5 : 0, -L / 2, D + (spec.sheerStern || 0), 0.5);
    if (planId === 'sailboat') {
      const mast = (parts.mast = grp(group, 'mast'));
      const mz = 0.9, mtop = D + 4.0;
      cy(mast, mats.drift, 0, (0.1 + mtop) / 2, mz, 0.065, mtop - 0.1);
      strut(mast, mats.rope, 0, mtop - 0.2, mz, spec.rig, D + 0.05, mz - 0.3, 0.012);
      strut(mast, mats.rope, 0, mtop - 0.2, mz, -0.45, D + 0.02, mz - 0.6, 0.012);
      strut(mast, mats.rope, 0, mtop - 0.2, mz, 0, D + 0.3, L / 2, 0.012);
      const sail = (parts.sail = grp(group, 'sail'));
      const tack = [0, D + 0.35, 2.5], peak = [0, mtop + 0.5, 0.2], clew = [0, D + 0.6, -2.0];
      const ctr = [0.32, (tack[1] + peak[1] + clew[1]) / 3, (tack[2] + peak[2] + clew[2]) / 3];
      const tg = new THREE.BufferGeometry();
      tg.setAttribute('position', new THREE.Float32BufferAttribute([...tack, ...peak, ...clew, ...ctr], 3));
      tg.setIndex([0, 1, 3, 1, 2, 3, 2, 0, 3]);
      tg.computeVertexNormals();
      put(sail, tg, mats.cloth, 0, 0, 0, 1, 1, 1);
      strut(sail, mats.drift, tack[0], tack[1], tack[2], peak[0], peak[1], peak[2], 0.035);
      strut(sail, mats.drift, tack[0], tack[1], tack[2], clew[0], clew[1], clew[2], 0.03);
      const nav = (parts.navigation = grp(group, 'navigation'));
      bx(nav, mats.wood, 0, D * 0.5, -L / 2 + 1.1, 0.12, D, 0.12);
      compassOn(nav, mats, 0, D, -L / 2 + 1.1);
      parts.supplies = supplies(group, mats, 0.05, 0.12, -0.5);
    } else {
      const ez = -L / 2 - 0.2, ex = -0.2;
      const eng = (parts.engine = grp(group, 'engine'));
      bx(eng, mats.metal, ex, D - 0.05, -L / 2 - 0.04, 0.16, 0.22, 0.1);
      bx(eng, mats.cover, ex, D + 0.28, ez, 0.36, 0.42, 0.46);
      cy(eng, mats.metal, ex, D - 0.42, ez, 0.05, 0.95);
      bx(eng, mats.metal, ex, -0.05, ez, 0.1, 0.14, 0.26);
      cy(eng, mats.brass, ex, -0.05, ez - 0.16, 0.04, 0.08, Math.PI / 2, 0, 0);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * TAU;
        bx(eng, mats.brass, ex + Math.cos(a) * 0.1, -0.05 + Math.sin(a) * 0.1, ez - 0.18, 0.14, 0.02, 0.07, 0, 0.3, a);
      }
      const ign = (parts.ignition = grp(group, 'ignition'));
      bx(ign, mats.red, ex - 0.08, D + 0.36, ez - 0.25, 0.05, 0.05, 0.05);
      bx(ign, mats.red, ex + 0.08, D + 0.36, ez - 0.25, 0.05, 0.05, 0.05);
      bx(ign, mats.black, 0.35, 0.3, -L / 2 + 0.45, 0.26, 0.18, 0.18);
      strut(ign, mats.black, 0.35, 0.4, -L / 2 + 0.45, ex, D + 0.2, ez + 0.2, 0.012);
      const fuel = (parts.fuel = grp(group, 'fuel'));
      const can = makePartMesh('fuel_can', mats);
      can.position.set(-0.45, 0.15, -L / 2 + 0.7);
      can.rotation.y = 0.2;
      fuel.add(can);
      strut(fuel, mats.black, -0.45, 0.6, -L / 2 + 0.7, ex, D + 0.15, ez + 0.2, 0.014);
      const nav = (parts.navigation = grp(group, 'navigation'));
      bx(nav, mats.wood, 0, 0.45, -0.3, 0.42, 0.62, 0.32);
      compassOn(nav, mats, 0, 0.76, -0.3);
      parts.supplies = supplies(group, mats, 0.1, 0.16, 0.6);
    }
  }
  for (const k in parts) parts[k].visible = false;
  return { group, parts, spec };
}

/** Trestles (or log rollers) under the boat and a pile of driftwood beside it (local frame like the boat). */
export function makeYardProps(planId, mats = createRaftMaterials(), rand = Math.random) {
  const spec = BOAT_SPECS[planId] || BOAT_SPECS.raft;
  const g = grp(null, 'raft-yard');
  if (planId === 'raft' || !BOAT_SPECS[planId]) {
    for (const z of [-1.4, 0, 1.4]) cy(g, mats.drift, 0, 0.09, z, 0.09, 2.7, 0, 0, Math.PI / 2);
  } else {
    const h = spec.cradle, w = spec.beam * 0.9 + 0.3;
    for (const z of [-spec.length * 0.26, spec.length * 0.22]) {
      bx(g, mats.woodDark, 0, h - 0.05, z, w, 0.1, 0.14);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) bx(g, mats.woodDark, sx * (w / 2 - 0.08), (h - 0.1) / 2, z + sz * 0.1, 0.06, h, 0.06, sz * 0.25, 0, 0);
    }
  }
  const px = -(spec.beam / 2 + 1.7);
  for (let k = 0; k < 5; k++) {
    const row = k < 3 ? 0 : 1, i = row ? k - 3 : k;
    cy(g, k % 2 ? mats.drift : mats.wood, px + (i - (row ? 0.5 : 1)) * 0.24, 0.1 + row * 0.19, (rand() - 0.5) * 0.3, 0.1, 1.8 + rand() * 0.5, Math.PI / 2, rand() * 0.2, 0);
  }
  return g;
}

/** Foam wake behind the stern (flat on the water; follows the boat each frame). */
export function makeWake(mats = createRaftMaterials()) {
  const g = grp(null, 'raft-wake');
  const plane = geo('wakePlane', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.5));
  for (const s of [-1, 1]) put(g, plane, mats.wake, s * 0.4, 0, 0, 0.35, 1, 9, 0, s * 0.32, 0).castShadow = false;
  const disc = geo('wakeDisc', () => new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2));
  put(g, disc, mats.wake, 0, 0.005, -0.2, 0.9, 1, 1.4).castShadow = false;
  return g;
}

/** Pooled dust / sand puffs. -> { mesh, emit(x, y, z, n, color), update(dt) } */
export function createPuffs(mats = createRaftMaterials(), cap = 48) {
  const mesh = new THREE.InstancedMesh(geo('puff', () => new THREE.IcosahedronGeometry(0.16, 0)), mats.puff, cap);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.name = 'raft-puffs';
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const P = [];
  for (let i = 0; i < cap; i++) P.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 1 });
  dummy.scale.setScalar(0);
  dummy.updateMatrix();
  for (let i = 0; i < cap; i++) {
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, col.set(0xffffff));
  }
  let next = 0, alive = 0;
  return {
    mesh,
    emit(x, y, z, n = 6, color = 0xd9c49a) {
      col.set(color);
      for (let k = 0; k < n; k++) {
        const i = next;
        const p = P[i];
        next = (next + 1) % cap;
        const a = Math.random() * TAU, sp = 0.6 + Math.random() * 1.2;
        p.x = x;
        p.y = y;
        p.z = z;
        p.vx = Math.cos(a) * sp;
        p.vz = Math.sin(a) * sp;
        p.vy = 1.2 + Math.random() * 1.6;
        p.max = p.life = 0.6 + Math.random() * 0.5;
        p.s = 0.7 + Math.random() * 0.8;
        mesh.setColorAt(i, col);
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      alive = cap;
    },
    update(dt) {
      if (!alive) return;
      let any = 0;
      for (let i = 0; i < cap; i++) {
        const p = P[i];
        if (p.life <= 0) {
          if (p.max > 0) {
            p.max = 0;
            dummy.scale.setScalar(0);
            dummy.updateMatrix();
            mesh.setMatrixAt(i, dummy.matrix);
          }
          continue;
        }
        any++;
        p.life -= dt;
        p.vy -= 3.2 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        const u = 1 - Math.max(0, p.life) / p.max;
        dummy.position.set(p.x, p.y, p.z);
        dummy.scale.setScalar(p.s * Math.sin(Math.PI * Math.min(1, u * 1.1 + 0.05)));
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (!any) alive = 0;
    },
  };
}
