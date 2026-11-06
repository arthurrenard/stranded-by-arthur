// Unit tests for the pure structure logic (Builder E). Run: node tests/structures.test.mjs
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { ITEMS, COOKABLE } from '../src/core/items.js';
import * as L from '../src/gameplay/structure-logic.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error('FAIL', name);
    throw e;
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('dry fire burns 1 fuel hour per game hour', () => {
  assert.equal(L.fuelBurnRate(0), 1);
  assert.ok(near(L.burnFuel(3, 1, 0), 2));
  assert.equal(L.burnFuel(0.5, 2, 0), 0); // never negative
  assert.equal(L.burnFuel(2, 0, 0), 2);
  assert.equal(L.burnFuel(2, -1, 0), 2);
});

test('rain shortens fuel', () => {
  const dry = L.hoursLeft(CONFIG.fire.campfireStartFuelHours, 0);
  const wet = L.hoursLeft(CONFIG.fire.campfireStartFuelHours, 1);
  assert.equal(dry, CONFIG.fire.campfireStartFuelHours);
  assert.ok(wet < dry * 0.5, `full rain should more than halve burn time (${wet} vs ${dry})`);
  assert.ok(L.burnFuel(3, 1, 1) < L.burnFuel(3, 1, 0.3));
});

test('rain exposure: canopy and shelter cover', () => {
  assert.equal(L.rainExposure(0, 0, false), 0);
  assert.equal(L.rainExposure(1, 0, false), 1);
  assert.ok(L.rainExposure(1, 1, false) < 0.5);
  assert.ok(L.rainExposure(1, 0, true) < 0.2);
  assert.ok(L.rainExposure(1, 0, true) < L.K.douseRainMin, 'a fire beside a lean-to is never doused');
  assert.ok(L.rainExposure(2, -1, false) <= 1);
});

test('adding wood: +fuelPerWood, capped at max, no waste when full', () => {
  const cfg = CONFIG.fire;
  let r = L.addWood(3, 1, cfg);
  assert.ok(near(r.fuel, 3 + cfg.fuelPerWoodHours));
  assert.equal(r.used, 1);
  r = L.addWood(cfg.maxFuelHours - 0.5, 1, cfg);
  assert.equal(r.fuel, cfg.maxFuelHours);
  assert.equal(r.used, 1);
  r = L.addWood(cfg.maxFuelHours, 1, cfg);
  assert.equal(r.used, 0, 'a full fire takes no wood');
  r = L.addWood(0, 3, cfg);
  assert.ok(near(r.fuel, 3 * cfg.fuelPerWoodHours));
  assert.equal(r.used, 3);
});

test('dousing: only heavy rain, deterministic, recovers when the rain eases', () => {
  let p = 0;
  for (let i = 0; i < 100; i++) p = L.douseStep(p, 0.01, 0.4); // 1 h of light rain
  assert.equal(p, 0);
  p = 0;
  let hours = 0;
  while (p < 1 && hours < 10) {
    p = L.douseStep(p, 0.01, 1);
    hours += 0.01;
  }
  assert.ok(hours > 0.2 && hours < 1, `a downpour douses an exposed fire in under an hour (${hours.toFixed(2)} h)`);
  const q = L.douseStep(0.5, 0.25, 0);
  assert.ok(q < 0.5 && q >= 0);
});

test('torch: downpour puts it out quickly, drizzle does not', () => {
  let p = 0, h = 0;
  while (p < 1 && h < 5) {
    p = L.torchDouseStep(p, 0.005, 1);
    h += 0.005;
  }
  assert.ok(h < 0.5, `downpour (${h.toFixed(2)} h)`);
  p = 0;
  for (let i = 0; i < 400; i++) p = L.torchDouseStep(p, 0.01, 0.3);
  assert.equal(p, 0);
  assert.equal(L.K.torchBurnHours, 4);
});

