// Ocean wave model shared by the GPU (generated GLSL) and the CPU (exact JS mirror), so the camera's
// underwater test and anything floating (ctx.water.waveHeightAt) agree with what is drawn.
// Pure module: no THREE, no DOM.
//
// Model: 4 Gerstner waves aligned with the wind (vertex displacement + normals) and 5 short
// "capillary" waves that only perturb the normal (sparkle). Amplitudes are in meters at uWave = 1 and
// are scaled by wOceanAmp() (small near the shore / in shallows) and by the weather (uWave).
// Each wave fades out with distance to the camera before the mesh/pixels would alias it.

const TAU = Math.PI * 2;
const G = 9.81;

/** off: radians from the wind direction, L: wavelength (m), A: amplitude (m), Q: Gerstner steepness. */
export const OCEAN_WAVES = [
  { off: 0.0, L: 38, A: 0.25, Q: 1.1, ph: 0.0 },
  { off: 0.49, L: 21, A: 0.155, Q: 1.0, ph: 1.7 },
  { off: -0.61, L: 13, A: 0.088, Q: 0.9, ph: 4.1 },
  { off: 1.13, L: 7.5, A: 0.045, Q: 0.8, ph: 2.6 },
];
/** Sum of the Gerstner amplitudes: crest height at amp = 1. */
export const OCEAN_AMP_SUM = OCEAN_WAVES.reduce((s, w) => s + w.A, 0);

export const DETAIL_WAVES = [
  { off: 0.26, L: 4.1, A: 0.03, ph: 0.3 },
  { off: -0.7, L: 2.7, A: 0.02, ph: 2.2 },
  { off: 1.22, L: 1.7, A: 0.012, ph: 5.1 },
  { off: -1.75, L: 1.1, A: 0.007, ph: 1.4 },
  { off: 2.6, L: 0.73, A: 0.0045, ph: 3.9 },
];

// vertex displacement fade (mesh resolution) and normal fade (pixel footprint), as multiples of L
const DISP_FADE = [5.5, 10];
const NORM_FADE = [30, 90];
const DETAIL_FADE = [14, 45];

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const f = (x) => {
  const s = Number(x).toFixed(6);
  return s.includes('.') ? s : s + '.0';
};
const derive = (w) => {
  const k = TAU / w.L;
  return { ...w, k, om: Math.sqrt(G * k), c: Math.cos(w.off), s: Math.sin(w.off) };
};
const OW = OCEAN_WAVES.map(derive);
const DW = DETAIL_WAVES.map(derive);

/** Amplitude factor from the distance to the shore (m) and the water depth (m). Mirrors wOceanAmp(). */
export function oceanAmp(shore, depth) {
  return (0.2 + 0.8 * smooth(3, 90, shore)) * (0.3 + 0.7 * smooth(0, 4, depth));
}

/**
 * CPU mirror of wWaveDisp(): displacement of the surface point whose rest position is (x, z).
 * out = { x, y, z } (meters). amp already includes uWave and oceanAmp().
 */
export function waveDisp(x, z, t, amp, wdx, wdz, dist, out) {
  let rx = 0, ry = 0, rz = 0;
  for (let i = 0; i < OW.length; i++) {
    const w = OW[i];
    const dx = wdx * w.c - wdz * w.s, dz = wdx * w.s + wdz * w.c;
    const a = w.A * amp * (1 - smooth(w.L * DISP_FADE[0], w.L * DISP_FADE[1], dist));
    const th = w.k * (dx * x + dz * z) - w.om * t + w.ph;
    const sn = Math.sin(th), cs = Math.cos(th);
    rx += dx * (w.Q * a * cs);
    rz += dz * (w.Q * a * cs);
    ry += a * sn;
  }
  out.x = rx;
  out.y = ry;
  out.z = rz;
  return out;
}

/**
 * Surface height offset at world (x, z): solves rest + disp(rest) = (x, z) with two fixed-point steps,
 * so the horizontal Gerstner shift is taken into account. ampAt(x, z) returns the local amplitude.
 */
export function waveHeight(x, z, t, ampAt, wdx, wdz, dist, tmp) {
  let px = x, pz = z;
  for (let it = 0; it < 2; it++) {
    waveDisp(px, pz, t, ampAt(px, pz), wdx, wdz, dist, tmp);
    px = x - tmp.x;
    pz = z - tmp.z;
  }
  waveDisp(px, pz, t, ampAt(px, pz), wdx, wdz, dist, tmp);
  return tmp.y;
}

function rot(w) {
  return `vec2(wd.x * ${f(w.c)} - wd.y * ${f(w.s)}, wd.x * ${f(w.s)} + wd.y * ${f(w.c)})`;
}

