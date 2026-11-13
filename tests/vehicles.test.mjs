// v3 (V3-C): pure vehicle logic: aground, capsizing, disembark spots, launch spots, head-home, currents.
// Run: node tests/vehicles.test.mjs
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createHeightfield } from '../src/world/heightfield.js';
import * as V from '../src/gameplay/vehicle-logic.js';
import * as THREE from 'three';
import { createEvents } from '../src/core/events.js';
import { createRng } from '../src/core/rng.js';
import { create as createController } from '../src/player/controller.js';
import { create as createVehicles } from '../src/gameplay/vehicles.js';
import { DEATH, deathLead, vehiclePanel, stormBannerOn, isleSightingDue, raftWinText, PART_WHERE, MAP_LANDMARKS, HUNGER_ICON, effectSummary, partsSummary } from '../src/ui/hud-data.js';
import { createMap, MAP_BOUNDS } from '../src/ui/hud-map.js';
import { RECIPE_BY_ID, checkRecipe } from '../src/gameplay/recipes.js';

let passed = 0;
const pending = [];
function test(name, fn) {
  const fail = (e) => {
    console.error('FAIL', name);
    throw e;
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') pending.push(r.then(() => passed++, fail));
    else passed++;
  } catch (e) {
    fail(e);
  }
}

const W = createHeightfield();
const LM = W.landmarks;
const ISLE = W.isle2;

test('aground check', () => {
  assert.equal(V.isAground(-1.0, 0), false);
  assert.equal(V.isAground(-0.3, 0), false);
  assert.equal(V.isAground(-0.2, 0), true);
  assert.equal(V.isAground(0.5, 0), true);
  assert.equal(V.isAground(-0.1, 0.2), false, 'surface above sea level (wave crest)');
});

test('capsize probability', () => {
  const k = CONFIG.isle2.capsizePerSec;
  assert.equal(V.capsizeChance(0, 1, k), 0);
  assert.equal(V.capsizeChance(0.5, 1, k), 0, 'not at the threshold');
  assert.equal(V.capsizeChance(0.9, 0, k), 0);
  const p1 = V.capsizeChance(1, 1, k);
  assert.ok(Math.abs(p1 - (1 - Math.exp(-k))) < 1e-12);
  assert.ok(V.capsizeChance(0.7, 1, k) < p1, 'weaker storm, lower chance');
  // frame-rate independent: 60 frames of 1/60 s == one 1 s step
  let survive = 1;
  for (let i = 0; i < 60; i++) survive *= 1 - V.capsizeChance(1, 1 / 60, k);
  assert.ok(Math.abs(1 - survive - p1) < 1e-9);
  // a full-storm minute flips a raft more often than not? (0.06/s -> ~97 %)
  assert.ok(V.capsizeChance(1, 60, k) > 0.9);
  assert.equal(V.canRight(0.29), true);
  assert.equal(V.canRight(0.3), false);
  assert.equal(V.canRight(undefined), true);
});

test('head-home and open-sea conditions', () => {
  assert.equal(V.canHeadHome(-249), false);
  assert.equal(V.canHeadHome(-251), true);
  assert.equal(V.canHeadHome(NaN), false);
  assert.equal(V.canHeadHome(W.coastDistance(LM.isle2Dock.x, LM.isle2Dock.z)), false, 'not at the dock');
  // straight out from Tempest Isle, away from both islands
  const ox = ISLE.x + 520, oz = ISLE.z - 520;
  assert.equal(V.canHeadHome(W.coastDistance(ox, oz)), true);
  assert.equal(V.openSeaReached(0, 900, ISLE), false);
  assert.equal(V.openSeaReached(0, 1400, ISLE), true);
  assert.equal(V.openSeaReached(ISLE.x + 100, ISLE.z - 1000, ISLE), true);
  assert.equal(V.openSeaReached(ISLE.x * 1.2, ISLE.z * 1.2 + 0, ISLE), Math.hypot(ISLE.x * 0.2, ISLE.z * 0.2) > V.OPEN_SEA_ISLE && Math.hypot(ISLE.x * 1.2, ISLE.z * 1.2) > V.OPEN_SEA_MAIN);
});

