// Game clock: in-game hours since day 1 00:00, sun/moon directions, daylight factor.
// Compass convention used everywhere: north = -Z, east = +X, up = +Y.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { smoothstep, clamp } from './util.js';

export function createClock(events) {
  let hoursTotal = CONFIG.time.startHour; // absolute game hours
  const sunDir = new THREE.Vector3();
  const moonDir = new THREE.Vector3();

  const clock = {
    timeScale: 1, // multiplier on game time flow (debug fast-forward, sleeping)
    paused: false,
    dtHours: 0, // game hours elapsed this frame
    dtGameSec: 0, // game seconds elapsed this frame (dtHours * 3600)
    realElapsed: 0, // real seconds while not paused
    sunDir, // unit vector toward the sun
    moonDir, // unit vector toward the moon
    daylight: 1, // 0 night .. 1 full day (smooth through dawn/dusk)
    isNight: false,

    get hoursTotal() {
      return hoursTotal;
    },
    get day() {
      return Math.floor(hoursTotal / 24) + 1;
    },
    get hour() {
      return ((hoursTotal % 24) + 24) % 24;
    },
    /** Game hours per real second at timeScale 1. */
    get hoursPerSec() {
      return 24 / CONFIG.time.dayLengthSec;
    },

    update(dt) {
      if (clock.paused) {
        clock.dtHours = 0;
        clock.dtGameSec = 0;
        return;
      }
      clock.realElapsed += dt;
      const before = hoursTotal;
      clock.dtHours = dt * clock.hoursPerSec * clock.timeScale;
      clock.dtGameSec = clock.dtHours * 3600;
      hoursTotal += clock.dtHours;
      fireCrossings(before, hoursTotal);
      computeSky();
    },

    /** Set the hour of the current day (no events except time:set). */
    setHour(h) {
      const dayStart = Math.floor(hoursTotal / 24) * 24;
      hoursTotal = dayStart + clamp(h, 0, 23.999);
      computeSky();
      events.emit('time:set', { hoursTotal });
    },
    /** Jump forward `h` game hours (sleeping). Emits time:skip {from, to}. */
    skipHours(h) {
      const from = hoursTotal;
      hoursTotal += Math.max(0, h);
      fireCrossings(from, hoursTotal);
      computeSky();
      events.emit('time:skip', { from, to: hoursTotal, hours: h });
    },
    /** Hours until the next occurrence of hour-of-day `target` (0..24). */
    hoursUntil(target) {
      let d = target - clock.hour;
      if (d <= 0) d += 24;
      return d;
    },
  };

  function fireCrossings(a, b) {
    // dawn 06:00, dusk 19:00, new day 00:00
    const marks = [
      [6, 'time:dawn'],
      [19, 'time:dusk'],
      [0, 'time:newday'],
    ];
    for (const [hr, name] of marks) {
      const ka = Math.floor((a - hr) / 24);
      const kb = Math.floor((b - hr) / 24);
      if (kb > ka) events.emit(name, { day: Math.floor(b / 24) + 1, hoursTotal: b });
    }
  }

  function computeSky() {
    // Sun rises in the east (+X) at ~05:45, sets in the west at ~19:15, arcs over the south (+Z).
    const h = clock.hour;
    const a = ((h - 5.75) / 13.5) * Math.PI; // 0 at sunrise, PI at sunset
    const elev = Math.sin(a);
    sunDir.set(Math.cos(a), elev * 0.92, 0.38).normalize();
    // Moon roughly opposite, a bit offset so it is not a perfect mirror.
    moonDir.set(-sunDir.x * 0.9, -sunDir.y * 0.95 + 0.05, -0.25).normalize();
    clock.daylight = smoothstep(-0.14, 0.22, sunDir.y);
    clock.isNight = sunDir.y < -0.06;
  }

  computeSky();
  return clock;
}
