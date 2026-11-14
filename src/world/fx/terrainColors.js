// Terrain vertex color model: biome weights -> color. Pure math (node-testable).
// Colors are blended in sRGB (perceptually nicer) and converted to linear at the end,
// because three.js treats vertex colors as linear.
//
// V4-D art pass: a muted, warm, hand-painted palette (sage / olive / straw instead of mint), with
//   - three noise scales (broad ~300 m regions: cool sage vs warm olive; ~80 m lush/dry; ~20 m clumps),
//   - straw-dry grass on sun-facing slopes (the sun path always leans toward +z, see core/clock.js),
//   - a dusty worn-sand fringe where the grass meets the beach,
//   - damp dark green near fresh water (and under the canopy: terrain.js applies DAMP at init),
//   - slope + concavity AO so gullies and steep faces read darker, ridges a touch sun-bleached.
// Grass swatches stay at HSV saturation <= 0.45 (tests/aesthetics.test.mjs).

const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

// sRGB swatches (keys kept stable: other modules import PAL by name)
export const PAL = {
  sand: hex(0xe0cfa3),
  sandDune: hex(0xd3bf92),
  sandWorn: hex(0xb3a27a), // dusty trodden fringe between grass and beach
  wetSand: hex(0xb8a37f),
  grass: hex(0x718b50), // sage-olive base
  grassLush: hex(0x5e7c47),
  grassDry: hex(0x9c9459), // straw-olive (sunny slopes)
  grassSage: hex(0x6c8a5f), // cool broad regions
  meadow: hex(0x8e9b5c),
  meadowGold: hex(0xb2a566),
  forest: hex(0x4d5a37),
  forestLitter: hex(0x665839),
  wetGrass: hex(0x4b6640),
  damp: hex(0x3d5034), // under the canopy (terrain.js)
  mud: hex(0x5c4e3c),
  highland: hex(0x7e8558),
  pineFloor: hex(0x4b5236),
  rock: hex(0x8a8378),
  darkRock: hex(0x57514a),
  lightRock: hex(0xa39b8d),
  crevice: hex(0x3a3830),
  seabedShallow: hex(0xc2ae84),
  seabedMid: hex(0x7a8670),
  seabedDeep: hex(0x324c4c),
  lakebed: hex(0x5a5339),
  lakebedDeep: hex(0x383b2c),
  riverbed: hex(0x7d7568),
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
const set3 = (c, p) => {
  c[0] = p[0];
  c[1] = p[1];
  c[2] = p[2];
};
export const srgbToLinear = (c) => (c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));

/** HSV saturation of an sRGB triplet (0..1). Used by the palette tests. */
export function hsvSat(c) {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  return mx <= 0 ? 0 : (mx - mn) / mx;
}

const _a = [0, 0, 0];
const _b = [0, 0, 0];
const NO_EXT = { n0: 0, sun: 0, cav: 0 };

/**
 * Compute a vertex color.
 * @param b biomeAt() result { h, slope, rn, water, sand, rock, highland, meadow, wet, forest }
 * @param n1,n2,n3 noise values in -1..1 (low, mid, high frequency)
 * @param shoreDelta height above the nearest fresh water surface (m) or Infinity
 * @param out [r,g,b] LINEAR output
 * @param ext optional { n0 broad noise -1..1, sun -1..1 (sun-facing aspect), cav concavity in m (+ = gully) }
 */