test('disembark spot search', () => {
  // mock: dry land for x > 2, sea elsewhere
  const mock = {
    heightAt: (x) => (x > 2 ? 0.6 : -1.5),
    waterAt: (x) => (x > 2 ? null : { type: 'ocean', depth: 1.5, surface: 0 }),
    slopeAt: () => 0.1,
  };
  const s = V.findDisembarkSpot(mock, 0, 0, 4.6);
  assert.ok(s, 'found');
  assert.ok(s.x > 2 && s.d <= 4.6);
  assert.equal(V.findDisembarkSpot(mock, -10, 0, 4.6), null, 'open water');
  const steep = { ...mock, slopeAt: () => 0.9 };
  assert.equal(V.findDisembarkSpot(steep, 0, 0, 4.6), null, 'cliffs are not a landing');
  // real world: just off the launch beach there is dry sand within reach
  const lb = LM.launchBeach;
  const dir = { x: (ISLE.x - lb.x) / Math.hypot(ISLE.x - lb.x, ISLE.z - lb.z), z: (ISLE.z - lb.z) / Math.hypot(ISLE.x - lb.x, ISLE.z - lb.z) };
  let wx = lb.x, wz = lb.z;
  for (let t = 0; t < 60 && !W.waterAt(wx, wz); t += 0.5) {
    wx = lb.x + dir.x * t;
    wz = lb.z + dir.z * t;
  }
  assert.ok(W.waterAt(wx, wz), 'found the waterline');
  const r = V.findDisembarkSpot(W, wx + dir.x, wz + dir.z, 4.6);
  assert.ok(r, 'dry sand next to the waterline');
  assert.equal(W.waterAt(r.x, r.z), null);
  assert.equal(V.findDisembarkSpot(W, (lb.x + LM.isle2Cove.x) / 2, (lb.z + LM.isle2Cove.z) / 2, 4.6), null, 'mid-crossing');
});

