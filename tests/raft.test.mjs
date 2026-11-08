// Unit tests for the boat-repair goal (Builder V2-B). Run: node tests/raft.test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { ITEMS } from '../src/core/items.js';
import { createEvents } from '../src/core/events.js';
import { createRng } from '../src/core/rng.js';
import { createHeightfield } from '../src/world/heightfield.js';
import * as L from '../src/gameplay/raft-logic.js';
import * as P from '../src/gameplay/raft-parts.js';
import { BOAT_SPECS, makeBoat } from '../src/gameplay/raft-meshes.js';
import { create as createRaft } from '../src/gameplay/raft.js';

let passed = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => passed++, (e) => { console.error('FAIL', name); throw e; }));
      return;
    }
    passed++;
  } catch (e) {
    console.error('FAIL', name);
    throw e;
  }
}

const RC = CONFIG.raft;
const PLAN_IDS = Object.keys(RC.plans);

test('every difficulty names an existing plan', () => {
  for (const id in CONFIG.difficulty.presets) {
    const d = CONFIG.difficulty.presets[id];
    assert.ok(RC.plans[d.plan], `difficulty ${id} -> plan ${d.plan}`);
    assert.equal(L.planIdFor(d, RC), d.plan);
  }
  assert.equal(L.planIdFor({ plan: 'nope' }, RC), 'raft');
  assert.equal(L.planIdFor(undefined, RC), 'raft');
});

test('resolvePlan attaches the id and is memoized', () => {
  for (const id of PLAN_IDS) {
    const p = L.resolvePlan(RC, id);
    assert.equal(p.id, id);
    assert.equal(p.name, RC.plans[id].name);
    assert.equal(L.resolvePlan(RC, id), p);
  }
});

test('every needs id and part id exists in ITEMS', () => {
  for (const id of PLAN_IDS) {
    for (const st of RC.plans[id].stages) {
      for (const need in st.needs) assert.ok(ITEMS[need], `${id}/${st.id} needs unknown item ${need}`);
      assert.ok(st.hours > 0 && st.label && st.id);
    }
  }
  for (const id in RC.parts) assert.ok(ITEMS[id], `part ${id}`);
});

test('stage ids map to boat visuals and plans grow with difficulty', () => {
  let prev = 0;
  for (const id of ['raft', 'sailboat', 'motorboat']) {
    const b = makeBoat(id);
    for (const st of RC.plans[id].stages) assert.ok(b.parts[st.id], `${id} has a visual for stage ${st.id}`);
    for (const k in b.parts) assert.equal(b.parts[k].visible, false);
    const hours = RC.plans[id].stages.reduce((a, s) => a + s.hours, 0);
    assert.ok(hours > prev, `${id} takes longer than the easier plan`);
    prev = hours;
    assert.ok(BOAT_SPECS[id]);
  }
});

test('world part counts cover every plan’s needs (no soft lock)', () => {
  for (const id of PLAN_IDS) {
    const need = L.remainingNeeds(RC.plans[id], 0);
    const placed = L.partCounts(RC, id);
    for (const part in RC.parts) {
      if (need[part]) assert.ok((placed[part] || 0) >= need[part], `${id}: ${part} placed ${placed[part] || 0} < need ${need[part]}`);
    }
    // sailcloth: crate1 holds 2, plus the bundles on beaches; the diving mask also takes 1
    const clothSupply = 2 + (RC.extraSailcloth[id] || 0);
    const usesMask = RC.plans[id].stages.some((s) => Object.keys(s.needs).some((n) => RC.parts[n]?.where === 'underwater'));
    assert.ok(clothSupply >= (need.cloth || 0) + (usesMask ? 1 : 0), `${id}: cloth supply ${clothSupply}`);
  }
});

test('needs status, readiness and consumption', () => {
  const st = RC.plans.raft.stages[0];
  const inv = new Map([['wood', 12], ['rope', 1], ['hull_plank', 3]]);
  const count = (id) => inv.get(id) || 0;
  const remove = (id, n) => {
    inv.set(id, count(id) - n);
    return true;
  };
  const s = L.needsStatus(st, count);
  assert.deepEqual(s.map((x) => x.id), Object.keys(st.needs));
  assert.equal(L.isReady(s), false);
  assert.deepEqual(L.missingOf(s).map((x) => x.id), ['rope']);
  assert.match(L.missingText(s, (id) => ITEMS[id].name), /Rope 1\/2/);
  assert.equal(L.consumeStage(st, count, remove), false);
  assert.equal(count('wood'), 12, 'nothing consumed when short');
  inv.set('rope', 2);
  assert.equal(L.consumeStage(st, count, remove), true);
  assert.equal(count('wood'), 2);
  assert.equal(count('rope'), 0);
  assert.equal(count('hull_plank'), 0);
});

