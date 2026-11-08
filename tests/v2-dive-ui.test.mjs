// v2 (V2-C): diving in the real controller (mock world), tool recipes, HUD pure helpers.
// Run: node tests/v2-dive-ui.test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { ITEMS } from '../src/core/items.js';
import { RECIPE_BY_ID, checkRecipe, lastUseWarning } from '../src/gameplay/recipes.js';
import { TOOL_TEXT, isUsable, create as createInventory } from '../src/gameplay/inventory.js';
import { create as createController } from '../src/player/controller.js';
import { objectiveView, objectiveSig, partsSummary, relBearing, compassPlace, raftWinText, PART_WHERE, RESCUE_METHOD } from '../src/ui/hud-data.js';

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

// ── controller harness: flat seabed `depth` m under a calm ocean at y = 0 ──
function rig({ depth = 8, exhausted = false } = {}) {
  const held = new Set();
  const events = [];
  const stats = { exhausted, values: { energy: exhausted ? 0 : 100 }, dead: false };
  const ctx = {
    state: 'playing',
    flags: {},
    camera: new THREE.PerspectiveCamera(70, 1, 0.1, 1000),
    events: { emit: (n, p) => events.push([n, p]) },
    input: { isDown: (a) => held.has(a), wasPressed: () => false, mouseDX: 0, mouseDY: 0 },
    stats,
    stats_summary: { distanceWalked: 0 },
    ui: { hint() {}, toast() {} },
    world: {
      boundary: 1e6,
      heightAt: () => -depth,
      normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0),
      waterAt: () => ({ surface: 0, depth, type: 'ocean', fresh: false }),
      biomeAt: () => 'ocean',
      landmarks: {},
    },
  };
  ctx.camera.rotation.order = 'YXZ';
  const pl = createController(ctx);
  ctx.player = pl;
  pl.teleport(0, 0, 0);
  const run = (seconds, dt = 1 / 60) => {
    for (let t = 0; t < seconds; t += dt) pl.update(dt);
  };
  return { ctx, pl, held, events, stats, run };
}

const eye = (pl) => pl.position.y + CONFIG.player.eyeHeight;

test('teleport into deep water starts afloat, not diving', () => {
  const { pl, run } = rig();
  run(1);
  assert.equal(pl.swimming, true);
  assert.equal(pl.diving, false);
  assert.equal(pl.headUnderwater, false);
  assert.equal(pl.depth, 0);
});

test('holding X dives at ~1.5 m/s, flags diving + headUnderwater + depth', () => {
  const { pl, held, run } = rig({ depth: 12 });
  run(1);
  const y0 = pl.position.y;
  held.add('dive');
  run(3);
  assert.equal(pl.diving, true);
  assert.equal(pl.headUnderwater, true);
  const sank = y0 - pl.position.y;
  assert.ok(sank > 3 && sank < 4.6, `sank ${sank.toFixed(2)} m in 3 s`);
  assert.ok(Math.abs(pl.depth - -eye(pl)) < 0.05, 'depth = eye below the surface');
  assert.ok(pl.moving, 'a vertical dive counts as moving (swim energy rate)');
});

test('the seabed stops the dive (feet >= ground + 0.35)', () => {
  const { pl, held, run } = rig({ depth: 4 });
  held.add('dive');
  run(8);
  assert.ok(pl.position.y >= -4 + 0.35 - 1e-6, `feet at ${pl.position.y}`);
  assert.ok(pl.position.y < -4 + 0.4);
  assert.equal(pl.headUnderwater, true);
});

test('releasing X floats you up gently, then back to normal swimming', () => {
  const { pl, held, run } = rig({ depth: 12 });
  held.add('dive');
  run(4);
  held.delete('dive');
  let maxUp = 0;
  let prev = pl.position.y;
  for (let i = 0; i < 60 * 4; i++) {
    pl.update(1 / 60);
    maxUp = Math.max(maxUp, (pl.position.y - prev) * 60);
    prev = pl.position.y;
  }
  assert.ok(maxUp < 1.0, `gentle: max rise ${maxUp.toFixed(2)} m/s`);
  run(12);
  assert.equal(pl.diving, false);
  assert.equal(pl.headUnderwater, false);
  assert.equal(pl.swimming, true);
});

test('Space rises faster than floating', () => {
  const a = rig({ depth: 12 }),
    b = rig({ depth: 12 });
  for (const r of [a, b]) {
    r.held.add('dive');
    r.run(4);
    r.held.delete('dive');
  }
  b.held.add('jump');
  a.run(1.5);
  b.run(1.5);
  assert.ok(b.pl.position.y > a.pl.position.y + 0.5);
});

test('X + Space together never lift you out of the water', () => {
  const { pl, held, run } = rig({ depth: 12 });
  held.add('dive');
  held.add('jump');
  run(5);
  assert.ok(eye(pl) < 0.6, `eye ${eye(pl).toFixed(2)}`);
});

test('exhausted: X does nothing and you still sink (existing behaviour)', () => {
  const { pl, held, run } = rig({ depth: 8, exhausted: true });
  held.add('dive');
  run(6);
  assert.equal(pl.diving, false);
  assert.equal(pl.headUnderwater, true, 'sinks below the surface');
  assert.ok(eye(pl) > -1.2, 'a slow sink to ~0.45 m under, not a dive');
});

