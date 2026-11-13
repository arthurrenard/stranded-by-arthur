// Tempest Isle pure logic (V3-B): no THREE, no DOM, so node tests can import it.
// Loot tables, hut contents per plan, rockfall timing, the hut's local frame, lore text.

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── Fishing (vegetarian: you never catch a fish) ─────────────────────────
/** Catch table: p sums to 1. n = [min, max]. 'message' = a message in a bottle (a bottle + a lore toast). */
export const FISHING_LOOT = [
  { id: 'old_boot', p: 0.3, n: [1, 1] },
  { id: 'wood', p: 0.2, n: [1, 2] },
  { id: 'rope', p: 0.12, n: [1, 1] },
  { id: 'bottle_empty', p: 0.12, n: [1, 1] },
  { id: 'cloth', p: 0.1, n: [1, 1] },
  { id: 'hull_plank', p: 0.08, n: [1, 1] },
  { id: 'message', p: 0.08, n: [1, 1], item: 'bottle_empty' },
];
export const BITE_DELAY = [4, 12]; // seconds until something tugs at the line
export const CAST_RANGE = [2.5, 13]; // m from the eye to where the float lands

/** Seconds to wait for a bite, from r in [0, 1). */
export function biteDelay(r) {
  return BITE_DELAY[0] + (BITE_DELAY[1] - BITE_DELAY[0]) * clamp01(r);
}

/** The catch for r in [0, 1): an entry of FISHING_LOOT. */
export function rollCatch(r) {
  let acc = 0;
  for (const e of FISHING_LOOT) {
    acc += e.p;
    if (r < acc) return e;
  }
  return FISHING_LOOT[FISHING_LOOT.length - 1];
}

/** Lore found in bottles, in order (then random). */
export const BOTTLE_MESSAGES = [
  '"To whoever finds this: the storms here come in under thirty seconds. Watch the sky to the east. — M."',
  '"Day 40. The fisherman never came back from the summit. His lantern still burns some nights. Who keeps lighting it?"',
  '"If the raft flips, swim AWAY from it until the wind drops. It rights easier in calm water."',
  '"Marguerite crew, if any of you made it: the helicopter only flies over the big island. Make smoke. Or make a boat."',
  '"Grandma\'s recipe: bananas, coconut, a pinch of sea salt. Still the best thing on these rocks."',
];

// ── The fishing hut ───────────────────────────────────────────────────────
/** Raft parts the hut holds for a plan: [{ id }] (one entry per piece), from CONFIG.raft.parts[id].where === 'isle2hut'. */
export function hutParts(raftCfg, plan) {
  const out = [];
  const parts = raftCfg?.parts || {};
  for (const id in parts) {
    if (parts[id].where !== 'isle2hut') continue;
    const n = parts[id].count?.[plan] || 0;
    for (let k = 0; k < n; k++) out.push({ id });
  }
  return out;
}

/** Everything "Search the shelves" gives: [{ id, n, part? }]. */
export function hutContents(raftCfg, plan) {
  const out = [
    { id: 'fishing_rod', n: 2 },
    { id: 'boat_key', n: 1 },
    { id: 'fuel_can', n: 1 },
  ];
  const counts = {};
  for (const p of hutParts(raftCfg, plan)) counts[p.id] = (counts[p.id] || 0) + 1;
  for (const id in counts) out.push({ id, n: counts[id], part: true });
  return out;
}

/** Hut size (m) in its local frame: u = toward the door (front wall at u = +D/2), v = sideways. */
export const HUT = {
  W: 5.0, // along v (side to side; the roof ridge runs along v)
  D: 4.0, // along u (back wall to front wall)
  wallH: 2.3,
  ridgeH: 3.35,
  wallT: 0.16,
  door: { v0: -1.45, v1: -0.35, h: 1.98 },
  window: { v0: 1.0, v1: 1.8, y0: 1.0, y1: 1.72 },
};

