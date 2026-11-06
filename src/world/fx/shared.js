// State shared by the four world modules (sky, weather, terrain, water), memoized per ctx.
// - `uniforms`: one set of uniform objects referenced by several materials, so the sky can
//   update light/sky colors once per frame and every water/terrain shader sees them.
// - `heightTexture()`: the heightfield baked into a HalfFloat RGBA DataTexture
//   (R = ground height, G = blurred height, B = distance to the shore over the ocean, in meters).
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
 * Uniform mapping world xz -> texel-centered uv of the height texture.
 * uv = xz * xform.x + xform.y
 */
export function heightXform(world) {
  const N1 = world.CELLS + 1;
  const scale = 1 / (world.CELL * N1);
  const offset = (world.SIZE / 2 / world.CELL + 0.5) / N1;
  return new THREE.Vector4(scale, offset, 0, 0);
}

/** GLSL helpers to read the height texture. Requires uniforms uHeightTex + uHeightXform. */
export const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeightTex;
uniform vec4 uHeightXform;
vec4 wHeightSample(vec2 xz) {
  return texture2D(uHeightTex, xz * uHeightXform.x + uHeightXform.y);
}
`;

// ── Pure helpers (exported for node tests) ───────────────────────────────

/**
 * Two-pass chamfer distance transform on an n×n grid.
 * seed[k] = 1 for source cells (distance 0). Returns Float32Array of distances in cells.
 */
export function chamferDistance(seed, n) {
  const INF = 1e9;
  const D = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) D[k] = seed[k] ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let j = 0; j < n; j++) {
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
  for (let j = n - 1; j >= 0; j--) {
    for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i;
      let d = D[k];
      if (i < n - 1) d = Math.min(d, D[k + 1] + a);
      if (j < n - 1) {
        d = Math.min(d, D[k + n] + a);
        if (i < n - 1) d = Math.min(d, D[k + n + 1] + b);
        if (i > 0) d = Math.min(d, D[k + n - 1] + b);
      }
      D[k] = d;
    }
  }
  return D;
}

/** Separable box blur (radius r cells, clamped edges), returns a new Float32Array. */
export function boxBlur(src, n, r) {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const w = 2 * r + 1;
  for (let j = 0; j < n; j++) {
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
    for (let j = -r; j <= r; j++) acc += tmp[Math.min(n - 1, Math.max(0, j)) * n + i];
    for (let j = 0; j < n; j++) {
      out[j * n + i] = acc / w;
      const add = Math.min(n - 1, j + r + 1), sub = Math.max(0, j - r);
      acc += tmp[add * n + i] - tmp[sub * n + i];
    }
  }
  return out;
}

/**
 * Raw channel data for the height texture (Float32, RGBA interleaved). Pure: no GPU objects.
 * R height, G blurred height (~gaussian, 8 m), B ocean distance to shore (m, 0 on land), A 1.
 */
export function bakeHeightData(world) {
  const n = world.CELLS + 1;
  const H = world.heights;
  const land = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) land[k] = H[k] >= world.SEA_LEVEL ? 1 : 0;
  let dist = chamferDistance(land, n);
  dist = boxBlur(dist, n, 1);
  let blur = boxBlur(H, n, 2);
  blur = boxBlur(blur, n, 2);
  const data = new Float32Array(n * n * 4);
  for (let k = 0; k < n * n; k++) {
    data[k * 4] = H[k];
    data[k * 4 + 1] = blur[k];
    data[k * 4 + 2] = land[k] ? 0 : Math.min(dist[k] * world.CELL, 400);
    data[k * 4 + 3] = 1;
  }
  return { data, n };
}

/**
 * Bilinear CPU sample of one channel of bakeHeightData() output at world (x, z), matching the GPU
 * sampling through heightXform (texel centers on the grid vertices, clamped at the edges).
 */
export function sampleHeightData(hd, world, x, z, channel) {
  const n = hd.n;
  const fx = Math.min(n - 1, Math.max(0, (x + world.SIZE / 2) / world.CELL));
  const fz = Math.min(n - 1, Math.max(0, (z + world.SIZE / 2) / world.CELL));
  const i0 = Math.min(n - 2, Math.floor(fx)), j0 = Math.min(n - 2, Math.floor(fz));
  const tx = fx - i0, tz = fz - j0;
  const d = hd.data;
  const k00 = (j0 * n + i0) * 4 + channel, k10 = k00 + 4, k01 = k00 + n * 4, k11 = k01 + 4;
  const a = d[k00] + (d[k10] - d[k00]) * tx;
  const b = d[k01] + (d[k11] - d[k01]) * tx;
  return a + (b - a) * tz;
}

function buildHeightTexture(baked) {
  const { data, n } = baked;
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) half[i] = THREE.DataUtils.toHalfFloat(data[i]);
  const tex = new THREE.DataTexture(half, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