test('exhausted mid-dive: never lifted, then a gentle float-up once recovered', () => {
  const r = rig({ depth: 12 });
  r.held.add('dive');
  r.run(4);
  const deep = r.pl.position.y;
  r.stats.exhausted = true;
  r.run(2);
  assert.ok(r.pl.position.y <= deep + 0.05, 'exhaustion never lifts you');
  r.stats.exhausted = false;
  r.held.delete('dive');
  let maxUp = 0,
    prev = r.pl.position.y;
  for (let i = 0; i < 120; i++) {
    r.pl.update(1 / 60);
    maxUp = Math.max(maxUp, (r.pl.position.y - prev) * 60);
    prev = r.pl.position.y;
  }
  assert.ok(maxUp < 1.0, `recovering rises gently (${maxUp.toFixed(2)} m/s)`);
});

// ── recipes ──
test('tool recipes exist and give tool items', () => {
  for (const [id, needs] of [
    ['shovel', { wood: 2, stone: 1, rope: 1 }],
    ['pickaxe', { wood: 2, flint: 1, rope: 1 }],
    ['diving_mask', { bamboo: 1, cloth: 1, rope: 1 }],
  ]) {
    const r = RECIPE_BY_ID[id];
    assert.ok(r, id);
    assert.equal(r.gives.id, id);
    assert.equal(ITEMS[id]?.category, 'tool');
    assert.equal(r.section, 'item');
    const got = Object.fromEntries(r.needs.map((n) => [n.id, n.n]));
    assert.deepEqual(got, needs);
    assert.equal(checkRecipe(r, (k) => needs[k] ?? 0).ok, true);
    assert.equal(checkRecipe(r, (k) => (k === 'rope' ? 0 : needs[k] ?? 0)).ok, false);
  }
});

test('pickaxe warns only when it used the last flint', () => {
  const r = RECIPE_BY_ID.pickaxe;
  assert.match(lastUseWarning(r, () => 0), /last flint/);
  assert.equal(lastUseWarning(r, () => 1), null);
  assert.equal(lastUseWarning(RECIPE_BY_ID.shovel, () => 0), null);
});

test('F texts for tools', () => {
  assert.match(TOOL_TEXT.shovel, /disturbed sand mounds.*E to dig/);
  assert.ok(TOOL_TEXT.pickaxe && TOOL_TEXT.diving_mask);
});

test('crafted tools get a hotbar slot even when it is full of materials', () => {
  const inv = createInventory({ events: { emit() {}, on() {} }, flags: {}, state: 'playing', ui: {} });
  for (const id of ['wood', 'stone', 'fiber', 'rope', 'flint', 'pyrite', 'leaves', 'bamboo', 'cloth']) inv.add(id, 2);
  assert.equal(inv.hotbar.filter(Boolean).length, 9);
  inv.add('shovel', 1);
  assert.ok(inv.hotbar.includes('shovel'));
  assert.equal(isUsable('pickaxe'), true);
  assert.equal(isUsable('hull_plank'), false, 'parts stay out of the hotbar race');
});

// ── HUD helpers ──
test('objectiveView: null-safe, stage text, ready, complete', () => {
  assert.equal(objectiveView(null), null);
  assert.equal(objectiveView(undefined), null);
  const v = objectiveView({
    title: 'Driftwood Raft',
    stageIndex: 0,
    stageCount: 4,
    stageLabel: 'Lash the hull together',
    needs: [
      { id: 'wood', have: 12, need: 10 },
      { id: 'hull_plank', have: 1, need: 3 },
    ],
    ready: false,
    hint: 'Planks wash up on the beaches.',
  });
  assert.equal(v.stage, 'Stage 1/4: Lash the hull together');
  assert.equal(v.needs[0].ok, true);
  assert.equal(v.needs[1].ok, false);
  assert.equal(v.needs[1].icon, ITEMS.hull_plank.icon);
  assert.equal(v.ready, false);
  assert.equal(objectiveView({ stageCount: 2, stageIndex: 0, needs: [{ id: 'wood', have: 1, need: 1 }] }).ready, true, 'fallback from needs');
  const c = objectiveView({ stageCount: 4, stageIndex: 4, complete: true, needs: [{ id: 'wood', have: 0, need: 1 }] });
  assert.equal(c.complete, true);
  assert.equal(c.needs.length, 0);
  assert.equal(c.ready, false);
  assert.notEqual(objectiveSig(v), objectiveSig(objectiveView({ ...v, stageCount: 4, stageIndex: 0, needs: [{ id: 'wood', have: 13, need: 10 }] })));
  assert.equal(objectiveSig(null), '');
});

test('partsSummary groups by id with found counts', () => {
  const rows = partsSummary([
    { id: 'hull_plank', where: 'beach', found: true },
    { id: 'hull_plank', where: 'beach', found: false },
    { id: 'rudder', where: 'buried', found: false },
    null,
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].found, rows[0].total], [1, 2]);
  assert.equal(rows[1].hint, PART_WHERE.buried.hint);
  assert.deepEqual(partsSummary(undefined), []);
});

test('compass bearing + edge clamping', () => {
  assert.equal(relBearing(0, 0, -10), 0); // north, facing north
  assert.equal(relBearing(0, 10, 0), 90); // east
  assert.equal(relBearing(90, 0, -10), -90);
  assert.ok(Math.abs(relBearing(350, 0, -1) - 10) < 1e-9);
  assert.deepEqual(compassPlace(0, 520, 3, 100), { x: 260, edge: 0 });
  assert.equal(compassPlace(170, 520, 3, 100).edge, 1);
  assert.equal(compassPlace(-170, 520, 3, 100).x, 100);
});

test('raft win text', () => {
  assert.equal(raftWinText('Driftwood Raft'), 'You sailed home on your own Driftwood Raft!');
  assert.ok(RESCUE_METHOD.raft);
});

if (!process.exitCode) console.log(`✓ v2-dive-ui: ${passed} tests passed`);
