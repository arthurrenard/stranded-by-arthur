// Pure weather model (no THREE, no DOM): a deterministic per-day shower schedule and the target
// weather values for any absolute game hour. weather.js smooths the live values toward these targets.
//
// Schedule rules (SPEC §6 A — weather):
// - Day 1 morning is guaranteed clear and sunny; its single shower starts after the first helicopter
//   pass (≥ 16:36), so there is never rain before 13:00 on day 1.
// - About 1–2 showers per in-game day (mean ≈ 1.35, some dry days), each lasting 0.5–2 h, preceded by a
//   cloudy build-up and followed by a quick clearing (which is when rainbows happen).
// - Rare thunderstorms (≈ 14 % of showers from day 2 on).
// - Occasional dry overcast spells for variety.
// Every day is generated from its own rng stream, so the result only depends on (seed, hoursTotal):
// skipping hours, setting the hour backwards or fast-forwarding always gives a consistent sky.
import { createRng } from '../../core/rng.js';

const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;

/** Reference values per weather kind (cloudiness, rain, storm, wind strength). */
export const WEATHER_PRESETS = {
  clear: { cloud: 0.16, rain: 0, storm: 0, wind: 0.3 },
  cloudy: { cloud: 0.7, rain: 0, storm: 0, wind: 0.5 },
  rain: { cloud: 0.9, rain: 0.7, storm: 0, wind: 0.68 },
  storm: { cloud: 1, rain: 1, storm: 1, wind: 1.25 },
};

export const SCHEDULE = {
  day1ShowerStart: [16.6, 20.0], // hour-of-day window for the day-1 shower
  showerDuration: [0.5, 2.0],
  stormDuration: [1.0, 2.0],
  stormChance: 0.14, // per shower, day >= 2
  lead: [0.6, 1.1], // cloudy build-up before rain (h)
  tail: [0.45, 0.8], // clearing after rain (h)
  minGap: 5, // hours between two showers of the same day
};

/** Fresh target object for targetAt(). */
export function makeWeatherTarget() {
  return { kind: 'clear', cloud: 0.16, rain: 0, storm: 0, wind: 0.3, angle: 0 };
}

/**
 * @param {number} seed world seed (CONFIG.seed)
 * @returns {{ day(d): {showers, spells}, targetAt(hoursTotal, out?), nextShower(hoursTotal) }}
 */
