// Builder V3-C — pure vehicle logic (no THREE, no DOM): unit-tested by tests/vehicles.test.mjs.
// Yaw convention (same as the player controller): heading 0 = bow toward -Z (north),
// forward = (-sin h, -cos h). `world` is ctx.world (heightAt / waterAt / slopeAt / coastDistance).

export const SEA = 0;

/** The paddle raft's dimensions (m). The group origin sits at the waterline, the deck top at `deck`. */
export const RAFT = { length: 3.4, beam: 1.9, deck: 0.3, seatEye: 1.05 };

export const LAUNCH_DEPTH = [0.3, 2.0]; // a new raft is placed in water this deep
export const LAUNCH_RANGE = 8; // m in front of the player
export const AGROUND_MARGIN = 0.25; // ground ahead above (water surface - this) = aground
export const CAPSIZE_STORM = 0.5; // rafts / sail boats can flip above this local storm intensity
export const RIGHT_STORM = 0.3; // a capsized raft can be righted below this
export const HOME_COAST = -250; // [R] "Head for home" when coastDistance is below this (m, negative at sea)
export const OPEN_SEA_MAIN = 1300; // motorboat: automatic "home" beyond this from the main island center…
export const OPEN_SEA_ISLE = 300; // …and this far from Tempest Isle
export const ISLE_CALM = 300; // no currents within this of the Tempest Isle center
// Between the islands the current is capped (no snap) but still beats the fastest swim (sprint-swimming ~3.4 m/s vs
// CURRENT_ACCEL 10 x 1.5 / ACCEL_SWIM 3.2 ≈ 4.7 m/s in the controller): nobody swims across (tests/vehicles.test.mjs),
// and a capsized swimmer is swept toward the nearer island.
export const CORRIDOR_MAX = 1.5;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const fwdX = (h) => -Math.sin(h);
export const fwdZ = (h) => -Math.cos(h);
/** Heading (yaw convention) that points from (x, z) toward (tx, tz). */
export const headingTo = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));

/** True when the ground ahead is too high to float over. */
export function isAground(groundAhead, surface = SEA, margin = AGROUND_MARGIN) {
  return groundAhead > surface - margin;
}

/** Probability that a raft flips during `dt` seconds in a local storm of intensity `storm` (0..1). */
export function capsizeChance(storm, dt, perSec = 0.06, threshold = CAPSIZE_STORM) {
  if (!(storm > threshold) || !(dt > 0) || !(perSec > 0)) return 0;
  return 1 - Math.exp(-perSec * storm * dt);
}

/** A capsized raft can be righted once the storm has eased. */
export const canRight = (storm) => !(storm >= RIGHT_STORM);

/** Motorboat: [R] "Head for home" is offered this far out at sea. */
export const canHeadHome = (coastDistance, threshold = HOME_COAST) => Number.isFinite(coastDistance) && coastDistance < threshold;

/** Motorboat: far enough out on the open sea that you're simply gone (automatic win). isle = { x, z }. */
export function openSeaReached(x, z, isle) {
  if (Math.hypot(x, z) <= OPEN_SEA_MAIN) return false;
  return !isle || Math.hypot(x - isle.x, z - isle.z) > OPEN_SEA_ISLE;
}

/** Exponential approach of a speed toward a target (rate 1/s). */
export function approach(v, target, rate, dt) {
  return v + (target - v) * (1 - Math.exp(-rate * dt));
}

/**
 * Target speed for a paddle raft from the W/S input (-1..1). No paddle or no energy: drift only.
 * cfg = CONFIG.vehicles.paddleRaft { speed, reverse }.
 */
export function paddleTarget(input, cfg, { hasPaddle = true, exhausted = false } = {}) {
  if (!input || !hasPaddle) return 0;
  const v = input > 0 ? cfg.speed * input : cfg.reverse * input;
  return exhausted ? clamp(v, -0.35, 0.35) : v;
}

/** Rough seaward heading at (x, z): the direction (of 12) where the water 5 m away is deepest. */
export function seawardHeading(world, x, z, fallback = 0) {
  let best = -Infinity, bestH = fallback;
  for (let k = 0; k < 12; k++) {
    const h = (k / 12) * Math.PI * 2;
    const d = -world.heightAt(x + fwdX(h) * 5, z + fwdZ(h) * 5);
    if (d > best + 1e-6) {
      best = d;
      bestH = h;
    }
  }
  return wrapAngle(bestH);
}

/**
 * Where to put a new raft: sea water LAUNCH_DEPTH deep within LAUNCH_RANGE in front of (px, pz).
 * Returns { ok: true, x, z, depth, heading } or { ok: false, reason }.
 */
export function findLaunchSpot(world, px, pz, yaw, range = LAUNCH_RANGE) {
  const offs = [0, 0.3, -0.3, 0.6, -0.6, 0.95, -0.95, 1.3, -1.3];
  for (let d = 1.5; d <= range + 1e-6; d += 0.5) {
    for (const o of offs) {
      const h = yaw + o;
      const x = px + fwdX(h) * d, z = pz + fwdZ(h) * d;
      const w = world.waterAt(x, z);
      if (!w || w.type !== 'ocean') continue;
      if (w.depth < LAUNCH_DEPTH[0] || w.depth > LAUNCH_DEPTH[1]) continue;
      return { ok: true, x, z, depth: w.depth, heading: seawardHeading(world, x, z, h) };
    }
  }
  return { ok: false, reason: "Build it at the water's edge: face the sea within a few steps of the shore." };
}

