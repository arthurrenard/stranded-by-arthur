// V3-B (Tempest Isle content) tests: pure logic + a create/init/update smoke run of src/isle2/isle2.js with a fake ctx (no WebGL).
// Run: node tests/isle2.test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import * as G from '../src/isle2/isle2-logic.js';
import { makeCtx } from './flora-smoke.mjs';
import { create } from '../src/isle2/isle2.js';
import { placeParts } from '../src/gameplay/raft-parts.js';
import { partList } from '../src/gameplay/raft-logic.js';
import { createRng } from '../src/core/rng.js';

const RC = CONFIG.raft;
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// ── hut contents per difficulty ─────────────────────────────────────────
for (const id of ['easy', 'medium', 'hard']) {
  const plan = CONFIG.difficulty.presets[id].plan;
  const c = G.hutContents(RC, plan);
  const get = (k) => c.find((e) => e.id === k)?.n || 0;
  assert.equal(get('fishing_rod'), 2, `${id}: two rods`);
  assert.equal(get('boat_key'), 1, `${id}: the key`);
  assert.equal(get('fuel_can'), 1, `${id}: a fuel can`);
  for (const pid in RC.parts) {
    const want = RC.parts[pid].where === 'isle2hut' ? RC.parts[pid].count[plan] || 0 : 0;
    if (pid === 'fuel_can') continue; // the hut always has one jerrycan
    assert.equal(get(pid), want, `${id}: ${pid} x${want}`);
  }
  assert.equal(G.hutParts(RC, plan).length, id === 'easy' ? 0 : 1, `${id}: hut parts (compass on medium/hard)`);
}
assert.ok(G.hutContents(RC, 'sailboat').some((e) => e.id === 'compass'), 'compass in the hut on medium');
assert.ok(!G.hutContents(RC, 'raft').some((e) => e.id === 'compass'), 'no compass on easy');

// ── fishing loot ─────────────────────────────────────────────────────────
const sum = G.FISHING_LOOT.reduce((a, e) => a + e.p, 0);
assert.ok(near(sum, 1, 1e-9), `fishing loot sums to 1 (${sum})`);
assert.ok(near(G.FISHING_LOOT.find((e) => e.id === 'old_boot').p, 0.3), 'old boot 30 %');
assert.ok(near(G.FISHING_LOOT.find((e) => e.id === 'hull_plank').p, 0.08), 'hull plank 8 %');
for (const e of G.FISHING_LOOT) assert.ok(e.id === 'message' || CONFIG && e.id, 'loot id');
assert.equal(G.rollCatch(0).id, 'old_boot');
assert.equal(G.rollCatch(0.2999).id, 'old_boot');
assert.equal(G.rollCatch(0.9999).id, 'message');
{
  const hist = {};
  const rnd = createRng(42);
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const e = G.rollCatch(rnd());
    hist[e.id] = (hist[e.id] || 0) + 1;
  }
  for (const e of G.FISHING_LOOT) assert.ok(Math.abs(hist[e.id] / N - e.p) < 0.015, `${e.id} frequency`);
}
for (const r of [0, 0.5, 0.999]) {
  const d = G.biteDelay(r);
  assert.ok(d >= 4 && d <= 12, 'bite in 4-12 s');
}

// ── rockfall timing ───────────────────────────────────────────────────────
for (let i = 0; i <= 20; i++) {
  const r = i / 20;
  const calm = G.nextRockfallDelay(r, 0);
  const storm = G.nextRockfallDelay(r, 1);
  assert.ok(calm >= 20 && calm <= 60, `calm delay ${calm}`);
  assert.ok(storm >= 10 && storm <= 30, `storm delay ${storm}`);
  assert.ok(storm < calm, 'storms bring more rockfalls');
  const dmg = G.rockDamage(r);
  assert.ok(dmg >= 15 && dmg <= 25, 'hit damage 15-25');
}
assert.ok(G.nextRockfallDelay(2, 5) >= 10, 'clamped');

