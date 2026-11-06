// One-shot sound recipes (Builder F2). Every sound is synthesized from noise + oscillators with the
// pure DSP helpers in dsp.js, then baked once into an AudioBuffer by audio.js (several random
// variants per sound, picked at random on play with a small pitch jitter → no two steps alike).
//
// RECIPES[name] = {
//   variants  number of baked variants
//   sr        bake sample rate (low for rumbles, high for sparkly sounds)
//   gain      relative loudness in the mix (buffers are normalized, so this IS the level)
//   jitter    random playback-rate spread (±)
//   cooldown  same-name de-duplication window in seconds (other modules also call play())
//   ref, rolloff  PannerNode distance model when played with a position
//   render(sr, rand, v) -> Float32Array (un-normalized; renderSound() finishes it)
// }
// Pure module: safe to import in node (tests/audio.test.mjs renders every variant).
import { rng, buf, envAD, filt, filtFn, noise, tone, grains, mix, shape, shapeCR, softclip, finish, voiced } from './dsp.js';

export const RECIPES = {};
function def(name, meta, render) {
  RECIPES[name] = { variants: 1, sr: 32000, gain: 0.5, jitter: 0.05, cooldown: 0.06, ref: 3, rolloff: 1, ...meta, render };
}

// Small shared building blocks ------------------------------------------------
/** Rising "bloop" (air bubble resonance). */
function bubble(a, sr, r, t0, amp) {
  const f = 500 + r() * 1400;
  tone(a, sr, t0, 0.05, f, amp * (0.5 + r() * 0.5), { f1: f * 1.7, a: 0.002, tau: 0.018 });
}
/** A filtered noise burst layer mixed at t0. */
function burst(a, sr, r, t0, sec, amp, color, att, tau, filters) {
  const n = noise(buf(sr, sec), r, color);
  shape(n, sr, (t) => envAD(t, att, tau));
  for (const [type, f, q, f1] of filters) filt(n, sr, type, f, q ?? 0.707, f1 ?? f);
  return mix(a, n, sr, t0, amp);
}

// ── Footsteps ───────────────────────────────────────────────────────────
def('footstep_sand', { variants: 6, gain: 0.3, jitter: 0.08 }, (sr, r) => {
  const a = buf(sr, 0.28);
  for (const [t0, A] of [[0, 1], [0.05 + r() * 0.03, 0.6]]) {
    const g = noise(buf(sr, 0.16), r, 'pink', 0.6);
    shape(g, sr, (t) => envAD(t, 0.006, 0.035));
    grains(g, sr, r, 0, 0.12, 50, 0.5, 0.0015, 0.04);
    filt(g, sr, 'bp', 1100 + r() * 500, 0.7);
    filt(g, sr, 'lp', 3800);
    mix(a, g, sr, t0, A);
  }
  tone(a, sr, 0, 0.08, 90, 0.22, { f1: 60, tau: 0.025 });
  return a;
});

def('footstep_grass', { variants: 6, gain: 0.28, jitter: 0.08 }, (sr, r) => {
  const a = buf(sr, 0.3);
  for (const [t0, A] of [[0, 1], [0.06 + r() * 0.03, 0.55]]) {
    const g = noise(buf(sr, 0.2), r, 'white', 0.5);
    shape(g, sr, (t) => envAD(t, 0.015, 0.05));
    grains(g, sr, r, 0.005, 0.1, 18, 0.6, 0.001, 0.05); // twigs and dry leaves
    filt(g, sr, 'hp', 1600 + r() * 600, 0.6);
    filt(g, sr, 'lp', 7000);
    mix(a, g, sr, t0, A);
  }
  tone(a, sr, 0, 0.07, 110, 0.16, { f1: 70, tau: 0.02 });
  return a;
});

def('footstep_rock', { variants: 6, gain: 0.32, jitter: 0.07 }, (sr, r) => {
  const a = buf(sr, 0.2);
  for (const [t0, A] of [[0, 1], [0.04 + r() * 0.03, 0.5]]) {
    tone(a, sr, t0, 0.08, 120 + r() * 40, 0.55 * A, { f1: 70, tau: 0.02 });
    const c = noise(buf(sr, 0.09), r, 'white');
    shape(c, sr, (t) => envAD(t, 0.0005, 0.004));
    grains(c, sr, r, 0.003, 0.06, 14, 0.35, 0.001, 0.025); // grit under the sole
    filt(c, sr, 'hp', 1800, 0.8);
    filt(c, sr, 'bp', 3200 + r() * 1500, 0.9);
    mix(a, c, sr, t0, 1.2 * A);
  }
  return a;
});

def('footstep_water', { variants: 5, gain: 0.32, jitter: 0.1 }, (sr, r) => {
  const a = buf(sr, 0.45);
  burst(a, sr, r, 0, 0.4, 1, 'white', 0.012, 0.07, [['bp', 2200, 1.1, 650]]);
  burst(a, sr, r, 0, 0.3, 0.6, 'brown', 0.02, 0.06, [['lp', 420]]);
  for (let i = 0; i < 4; i++) bubble(a, sr, r, 0.03 + r() * 0.25, 0.25);
  return a;
});