/** GLSL: wOceanAmp, wWaveDisp, wWaveNormal, wDetailNormal (no uniforms; pure functions). */
export function wavesGLSL() {
  let disp = '', norm = '', det = '';
  for (const w of OW) {
    disp += `
  {
    vec2 d = ${rot(w)};
    float a = ${f(w.A)} * amp * (1.0 - smoothstep(${f(w.L * DISP_FADE[0])}, ${f(w.L * DISP_FADE[1])}, dist));
    float th = ${f(w.k)} * dot(d, p) - ${f(w.om)} * t + ${f(w.ph)};
    float sn = sin(th);
    float cs = cos(th);
    r.xz += d * (${f(w.Q)} * a * cs);
    r.y += a * sn;
  }`;
    norm += `
  {
    vec2 d = ${rot(w)};
    float a = ${f(w.A)} * amp * (1.0 - smoothstep(${f(w.L * NORM_FADE[0])}, ${f(w.L * NORM_FADE[1])}, dist));
    float th = ${f(w.k)} * dot(d, p) - ${f(w.om)} * t + ${f(w.ph)};
    float ka = ${f(w.k)} * a;
    n.xz -= d * (ka * cos(th));
    n.y -= ${f(w.Q)} * ka * sin(th);
  }`;
  }
  for (const w of DW) {
    det += `
  {
    vec2 d = ${rot(w)};
    float a = ${f(w.A)} * detail * (1.0 - smoothstep(${f(w.L * DETAIL_FADE[0])}, ${f(w.L * DETAIL_FADE[1])}, dist));
    float th = ${f(w.k)} * dot(d, p) - ${f(w.om)} * t + ${f(w.ph)};
    n.xz -= d * (${f(w.k)} * a * cos(th));
  }`;
  }
  return /* glsl */ `
float wOceanAmp(float shore, float depth) {
  return (0.2 + 0.8 * smoothstep(3.0, 90.0, shore)) * (0.3 + 0.7 * smoothstep(0.0, 4.0, depth));
}
vec3 wWaveDisp(vec2 p, float t, float amp, vec2 wd, float dist) {
  vec3 r = vec3(0.0);${disp}
  return r;
}
vec3 wDetailNormalRaw(vec2 p, float t, float detail, vec2 wd, float dist, vec3 n) {${det}
  return n;
}
vec3 wWaveNormal(vec2 p, float t, float amp, float detail, vec2 wd, float dist) {
  vec3 n = vec3(0.0, 1.0, 0.0);${norm}
  return normalize(wDetailNormalRaw(p, t, detail, wd, dist, n));
}
vec3 wDetailNormal(vec2 p, float t, float detail, vec2 wd, float dist) {
  return normalize(wDetailNormalRaw(p, t, detail, wd, dist, vec3(0.0, 1.0, 0.0)));
}
`;
}

/**
 * Camera-centered polar grid for the ocean (rest positions, y = 0). Rings grow geometrically:
 * ~0.6 m spacing under the camera, tens of meters at the horizon. Triangles face +Y.
 * Returns { positions: Float32Array, indices: Uint32Array, rings, segments }.
 */
export function buildPolarGrid(maxR = 2450, segments = 192, growth = 0.045, first = 0.6) {
  const radii = [0];
  while (radii[radii.length - 1] < maxR) {
    const r = radii[radii.length - 1];
    radii.push(Math.min(maxR, r * (1 + growth) + first));
  }
  const rings = radii.length;
  const positions = new Float32Array((1 + (rings - 1) * segments) * 3);
  // vertex 0: the center; ring i >= 1 starts at 1 + (i - 1) * segments
  let v = 1;
  for (let i = 1; i < rings; i++) {
    const r = radii[i];
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      positions[v * 3] = Math.cos(a) * r;
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = Math.sin(a) * r;
      v++;
    }
  }
  const tris = segments + (rings - 2) * segments * 2;
  const indices = new Uint32Array(tris * 3);
  let p = 0;
  for (let j = 0; j < segments; j++) {
    const j1 = (j + 1) % segments;
    indices[p++] = 0;
    indices[p++] = 1 + j1;
    indices[p++] = 1 + j;
  }
  for (let i = 1; i < rings - 1; i++) {
    const a0 = 1 + (i - 1) * segments, b0 = 1 + i * segments;
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      const ia = a0 + j, ib = a0 + j1, oa = b0 + j, ob = b0 + j1;
      indices[p++] = ia;
      indices[p++] = ob;
      indices[p++] = oa;
      indices[p++] = ia;
      indices[p++] = ib;
      indices[p++] = ob;
    }
  }
  return { positions, indices, rings, segments, radii };
}