export function terrainColor(b, n1, n2, n3, shoreDelta, out, ext = NO_EXT) {
  const c = out;
  const h = b.h;
  const n0 = ext.n0 || 0, sun = ext.sun || 0, cav = ext.cav || 0;
  // grass base: broad cool-sage / warm-olive regions, then lush/dry patches
  set3(c, PAL.grass);
  mixInto(c, n0 < 0 ? PAL.grassSage : PAL.grassDry, Math.abs(n0) * 0.45);
  mixInto(c, n1 > 0 ? PAL.grassDry : PAL.grassLush, Math.abs(n1) * 0.55);
  // sun-baked straw on slopes facing the sun (not where it's wet)
  mixInto(c, PAL.grassDry, sstep(0.08, 0.6, sun) * (0.35 + 0.25 * (n2 * 0.5 + 0.5)) * (1 - b.wet));
  // meadow (lighter, a touch golden)
  set3(_a, PAL.meadow);
  mixInto(_a, PAL.meadowGold, clamp01(n2 * 0.8 + 0.3 + sun * 0.3));
  mixInto(c, _a, b.meadow * 0.9);
  // forest floor with leaf litter
  set3(_a, PAL.forest);
  mixInto(_a, PAL.forestLitter, clamp01(n2 * 0.9 + 0.1) * 0.6);
  mixInto(c, _a, b.forest * 0.8);
  // highlands: olive, pine-needle floor where forested
  set3(_a, PAL.highland);
  mixInto(_a, PAL.pineFloor, b.forest * 0.7);
  mixInto(c, _a, b.highland * 0.75);
  // damp deep green near lakes/river, mud right at the waterline
  mixInto(c, PAL.wetGrass, b.wet * 0.6);
  if (shoreDelta < 4) mixInto(c, PAL.wetGrass, sstep(4, 1.2, shoreDelta) * 0.45);
  if (shoreDelta < 1.6) mixInto(c, PAL.mud, sstep(1.6, 0.25, shoreDelta) * 0.85);
  // beach sand, with a dusty worn fringe where the grass gives way, wet near the sea
  if (b.sand > 0) {
    const fringe = sstep(0.0, 0.3, b.sand) * (1 - sstep(0.5, 0.9, b.sand));
    mixInto(c, PAL.sandWorn, fringe * clamp01(n2 * 0.7 + 0.65) * 0.75);
    set3(_a, PAL.sand);
    mixInto(_a, PAL.sandDune, clamp01(n2 * 0.5 + 0.5) * 0.6);
    mixInto(_a, PAL.wetSand, sstep(0.95, 0.2, h));
    mixInto(c, _a, b.sand);
  }
  // rock on slopes and the summit; flat summit spots keep some highland grass
  let rock = b.rock;
  if (rock > 0) {
    const flat = sstep(0.18, 0.05, b.slope);
    rock *= 1 - 0.5 * flat * clamp01(n1 * 1.2 + 0.4);
    set3(_b, PAL.rock);
    mixInto(_b, n3 > 0 ? PAL.lightRock : PAL.darkRock, Math.abs(n3) * 0.8 + sstep(0.45, 0.8, b.slope) * 0.3);
    mixInto(c, _b, rock);
  }
  // under water
  const w = b.water;
  if (w) {
    const d = w.depth;
    if (w.type === 'ocean') {
      set3(_a, PAL.wetSand);
      mixInto(_a, PAL.seabedShallow, sstep(0.0, 1.5, d));
      mixInto(_a, PAL.seabedMid, sstep(1.5, 9, d));
      mixInto(_a, PAL.seabedDeep, sstep(8, 24, d));
      mixInto(c, _a, sstep(0.0, 0.35, d) * (1 - rock * 0.5));
    } else if (w.type === 'river') {
      set3(_a, PAL.riverbed);
      mixInto(_a, n3 > 0 ? PAL.lightRock : PAL.mud, Math.abs(n3) * 0.5);
      mixInto(c, _a, sstep(0.0, 0.4, d));
    } else {
      set3(_a, PAL.lakebed);
      mixInto(_a, PAL.lakebedDeep, sstep(0.5, 4.5, d));
      mixInto(c, _a, sstep(0.0, 0.5, d));
    }
  }
  // AO: gullies and steep faces darker (toward a cool crevice tone), ridges slightly sun-bleached
  const ao = clamp01(cav * 0.55) * 0.42 + sstep(0.3, 0.85, b.slope) * 0.14;
  if (ao > 0) mixInto(c, PAL.crevice, ao);
  // value variation on three scales (broad, patch, clump)
  const v = 1 + n0 * 0.04 + n1 * 0.035 + n3 * 0.04 + clamp01(-cav * 0.5) * 0.05;
  c[0] = srgbToLinear(clamp01(c[0] * v));
  c[1] = srgbToLinear(clamp01(c[1] * v));
  c[2] = srgbToLinear(clamp01(c[2] * v));
  return c;
}