def('footstep_wood', { variants: 4, gain: 0.3 }, (sr, r) => {
  const a = buf(sr, 0.2);
  for (const [t0, A] of [[0, 1], [0.045 + r() * 0.02, 0.5]]) {
    const f = 170 + r() * 40;
    tone(a, sr, t0, 0.12, f, 0.6 * A, { a: 0.001, tau: 0.035 });
    tone(a, sr, t0, 0.08, f * 2.37, 0.3 * A, { a: 0.001, tau: 0.02 });
    burst(a, sr, r, t0, 0.03, 0.5 * A, 'white', 0.0003, 0.003, [['hp', 1500]]);
  }
  return a;
});

/** Swimming stroke (footstep events with swim:true). */
def('swim', { variants: 4, gain: 0.26, jitter: 0.1 }, (sr, r) => {
  const a = noise(buf(sr, 0.75), r, 'pink');
  shape(a, sr, (t) => envAD(t, 0.12, 0.16));
  filt(a, sr, 'bp', 700, 0.9, 1500);
  for (let i = 0; i < 3; i++) bubble(a, sr, r, 0.1 + r() * 0.4, 0.12);
  return a;
});

// ── Body ────────────────────────────────────────────────────────────────
def('jump', { variants: 3, gain: 0.24, jitter: 0.05 }, (sr, r) => {
  const a = buf(sr, 0.3);
  const b = noise(buf(sr, 0.25), r, 'white');
  shape(b, sr, (t) => envAD(t, 0.012, 0.05));
  mix(a, filt(b.slice(), sr, 'bp', 750 + r() * 100, 4), sr, 0, 1); // breathy "hup" formants
  mix(a, filt(b, sr, 'bp', 1350 + r() * 150, 5), sr, 0, 0.6);
  burst(a, sr, r, 0, 0.3, 0.35, 'white', 0.05, 0.06, [['hp', 1200], ['lp', 5000]]); // clothes
  return a;
});

def('land', { variants: 3, gain: 0.42, jitter: 0.06 }, (sr, r) => {
  const a = buf(sr, 0.35);
  tone(a, sr, 0, 0.25, 85 + r() * 15, 0.9, { f1: 42, a: 0.002, tau: 0.06 });
  burst(a, sr, r, 0, 0.25, 0.7, 'brown', 0.003, 0.04, [['lp', 600]]);
  const g = grains(buf(sr, 0.2), sr, r, 0, 0.12, 30, 0.4, 0.0015, 0.04);
  mix(a, filt(g, sr, 'bp', 1800, 0.8), sr, 0.005, 0.5);
  return a;
});

def('splash', { variants: 3, gain: 0.48, cooldown: 0.45, jitter: 0.08, ref: 4 }, (sr, r) => {
  const a = buf(sr, 1.2);
  burst(a, sr, r, 0, 0.9, 1, 'white', 0.006, 0.17, [['bp', 2600, 0.9, 550]]);
  tone(a, sr, 0, 0.3, 130, 0.5, { f1: 55, a: 0.004, tau: 0.08 }); // plunge
  burst(a, sr, r, 0, 0.6, 0.7, 'brown', 0.02, 0.15, [['lp', 500]]);
  for (let i = 0; i < 22; i++) bubble(a, sr, r, 0.04 + Math.pow(r(), 1.6) * 0.75, 0.2);
  for (let i = 0; i < 10; i++) tone(a, sr, 0.22 + r() * 0.55, 0.03, 2200 + r() * 2400, 0.08, { a: 0.001, tau: 0.007 }); // droplets
  return a;
});

def('hurt', { variants: 3, gain: 0.42, cooldown: 0.25, jitter: 0.04 }, (sr, r, v) => {
  const a = buf(sr, 0.45);
  const f0 = 135 + v * 12 + r() * 10;
  const g = voiced(sr, 0.4, (t) => f0 * (1.12 - 0.35 * t), [[620, 6, 1], [1080, 7, 0.55], [2500, 9, 0.18]], (t) => envAD(t, 0.02, 0.11), r, 0.25);
  mix(a, g, sr, 0, 1);
  tone(a, sr, 0, 0.12, 80, 0.4, { f1: 50, tau: 0.035 });
  return a;
});

def('gasp', { variants: 2, gain: 0.4, cooldown: 1.2 }, (sr, r) => {
  const a = buf(sr, 0.9);
  const inh = noise(buf(sr, 0.5), r, 'white');
  shape(inh, sr, (t) => (t < 0.32 ? Math.pow(t / 0.32, 1.5) : Math.exp(-(t - 0.32) / 0.03)));
  mix(a, filt(inh.slice(), sr, 'bp', 1300, 2.5, 1700), sr, 0, 1);
  mix(a, filt(inh, sr, 'bp', 2600, 3, 3000), sr, 0, 0.5);
  const vo = voiced(sr, 0.35, (t) => 210 + 40 * t, [[800, 5, 1], [1500, 6, 0.4]], (t) => (t < 0.28 ? t / 0.28 : Math.exp(-(t - 0.28) / 0.02)) * 0.25, r, 0.6);
  mix(a, vo, sr, 0, 1);
  burst(a, sr, r, 0.42, 0.4, 0.5, 'pink', 0.05, 0.1, [['bp', 900, 1.5]]); // exhale
  return a;
});