test('flame level follows the fuel', () => {
  assert.equal(L.flameLevel(0), 0);
  assert.ok(L.flameLevel(0.1) < L.flameLevel(1));
  assert.ok(L.flameLevel(1) < L.flameLevel(6));
  assert.ok(L.flameLevel(12) <= 1);
});

test('signal strengths match the spec', () => {
  assert.equal(L.campfireStrength(1), 120);
  assert.equal(L.campfireStrength(0), 350);
  assert.equal(L.signalFireStrength(1), 650);
  assert.equal(L.signalFireStrength(0), 500);
  assert.ok(L.signalFireStrength(1, true) > 650);
  assert.equal(L.sosStrength(1), 220);
  assert.equal(L.sosStrength(0), 0);
  assert.equal(L.torchSignalActive(true, 0), true);
  assert.equal(L.torchSignalActive(true, 1), false);
  assert.equal(L.torchSignalActive(false, 0), false);
});

test('sleep window 19:00..05:00 and blockers', () => {
  assert.equal(L.isSleepHour(19), true);
  assert.equal(L.isSleepHour(23.5), true);
  assert.equal(L.isSleepHour(0), true);
  assert.equal(L.isSleepHour(4.99), true);
  assert.equal(L.isSleepHour(5), false);
  assert.equal(L.isSleepHour(12), false);
  assert.equal(L.isSleepHour(18.99), false);
  assert.equal(L.sleepBlocker({ hour: 12, sheltered: true, nearFire: 1 }), 'notTired');
  assert.equal(L.sleepBlocker({ hour: 22, sheltered: false, nearFire: 0 }), 'exposed');
  assert.equal(L.sleepBlocker({ hour: 22, sheltered: true, nearFire: 0 }), null);
  assert.equal(L.sleepBlocker({ hour: 2, sheltered: false, nearFire: 0.5 }), null);
  assert.equal(L.sleepBlocker({ hour: 2, sheltered: true, nearFire: 0, cooking: true }), 'cooking');
});

test('cook queue: every COOKABLE item, nothing else', () => {
  const inv = { wild_apple: 2, chestnut: 3, berries: 5, toadstool: 1 };
  const count = (id) => inv[id] || 0;
  const q = L.cookQueue(count, COOKABLE, ITEMS);
  assert.equal(q.total, 5);
  assert.deepEqual(
    q.groups.map((g) => g.from).sort(),
    ['chestnut', 'wild_apple'],
  );
  for (const g of q.groups) assert.equal(g.to, ITEMS[g.from].cooksInto);
  assert.ok(COOKABLE.includes(L.nextCookable(count, COOKABLE, ITEMS)));
  assert.equal(L.nextCookable(() => 0, COOKABLE, ITEMS), null);
  assert.equal(L.cookQueue(() => 0, COOKABLE, ITEMS).total, 0);
});

test('SOS layout: ~8 m wide, 3 letters, readable stone count', () => {
  const pts = L.sosLayout();
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  assert.ok(w > 7 && w < 9, `width ${w}`);
  assert.ok(h > 2.4 && h < 3.4, `height ${h}`);
  assert.ok(pts.length >= 30 && pts.length <= 70, `stones ${pts.length}`);
  for (let l = 0; l < 3; l++) assert.ok(pts.filter((p) => p.letter === l).length >= 8);
  assert.ok(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2) < 0.3, 'centered');
  // no two stones on top of each other
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) > 0.2);
});

test('placement candidates start straight ahead (forward = -sin yaw, -cos yaw)', () => {
  const c = L.placementCandidates(0, 0, 0, 'campfire');
  assert.ok(near(c[0].x, 0) && near(c[0].z, -L.FOOTPRINT.campfire.dist), 'yaw 0 looks north (-Z)');
  const e = L.placementCandidates(10, 5, -Math.PI / 2, 'shelter')[0]; // yaw -90° looks east (+X)
  assert.ok(near(e.x, 10 + L.FOOTPRINT.shelter.dist) && near(e.z, 5));
  assert.ok(c.length >= 10);
});

console.log(`structures.test.mjs: ${passed} tests passed`);
