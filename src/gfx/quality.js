// V4-E — Graphics quality: Low / Medium / High presets + adaptive resolution.
//
// create(ctx) -> ctx.quality = { level, lodDistance, grassScale, grassDensity, underDistance, pixelRatio,
//   stats, set(level), init(), update(dt) }. Registered in main.js with { always: true } before 'sky', so
//   everything it touches outside its own state (renderer, the sun light, the pause overlay) is looked up
//   lazily. Flora reads lodDistance / grassScale / grassDensity / underDistance every few frames.
//
// Presets (QUALITY_PRESETS): pixel-ratio cap, sun shadow-map size, tree LOD distance (full-detail radius
//   of the tree chunks, m), grass patch radius + density factors, undergrowth view distance. Far fog is
//   unchanged on every level.
// Adaptive resolution (createAdaptiveRes, pure): when the smoothed frame time stays above 22 ms for 3 s
//   the renderer pixel ratio drops by 0.15 (floor 0.75); when it stays under 14 ms for 6 s it steps back
//   up by 0.15, up to the level's cap. Runs only while playing with the page visible.
// The level persists in localStorage ('stranded.quality'); default 'high', or 'medium' when the GPU looks
//   weak (maxTextureSize < 8192 or <= 4 CPU threads). A "Graphics" <select> is added to the pause
//   overlay's options row in init().
//
// Pure helpers used by flora + tests/perf.test.mjs: pickLod (LOD with hysteresis), boxDist2D, presetFor.
// No DOM / localStorage access at module top level (scripts/check.mjs imports every module in node).
import { CONFIG } from '../config.js';

export const QUALITY_LEVELS = ['low', 'medium', 'high'];
export const STORAGE_KEY = 'stranded.quality';

/** pixelRatio: cap before min(devicePixelRatio, CONFIG.graphics.maxPixelRatio) (Infinity = that min). */
export const QUALITY_PRESETS = {
  low: { pixelRatio: 1.0, shadowMapSize: 1024, lodDistance: 70, grassScale: 0.55, grassDensity: 0.7, underDistance: 125 },
  medium: { pixelRatio: 1.25, shadowMapSize: 2048, lodDistance: 110, grassScale: 0.8, grassDensity: 0.85, underDistance: 145 },
  high: { pixelRatio: Infinity, shadowMapSize: 2048, lodDistance: 150, grassScale: 1, grassDensity: 1, underDistance: 160 },
};

/** Resolved preset for a level: the pixel-ratio cap never exceeds the screen's dpr or maxPixelRatio. */
export function presetFor(level, dpr = 1, maxPixelRatio = CONFIG.graphics.maxPixelRatio) {
  const P = QUALITY_PRESETS[level] ?? QUALITY_PRESETS.high;
  const screen = Math.min(dpr > 0 ? dpr : 1, maxPixelRatio);
  return { ...P, level: QUALITY_PRESETS[level] ? level : 'high', pixelRatio: Math.min(P.pixelRatio, screen) };
}

/** Default level when nothing is stored: 'medium' on a weak-looking GPU / CPU, else 'high'. */
export function defaultLevel(maxTextureSize, hardwareConcurrency) {
  if (Number.isFinite(maxTextureSize) && maxTextureSize < 8192) return 'medium';
  if (Number.isFinite(hardwareConcurrency) && hardwareConcurrency <= 4) return 'medium';
  return 'high';
}

/**
 * LOD choice with hysteresis: a chunk at distance d (m) renders full detail inside D. Full chunks stay full
 * until d > D + hyst/2, low ones switch back at d < D - hyst/2 (so a chunk on the edge never flickers).
 */
export function pickLod(wasFull, d, D, hyst = 10) {
  return wasFull ? d <= D + hyst * 0.5 : d < D - hyst * 0.5;
}

/** Horizontal distance from (x, z) to the box [minX, maxX] x [minZ, maxZ] (0 inside). */
export function boxDist2D(minX, minZ, maxX, maxZ, x, z) {
  const dx = Math.max(minX - x, 0, x - maxX);
  const dz = Math.max(minZ - z, 0, z - maxZ);
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Adaptive resolution controller (pure). step(frameMs) -> pixel ratio. opts: { cap, floor, step, hiMs, hiHold,
 * loMs, loHold, tau }. Frame times are smoothed (exponential, tau s); frames over 250 ms (tab switches,
 * loading hitches) are ignored.
 */
export function createAdaptiveRes(opts = {}) {
  const o = { cap: 1, floor: 0.75, step: 0.15, hiMs: 22, hiHold: 3, loMs: 14, loHold: 6, tau: 0.5, ...opts };
  let cap = o.cap, ratio = o.cap, smooth = 16.7, hiT = 0, loT = 0;
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    get ratio() {
      return ratio;
    },
    get cap() {
      return cap;
    },
    get smoothMs() {
      return smooth;
    },
    /** New cap (quality level change): the ratio jumps to it and the timers restart. */
    setCap(c) {
      cap = c;
      ratio = c;
      hiT = loT = 0;
    },
    /** Feed one frame's duration in ms; returns the (possibly changed) pixel ratio. */
    step(frameMs) {
      if (!(frameMs > 0) || frameMs > 250) return ratio;
      const dt = frameMs / 1000;
      smooth += (frameMs - smooth) * Math.min(1, dt / o.tau);
      const floor = Math.min(o.floor, cap);
      if (smooth > o.hiMs) {
        loT = 0;
        hiT += dt;
        if (hiT >= o.hiHold) {
          hiT = 0;
          ratio = round(Math.max(floor, ratio - o.step));
        }
      } else if (smooth < o.loMs) {
        hiT = 0;
        loT += dt;
        if (loT >= o.loHold) {
          loT = 0;
          ratio = round(Math.min(cap, ratio + o.step));
        }
      } else {
        hiT = loT = 0;
      }
      return ratio;
    },
  };
}