test('remaining needs sum from the current stage', () => {
  const p = RC.plans.sailboat;
  const all = L.remainingNeeds(p, 0);
  const rest = L.remainingNeeds(p, 1);
  assert.equal(all.wood, p.stages.reduce((a, s) => a + (s.needs.wood || 0), 0));
  assert.equal(rest.hull_plank, undefined);
  assert.deepEqual(L.remainingNeeds(p, p.stages.length), {});
});

test('work hours, drains and hints', () => {
  assert.equal(L.isWorkHour(4.99), false);
  assert.equal(L.isWorkHour(5), true);
  assert.equal(L.isWorkHour(19.99), true);
  assert.equal(L.isWorkHour(20), false);
  assert.equal(L.fmtHours(0.75), '45 min');
  assert.equal(L.fmtHours(1.5), '1.5 h');
  const d = L.buildDrain(2, CONFIG.stats, CONFIG.difficulty.presets.medium);
  assert.ok(Math.abs(d.thirst + 2 * CONFIG.stats.thirstPerHour * CONFIG.difficulty.presets.medium.thirstMul * 1.5) < 1e-9);
  assert.ok(Math.abs(d.hunger + 2 * CONFIG.stats.hungerPerHour * CONFIG.difficulty.presets.medium.hungerMul * 1.5) < 1e-9);
  assert.equal(d.energy, -24);
  assert.match(L.hintFor('rudder', { where: 'buried' }), /shovel/);
  assert.match(L.hintFor('spark_plug', { where: 'rock' }), /pickaxe/);
  assert.match(L.hintFor('engine_block', { where: 'underwater' }), /dive with X/);
  assert.match(L.hintFor('rope', {}), /4 plant fiber/);
  for (const id of PLAN_IDS) {
    for (const need in L.remainingNeeds(RC.plans[id], 0)) {
      assert.notEqual(L.hintFor(need, { where: RC.parts[need]?.where }), 'Search the island', `hint for ${need}`);
    }
  }
});

// ── placement on the real island ───────────────────────────────────────────
const W = createHeightfield();
const LM = W.landmarks;
const site = P.findSite(W);

test('boatyard is dry flat sand 6–10 m seaward of the spawn', () => {
  const d = Math.hypot(site.x - LM.spawn.x, site.z - LM.spawn.z);
  assert.ok(d >= 5.5 && d <= 11.5, `site ${d.toFixed(1)} m from spawn`);
  assert.equal(W.waterAt(site.x, site.z), null);
  assert.ok(W.slopeAt(site.x, site.z) < 0.2);
  assert.ok(Math.hypot(site.x, site.z) > Math.hypot(LM.spawn.x, LM.spawn.z), 'seaward');
});

test('launch route clears land and the wreck', () => {
  const turn = P.findLaunchTurn(W, site, LM.wreck);
  const path = P.buildPath(site, turn, new Float32Array(3 * 400));
  const o = {};
  for (let s = 30; s < 190; s += 2) {
    P.pathAt(path, s, o);
    assert.ok(W.heightAt(o.x, o.z) < 0, `route on land at s=${s}`);
    assert.ok(Math.hypot(o.x - LM.wreck.x, o.z - LM.wreck.z) > 18, `route hits the wreck at s=${s}`);
  }
});

test('parts are placed per plan, spread out and in the right places', () => {
  for (const id of PLAN_IDS) {
    const list = L.partList(RC, id);
    const out = P.placeParts(W, createRng(CONFIG.seed).fork('raft'), list, {
      avoid: [{ x: site.x, z: site.z, r: 10 }, { x: LM.castawayCamp.x, z: LM.castawayCamp.z, r: 9, tag: 'camp' }],
    });
    assert.equal(out.length, list.length, `${id}: all parts placed`);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        assert.ok(Math.hypot(out[i].x - out[j].x, out[i].z - out[j].z) >= 6, `${id}: parts ${i}/${j} too close`);
      }
      const p = out[i];
      if (p.where === 'beach') assert.ok(P.isBeachSpot(W, p.x, p.z), `${id}: ${p.id} on dry sand`);
      if (p.where === 'underwater') {
        const w = W.waterAt(p.x, p.z);
        assert.ok(w && w.type === 'ocean' && w.depth >= 3 && w.depth <= 8, `${id}: ${p.id} 3–8 m deep`);
        assert.ok(Math.hypot(p.x - LM.wreck.x, p.z - LM.wreck.z) <= 46);
      }
      if (p.where !== 'underwater') assert.equal(W.waterAt(p.x, p.z), null, `${id}: ${p.id} not in water`);
      assert.ok(Math.hypot(p.x - site.x, p.z - site.z) >= 10, 'clear of the boatyard');
    }
    const planks = out.filter((p) => p.id === 'hull_plank');
    const nearSpawn = planks.filter((p) => Math.hypot(p.x - LM.spawn.x, p.z - LM.spawn.z) <= 80);
    assert.equal(nearSpawn.length, 1, `${id}: exactly one hull plank near the spawn`);
    const compass = out.find((p) => p.id === 'compass');
    if (compass) assert.ok(Math.hypot(compass.x - LM.castawayCamp.x, compass.z - LM.castawayCamp.z) < 12, 'compass by the camp');
    // deterministic
    const again = P.placeParts(W, createRng(CONFIG.seed).fork('raft'), list, {
      avoid: [{ x: site.x, z: site.z, r: 10 }, { x: LM.castawayCamp.x, z: LM.castawayCamp.z, r: 9, tag: 'camp' }],
    });
    assert.deepEqual(again, out);
  }
});

