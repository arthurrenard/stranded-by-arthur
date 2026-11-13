// State shared by the four world modules (sky, weather, terrain, water), memoized per ctx.
// - `uniforms`: one set of uniform objects referenced by several materials, so the sky can
//   update light/sky colors once per frame and every water/terrain shader sees them.
// - `heightTexture()`: the heightfield baked into a HalfFloat RGBA DataTexture
//   (R = ground height, G = blurred height, B = distance to the shore over the ocean, in meters),
//   covering both islands (main + Tempest Isle, v3).
// Nothing here touches other builders' systems; safe to call from create().
import * as THREE from 'three';

const cache = new WeakMap();

export function worldShared(ctx) {
  let s = cache.get(ctx);
  if (s) return s;
  s = {
    uniforms: {
      // true celestial directions (unit vectors toward the body)
      uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
      uMoonDir: { value: new THREE.Vector3(-0.4, -0.8, -0.2).normalize() },
      // the active key light (sun by day, moon by night): direction + color*intensity (linear)
      uLightDir: { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
      uLightColor: { value: new THREE.Color(2.5, 2.4, 2.2) },
      // diffuse sky irradiance (hemisphere sky color * intensity + ambient), linear
      uAmbientColor: { value: new THREE.Color(0.8, 0.9, 1.0) },
      // sky gradient (linear colors, displayed untonemapped like the fog)
      uZenith: { value: new THREE.Color(0x3c7fd4) },
      uHorizon: { value: new THREE.Color(0xa8cbe8) },
      uGlowColor: { value: new THREE.Color(0xffb060) },
      uSunsetAmt: { value: 0 },
      // clouds (sky dome + stars + terrain cloud shadows)
      uCloudCover: { value: 0.2 },
      uCloudOffset: { value: new THREE.Vector2() },
      uCloudGround: { value: new THREE.Vector2() }, // meters, for cloud shadows on the ground
      uCloudShadow: { value: 0 },
      uFlash: { value: 0 }, // lightning flash 0..1+
      // water
      uTide: { value: 0 }, // slow sea level breathing (m), also used by the terrain wet band
      uWave: { value: 0.8 }, // wave amplitude multiplier (weather wind/storm)
      uWet: { value: 0 }, // ground wetness from rain (dries slowly)
    },
    _heightTex: null,
    _heightData: null,
    /** CPU copy of the baked channels ({ data: Float32Array RGBA, n }), shared with the texture. */
    heightData() {
      if (!s._heightData) s._heightData = bakeHeightData(ctx.world);
      return s._heightData;
    },
    heightTexture() {
      if (!s._heightTex) s._heightTex = buildHeightTexture(s.heightData());
      return s._heightTex;
    },
  };
  cache.set(ctx, s);
  return s;
}

/**
 * Extent of the baked height texture: the union of every terrain grid (main island + Tempest Isle),
 * at the main grid spacing. Texel (i, j) sits on world (x0 + i*cell, z0 + j*cell). Pure.
 */
export function heightExtent(world) {
  const cell = world.CELL;
  const grids = world.grids?.length ? world.grids : [{ x0: -world.SIZE / 2, z0: -world.SIZE / 2, cell, cells: world.CELLS }];
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const g of grids) {
    x0 = Math.min(x0, g.x0);
    z0 = Math.min(z0, g.z0);
    x1 = Math.max(x1, g.x0 + g.cells * g.cell);
    z1 = Math.max(z1, g.z0 + g.cells * g.cell);
  }
  const nx = Math.round((x1 - x0) / cell) + 1, nz = Math.round((z1 - z0) / cell) + 1;
  return { x0, z0, cell, nx, nz };
}

/**
 * Uniform mapping world xz -> texel-centered uv of the height texture:
 * uv = (x * xform.x + xform.y, z * xform.z + xform.w)
 */
export function heightXform(world) {
  const e = heightExtent(world);
  return new THREE.Vector4(
    1 / (e.cell * e.nx),
    (-e.x0 / e.cell + 0.5) / e.nx,
    1 / (e.cell * e.nz),
    (-e.z0 / e.cell + 0.5) / e.nz
  );
}

