// v5 (V5-A): inventory slot model (pure helpers + the live inventory API) and the drop flow.
// Run: node tests/inventory-ui.test.mjs
import assert from 'node:assert/strict';
import {
  HOT,
  PACK,
  STACK,
  stackLimit,
  newSlots,
  slotTotal,
  roomFor,
  addTo,
  removeFrom,
  moveSlot,
  takeFrom,
  refillHot,
  create as createInventory,
} from '../src/gameplay/inventory.js';
import { slotTooltip, PACK_HELP } from '../src/ui/hud-data.js';
import { create as createResources } from '../src/nature/resources.js';

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

const ids = (S) => S.map((s) => (s ? `${s.id}:${s.n}` : null));

test('stack limits: tools one per slot, materials and parts stack', () => {
  assert.equal(stackLimit('shovel'), 1);
  assert.equal(stackLimit('fishing_rod'), 1);
  assert.equal(stackLimit('wood'), STACK);
  assert.equal(stackLimit('flint'), STACK, 'flint is a "tool" category but is gathered in numbers');
  assert.equal(stackLimit('hull_plank'), STACK);
});

test('addTo fills existing stacks, then the hotbar, extra stacks go to the backpack', () => {
  const S = newSlots();
  assert.equal(S.length, HOT + PACK);
  assert.equal(addTo(S, 'wood', 5), 5);
  assert.deepEqual(S[0], { id: 'wood', n: 5 });
  addTo(S, 'stone', 3);
  assert.deepEqual(S[1], { id: 'stone', n: 3 });
  assert.equal(addTo(S, 'wood', 30), 30);
  assert.equal(S[0].n, 20);
  assert.deepEqual(S[2], { id: 'wood', n: 15 }, 'the overflow stack takes the next empty hotbar slot');
  assert.equal(slotTotal(S, 'wood'), 35);
  addTo(S, 'shovel', 2);
  assert.equal(S[3].id, 'shovel');
  assert.equal(S[3].n, 1);
  assert.equal(S[4].id, 'shovel');
  for (const m of ['fiber', 'rope', 'leaves', 'bamboo']) addTo(S, m, 1);
  addTo(S, 'cloth', 25);
  assert.equal(S[HOT].id, 'cloth', 'hotbar full: the backpack');
  assert.equal(slotTotal(S, 'shovel'), 2);
});

test('a usable item evicts the right-most material from a full hotbar into the backpack', () => {
  const S = newSlots();
  const mats = ['wood', 'stone', 'fiber', 'rope', 'leaves', 'bamboo', 'cloth', 'flint', 'pyrite'];
  for (const m of mats) addTo(S, m, 2);
  assert.equal(S.slice(0, HOT).filter(Boolean).length, 9);
  addTo(S, 'berries', 3);
  assert.equal(S[8].id, 'berries');
  assert.ok(S.slice(HOT).some((s) => s?.id === 'pyrite'), 'the evicted stack stays in the backpack');
  addTo(S, 'hull_plank', 1);
  assert.ok(!S.slice(0, HOT).some((s) => s?.id === 'hull_plank'), 'parts never evict');
});

test('addTo stops when everything is full and reports what fit', () => {
  const S = newSlots(2, 2);
  assert.equal(addTo(S, 'wood', 100, { hot: 2 }), 80);
  assert.equal(roomFor(S, 'wood'), 0);
  assert.equal(addTo(S, 'stone', 1, { hot: 2 }), 0);
});

test('removeFrom takes from the backpack first and reports emptied hotbar slots', () => {
  const S = newSlots();
  addTo(S, 'wood', 20);
  S[HOT] = { id: 'wood', n: 5 }; // 20 in hotbar 0, 5 in the backpack
  assert.deepEqual(removeFrom(S, 'wood', 5), []);
  assert.equal(S[HOT], null);
  assert.equal(S[0].n, 20);
  assert.equal(removeFrom(S, 'wood', 21), null, 'not enough: nothing removed');
  assert.equal(S[0].n, 20);
  assert.deepEqual(removeFrom(S, 'wood', 20), [0]);
  assert.equal(S[0], null);
});