def('heartbeat', { gain: 0.5, cooldown: 0.2, jitter: 0.02 }, (sr, r) => {
  const a = buf(sr, 0.7);
  for (const [t0, f, g] of [[0, 62, 1], [0.27, 75, 0.7]]) {
    tone(a, sr, t0, 0.22, f, g, { f1: f * 0.7, a: 0.008, tau: 0.05 });
    burst(a, sr, r, t0, 0.12, g * 0.6, 'brown', 0.006, 0.03, [['lp', 180]]);
  }
  return a;
});

// ── Gameplay ────────────────────────────────────────────────────────────
def('pickup', { variants: 4, gain: 0.3, jitter: 0.06, ref: 2.5 }, (sr, r) => {
  const a = buf(sr, 0.3);
  const n = noise(buf(sr, 0.15), r, 'white');
  shape(n, sr, (t) => envAD(t, 0.008, 0.03));
  grains(n, sr, r, 0, 0.08, 12, 0.5, 0.001);
  filt(n, sr, 'hp', 2000);
  mix(a, filt(n, sr, 'lp', 8000), sr, 0, 0.6);
  const f = 620 + r() * 120;
  tone(a, sr, 0.015, 0.2, (t) => f * (1 + 0.5 * Math.min(1, t / 0.03)), 0.45, { a: 0.003, tau: 0.06, harm: [[2, 0.25]] });
  return a;
});

def('craft', { variants: 2, gain: 0.42, cooldown: 0.3 }, (sr, r) => {
  const a = buf(sr, 1.4);
  for (let k = 0; k < 3; k++) {
    const t0 = k * 0.17 + r() * 0.02, f = 260 + r() * 80;
    tone(a, sr, t0, 0.15, f, 0.6, { a: 0.001, tau: 0.04 });
    tone(a, sr, t0, 0.1, f * 2.6, 0.25, { a: 0.001, tau: 0.02 });
    burst(a, sr, r, t0, 0.03, 0.5, 'white', 0.0003, 0.004, [['hp', 1200]]);
  }
  const z = noise(buf(sr, 0.2), r, 'white');
  shape(z, sr, (t) => Math.sin(Math.PI * Math.min(1, t / 0.18)));
  mix(a, filt(z, sr, 'bp', 1800, 2, 4200), sr, 0.52, 0.35); // rope pulled tight
  for (const [f, g] of [[1046.5, 0.3], [1568, 0.22], [2093, 0.1]]) tone(a, sr, 0.74, 0.65, f, g, { a: 0.004, tau: 0.22 });
  return a;
});

def('eat', { variants: 3, gain: 0.38, cooldown: 0.3 }, (sr, r) => {
  const a = buf(sr, 1.0);
  for (let k = 0; k < 3; k++) {
    const t0 = 0.02 + k * (0.24 + r() * 0.06), A = k === 0 ? 1 : 0.6;
    const c = grains(buf(sr, 0.12), sr, r, 0, 0.07, 40, 0.8, 0.0012, 0.03);
    noise(c, r, 'white', 0.1);
    shape(c, sr, (t) => envAD(t, 0.002, 0.03));
    filt(c, sr, 'bp', 2000 + r() * 1200, 0.7);
    mix(a, filt(c, sr, 'lp', 6000), sr, t0, A);
    tone(a, sr, t0, 0.05, 140, 0.25 * A, { f1: 90, tau: 0.015 });
  }
  return a;
});

def('drink', { variants: 2, gain: 0.4, cooldown: 0.3 }, (sr, r) => {
  const a = buf(sr, 1.1);
  for (let k = 0; k < 3; k++) {
    const t0 = 0.05 + k * (0.3 + r() * 0.05), f = 300 + r() * 60;
    tone(a, sr, t0, 0.12, f, 0.7, { f1: f * 0.55, a: 0.006, tau: 0.035 }); // glug
    burst(a, sr, r, t0, 0.1, 0.4, 'pink', 0.004, 0.025, [['bp', 520, 3]]);
  }
  burst(a, sr, r, 0.92, 0.18, 0.25, 'pink', 0.04, 0.05, [['bp', 1000, 1.2]]); // "ahh"
  return a;
});

def('ignite', { variants: 2, gain: 0.48, ref: 3, cooldown: 0.3 }, (sr, r) => {
  const a = buf(sr, 1.4);
  burst(a, sr, r, 0, 0.03, 0.6, 'white', 0.0003, 0.005, [['hp', 4000]]); // flint strike
  const w = noise(buf(sr, 1.3), r, 'pink');
  shape(w, sr, (t) => (t < 0.25 ? Math.pow(t / 0.25, 2) : Math.exp(-(t - 0.25) / 0.35)));
  filtFn(w, sr, 'lp', (t) => 180 + 2600 * Math.min(1, t / 0.3) * Math.exp(-Math.max(0, t - 0.3) / 0.6), 0.9);
  mix(a, w, sr, 0.05, 1); // whoomph
  tone(a, sr, 0.05, 0.6, 55, 0.4, { a: 0.15, tau: 0.25 });
  const c = grains(buf(sr, 1.3), sr, r, 0.2, 1.0, 14, 0.6, 0.0015);
  mix(a, filt(c, sr, 'hp', 1800), sr, 0, 0.5);
  return a;
});

