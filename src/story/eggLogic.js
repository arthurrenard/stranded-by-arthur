// Pure easter-egg logic (Builder F2): no three.js, no DOM, no ctx. Tested by tests/eastereggs.test.mjs.

/** The 7 secrets, in journal order. */
export const EGGS = [
  { id: 'bottle', name: 'Message in a Bottle' },
  { id: 'camp', name: "The Castaway's Camp" },
  { id: 'circle', name: 'The Stone Circle' },
  { id: 'butterfly', name: 'The Golden Butterfly' },
  { id: 'konami', name: 'Moon Gravity' },
  { id: 'carving', name: 'Carved Initials' },
  { id: 'duck', name: 'Rubber Duck' },
];
export const EGG_TOTAL = EGGS.length;
export const eggName = (id) => EGGS.find((e) => e.id === id)?.name ?? id;

/** ↑ ↑ ↓ ↓ ← → ← → B A, as KeyboardEvent.code values. */
export const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'KeyB', 'KeyA'];

/**
 * Streaming matcher for a key sequence (KMP, so overlapping prefixes such as ↑↑↑↓↓… still match).
 * push(code) -> true exactly when the last pushed codes complete the sequence; progress resets after a match.
 */
export function createSequenceMatcher(seq = KONAMI) {
  const n = seq.length;
  const fail = new Array(n).fill(0); // fail[i] = length of the longest proper prefix-suffix of seq[0..i]
  for (let i = 1, k = 0; i < n; i++) {
    while (k > 0 && seq[i] !== seq[k]) k = fail[k - 1];
    if (seq[i] === seq[k]) k++;
    fail[i] = k;
  }
  let k = 0;
  return {
    get progress() {
      return k;
    },
    push(code) {
      while (k > 0 && code !== seq[k]) k = fail[k - 1];
      if (code === seq[k]) k++;
      if (k === n) {
        k = 0;
        return true;
      }
      return false;
    },
    reset() {
      k = 0;
    },
  };
}

/** hour in [start, end), with wraparound past midnight when start > end (e.g. 22 -> 3). */
export function inHourWindow(hour, start, end) {
  const h = ((hour % 24) + 24) % 24;
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

export const NIGHT_START = 22;
export const NIGHT_END = 3;
export const DAWN_START = 5.5;
export const DAWN_END = 8;

/** Stone-circle window 22:00–03:00. */
export const inNightWindow = (hour, start = NIGHT_START, end = NIGHT_END) => inHourWindow(hour, start, end);
/** Butterfly window 05:30–08:00. */
export const inDawnWindow = (hour, start = DAWN_START, end = DAWN_END) => inHourWindow(hour, start, end);

/**
 * Identity of the night containing (day, hour) for a window that wraps past midnight: the day on which the
 * window started (02:00 on day 5 belongs to night 4). null outside the window.
 */
export function nightKey(day, hour, start = NIGHT_START, end = NIGHT_END) {
  if (!inHourWindow(hour, start, end)) return null;
  if (start <= end) return day;
  return hour >= start ? day : day - 1;
}

/** Point mirrored through a center (the duck's echo comes from across the lake). */
export function mirrorThrough(x, z, cx, cz) {
  return { x: 2 * cx - x, z: 2 * cz - z };
}

/** Small deterministic hash -> [0,1) (per-day butterfly spot). */
export function hash01(a, b = 0) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** Where the butterfly flutters on a given day: within `spread` m of the meadow center (deterministic). */
export function butterflyAnchor(day, cx, cz, spread = 16) {
  const a = hash01(day, 1) * Math.PI * 2;
  const r = Math.sqrt(hash01(day, 2)) * spread;
  return { x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r };
}

/** 0..1 envelope for a timed effect: fade in over `fadeIn` s, hold, fade out over the last `fadeOut` s. */
export function envelope(t, duration, fadeIn = 4, fadeOut = 6) {
  if (t <= 0 || t >= duration) return 0;
  return Math.min(1, t / fadeIn, (duration - t) / fadeOut);
}