test('a crowded world (hostile colliders) still places every part', () => {
  const blocked = (x, z) => ((Math.floor(x * 7 + z * 13) % 10) + 10) % 10 < 8;
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const id of PLAN_IDS) {
      const list = L.partList(RC, id);
      const out = P.placeParts(W, createRng(7).fork('raft'), list, {
        avoid: [{ x: site.x, z: site.z, r: 10 }, { x: LM.castawayCamp.x, z: LM.castawayCamp.z, r: 9, tag: 'camp' }],
        blocked,
      });
      assert.equal(out.length, list.length, `${id}: all parts placed despite colliders`);
      for (const e of list) assert.ok(out.some((p) => p.id === e.id && p.where === e.where), `${id}: ${e.id}`);
      const near = out.filter((p) => p.id === 'hull_plank' && Math.hypot(p.x - LM.spawn.x, p.z - LM.spawn.z) <= 80);
      assert.equal(near.length, 1, `${id}: one plank near the spawn`);
    }
    // everything blocked: the colliders are ignored, never a soft lock
    const all = L.partList(RC, 'motorboat');
    const out = P.placeParts(W, createRng(3).fork('raft'), all, { blocked: () => true });
    assert.equal(out.length, all.length);
  } finally {
    console.warn = warn;
  }
});

test('other seeds keep exactly one plank near the spawn', () => {
  for (const seed of [1, 2, 3, 99, 12345]) {
    for (const id of PLAN_IDS) {
      const out = P.placeParts(W, createRng(seed).fork('raft'), L.partList(RC, id), { avoid: [{ x: site.x, z: site.z, r: 10 }] });
      const near = out.filter((p) => p.id === 'hull_plank' && Math.hypot(p.x - LM.spawn.x, p.z - LM.spawn.z) <= 80);
      assert.equal(near.length, 1, `seed ${seed} ${id}`);
      assert.equal(out.length, L.partList(RC, id).length);
    }
  }
});

// ── end to end with a mocked ctx ───────────────────────────────────────────
function mockCtx(difficultyId) {
  const events = createEvents();
  const inv = new Map();
  const registered = [];
  const ctx = {
    THREE,
    config: CONFIG,
    items: ITEMS,
    events,
    rng: createRng(CONFIG.seed),
    world: W,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    state: 'title',
    flags: { cinematic: false },
    difficulty: { id: difficultyId, ...CONFIG.difficulty.presets[difficultyId] },
    time: {
      hour: 9,
      day: 1,
      skipHours(h) {
        this.hour = (this.hour + h) % 24;
      },
    },
    stats: {
      dead: false,
      values: { thirst: 100, hunger: 100, energy: 100 },
      applyEffects(e) {
        for (const k in e) this.values[k] = Math.max(0, (this.values[k] ?? 0) + e[k]);
      },
    },
    inventory: {
      count: (id) => inv.get(id) || 0,
      has: (id, n = 1) => (inv.get(id) || 0) >= n,
      add(id, n = 1) {
        inv.set(id, (inv.get(id) || 0) + n);
        events.emit('item:added', { id, n });
        return n;
      },
      remove(id, n = 1) {
        if ((inv.get(id) || 0) < n) return false;
        inv.set(id, inv.get(id) - n);
        events.emit('item:removed', { id, n });
        return true;
      },
    },
    interact: { register: (d) => (registered.push(d), Object.assign(d, { remove() { d.removed = true; } })) },
    colliders: { add: (c) => c, remove() {}, query: () => [] },
    fade: () => Promise.resolve(),
    letterbox() {},
    input: { wasPressed: () => false },
    ui: { toast() {}, hint() {}, subtitle() {}, markJournal() {} },
  };
  return { ctx, inv, registered };
}

