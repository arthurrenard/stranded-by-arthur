// Seeded random numbers. createRng(seed) returns a callable () => [0,1) with helpers,
// so it can be passed straight to simplex-noise's createNoise2D(rng).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed) {
  const r = mulberry32(seed);
  const rng = () => r();
  rng.range = (a, b) => a + (b - a) * r();
  rng.int = (a, b) => Math.floor(a + (b - a + 1) * r()); // inclusive
  rng.pick = (arr) => arr[Math.floor(r() * arr.length)];
  rng.chance = (p) => r() < p;
  rng.sign = () => (r() < 0.5 ? -1 : 1);
  /** Independent child stream; use a distinct salt per module so modules don't disturb each other. */
  rng.fork = (salt) => createRng((seed * 2654435761 + hashString(String(salt))) >>> 0);
  return rng;
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