def('cook', { variants: 2, gain: 0.32, ref: 3, cooldown: 0.4 }, (sr, r) => {
  const a = buf(sr, 1.6);
  const s = noise(buf(sr, 1.6), r, 'white');
  let m = 0.5;
  shape(s, sr, (t) => {
    m += (r() - 0.5) * 0.08; // sizzle flutter (random walk)
    m = m < 0.2 ? 0.2 : m > 1 ? 1 : m;
    return m * Math.min(1, t / 0.06) * Math.min(1, (1.6 - t) / 0.5);
  });
  filt(s, sr, 'hp', 3200);
  mix(a, filt(s, sr, 'lp', 9000), sr, 0, 0.6);
  const c = grains(buf(sr, 1.6), sr, r, 0, 1.5, 60, 0.7, 0.0008);
  mix(a, filt(c, sr, 'hp', 2500), sr, 0, 0.6);
  for (let i = 0; i < 4; i++) burst(a, sr, r, r() * 1.4, 0.04, 0.8, 'white', 0.0005, 0.008, [['bp', 800 + r() * 500, 3]]);
  return a;
});

def('place', { variants: 2, gain: 0.42, ref: 3, cooldown: 0.3 }, (sr, r) => {
  const a = buf(sr, 0.6);
  tone(a, sr, 0, 0.3, 95, 0.8, { f1: 55, a: 0.002, tau: 0.07 });
  burst(a, sr, r, 0, 0.5, 0.6, 'pink', 0.005, 0.12, [['bp', 900, 0.8]]);
  const g = grains(buf(sr, 0.5), sr, r, 0, 0.4, 30, 0.6, 0.002, 0.12);
  mix(a, filt(g, sr, 'hp', 1500), sr, 0.02, 0.5);
  return a;
});

def('snuff', { gain: 0.32, ref: 3, cooldown: 0.5 }, (sr, r) => {
  const a = noise(buf(sr, 1.2), r, 'white');
  shape(a, sr, (t) => envAD(t, 0.02, 0.32));
  filt(a, sr, 'hp', 2200);
  filt(a, sr, 'lp', 7000);
  const c = grains(buf(sr, 1), sr, r, 0, 0.8, 10, 0.5, 0.001, 0.3);
  return mix(a, filt(c, sr, 'hp', 2000), sr, 0, 0.5);
});

// ── Trees ───────────────────────────────────────────────────────────────
/** Stick-slip friction: an impulse train with a wandering rate, rung through wooden resonances. */
function creak(sr, r, dur, rateFn, modes) {
  const ex = buf(sr, dur);
  let ph = 0;
  for (let i = 0; i < ex.length; i++) {
    ph += rateFn(i / sr) / sr;
    if (ph >= 1) {
      ph -= 1;
      ex[i] = 0.6 + r() * 0.4;
    }
  }
  const out = buf(sr, dur);
  for (const [f, q, g] of modes) mix(out, filt(ex.slice(), sr, 'bp', f, q), sr, 0, g);
  return out;
}

def('tree_creak', { variants: 2, sr: 22050, gain: 0.55, ref: 7, cooldown: 0.5 }, (sr, r) => {
  const dur = 2.8, p1 = r() * 6, p2 = r() * 6;
  const a = creak(sr, r, dur, (t) => 38 + 22 * Math.sin(t * 1.7 + p1) + 12 * Math.sin(t * 4.3 + p2) + 8 * (r() - 0.5), [[380 + r() * 60, 14, 1], [820 + r() * 80, 12, 0.7], [1500, 9, 0.35]]);
  shape(a, sr, (t) => Math.min(1, t / 0.5) * (0.6 + 0.4 * Math.sin(t * 2.3 + p1)) * Math.min(1, (dur - t) / 0.4));
  const k = grains(buf(sr, 0.5), sr, r, 0, 0.4, 25, 1, 0.002, 0.15); // fibres starting to split
  return mix(a, filt(k, sr, 'bp', 2400, 1), sr, dur - 0.6, 0.6);
});

def('tree_crash', { variants: 2, sr: 22050, gain: 0.9, ref: 14, cooldown: 0.5 }, (sr, r) => {
  const dur = 4.2, a = buf(sr, dur), T = 1.35 + r() * 0.2;
  const c = noise(buf(sr, 0.6), r, 'white');
  shape(c, sr, (t) => envAD(t, 0.0005, 0.03));
  grains(c, sr, r, 0, 0.5, 40, 0.8, 0.002, 0.12);
  mix(a, filt(c, sr, 'hp', 900), sr, 0, 1); // the trunk gives way
  const w = noise(buf(sr, T + 0.3), r, 'pink');
  shapeCR(w, sr, (t) => Math.pow(Math.min(1, t / T), 2.2) * (t > T ? Math.exp(-(t - T) / 0.08) : 1), 8);
  mix(a, filt(w, sr, 'bp', 500, 0.8, 2200), sr, 0.1, 0.9); // the crown rushing down through the air
  tone(a, sr, T, 1.2, 48, 1.1, { f1: 28, a: 0.004, tau: 0.32 }); // impact
  burst(a, sr, r, T, 1.6, 1.0, 'brown', 0.005, 0.35, [['lp', 260]]);
  const s = grains(buf(sr, 1.2), sr, r, 0, 0.9, 50, 1, 0.003, 0.25);
  mix(a, filt(s, sr, 'bp', 1800, 0.9), sr, T, 0.7); // branches snapping
  burst(a, sr, r, T, 2.6, 0.35, 'white', 0.02, 0.6, [['hp', 2200], ['lp', 7000]]); // leaves thrashing
  const late = grains(buf(sr, 1.4), sr, r, 0, 1.3, 6, 0.6, 0.003);
  mix(a, filt(late, sr, 'bp', 1400, 1.2), sr, T + 0.9, 0.5);
  return softclip(a, 1.4);
});

