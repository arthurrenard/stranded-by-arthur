// Flora palette (SPEC §9) as linear-space [r,g,b] triplets, ready to bake into vertex colors.
// THREE.Color converts the sRGB hex values into the renderer's linear working space.
import * as THREE from 'three';

/** sRGB hex -> linear [r, g, b]. */
export function lin(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

// V4-D art pass: per-species, less saturated, more natural greens (olive oak, sage willow, deep spruce,
// autumn-tinged birch accents), darker trunks, softer flower pigments. Keys are stable (imported by name).
export const PAL = {
  // foliage
  oakLeaf: lin('#5a7a3c'), // olive
  oakLeafLight: lin('#7d9650'),
  oakLeafDark: lin('#3d5a2d'),
  pine: lin('#2e4a3a'), // deep spruce
  pineLight: lin('#45614c'),
  pineDark: lin('#203628'),
  birchLeaf: lin('#97a256'), // yellow-green
  birchLeafLight: lin('#c0a85c'), // autumn-tinged accent
  palm: lin('#6f8c46'),
  palmDark: lin('#4c6634'),
  willow: lin('#86985c'), // sage
  willowDark: lin('#5e7244'),
  appleLeaf: lin('#5e7f40'),
  apple: lin('#b5402f'),
  appleBlush: lin('#c98b3c'),
  chestnutLeaf: lin('#4c6a33'),
  catkin: lin('#d6cc94'),
  sapling: lin('#6e8c48'),
  // bark & wood (darker, warmer)
  bark: lin('#58412f'),
  barkDark: lin('#3b2b20'),
  barkLight: lin('#725943'),
  barkGrey: lin('#5d564e'),
  birchBark: lin('#dcd5c6'),
  birchMark: lin('#2c2824'),
  palmTrunk: lin('#86704f'),
  palmTrunkDark: lin('#5e4c37'),
  coconut: lin('#553d24'),
  snag: lin('#7f7569'),
  snagDark: lin('#554d44'),
  heartwood: lin('#c4a477'),
  fungus: lin('#d9bf8c'),
  fungusOrange: lin('#c9823e'),
  // ground cover
  rock: lin('#8a8378'),
  rockLight: lin('#a39b8d'),
  rockDark: lin('#57514a'),
  moss: lin('#5b7038'),
  fern: lin('#55793c'),
  fernLight: lin('#76914f'),
  bush: lin('#4a6936'),
  bushLight: lin('#66824a'),
  blossomWhite: lin('#efeadc'),
  blossomPink: lin('#dda2b6'),
  reed: lin('#7e8d50'),
  reedDry: lin('#ad9f6a'),
  cattail: lin('#57391f'),
  lily: lin('#557d40'),
  lilyDark: lin('#3d5c30'),
  lotusPink: lin('#e6b3c4'),
  lotusWhite: lin('#f2eee2'),
  // grass (matches terrain tints, src/world/fx/terrainColors.js)
  grass: lin('#718b50'),
  meadow: lin('#8e9b5c'),
  forestFloor: lin('#4d5a37'),
  dryGrass: lin('#a59a5e'),
  duneGrass: lin('#b2aa7c'),
  // meadow flowers: [petal, center]
  flowers: [
    [lin('#f1ece0'), lin('#e2b63a')], // daisy
    [lin('#e6c24a'), lin('#cf9228')], // buttercup
    [lin('#8a70bc'), lin('#e6cb62')], // violet
    [lin('#de92ad'), lin('#ecd683')], // pink campion
    [lin('#cc4a3a'), lin('#2a1d16')], // poppy
    [lin('#5c7fc8'), lin('#2f4079')], // cornflower
    [lin('#de904c'), lin('#b9582a')], // orange marigold
  ],
};

/** Multiply a color by k with a little random jitter (rng in [0,1)). Returns a new array. */
export function jit(c, rng, amount = 0.08, k = 1) {
  const j = 1 + (rng() - 0.5) * 2 * amount;
  return [c[0] * k * j, c[1] * k * j, c[2] * k * j];
}

/** Linear blend of two colors. */
export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Scale a color. */
export function mul(c, k) {
  return [c[0] * k, c[1] * k, c[2] * k];
}