// ── hut frame + burn curve ───────────────────────────────────────────────
{
  const hut = { x: 10, z: -4, fx: Math.cos(0.7), fz: Math.sin(0.7) };
  const p = G.hutWorld(hut, 1.2, -0.8);
  const l = G.hutLocal(hut, p.x, p.z);
  assert.ok(near(l.u, 1.2, 1e-9) && near(l.v, -0.8, 1e-9), 'hut frame round trip');
  assert.ok(G.insideHut(hut, hut.x, hut.z), 'center inside');
  const out = G.hutWorld(hut, G.HUT.D / 2 + 0.4, 0);
  assert.ok(!G.insideHut(hut, out.x, out.z), 'outside the front wall');
  assert.equal(G.canSleepAt(20), true);
  assert.equal(G.canSleepAt(3), true);
  assert.equal(G.canSleepAt(12), false);
  assert.equal(G.burnIntensity(0), 0);
  assert.equal(G.burnIntensity(30), 1);
  assert.equal(G.burnIntensity(G.BURN.seconds + 1), 0);
  assert.equal(G.logbookPages(true).length, 4);
}

// ── raft-parts: hut parts are never placed in the world ──────────────────
{
  const W = makeCtx().ctx.world;
  for (const plan of ['raft', 'sailboat', 'motorboat']) {
    const list = partList(RC, plan);
    const out = placeParts(W, createRng(CONFIG.seed).fork('raft'), list, {});
    assert.ok(!out.some((p) => p.where === 'isle2hut'), `${plan}: no isle2hut part in the world`);
    assert.equal(out.length, list.filter((p) => p.where !== 'isle2hut').length, `${plan}: everything else placed`);
  }
}