// ── Story / easter eggs ─────────────────────────────────────────────────
def('quack', { variants: 3, gain: 0.55, ref: 8, cooldown: 0.12, jitter: 0.04 }, (sr, r, v) => {
  const a = buf(sr, 0.42);
  const f0 = 380 + v * 45 + r() * 30, dur = 0.24 + r() * 0.06;
  const q = voiced(
    sr,
    dur,
    (t) => f0 * (t < 0.04 ? 0.85 + 3.75 * t : 1.0 - (0.45 * (t - 0.04)) / dur),
    [[1150, 5, 1], [2300, 6, 0.6], [3400, 8, 0.25]],
    (t) => Math.min(1, t / 0.012) * Math.min(1, (dur - t) / 0.06) * (0.75 + 0.25 * Math.sin(t * Math.PI * 2 * 55)),
    r,
    0.12
  );
  return mix(a, q, sr, 0, 1);
});

def('chime', { sr: 44100, gain: 0.48, cooldown: 0.4 }, (sr, r) => {
  const a = buf(sr, 2.8);
  [1046.5, 1318.5, 1568, 2093].forEach((f, k) => {
    const t0 = k * 0.085;
    for (const [m, g, tau] of [[1, 1, 0.9], [2.0, 0.28, 0.5], [3.01, 0.12, 0.3], [4.17, 0.06, 0.18]]) tone(a, sr, t0, Math.min(2.6 - t0, tau * 6), f * m, g * 0.5, { a: 0.002, tau });
  });
  for (let i = 0; i < 26; i++) tone(a, sr, 0.25 + r() * 1.5, 0.25, 3000 + r() * 4500, 0.04 + r() * 0.04, { a: 0.003, tau: 0.06 }); // sparkle
  return a;
});

/** Soft magical pad + sparkles (stone circle meteor shower). */
def('shimmer', { sr: 22050, gain: 0.42, cooldown: 2 }, (sr, r) => {
  const dur = 7, a = buf(sr, dur);
  const env = (t) => Math.min(1, t / 2.5) * Math.min(1, (dur - t) / 2.5);
  for (const f of [261.6, 392, 523.3, 659.3, 784]) for (const d of [-0.003, 0.003]) tone(a, sr, 0, dur, f * (1 + d), 0.12, { env }); // detuned pairs beat slowly
  for (let i = 0; i < 40; i++) tone(a, sr, 0.5 + r() * 5.5, 0.4, 2000 + r() * 5000, 0.05, { a: 0.01, tau: 0.12 });
  return a;
});

def('flare', { gain: 0.58, ref: 10, cooldown: 0.5 }, (sr, r) => {
  const a = buf(sr, 3.4);
  tone(a, sr, 0, 0.2, 95, 0.8, { f1: 55, a: 0.001, tau: 0.04 }); // launch thump
  burst(a, sr, r, 0, 0.15, 0.9, 'white', 0.0005, 0.02, [['lp', 2000]]);
  burst(a, sr, r, 0.03, 3.2, 0.7, 'white', 0.04, 1.1, [['bp', 3200, 0.7], ['hp', 1200]]); // rocket hiss
  tone(a, sr, 0.05, 1.8, 800, 0.18, { f1: 2600, a: 0.05, tau: 0.9, vib: 0.01, vibRate: 13 }); // whistle
  const c = grains(buf(sr, 3.2), sr, r, 0.1, 3.0, 40, 0.5, 0.001, 1.2);
  mix(a, filt(c, sr, 'hp', 2500), sr, 0, 0.5);
  burst(a, sr, r, 2.0, 0.2, 0.6, 'pink', 0.001, 0.05, [['bp', 1100, 1.5]]); // star bursts open
  return a;
});

def('horn', { sr: 22050, gain: 0.65, ref: 60, cooldown: 1 }, (sr) => {
  const dur = 2.6, a = buf(sr, dur);
  const env = (t) => Math.min(1, t / 0.18) * Math.min(1, (dur - t) / 0.5);
  for (const [f, g] of [[110, 1], [138.6, 0.8]]) tone(a, sr, 0, dur, f, g, { shape: 'saw', env, vib: 0.003, vibRate: 5 });
  filt(a, sr, 'lp', 900, 0.9);
  return filt(a, sr, 'lp', 1400);
});

