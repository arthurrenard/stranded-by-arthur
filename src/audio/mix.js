// Pure mixing math for the ambient soundscape (Builder F2): how loud each bed is for a given
// listener situation, how often birds sing, how fast the heart beats… No WebAudio, no allocations
// (functions return numbers or write into a caller-owned object), unit-tested in tests/audio.test.mjs.
import { clamp01, smoothstep, lerp } from '../core/util.js';

/** Bell curve exp(-(x-mu)^2 / 2 sigma^2). */
export const bell = (x, mu, sigma) => Math.exp(-((x - mu) * (x - mu)) / (2 * sigma * sigma));

/** Ground ambience fades as the listener climbs above the ground (title orbit, summit cliffs). */
export const altitudeFade = (alt) => 1 - 0.85 * smoothstep(4, 60, alt);

/**
 * Ocean surf level. coastDist: + inland / − at sea (ctx.world.coastDistance), alt: meters above
 * the ground or sea. Loud on the beach and at sea, ~0.05 deep inland, softer from high up.
 */
export function oceanLevel(coastDist, alt, storm = 0) {
  const near = clamp01(1 - coastDist / 80);
  const v = 0.05 + 0.95 * near * near;
  return v * lerp(1, 0.35, smoothstep(10, 140, alt)) * (1 + 0.35 * clamp01(storm));
}

/** Inland the surf loses its highs: low-pass cutoff (Hz) for the ocean bed. */
export const oceanCutoff = (coastDist) => 500 + 9500 * Math.pow(clamp01(1 - coastDist / 70), 2);

/**
 * Wind: writes { base, howl, rustle } into `out`. strength ~0..1.5 (weather), alt above ground,
 * canopy 0..1 (trees shelter you), storm 0..1, forest 0..1 (leaves to rustle).
 */
export function windLevels(out, strength, alt, canopy, storm, forest) {
  const s = Math.max(0, Math.min(1.5, strength));
  let base = 0.1 + 0.6 * Math.pow(s, 1.3);
  base *= 1 + 0.8 * smoothstep(25, 90, alt);
  base *= 1 - 0.45 * clamp01(canopy);
  out.base = base;
  out.howl = Math.max(smoothstep(0.55, 1.05, s), clamp01(storm)) * (1 - 0.5 * clamp01(canopy));
  out.rustle = clamp01(forest) * (0.15 + 0.85 * Math.min(1, s)) * altitudeFade(alt);
  return out;
}

/**
 * Bird phrases per second: daytime only, a dawn chorus, louder in the forest, quiet in rain.
 * hour 0..24, daylight 0..1, forest/meadow 0..1, rain 0..1, alt (m above ground).
 */
export function birdRate(hour, daylight, forest, meadow, rain, alt) {
  const day = Math.pow(clamp01(daylight), 1.5);
  const chorus = 1 + 1.8 * bell(hour, 6.6, 0.9) + 0.6 * bell(hour, 18.2, 0.7);
  return 0.55 * day * (0.1 + 0.9 * clamp01(forest) + 0.45 * clamp01(meadow)) * chorus * (1 - 0.85 * clamp01(rain)) * altitudeFade(alt);
}

/** 0 by day → 1 at night (smooth through dusk). */
export const nightness = (daylight) => 1 - smoothstep(0.05, 0.45, daylight);

/** Night crickets level (grassy/forest places, not on the sand, hushed by rain). */
export function cricketLevel(daylight, meadow, forest, sand, rain, alt) {
  return clamp01(nightness(daylight) * (0.25 + 0.5 * meadow + 0.45 * forest) * (1 - 0.7 * clamp01(rain)) * (1 - 0.6 * clamp01(sand)) * altitudeFade(alt));
}

/** Afternoon cicada buzz in the forest. */
export function cicadaLevel(hour, daylight, forest, rain, alt) {
  return clamp01(clamp01(daylight) * bell(hour, 14, 2.4) * clamp01(forest) * (1 - clamp01(rain)) * altitudeFade(alt));
}

/** Frogs near fresh water at night (they love the rain). dWater = meters to the nearest shore. */
export function frogLevel(dWater, daylight, rain) {
  return clamp01(smoothstep(45, 5, dWater) * nightness(daylight) * (1 + 0.5 * clamp01(rain)));
}

/** River babble: loud on the bank, gone 25 m away. */
export const riverLevel = (d) => (d == null ? 0 : smoothstep(25, 2, d));

/** Lake lapping from the distance to the shoreline (either side). */
export const lapLevel = (dShore) => smoothstep(18, 1, Math.abs(dShore));

/** Heartbeat period (s) and volume for low health (< 25). Returns 0 period when healthy. */
export function heartbeat(health) {
  if (!(health < 25) || health <= 0) return { period: 0, volume: 0 };
  const k = clamp01((25 - health) / 22);
  return { period: lerp(0.95, 0.45, k), volume: lerp(0.35, 0.95, k) };
}

/** Doppler rate factor from the radial velocity (m/s, positive = moving away). */
export const doppler = (radialVel) => 343 / (343 + Math.max(-150, Math.min(150, radialVel)));

/** Stereo pan (−1..1) of a horizontal direction (dx, dz) as heard by a listener with camera yaw `yaw`. */
export function panToward(dx, dz, yaw) {
  const l = Math.hypot(dx, dz);
  if (l < 1e-6) return 0;
  return (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / l;
}

/** Same-name de-duplication: gate(name, t, window) → true if the sound may play at time t. */
export function createGate() {
  const last = new Map();
  return (name, t, window) => {
    const l = last.get(name);
    if (l !== undefined && Math.abs(t - l) < window) return false;
    last.set(name, t);
    return true;
  };
}

/** Distance-based air absorption: low-pass cutoff (Hz) for a sound `d` meters away. */
export const airCutoff = (d) => Math.max(900, Math.min(20000, 20000 * Math.exp(-Math.max(0, d - 25) / 220)));
