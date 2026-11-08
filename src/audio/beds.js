// Persistent WebAudio graphs for the ambient soundscape and the positional vehicle loops (Builder F2).
// Every factory takes (ac, dest, N) where N = { white, pink, brown } looping noise AudioBuffers, and
// returns a small controller with update(...). Motion lives in the audio graph itself (oscillator LFOs
// wired into AudioParams, waves scheduled a few seconds ahead), so JS only writes slow-changing
// target levels through Target (setTargetAtTime only when the value really moved).
// Beds that fall silent for a few seconds disconnect from the mix so the browser stops rendering them.
// Nothing here runs at import time (node-safe).
import { rng, noise } from './dsp.js';

// ── Small graph helpers ─────────────────────────────────────────────────
export function gain(ac, v = 1) {
  const g = ac.createGain();
  g.gain.value = v;
  return g;
}
export function bq(ac, type, f, q = 0.707) {
  const b = ac.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  return b;
}
export function osc(ac, type, f) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = f;
  o.start();
  return o;
}
/** Looping noise source starting at a random offset (beds never phase-lock). */
export function loopSrc(ac, buffer, rate = 1) {
  const s = ac.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.playbackRate.value = rate;
  s.start(0, Math.random() * buffer.duration * 0.9);
  return s;
}
/** Oscillator LFO adding `depth` × wave to an AudioParam. Returns { o, g } (g.gain = depth). */
export function lfo(ac, freq, depth, param, type = 'sine') {
  const o = osc(ac, type, freq);
  const g = gain(ac, depth);
  o.connect(g);
  g.connect(param);
  return { o, g };
}
export function makePanner(ac, { model = 'HRTF', ref = 3, rolloff = 1, max = 10000 } = {}) {
  const p = ac.createPanner();
  p.panningModel = model;
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.rolloffFactor = rolloff;
  p.maxDistance = max;
  return p;
}
export function setPannerPos(p, x, y, z) {
  if (p.positionX) {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else p.setPosition(x, y, z);
}

/** AudioParam writer: setTargetAtTime only when the target moved by more than eps (relative or absolute). */
export class Target {
  constructor(param, initial, tau = 0.3, eps = 0.004, relative = false) {
    this.p = param;
    this.v = initial;
    this.tau = tau;
    this.eps = eps;
    this.rel = relative;
  }
  set(v, t, tau = this.tau) {
    const d = Math.abs(v - this.v);
    const lim = this.rel ? this.eps * Math.max(Math.abs(v), Math.abs(this.v), 1e-6) : this.eps;
    if (d <= lim && !(v === 0 && this.v !== 0)) return;
    this.v = v;
    this.p.setTargetAtTime(v, t, tau);
  }
}

/** A bed's output gain that disconnects itself after 3 s of silence. */
export class Bed {
  constructor(ac, dest) {
    this.dest = dest;
    this.out = gain(ac, 0);
    this.level = new Target(this.out.gain, 0, 0.35, 0.002);
    this.connected = false;
    this.silent = 0;
  }
  setLevel(v, t, dt, tau) {
    if (v > 0.0008) {
      if (!this.connected) {
        this.out.connect(this.dest);
        this.connected = true;
      }
      this.silent = 0;
    } else {
      v = 0;
      this.silent += dt;
      if (this.connected && this.silent > 3) {
        this.out.disconnect();
        this.connected = false;
      }
    }
    this.level.set(v, t, tau);
  }
}

// ── Shared buffers ──────────────────────────────────────────────────────
/** Seamlessly looping 6 s noise buffers (tail cross-faded into the head so brown noise never clicks). */
export function makeNoiseBuffers(ac, sr = 32000, sec = 6) {
  const out = {};
  const n = Math.round(sr * sec), f = Math.round(sr * 0.25);
  let seed = 9001;
  for (const color of ['white', 'pink', 'brown']) {
    const a = noise(new Float32Array(n + f), rng(seed++), color);
    let p = 0;
    for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = a[i] / (p || 1);
    for (let i = 0; i < f; i++) {
      const k = i / f;
      d[i] = (a[i] * k + a[n + i] * (1 - k)) / (p || 1);
    }
    const b = ac.createBuffer(1, n, sr);
    b.copyToChannel(d, 0);
    out[color] = b;
  }
  return out;
}

/** Outdoor reverb impulse: diffuse stereo tail that darkens as it decays (no hard walls on an island). */
export function makeImpulse(ac, sec = 1.3) {
  const sr = ac.sampleRate, n = Math.round(sr * sec);
  const b = ac.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const r = rng(77 + ch * 13);
    const d = new Float32Array(n);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const k = 0.55 - 0.45 * Math.min(1, t / sec); // one-pole low-pass closes over time
      lp += k * (r() * 2 - 1 - lp);
      const early = t < 0.09 && r() < 0.012 ? (r() * 2 - 1) * 1.6 : 0; // sparse early reflections (trees, rocks)
      d[i] = (lp + early) * Math.exp(-t / 0.32) * Math.min(1, t / 0.004);
    }
    b.copyToChannel(d, ch);
  }
  return b;
}

