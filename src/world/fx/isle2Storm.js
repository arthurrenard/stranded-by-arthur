// Tempest Isle local storms (v3), pure and deterministic: no THREE, no ctx (tests/isle2Storm.test.mjs).
// Each half-day (06-18, 18-06) rolls once against CONFIG.isle2.stormChance, seeded per half-day index,
// for a storm of 1-4 game hours that starts and ends inside that half-day (with room for the ~30 s ramp
// out). Weather.js turns the window into a live intensity (real-second ramps) and the spatial falloff.
import { mulberry32 } from '../../core/rng.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Half-day index of an absolute game hour: k covers [6 + 12k, 18 + 12k). */
export function halfDayIndex(hours) {
  return Math.floor((hours - 6) / 12);
}

function halfDaySeed(seed, k) {
  let h = (Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((k | 0) + 0x632be5ab, 0xc2b2ae35)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * The storm window of half-day k, or null when the roll fails.
 * opts: { stormChance (0.4), minHours (1), maxHours (4), lead (0.25 h after the half-day starts),
 *         tail (1 h before it ends) } -> { k, start, end, peak (0.8..1) } in absolute game hours.
 */
export function stormWindow(seed, k, opts = {}) {
  const chance = opts.stormChance ?? 0.4;
  const r = mulberry32(halfDaySeed(seed, k));
  if (!(r() < chance)) return null;
  const minH = opts.minHours ?? 1, maxH = opts.maxHours ?? 4;
  const lead = opts.lead ?? 0.25, tail = opts.tail ?? 1;
  const dur = minH + (maxH - minH) * r();
  const h0 = 6 + 12 * k;
  const earliest = h0 + lead, latest = Math.max(earliest, h0 + 12 - tail - dur);
  const start = earliest + (latest - earliest) * r();
  const peak = 0.8 + 0.2 * r();
  return { k, start, end: start + dur, peak };
}

/** The storm window running at `hours` (start <= hours < end), or null. */
export function stormActiveAt(seed, hours, opts) {
  const w = stormWindow(seed, halfDayIndex(hours), opts);
  return w && hours >= w.start && hours < w.end ? w : null;
}

/** The next storm window that has not ended yet at `hours` (searches up to maxHalfDays ahead), or null. */
export function nextStorm(seed, hours, opts, maxHalfDays = 60) {
  const k0 = halfDayIndex(hours);
  for (let k = k0; k < k0 + maxHalfDays; k++) {
    const w = stormWindow(seed, k, opts);
    if (w && w.end > hours) return w;
  }
  return null;
}

/** Spatial falloff: 1 inside `inner` m of the isle center, 0 beyond `outer` (smoothstep). */
export function stormFalloff(d, inner, outer) {
  const t = clamp01((outer - d) / (outer - inner));
  return t * t * (3 - 2 * t);
}

/** Hail fraction of a local storm value (only the stronger part of a storm hails). */
export function hailFrom(storm) {
  const t = clamp01((storm - 0.55) / 0.3);
  return t * t * (3 - 2 * t);
}

/** Linear real-time ramp of the live intensity toward the target (rampSec for a full 0 -> 1 swing). */
export function rampToward(cur, target, dt, rampSec) {
  const step = dt / Math.max(0.001, rampSec);
  return cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
}
