// Pure structure logic (Builder E): fuel math, rain exposure + dousing, signal strengths, the sleep
// window, the cooking queue, the SOS stone layout and placement candidates.
// No THREE / DOM: unit-tested in tests/structures.test.mjs. All tunables that are not in CONFIG live in K.

export const K = {
  // Rain
  rainBurnExtra: 1.5, // fuel burns (1 + rain * this) times faster in full rain
  shelterRainCover: 0.85, // a fire next to a lean-to only feels 15 % of the rain
  canopyRainCover: 0.6, // full canopy blocks 60 % of the rain
  douseRainMin: 0.55, // effective rain above this slowly douses a campfire
  douseRate: 2.6, // douse progress per game hour at full rain (1 = doused)
  douseRecover: 0.8, // douse progress lost per game hour when the rain eases
  douseWarnAt: 0.45, // progress at which a "the rain is drowning your fire" toast is shown
  // Torch
  torchBurnHours: 4,
  torchDouseRainMin: 0.45,
  torchDouseRate: 4.5, // ~0.22 game h (≈7 real s) of downpour in the open puts a torch out
  torchDouseRecover: 2,
  // Signals (visibility ranges in meters)
  campfireDay: 120,
  campfireNight: 350,
  signalDay: 650,
  signalNight: 500,
  signalBoostMul: 1.25, // extra-thick smoke (leaves) reads from further away
  sosDay: 220,
  sosMinDaylight: 0.3,
  torchNight: 160,
  torchMaxDaylight: 0.35,
  // Signal fire
  leavesPerBoost: 2,
  boostHours: 1,
  maxBoostHours: 3,
  // Sleep window: 19:00 .. 05:00
  sleepFrom: 19,
  sleepUntil: 5,
  wakeHour: 6.5,
  // Embers glow on after a fire dies (game hours)
  emberHours: 0.35,
};

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Effective rain reaching a fire / torch (0..1).
 * @param rain     weather rain intensity 0..1
 * @param canopy   tree cover 0..1 at that spot
 * @param covered  true when under (or right next to) a lean-to roof
 */
export function rainExposure(rain, canopy = 0, covered = false) {
  let r = clamp01(rain) * (1 - clamp01(canopy) * K.canopyRainCover);
  if (covered) r *= 1 - K.shelterRainCover;
  return clamp01(r);
}

/** Fuel hours consumed per game hour at a given effective rain. */
export function fuelBurnRate(rainEff) {
  return 1 + clamp01(rainEff) * K.rainBurnExtra;
}

/** Burn `dtHours` of game time. Returns the new fuel (never negative). */
export function burnFuel(fuel, dtHours, rainEff = 0) {
  if (!(dtHours > 0)) return Math.max(0, fuel);
  return Math.max(0, fuel - dtHours * fuelBurnRate(rainEff));
}

/** Game hours until the fuel runs out at the current rain. */
export function hoursLeft(fuel, rainEff = 0) {
  return Math.max(0, fuel) / fuelBurnRate(rainEff);
}

/**
 * Add `n` pieces of wood. Returns { fuel, used } (used = pieces actually needed: none when already full).
 * @param cfg CONFIG.fire ({ fuelPerWoodHours, maxFuelHours })
 */
export function addWood(fuel, n, cfg, maxFuel = cfg.maxFuelHours) {
  let used = 0;
  let f = Math.max(0, fuel);
  while (used < n && f < maxFuel - 0.05) {
    f = Math.min(maxFuel, f + cfg.fuelPerWoodHours);
    used++;
  }
  return { fuel: f, used };
}

/** Advance the rain-douse accumulator of a campfire. Returns the new progress (>= 1 means doused). */
export function douseStep(progress, dtHours, rainEff) {
  if (!(dtHours > 0)) return progress;
  if (rainEff > K.douseRainMin) {
    const t = (rainEff - K.douseRainMin) / (1 - K.douseRainMin);
    return progress + dtHours * K.douseRate * t;
  }
  return Math.max(0, progress - dtHours * K.douseRecover);
}

/** Same for a held torch. */
export function torchDouseStep(progress, dtHours, rainEff) {
  if (!(dtHours > 0)) return progress;
  if (rainEff > K.torchDouseRainMin) {
    const t = (rainEff - K.torchDouseRainMin) / (1 - K.torchDouseRainMin);
    return progress + dtHours * K.torchDouseRate * t;
  }
  return Math.max(0, progress - dtHours * K.torchDouseRecover);
}

/** Visual/physical flame level 0..1 from the remaining fuel (small fires look small). */
export function flameLevel(fuel) {
  if (fuel <= 0) return 0;
  const start = clamp01(fuel / 0.6); // the last ~35 real seconds the flames shrink to embers
  const size = 0.72 + 0.28 * clamp01(fuel / 5);
  return start * size;
}

// ── Signals (visibility range in meters, used by the rescue attention model) ──
export const campfireStrength = (daylight) => lerp(K.campfireNight, K.campfireDay, clamp01(daylight));
export const signalFireStrength = (daylight, boosted = false) =>
  lerp(K.signalNight, K.signalDay, clamp01(daylight)) * (boosted ? K.signalBoostMul : 1);
export const sosStrength = (daylight) => (daylight >= K.sosMinDaylight ? K.sosDay : 0);
export const torchSignalActive = (lit, daylight) => !!lit && daylight <= K.torchMaxDaylight;

