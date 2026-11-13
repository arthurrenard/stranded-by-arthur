// V3-A: Tempest Isle local storms (fx/isle2Storm.js + weather.js), the sea-haze fog curve (fx/fogChunks.js),
// the two-island height bake (fx/shared.js) and the palm "bonk" (nature/res/treeHarvest.js).
// Run: node tests/isle2-storm.test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/core/rng.js';
import { createHeightfield } from '../src/world/heightfield.js';
import * as S from '../src/world/fx/isle2Storm.js';
import { seaHazeFog } from '../src/world/fx/fogChunks.js';
import { bakeHeightData, sampleHeightData, heightExtent } from '../src/world/fx/shared.js';
import * as Weather from '../src/world/weather.js';
import { createTreeHarvest } from '../src/nature/res/treeHarvest.js';

let passed = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(
        r.then(
          () => passed++,
          (e) => {
            console.error(`✗ ${name}\n`, e);
            process.exitCode = 1;
          }
        )
      );
      return;
    }
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n`, e);
    process.exitCode = 1;
  }
}

const C = CONFIG.isle2;
const W = createHeightfield();
const I2 = W.isle2;
const LM = W.landmarks;

// ── Schedule ─────────────────────────────────────────────────────────────
test('half-day index: 06-18 and 18-06 blocks', () => {
  assert.equal(S.halfDayIndex(6), 0);
  assert.equal(S.halfDayIndex(17.99), 0);
  assert.equal(S.halfDayIndex(18), 1);
  assert.equal(S.halfDayIndex(29.99), 1);
  assert.equal(S.halfDayIndex(5.2), -1); // the intro, before the first morning
});

test('storm windows: ~40 % of half-days, 1-4 h long, inside their half-day with room to ramp out, deterministic', () => {
  let n = 0;
  const K = 4000;
  for (let k = 0; k < K; k++) {
    const w = S.stormWindow(CONFIG.seed, k, C);
    assert.deepEqual(w, S.stormWindow(CONFIG.seed, k, C));
    if (!w) continue;
    n++;
    const d = w.end - w.start;
    assert.ok(d >= 1 - 1e-9 && d <= 4 + 1e-9, `duration ${d}`);
    assert.ok(w.start >= 6 + 12 * k && w.end <= 18 + 12 * k - 1 + 1e-9, 'inside the half-day');
    assert.ok(w.peak >= 0.8 && w.peak <= 1);
  }
  const f = n / K;
  assert.ok(Math.abs(f - C.stormChance) < 0.03, `storm fraction ${f}`);
});

test('stormActiveAt / nextStorm agree with the windows', () => {
  const w = S.nextStorm(CONFIG.seed, 6, C);
  assert.ok(w);
  assert.equal(S.stormActiveAt(CONFIG.seed, w.start - 0.01, C)?.start === w.start, false);
  assert.equal(S.stormActiveAt(CONFIG.seed, (w.start + w.end) / 2, C).start, w.start);
  assert.equal(S.stormActiveAt(CONFIG.seed, w.end + 0.01, C)?.start === w.start, false);
});

test('falloff: full inside stormInner, zero beyond stormOuter; the main island is never inside', () => {
  assert.equal(S.stormFalloff(0, C.stormInner, C.stormOuter), 1);
  assert.equal(S.stormFalloff(C.stormInner, C.stormInner, C.stormOuter), 1);
  assert.equal(S.stormFalloff(C.stormOuter, C.stormInner, C.stormOuter), 0);
  let minD = Infinity;
  for (let x = -500; x <= 500; x += 5)
    for (let z = -500; z <= 500; z += 5) if (W.islandAt(x, z) === 'main' && W.heightAt(x, z) > -1) minD = Math.min(minD, Math.hypot(x - I2.x, z - I2.z));
  assert.ok(minD > C.stormOuter, `main island land ${minD.toFixed(0)} m from the isle center`);
});

test('hail only in the stronger part of a storm; ramps are linear in real seconds', () => {
  assert.equal(S.hailFrom(0.5), 0);
  assert.equal(S.hailFrom(1), 1);
  assert.ok(S.hailFrom(0.7) > 0 && S.hailFrom(0.7) < 1);
  let v = 0;
  for (let t = 0; t < C.stormRampSec; t += 1) v = S.rampToward(v, 1, 1, C.stormRampSec);
  assert.ok(Math.abs(v - 1) < 1e-9);
  assert.equal(S.rampToward(0.5, 0, 100, 30), 0);
});

// ── Fog ──────────────────────────────────────────────────────────────────
test('sea haze: faint outline from the launch beach, clear from the summit, main island unchanged at ground level', () => {
  const rho = 0.00113; // clear midday base density (skyPalette)
  const lb = LM.launchBeach, pk = I2.peak;
  const dPeak = Math.hypot(lb.x - pk.x, lb.z - pk.z);
  // points of the isle seen from the launch beach, 550-750 m away (cove side -> peak -> far side)
  const ux = (pk.x - lb.x) / dPeak, uz = (pk.z - lb.z) / dPeak;
  for (const d of [550, 650, dPeak, 750]) {
    const f = seaHazeFog(rho, d, lb.y + 1.6, lb.x + ux * d, lb.z + uz * d);
    assert.ok(f >= 0.79 && f <= 0.89, `beach ${d.toFixed(0)} m: ${(f * 100).toFixed(1)} %`);
  }
  const sm = LM.summit;
  const dS = Math.hypot(sm.x - pk.x, sm.z - pk.z);
  assert.ok(seaHazeFog(rho, dS, sm.y + 1.6, pk.x, pk.z) <= 0.5, 'summit view');
  const old = (d) => 1 - Math.exp(-((rho * d) ** 2));
  for (const d of [50, 200, 400, 600]) {
    assert.ok(Math.abs(seaHazeFog(rho, d, 3, 250, -80) - old(d)) < 1e-12, 'main island fragments unchanged from the ground');
    assert.ok(Math.abs(seaHazeFog(rho, d, 3, -700, 300) - old(d)) < 1e-12, 'the open sea away from Tempest Isle unchanged');
  }
  assert.ok(seaHazeFog(0.0049, 650, 3, pk.x, pk.z) > 0.99, 'gone in the rain');
});

// ── Height bake ──────────────────────────────────────────────────────────
test('the height texture covers both islands and matches the grids', () => {
  const E = heightExtent(W);
  assert.ok(E.x0 <= -W.SIZE / 2 && E.z0 <= I2.z0 && E.x0 + (E.nx - 1) * E.cell >= I2.x0 + I2.cells * I2.cell);
  const hd = bakeHeightData(W);
  assert.equal(hd.data.length, E.nx * E.nz * 4);
  // exact on grid vertices of both grids
  for (const [x, z] of [[0, 0], [LM.summit.x, LM.summit.z], [I2.x0 + 100 * I2.cell, I2.z0 + 90 * I2.cell]]) {
    const gx = Math.round(x / W.CELL) * W.CELL, gz = Math.round(z / W.CELL) * W.CELL;
    assert.ok(Math.abs(sampleHeightData(hd, W, gx, gz, 0) - W.heightAt(gx, gz)) < 1e-3, `vertex ${gx},${gz}`);
  }
  // shore distance: 0 on Tempest Isle, small off the cove, large in the strait
  assert.equal(sampleHeightData(hd, W, LM.isle2Hut.x, LM.isle2Hut.z, 2), 0);
  const d = LM.isle2Dock;
  assert.ok(sampleHeightData(hd, W, d.x + d.dirX * 25, d.z + d.dirZ * 25, 2) < 40);
  const mx = (LM.launchBeach.x + I2.x) / 2, mz = (LM.launchBeach.z + I2.z) / 2;
  assert.ok(sampleHeightData(hd, W, mx, mz, 2) > 120);
});

// ── Weather integration (node, no WebGL) ─────────────────────────────────
function makeWeatherCtx() {
  const events = [];
  const handlers = {};
  const toasts = [];
  const hurt = [];
  const ctx = {
    config: CONFIG,
    rng: createRng(CONFIG.seed),
    world: W,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    state: 'playing',
    flags: {},
    difficulty: { damageMul: 1 },
    shelters: new Set(),
    time: { hoursTotal: 30, dtHours: 0, timeScale: 1, daylight: 1, sunDir: new THREE.Vector3(0.3, 0.8, 0.2).normalize(), moonDir: new THREE.Vector3(0, -1, 0) },
    uniforms: { uWind: { value: new THREE.Vector2(1, 0) }, uWindStrength: { value: 0.3 }, uRain: { value: 0 }, uTime: { value: 0 } },
    events: {
      on: (n, f) => ((handlers[n] ||= []).push(f)),
      emit: (n, p) => {
        events.push(n);
        for (const f of handlers[n] || []) f(p);
      },
    },
    ui: { toast: (t) => toasts.push(t) },
    stats: { damage: (a, cause) => (hurt.push([a, cause]), a) },
    player: { position: new THREE.Vector3() },
  };
  return { ctx, events, toasts, hurt };
}
const step = (api, ctx, sec, dt = 0.1) => {
  for (let t = 0; t < sec; t += dt) api.update(dt);
};

test('weather: a forced Tempest Isle storm ramps in fast, folds into the camera weather near the isle only, hails and hurts', () => {
  const { ctx, events, toasts, hurt } = makeWeatherCtx();
  const api = Weather.create(ctx);
  api.init();
  // stand on the cove beach
  ctx.camera.position.set(LM.isle2Cove.x, LM.isle2Cove.y + 1.6, LM.isle2Cove.z);
  ctx.player.position.set(LM.isle2Cove.x, LM.isle2Cove.y, LM.isle2Cove.z);
  api.debugIsle2Storm(false); // clear any scheduled storm for a clean start
  step(api, ctx, 40);
  assert.equal(api.stormAt(ctx.camera.position.x, ctx.camera.position.z), 0);
  const calmRain = api.rain;
  api.debugIsle2Storm(true, 2);
  step(api, ctx, C.stormRampSec * 0.5);
  assert.ok(api.isle2Storm.active && api.isle2Storm.intensity > 0.4 && api.isle2Storm.intensity < 0.6, `half ramp ${api.isle2Storm.intensity}`);
  step(api, ctx, C.stormRampSec * 0.6);
  assert.equal(api.isle2Storm.intensity, 1);
  assert.ok(events.includes('isle2:stormStart'));
  assert.ok(toasts.some((t) => /Black clouds/.test(t)), 'storm warning');
  const local = api.stormAt(ctx.camera.position.x, ctx.camera.position.z);
  assert.ok(local > 0.95, `cove storm ${local}`);
  assert.ok(api.rain >= 0.99 && api.storm >= 0.95 && api.cloudiness >= 0.99 && api.wind.strength >= 1.15 && api.rain > calmRain);
  assert.ok(api.hailAt(ctx.camera.position.x, ctx.camera.position.z) > 0.9);
  // rain is positional for everything that isn't at the camera (fires on the main island stay dry)
  assert.equal(api.rainAt(LM.launchBeach.x, LM.launchBeach.z), api.baseRain);
  assert.ok(api.baseRain < 0.99 || calmRain >= 0.99);
  assert.ok(api.rainAt(LM.isle2Cove.x, LM.isle2Cove.z) > 0.99);
  assert.ok(api.hailMesh.visible && api.hailMesh.count > 200, 'hail pellets around the camera');
  // exposed: hurt in ~1 hp chunks at hailDamagePerSec
  hurt.length = 0;
  step(api, ctx, 10);
  const dealt = hurt.reduce((s, h) => s + h[0], 0);
  assert.ok(hurt.every((h) => h[1] === 'hail') && Math.abs(dealt - 10 * C.hailDamagePerSec) < 1.3, `hail damage ${dealt}`);
  assert.ok(toasts.some((t) => /Hail! Get indoors!/.test(t)));
  // indoors: no hail damage, no pellets
  ctx.shelters.add({ position: ctx.player.position.clone(), radius: 4, indoor: true });
  hurt.length = 0;
  step(api, ctx, 6);
  assert.equal(hurt.length, 0);
  assert.equal(api.hailMesh.visible, false);
  ctx.shelters.clear();
  // the main island: untouched
  ctx.camera.position.set(LM.launchBeach.x, LM.launchBeach.y + 1.6, LM.launchBeach.z);
  ctx.player.position.set(LM.launchBeach.x, LM.launchBeach.y, LM.launchBeach.z);
  step(api, ctx, 2);
  assert.equal(api.stormAt(LM.launchBeach.x, LM.launchBeach.z), 0);
  assert.equal(api.hailAt(LM.launchBeach.x, LM.launchBeach.z), 0);
  hurt.length = 0;
  step(api, ctx, 4);
  assert.equal(hurt.length, 0);
  // clearing: ramps out, stormEnd fires
  api.debugIsle2Storm(false);
  step(api, ctx, C.stormRampSec + 2);
  assert.equal(api.isle2Storm.intensity, 0);
  assert.ok(events.includes('isle2:stormEnd'));
});

test('weather: the scheduled storms follow the half-day rolls', () => {
  const { ctx, events } = makeWeatherCtx();
  const api = Weather.create(ctx);
  api.init();
  const seed = ((CONFIG.seed ?? 1) ^ 0x7e57) >>> 0; // weather.js i2Seed
  const w = S.nextStorm(seed, 10, C);
  ctx.time.hoursTotal = (w.start + w.end) / 2;
  ctx.events.emit('time:set', {});
  api.update(0.1);
  assert.ok(api.isle2Storm.active && Math.abs(api.isle2Storm.endsAtHours - w.end) < 1e-9 && api.isle2Storm.intensity === w.peak);
  assert.ok(events.includes('isle2:stormStart'));
  assert.ok(api.forecast().isle2StormInHours === 0);
});

// ── Palm bonk ────────────────────────────────────────────────────────────
function makePalmCtx(state = 'playing') {
  const log = { damage: [], subs: [], flash: [], sounds: [], inv: [] };
  let registered = null;
  const ctx = {
    state,
    flags: {},
    world: W,
    player: { position: new THREE.Vector3(0, 2, 0) },
    interact: { register: (e) => ((registered = e), e) },
    audio: { play: (n, o) => log.sounds.push([n, o?.volume]) },
    ui: { flash: (c, d) => log.flash.push([c, d]), subtitle: (t, d) => log.subs.push([t, d]), toast: () => {} },
    stats: { damage: (a, c) => log.damage.push([a, c]) },
    inventory: { add: (id, n) => (log.inv.push([id, n]), n) },
    events: { emit: () => {} },
  };
  return { ctx, log, entry: () => registered };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('palm shake: 5 % coconut on the head = Bonk. + death by coconut; god mode survives; misses/drops unchanged', async () => {
  assert.equal(CONFIG.palmDeathChance, 0.05);
  // rand 0.01 < 0.05: bonk
  {
    const { ctx, log, entry } = makePalmCtx();
    const th = createTreeHarvest(ctx, { rand: () => 0.01, now: () => 10, burst: () => {}, itemName: (id) => id });
    th.add({ x: 5, z: 5, y: 1, type: 'palm', height: 8 });
    entry().onUse();
    assert.deepEqual(log.subs[0], ['Bonk.', 2]);
    assert.deepEqual(log.flash[0], ['#fff', 0.2]);
    assert.ok(log.sounds.some(([n, v]) => n === 'land' && v === 1.2));
    assert.equal(log.inv.length, 0);
    await wait(600);
    assert.deepEqual(log.damage[0], [1e4, 'coconut']);
  }
  // god mode: bonk but no death
  {
    const { ctx, log, entry } = makePalmCtx();
    ctx.flags.godMode = true;
    const th = createTreeHarvest(ctx, { rand: () => 0.01, now: () => 10, burst: () => {}, itemName: (id) => id });
    th.add({ x: 5, z: 5, y: 1, type: 'palm', height: 8 });
    entry().onUse();
    await wait(600);
    assert.equal(log.subs.length, 1);
    assert.equal(log.damage.length, 0);
  }
  // rand 0.1: no bonk, and 0.1 < 0.3 = a coconut drops (the 30 % drop stays)
  {
    const { ctx, log, entry } = makePalmCtx();
    const th = createTreeHarvest(ctx, { rand: () => 0.1, now: () => 10, burst: () => {}, itemName: (id) => id });
    th.add({ x: 5, z: 5, y: 1, type: 'palm', height: 8 });
    entry().onUse();
    await wait(10);
    assert.equal(log.subs.length, 0);
    assert.deepEqual(log.inv[0], ['coconut', 1]);
  }
  // apples never bonk
  {
    const { ctx, log, entry } = makePalmCtx();
    const th = createTreeHarvest(ctx, { rand: () => 0.0, now: () => 10, burst: () => {}, itemName: (id) => id });
    th.add({ x: 5, z: 5, y: 1, type: 'apple', height: 6 });
    entry().onUse();
    await wait(10);
    assert.equal(log.subs.length, 0);
    assert.equal(log.inv[0][0], 'wild_apple');
  }
});

await Promise.all(pending);
console.log(`isle2-storm tests: ${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
