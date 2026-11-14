// Dense swaying grass around the player: one InstancedMesh of grass tufts on a toroidal grid of 8 m
// cells (11 x 11 cells, ~44 m radius). When the player crosses a cell boundary only the cells that
// enter the window are rewritten (slot = cell index mod N). Per-cell tuft data (position, height,
// color from the biome) is computed lazily once and cached, so walking costs ~1 ms per crossing.
// The shader (materials.makeGrass) shrinks tufts toward the patch edge, sways them in rolling waves
// and bends them away from the player's legs. No grass on sand (except sparse dune grass on the
// upper beach), rock, steep slopes or in water.
// V4-E: setScale(radiusK, densityK) (flora, from ctx.quality) rebuilds the patch with fewer cells
// (11 / 9 / 7 per side) and fewer tuft slots per cell (uniform subsample of each cell's tufts).
import * as THREE from 'three';
import { hash2, smoothstep } from '../../core/util.js';
import { BEND_MAX, FLUTTER_MAX } from './bake.js';
import { PAL, lin, mix } from './palette.js';

const CELL = 8;
const N = 11; // cells per side (odd)
const H = (N - 1) / 2;
const K = 72; // tuft slots per cell
const RADIUS = 40;
const SEED = 7331;

/** One tuft: 7 curved, tapered blades (unit height ~1 m), up-facing normals, wind weights. */
function buildTuft() {
  const pos = [], col = [], nrm = [], wind = [], idx = [];
  let r = 12345;
  const rnd = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
  const blades = 7;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + rnd() * 0.9;
    const ca = Math.cos(a), sa = Math.sin(a);
    const h = 0.55 + rnd() * 0.45;
    const w = 0.05 + rnd() * 0.035;
    const lean = 0.12 + rnd() * 0.3; // outward lean of the tip (m per m of height)
    const r0 = rnd() * 0.12; // root offset from the tuft center
    const bx = ca * r0, bz = sa * r0;
    // the blade faces roughly sideways to its lean direction
    const sx = -sa, sz = ca;
    const shade = 0.88 + rnd() * 0.24;
    const yellow = rnd() < 0.18 ? 0.2 : 0;
    const base = pos.length / 3;
    const rows = [0, 0.45, 0.78];
    for (const t of rows) {
      const off = lean * h * t * t;
      const cx = bx + ca * off, cz = bz + sa * off, y = h * t;
      const ww = w * (1 - t * 0.7);
      for (const sd of [-1, 1]) {
        pos.push(cx + sx * ww * sd, y, cz + sz * ww * sd);
        const k = (0.45 + 0.75 * t) * shade;
        col.push(k * (1 + yellow), k * (1 + yellow * 0.6), k * (1 - yellow));
        nrm.push(0, 1, 0);
        wind.push(Math.pow(t, 1.5) * 0.32, t * 0.035, b / blades);
      }
    }
    // tip
    const off = lean * h;
    pos.push(bx + ca * off, h, bz + sa * off);
    col.push(1.25 * shade * (1 + yellow), 1.25 * shade * (1 + yellow * 0.6), 1.25 * shade * (1 - yellow));
    nrm.push(0, 1, 0);
    wind.push(0.32, 0.035, b / blades);
    // triangles (rendered double-sided)
    for (let rr = 0; rr < 2; rr++) {
      const a0 = base + rr * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
      idx.push(a0, b0, b1, a0, b1, a1);
    }
    idx.push(base + 4, base + 5, base + 6);
  }
  const nV = pos.length / 3;
  const W = new Uint8Array(nV * 4);
  for (let k = 0; k < nV; k++) {
    W[k * 4] = Math.round(Math.min(1, wind[k * 3] / BEND_MAX) * 255);
    W[k * 4 + 1] = Math.round(Math.min(1, wind[k * 3 + 1] / FLUTTER_MAX) * 255);
    W[k * 4 + 2] = Math.round(wind[k * 3 + 2] * 255);
    W[k * 4 + 3] = 255;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aWind', new THREE.BufferAttribute(W, 4, true));
  g.setIndex(idx);
  return g;
}

const C_MEADOW = lin('#93bd52');
const C_GRASS = lin('#6f9f40');
const C_FOREST = lin('#557236');
const C_DRY = PAL.dryGrass;
const C_DUNE = PAL.duneGrass;
const C_HIGH = lin('#8c9a52');