/** Local (u, v) of a world point relative to a hut { x, z, fx, fz } (f = unit vector toward the door). */
export function hutLocal(hut, x, z) {
  const dx = x - hut.x, dz = z - hut.z;
  return { u: dx * hut.fx + dz * hut.fz, v: dx * hut.fz - dz * hut.fx };
}
/** World (x, z) of hut-local (u, v). Inverse of hutLocal. */
export function hutWorld(hut, u, v) {
  return { x: hut.x + u * hut.fx + v * hut.fz, z: hut.z + u * hut.fz - v * hut.fx };
}
/** Inside the walls (inner surface minus a small margin). */
export function insideHut(hut, x, z, margin = 0.05) {
  const dx = x - hut.x, dz = z - hut.z; // inline (no allocation: called every frame by weather / structures)
  const u = dx * hut.fx + dz * hut.fz, v = dx * hut.fz - dz * hut.fx;
  const hu = HUT.D / 2 - HUT.wallT / 2 - margin, hv = HUT.W / 2 - HUT.wallT / 2 - margin;
  return Math.abs(u) <= hu && Math.abs(v) <= hv;
}

/** Bunk hours: 19:00 – 05:00. */
export const canSleepAt = (hour) => hour >= 19 || hour < 5;

/** The burn, for fun. */
export const BURN = {
  seconds: 70, // flames
  smolder: 90, // seconds of thin smoke after the flames die
  confirmSec: 4, // second R within this
  collapseAt: 50, // the roof falls in
  damagePerSec: 9, // standing inside while it burns (x difficulty damageMul, applied by stats)
  heatRadius: 11,
};
/** 0..1 flame intensity over the burn (catches, roars, dies down). */
export function burnIntensity(t) {
  if (t <= 0) return 0;
  if (t < 12) return 0.25 + 0.75 * (t / 12);
  if (t < BURN.seconds - 15) return 1;
  if (t < BURN.seconds) return Math.max(0.15, (BURN.seconds - t) / 15);
  return 0;
}

/** Logbook pages ("Read the logbook"), shown one per press. */
export function logbookPages(hasCompass) {
  return [
    'Logbook, page 1: "They call this rock Tempest Isle, and now I know why. The storms come in fast, out of a clear sky. Never stay on open water when the wind turns."',
    'Page 2: "Hail like gravel today. It bent the pines flat. The wind snuffs any fire left outside, but the hearth in here never goes out. Stay indoors."',
    'Page 3: "The boat key hangs by the door. There\'s a full jerrycan on the shelf: the outboard needs one can to start. Don\'t lose the key."',
    hasCompass
      ? 'Page 4: "Left my brass compass on the shelf. If you\'re reading this, take it. You\'ll need it to find home. And watch for loose rocks on the climb."'
      : 'Page 4: "Lost my brass compass somewhere on the big island. The motorboat will get you out to open water anyway. Mind the loose rocks on the climb."',
  ];
}

// ── Rockfall ──────────────────────────────────────────────────────────────
export const ROCKFALL = {
  minHeight: 35, // m: only above this on Tempest Isle
  minSlope: 0.3, // only on steep slopes (world.slopeAt)
  delay: [20, 60], // s between rockfalls (calm)
  stormMul: 0.5, // at full storm the delay is halved
  damage: [15, 25],
  rocks: [2, 4], // boulders per rockfall
  spawnDist: [26, 44], // m upslope of the player
  life: 14, // s a boulder rolls at most
};
/** Seconds until the next rockfall, from r in [0, 1) and the local storm intensity 0..1. */
export function nextRockfallDelay(r, storm = 0) {
  const [a, b] = ROCKFALL.delay;
  return (a + (b - a) * clamp01(r)) * (1 - ROCKFALL.stormMul * clamp01(storm));
}
/** Damage of a direct hit, from r in [0, 1). */
export function rockDamage(r) {
  const [a, b] = ROCKFALL.damage;
  return Math.round(a + (b - a) * clamp01(r));
}
