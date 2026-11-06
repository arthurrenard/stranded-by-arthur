// Unit tests for src/survival/model.js (pure survival math).
// Run: node tests/survival.test.mjs   (exits 1 on any failure)
// The morning test drives daylight / sun elevation with the real game clock (src/core/clock.js),
// so it exercises exactly what the game feeds into the model.
import assert from 'node:assert/strict';
import * as M from '../src/survival/model.js';
import { CONFIG } from '../src/config.js';
import { createClock } from '../src/core/clock.js';
import { ITEMS } from '../src/core/items.js';

const S = CONFIG.stats;
const P = CONFIG.player;
let passed = 0,
  failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} expected ${b} ± ${eps}, got ${a}`);

// Same weather fallbacks stats.js uses when ctx.weather is missing.
const DEFAULT_WEATHER = { rain: 0, cloudiness: 0.25, wind: 0.35, airTempOffset: 0 };

/** Simulate in-game time with the real clock. opts: { startHour, hours, state, weather, canopy, fire, sheltered, act, immersion } */
function simulate(opts) {
  const clock = createClock({ emit() {} });
  clock.setHour(opts.startHour ?? 12);
  const s = Object.assign(M.createState(), opts.state || {});
  const weather = { ...DEFAULT_WEATHER, ...(opts.weather || {}) };
  const dt = 0.05;
  const rep = {};
  const trace = { minHeat: s.heat, reachComfortAt: null, damage: 0, causes: new Set() };
  let hours = 0;
  while (hours < (opts.hours ?? 1)) {
    clock.update(dt);
    const env = {
      airTemp: M.airTemperature(clock.hour, weather),
      sun: M.sunExposure(clock.daylight, opts.canopy ?? 0, weather.cloudiness, !!opts.sheltered),
      sunElevation: clock.sunDir.y,
      wind: weather.wind,
      rain: weather.rain,
      canopy: opts.canopy ?? 0,
      fire: opts.fire ?? 0,
      sheltered: !!opts.sheltered,
      torch: false,
      immersion: opts.immersion ?? 0,
      waterTemp: M.waterTemperature('ocean'),
    };
    M.tick(s, { dtReal: dt, dtSim: dt, dtHours: clock.dtHours, env, act: opts.act || {} }, S, rep);
    hours += clock.dtHours;
    trace.minHeat = Math.min(trace.minHeat, s.heat);
    if (trace.reachComfortAt === null && s.heat >= S.heatComfortMin) trace.reachComfortAt = hours;
    trace.damage += rep.damage;
    if (rep.cause) trace.causes.add(rep.cause);
  }
  return { s, trace };
}

/** Run tick for `seconds` of real time with a fixed env/act (no clock). */
function run(s, seconds, { env = {}, act = {}, god = false, dt = 0.05 } = {}) {
  const rep = {};
  const causes = new Set();
  let dmg = 0;
  const hoursPerSec = 24 / CONFIG.time.dayLengthSec;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const e = { airTemp: 22, sun: 0.5, wind: 0.2, ...env };
    M.tick(s, { dtReal: dt, dtSim: dt, dtHours: dt * hoursPerSec, env: e, act, god }, S, rep);
    dmg += rep.damage;
    if (rep.cause) causes.add(rep.cause);
  }
  return { dmg, causes };
}

console.log('survival model');

test('start state is cold and wet', () => {
  const s = M.createState();
  assert.ok(s.heat < S.heatComfortMin, 'heat starts below the comfort zone');
  assert.equal(s.wetness, 1);
});

test('morning sun brings the castaway into the comfort zone within ~2-3 h (standing in the open)', () => {
  const { s, trace } = simulate({ startHour: CONFIG.time.startHour, hours: 4 });
  assert.ok(trace.reachComfortAt !== null, 'never reached the comfort zone');
  assert.ok(trace.reachComfortAt >= 1.5 && trace.reachComfortAt <= 3.0, `reached comfort after ${trace.reachComfortAt.toFixed(2)} h`);
  assert.ok(trace.minHeat >= M.K.coldDamageBelow, `heat dipped to ${trace.minHeat.toFixed(1)} (cold damage at spawn)`);
  assert.equal(trace.damage, 0, 'no damage during the first morning');
  assert.ok(s.wetness < 0.05, 'clothes dried in the sun');
});

test('walking in the morning sun is a little faster than standing', () => {
  const a = simulate({ startHour: CONFIG.time.startHour, hours: 4 }).trace.reachComfortAt;
  const b = simulate({ startHour: CONFIG.time.startHour, hours: 4, act: { moving: true } }).trace.reachComfortAt;
  assert.ok(b < a && b >= 1.2, `walk ${b?.toFixed(2)} vs stand ${a?.toFixed(2)}`);
});

test('swimming keeps you soaked and far from the comfort zone in the morning', () => {
  const { s, trace } = simulate({ startHour: CONFIG.time.startHour, hours: 2, immersion: 1, act: { swimming: true } });
  assert.equal(s.wetness, 1);
  assert.equal(trace.reachComfortAt, null);
});

test('air is cold before dawn and warm in the afternoon', () => {
  const night = M.airTemperature(4.5, DEFAULT_WEATHER);
  const noon = M.airTemperature(14.5, DEFAULT_WEATHER);
  assert.ok(night < 13 && noon > 23, `night ${night.toFixed(1)} noon ${noon.toFixed(1)}`);
  assert.ok(M.airTemperature(14.5, { ...DEFAULT_WEATHER, rain: 1 }) < noon - 3, 'rain chills the air');
});

test('a dry night in the open is cold but not lethal; a fire makes it comfortable', () => {
  const open = simulate({ startHour: 21, hours: 8, state: { heat: 50, wetness: 0 } });
  assert.ok(open.s.heat < S.heatComfortMin && open.trace.minHeat > M.K.coldDamageBelow, `open night heat ${open.trace.minHeat.toFixed(1)}`);
  const fire = simulate({ startHour: 21, hours: 8, state: { heat: 30, wetness: 0 }, fire: 1 });
  assert.ok(fire.s.heat >= S.heatComfortMin && fire.s.heat <= S.heatComfortMax, `by the fire ${fire.s.heat.toFixed(1)}`);
});

test('rain soaks you in the open but not under a shelter', () => {
  const open = simulate({ startHour: 15, hours: 1, state: { wetness: 0, heat: 55 }, weather: { rain: 1, cloudiness: 0.9 } });
  const roof = simulate({ startHour: 15, hours: 1, state: { wetness: 0, heat: 55 }, weather: { rain: 1, cloudiness: 0.9 }, sheltered: true });
  assert.ok(open.s.wetness > 0.8, `open wetness ${open.s.wetness}`);
  assert.equal(roof.s.wetness, 0);
  assert.ok(open.s.heat < roof.s.heat, 'wet is colder');
});

test('thirst at 0 damages health (dehydration)', () => {
  const s = Object.assign(M.createState(), { thirst: 0, heat: 55, wetness: 0 });
  const h0 = s.health;
  const { causes } = run(s, 10);
  near(h0 - s.health, S.dmgThirstPerSec * 10, 0.05, 'dehydration damage');
  assert.ok(causes.has('dehydration'));
});

test('hunger at 0 damages health (starvation)', () => {
  const s = Object.assign(M.createState(), { hunger: 0, heat: 55, wetness: 0 });
  const h0 = s.health;
  const { causes } = run(s, 10);
  near(h0 - s.health, S.dmgHungerPerSec * 10, 0.05);
  assert.ok(causes.has('starvation'));
});

test('hypothermia and heatstroke damage', () => {
  const cold = Object.assign(M.createState(), { heat: 5, wetness: 1 });
  const r1 = run(cold, 5, { env: { airTemp: 5, sun: 0, wind: 1 } });
  assert.ok(r1.dmg > S.dmgColdPerSec * 5, 'cold damage scales below the threshold');
  assert.ok(r1.causes.has('hypothermia'));
  const hot = Object.assign(M.createState(), { heat: 97, wetness: 0 });
  const r2 = run(hot, 2, { env: { airTemp: 40, sun: 1 } });
  assert.ok(r2.causes.has('heatstroke'));
});

test('swimming drains energy (tread < swim < fast swim)', () => {
  const rate = (act) => {
    const s = Object.assign(M.createState(), { energy: 100 });
    run(s, 5, { act, env: { immersion: 1 } });
    return (100 - s.energy) / 5;
  };
  near(rate({ swimming: true }), S.energyTreadPerSec, 1e-6, 'tread');
  near(rate({ swimming: true, moving: true }), S.energySwimPerSec, 1e-6, 'swim');
  near(rate({ swimming: true, moving: true, sprinting: true }), S.energySwimFastPerSec, 1e-6, 'fast swim');
});

test('sprint locked at 0 energy until energy >= energyResumeSprintAt', () => {
  const s = Object.assign(M.createState(), { energy: 10 });
  run(s, 3, { act: { moving: true, sprinting: true } });
  assert.equal(s.energy, 0);
  assert.equal(s.exhausted, true);
  assert.equal(M.canSprint(s), false);
  near(M.landSpeed(true, s), P.exhaustedSpeed, 1e-9, 'trudging at exhaustedSpeed at 0 energy');
  // recover while idle: still locked just below the threshold
  const secsToJustBelow = (S.energyResumeSprintAt - 0.5) / S.energyRegenIdlePerSec;
  run(s, secsToJustBelow);
  assert.ok(s.energy < S.energyResumeSprintAt);
  assert.equal(M.canSprint(s), false, 'still locked');
  assert.ok(M.landSpeed(true, s) < P.walkSpeed, 'still slower than walking');
  run(s, 0.5);
  assert.ok(s.energy >= S.energyResumeSprintAt);
  assert.equal(M.canSprint(s), true, 'sprint unlocked');
  assert.equal(M.landSpeed(true, s), P.sprintSpeed);
});

test('jump cost goes through the same exhaustion rule', () => {
  const s = Object.assign(M.createState(), { energy: S.energyJump * 0.5 });
  M.changeEnergy(s, -S.energyJump);
  assert.equal(s.energy, 0);
  assert.equal(s.exhausted, true);
  M.applyEffects(s, { energy: 12 }); // food energy below the resume threshold keeps you exhausted
  assert.equal(s.exhausted, true);
  M.applyEffects(s, { energy: 12 });
  assert.equal(s.exhausted, false);
});

test('energy regen is halved when hunger or thirst < 20', () => {
  const a = Object.assign(M.createState(), { energy: 50 });
  const b = Object.assign(M.createState(), { energy: 50, hunger: 15 });
  run(a, 2);
  run(b, 2);
  near(a.energy - 50, S.energyRegenIdlePerSec * 2, 1e-6);
  near(b.energy - 50, S.energyRegenIdlePerSec, 1e-6);
});

test('sinking after exhaustion in deep water: head under, breath drains, drowning hurts', () => {
  const s = Object.assign(M.createState(), { energy: 0, exhausted: true, wetness: 1 });
  const { causes } = run(s, 25, { act: { swimming: true, sinking: true, headUnderwater: true }, env: { immersion: 1 } });
  assert.equal(s.breath, 0);
  assert.ok(causes.has('drowning'));
  assert.ok(s.energy > 0, 'limp floating slowly restores some strength');
});

test('poison deals its damage over ~20 s', () => {
  const s = Object.assign(M.createState(), { health: 100, heat: 55, wetness: 0 });
  M.applyEffects(s, { poison: 30 });
  const half = run(s, 10);
  near(half.dmg, 15, 0.5, 'half the poison after 10 s');
  assert.ok(half.causes.has('poison'));
  const rest = run(s, 10.5);
  near(half.dmg + rest.dmg, 30, 0.2, 'all of it after ~20 s');
  const after = run(s, 5);
  assert.equal(after.dmg, 0, 'nothing after it wore off');
  assert.equal(s.poison, 0);
});

test('toadstool effects: poison + nausea timer + small thirst loss', () => {
  const s = Object.assign(M.createState(), { thirst: 50 });
  M.applyEffects(s, ITEMS.toadstool.effects);
  assert.equal(s.nausea, 25);
  run(s, 5);
  near(s.nausea, 20, 1e-6);
  assert.ok(s.thirst < 50);
});

test('applyEffects clamps and reports real deltas', () => {
  const s = Object.assign(M.createState(), { thirst: 95, health: 3, wetness: 0.2 });
  const d = M.applyEffects(s, { thirst: 32, health: -8, wetness: -1, heat: 500 });
  assert.equal(s.thirst, 100);
  assert.equal(d.thirst, 5);
  assert.equal(s.health, 0);
  assert.equal(d.health, -3);
  assert.equal(s.wetness, 0);
  assert.equal(s.heat, 100);
});

test('seawater: thirst -8, health -2', () => {
  const s = M.createState();
  const t0 = s.thirst,
    h0 = s.health;
  M.applyEffects(s, { thirst: -8, health: -2 });
  assert.equal(s.thirst, t0 - 8);
  assert.equal(s.health, h0 - 2);
});

test('sleeping 8 h drains thirst and hunger at half rate and restores energy', () => {
  const s = Object.assign(M.createState(), { thirst: 80, hunger: 80, energy: 10, exhausted: true, health: 70 });
  const r = M.simulateSleep(s, 8, { fire: 1, sheltered: true });
  near(r.thirstLost, S.thirstPerHour * 0.5 * 8, 1e-9, 'thirst');
  near(r.hungerLost, S.hungerPerHour * 0.5 * 8, 1e-9, 'hunger');
  assert.equal(s.energy, 100);
  assert.equal(s.exhausted, false);
  assert.ok(s.health > 70, 'rest heals');
  assert.ok(s.heat >= S.heatComfortMin && s.wetness === 0, 'warm and dry by the fire');
});

test('sleeping with a fire/shelter is warmer than in the open; deficits never kill in sleep', () => {
  const a = M.createState();
  const b = M.createState();
  M.simulateSleep(a, 8, {});
  M.simulateSleep(b, 8, { fire: 1 });
  assert.ok(b.heat > a.heat);
  const c = Object.assign(M.createState(), { thirst: 2, hunger: 2, health: 20 });
  const r = M.simulateSleep(c, 10, {});
  assert.ok(r.damage > 0);
  assert.equal(c.health, M.K.sleepMinHealth);
});

test('fall damage only above fallDamageSpeed and grows quickly', () => {
  assert.equal(M.fallDamage(P.fallDamageSpeed - 1), 0);
  const small = M.fallDamage(P.fallDamageSpeed + 2);
  const big = M.fallDamage(P.fallDamageSpeed + 8);
  assert.ok(small > 0 && small < 20, `small ${small}`); // ~6 m drop: a bruise
  assert.ok(big >= 55 && big < 90, `big ${big}`); // ~11 m drop: badly hurt
  assert.ok(M.fallDamage(P.fallDamageSpeed + 11) >= 100, 'a ~14 m drop is lethal');
});

test('god mode: no drains and no damage', () => {
  const s = Object.assign(M.createState(), { thirst: 0, hunger: 0, heat: 5 });
  const h0 = s.health;
  run(s, 5, { god: true, act: { sprinting: true, moving: true } });
  assert.equal(s.health, h0);
  assert.ok(s.energy >= M.createState().energy);
});

test('the biggest contributor names the death cause', () => {
  const s = Object.assign(M.createState(), { thirst: 0, breath: 0, health: 5 });
  const { causes } = run(s, 1, { act: { headUnderwater: true, swimming: true } });
  assert.ok(causes.has('drowning'));
  assert.equal(s.health, 0);
});

test('health regenerates slowly when needs are met', () => {
  const s = Object.assign(M.createState(), { health: 50, thirst: 80, hunger: 80, heat: 55, wetness: 0 });
  run(s, 10, { env: { airTemp: 20, sun: 0.3 } });
  near(s.health, 50 + S.healthRegenPerSec * 10, 0.05);
});

test('warning levels', () => {
  const s = Object.assign(M.createState(), { thirst: 8, hunger: 24, heat: 30 });
  assert.equal(M.warningLevel('thirst', s), 'critical');
  assert.equal(M.warningLevel('hunger', s), 'low');
  assert.equal(M.warningLevel('cold', s), 'low');
  assert.equal(M.warningLevel('hot', s), null);
  assert.equal(M.warningLevel('energy', s, { sinking: true }), 'critical');
});

// ── Headless integration: controller.js + stats.js on the real heightfield (no DOM / WebGL) ────────────
async function integration() {
  console.log('\ncontroller + stats (headless, real heightfield)');
  const THREE = await import('three');
  const { createEvents } = await import('../src/core/events.js');
  const { createColliders } = await import('../src/core/spatial.js');
  const { createHeightfield } = await import('../src/world/heightfield.js');
  const Controller = await import('../src/player/controller.js');
  const Stats = await import('../src/survival/stats.js');

  const world = createHeightfield();
  const events = createEvents();
  const log = [];
  const emit = events.emit.bind(events);
  events.emit = (n, p) => {
    log.push([n, p]);
    emit(n, p);
  };
  const held = new Set();
  const pressed = new Set();
  const toasts = [];
  const ctx = {
    THREE, config: CONFIG, events, state: 'loading', world,
    input: { mouseDX: 0, mouseDY: 0, locked: true, isDown: (a) => held.has(a), wasPressed: (a) => pressed.has(a), wasReleased: () => false },
    time: createClock(events),
    colliders: createColliders(),
    camera: new THREE.PerspectiveCamera(CONFIG.graphics.fov, 1.6, 0.1, 2000),
    flags: { cinematic: false, torchLit: false, sheltered: false, nearFire: 0, sleeping: false, godMode: false, gravityScale: 1, speedScale: 1 },
    uniforms: { uWindStrength: { value: 0.35 }, uRain: { value: 0 } },
    heatSources: new Set(), shelters: new Set(), signals: new Set(),
    stats_summary: { distanceWalked: 0, itemsCrafted: 0, foodsEaten: 0, plantsGathered: 0 },
    ui: { toast: (t) => toasts.push(t), hint() {}, flash() {} },
    audio: { play() {} },
    fade: () => Promise.resolve(),
  };
  ctx.camera.rotation.order = 'YXZ';
  ctx.player = Controller.create(ctx);
  ctx.stats = Stats.create(ctx);
  ctx.player.init();
  ctx.stats.init();
  events.on('stats:died', () => {
    if (ctx.state === 'playing') ctx.state = 'dead';
  });
  const pl = ctx.player, st = ctx.stats;
  const spawn = world.landmarks.spawn;
  ctx.state = 'playing';
  pl.teleport(spawn.x, spawn.z, spawn.yaw);
  ctx.time.setHour(CONFIG.time.startHour);
  events.emit('game:start', {});
  const dt = 1 / 60;
  const frames = (n, each) => {
    for (let i = 0; i < n; i++) {
      ctx.time.update(dt);
      pl.update(dt);
      st.update(dt);
      each?.(i);
      pressed.clear();
    }
  };
  const count = (name, f) => log.filter((e) => e[0] === name && (!f || f(e[1]))).length;

  test('spawn: feet on the ground, camera at eye height', () => {
    near(pl.position.y, world.heightAt(pl.position.x, pl.position.z), 1e-6);
    near(ctx.camera.position.y - pl.position.y, P.eyeHeight, 0.06);
  });
  const p0 = pl.position.clone();
  held.add('forward');
  frames(180);
  held.clear();
  frames(20);
  test('walking: ~walkSpeed, footsteps on sand, distanceWalked tracked', () => {
    const d = p0.distanceTo(pl.position);
    assert.ok(d > P.walkSpeed * 2.6 && d < P.walkSpeed * 3.3, `moved ${d.toFixed(2)} m in 3 s`);
    assert.ok(count('player:footstep') >= 4, 'footsteps');
    assert.ok(['sand', 'grass'].includes(log.find((e) => e[0] === 'player:footstep')[1].surface));
    assert.ok(ctx.stats_summary.distanceWalked > d * 0.9);
  });
  test('sprinting drains energy at energySprintPerSec', () => {
    st.setValues({ energy: 80 });
    held.add('forward');
    held.add('sprint');
    frames(120);
    held.clear();
    near(80 - st.values.energy, S.energySprintPerSec * 2, 1.2);
  });
  test('jump: ~v^2/2g high, costs energy, emits jump + land', () => {
    st.setValues({ energy: 60 });
    const y0 = pl.position.y;
    let top = 0;
    pressed.add('jump');
    frames(90, () => (top = Math.max(top, pl.position.y - y0)));
    near(top, (P.jumpVelocity * P.jumpVelocity) / (2 * P.gravity), 0.15);
    assert.equal(count('player:jump'), 1);
    assert.ok(count('player:land') >= 1);
    assert.ok(st.values.energy < 60 + S.energyRegenIdlePerSec * 1.5 - S.energyJump + 0.5);
  });
  test('deep water: swimming with the eyes ~0.25 m above the surface', () => {
    const W = world.landmarks.wreck;
    pl.teleport(W.x, W.z - 15, Math.PI);
    frames(120);
    const w = world.waterAt(pl.position.x, pl.position.z);
    assert.ok(pl.swimming && pl.inWater, 'swimming');
    near(ctx.camera.position.y - w.surface, 0.25, 0.2, 'eye above surface');
    assert.equal(count('player:swimStart'), 1);
    assert.equal(st.values.wetness, 1);
  });
  test('energy 0 in deep water: sink, head under, breath drains, drowning hurts, then recover', () => {
    st.setValues({ energy: 0, health: 90 });
    frames(1300); // ~18 s of breath, then drowning damage
    assert.ok(count('player:submerged') >= 1, 'submerged');
    assert.ok(st.values.health < 90, 'drowning damage');
    assert.ok(count('player:hurt', (p) => p.cause === 'drowning') >= 1);
    frames(700); // limp floating restores energy to energyResumeSprintAt -> float back up
    assert.ok(count('player:surfaced') >= 1, 'surfaced again after resting');
    assert.equal(st.exhausted, false);
  });
  test('swimming back to the beach stands you up (swimEnd, exitWater)', () => {
    st.setValues({ energy: 100, health: 90 });
    pl.yaw = 0;
    held.add('forward');
    frames(1200);
    held.clear();
    assert.equal(pl.swimming, false);
    assert.ok(count('player:swimEnd') >= 1 && count('player:exitWater') >= 1);
  });
  test('falling 8 m hurts (cause falling)', () => {
    pl.teleport(spawn.x, spawn.z - 40, 0);
    frames(10);
    const h0 = st.values.health;
    pl.position.y += 8;
    pl.onGround = false;
    frames(120);
    assert.ok(h0 - st.values.health > 15, `fall dmg ${(h0 - st.values.health).toFixed(1)}`);
    assert.ok(count('player:hurt', (p) => p.cause === 'falling') >= 1);
  });
  test('world boundary currents hold you inside CONFIG.world.boundary (toast once)', () => {
    pl.teleport(0, CONFIG.world.boundary - 12, Math.PI);
    held.add('forward');
    frames(300);
    held.clear();
    assert.ok(Math.hypot(pl.position.x, pl.position.z) <= CONFIG.world.boundary + 1e-6);
    assert.equal(toasts.filter((t) => t.includes('current')).length, 1);
  });
  await (async () => {
    pl.teleport(spawn.x, spawn.z - 40, 0);
    frames(10);
    st.setValues({ thirst: 80, hunger: 80, energy: 30 });
    ctx.time.setHour(22);
    const ok = await st.sleep(8);
    test('stats.sleep(8): skips the clock, half-rate drains, energy 100, stats:sleep', () => {
      assert.equal(ok, true);
      near(ctx.time.hour, 6, 1e-6);
      near(st.values.thirst, 80 - S.thirstPerHour * 4, 1e-6);
      near(st.values.hunger, 80 - S.hungerPerHour * 4, 1e-6);
      assert.equal(st.values.energy, 100);
      assert.equal(count('stats:sleep'), 1);
      assert.equal(ctx.flags.sleeping, false);
    });
  })();
  test('death: stats:died once with the cause; damage ignored afterwards; camera falls', () => {
    const camY = ctx.camera.position.y;
    st.damage(500, 'tree');
    st.damage(5, 'tree');
    assert.equal(st.dead, true);
    assert.equal(st.deathCause, 'tree');
    assert.equal(count('stats:died'), 1);
    assert.equal(ctx.state, 'dead');
    frames(150);
    assert.ok(ctx.camera.position.y < camY - 1, 'camera fell to the ground');
  });
}

try {
  await integration();
} catch (e) {
  failed++;
  console.log('  FAIL integration crashed:', e);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