export class GrassPatch {
  constructor(ctx, mats) {
    this.ctx = ctx;
    this.W = ctx.world;
    this.mats = mats;
    this.cache = new Map();
    this.N = N; // cells per side (odd)
    this.H = H;
    this.KS = K; // tuft slots per cell
    this.density = 1;
    this.slotKey = new Float64Array(N * N).fill(NaN);
    this.center = [NaN, NaN];
    this.geo = buildTuft();
    this.mesh = this.makeMesh();
    mats.uniforms.uGrassRadius.value = RADIUS;
    this._p = new THREE.Vector3();
  }

  makeMesh() {
    const mesh = new THREE.InstancedMesh(this.geo, this.mats.grass, this.N * this.N * this.KS);
    mesh.name = 'flora-grass';
    mesh.frustumCulled = false; // re-centered every few meters; the shader fades the edge
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceMatrix.array.fill(0); // all tufts start collapsed
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.visible = false;
    return mesh;
  }

  /** Quality scaling: radius factor (1 = 40 m, 11x11 cells) and tuft density factor (1 = 72 per cell). */
  setScale(radiusK = 1, densityK = 1) {
    radiusK = Math.min(1, Math.max(0.3, radiusK));
    densityK = Math.min(1, Math.max(0.3, densityK));
    this.mats.uniforms.uGrassRadius.value = RADIUS * radiusK;
    const n = 2 * Math.max(1, Math.round(H * radiusK)) + 1;
    const ks = Math.max(8, Math.round(K * densityK));
    if (n === this.N && ks === this.KS && densityK === this.density) return;
    this.N = n;
    this.H = (n - 1) / 2;
    this.KS = ks;
    this.density = densityK;
    const old = this.mesh;
    const mesh = this.makeMesh();
    mesh.visible = old.visible;
    const parent = old.parent;
    if (parent) {
      parent.add(mesh);
      parent.remove(old);
    }
    old.dispose(); // instance buffers only; the tuft geometry and material are shared
    this.mesh = mesh;
    this.slotKey = new Float64Array(n * n).fill(NaN);
    this.center[0] = this.center[1] = NaN;
  }

  /** Lazily computed tuft data for a cell: Float32Array [x, y, z, rot, sxz, sy, r, g, b] * n. */
  cell(ix, iz) {
    const key = ix * 4096 + iz;
    let c = this.cache.get(key);
    if (c) return c;
    if (this.cache.size > 1500) this.cache.clear();
    const W = this.W;
    const flora = this.ctx.flora;
    const data = new Float32Array(K * 9);
    let n = 0;
    const sub = 9; // 9 x 8 stratified sub-grid
    for (let k = 0; k < K; k++) {
      const hx = hash2(ix * 97 + k, iz * 89 - k, SEED), hz = hash2(iz * 61 + k, ix * 53 + k * 7, SEED + 1);
      const hr = hash2(ix + k * 13, iz - k * 17, SEED + 2);
      const x = (ix + ((k % sub) + hx) / sub) * CELL;
      const z = (iz + (Math.floor(k / sub) + hz) / (K / sub)) * CELL;
      const h = W.heightAt(x, z);
      if (h < 0.35) continue;
      const b = W.biomeAt(x, z);
      if (b.water || b.rock > 0.42 || b.slope > 0.55) continue;
      const rv = W.riverAt(x, z);
      if (rv && rv.d < rv.w + 0.4) continue;
      let dens, height, color;
      if (b.sand > 0.35) {
        // sparse dune grass on the upper beach only
        dens = b.sand < 0.8 && h > 1.1 ? 0.18 * smoothstep(1.1, 2.0, h) : 0;
        height = 0.45 + hr * 0.35;
        color = C_DUNE;
      } else {
        const canopy = flora?.canopyAt ? flora.canopyAt(x, z) : 0;
        const meadow = b.meadow, forest = b.forest * (0.5 + 0.5 * canopy);
        dens = 0.85 - forest * 0.72 + meadow * 0.15;
        dens *= 1 - b.highland * 0.35;
        dens *= 1 - smoothstep(0.2, 0.42, b.rock);
        height = (0.32 + meadow * 0.42 + b.wet * 0.2) * (1 - forest * 0.35) * (1 - b.highland * 0.3) * (0.75 + hr * 0.5);
        color = mix(C_GRASS, C_MEADOW, Math.min(1, meadow * 1.2));
        color = mix(color, C_FOREST, Math.min(1, forest * 0.9));
        color = mix(color, C_HIGH, b.highland * 0.6);
        color = mix(color, C_DRY, smoothstep(0.1, 0.35, b.sand) * 0.8);
      }
      if (hr > dens) continue;
      const tv = 0.88 + hash2(k, ix * 31 + iz, SEED + 3) * 0.24;
      const o = n * 9;
      data[o] = x;
      data[o + 1] = h - 0.03;
      data[o + 2] = z;
      data[o + 3] = hx * Math.PI * 2;
      data[o + 4] = 0.75 + hz * 0.45;
      data[o + 5] = height;
      data[o + 6] = color[0] * tv;
      data[o + 7] = color[1] * tv;
      data[o + 8] = color[2] * tv;
      n++;
    }
    c = { data, n };
    this.cache.set(key, c);
    return c;
  }