// ── Weather / intro ─────────────────────────────────────────────────────
// v0 = close strike (sharp crack), v1 = mid, v2 = distant roll.
def('thunder', { variants: 3, sr: 16000, gain: 1.0, cooldown: 0.25, jitter: 0.08 }, (sr, r, v) => {
  const dur = 7.5 + r() * 1.5, a = buf(sr, dur);
  const near = v === 0, far = v === 2;
  const rum = noise(buf(sr, dur), r, 'brown');
  const rolls = [];
  for (let i = 0; i < 6; i++) rolls.push([(near ? 0.05 : 0.3) + r() * (far ? 3.5 : 2.5), 0.1 + r() * 0.5, 0.7 + r() * 1.8, 0.4 + r() * 0.6]);
  const p1 = r() * 6, p2 = r() * 6;
  shapeCR(rum, sr, (t) => {
    let e = 0;
    for (const [t0, at, tau, g] of rolls) {
      const u = t - t0;
      if (u > 0) e += g * (u < at ? u / at : Math.exp(-(u - at) / tau));
    }
    return e * (0.7 + 0.3 * Math.sin(t * 5.1 + p1) * Math.sin(t * 2.3 + p2)) * Math.min(1, (dur - t) / 1.2);
  });
  filt(rum, sr, 'lp', far ? 160 : 320, 0.8);
  mix(a, filt(rum, sr, 'hp', 25), sr, 0, 1);
  if (!far) {
    const c = noise(buf(sr, 1.2), r, 'white');
    grains(c, sr, r, 0, 0.6, 60, 1.5, 0.004, 0.15);
    shape(c, sr, (t) => envAD(t, 0.002, near ? 0.12 : 0.25));
    filt(c, sr, 'hp', near ? 500 : 250);
    mix(a, filt(c, sr, 'lp', near ? 6000 : 1800), sr, near ? 0 : 0.25, near ? 1.0 : 0.45);
  }
  return softclip(a, 1.6);
});

/** The fishing boat smashing onto the reef (intro). */
def('crash', { gain: 1.0, cooldown: 1, ref: 20 }, (sr, r) => {
  const dur = 4.5, a = buf(sr, dur);
  tone(a, sr, 0, 2.0, 55, 1.0, { f1: 30, a: 0.003, tau: 0.5 }); // boom
  burst(a, sr, r, 0, 2.0, 1.2, 'brown', 0.004, 0.45, [['lp', 700]]);
  const s = grains(buf(sr, 1.8), sr, r, 0, 1.6, 120, 1, 0.004, 0.45);
  mix(a, filt(s, sr, 'bp', 1600, 0.6), sr, 0.01, 0.9); // splintering planks
  const s2 = grains(buf(sr, 1.0), sr, r, 0, 0.9, 50, 1, 0.002, 0.3);
  mix(a, filt(s2, sr, 'hp', 3000), sr, 0.02, 0.5);
  for (const [f, g, tau] of [[233, 0.35, 1.1], [587, 0.25, 0.8], [1031, 0.18, 0.6], [1660, 0.1, 0.4], [2397, 0.06, 0.3]]) tone(a, sr, 0.03, 2.2, f, g, { a: 0.001, tau }); // metal fittings
  const gg = creak(sr, r, 2.4, (t) => 22 + 14 * Math.sin(t * 2.2) + 6 * (r() - 0.5), [[180, 10, 1], [430, 9, 0.6], [900, 8, 0.3]]);
  shape(gg, sr, (t) => Math.min(1, t / 0.3) * Math.min(1, (2.4 - t) / 0.8));
  mix(a, gg, sr, 0.5, 1.6); // hull groaning on the rocks
  const w = noise(buf(sr, 3.8), r, 'pink');
  shape(w, sr, (t) => Math.sin(Math.PI * Math.min(1, t / 3.8)) * (0.6 + 0.4 * Math.sin(t * 3)));
  mix(a, filt(w, sr, 'bp', 700, 0.7, 1400), sr, 0.3, 0.5); // water surging over the deck
  return softclip(a, 1.5);
});

// ── UI ──────────────────────────────────────────────────────────────────
def('ui_click', { sr: 44100, gain: 0.2, jitter: 0.03, cooldown: 0.03 }, (sr, r) => {
  const a = buf(sr, 0.05);
  tone(a, sr, 0, 0.04, 1900, 0.6, { a: 0.0005, tau: 0.006 });
  return burst(a, sr, r, 0, 0.02, 0.4, 'white', 0.0002, 0.0015, [['hp', 3000]]);
});

def('ui_open', { sr: 44100, gain: 0.24, cooldown: 0.1 }, (sr, r) => {
  const a = buf(sr, 0.32);
  const w = noise(buf(sr, 0.3), r, 'pink');
  shape(w, sr, (t) => Math.sin(Math.PI * Math.min(1, t / 0.28)) ** 2);
  mix(a, filt(w, sr, 'bp', 450, 1.3, 2400), sr, 0, 1);
  return tone(a, sr, 0, 0.08, 320, 0.35, { f1: 240, a: 0.001, tau: 0.02 });
});

// ── Ambience (scheduled by audio.js) ────────────────────────────────────
def('crackle', { variants: 10, gain: 0.32, ref: 1.5, cooldown: 0, jitter: 0.15 }, (sr, r, v) => {
  const big = v >= 7; // a few chunky pops among the small ticks
  const a = buf(sr, big ? 0.09 : 0.04);
  const tau = big ? 0.012 : 0.003 + r() * 0.002;
  noise(a, r, 'white');
  shape(a, sr, (t) => envAD(t, 0.0003, tau));
  return filt(a, sr, 'bp', big ? 700 + r() * 500 : 2200 + r() * 3500, big ? 2.5 : 1.2);
});