let _gateCurve = null;
function gateCurve() {
  if (_gateCurve) return _gateCurve;
  _gateCurve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    _gateCurve[i] = x > 0.35 ? Math.sqrt((x - 0.35) / 0.65) : 0;
  }
  return _gateCurve;
}

// ── Ocean surf ──────────────────────────────────────────────────────────
/** Deep sea roar + breaking waves (envelopes scheduled per wave) + foam hiss running back down the sand. */
export function createOcean(ac, dest, N) {
  const bed = new Bed(ac, dest);
  const lp = bq(ac, 'lowpass', 8000, 0.5);
  const pan = ac.createStereoPanner();
  lp.connect(pan);
  pan.connect(bed.out);
  const rg = gain(ac, 0.5);
  loopSrc(ac, N.brown, 0.8).connect(bq(ac, 'lowpass', 220, 0.7)).connect(rg).connect(lp);
  lfo(ac, 0.09, 0.14, rg.gain);
  const wlp = bq(ac, 'lowpass', 600, 0.6);
  const wenv = gain(ac, 0.1);
  loopSrc(ac, N.pink, 0.97).connect(wlp).connect(bq(ac, 'highpass', 120, 0.7)).connect(wenv).connect(lp);
  const henv = gain(ac, 0);
  loopSrc(ac, N.white, 1).connect(bq(ac, 'bandpass', 3800, 0.6)).connect(henv).connect(lp);
  const cut = new Target(lp.frequency, 8000, 0.6, 0.03, true);
  const panT = new Target(pan.pan, 0, 0.8, 0.03);
  let next = 0;
  return {
    bed,
    update(t, dt, level, cutoff, panV, storm) {
      bed.setLevel(level, t, dt, 0.7);
      cut.set(cutoff, t);
      panT.set(panV, t);
      if (!bed.connected) {
        next = t + 0.4;
        return;
      }
      if (t < next - 0.3) return;
      // schedule one wave: swell, break, roll out
      const t0 = Math.max(t, next), A = (0.55 + Math.random() * 0.45) * (1 + 0.4 * storm), rise = 1.6 + Math.random() * 1.2;
      const wg = wenv.gain, wf = wlp.frequency, hg = henv.gain;
      wg.setTargetAtTime(0.3 * A, t0, rise * 0.45);
      wf.setTargetAtTime(700 + 300 * A, t0, rise * 0.5);
      wg.setTargetAtTime(Math.min(1.4, A), t0 + rise, 0.07);
      wf.setTargetAtTime(1800 + 1800 * A, t0 + rise, 0.05);
      wg.setTargetAtTime(0.1, t0 + rise + 0.35, 1.3);
      wf.setTargetAtTime(480, t0 + rise + 0.35, 1.1);
      hg.setTargetAtTime(0.32 * A, t0 + rise + 0.25, 0.18);
      hg.setTargetAtTime(0, t0 + rise + 0.9, 1.4);
      next = t0 + rise + 3.2 + Math.random() * 4.5 * (1 - 0.35 * Math.min(1, storm));
    },
  };
}