// ── create/init/update smoke run with a fake ctx ───────────────────────────
{
  const { ctx, registered, log } = makeCtx();
  const W = ctx.world;
  const L = W.landmarks;
  ctx.difficulty = { id: 'medium', ...CONFIG.difficulty.presets.medium };
  const invCounts = {};
  ctx.inventory = {
    add(id, n = 1) { invCounts[id] = (invCounts[id] || 0) + n; log.inv.push({ id, n }); return n; },
    remove(id, n = 1) { if ((invCounts[id] || 0) < n) return false; invCounts[id] -= n; return true; },
    count: (id) => invCounts[id] || 0,
    has: (id, n = 1) => (invCounts[id] || 0) >= n,
  };
  const providers = [];
  ctx.interact.addProvider = (fn) => (providers.push(fn), () => {});
  ctx.ui.subtitle = (t) => log.toast.push(t);
  ctx.input = { wasPressed: () => false, isDown: () => false };
  ctx.time.hoursUntil = (h) => ((h - (ctx.time.hour % 24)) + 24) % 24;
  let slept = 0;
  ctx.stats.sleep = (h) => (slept = h);
  ctx.resources = { spawnItem: (id, x, z, n, opts) => ({ id, x, z, n, opts }) };
  const api = create(ctx);
  ctx.isle2 = api;
  api.init();
  for (let i = 0; i < 30; i++) api.update(1 / 30);

  // dock colliders: walkable deck
  const D = L.isle2Dock;
  const end = { x: D.x + D.dirX * 17, z: D.z + D.dirZ * 17 };
  const pos = new THREE.Vector3(end.x, 0.95, end.z);
  const top = ctx.colliders.resolve(pos, 0.35, 0.95 + 0.4, 0.95 + 1.8);
  assert.ok(top > 0.6 && top < 1.3, `standing on the dock end (top ${top})`);
  // stepping from the beach onto the deck where it meets the sand
  let steppable = false;
  for (let t = 0; t <= 4; t += 0.25) {
    const x = D.x + D.dirX * t, z = D.z + D.dirZ * t;
    const gy = W.heightAt(x, z);
    const p = new THREE.Vector3(x, gy, z);
    const tp = ctx.colliders.resolve(p, 0.35, gy + 0.4, gy + 1.8);
    if (tp > gy && tp - gy <= 0.45) steppable = true;
  }
  assert.ok(steppable, 'the beach end of the dock can be stepped onto');

  // motorboat
  const mb = api.motorboat;
  assert.ok(mb && mb.object && mb.position && mb.moored === true, 'motorboat moored');
  assert.ok(mb.position === mb.object.position, 'position is the object position');
  const w = W.waterAt(mb.position.x, mb.position.z);
  assert.ok(w && w.type === 'ocean' && w.depth > 1, 'the boat floats in the sea');
  assert.ok(Number.isFinite(mb.heading), 'heading');
  const fx = -Math.sin(mb.heading), fz = -Math.cos(mb.heading);
  assert.ok(fx * D.dirX + fz * D.dirZ > 0.9, 'bow points out to sea');

  // hut: shelter, indoors, hearth
  const H = L.isle2Hut;
  assert.ok([...ctx.shelters].some((s) => s.indoor && Math.hypot(s.position.x - H.x, s.position.z - H.z) < 2), 'hut shelter registered');
  assert.equal(api.isIndoors(new THREE.Vector3(H.x, H.y + 0.2, H.z)), true, 'hut center is indoors');
  assert.equal(api.isIndoors(new THREE.Vector3(H.x + 20, H.y, H.z)), false, 'outside is not indoors');
  assert.equal(api.isIndoors(new THREE.Vector3(D.x, 1, D.z)), false, 'the dock is outdoors');
  assert.ok(api.hut.hearthPos && api.isIndoors(api.hut.hearthPos), 'the hearth fire is indoors (storms never douse it)');

  // parts in the hut: compass on medium, not taken
  assert.deepEqual(api.partsInHut(), [{ id: 'compass', taken: false }]);
  ctx.difficulty = { id: 'easy', ...CONFIG.difficulty.presets.easy };
  assert.deepEqual(api.partsInHut(), [], 'easy: no hut parts (read lazily)');
  ctx.difficulty = { id: 'medium', ...CONFIG.difficulty.presets.medium };

  // search the shelves
  const search = registered.find((h) => /Search the shelves/.test(typeof h.label === 'function' ? h.label(ctx, h) : h.label));
  assert.ok(search, 'search entry');
  search.onUse(ctx, search);
  assert.equal(invCounts.fishing_rod, 2);
  assert.equal(invCounts.boat_key, 1);
  assert.equal(invCounts.fuel_can, 1);
  assert.equal(invCounts.compass, 1);
  assert.deepEqual(api.partsInHut(), [{ id: 'compass', taken: true }]);
  assert.equal(search.enabled(ctx, search), false, 'search once');

  // hearth
  const hearth = registered.find((h) => /hearth/i.test(typeof h.label === 'function' ? h.label(ctx, h) : h.label || ''));
  assert.ok(hearth, 'hearth entry');
  invCounts.flint = 1; invCounts.pyrite = 1; invCounts.wood = 2;
  hearth.onUse(ctx, hearth);
  const hs = [...ctx.heatSources].find((h) => h.kind === 'hearth');
  assert.ok(hs && hs.indoor === true, 'hearth heat source (indoor)');
  assert.equal(invCounts.wood, 1, 'one wood used');

  // logbook + bunk
  const book = registered.find((h) => /logbook/i.test(typeof h.label === 'function' ? h.label(ctx, h) : h.label || ''));
  assert.ok(book, 'logbook entry');
  book.onUse(ctx, book);
  assert.ok(log.toast.some((t) => /Tempest Isle/.test(t)), 'logbook page 1');
  ctx.time.jump(20 - ctx.time.hour); // 20:00
  const bunk = registered.find((h) => /bunk/i.test(typeof h.label === 'function' ? h.label(ctx, h) : h.label || ''));
  bunk.onUse(ctx, bunk);
  assert.ok(slept > 9 && slept < 11.5, `sleeps until 06:30 (${slept})`);

  // fishing provider on the dock
  invCounts.fishing_rod = 2;
  ctx.player.position.set(end.x, 0.95, end.z);
  ctx.camera.position.set(end.x, 0.95 + 1.7, end.z);
  ctx.camera.lookAt(end.x + D.dirX * 6, -0.2, end.z + D.dirZ * 6);
  ctx.camera.updateMatrixWorld(true);
  const cands = providers.map((p) => p(ctx)).filter(Boolean);
  const fish = cands.find((c) => /Cast the line/.test(c.label || c.secondary?.label || ''));
  assert.ok(fish, 'cast the line from the dock');

  // set the hut on fire: needs two R presses
  invCounts.flint = 1; invCounts.pyrite = 1;
  const door = registered.find((h) => h.secondary && /fire/i.test(typeof h.secondary.label === 'function' ? h.secondary.label(ctx, h) : h.secondary.label));
  assert.ok(door, 'door fire entry');
  assert.ok(door.enabled(ctx, door), 'fire entry enabled with flint + pyrite');
  door.secondary.onUse(ctx, door);
  assert.equal(api.hut.state, 'intact', 'first R only asks');
  door.secondary.onUse(ctx, door);
  assert.equal(api.hut.state, 'burning', 'second R lights it');
  ctx.player.position.set(H.x, H.y + 0.1, H.z);
  for (let i = 0; i < 40; i++) api.update(0.05);
  assert.ok(log.damage.some((d) => d.cause === 'fire'), 'standing inside the burning hut hurts');
  ctx.player.position.set(H.x + 40, H.y, H.z);
  for (let i = 0; i < (G.BURN.seconds + 3) * 4; i++) api.update(0.25);
  assert.equal(api.hut.state, 'ruins', 'burnt down');
  assert.equal([...ctx.shelters].some((s) => s.indoor), false, 'shelter gone');
  assert.equal(api.isIndoors(new THREE.Vector3(H.x, H.y + 0.2, H.z)), false, 'no indoors in the ruins');
  assert.equal([...ctx.heatSources].some((h) => h.kind === 'hearth'), false, 'hearth gone');
  assert.equal(bunk.enabled(ctx, bunk), false, 'bunk gone');
}