function loadLevel() {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return QUALITY_LEVELS.includes(v) ? v : null;
  } catch (_) {
    return null;
  }
}
function saveLevel(v) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, v);
  } catch (_) {
    /* private mode / blocked storage: the level just isn't remembered */
  }
}

export function create(ctx) {
  const G = ctx.config?.graphics ?? CONFIG.graphics;
  const dpr = () => globalThis.devicePixelRatio || 1;
  let level = loadLevel() ?? defaultLevel(ctx.renderer?.capabilities?.maxTextureSize, globalThis.navigator?.hardwareConcurrency);
  let P = presetFor(level, dpr(), G.maxPixelRatio);
  const adapt = createAdaptiveRes({ cap: P.pixelRatio });
  let sun = null;
  let select = null;
  let lastNow = 0;
  let sunWait = 0; // frames until the next sun lookup while it doesn't exist yet

  function applyPixelRatio() {
    const r = ctx.renderer;
    if (r?.setPixelRatio && Math.abs((r.getPixelRatio?.() ?? 0) - adapt.ratio) > 1e-3) r.setPixelRatio(adapt.ratio);
  }
  function applyShadowSize() {
    sun ??= ctx.sky?.sun ?? ctx.scene?.getObjectByName?.('sun') ?? null;
    const sh = sun?.shadow;
    if (!sh || sh.mapSize.x === P.shadowMapSize) return;
    sh.mapSize.set(P.shadowMapSize, P.shadowMapSize);
    if (sh.map) {
      sh.map.dispose(); // three reallocates the shadow map at the new size on the next render
      sh.map = null;
    }
  }

  const api = {
    get level() {
      return level;
    },
    get lodDistance() {
      return P.lodDistance;
    },
    get grassScale() {
      return P.grassScale;
    },
    get grassDensity() {
      return P.grassDensity;
    },
    get underDistance() {
      return P.underDistance;
    },
    /** Current renderer pixel ratio target (adaptive). */
    get pixelRatio() {
      return adapt.ratio;
    },
    /** Debug: { level, ratio, cap, smoothMs, shadowMapSize }. */
    get stats() {
      return { level, ratio: adapt.ratio, cap: adapt.cap, smoothMs: +adapt.smoothMs.toFixed(2), shadowMapSize: P.shadowMapSize };
    },
    presets: QUALITY_PRESETS,
    /** Switch level ('low' | 'medium' | 'high'): applied at once and remembered. */
    set(next) {
      if (!QUALITY_LEVELS.includes(next)) return level;
      level = next;
      P = presetFor(level, dpr(), G.maxPixelRatio);
      adapt.setCap(P.pixelRatio);
      applyPixelRatio();
      applyShadowSize();
      saveLevel(level);
      if (select && select.value !== level) select.value = level;
      ctx.events?.emit?.('quality:change', { level });
      return level;
    },
    init() {
      applyPixelRatio();
      applyShadowSize();
      const doc = globalThis.document;
      const row = doc?.querySelector?.('#pause .options');
      if (!row || doc.getElementById('opt-quality')) return;
      const label = doc.createElement('label');
      label.append('Graphics ');
      select = doc.createElement('select');
      select.id = 'opt-quality';
      select.title = 'Graphics quality';
      select.style.cssText =
        'font:inherit;color:inherit;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.35);border-radius:4px;padding:2px 6px;cursor:pointer';
      for (const [v, t] of [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]) {
        const op = doc.createElement('option');
        op.value = v;
        op.textContent = t;
        op.style.color = '#000';
        select.appendChild(op);
      }
      select.value = level;
      select.addEventListener('change', () => {
        api.set(select.value);
        select.blur(); // keep later key presses (WASD...) away from the select
      });
      label.appendChild(select);
      row.appendChild(label);
    },
    update() {
      const now = globalThis.performance?.now?.() ?? 0;
      const frameMs = lastNow ? now - lastNow : 0;
      lastNow = now;
      if (sun ? sun.shadow?.mapSize.x !== P.shadowMapSize : --sunWait <= 0) {
        sunWait = 60;
        applyShadowSize();
      }
      const visible = globalThis.document?.visibilityState !== 'hidden';
      if (ctx.state === 'playing' && visible) adapt.step(frameMs);
      applyPixelRatio(); // also re-asserts the target if something else reset the pixel ratio
    },
  };
  return api;
}