// ── Wind ────────────────────────────────────────────────────────────────
/** Gusty band-passed noise, a resonant howl for storms and leaf rustle that swells with the gusts. */
const _clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const _smooth = (e0, e1, x) => {
  const t = _clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * Slow random wind envelope (0..1): long quiet lulls (10-40 s at 15-25 %) that swell over 5-15 s to a peak
 * (65-100 %), hold a few seconds, then fade back over 5-15 s. Pure (no WebAudio), stepped a few times a second.
 */
export class WindEnvelope {
  constructor(rand = Math.random) {
    this.rand = rand;
    this.lo = 0.15 + 0.1 * rand();
    this.hi = 0.8;
    this.from = this.lo;
    this.phase = 'lull';
    this.t = 0;
    this.dur = 3 + 12 * rand(); // the first lull is shorter
    this.v = this.lo;
  }
  next() {
    const r = this.rand;
    this.t = 0;
    if (this.phase === 'lull') {
      this.phase = 'rise';
      this.from = this.v;
      this.hi = 0.65 + 0.35 * r();
      this.dur = 5 + 10 * r();
    } else if (this.phase === 'rise') {
      this.phase = 'hold';
      this.dur = 2 + 6 * r();
    } else if (this.phase === 'hold') {
      this.phase = 'fall';
      this.from = this.v;
      this.lo = 0.15 + 0.1 * r();
      this.dur = 5 + 10 * r();
    } else {
      this.phase = 'lull';
      this.dur = 10 + 30 * r();
    }
  }
  /** Advance by dt seconds; returns the level 0..1. */
  update(dt) {
    this.t += dt;
    if (this.t >= this.dur) this.next();
    const k = _smooth(0, 1, this.t / this.dur);
    if (this.phase === 'rise') this.v = this.from + (this.hi - this.from) * k;
    else if (this.phase === 'fall') this.v = this.from + (this.lo - this.from) * k;
    else if (this.phase === 'hold') this.v = this.hi;
    else this.v = this.lo;
    return this.v;
  }
}

const WIND_STEP = 0.25; // s: the envelope and the mix targets update at 4 Hz (setTargetAtTime smooths in between)

export function createWind(ac, dest, N) {
  const bed = new Bed(ac, dest);
  const bp = bq(ac, 'bandpass', 420, 0.8);
  const gust = gain(ac, 0);
  loopSrc(ac, N.pink, 1).connect(bp).connect(gust).connect(bed.out);
  const gl = [lfo(ac, 0.071, 0, gust.gain), lfo(ac, 0.163, 0, gust.gain), lfo(ac, 0.031, 0, gust.gain)];
  lfo(ac, 0.071, 140, bp.frequency);
  lfo(ac, 0.113, 90, bp.frequency);
  const hsrc = loopSrc(ac, N.white, 1);
  const h1 = bq(ac, 'bandpass', 620, 9), h2 = bq(ac, 'bandpass', 940, 7);
  const hg = gain(ac, 0);
  hsrc.connect(h1).connect(hg);
  hsrc.connect(h2).connect(hg);
  hg.connect(bed.out);
  lfo(ac, 0.05, 180, h1.frequency);
  lfo(ac, 0.083, 240, h2.frequency);
  const hl = lfo(ac, 0.12, 0, hg.gain);
  const lg = gain(ac, 0);
  loopSrc(ac, N.white, 0.9).connect(bq(ac, 'highpass', 2600, 0.7)).connect(bq(ac, 'lowpass', 9000, 0.7)).connect(lg).connect(bed.out);
  const ll = lfo(ac, 0.071, 0, lg.gain);
  const T = {
    gust: new Target(gust.gain, 0, 0.6),
    g0: new Target(gl[0].g.gain, 0, 0.6),
    g1: new Target(gl[1].g.gain, 0, 0.6),
    g2: new Target(gl[2].g.gain, 0, 0.6),
    freq: new Target(bp.frequency, 420, 1.0, 0.03, true),
    howl: new Target(hg.gain, 0, 1.2),
    howlL: new Target(hl.g.gain, 0, 1.2),
    rustle: new Target(lg.gain, 0, 0.8),
    rustleL: new Target(ll.g.gain, 0, 0.8),
  };
  const env = new WindEnvelope();
  let acc = WIND_STEP; // first call updates at once
  let level = 0;
  return {
    bed,
    /** Current slow envelope level (0..1), for debugging. */
    get envelope() {
      return level;
    },
    /**
     * w = { base, howl, rustle } (mix.windLevels), strength 0..1.5.
     * o = { canopy 0..1, storm 0..1, coast (m inland, + = inland), forest 0..1 } (optional): under a full canopy the wind
     * drops to ~25 % (mix.windLevels already takes 45 % off), deep inland forest is quieter than the beach, and a slow
     * random envelope makes it swell and lull. Storms override both (they stay loud).
     */
    update(t, dt, w, strength, o) {
      acc += dt;
      if (acc < WIND_STEP) return;
      const step = acc;
      acc = 0;
      const any = w.base + w.howl + w.rustle;
      bed.setLevel(any > 0.002 ? 1 : 0, t, step, 0.5);
      const storm = _clamp01(o?.storm ?? 0);
      const e = env.update(step);
      level = e + (1 - e) * storm; // storms: always near the peak
      if (!bed.connected) return;
      const calm = 1 - 0.7 * storm;
      const canopy = _clamp01(o?.canopy ?? 0) * calm;
      const shelter = 1 - 0.55 * canopy; // x windLevels' (1 - 0.45 canopy) = ~0.25 under a full canopy
      const inland = _smooth(25, 110, o?.coast ?? 0) * _clamp01(o?.forest ?? 0) * calm;
      const deep = 1 - 0.35 * inland; // the inland forest is calmer than the open beach
      const k = level * shelter * deep;
      const b = w.base * k;
      T.gust.set(0.6 * b, t);
      T.g0.set(0.22 * b, t);
      T.g1.set(0.15 * b, t);
      T.g2.set(0.18 * b, t);
      T.freq.set(360 + 320 * Math.min(1.5, strength) * (0.75 + 0.25 * level), t);
      const hw = w.howl * k;
      T.howl.set(0.16 * hw, t);
      T.howlL.set(0.12 * hw, t);
      const ru = w.rustle * (0.35 + 0.65 * level) * (1 - 0.4 * canopy) * deep; // leaves keep a soft rustle in a lull
      T.rustle.set(0.22 * ru, t);
      T.rustleL.set(0.16 * ru, t);
    },
  };
}

// ── Rain ────────────────────────────────────────────────────────────────
export function createRain(ac, dest, N) {
  const bed = new Bed(ac, dest);
  const lp = bq(ac, 'lowpass', 7000, 0.6);
  const hiss = gain(ac, 0);
  loopSrc(ac, N.pink, 1.05).connect(bq(ac, 'highpass', 500, 0.7)).connect(lp).connect(hiss).connect(bed.out);
  const heavy = gain(ac, 0);
  loopSrc(ac, N.brown, 1.1).connect(bq(ac, 'lowpass', 500, 0.7)).connect(heavy).connect(bed.out);
  const T = { hiss: new Target(hiss.gain, 0, 0.8), heavy: new Target(heavy.gain, 0, 1.0), lp: new Target(lp.frequency, 7000, 0.6, 0.03, true) };
  return {
    bed,
    /** rain 0..1, muffled 0..1 (sheltered / under thick canopy / underwater) */
    update(t, dt, rain, muffled) {
      bed.setLevel(rain > 0.01 ? 1 : 0, t, dt, 0.8);
      if (!bed.connected) return;
      T.hiss.set(0.55 * Math.pow(rain, 0.8), t);
      T.heavy.set(0.5 * rain * rain, t);
      T.lp.set(7000 - 5400 * muffled, t);
    },
  };
}

// ── River babble / lake lapping ─────────────────────────────────────────
export function createWater(ac, dest, N) {
  const bed = new Bed(ac, dest);
  const pan = ac.createStereoPanner();
  pan.connect(bed.out);
  const src = loopSrc(ac, N.pink, 1);
  const bands = [];
  for (const [f, q, df, rf, rg] of [[450, 2.5, 120, 0.7, 0.9], [1150, 3, 300, 1.3, 1.7], [2600, 4, 600, 2.1, 2.9]]) {
    const b = bq(ac, 'bandpass', f, q);
    const g = gain(ac, 0.5);
    src.connect(b).connect(g).connect(pan);
    const fl = lfo(ac, rf, df, b.frequency);
    const gl = lfo(ac, rg, 0.3, g.gain);
    bands.push({ f, df, rf, rg, freq: new Target(b.frequency, f, 0.8, 0.03, true), depth: new Target(fl.g.gain, df, 0.8, 0.03, true), rate: new Target(fl.o.frequency, rf, 0.8, 0.03, true), grate: new Target(gl.o.frequency, rg, 0.8, 0.03, true) });
  }
  const sp = gain(ac, 0.07);
  loopSrc(ac, N.white, 1).connect(bq(ac, 'highpass', 4500, 0.7)).connect(sp).connect(pan);
  const panT = new Target(pan.pan, 0, 0.6, 0.03);
  const spT = new Target(sp.gain, 0.07, 0.8);
  return {
    bed,
    /** level 0..1, panV −1..1, calm 0 (river babble) .. 1 (lake lapping) */
    update(t, dt, level, panV, calm) {
      bed.setLevel(level * 0.55, t, dt, 0.8);
      if (!bed.connected) return;
      panT.set(panV, t);
      const s = 1 - 0.45 * calm, rs = 1 - 0.55 * calm;
      for (const b of bands) {
        b.freq.set(b.f * s, t);
        b.depth.set(b.df * s, t);
        b.rate.set(b.rf * rs, t);
        b.grate.set(b.rg * rs, t);
      }
      spT.set(0.07 * (1 - 0.8 * calm), t);
    },
  };
}

// ── Insects: night crickets + afternoon cicadas ─────────────────────────
export function createInsects(ac, dest, N) {
  const bed = new Bed(ac, dest);
  const crickets = gain(ac, 0);
  crickets.connect(bed.out);
  for (const [f, syl, chirp, p] of [[4300, 29, 1.7, -0.6], [4750, 33, 2.3, 0.1], [5150, 26, 2.9, 0.65]]) {
    const car = osc(ac, 'sine', f);
    lfo(ac, 0.07 + Math.random() * 0.08, 25, car.frequency); // slow pitch drift (temperature)
    const am = gain(ac, 0.5);
    lfo(ac, syl, 0.5, am.gain, 'square'); // syllable pulses
    const gate = gain(ac, 0);
    const go = osc(ac, 'sine', chirp * (0.95 + Math.random() * 0.1));
    const sh = ac.createWaveShaper();
    sh.curve = gateCurve();
    go.connect(sh).connect(gate.gain); // chirp groups
    const pn = ac.createStereoPanner();
    pn.pan.value = p;
    car.connect(am).connect(gate).connect(pn).connect(crickets);
  }
  const cicada = gain(ac, 0);
  cicada.connect(bed.out);
  const cam = gain(ac, 0.5);
  const sw = gain(ac, 0.5);
  loopSrc(ac, N.white, 1).connect(bq(ac, 'bandpass', 5200, 5)).connect(cam).connect(sw).connect(cicada);
  lfo(ac, 95, 0.5, cam.gain, 'square');
  lfo(ac, 0.06, 0.5, sw.gain);
  const T = { c: new Target(crickets.gain, 0, 1.5), z: new Target(cicada.gain, 0, 2.0) };
  return {
    bed,
    update(t, dt, cricketLv, cicadaLv) {
      bed.setLevel(cricketLv + cicadaLv > 0.002 ? 1 : 0, t, dt, 1);
      if (!bed.connected) return;
      T.c.set(0.11 * cricketLv, t);
      T.z.set(0.09 * cicadaLv, t);
    },
  };
}

// ── Fire (positional; crackle one-shots connect to `input`) ─────────────
export function createFire(ac, dest, N) {
  const panner = makePanner(ac, { ref: 1.6, rolloff: 1.1, max: 200 });
  panner.connect(dest);
  const bed = new Bed(ac, panner);
  const roar = gain(ac, 0.6);
  loopSrc(ac, N.brown, 0.9).connect(bq(ac, 'lowpass', 280, 0.8)).connect(roar).connect(bed.out);
  const fl = gain(ac, 0.22);
  loopSrc(ac, N.pink, 1).connect(bq(ac, 'bandpass', 900, 0.8)).connect(fl).connect(bed.out);
  lfo(ac, 3.1, 0.1, fl.gain);
  lfo(ac, 7.3, 0.07, fl.gain);
  const input = gain(ac, 1);
  input.connect(panner);
  return {
    bed,
    panner,
    input,
    update(t, dt, level, x, y, z) {
      bed.setLevel(level, t, dt, 0.5);
      if (level > 0) setPannerPos(panner, x, y, z);
    },
  };
}

// ── Underwater rumble ───────────────────────────────────────────────────
export function createUnderwater(ac, dest, N) {
  const bed = new Bed(ac, dest);
  const g = gain(ac, 0.9);
  loopSrc(ac, N.brown, 0.6).connect(bq(ac, 'lowpass', 200, 0.9)).connect(g).connect(bed.out);
  lfo(ac, 0.2, 0.25, g.gain);
  return {
    bed,
    update(t, dt, level) {
      bed.setLevel(level, t, dt, 0.08);
    },
  };
}

// ── Positional vehicle loops ────────────────────────────────────────────
/** Shared shell: mix → air absorption → volume → panner → dest. Detune/rate nodes receive Doppler. */
function loopShell(ac, dest, ref) {
  const panner = makePanner(ac, { ref, rolloff: 1, max: 5000 });
  const vol = gain(ac, 0);
  const air = bq(ac, 'lowpass', 18000, 0.5);
  const mixG = gain(ac, 1);
  mixG.connect(air).connect(vol).connect(panner);
  return { panner, vol, air, mixG, dest, connected: false, silent: 0, detune: [], rate: [] };
}

let _pulse = null;
function pulseWave(ac) {
  if (_pulse && _pulse.ac === ac) return _pulse.w;
  const n = 14, real = new Float32Array(n), imag = new Float32Array(n);
  for (let k = 1; k < n; k++) real[k] = 1 - k / (n + 2);
  _pulse = { ac, w: ac.createPeriodicWave(real, imag) };
  return _pulse.w;
}

/** Helicopter: ~16 Hz blade chop (noise gated by a sharp pulse wave), low blade slap, turbine whine. */
export function createRotor(ac, dest, N) {
  const L = loopShell(ac, dest, 30);
  const chopSrc = loopSrc(ac, N.pink, 1);
  const chop = gain(ac, 0.12);
  chopSrc.connect(bq(ac, 'lowpass', 1100, 0.7)).connect(chop).connect(L.mixG);
  const pulse = ac.createOscillator();
  pulse.setPeriodicWave(pulseWave(ac));
  pulse.frequency.value = 16;
  pulse.start();
  pulse.connect(gain(ac, 0.6)).connect(chop.gain);
  pulse.connect(bq(ac, 'lowpass', 140, 1)).connect(gain(ac, 0.9)).connect(L.mixG);
  const t1 = osc(ac, 'sine', 1240), t2 = osc(ac, 'sine', 2490);
  const tw = gain(ac, 0.03);
  t1.connect(tw);
  t2.connect(tw);
  tw.connect(L.mixG);
  lfo(ac, 0.4, 6, t1.frequency);
  const hiss = loopSrc(ac, N.white, 1);
  hiss.connect(bq(ac, 'bandpass', 3200, 2)).connect(gain(ac, 0.03)).connect(L.mixG);
  L.detune.push(pulse, t1, t2);
  L.rate.push(chopSrc, hiss);
  return L;
}

/** Search boat diesel: sawtooth putt-putt gated at the firing rate, valve knock, bow wash. */
export function createEngine(ac, dest, N) {
  const L = loopShell(ac, dest, 15);
  const saw = osc(ac, 'sawtooth', 46);
  const am = gain(ac, 0.5);
  saw.connect(bq(ac, 'lowpass', 240, 2)).connect(am).connect(L.mixG);
  const fire = osc(ac, 'square', 11.5);
  fire.connect(gain(ac, 0.45)).connect(am.gain);
  const knock = gain(ac, 0.05);
  loopSrc(ac, N.pink, 1).connect(bq(ac, 'bandpass', 650, 1.5)).connect(knock).connect(L.mixG);
  fire.connect(gain(ac, 0.05)).connect(knock.gain);
  const wash = gain(ac, 0.1);
  const ws = loopSrc(ac, N.white, 1);
  ws.connect(bq(ac, 'bandpass', 900, 0.6)).connect(wash).connect(L.mixG);
  lfo(ac, 0.3, 0.05, wash.gain);
  L.detune.push(saw, fire);
  L.rate.push(ws);
  return L;
}
