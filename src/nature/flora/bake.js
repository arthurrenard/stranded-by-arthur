// Chunk baking: copies variant geometry (species.js) into one merged BufferGeometry per 64 m tile,
// applying each instance's rotation, scale, tint and wind weights while copying. One draw call per
// chunk instead of one per (variant, chunk) group (the island has ~1600 such groups: far over the
// SPEC §9 budget of ~250 draw calls), and three.js still frustum-culls each chunk.
//
// Compact vertex layout (≈25 bytes/vertex):
//   position Float32x3 (world space)  · normal Int8x3 (normalized; only used for shadow normal bias)
//   color    Uint16x3 (normalized, linear)
//   aWind    Uint8x4 (normalized): x bend / BEND_MAX, y flutter / FLUTTER_MAX, z per-tree phase, w leaf flag
//   aClose   Int8x4 (normalized, optional, flowers): xyz offset to the closed pose / CLOSE_MAX, w phase*2-1
//
// Each add() returns a handle with the instance's index range inside its chunk so a single tree can be
// hidden later (falling trees) by turning its triangles into degenerate ones (hideRange()).
import * as THREE from 'three';

export const CHUNK = 64;
export const BEND_MAX = 2.5; // meters of sway at wind strength 1 (aWind.x = 1)
export const FLUTTER_MAX = 0.3; // meters of leaf flutter (aWind.y = 1)
export const CLOSE_MAX = 0.25; // meters (aClose xyz = ±1)

export const chunkCoord = (v) => Math.floor(v / CHUNK);

export class ChunkBaker {
  /** opts: { close: bool (bake the aClose attribute) } */
  constructor(opts = {}) {
    this.close = !!opts.close;
    this.chunks = new Map();
  }

  /**
   * Queue an instance of variant V. inst: { x, y, z, rot, s, phase, barkTint?, leafTint?, windK? }.
   * Returns a handle { key, iStart, iCount, barkCount, geometry (after build) }.
   */
  add(V, inst) {
    const ix = chunkCoord(inst.x), iz = chunkCoord(inst.z);
    const key = ix * 4096 + iz;
    let c = this.chunks.get(key);
    if (!c) this.chunks.set(key, (c = { key, ix, iz, items: [], nV: 0, nI: 0, geometry: null }));
    const h = { key, vStart: c.nV, vCount: V.nVerts, iStart: c.nI, iCount: V.nIdx, barkCount: V.barkCount, chunk: c };
    c.items.push({ V, inst, h });
    c.nV += V.nVerts;
    c.nI += V.nIdx;
    return h;
  }

  /** Build every chunk geometry. Returns [{ key, ix, iz, geometry, count }]. */
  build() {
    const out = [];
    for (const c of this.chunks.values()) {
      const nV = c.nV, nI = c.nI;
      const pos = new Float32Array(nV * 3);
      const nrm = new Int8Array(nV * 3);
      const col = new Uint16Array(nV * 3);
      const wind = new Uint8Array(nV * 4);
      const close = this.close ? new Int8Array(nV * 4) : null;
      const index = nV > 65535 ? new Uint32Array(nI) : new Uint16Array(nI);
      const A = { pos, nrm, col, wind, close, index };
      for (const it of c.items) writeInstance(it.V, it.inst, A, it.h.vStart, it.h.iStart);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
      g.setAttribute('aWind', new THREE.BufferAttribute(wind, 4, true));
      if (close) g.setAttribute('aClose', new THREE.BufferAttribute(close, 4, true));
      g.setIndex(new THREE.BufferAttribute(index, 1));
      g.computeBoundingSphere();
      g.boundingSphere.radius += 2; // wind sway margin
      g.computeBoundingBox();
      c.geometry = g;
      out.push({ key: c.key, ix: c.ix, iz: c.iz, geometry: g, count: c.items.length });
    }
    return out;
  }
}

const clampU16 = (v) => (v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535));
const clampU8 = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));
const clampI8 = (v) => (v <= -1 ? -127 : v >= 1 ? 127 : Math.round(v * 127));
const ONE = [1, 1, 1];

