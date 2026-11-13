// Unit tests + balance simulation for src/story/rescueLogic.js. Run: node tests/rescue.test.mjs
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { mulberry32 } from '../src/core/rng.js';
import * as L from '../src/story/rescueLogic.js';

const R = CONFIG.rescue;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n`, e);
    process.exitCode = 1;
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── Schedule ─────────────────────────────────────────────────────────────
test('scripted passes come first, then repeats with closeness 1 alternating kinds', () => {
  const n = R.passes.length;
  for (let i = 0; i < n; i++) {
    const p = L.passDef(i, R);
    assert.equal(p.at, R.passes[i].at);
    assert.equal(p.kind, R.passes[i].kind);
    assert.equal(p.closeness, R.passes[i].closeness);
  }
  const last = R.passes[n - 1];
  const r1 = L.passDef(n, R), r2 = L.passDef(n + 1, R), r3 = L.passDef(n + 2, R);
  assert.ok(near(r1.at, last.at + R.repeatEveryHours));
  assert.ok(near(r2.at, last.at + 2 * R.repeatEveryHours));
  assert.equal(r1.closeness, 1);
  assert.notEqual(r1.kind, r2.kind);
  assert.equal(r1.kind, r3.kind);
});

test('firstPassIndexAfter is strict and works deep into the repeats', () => {
  assert.equal(L.firstPassIndexAfter(0, R), 0);
  assert.equal(L.firstPassIndexAfter(R.passes[0].at - 0.01, R), 0);
  assert.equal(L.firstPassIndexAfter(R.passes[0].at, R), 1);
  for (const h of [100, 133.7, 500, 1000.25]) {
    const i = L.firstPassIndexAfter(h, R);
    assert.ok(L.passDef(i, R).at > h, `pass ${i} after ${h}`);
    assert.ok(i === 0 || L.passDef(i - 1, R).at <= h, `pass ${i - 1} not after ${h}`);
  }
});

test('passesBetween returns the passes a sleeper misses', () => {
  // sleeping from 19:00 on day 3 to 06:00 on day 4 covers the 19:30 night pass
  const from = 48 + 19, to = 72 + 6;
  const missed = L.passesBetween(from, to, R);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].at, 48 + 19.5);
  assert.equal(L.passesBetween(10, 14, R).length, 0);
  assert.equal(L.passesBetween(14, 15, R).length, 1); // (from, to] includes the 15:00 start
});

test('pass duration stays within 70..110 s', () => {
  for (let c = 0; c <= 1; c += 0.05) for (const r of [0, 0.5, 1]) {
    const d = L.passDuration(c, r);
    assert.ok(d >= 70 && d <= 110, `${c} ${r} -> ${d}`);
  }
});

test('closest approach and altitude shrink with closeness', () => {
  assert.ok(L.closestApproach(0.25) > L.closestApproach(0.55));
  assert.ok(L.closestApproach(0.55) > L.closestApproach(0.9));
  assert.ok(L.heliAltitude(0) === 90 && L.heliAltitude(1) === 60);
  assert.ok(L.boatOffshore(0) > L.boatOffshore(1));
  assert.ok(L.boatOffshore(1, 0) >= 100 && L.boatOffshore(0, 1) <= 280);
});

// ── Paths & routes ───────────────────────────────────────────────────────
test('makePath / samplePath walk the polyline by arc length', () => {
  const p = L.makePath([{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 200, z: 0 }]);
  assert.ok(near(p.length, 200, 1e-6));
  const o = {};
  L.samplePath(p, 0.25, o);
  assert.ok(near(o.x, 50, 1e-6) && near(o.z, 0) && near(o.dx, 1) && near(o.dz, 0));
  L.samplePath(p, 1.5, o); // clamped
  assert.ok(near(o.x, 200, 1e-6));
});

test('helicopter routes respect the closest approach and are long enough to cross the island', () => {
  for (const c of [0.25, 0.55, 0.7, 0.9, 1]) {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = mulberry32(seed * 31 + Math.round(c * 100));
      const px = 10, pz = 291;
      const route = L.heliRoute(rand, c, px, pz);
      const path = L.makePath(route.pts);
      const d = L.pathClosest(path, px, pz);
      // within 25 % (+5 m) of the target distance
      assert.ok(Math.abs(d - route.closest) <= route.closest * 0.25 + 5, `c=${c} seed=${seed}: closest ${d.toFixed(1)} vs ${route.closest.toFixed(1)}`);
      assert.ok(path.length > 1500, `route length ${path.length}`);
      assert.equal(route.circling, c >= 0.6);
    }
  }
});

test('coast table + boat route stay offshore', () => {
  // a round island of radius 300 with a headland at angle 0
  const sample = (a) => 300 + 60 * Math.exp(-((Math.atan2(Math.sin(a), Math.cos(a)) / 0.12) ** 2));
  const table = L.buildCoastTable(sample, 72, 3);
  assert.ok(L.coastRadiusAt(table, 0) >= 355);
  assert.ok(L.coastRadiusAt(table, 0.2) >= 355, 'max filter widens the headland');
  assert.ok(near(L.coastRadiusAt(table, Math.PI), 300, 1));
  for (let seed = 1; seed <= 20; seed++) {
    const rand = mulberry32(seed);
    const c = seed / 20;
    const route = L.boatRoute(rand, c, 0, 290, (a) => L.coastRadiusAt(table, a));
    const path = L.makePath(route.pts);
    for (let i = 0; i < path.n; i++) {
      const r = Math.hypot(path.x[i], path.z[i]);
      const a = Math.atan2(path.z[i], path.x[i]);
      assert.ok(r >= sample(a) + 90, `boat point inside ${r.toFixed(0)} < coast ${sample(a).toFixed(0)}+90`);
    }
  }
});

// ── Attention model ──────────────────────────────────────────────────────
test('visibility falloff: strong under 150 m, weak to 350 m, none beyond', () => {
  assert.equal(L.visibilityFalloff(0), 1);
  assert.ok(near(L.visibilityFalloff(150), 0.6));
  assert.ok(L.visibilityFalloff(250) > 0 && L.visibilityFalloff(250) < 0.2);
  assert.equal(L.visibilityFalloff(350), 0);
  assert.equal(L.visibilityFalloff(900), 0);
  for (let d = 0; d < 400; d += 10) assert.ok(L.visibilityFalloff(d) >= L.visibilityFalloff(d + 10));
});

test('player contribution multipliers', () => {
  const base = { d: 100, open: true, exposed: false, waving: false, underwater: false, daylight: 1 };
  const r0 = L.playerContribution(base);
  assert.ok(r0 > 0);
  assert.ok(near(L.playerContribution({ ...base, waving: true }), r0 * 3));
  assert.ok(near(L.playerContribution({ ...base, exposed: true }), r0 * 1.5));
  assert.equal(L.playerContribution({ ...base, underwater: true }), 0);
  assert.equal(L.playerContribution({ ...base, open: false }), 0);
  assert.ok(L.playerContribution({ ...base, daylight: 0 }) < r0 * 0.3);
  assert.ok(L.playerContribution({ ...base, daylight: 0, inSpotlight: true }) >= r0);
});

test('signal contribution: (1 - d/strength) x weight, zero outside the range', () => {
  const s = L.signalContribution('signal_fire', 325, 650);
  assert.ok(near(s, 0.5 * 3 * L.K.signal));
  assert.ok(near(L.signalContribution('sos', 0, 220), 2 * L.K.signal));
  assert.equal(L.signalContribution('campfire', 130, 120), 0);
  assert.equal(L.signalContribution('flare', 10, 700), 0, 'flares are instant, not weighted');
  assert.equal(L.signalContribution('unknown', 1, 100), 0);
});

test('attentionRate sums parts and applies the blessing', () => {
  const parts = {};
  const player = { d: 80, open: true, exposed: true, waving: true, underwater: false, daylight: 1 };
  const sig = [{ kind: 'signal_fire', d: 200, strength: 650 }, { kind: 'sos', d: 100, strength: 220 }];
  const r = L.attentionRate(player, sig, false, parts);
  assert.ok(near(r, parts.waving + parts.signal_fire + parts.sos));
  assert.equal(L.dominantMethod(parts), parts.waving > parts.signal_fire ? 'waving' : 'signal_fire');
  const rb = L.attentionRate(player, sig, true, parts);
  assert.ok(near(rb, r * 1.1));
  assert.equal(L.stepAttention(10, 0, 1), 10 - L.K.decay);
  assert.equal(L.stepAttention(0.1, 0, 1), 0);
  assert.equal(L.stepAttention(10, 5, 2), 20);
  assert.ok(L.flareSpots(699) && !L.flareSpots(701));
});

// ── Whole-pass balance simulation ────────────────────────────────────────
// Integrates attention along the actual route at 10 Hz for a whole pass (the heli flies at its
// cruise altitude above a flat island, the boat at sea level).
const COAST = L.buildCoastTable(() => 300, 72, 3);
function simulate({ kind = 'helicopter', c, seed, player, playerY = 3, signals = [], daylight = 1, mul = 1 }) {
  const rand = mulberry32(seed);
  const duration = L.passDuration(c, rand());
  const route = kind === 'boat' ? L.boatRoute(rand, c, player.x, player.z, (a) => L.coastRadiusAt(COAST, a)) : L.heliRoute(rand, c, player.x, player.z);
  const path = L.makePath(route.pts);
  const alt = kind === 'boat' ? 2 : route.alt;
  const o = {};
  let att = 0, closest = Infinity;
  const sig = signals.map((s) => ({ ...s, d: 0 }));
  const speed0 = path.length / duration; // cruise speed; the crew slows down once they half-notice
  let dist = 0;
  for (let t = 0; dist < path.length && t < 400; t += 0.1) {
    dist += speed0 * L.speedFactor(att, R.spotThreshold) * 0.1;
    L.samplePath(path, dist / path.length, o);
    const d = Math.hypot(o.x - player.x, alt - playerY, o.z - player.z);
    closest = Math.min(closest, d);
    for (const s of sig) s.d = Math.hypot(o.x - s.x, alt - (s.y ?? 1), o.z - s.z);
    const rate = L.attentionRate({ ...player, d, daylight, fromBoat: kind === 'boat' }, sig, false, null, mul);
    att = L.stepAttention(att, rate, 0.1);
    if (att >= R.spotThreshold) return { spotted: true, att, t, closest };
  }
  return { spotted: false, att, closest };
}
const beach = { x: 10, z: 291, open: true, exposed: true, waving: false, underwater: false };
const spotRate = (opts, seeds = 30) => {
  let n = 0;
  for (let s = 1; s <= seeds; s++) if (simulate({ ...opts, seed: s * 7919 }).spotted) n++;
  return n / seeds;
};

test('balance: the first pass (closeness 0.25) never spots a player who is only standing or waving', () => {
  assert.equal(spotRate({ c: 0.25, player: beach }), 0);
  assert.ok(spotRate({ c: 0.25, player: { ...beach, waving: true } }) <= 0.1);
});

test('balance: a signal fire gets you spotted even on the far first pass and the boat pass', () => {
  const fire = [{ kind: 'signal_fire', x: 20, z: 280, y: 2, strength: 650 }];
  assert.ok(spotRate({ c: 0.25, player: { ...beach, open: false }, signals: fire }) >= 0.8);
  assert.ok(spotRate({ kind: 'boat', c: 0.45, player: { ...beach, open: false }, signals: fire }) >= 0.8);
});

test('balance: waving on the beach works on the closer passes, not the far ones', () => {
  assert.ok(spotRate({ c: 0.7, player: { ...beach, waving: true } }) >= 0.7, 'heli 0.7 waving');
  assert.ok(spotRate({ kind: 'boat', c: 0.75, player: { ...beach, waving: true } }) >= 0.7, 'boat 0.75 waving');
  assert.ok(spotRate({ c: 1, player: { ...beach, waving: true } }) >= 0.95, 'repeat pass waving');
  assert.ok(spotRate({ c: 0.55, player: { ...beach, waving: false } }) <= 0.2, 'heli 0.55 just standing');
});

test('balance: the boat pass on day 2 is a fair chance for a waving player, not a sure thing', () => {
  const r = spotRate({ kind: 'boat', c: 0.45, player: { ...beach, waving: true } });
  assert.ok(r >= 0.15 && r <= 0.85, `boat 0.45 waving spot rate ${r}`);
  assert.equal(spotRate({ kind: 'boat', c: 0.45, player: beach }), 0, 'boat 0.45 just standing');
});

test('speedFactor slows the search once attention builds', () => {
  assert.equal(L.speedFactor(0), 1);
  assert.equal(L.speedFactor(20), 1);
  assert.ok(L.speedFactor(50) < 1 && L.speedFactor(50) > 0.45);
  assert.ok(near(L.speedFactor(100), 0.45));
});

test('balance: hidden players are never spotted without signals', () => {
  assert.equal(spotRate({ c: 1, player: { ...beach, open: false, waving: true } }), 0, 'under canopy');
  assert.equal(spotRate({ c: 1, player: { ...beach, underwater: true, waving: true } }), 0, 'head underwater');
});

test('balance: at night a signal fire works, an unlit figure does not', () => {
  const fire = [{ kind: 'signal_fire', x: 20, z: 280, y: 2, strength: 500 }];
  assert.ok(spotRate({ c: 0.8, player: { ...beach, open: false }, signals: fire, daylight: 0 }) >= 0.8);
  assert.ok(spotRate({ c: 0.8, player: { ...beach, waving: false }, daylight: 0 }) <= 0.1);
});

test('miss hints pick the most useful advice', () => {
  const base = { kind: 'helicopter', night: false, wasOpen: true, waved: true, hadSignalFire: true, hadNightLight: true, hasFlare: false, maxAttention: 10, threshold: 100, closest: 400 };
  assert.match(L.missHint({ ...base, maxAttention: 60 }), /almost saw you/);
  assert.match(L.missHint({ ...base, hasFlare: true, closest: 500 }), /flare/);
  assert.match(L.missHint({ ...base, wasOpen: false }), /under the trees/);
  assert.match(L.missHint({ ...base, night: true, hadNightLight: false }), /At night/);
  assert.match(L.missHint({ ...base, hadSignalFire: false }), /signal fire's smoke/);
  assert.match(L.missHint({ ...base, waved: false }), /Hold G/);
  assert.match(L.missHint({ ...base, kind: 'boat' }), /^The boat sailed away/);
  assert.match(L.sleptThroughText(['helicopter']), /helicopter/);
  assert.match(L.sleptThroughText(['boat']), /boat engine/);
});

// ── Difficulty (v3) ──────────────────────────────────────────────────────
const P = CONFIG.difficulty.presets;
test('difficulty presets: easy 1 / medium 0.3 / hard 0 attention, flare ranges 700 / 250 / 0', () => {
  const e = L.difficultyRescue(P.easy), m = L.difficultyRescue(P.medium), h = L.difficultyRescue(P.hard);
  assert.deepEqual([e.mul, m.mul, h.mul], [1, 0.3, 0]);
  assert.deepEqual([e.flareRange, m.flareRange, h.flareRange], [700, 250, 0]);
  assert.ok(!e.hopeless && !e.hazy && m.hazy && !m.hopeless && h.hopeless && !h.hazy);
  const d = L.difficultyRescue(null); // no difficulty yet = easy defaults
  assert.equal(d.mul, 1);
  assert.equal(d.flareRange, L.K.flareRange);
});

test('attentionRate scales every part by the difficulty multiplier', () => {
  const parts = {};
  const player = { d: 80, open: true, exposed: true, waving: true, underwater: false, daylight: 1 };
  const sig = [{ kind: 'signal_fire', d: 200, strength: 650 }];
  const r1 = L.attentionRate(player, sig, false, parts);
  const r3 = L.attentionRate(player, sig, false, parts, 0.3);
  assert.ok(near(r3, r1 * 0.3));
  assert.ok(near(r3, parts.waving + parts.signal_fire));
  assert.equal(L.attentionRate(player, sig, true, parts, 0), 0);
  assert.equal(parts.signal_fire, 0);
});

test('flare range follows the difficulty: 0 = never seen', () => {
  assert.ok(L.flareSpots(240, 250) && !L.flareSpots(260, 250));
  assert.ok(!L.flareSpots(0, 0) && !L.flareSpots(10, 0));
  assert.ok(L.flareSpots(699, 700));
});

test('hard: passes stay far out, medium keeps the schedule closeness', () => {
  assert.equal(L.passCloseness(1, 0), 0);
  assert.equal(L.passCloseness(0.8, 0.3), 0.8);
  assert.ok(L.closestApproach(L.passCloseness(1, 0), 0) > 350);
});

test('difficulty hints: wrong stretch of sea on hard, haze on medium, none on easy', () => {
  assert.match(L.difficultyHint(0), /wrong stretch of sea/);
  assert.match(L.difficultyHint(0.3), /signal fire/);
  assert.equal(L.difficultyHint(1), null);
  const base = { kind: 'helicopter', night: false, wasOpen: true, waved: true, hadSignalFire: true, hadNightLight: true, maxAttention: 0, threshold: 100 };
  assert.doesNotMatch(L.missHint({ ...base, hasFlare: true, closest: 200, flareRange: 0 }), /flare range/);
  assert.match(L.missHint({ ...base, hasFlare: true, closest: 200, flareRange: 250 }), /flare range/);
});

test('balance: hard never spots anyone, even a waving player beside a signal fire on the closest pass', () => {
  const fire = [{ kind: 'signal_fire', x: 10, z: 291, strength: 650 }];
  assert.equal(spotRate({ c: 1, player: { ...beach, waving: true }, signals: fire, mul: 0 }), 0);
  assert.equal(spotRate({ kind: 'boat', c: 1, player: { ...beach, waving: true }, signals: fire, mul: 0 }), 0);
});

test('balance: medium is much harder than easy but a close pass with a signal fire + waving can work', () => {
  const fire = [{ kind: 'signal_fire', x: 10, z: 291, strength: 650 }];
  const waver = { ...beach, waving: true };
  const easyWave = spotRate({ c: 1, player: waver });
  const medWave = spotRate({ c: 1, player: waver, mul: 0.3 });
  assert.ok(medWave < easyWave, `medium waving ${medWave} vs easy ${easyWave}`);
  assert.ok(spotRate({ c: 1, player: waver, signals: fire, mul: 0.3 }) > 0, 'a close pass + fire + waving should sometimes work on medium');
});

test('bearing names follow north = -Z, east = +X', () => {
  assert.equal(L.bearingName(0, -1), 'north');
  assert.equal(L.bearingName(1, 0), 'east');
  assert.equal(L.bearingName(0, 1), 'south');
  assert.equal(L.bearingName(-1, -1), 'north-west');
});

console.log(`rescue tests: ${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