test('moveSlot: move, swap, merge, split', () => {
  const S = newSlots();
  addTo(S, 'wood', 10);
  addTo(S, 'stone', 4);
  // move into an empty backpack slot
  assert.ok(moveSlot(S, 0, HOT + 3));
  assert.equal(S[0], null);
  assert.deepEqual(S[HOT + 3], { id: 'wood', n: 10 });
  // swap different items
  assert.ok(moveSlot(S, HOT + 3, 1));
  assert.deepEqual(ids([S[1], S[HOT + 3]]), ['wood:10', 'stone:4']);
  // split half (rounded up) into an empty slot
  assert.ok(moveSlot(S, 1, 5, { split: true }));
  assert.deepEqual(ids([S[1], S[5]]), ['wood:5', 'wood:5']);
  // merge back
  assert.ok(moveSlot(S, 5, 1));
  assert.deepEqual(ids([S[1], S[5]]), ['wood:10', null]);
  // merge respects the stack limit
  S[2] = { id: 'wood', n: 15 };
  assert.ok(moveSlot(S, 2, 1));
  assert.deepEqual(ids([S[1], S[2]]), ['wood:20', 'wood:5']);
  assert.equal(moveSlot(S, 2, 1), false, 'full target: nothing moves');
  // a split onto a different item does nothing
  assert.equal(moveSlot(S, 1, HOT + 3, { split: true }), false);
  assert.equal(moveSlot(S, 1, 1), false);
  assert.equal(moveSlot(S, 7, 1), false, 'empty source');
  assert.equal(slotTotal(S, 'wood'), 25);
});

test('takeFrom and refillHot', () => {
  const S = newSlots();
  addTo(S, 'wood', 6);
  assert.deepEqual(takeFrom(S, 0, 1), { id: 'wood', n: 1 });
  assert.deepEqual(takeFrom(S, 0), { id: 'wood', n: 5 });
  assert.equal(S[0], null);
  assert.equal(takeFrom(S, 0), null);
  S[HOT] = { id: 'stone', n: 2 };
  S[HOT + 1] = { id: 'berries', n: 2 };
  assert.ok(refillHot(S, 0));
  assert.equal(S[0].id, 'berries', 'usable items refill first');
});

// ── the live inventory ─────────────────────────────────────────────────
function rig() {
  const events = [];
  const drops = [];
  const ctx = {
    events: { emit: (name, p) => events.push([name, p]), on() {} },
    flags: {},
    state: 'playing',
    ui: { toast() {} },
    player: { position: { x: 10, y: 1, z: 20 } },
    camera: { getWorldDirection: (v) => v.set(0, 0, -1) },
    world: { waterAt: () => null },
    resources: { spawnDrop: (id, n, x, z) => drops.push({ id, n, x, z }) },
  };
  const inv = createInventory(ctx);
  ctx.inventory = inv;
  return { ctx, inv, events, drops };
}

test('the old API: count / has / list / hotbar / selected', () => {
  const { inv } = rig();
  const hb = inv.hotbar;
  inv.add('wood', 25);
  inv.add('berries', 2);
  assert.equal(inv.count('wood'), 25);
  assert.ok(inv.has('wood', 25));
  assert.deepEqual(inv.list(), [{ id: 'wood', n: 25 }, { id: 'berries', n: 2 }], 'one aggregated entry per item');
  assert.equal(inv.hotbar, hb, 'the hotbar array is persistent (no per-frame allocation)');
  assert.equal(inv.hotbar.length, 9);
  assert.deepEqual(inv.hotbar.slice(0, 4), ['wood', 'wood', 'berries', null]);
  assert.equal(inv.selected, 'wood');
  assert.equal(inv.slotN(0), 20);
  assert.equal(inv.slotN(1), 5);
  inv.select(2);
  assert.equal(inv.selected, 'berries');
  assert.ok(inv.remove('wood', 25));
  assert.equal(inv.count('wood'), 0);
  assert.equal(inv.remove('wood', 1), false);
});