/** Transform variant V by inst and write it at vertex offset vo / index offset io. */
function writeInstance(V, inst, A, vo, io) {
  const c = Math.cos(inst.rot || 0), sn = Math.sin(inst.rot || 0), s = inst.s ?? 1;
  const ox = inst.x, oy = inst.y, oz = inst.z;
  const bt = inst.barkTint || ONE, lt = inst.leafTint || ONE;
  const windK = (inst.windK ?? 1) * s;
  const phase = inst.phase ?? 0;
  const P = V.pos, N = V.nrm, C = V.col, Wd = V.wind, Lf = V.leaf, Cl = V.close;
  const { pos, nrm, col, wind, close } = A;
  for (let k = 0; k < V.nVerts; k++) {
    const k3 = k * 3, o3 = (vo + k) * 3, o4 = (vo + k) * 4;
    const lx = P[k3], ly = P[k3 + 1], lz = P[k3 + 2];
    pos[o3] = ox + (lx * c + lz * sn) * s;
    pos[o3 + 1] = oy + ly * s;
    pos[o3 + 2] = oz + (-lx * sn + lz * c) * s;
    const nx = N[k3], ny = N[k3 + 1], nz = N[k3 + 2];
    nrm[o3] = clampI8(nx * c + nz * sn);
    nrm[o3 + 1] = clampI8(ny);
    nrm[o3 + 2] = clampI8(-nx * sn + nz * c);
    const t = Lf[k] ? lt : bt;
    col[o3] = clampU16(C[k3] * t[0]);
    col[o3 + 1] = clampU16(C[k3 + 1] * t[1]);
    col[o3 + 2] = clampU16(C[k3 + 2] * t[2]);
    wind[o4] = clampU8((Wd[k * 2] * windK) / BEND_MAX);
    wind[o4 + 1] = clampU8((Wd[k * 2 + 1] * s) / FLUTTER_MAX);
    wind[o4 + 2] = clampU8(phase);
    wind[o4 + 3] = Lf[k] ? 255 : 0;
    if (close) {
      if (Cl) {
        const cx = Cl[k * 4], cy = Cl[k * 4 + 1], cz = Cl[k * 4 + 2];
        close[o4] = clampI8(((cx * c + cz * sn) * s) / CLOSE_MAX);
        close[o4 + 1] = clampI8((cy * s) / CLOSE_MAX);
        close[o4 + 2] = clampI8(((-cx * sn + cz * c) * s) / CLOSE_MAX);
        close[o4 + 3] = clampI8(Cl[k * 4 + 3] * 2 - 1);
      }
    }
  }
  const I = V.index, index = A.index;
  for (let i = 0; i < V.nIdx; i++) index[io + i] = I[i] + vo;
}

/**
 * Free the CPU copies of a static geometry's arrays once they are on the GPU (halves the JS heap).
 * keepIndex: keep the index array (needed by hideRange for trees that may fall).
 */
export function releaseAfterUpload(g, keepIndex = false) {
  const free = function () {
    this.array = null;
  };
  for (const k in g.attributes) g.attributes[k].onUpload(free);
  if (!keepIndex && g.index) g.index.onUpload(free);
}

/**
 * Hide part of a baked instance (e.g. a tree that starts falling) by collapsing its triangles.
 * from/count are relative to the instance's own index range (default: everything).
 */
export function hideRange(h, from = 0, count = h.iCount - from) {
  const g = h.chunk?.geometry;
  if (!g) return;
  const idx = g.index;
  const a = idx.array;
  if (!a) return;
  const start = h.iStart + from;
  const v = a[start];
  for (let i = start; i < start + count; i++) a[i] = v;
  idx.addUpdateRange(start, count);
  idx.needsUpdate = true;
}

/**
 * Standalone geometry for one variant in its local frame (same attribute layout as the chunks).
 * opts: { bendK (1; 0 = no sway), tint (leaf+bark multiplier), close (bool) }
 * Groups: 0 = bark triangles, 1 = leaf triangles (used by falling trees).
 */
export function variantGeometry(V, opts = {}) {
  const b = new ChunkBaker({ close: !!opts.close });
  b.add(V, { x: 0, y: 0, z: 0, rot: 0, s: 1, phase: opts.phase ?? 0.5, windK: opts.bendK ?? 1, barkTint: opts.barkTint, leafTint: opts.leafTint });
  const [{ geometry: g }] = b.build();
  g.addGroup(0, V.barkCount, 0);
  g.addGroup(V.barkCount, V.nIdx - V.barkCount, 1);
  return g;
}