/**
 * Nearest dry, walkable ground within maxR of (x, z): { x, z, d } or null. 16 directions per ring.
 * `out` (optional) is reused.
 */
export function findDisembarkSpot(world, x, z, maxR = 4.6, out = {}) {
  for (let r = 0.75; r <= maxR + 1e-6; r += 0.45) {
    let best = null, bestH = -Infinity;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r;
      const g = world.heightAt(sx, sz);
      if (!(g > SEA + 0.08) || world.waterAt(sx, sz)) continue;
      if (world.slopeAt && world.slopeAt(sx, sz) > 0.55) continue;
      if (g > bestH) {
        bestH = g;
        best = a;
      }
    }
    if (best != null) {
      out.x = x + Math.cos(best) * r;
      out.z = z + Math.sin(best) * r;
      out.d = r;
      return out;
    }
  }
  return null;
}

/** Distance from (x, z) to the dock's centerline segment. dock = { x, z, dirX, dirZ, length }. */
export function dockDistance(dock, x, z) {
  if (!dock) return Infinity;
  const L = dock.length ?? 18;
  const t = clamp((x - dock.x) * dock.dirX + (z - dock.z) * dock.dirZ, 0, L);
  return Math.hypot(x - (dock.x + dock.dirX * t), z - (dock.z + dock.dirZ * t));
}

/** The dry beach spot at the landward end of the dock. */
export function dockLanding(dock) {
  return { x: dock.x - dock.dirX * 2.2, z: dock.z - dock.dirZ * 2.2 };
}

/**
 * A wading-depth spot to moor the Boatyard boat off the Tempest Isle cove: beside the dock (side ±1),
 * walking out from the shore until the water is `depth` deep. Returns { x, z, depth }.
 */
export function findMooring(world, dock, side = 1, minDepth = 0.85, maxDepth = 1.2, lateral = 13) {
  const lx = -dock.dirZ * side, lz = dock.dirX * side;
  let last = null;
  for (let lat = lateral; lat >= 4; lat -= 3) {
    for (let t = -6; t <= 40; t += 0.5) {
      const x = dock.x + lx * lat + dock.dirX * t, z = dock.z + lz * lat + dock.dirZ * t;
      const w = world.waterAt(x, z);
      if (!w || w.type !== 'ocean') continue;
      last = { x, z, depth: w.depth };
      if (w.depth >= minDepth && w.depth <= maxDepth) return last;
      if (w.depth > maxDepth) break;
    }
  }
  return last || { x: dock.x + dock.dirX * 14 + lx * lateral, z: dock.z + dock.dirZ * 14 + lz * lateral, depth: 1 };
}

/**
 * Sea currents for a swimmer (never while aboard). Main island: the old behaviour (soft zone from
 * boundary - soft, hard limit at boundary). Within ISLE_CALM of Tempest Isle: none. Between the
 * islands (the crossing): a capped current toward the nearer island and never a hard snap.
 * isle = { x, z, R } or null. Returns `out` = { active, dirX, dirZ (unit, toward safety), over (0..), clampR }.
 * clampR > 0: keep the swimmer within that radius of the main center.
 */
export function currentsAt(x, z, boundary, soft, isle, mainR = 320, out = {}) {
  out.active = false;
  out.over = 0;
  out.clampR = 0;
  out.dirX = 0;
  out.dirZ = 0;
  const dMain = Math.hypot(x, z);
  const start = boundary - soft;
  if (dMain <= start || dMain < 1e-3) return out;
  const dIsle = isle ? Math.hypot(x - isle.x, z - isle.z) : Infinity;
  if (dIsle <= ISLE_CALM) return out;
  out.active = true;
  const isleR = isle?.R ?? 150;
  const corridor = dIsle < isleR + 330;
  const towardIsle = corridor && dIsle - isleR < dMain - mainR;
  if (towardIsle) {
    out.dirX = (isle.x - x) / dIsle;
    out.dirZ = (isle.z - z) / dIsle;
    out.over = clamp((dIsle - ISLE_CALM) / soft, 0, CORRIDOR_MAX);
  } else {
    out.dirX = -x / dMain;
    out.dirZ = -z / dMain;
    out.over = (dMain - start) / soft;
    if (corridor) out.over = Math.min(out.over, CORRIDOR_MAX);
    else out.clampR = boundary;
  }
  return out;
}

/** Wind drift (m/s) for a floating vehicle: stronger in the local storm. wind = { x, z, strength }. */
export function windDrift(wind, storm, out = {}) {
  const s = (wind?.strength ?? 0) * (0.08 + 0.9 * (storm || 0));
  out.x = (wind?.x ?? 0) * s;
  out.z = (wind?.z ?? 0) * s;
  return out;
}
