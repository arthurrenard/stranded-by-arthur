// Pure-JS DSP used to BAKE one-shot sounds into mono Float32Arrays (Builder F2).
// There is no WebAudio here, only plain math, so it runs (and is unit-tested) in node.
// audio.js copies the baked arrays into AudioBuffers once, which makes playback nearly free:
// one AudioBufferSourceNode + one GainNode (+ a PannerNode when the sound is positional).
//
// Conventions: every helper works on a mono Float32Array `a` at sample rate `sr`; times are seconds.
// "Adding" helpers (tone, noise, grains, mix) sum into the array; filt/shape transform in place.

const TAU = Math.PI * 2;

/** Seeded PRNG (mulberry32) -> () => [0,1). Baking is deterministic per (sound, variant). */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zeroed buffer of `sec` seconds. */
export const buf = (sr, sec) => new Float32Array(Math.max(1, Math.round(sec * sr)));

/** Linear attack `a` then exponential decay with time constant `tau`. */
export const envAD = (t, a, tau) => (t < 0 ? 0 : t < a ? t / a : Math.exp(-(t - a) / tau));

// ── Biquad (RBJ cookbook, direct form I) ─────────────────────────────────
export class Biquad {
  constructor(sr) {
    this.sr = sr;
    this.b0 = 1;
    this.b1 = this.b2 = this.a1 = this.a2 = 0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  /** type: 'lp' | 'hp' | 'bp' (constant 0 dB peak). */
  set(type, f, q = 0.707) {
    const w = (TAU * Math.min(Math.max(f, 10), this.sr * 0.45)) / this.sr;
    const cs = Math.cos(w), al = Math.sin(w) / (2 * Math.max(q, 0.05));
    let b0, b1, b2;
    if (type === 'hp') {
      b0 = (1 + cs) / 2;
      b1 = -(1 + cs);
      b2 = b0;
    } else if (type === 'bp') {
      b0 = al;
      b1 = 0;
      b2 = -al;
    } else {
      b0 = (1 - cs) / 2;
      b1 = 1 - cs;
      b2 = b0;
    }
    const a0 = 1 + al;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cs) / a0;
    this.a2 = (1 - al) / a0;
    return this;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** In-place filter; the cutoff glides exponentially f0 -> f1 across the buffer (coefficients every 32 samples). */
export function filt(a, sr, type, f0, q = 0.707, f1 = f0) {
  const bq = new Biquad(sr).set(type, f0, q);
  const n = a.length, sweep = f1 !== f0, ratio = f1 / f0;
  for (let i = 0; i < n; i++) {
    if (sweep && (i & 31) === 0) bq.set(type, f0 * Math.pow(ratio, i / n), q);
    a[i] = bq.process(a[i]);
  }
  return a;
}

/** In-place filter whose cutoff follows fn(t) (evaluated every 32 samples). */
export function filtFn(a, sr, type, fn, q = 0.707) {
  const bq = new Biquad(sr).set(type, fn(0), q);
  for (let i = 0; i < a.length; i++) {
    if ((i & 31) === 0) bq.set(type, fn(i / sr), q);
    a[i] = bq.process(a[i]);
  }
  return a;
}

/** Adds noise: 'white' | 'pink' (Kellet economy) | 'brown' (leaky integrator). */
export function noise(a, rand, color = 'white', amp = 1) {
  let b0 = 0, b1 = 0, b2 = 0, br = 0;
  for (let i = 0; i < a.length; i++) {
    const w = rand() * 2 - 1;
    let v;
    if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      v = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    } else if (color === 'brown') {
      br = (br + 0.02 * w) / 1.02;
      v = br * 3.5;
    } else v = w;
    a[i] += v * amp;
  }
  return a;
}

/** Multiplies every sample by fn(t). fn is called in order, so it may keep state (random walks). */
export function shape(a, sr, fn) {
  for (let i = 0; i < a.length; i++) a[i] *= fn(i / sr);
  return a;
}

/** Like shape() but evaluates fn every `step` samples and interpolates (cheap for long smooth envelopes). */
export function shapeCR(a, sr, fn, step = 32) {
  let e0 = fn(0);
  for (let i = 0; i < a.length; i += step) {
    const e1 = fn(Math.min(a.length, i + step) / sr);
    const n = Math.min(step, a.length - i);
    for (let k = 0; k < n; k++) a[i + k] *= e0 + ((e1 - e0) * k) / step;
    e0 = e1;
  }
  return a;
}

/**
 * Adds an oscillator starting at t0 for `dur` seconds.
 * f: Hz, or a function f(t). opts: { f1 (exponential glide target), a (attack), tau (decay),
 * env (t => gain, replaces a/tau), shape: 'sine'|'tri'|'saw'|'square', vib (depth, ratio),
 * vibRate (Hz), harm: [[integer multiple, amp], ...] }
 */
export function tone(a, sr, t0, dur, f, amp, opts = {}) {
  const { f1 = null, a: att = 0.004, tau = dur, env = null, shape: wave = 'sine', vib = 0, vibRate = 6, harm = null } = opts;
  const i0 = Math.max(0, Math.round(t0 * sr));
  const n = Math.min(a.length - i0, Math.round(dur * sr));
  if (n <= 0) return a;
  const fFn = typeof f === 'function' ? f : null;
  const ratio = f1 != null && !fFn ? f1 / f : 1;
  const tailN = Math.max(1, 0.004 * sr);
  let ph = 0;
  for (let k = 0; k < n; k++) {
    const t = k / sr;
    let fr = fFn ? fFn(t) : ratio !== 1 ? f * Math.pow(ratio, t / dur) : f;
    if (vib) fr *= 1 + vib * Math.sin(TAU * vibRate * t);
    ph += fr / sr;
    ph -= Math.floor(ph);
    let s;
    if (wave === 'saw') s = 2 * ph - 1;
    else if (wave === 'square') s = ph < 0.5 ? 1 : -1;
    else if (wave === 'tri') s = 1 - 4 * Math.abs(ph - 0.5);
    else s = Math.sin(TAU * ph);
    if (harm) for (let h = 0; h < harm.length; h++) s += harm[h][1] * Math.sin(TAU * ph * harm[h][0]);
    const e = env ? env(t) : envAD(t, att, tau);
    const tail = n - k < tailN ? (n - k) / tailN : 1;
    a[i0 + k] += s * amp * e * tail;
  }
  return a;
}

/**
 * Adds `n` tiny noise grains (clicks/crunch) in [t0, t0 + dur). With a finite `decay` (s) the grains
 * cluster near t0 (exponential density) and get quieter; each grain lasts about `gl` seconds.
 */
export function grains(a, sr, rand, t0, dur, n, amp, gl = 0.002, decay = Infinity) {
  const fin = Number.isFinite(decay);
  const norm = fin ? 1 - Math.exp(-dur / decay) : 1;
  for (let g = 0; g < n; g++) {
    const t = fin ? -Math.log(1 - rand() * norm) * decay : rand() * dur;
    const i0 = Math.round((t0 + t) * sr);
    const len = Math.max(2, Math.round(gl * sr * (0.5 + rand())));
    const A = amp * (0.3 + 0.7 * rand()) * (fin ? Math.exp(-t / (decay * 2)) : 1);
    for (let k = 0; k < len && i0 + k < a.length; k++) {
      if (i0 + k < 0) continue;
      a[i0 + k] += (rand() * 2 - 1) * A * Math.exp((-3 * k) / len);
    }
  }
  return a;
}

/** dst += src * gain, with src starting at t0 (clipped to dst's length). */
export function mix(dst, src, sr, t0 = 0, gain = 1) {
  const i0 = Math.round(t0 * sr);
  const n = Math.min(src.length, dst.length - i0);
  for (let k = Math.max(0, -i0); k < n; k++) dst[i0 + k] += src[k] * gain;
  return dst;
}

/** Peak value (absolute). */
export function peak(a) {
  let p = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i] < 0 ? -a[i] : a[i];
    if (v > p) p = v;
  }
  return p;
}