// ── burning before searching drops everything outside (never loses the key or the compass) ──
{
  const { ctx, registered } = makeCtx();
  ctx.difficulty = { id: 'hard', ...CONFIG.difficulty.presets.hard };
  const invCounts = { flint: 1, pyrite: 1 };
  ctx.inventory = {
    add(id, n = 1) { invCounts[id] = (invCounts[id] || 0) + n; return n; },
    remove(id, n = 1) { if ((invCounts[id] || 0) < n) return false; invCounts[id] -= n; return true; },
    count: (id) => invCounts[id] || 0,
    has: (id, n = 1) => (invCounts[id] || 0) >= n,
  };
  ctx.input = { wasPressed: () => false, isDown: () => false };
  const drops = [];
  ctx.resources = { spawnItem: (id, x, z, n, opts) => { const d = { id, x, z, n, opts }; drops.push(d); return d; } };
  const api = create(ctx);
  ctx.isle2 = api;
  api.init();
  const door = registered.find((h) => h.secondary && /fire/i.test(typeof h.secondary.label === 'function' ? h.secondary.label(ctx, h) : h.secondary.label));
  door.secondary.onUse(ctx, door);
  door.secondary.onUse(ctx, door);
  ctx.player.position.set(0, 0, 0);
  for (let i = 0; i < (G.BURN.seconds + 3) * 4; i++) api.update(0.25);
  const ids = drops.map((d) => d.id);
  for (const id of ['boat_key', 'compass', 'fishing_rod', 'fuel_can']) assert.ok(ids.includes(id), `${id} dropped outside`);
  for (const d of drops) {
    assert.ok(d.opts?.keep, `${d.id} drop is kept`);
    assert.ok(!api.isIndoors({ x: d.x, y: ctx.world.landmarks.isle2Hut.y, z: d.z }), `${d.id} outside the ruins`);
  }
  const compassDrop = drops.find((d) => d.id === 'compass');
  compassDrop.opts.onPick?.(1);
  assert.deepEqual(api.partsInHut(), [{ id: 'compass', taken: true }], 'picking the dropped compass marks it taken');
}

console.log('isle2 tests passed');