// ── Sleep ─────────────────────────────────────────────────────────────────
/** True between 19:00 and 05:00. */
export const isSleepHour = (hour) => hour >= K.sleepFrom || hour < K.sleepUntil;

/**
 * Why the player can't sleep (null = OK). Mirrors the HUD's "You can sleep here" chip.
 * @param s { hour, sheltered, nearFire (0..1), cooking }
 */
export function sleepBlocker(s) {
  if (!isSleepHour(s.hour)) return 'notTired';
  if (s.cooking) return 'cooking';
  if (!s.sheltered && !(s.nearFire > 0.12)) return 'exposed';
  return null;
}

// ── Cooking ───────────────────────────────────────────────────────────────
/**
 * Everything the player could cook right now, grouped by raw item.
 * @param count    (id) => number owned
 * @param cookable ids of raw items with cooksInto (COOKABLE)
 * @param items    ITEMS
 * @returns { total, groups: [{ from, to, n }] }
 */
export function cookQueue(count, cookable, items) {
  const groups = [];
  let total = 0;
  for (const id of cookable) {
    const n = count(id);
    const to = items[id]?.cooksInto;
    if (n > 0 && to) {
      groups.push({ from: id, to, n });
      total += n;
    }
  }
  return { total, groups };
}

/** The first raw item still owned (re-read each step: food can be eaten mid-queue). */
export function nextCookable(count, cookable, items) {
  for (const id of cookable) if (count(id) > 0 && items[id]?.cooksInto) return id;
  return null;
}

// ── SOS layout ────────────────────────────────────────────────────────────
/**
 * Stone positions spelling "SOS" in local 2D coordinates: x to the reader's right, y away from the reader
 * (letter tops). Centered on (0, 0); total width ≈ 8 m, letter height ≈ 3 m.
 * @returns [{ x, y, letter (0..2) }]
 */
export function sosLayout(spacing = 0.62, letterW = 2.2, letterH = 3.0, gap = 0.7) {
  const out = [];
  const total = letterW * 3 + gap * 2;
  const x0 = -total / 2 + letterW / 2; // center of the first letter
  const rx = letterW / 2;
  const ry = letterH / 4; // each S bowl is half the letter height
  const curves = [
    // S: top bowl (from upper right, over the top, down the left, to the middle) then the bottom bowl
    (cx) => [arc(cx, ry, rx, ry, 0.35, Math.PI * 1.5), arc(cx, -ry, rx, ry, Math.PI * 0.5, -Math.PI * 0.65)],
    // O: an ellipse
    (cx) => [arc(cx, 0, rx * 0.95, letterH / 2, 0, Math.PI * 2, true)],
    (cx) => [arc(cx, ry, rx, ry, 0.35, Math.PI * 1.5), arc(cx, -ry, rx, ry, Math.PI * 0.5, -Math.PI * 0.65)],
  ];
  for (let L = 0; L < 3; L++) {
    const cx = x0 + L * (letterW + gap);
    // join a letter's curves into one polyline, then resample by arc length
    const pts = [];
    for (const c of curves[L](cx)) for (const p of c) pts.push(p);
    const closed = L === 1;
    for (const p of resample(pts, spacing, closed)) out.push({ x: p[0], y: p[1], letter: L });
  }
  return out;
}

/** Dense points on an elliptical arc from angle a0 to a1 (radians, CCW positive). */
function arc(cx, cy, rx, ry, a0, a1, closed = false) {
  const n = 48;
  const pts = [];
  const count = closed ? n : n + 1;
  for (let i = 0; i < count; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

/** Resample a polyline at a fixed spacing (includes both ends unless closed). */
function resample(pts, spacing, closed) {
  const seg = [];
  let len = 0;
  const n = pts.length;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(l);
    len += l;
  }
  const count = Math.max(2, Math.round(len / spacing));
  const step = len / (closed ? count : count - 1);
  const out = [];
  let si = 0, acc = 0;
  for (let k = 0; k < count; k++) {
    const d = Math.min(len, k * step);
    while (si < m - 1 && acc + seg[si] < d) acc += seg[si++];
    const a = pts[si], b = pts[(si + 1) % n];
    const t = seg[si] > 0 ? (d - acc) / seg[si] : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// ── Placement ─────────────────────────────────────────────────────────────
/** Footprints + preferred distance in front of the player, per structure type. */
export const FOOTPRINT = {
  campfire: { dist: 2.5, r: 0.75 },
  signal_fire: { dist: 3.2, r: 1.45 },
  shelter: { dist: 3.0, r: 1.7 },
  sos: { dist: 4.0, r: 1.5, halfW: 4.2 },
};

/**
 * Candidate spots in front of the player, best first: [{ x, z, yaw }].
 * forward = (-sin yaw, 0, -cos yaw).
 */
export function placementCandidates(px, pz, yaw, type) {
  const fp = FOOTPRINT[type] || FOOTPRINT.campfire;
  const out = [];
  const dists = [fp.dist, fp.dist + 0.6, fp.dist - 0.4, fp.dist + 1.2];
  const turns = [0, 0.3, -0.3, 0.6, -0.6];
  for (const t of turns) {
    for (const d of dists) {
      const a = yaw + t;
      out.push({ x: px - Math.sin(a) * d, z: pz - Math.cos(a) * d, yaw: a });
    }
  }
  return out;
}