def('drip', { variants: 6, gain: 0.22, ref: 2, cooldown: 0, jitter: 0.2 }, (sr, r) => {
  const a = buf(sr, 0.09), f = 900 + r() * 1600;
  tone(a, sr, 0.002, 0.07, f, 0.7, { f1: f * 2.2, a: 0.0008, tau: 0.012 });
  return burst(a, sr, r, 0, 0.01, 0.4, 'white', 0.0002, 0.0012, [['hp', 3000]]);
});

def('bubble', { variants: 6, gain: 0.22, cooldown: 0, jitter: 0.25 }, (sr, r) => {
  const a = buf(sr, 0.12), f = 250 + r() * 600;
  return tone(a, sr, 0, 0.1, f, 0.8, { f1: f * 2.5, a: 0.003, tau: 0.03 });
});

// Frogs: pulse-train croaks, each pulse a short damped resonance. v picks the species.
const FROGS = [
  { res: 520, rate: 75, syl: [[0, 0.09], [0.16, 0.12]] }, // green frog "rib-bit"
  { res: 1500, rate: 110, syl: [[0, 0.06], [0.1, 0.06], [0.2, 0.07]] }, // tree frog
  { res: 260, rate: 48, syl: [[0, 0.32]] }, // bullfrog
  { res: 760, rate: 90, syl: [[0, 0.07], [0.14, 0.09]] },
];
def('frog', { variants: 4, gain: 0.36, ref: 4, cooldown: 0.05, jitter: 0.06 }, (sr, r, v) => {
  const T = FROGS[v % FROGS.length];
  const a = buf(sr, 0.5);
  for (const [t0, d] of T.syl) {
    const n = Math.max(1, Math.floor(d * T.rate));
    for (let k = 0; k < n; k++) {
      const t = t0 + k / T.rate, env = Math.sin((Math.PI * (k + 0.5)) / n);
      tone(a, sr, t, 0.02, T.res * (1 + (r() - 0.5) * 0.05), env, { a: 0.0004, tau: 0.004 });
      tone(a, sr, t, 0.012, T.res * 2.1, env * 0.3, { a: 0.0003, tau: 0.002 });
    }
  }
  if (v % FROGS.length === 2) tone(a, sr, 0, 0.34, 110, 0.35, { a: 0.03, tau: 0.2, harm: [[2, 0.5]] });
  return a;
});

// Birds (each variant is a distinct "song"; audio.js lets one singer repeat its own song).
def('bird_chirp', { variants: 8, gain: 0.28, ref: 6, cooldown: 0, jitter: 0.04 }, (sr, r) => {
  const n = 2 + Math.floor(r() * 4), gap = 0.07 + r() * 0.07, len = 0.035 + r() * 0.04;
  const fHi = 4200 + r() * 2200, fLo = fHi * (0.55 + r() * 0.2);
  const a = buf(sr, n * (len + gap) * 1.1 + 0.05);
  for (let k = 0; k < n; k++) {
    const up = r() < 0.25;
    tone(a, sr, k * (len + gap) * (1 + (r() - 0.5) * 0.15), len, up ? fLo : fHi, 0.7 + r() * 0.3, { f1: up ? fHi : fLo, env: (t) => Math.sin((Math.PI * t) / len), harm: [[2, 0.12]] });
  }
  return a;
});

def('bird_trill', { variants: 6, gain: 0.24, ref: 6, cooldown: 0 }, (sr, r) => {
  const dur = 0.6 + r() * 0.9, rate = 16 + r() * 14, f0 = 3600 + r() * 1800, drift = 0.8 + r() * 0.35;
  const a = buf(sr, dur + 0.05);
  const n = Math.floor(dur * rate), len = 0.6 / rate;
  for (let k = 0; k < n; k++) {
    const u = k / n, f = f0 * Math.pow(drift, u);
    const g = Math.sin(Math.PI * Math.min(1, u * 1.1 + 0.02)) * (0.8 + r() * 0.2);
    tone(a, sr, k / rate, len, f * 1.08, g, { f1: f * 0.92, env: (t) => Math.sin((Math.PI * t) / len) });
  }
  return a;
});

def('bird_whistle', { variants: 8, gain: 0.3, ref: 7, cooldown: 0 }, (sr, r) => {
  const n = 3 + Math.floor(r() * 4), notes = [];
  let t = 0;
  for (let k = 0; k < n; k++) {
    const len = 0.09 + r() * 0.17, f = 1700 + r() * 1900;
    notes.push([t, len, f, f * (0.75 + r() * 0.55)]);
    t += len + 0.03 + r() * 0.08;
  }
  const a = buf(sr, t + 0.1);
  for (const [t0, len, f, f1] of notes) {
    tone(a, sr, t0, len, f, 0.6 + r() * 0.4, { f1, env: (tt) => Math.pow(Math.sin((Math.PI * tt) / len), 0.7), vib: 0.012, vibRate: 28 + r() * 20, harm: [[2, 0.18], [3, 0.05]] });
  }
  return a;
});