test('end to end: hard plan from parts to sailing home', async () => {
  const { ctx, inv, registered } = mockCtx('easy');
  const raft = createRaft(ctx);
  raft.init();
  assert.equal(raft.planId, 'raft');
  // the title screen changes the difficulty before the game starts
  ctx.difficulty = { id: 'hard', ...CONFIG.difficulty.presets.hard };
  ctx.events.emit('difficulty:set', ctx.difficulty);
  assert.equal(raft.planId, 'motorboat');
  assert.equal(raft.objective().title, RC.plans.motorboat.name);
  ctx.state = 'playing';
  ctx.events.emit('game:start', {});
  ctx.events.emit('game:start', {});
  const parts = raft.parts();
  assert.equal(parts.length, L.partList(RC, 'motorboat').length, 'spawned once');
  const events = [];
  for (const n of ['raft:part', 'raft:stage', 'raft:complete', 'raft:sailed']) ctx.events.on(n, (p) => events.push([n, p]));

  // beach pickup
  const beachRec = registered.find((r) => typeof r.label === 'string' && r.label.startsWith('Pick up'));
  beachRec.onUse(ctx, beachRec);
  assert.equal(inv.get('hull_plank'), 1);
  assert.equal(events[0][0], 'raft:part');
  // buried part needs a shovel
  const dig = registered.find((r) => typeof r.label === 'function' && /Dig/.test(r.label()));
  assert.match(dig.label(), /needs a shovel/);
  dig.onUse();
  raft.update(2);
  assert.equal(parts.filter((p) => p.where === 'buried' && p.found).length, 0);
  inv.set('shovel', 1);
  assert.equal(dig.label(), 'Dig here');
  dig.onUse();
  for (let i = 0; i < 30; i++) raft.update(0.05);
  assert.equal(parts.filter((p) => p.where === 'buried' && p.found).length, 1, 'dug up');

  // objective names the first missing item with a hint
  const o = raft.objective();
  assert.equal(o.stageIndex, 0);
  assert.equal(o.ready, false);
  assert.ok(o.hint.length > 5);
  const yard = registered.find((r) => r.label && r.secondary);
  assert.equal(yard.label(), 'What’s needed?');

  // night blocks building
  raft.debugGiveAll();
  assert.equal(raft.objective().ready, true);
  ctx.time.hour = 22;
  await yard.onUse();
  assert.equal(raft.stageIndex, 0);
  ctx.time.hour = 6;
  const stages = RC.plans.motorboat.stages;
  for (let i = 0; i < stages.length; i++) {
    ctx.time.hour = 6;
    ctx.stats.values.thirst = ctx.stats.values.hunger = 100;
    assert.match(yard.label(), /^Build: /);
    await yard.onUse();
    assert.equal(raft.stageIndex, i + 1, `built stage ${stages[i].id}`);
  }
  assert.equal(raft.complete, true);
  assert.ok(events.some((e) => e[0] === 'raft:complete'));
  assert.equal(events.filter((e) => e[0] === 'raft:stage').length, stages.length);
  assert.equal(inv.get('engine_block') || 0, 0, 'parts consumed');
  assert.equal(raft.objective().complete, true);

  // launch: ~12 s cinematic then raft:sailed
  ctx.time.hour = 10;
  assert.match(yard.label(), /^Launch the /);
  yard.onUse();
  assert.equal(ctx.flags.cinematic, true);
  for (let i = 0; i < 300 && !events.some((e) => e[0] === 'raft:sailed'); i++) {
    raft.update(1 / 20);
    await new Promise((r) => setImmediate(r));
  }
  const sailed = events.find((e) => e[0] === 'raft:sailed');
  assert.ok(sailed, 'sailed');
  assert.equal(sailed[1].plan, 'motorboat');
  assert.equal(sailed[1].day, 1);
  assert.ok(Math.hypot(ctx.camera.position.x - raft.site.x, ctx.camera.position.z - raft.site.z) > 40, 'sailed away from the beach');
});

test('easy plan: refuses work when parched, then completes', async () => {
  const { ctx, registered } = mockCtx('easy');
  const raft = createRaft(ctx);
  raft.init();
  ctx.state = 'playing';
  ctx.events.emit('game:start', {});
  assert.equal(raft.plan.id, 'raft');
  assert.equal(raft.plan.stages[0].id, 'hull');
  raft.debugGiveAll();
  assert.equal(raft.objective().ready, true);
  const yard = registered.find((r) => r.label && r.secondary);
  ctx.stats.values.thirst = 3;
  await yard.onUse();
  assert.equal(raft.stageIndex, 0, 'too thirsty to build');
  assert.equal(ctx.inventory.count('hull_plank') >= 3, true, 'nothing consumed');
  ctx.stats.values.thirst = 100;
  await yard.onUse();
  assert.equal(raft.stageIndex, 1);
  assert.ok(ctx.stats.values.thirst < 100, 'work drains thirst');
  raft.debugComplete();
  assert.equal(raft.complete, true);
  assert.equal(raft.objective().complete, true);
});

await Promise.all(pending);
console.log(`raft: ${passed} tests passed`);
