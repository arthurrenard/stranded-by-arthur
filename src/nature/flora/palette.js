// Flora palette (SPEC §9) as linear-space [r,g,b] triplets, ready to bake into vertex colors.
// THREE.Color converts the sRGB hex values into the renderer's linear working space.
import * as THREE from 'three';

/** sRGB hex -> linear [r, g, b]. */
export function lin(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

export const PAL = {
  // foliage
  oakLeaf: lin('#4f8a35'),
  oakLeafLight: lin('#72aa45'),
  oakLeafDark: lin('#386a27'),
  pine: lin('#2f5d3a'),
  pineLight: lin('#447a4a'),
  pineDark: lin('#21452b'),
  birchLeaf: lin('#93bd4c'),
  birchLeafLight: lin('#b4d465'),
  palm: lin('#6fa33c'),
  palmDark: lin('#4c7d29'),
  willow: lin('#86b24d'),
  willowDark: lin('#5f8c37'),
  appleLeaf: lin('#5c9b3b'),
  apple: lin('#c8302a'),
  appleBlush: lin('#d98a2b'),
  chestnutLeaf: lin('#457d2e'),
  catkin: lin('#e3d98f'),
  sapling: lin('#6aa843'),
  // bark & wood
  bark: lin('#6b4f36'),
  barkDark: lin('#4c3826'),
  barkLight: lin('#82654a'),
  barkGrey: lin('#6f655a'),
  birchBark: lin('#e8e4da'),
  birchMark: lin('#2f2b27'),
  palmTrunk: lin('#8f7656'),
  palmTrunkDark: lin('#6c583f'),
  coconut: lin('#5a3f22'),
  snag: lin('#8b8072'),
  snagDark: lin('#5f564b'),
  heartwood: lin('#c9a97a'),
  fungus: lin('#e2c58c'),
  fungusOrange: lin('#d8873a'),
  // ground cover
  rock: lin('#8a847a'),
  rockLight: lin('#a19b90'),
  rockDark: lin('#5d5750'),
  moss: lin('#5f8434'),
  fern: lin('#4e8c34'),
  fernLight: lin('#73ad4a'),
  bush: lin('#467b2e'),
  bushLight: lin('#62993c'),
  blossomWhite: lin('#f4f1e6'),
  blossomPink: lin('#eaa3c0'),
  reed: lin('#7d9d4a'),
  reedDry: lin('#b7a866'),
  cattail: lin('#5b3a20'),
  lily: lin('#4f913b'),
  lilyDark: lin('#3a6f2d'),
  lotusPink: lin('#f0b6cf'),
  lotusWhite: lin('#f7f4ea'),
  // grass (matches terrain tints)
  grass: lin('#6a9a3e'),
  meadow: lin('#8fb84f'),
  forestFloor: lin('#4a6430'),
  dryGrass: lin('#a8a65a'),
  duneGrass: lin('#b9b77a'),
  // meadow flowers: [petal, center]
  flowers: [
    [lin('#f6f3ea'), lin('#f2c230')], // daisy
    [lin('#f4cf2e'), lin('#e09a1c')], // buttercup
    [lin('#9a6fd0'), lin('#f1d35a')], // violet
    [lin('#f08fb3'), lin('#f5df7a')], // pink campion
    [lin('#e23a2c'), lin('#2a1d16')], // poppy
    [lin('#4f7fe0'), lin('#2c3f86')], // cornflower
    [lin('#f2913a'), lin('#c9561f')], // orange marigold
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