/** GLSL helpers to read the height texture. Requires uniforms uHeightTex + uHeightXform. */
export const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
uniform vec4 uHeightXform;
vec4 wHeightSample(vec2 xz) {
  return texture2D(uHeightTex, vec2(xz.x * uHeightXform.x + uHeightXform.y, xz.y * uHeightXform.z + uHeightXform.w));
}
`;

// ── Pure helpers (exported for node tests) ───────────────────────────────

/**
 * Two-pass chamfer distance transform on an n×nz grid (row-major, n columns; nz defaults to n).
 * seed[k] = 1 for source cells (distance 0). Returns Float32Array of distances in cells.
 */
export function chamferDistance(seed, n, nz = n) {
  const INF = 1e9;
  const N = n * nz;
  const D = new Float32Array(N);
  for (let k = 0; k < N; k++) D[k] = seed[k] ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      let d = D[k];
      if (i > 0) d = Math.min(d, D[k - 1] + a);
      if (j > 0) {
        d = Math.min(d, D[k - n] + a);
        if (i > 0) d = Math.min(d, D[k - n - 1] + b);
        if (i < n - 1) d = Math.min(d, D[k - n + 1] + b);
      }
      D[k] = d;
    }
  }
  for (let j = nz - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      let d = D[k];
      if (i < n - 1) d = Math.min(d, D[k + 1] + a);
      if (j < nz - 1) {
        d = Math.min(d, D[k + n] + a);
        if (i < n - 1) d = Math.min(d, D[k + n + 1] + b);
        if (i > 0) d = Math.min(d, D[k + n - 1] + b);
      }
      D[k] = d;
    }
  }
  return D;
}

/** Separable box blur (radius r cells, clamped edges) on an n×nz grid, returns a new Float32Array. */
export function boxBlur(src, n, r, nz = n) {
  const tmp = new Float32Array(n * nz);
  const out = new Float32Array(n * nz);
  const w = 2 * r + 1;
  for (let j = 0; j < nz; j++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[j * n + Math.min(n - 1, Math.max(0, i))];
    for (let i = 0; i < n; i++) {
      tmp[j * n + i] = acc / w;
      const add = Math.min(n - 1, i + r + 1), sub = Math.max(0, i - r);
      acc += src[j * n + add] - src[j * n + sub];
    }
  }
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) acc += tmp[Math.min(nz - 1, Math.max(0, j)) * n + i];
    for (let j = 0; j < nz; j++) {
      out[j * n + i] = acc / w;
      const add = Math.min(nz - 1, j + r + 1), sub = Math.max(0, j - r);
      acc += tmp[add * n + i] - tmp[sub * n + i];
    }
  }
  return out;
}

/**
 * Raw channel data for the height texture (Float32, RGBA interleaved). Pure: no GPU objects.
 * R height, G blurred height (~gaussian, 8 m), B ocean distance to shore (m, 0 on land), A 1.
 * Covers every terrain grid (heightExtent): grid vertices are copied exactly (max where grids overlap),
 * the open sea outside them comes from world.heightAt. Returns { data, n (= nx), nx, nz, x0, z0, cell }.
 */
export function bakeHeightData(world) {
  const E = heightExtent(world);
  const { nx, nz, x0, z0, cell } = E;
  const N = nx * nz;
  const H = new Float32Array(N).fill(NaN);
  const grids = world.grids?.length
    ? world.grids
    : [{ heights: world.heights, x0: -world.SIZE / 2, z0: -world.SIZE / 2, cell, cells: world.CELLS, N1: world.CELLS + 1 }];
  for (const g of grids) {
    const oi = (g.x0 - x0) / cell, oj = (g.z0 - z0) / cell;
    if (Math.abs(g.cell - cell) > 1e-6 || Math.abs(oi - Math.round(oi)) > 1e-6 || Math.abs(oj - Math.round(oj)) > 1e-6) continue;
    const i0 = Math.round(oi), j0 = Math.round(oj), N1 = g.N1 ?? g.cells + 1;
    for (let j = 0; j < N1; j++) {
      for (let i = 0; i < N1; i++) {
        const k = (j + j0) * nx + i + i0;
        const h = g.heights[j * N1 + i];
        if (!(H[k] >= h)) H[k] = h;
      }
    }
  }
  for (let j = 0, k = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++, k++) if (Number.isNaN(H[k])) H[k] = world.heightAt ? world.heightAt(x0 + i * cell, z0 + j * cell) : -30;
  }
  const land = new Uint8Array(N);
  for (let k = 0; k < N; k++) land[k] = H[k] >= world.SEA_LEVEL ? 1 : 0;
  let dist = chamferDistance(land, nx, nz);
  dist = boxBlur(dist, nx, 1, nz);
  let blur = boxBlur(H, nx, 2, nz);
  blur = boxBlur(blur, nx, 2, nz);
  const data = new Float32Array(N * 4);
  for (let k = 0; k < N; k++) {
    data[k * 4] = H[k];
    data[k * 4 + 1] = blur[k];
    data[k * 4 + 2] = land[k] ? 0 : Math.min(dist[k] * cell, 400);
    data[k * 4 + 3] = 1;
  }
  return { data, n: nx, nx, nz, x0, z0, cell };
}

/**
 * Bilinear CPU sample of one channel of bakeHeightData() output at world (x, z), matching the GPU
 * sampling through heightXform (texel centers on the grid vertices, clamped at the edges).
 */
export function sampleHeightData(hd, world, x, z, channel) {
  const nx = hd.nx ?? hd.n, nz = hd.nz ?? hd.n;
  const cell = hd.cell ?? world.CELL;
  const x0 = hd.x0 ?? -world.SIZE / 2, z0 = hd.z0 ?? -world.SIZE / 2;
  const fx = Math.min(nx - 1, Math.max(0, (x - x0) / cell));
  const fz = Math.min(nz - 1, Math.max(0, (z - z0) / cell));
  const i0 = Math.min(nx - 2, Math.floor(fx)), j0 = Math.min(nz - 2, Math.floor(fz));
  const tx = fx - i0, tz = fz - j0;
  const d = hd.data;
  const k00 = (j0 * nx + i0) * 4 + channel, k10 = k00 + 4, k01 = k00 + nx * 4, k11 = k01 + 4;
  const a = d[k00] + (d[k10] - d[k00]) * tx;
  const b = d[k01] + (d[k11] - d[k01]) * tx;
  return a + (b - a) * tz;
}

function buildHeightTexture(baked) {
  const { data } = baked;
  const nx = baked.nx ?? baked.n, nz = baked.nz ?? baked.n;
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const tex = new THREE.DataTexture(half, nx, nz, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