test('launch spot at the water edge', () => {
  const lb = LM.launchBeach;
  const yaw = V.headingTo(lb.x, lb.z, ISLE.x, ISLE.z); // facing Tempest Isle
  // walk to just before the waterline
  let px = lb.x, pz = lb.z;
  for (let t = 0; t < 60; t += 0.5) {
    const x = lb.x + V.fwdX(yaw) * t, z = lb.z + V.fwdZ(yaw) * t;
    if (W.waterAt(x, z)) break;
    px = x;
    pz = z;
  }
  const s = V.findLaunchSpot(W, px, pz, yaw);
  assert.ok(s.ok, 'spot found at the beach');
  const w = W.waterAt(s.x, s.z);
  assert.ok(w && w.type === 'ocean' && w.depth >= 0.3 && w.depth <= 2);
  assert.ok(Math.hypot(s.x - px, s.z - pz) <= 8.01);
  // the raft points out to sea, roughly toward Tempest Isle
  assert.ok(Math.abs(V.wrapAngle(s.heading - yaw)) < 1.6, 'seaward');
  // inland: refused with the hint
  const inland = V.findLaunchSpot(W, LM.summit.x, LM.summit.z, 0);
  assert.equal(inland.ok, false);
  assert.match(inland.reason, /water's edge/);
});

test('currents: only far from both islands, never a snap between them', () => {
  const B = CONFIG.world.boundary, soft = 32;
  const o = {};
  assert.equal(V.currentsAt(0, 300, B, soft, ISLE, 320, o).active, false, 'near the main island');
  assert.equal(V.currentsAt(ISLE.x, ISLE.z - 250, B, soft, ISLE, 320, o).active, false, 'near Tempest Isle');
  // far out south of the main island: the old behaviour (push to the center, hard limit)
  V.currentsAt(0, 480, B, soft, ISLE, 320, o);
  assert.equal(o.active, true);
  assert.ok(o.dirZ < -0.99 && o.clampR === B && o.over > 1);
  // mid-crossing: a capped current, no snap
  const lb = LM.launchBeach, cv = LM.isle2Cove;
  const mx = (lb.x + cv.x) / 2, mz = (lb.z + cv.z) / 2;
  V.currentsAt(mx, mz, B, soft, ISLE, 320, o);
  assert.equal(o.active, true);
  assert.equal(o.clampR, 0);
  assert.ok(o.over <= V.CORRIDOR_MAX + 1e-9);
  // closer to Tempest Isle's coast: pushed toward it
  const nx = cv.x + (lb.x - cv.x) * 0.25, nz = cv.z + (lb.z - cv.z) * 0.25;
  V.currentsAt(nx, nz, B, soft, ISLE, 320, o);
  if (o.active) assert.ok(o.dirX * (ISLE.x - nx) + o.dirZ * (ISLE.z - nz) > 0, 'toward the isle');
  // no second island in a mock world: plain main-island behaviour
  V.currentsAt(480, 0, B, soft, null, 320, o);
  assert.ok(o.active && o.clampR === B && o.dirX < -0.99);
});

// nobody swims between the islands (the user: "You can't naturally swim to it"), from either side
function swimAcross(from, to, seconds = 600) {
  const held = new Set(['forward', 'sprint']);
  const ctx = {
    state: 'playing',
    flags: { godMode: true },
    camera: new THREE.PerspectiveCamera(70, 1, 0.1, 1000),
    events: { emit() {} },
    input: { isDown: (a) => held.has(a), wasPressed: () => false, mouseDX: 0, mouseDY: 0 },
    stats: { exhausted: false, values: { energy: 100 }, dead: false },
    stats_summary: { distanceWalked: 0 },
    ui: { hint() {}, toast() {} },
    world: W,
  };
  ctx.camera.rotation.order = 'YXZ';
  const pl = createController(ctx);
  ctx.player = pl;
  const yaw = V.headingTo(from.x, from.z, to.x, to.z);
  pl.teleport(from.x, from.z, yaw);
  let best = Infinity;
  for (let t = 0; t < seconds; t += 1 / 20) {
    pl.yaw = yaw;
    pl.update(1 / 20);
    best = Math.min(best, Math.hypot(pl.position.x - to.x, pl.position.z - to.z));
  }
  return { best, pl };
}
test('currents: you cannot swim between the islands', () => {
  const lb = LM.launchBeach, cv = LM.isle2Cove;
  const half = Math.hypot(cv.x - lb.x, cv.z - lb.z) / 2;
  const a = swimAcross(lb, cv);
  assert.ok(a.best > half, `main -> isle got within ${a.best.toFixed(0)} m (midpoint ${half.toFixed(0)} m)`);
  assert.ok(Math.hypot(a.pl.position.x - ISLE.x, a.pl.position.z - ISLE.z) > 300);
  const b = swimAcross(cv, lb);
  assert.ok(b.best > half, `isle -> main got within ${b.best.toFixed(0)} m`);
});

test('dock helpers and mooring', () => {
  const D = LM.isle2Dock;
  assert.ok(V.dockDistance(D, D.x + D.dirX * 9, D.z + D.dirZ * 9) < 1e-9);
  assert.ok(Math.abs(V.dockDistance(D, D.x + D.dirX * 9 - D.dirZ * 3, D.z + D.dirZ * 9 + D.dirX * 3) - 3) < 1e-9);
  const L = V.dockLanding(D);
  assert.equal(W.waterAt(L.x, L.z), null, 'landing is dry');
  const m = V.findMooring(W, D, 1);
  const w = W.waterAt(m.x, m.z);
  assert.ok(w && w.type === 'ocean', 'moored at sea');
  assert.ok(V.dockDistance(D, m.x, m.z) > 3.5, 'clear of the dock');
  assert.ok(Math.hypot(m.x - LM.isle2Cove.x, m.z - LM.isle2Cove.z) < 45, 'off the cove');
});

test('paddle target speeds', () => {
  const cfg = CONFIG.vehicles.paddleRaft;
  assert.equal(V.paddleTarget(1, cfg), cfg.speed);
  assert.equal(V.paddleTarget(-1, cfg), -cfg.reverse);
  assert.equal(V.paddleTarget(1, cfg, { hasPaddle: false }), 0);
  assert.ok(V.paddleTarget(1, cfg, { exhausted: true }) <= 0.35);
  assert.equal(V.paddleTarget(0, cfg), 0);
  // a full crossing at paddle speed takes a while but is doable: ~525 m
  const minutes = 525 / cfg.speed / 60;
  assert.ok(minutes > 2 && minutes < 8, `crossing ${minutes.toFixed(1)} min`);
});

// ── end to end: real heightfield + controller + vehicles, mocked everything else ──
function rig() {
  const held = new Set();
  const inv = new Map();
  const toasts = [];
  const sounds = [];
  const events = createEvents();
  const emitted = [];
  const origEmit = events.emit.bind(events);
  events.emit = (n, p) => {
    emitted.push([n, p]);
    origEmit(n, p);
  };
  let provider = null;
  const weather = { storm: 0, stormAt: () => weather.storm, wind: { x: 1, z: 0, strength: 0.6 } };
  const stats = { exhausted: false, dead: false, values: { energy: 100 }, drained: 0, drainEnergy(n) { stats.drained += n; } };
  const ctx = {
    THREE,
    config: CONFIG,
    state: 'playing',
    flags: {},
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(70, 1, 0.1, 3000),
    events,
    rng: createRng(7),
    input: { isDown: (a) => held.has(a), wasPressed: () => false, mouseDX: 0, mouseDY: 0 },
    stats,
    stats_summary: { distanceWalked: 0 },
    ui: { hint() {}, toast: (t) => toasts.push(t), flash() {}, subtitle() {}, setPrompt() {} },
    audio: { play: (n) => sounds.push(n), setLoop() {} },
    world: W,
    weather,
    time: { day: 3 },
    inventory: {
      count: (id) => inv.get(id) || 0,
      add: (id, n = 1) => inv.set(id, (inv.get(id) || 0) + n),
      remove: (id, n = 1) => inv.set(id, Math.max(0, (inv.get(id) || 0) - n)),
    },
    interact: { addProvider: (fn) => (provider = fn) },
    fade: () => Promise.resolve(),
    letterbox() {},
  };
  ctx.scene.add(ctx.camera);
  ctx.camera.rotation.order = 'YXZ';
  const pl = createController(ctx);
  ctx.player = pl;
  pl.init();
  const veh = createVehicles(ctx);
  ctx.vehicles = veh;
  veh.init();
  const step = (dt = 1 / 30) => {
    pl.update(dt);
    veh.update(dt);
  };
  const run = (seconds, dt = 1 / 30, until = null) => {
    for (let t = 0; t < seconds; t += dt) {
      step(dt);
      if (until && until()) return true;
    }
    return false;
  };
  const cand = () => provider?.(ctx) || null;
  return { ctx, pl, veh, held, inv, toasts, sounds, emitted, weather, stats, run, step, cand };
}

test('paddle raft: build, board, paddle, aground, disembark', () => {
  const R = rig();
  const { pl, veh, held, run, cand } = R;
  const raft = veh.debugRaft();
  assert.ok(raft, 'raft placed');
  const w = W.waterAt(raft.object.position.x, raft.object.position.z);
  assert.ok(w && w.depth >= 0.3 && w.depth <= 2, 'in shallow water');
  const c = cand();
  assert.equal(c?.label, 'Board the raft');
  c.onUse();
  assert.equal(veh.current, raft);
  assert.equal(pl.aboard, raft);
  assert.equal(pl.swimming, false);
  // the camera sits on the seat
  run(0.5);
  const seat = new THREE.Vector3();
  raft.seat.getWorldPosition(seat);
  assert.ok(seat.distanceTo(R.ctx.camera.position) < 1e-6, 'camera at the seat');
  assert.ok(Math.abs(pl.position.y - (seat.y - V.RAFT.seatEye)) < 1e-6, 'feet on the deck');
  // paddle out toward Tempest Isle
  const p0 = raft.object.position.clone();
  const isle = W.isle2;
  const d0 = Math.hypot(p0.x - isle.x, p0.z - isle.z);
  pl.yaw = raft.heading = V.headingTo(p0.x, p0.z, isle.x, isle.z);
  held.add('forward');
  run(25);
  held.delete('forward');
  const d1 = Math.hypot(raft.object.position.x - isle.x, raft.object.position.z - isle.z);
  assert.ok(d0 - d1 > 25, `paddled ${(d0 - d1).toFixed(1)} m toward the isle`);
  assert.ok(R.stats.drained > 5, 'paddling costs energy');
  assert.ok(R.sounds.filter((n) => n === 'splash').length > 10, 'soft splash per stroke');
  assert.equal(veh.canDisembark, false, 'no land out here');
  // no paddle: drifting only
  R.inv.set('paddle', 0);
  R.weather.wind.strength = 0;
  run(12); // coast to a stop first
  const before = raft.object.position.clone();
  held.add('forward');
  run(5);
  held.delete('forward');
  assert.ok(raft.object.position.distanceTo(before) < 3, 'barely moves without a paddle');
  assert.ok(R.toasts.some((t) => /Wooden Paddle/.test(t)), 'paddle toast');
  R.inv.set('paddle', 1);
  // turn back to the beach and run aground
  const LB = W.landmarks.launchBeach;
  pl.yaw = raft.heading = V.headingTo(raft.object.position.x, raft.object.position.z, LB.x, LB.z);
  held.add('forward');
  const grounded = run(60, 1 / 30, () => raft.aground);
  held.delete('forward');
  assert.ok(grounded, 'ran aground at the beach');
  const g = W.heightAt(raft.object.position.x, raft.object.position.z);
  assert.ok(g < 0, 'the raft itself still floats');
  run(0.5);
  assert.equal(veh.canDisembark, true);
  const d = cand();
  assert.equal(d.label, 'Disembark');
  d.onUse();
  assert.equal(veh.current, null);
  assert.equal(pl.aboard, null);
  assert.equal(W.waterAt(pl.position.x, pl.position.z), null, 'on dry land');
  run(0.5);
  assert.equal(pl.swimming, false);
});

test('paddle raft: storms capsize it, then it can be righted', () => {
  const R = rig();
  const { pl, veh, run, cand, weather } = R;
  const raft = veh.debugRaft();
  cand().onUse();
  // paddle out a bit so the player lands in deep water
  pl.yaw = raft.heading;
  R.held.add('forward');
  run(12);
  R.held.delete('forward');
  weather.storm = 1;
  const flipped = run(240, 1 / 30, () => raft.capsized);
  assert.ok(flipped, 'flipped within 4 minutes of full storm');
  assert.equal(veh.current, null, 'thrown off');
  assert.equal(pl.aboard, null);
  run(2);
  assert.ok(pl.swimming || pl.inWater, 'in the water');
  assert.ok(R.emitted.some(([n]) => n === 'vehicle:capsized'));
  // too stormy to right it
  const c1 = cand();
  assert.ok(c1 && /wait for the storm/.test(c1.label), c1?.label);
  c1.onUse();
  assert.equal(raft.capsized, true);
  weather.storm = 0.1;
  const c2 = cand();
  assert.equal(c2?.label, 'Right the raft');
  c2.onUse();
  assert.equal(raft.capsized, false);
  run(1.5);
  assert.ok(Math.abs(raft.body.rotation.z) < 1e-6, 'upright again');
  assert.equal(cand()?.label, 'Board the raft');
});

test('motorboat: key, fuel, drive, head for home', async () => {
  const R = rig();
  const { pl, veh, inv, run, cand, emitted } = R;
  const D = W.landmarks.isle2Dock;
  const obj = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 5.2));
  const hd = V.headingTo(D.x, D.z, D.x + D.dirX, D.z + D.dirZ); // bow out to sea
  obj.position.set(D.x + D.dirX * 20 - D.dirZ * 2.2, 0.1, D.z + D.dirZ * 20 + D.dirX * 2.2);
  obj.rotation.y = hd;
  R.ctx.scene.add(obj);
  const boat = { object: obj, position: obj.position, heading: hd, moored: true };
  R.ctx.isle2 = { motorboat: boat };
  pl.teleport(D.x + D.dirX * 17, D.z + D.dirZ * 17); // standing at the dock end (in water in this mock)
  run(0.2);
  assert.equal(cand()?.label, 'Start the motorboat');
  cand().onUse();
  assert.equal(veh.current, null);
  assert.ok(R.toasts.some((t) => /key/.test(t)), 'key toast');
  inv.set('boat_key', 1);
  cand().onUse();
  assert.equal(veh.current, null, 'no fuel yet');
  inv.set('fuel_can', 1);
  cand().onUse();
  assert.equal(veh.current?.type, 'motorboat');
  assert.equal(inv.get('fuel_can'), 0, 'fuel used on the first start');
  assert.equal(boat.moored, false);
  assert.equal(veh.canHeadHome, false, 'not by the dock');
  R.held.add('forward');
  run(10);
  R.held.delete('forward');
  assert.ok(Math.hypot(obj.position.x - D.x, obj.position.z - D.z) > 50, 'drove out');
  // far out at sea -> [R] Head for home
  obj.position.set(1000, 0, -300); // > 250 m off any coast, < 1300 m from the main center
  run(0.2);
  assert.equal(R.ctx.flags.cinematic, undefined, 'no automatic departure yet');
  assert.equal(veh.canHeadHome, true);
  const c = cand();
  assert.equal(c.secondary?.label, 'Head for home');
  c.secondary.onUse();
  assert.equal(R.ctx.flags.cinematic, true);
  for (let i = 0; i < 400 && !emitted.some(([n]) => n === 'raft:sailed'); i++) {
    run(1 / 30);
    await Promise.resolve();
  }
  const s = emitted.find(([n]) => n === 'raft:sailed');
  assert.ok(s, 'sailed');
  assert.equal(s[1].plan, 'motorboat_dock');
  assert.equal(s[1].name, "the fisherman's motorboat");
});