/** Normalizes to peak 1, then tanh saturation (adds weight to booms and cracks). */
export function softclip(a, drive = 1.5) {
  const p = peak(a) || 1;
  const k = 1 / Math.tanh(drive);
  for (let i = 0; i < a.length; i++) a[i] = Math.tanh((a[i] / p) * drive) * k;
  return a;
}

/** Final pass: DC blocker, click-free edges, normalize to `target` peak. Never returns NaNs. */
export function finish(a, sr, target = 0.9) {
  let x1 = 0, y1 = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    const y = x - x1 + 0.995 * y1;
    x1 = x;
    y1 = y;
    a[i] = y;
  }
  const fi = Math.min(a.length, Math.round(0.0005 * sr));
  for (let i = 0; i < fi; i++) a[i] *= i / fi;
  const fo = Math.min(a.length, Math.round(0.006 * sr));
  for (let i = 0; i < fo; i++) a[a.length - 1 - i] *= i / fo;
  const p = peak(a);
  if (p > 1e-9) {
    const g = target / p;
    for (let i = 0; i < a.length; i++) a[i] *= g;
  }
  return a;
}

/** Saw "voice" source through parallel formant band-passes. ffn(t) = pitch, formants = [[Hz, Q, gain]]. */
export function voiced(sr, dur, ffn, formants, env, rand, breath = 0.1) {
  const src = buf(sr, dur);
  let ph = 0;
  for (let i = 0; i < src.length; i++) {
    const f = ffn(i / sr) * (1 + (rand() - 0.5) * 0.02);
    ph += f / sr;
    ph -= Math.floor(ph);
    src[i] = 2 * ph - 1 + (rand() * 2 - 1) * breath;
  }
  const out = buf(sr, dur);
  for (const [f, q, g] of formants) mix(out, filt(src.slice(), sr, 'bp', f, q), sr, 0, g);
  return shape(out, sr, env);
}