export function createWeatherSchedule(seed) {
  const root = createRng(seed >>> 0).fork('weather');
  const cache = new Map();
  const windRng = root.fork('wind');
  const windBase = 0.29 + windRng.range(-0.25, 0.25); // prevailing direction (radians, x/z plane)
  const windPhase = windRng.range(0, 6.283);

  /** Showers + cloudy spells of day d (1-based), in absolute game hours. */
  function day(d) {
    let plan = cache.get(d);
    if (plan) return plan;
    const r = root.fork('weather-day-' + d);
    const base = (d - 1) * 24;
    const showers = [];
    let n;
    if (d === 1) n = 1;
    else {
      const x = r();
      n = x < 0.1 ? 0 : x < 0.55 ? 1 : 2;
    }
    const starts = [];
    for (let k = 0; k < n; k++) {
      let h = 0;
      for (let tries = 0; tries < 12; tries++) {
        h = d === 1 ? r.range(SCHEDULE.day1ShowerStart[0], SCHEDULE.day1ShowerStart[1]) : r.range(0.5, 22.5);
        if (starts.every((s) => Math.abs(s - h) >= SCHEDULE.minGap)) break;
        h = -1;
      }
      if (h < 0) continue;
      starts.push(h);
      const storm = d >= 2 && r() < SCHEDULE.stormChance;
      const dur = storm ? r.range(...SCHEDULE.stormDuration) : r.range(...SCHEDULE.showerDuration);
      showers.push({
        kind: storm ? 'storm' : 'rain',
        start: base + h,
        end: base + h + dur,
        intensity: storm ? 1 : r.range(0.45, 0.9),
        lead: r.range(...SCHEDULE.lead),
        tail: r.range(...SCHEDULE.tail),
        phase: r.range(0, 6.283),
      });
    }
    showers.sort((a, b) => a.start - b.start);
    // dry overcast spells (day 1: afternoon only, so the first morning stays sunny)
    const spells = [];
    if (r() < 0.55) {
      // day 1: a short midday spell that has cleared before the 15:00 helicopter pass
      const h = d === 1 ? r.range(11.5, 12.5) : r.range(0, 22);
      const dur = d === 1 ? r.range(1, 1.8) : r.range(1, 3);
      spells.push({ start: base + h, end: base + h + dur, cloud: r.range(0.5, 0.74) });
    }
    plan = { showers, spells, baseCloud: r.range(0.1, 0.26), cloudPhase: r.range(0, 6.283) };
    cache.set(d, plan);
    if (cache.size > 16) cache.delete(cache.keys().next().value);
    return plan;
  }

  /** Target weather at an absolute game hour. */
  function targetAt(H, out = makeWeatherTarget()) {
    const d = Math.floor(H / 24) + 1;
    const hod = H - (d - 1) * 24;
    const today = day(d);
    // fair-weather cumulus drift (day 1 morning: a few puffy clouds only)
    let cloud = today.baseCloud + 0.1 * (0.5 + 0.5 * Math.sin(H * 0.55 + today.cloudPhase));
    if (d === 1 && hod < 12) cloud = Math.min(cloud, 0.16);
    let rain = 0, storm = 0;
    let wind = 0.24 + 0.14 * (0.5 + 0.5 * Math.sin(H * 0.23 + windPhase));
    let kind = 'clear';
    let level = 0; // 0 clear, 1 cloudy, 2 rain, 3 storm (highest wins the label)

    for (let dd = Math.max(1, d - 1); dd <= d + 1; dd++) {
      const plan = dd === d ? today : day(dd);
      for (const sp of plan.spells) {
        if (H < sp.start - 0.5 || H > sp.end + 0.5) continue;
        const k = smooth(sp.start - 0.5, sp.start + 0.2, H) * (1 - smooth(sp.end - 0.2, sp.end + 0.5, H));
        cloud = Math.max(cloud, lerp(cloud, sp.cloud, k));
        wind = Math.max(wind, lerp(wind, WEATHER_PRESETS.cloudy.wind, k));
        if (k > 0.5 && level < 1) (level = 1), (kind = 'cloudy');
      }
      for (const ev of plan.showers) {
        const s0 = ev.start - ev.lead, e1 = ev.end + ev.tail;
        if (H < s0 || H > e1) continue;
        const P = ev.kind === 'storm' ? WEATHER_PRESETS.storm : WEATHER_PRESETS.rain;
        if (H < ev.start) {
          // build-up: clouds thicken, wind picks up
          const k = smooth(s0, ev.start, H);
          cloud = Math.max(cloud, lerp(cloud, P.cloud, k));
          wind = Math.max(wind, lerp(wind, P.wind * 0.85, k));
          if (k > 0.35 && level < 1) (level = 1), (kind = 'cloudy');
        } else if (H <= ev.end) {
          const pulse = ev.kind === 'storm' ? 1 : 0.82 + 0.18 * Math.sin((H - ev.start) * 6.0 + ev.phase);
          rain = Math.max(rain, ev.intensity * pulse);
          cloud = Math.max(cloud, P.cloud);
          wind = Math.max(wind, P.wind);
          if (ev.kind === 'storm') storm = 1;
          const lv = ev.kind === 'storm' ? 3 : 2;
          if (lv > level) (level = lv), (kind = ev.kind);
        } else {
          // clearing: the clouds break up quickly (sun + rainbow chance)
          const k = smooth(ev.end, e1, H);
          cloud = Math.max(cloud, lerp(0.62, cloud, k));
          wind = Math.max(wind, lerp(P.wind * 0.7, wind, k));
          if (k < 0.4 && level < 1) (level = 1), (kind = 'cloudy');
        }
      }
    }
    out.kind = kind;
    out.cloud = Math.min(1, cloud);
    out.rain = Math.min(1, rain);
    out.storm = storm;
    out.wind = wind;
    // the wind direction meanders slowly around the prevailing direction
    out.angle = windBase + 0.7 * Math.sin(H * 0.11 + windPhase) + 0.35 * Math.sin(H * 0.29 + 1.3);
    return out;
  }

  /** Game hours until the next shower starts (or 0 while raining), searching up to 3 days ahead. */
  function nextShower(H) {
    const d = Math.floor(H / 24) + 1;
    for (let dd = Math.max(1, d - 1); dd <= d + 3; dd++) {
      for (const ev of day(dd).showers) {
        if (H >= ev.start && H <= ev.end) return 0;
        if (ev.start > H) return ev.start - H;
      }
    }
    return Infinity;
  }

  return { day, targetAt, nextShower };
}

/**
 * Air temperature offset (°C) for the live weather: cloudy −1.5, rain −4, storm −6.
 * The kinds blend (they do not add up): a storm is −6, not −11.5.
 */
export function airTempOffsetFor(cloud, rain, storm) {
  let off = -1.5 * smooth(0.35, 0.8, cloud);
  off = lerp(off, -4, smooth(0, 0.5, rain));
  off = lerp(off, -6, Math.min(1, Math.max(0, storm)));
  return off;
}

/** Weather label for the live values. */
export function weatherKind(cloud, rain, storm) {
  if (storm > 0.5) return 'storm';
  if (rain > 0.15) return 'rain';
  if (cloud > 0.5) return 'cloudy';
  return 'clear';
}