test('HUD: steak hunger, v3 deaths, panels, banner, sighting, win text', () => {
  assert.equal(HUNGER_ICON, '🥩');
  assert.equal(DEATH.starvation.icon, '🥩');
  assert.match(effectSummary({ hunger: 20 }), /🥩/);
  assert.equal(deathLead(DEATH.coconut, 3, '14:00'), 'A coconut fell on your head. Bonk. Day 3, 14:00.');
  assert.equal(deathLead(DEATH.hail, 2, '09:30'), 'Battered by hail on Tempest Isle. Day 2, 09:30.');
  assert.equal(deathLead(DEATH.fire, 4, '21:00'), "You went down with the fisherman's hut. Day 4, 21:00.");
  assert.equal(deathLead(DEATH.starvation, 5, '08:00'), 'You starved on day 5, 08:00.');
  assert.equal(vehiclePanel(null), null);
  assert.equal(vehiclePanel({ type: 'paddle_raft' }, { hasPaddle: true }).title, '🛶 Paddle raft · W/S paddle · A/D steer · E disembark');
  assert.match(vehiclePanel({ type: 'paddle_raft' }, { hasPaddle: false }).sub, /No paddle/);
  assert.doesNotMatch(vehiclePanel({ type: 'motorboat' }, {}).title, /head for home/);
  assert.match(vehiclePanel({ type: 'motorboat' }, { canHeadHome: true }).title, /R head for home/);
  assert.equal(stormBannerOn({ active: true }, 500), true);
  assert.equal(stormBannerOn({ active: true }, 800), false);
  assert.equal(stormBannerOn({ active: false }, 10), false);
  assert.equal(stormBannerOn(undefined, 10), false);
  const S = LM.summit;
  assert.equal(isleSightingDue({ x: S.x, y: S.y + 1.7, z: S.z }, ISLE), true, 'seen from the summit');
  assert.equal(isleSightingDue({ x: LM.launchBeach.x, y: 3, z: LM.launchBeach.z }, ISLE), false, 'not from the beach');
  assert.equal(raftWinText('Driftwood Raft'), 'You sailed home on your own Driftwood Raft!');
  assert.equal(raftWinText("the fisherman's motorboat"), "You sailed home in the fisherman's motorboat!");
  assert.ok(PART_WHERE.isle2hut?.hint);
  const rows = partsSummary([{ id: 'compass', where: 'isle2hut', found: false }]);
  assert.equal(rows[0].where, 'isle2hut');
  for (const k of ['isle2', 'isle2Dock', 'isle2Hut', 'isle2Pond']) {
    assert.ok(MAP_LANDMARKS.some((m) => m.key === k), k);
    assert.ok(LM[k], `landmark ${k} exists`);
  }
});