  /** Write a cell into its toroidal slot. */
  fill(slot, ix, iz) {
    const c = this.cell(ix, iz);
    const M = this.mesh.instanceMatrix.array;
    const Cc = this.mesh.instanceColor.array;
    const KS = this.KS, dens = this.density;
    const base = slot * KS;
    for (let k = 0; k < KS; k++) {
      const m = (base + k) * 16;
      const src = dens >= 1 ? k : Math.floor(k / dens); // uniform subsample at lower densities
      if (src >= c.n) {
        for (let j = 0; j < 16; j++) M[m + j] = 0;
        continue;
      }
      const o = src * 9;
      const rot = c.data[o + 3], sxz = c.data[o + 4], sy = c.data[o + 5];
      const cs = Math.cos(rot), sn = Math.sin(rot);
      // column-major: rotation about Y with scale (sxz, sy, sxz)
      M[m] = cs * sxz;
      M[m + 1] = 0;
      M[m + 2] = -sn * sxz;
      M[m + 3] = 0;
      M[m + 4] = 0;
      M[m + 5] = sy;
      M[m + 6] = 0;
      M[m + 7] = 0;
      M[m + 8] = sn * sxz;
      M[m + 9] = 0;
      M[m + 10] = cs * sxz;
      M[m + 11] = 0;
      M[m + 12] = c.data[o];
      M[m + 13] = c.data[o + 1];
      M[m + 14] = c.data[o + 2];
      M[m + 15] = 1;
      const ci = (base + k) * 3;
      Cc[ci] = c.data[o + 6];
      Cc[ci + 1] = c.data[o + 7];
      Cc[ci + 2] = c.data[o + 8];
    }
  }

  update() {
    const ctx = this.ctx;
    const p = this._p;
    if (ctx.player?.position && (ctx.state === 'playing' || ctx.state === 'paused' || ctx.state === 'dead')) p.copy(ctx.player.position);
    else ctx.camera.getWorldPosition(p);
    // no grass for the far title/intro cameras
    const ground = this.W.heightAt(p.x, p.z);
    const show = ctx.state !== 'loading' && ctx.state !== 'title' && p.y - ground < 40;
    this.mesh.visible = show;
    if (!show) return;
    this.mats.uniforms.uGrassCenter.value.set(p.x, p.y, p.z);
    this.mats.uniforms.uPlayer.value.set(p.x, p.y, p.z);
    const cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
    if (cx === this.center[0] && cz === this.center[1]) return;
    this.center[0] = cx;
    this.center[1] = cz;
    let dirty = false;
    const N = this.N, H = this.H;
    for (let dz = -H; dz <= H; dz++) {
      for (let dx = -H; dx <= H; dx++) {
        const ix = cx + dx, iz = cz + dz;
        const slot = (((ix % N) + N) % N) + (((iz % N) + N) % N) * N;
        const key = ix * 4096 + iz;
        if (this.slotKey[slot] === key) continue;
        this.slotKey[slot] = key;
        this.fill(slot, ix, iz);
        dirty = true;
      }
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }
}
