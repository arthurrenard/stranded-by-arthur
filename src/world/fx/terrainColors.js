// Terrain vertex color model: biome weights -> color. Pure math (node-testable).
// Colors are blended in sRGB (perceptually nicer) and converted to linear at the end,
// because three.js treats vertex colors as linear.

const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

// SPEC §9 palette + a few derived tones
export const PAL = {
  sand: hex(0xe8d6a8),
  sandDune: hex(0xdcc797),
  wetSand: hex(0xc9b48a),
  grass: hex(0x6a9a3e),
  grassLush: hex(0x5c9236),
  grassDry: hex(0x8d9c48),
  meadow: hex(0x8fb84f),
  meadowGold: hex(0xa4bd55),
  forest: hex(0x4a6430),
  forestLitter: hex(0x5b5532),
  wetGrass: hex(0x4b7d33),
  mud: hex(0x6b5a40),
  highland: hex(0x7d8c52),
  pineFloor: hex(0x445a33),
  rock: hex(0x8a847a),
  darkRock: hex(0x5d5750),
  lightRock: hex(0x9d978c),
  seabedShallow: hex(0xc4b083),
  seabedMid: hex(0x7d8a72),
  seabedDeep: hex(0x34504f),
  lakebed: hex(0x5d5639),
  lakebedDeep: hex(0x3a3d2c),
  riverbed: hex(0x80776a),
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
function mixInto(c, p, t) {
  if (t <= 0) return;
  if (t > 1) t = 1;
  c[0] += (p[0] - c[0]) * t;
  c[1] += (p[1] - c[1]) * t;
  c[2] += (p[2] - c[2]) * t;
}
export const srgbToLinear = (c) => (c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));

const _a = [0, 0, 0];
const _b = [0, 0, 0];

/**
 * Compute a vertex color.
 * @param b biomeAt() result { h, slope, rn, water, sand, rock, highland, meadow, wet, forest }
 * @param n1,n2,n3 noise values in -1..1 (low, mid, high frequency)
 * @param shoreDelta height above the nearest fresh water surface (m) or Infinity
 * @param out [r,g,b] LINEAR output
 */
export function terrainColor(b, n1, n2, n3, shoreDelta, out) {
  const c = out;
  const h = b.h;
  // grass base: lush/dry patches
  c[0] = PAL.grass[0];
  c[1] = PAL.grass[1];
  c[2] = PAL.grass[2];
  mixInto(c, n1 > 0 ? PAL.grassDry : PAL.grassLush, Math.abs(n1) * 0.7);
  // meadow (lighter, a touch golden)
  _a[0] = PAL.meadow[0]; _a[1] = PAL.meadow[1]; _a[2] = PAL.meadow[2];
  mixInto(_a, PAL.meadowGold, clamp01(n2 * 0.8 + 0.3));
  mixInto(c, _a, b.meadow * 0.95);
  // forest floor with leaf litter
  _a[0] = PAL.forest[0]; _a[1] = PAL.forest[1]; _a[2] = PAL.forest[2];
  mixInto(_a, PAL.forestLitter, clamp01(n2 * 0.9 + 0.1) * 0.6);
  mixInto(c, _a, b.forest * 0.8);
  // highlands: olive, pine-needle floor where forested
  _a[0] = PAL.highland[0]; _a[1] = PAL.highland[1]; _a[2] = PAL.highland[2];
  mixInto(_a, PAL.pineFloor, b.forest * 0.7);
  mixInto(c, _a, b.highland * 0.75);
  // lush near lakes/river, mud right at the waterline
  mixInto(c, PAL.wetGrass, b.wet * 0.55);
  if (shoreDelta < 1.6) mixInto(c, PAL.mud, sstep(1.6, 0.25, shoreDelta) * 0.85);
  // beach sand, wet near the sea
  if (b.sand > 0) {
    _a[0] = PAL.sand[0]; _a[1] = PAL.sand[1]; _a[2] = PAL.sand[2];
    mixInto(_a, PAL.sandDune, clamp01(n2 * 0.5 + 0.5) * 0.6);
    mixInto(_a, PAL.wetSand, sstep(0.95, 0.2, h));
    mixInto(c, _a, b.sand);
  }
  // rock on slopes and the summit; flat summit spots keep some highland grass
  let rock = b.rock;
  if (rock > 0) {
    const flat = sstep(0.18, 0.05, b.slope);
    rock *= 1 - 0.5 * flat * clamp01(n1 * 1.2 + 0.4);
    _b[0] = PAL.rock[0]; _b[1] = PAL.rock[1]; _b[2] = PAL.rock[2];
    mixInto(_b, n3 > 0 ? PAL.lightRock : PAL.darkRock, Math.abs(n3) * 0.8 + sstep(0.45, 0.8, b.slope) * 0.3);
    mixInto(c, _b, rock);
  }
  // under water
  const w = b.water;
  if (w) {
    const d = w.depth;
    if (w.type === 'ocean') {
      _a[0] = PAL.wetSand[0]; _a[1] = PAL.wetSand[1]; _a[2] = PAL.wetSand[2];
      mixInto(_a, PAL.seabedShallow, sstep(0.0, 1.5, d));
      mixInto(_a, PAL.seabedMid, sstep(1.5, 9, d));
      mixInto(_a, PAL.seabedDeep, sstep(8, 24, d));
      mixInto(c, _a, sstep(0.0, 0.35, d) * (1 - rock * 0.5));
    } else if (w.type === 'river') {
      _a[0] = PAL.riverbed[0]; _a[1] = PAL.riverbed[1]; _a[2] = PAL.riverbed[2];
      mixInto(_a, n3 > 0 ? PAL.lightRock : PAL.mud, Math.abs(n3) * 0.5);
      mixInto(c, _a, sstep(0.0, 0.4, d));
    } else {
      _a[0] = PAL.lakebed[0]; _a[1] = PAL.lakebed[1]; _a[2] = PAL.lakebed[2];
      mixInto(_a, PAL.lakebedDeep, sstep(0.5, 4.5, d));
      mixInto(c, _a, sstep(0.0, 0.5, d));
    }
  }
  // gentle brightness variation
  const v = 1 + n3 * 0.035 + n1 * 0.03;
  c[0] = srgbToLinear(clamp01(c[0] * v));
  c[1] = srgbToLinear(clamp01(c[1] * v));
  c[2] = srgbToLinear(clamp01(c[2] * v));
  return c;
}
