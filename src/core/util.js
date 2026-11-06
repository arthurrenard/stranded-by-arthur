// Small math helpers shared by every module. Pure functions only.
export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (v - a) / (b - a);
/** Hermite smoothstep. Works with e0 > e1 (reversed ramp). */
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
/** Shortest signed angle difference a->b in radians. */
export const angleDiff = (a, b) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};
/** Fractal noise; noise2D is a simplex-noise createNoise2D() function. Returns roughly -1..1. */
export function fbm(noise2D, x, z, octaves = 4, freq = 0.01, lacunarity = 2, gain = 0.5) {
  let amp = 1, sum = 0, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2D(x * f, z * f);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}
/** Deterministic hash of two numbers -> [0,1). Good for per-position variation. */
export function hash2(x, z, seed = 0) {
  let h = Math.imul((x * 73856093) ^ (z * 19349663) ^ (seed * 83492791), 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
/** Format in-game hour (float) as "HH:MM". */
export function fmtHour(h) {
  const hh = Math.floor(((h % 24) + 24) % 24);
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