test('map covers both islands', () => {
  const map = createMap({ world: W });
  for (const [x, z] of [[0, 0], [LM.wreck.x, LM.wreck.z], [ISLE.x, ISLE.z], [ISLE.x + ISLE.R, ISLE.z - ISLE.R], [-320, 320]]) {
    const [px, pz] = map.toPercent(x, z);
    assert.ok(px > 0 && px < 100 && pz > 0 && pz < 100, `(${x}, ${z}) on the map`);
  }
  assert.ok(MAP_BOUNDS.size >= 1100);
  // every coast of both islands (and the wreck) fits with >= 10 m to spare
  const B = MAP_BOUNDS;
  for (const [cx, cz, R0] of [[0, 0, 480], [ISLE.x, ISLE.z, 235]]) {
    for (let a = 0; a < 360; a += 2) {
      const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
      for (let r = R0; r > 0; r -= 1) {
        const x = cx + c * r, z = cz + s * r;
        if (W.heightAt(x, z) <= 0) continue;
        assert.ok(x > B.x0 + 10 && x < B.x0 + B.size - 10 && z > B.z0 + 10 && z < B.z0 + B.size - 10, `coast (${x.toFixed(0)}, ${z.toFixed(0)}) on the map`);
        break;
      }
    }
  }
  assert.ok(LM.wreck.z < B.z0 + B.size - 25, 'wreck on the map');
  while (!map.bakeStep(64));
  map.reveal(ISLE.x, ISLE.z);
  assert.ok(map.exploredFraction() > 0, 'fog of war on Tempest Isle too');
  const k = map.checkLandmarks(LM.isle2Hut.x, LM.isle2Hut.z).map((l) => l.key);
  assert.ok(k.includes('isle2Hut') && k.includes('isle2'));
});

test('recipes: paddle + paddle raft', () => {
  const inv = { wood: 10, rope: 4 };
  const count = (id) => inv[id] || 0;
  const pr = RECIPE_BY_ID.paddle;
  assert.deepEqual(pr.gives, { id: 'paddle', n: 1 });
  assert.equal(checkRecipe(pr, count).ok, true);
  const raft = RECIPE_BY_ID.paddle_raft;
  assert.equal(raft.place, 'paddle_raft');
  assert.deepEqual(raft.needs.map((n) => [n.id, n.n]), [['wood', 8], ['rope', 3]]);
  const far = checkRecipe(raft, count, { placement: () => V.findLaunchSpot(W, LM.summit.x, LM.summit.z, 0) });
  assert.equal(far.ok, false);
  assert.match(far.reason, /water's edge/);
});

await Promise.all(pending);
console.log(`vehicles: ${passed} tests passed`);