test('move from the backpack to the hotbar keeps counts and bumps the version', () => {
  const { inv } = rig();
  inv.add('wood', 25);
  assert.ok(inv.move(1, HOT + 2));
  const v = inv.version;
  assert.ok(inv.move(HOT + 2, 4));
  assert.ok(inv.version > v);
  assert.equal(inv.hotbar[4], 'wood');
  assert.equal(inv.slotN(4), 5);
  assert.equal(inv.count('wood'), 25);
});

test('drop: Q-style drop from the selected slot lands 1.2 m in front; one or the whole stack', () => {
  const { inv, drops, events } = rig();
  inv.add('stone', 6);
  assert.equal(inv.dropSelected(true), 1);
  assert.equal(inv.count('stone'), 5);
  assert.deepEqual(drops[0], { id: 'stone', n: 1, x: 10, z: 20 - 1.2 });
  assert.equal(inv.dropSelected(), 5);
  assert.equal(inv.count('stone'), 0);
  assert.equal(inv.hotbar[0], null);
  assert.ok(events.some(([n, p]) => n === 'item:removed' && p.dropped));
  assert.equal(inv.dropSelected(), 0, 'nothing selected: nothing dropped');
});

test('drop in deep water falls at the feet', () => {
  const { ctx, inv, drops } = rig();
  ctx.world.waterAt = () => ({ depth: 3, surface: 0 });
  inv.add('wood', 2);
  inv.dropSlot(0);
  assert.deepEqual(drops[0], { id: 'wood', n: 2, x: 10, z: 20 });
});

test('a full pack spills the rest at the feet, except for pickups (spill: false)', () => {
  const { inv, drops } = rig();
  assert.equal(inv.add('shovel', 40), 40, 'the spilled rest counts as handled (callers must not re-give it)');
  assert.equal(inv.count('shovel'), 33);
  assert.equal(drops.length, 1);
  assert.deepEqual(drops[0], { id: 'shovel', n: 7, x: 10, z: 20 });
  assert.equal(inv.add('stone', 3, { spill: false }), 0);
  assert.equal(drops.length, 1);
});

test('solo inventory without resources/player still works (old ctx shape)', () => {
  const inv = createInventory({ events: { emit() {}, on() {} }, flags: {}, state: 'playing', ui: {} });
  inv.add('wood', 3);
  assert.equal(inv.dropSelected(), 0, 'no world to drop into: the stack stays');
  assert.equal(inv.count('wood'), 3);
});

test('resources drop contract (before the world is built: pending path)', () => {
  const ev = [];
  const rng = { fork: () => rng, next: Math.random };
  const res = createResources({ rng, flags: {}, events: { emit: (n, p) => ev.push([n, p]), on() {} } });
  res.spawnDrop('wood', 2, 1, 2);
  assert.deepEqual(ev[0], ['item:dropped', { dropId: 'local:1', id: 'wood', n: 2, x: 1, z: 2 }]);
  res.spawnDrop('stone', 1, 0, 0, 'p7:3');
  assert.equal(ev.length, 1, 'a remote apply (dropId given) emits nothing');
  assert.equal(res.removeDrop('local:1'), true);
  assert.equal(res.removeDrop('local:1'), false);
  assert.equal(res.removeDrop('p7:3'), true);
});

test('tooltip text', () => {
  const t = slotTooltip('wood', 7, 20);
  assert.match(t.title, /Wood/);
  assert.equal(t.stack, '7 / 20 in this stack');
  assert.equal(slotTooltip('shovel', 1, 1).stack, 'One per slot');
  assert.equal(slotTooltip('nope', 1, 1), null);
  assert.ok(PACK_HELP.includes('Shift'));
});

if (!process.exitCode) console.log(`✓ inventory-ui: ${passed} tests passed`);