def('bird_coo', { variants: 4, gain: 0.28, ref: 8, cooldown: 0 }, (sr, r) => {
  const f = 400 + r() * 130;
  const pat = [[0, 0.26, 0.7], [0.36, 0.42, 1], [0.9, 0.22, 0.6], [1.2, 0.24, 0.55]];
  const a = buf(sr, 1.55);
  for (const [t0, len, g] of pat) tone(a, sr, t0, len, f * 1.04, g, { f1: f * 0.94, env: (t) => Math.pow(Math.sin((Math.PI * t) / len), 1.5), harm: [[2, 0.1]] });
  const b = filt(noise(buf(sr, 1.55), r, 'pink'), sr, 'bp', f * 2, 4); // breathiness
  shape(b, sr, (t) => {
    for (const [t0, len] of pat) if (t >= t0 && t < t0 + len) return Math.sin((Math.PI * (t - t0)) / len) * 0.15;
    return 0;
  });
  return mix(a, b, sr, 0, 1);
});

def('gull', { variants: 5, gain: 0.3, ref: 10, cooldown: 0 }, (sr, r) => {
  const n = 1 + Math.floor(r() * 3), a = buf(sr, n * 0.5 + 0.15);
  for (let k = 0; k < n; k++) {
    const len = 0.3 + r() * 0.12, f = 950 + r() * 350;
    const c = voiced(
      sr,
      len,
      (t) => f * (t < len * 0.25 ? 1 + (1.4 * t) / len : 1.35 - 0.8 * (t / len - 0.25)),
      [[1700, 3, 1], [3100, 4, 0.5]],
      (t) => Math.pow(Math.max(0, Math.sin((Math.PI * t) / len)), 0.6) * (0.8 + 0.2 * Math.sin(t * Math.PI * 2 * 45)),
      r,
      0.05
    );
    mix(a, c, sr, k * (0.38 + r() * 0.08), k === 0 ? 1 : 0.8);
  }
  return a;
});

def('owl', { variants: 3, gain: 0.28, ref: 10, cooldown: 0 }, (sr, r) => {
  const f = 340 + r() * 60;
  const a = buf(sr, 1.7);
  for (const [t0, len, g] of [[0, 0.32, 1], [0.62, 0.14, 0.7], [0.82, 0.14, 0.7], [1.05, 0.5, 0.9]]) {
    tone(a, sr, t0, len, f * 1.03, g, { f1: f * 0.97, env: (t) => Math.pow(Math.sin((Math.PI * t) / len), 1.2), vib: 0.01, vibRate: 7, harm: [[2, 0.08]] });
  }
  return a;
});

def('woodpecker', { variants: 2, gain: 0.28, ref: 10, cooldown: 0 }, (sr, r) => {
  const n = 14 + Math.floor(r() * 10), a = buf(sr, 1.1), f = 900 + r() * 500;
  let t = 0;
  for (let k = 0; k < n; k++) {
    const g = Math.sin((Math.PI * (k + 0.5)) / n) * 0.4 + 0.6;
    tone(a, sr, t, 0.03, f, g, { a: 0.0003, tau: 0.004 });
    tone(a, sr, t, 0.02, f * 2.7, g * 0.4, { a: 0.0003, tau: 0.002 });
    t += 0.045 - (0.015 * k) / n;
  }
  return a;
});

/** Names other modules might use for the same thing (unknown names are silently ignored). */
export const ALIASES = {
  birds_flush: 'bird_trill',
  footstep: 'footstep_grass',
  footstep_wood: 'footstep_wood',
  creak: 'tree_creak',
  boat_horn: 'horn',
  impact: 'crash',
  wreck: 'crash',
  click: 'ui_click',
  open: 'ui_open',
  whoosh: 'ui_open',
  gulp: 'drink',
  bite: 'eat',
  ding: 'chime',
  secret: 'chime',
  fire: 'ignite',
  build: 'place',
  stroke: 'swim',
};

/** Resolves an alias to a recipe name (or null when unknown). */
export function resolveName(name) {
  if (RECIPES[name]) return name;
  const a = ALIASES[name];
  return a && RECIPES[a] ? a : null;
}

function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Renders variant `v` of a recipe: a normalized, click-free mono Float32Array at RECIPES[name].sr. */
export function renderSound(name, v = 0) {
  const R = RECIPES[name];
  if (!R) return null;
  const rand = rng((hashName(name) + v * 7919 + 1) >>> 0);
  return finish(R.render(R.sr, rand, v), R.sr, 0.9);
}

/** Bake order: what the player hears first gets baked first (one per frame after the context starts). */
export const BAKE_ORDER = [
  'ui_click', 'ui_open', 'footstep_sand', 'footstep_grass', 'footstep_rock', 'footstep_water', 'footstep_wood', 'jump', 'land',
  'splash', 'swim', 'pickup', 'bird_whistle', 'bird_chirp', 'gull', 'crackle', 'drip', 'craft', 'eat', 'drink', 'hurt', 'gasp',
  'ignite', 'bird_trill', 'bird_coo', 'frog', 'owl', 'bubble', 'woodpecker', 'place', 'cook', 'snuff', 'heartbeat', 'chime',
  'quack', 'tree_creak', 'tree_crash', 'thunder', 'flare', 'crash', 'horn', 'shimmer',
];
