// V5-B co-op (SPEC §13): communal boat stock, raft seats, pose interpolation, protocol checks, and an end-to-end
// shared raft between two (three) vehicle systems wired through a fake relay. Run: node tests/coop.test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { createHeightfield } from '../src/world/heightfield.js';
import { createEvents } from '../src/core/events.js';
import { createRng } from '../src/core/rng.js';
import { create as createController } from '../src/player/controller.js';
import { create as createVehicles } from '../src/gameplay/vehicles.js';
import * as L from '../src/gameplay/raft-logic.js';
import * as CO from '../src/gameplay/vehicle-coop.js';
import { validateEvent, SHARED_EVENTS, HOST_ONLY_EVENTS, PAUSED_OK_EVENTS } from '../src/net/protocol.js';

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

// ── stock ────────────────────────────────────────────────────────────────
const stage = { id: 's', label: 'S', hours: 1, needs: { wood: 10, rope: 2 } };
const plan = { stages: [stage, { id: 't', label: 'T', hours: 1, needs: { wood: 4, cloth: 1 } }] };

test('stockNeedsStatus: have = stock + own, with a stock field', () => {
  const st = L.stockNeedsStatus(stage, { wood: 6 }, (id) => (id === 'wood' ? 3 : 2));
  assert.deepEqual(st, [
    { id: 'wood', have: 9, need: 10, stock: 6 },
    { id: 'rope', have: 2, need: 2, stock: 0 },
  ]);
  assert.equal(L.isReady(st), false);
});

test('consumeStageStock: stock first, then own inventory; nothing taken when short', () => {
  const inv = { wood: 5, rope: 3 };
  const removed = [];
  const count = (id) => inv[id] || 0;
  const remove = (id, n) => {
    removed.push([id, n]);
    inv[id] -= n;
  };
  const stock = { wood: 3 };
  assert.equal(L.consumeStageStock(stage, stock, count, remove), null);
  assert.deepEqual(stock, { wood: 3 });
  assert.equal(removed.length, 0);
  stock.wood = 7;
  const used = L.consumeStageStock(stage, stock, count, remove);
  assert.deepEqual(used, { wood: 7 });
  assert.deepEqual(stock, {}, 'stock emptied');
  assert.deepEqual(removed, [['wood', 3], ['rope', 2]]);
  assert.deepEqual(inv, { wood: 2, rope: 1 });
  // all from stock
  const s2 = { wood: 12, rope: 2 };
  assert.deepEqual(L.consumeStageStock(stage, s2, () => 0, () => assert.fail('no own items')), { wood: 10, rope: 2 });
  assert.deepEqual(s2, { wood: 2 });
});

test('depositList: what remaining stages need, minus the stock, capped by own', () => {
  const own = { wood: 20, rope: 1, cloth: 3, berry: 5 };
  const list = L.depositList(plan, 0, { wood: 5 }, (id) => own[id] || 0);
  assert.deepEqual(list, [
    { id: 'wood', n: 9 },
    { id: 'rope', n: 1 },
    { id: 'cloth', n: 1 },
  ]);
  assert.deepEqual(L.depositList(plan, 1, { wood: 4, cloth: 1 }, (id) => own[id] || 0), []);
});

test('addStock / applyUsed / setStock', () => {
  const s = {};
  assert.equal(L.addStock(s, 'wood', 4), 4);
  L.addStock(s, 'rope', 1);
  L.applyUsed(s, { wood: 3, rope: 5 });
  assert.deepEqual(s, { wood: 1 });
  L.setStock(s, { cloth: 2, bad: -1, x: 'y' });
  assert.deepEqual(s, { cloth: 2 });
  L.setStock(s, null);
  assert.deepEqual(s, {});
});

// ── seats ────────────────────────────────────────────────────────────────
test('seats: free seat, full raft, release, simulator', () => {
  const s = CO.makeSeats();
  assert.equal(CO.freeSeat(s), 0);
  s[0] = 'a';
  assert.equal(CO.freeSeat(s), 1);
  s[1] = CO.ME;
  assert.equal(CO.freeSeat(s), -1, 'full');
  assert.equal(CO.simulatorOf(s, 'owner'), 'a');
  assert.deepEqual(CO.releaseSeats(s, 'a'), [0]);
  assert.equal(CO.simulatorOf(s, 'owner'), 'owner', 'empty seat 0: the owner simulates');
  assert.equal(CO.clearRemote(s), false);
  s[0] = 'b';
  assert.equal(CO.clearRemote(s), true);
  assert.deepEqual(s, [null, CO.ME]);
});

test('applySeatClaim: take, leave (only by the occupant), one seat per player, ties by id', () => {
  const s = CO.makeSeats();
  assert.equal(CO.applySeatClaim(s, 0, 'b', 'b', 'm'), 'ok');
  assert.deepEqual(s, ['b', null]);
  assert.equal(CO.applySeatClaim(s, 1, 'b', 'b', 'm'), 'ok');
  assert.deepEqual(s, [null, 'b'], 'moving seats frees the old one');
  CO.applySeatClaim(s, 1, 'c', null, 'm');
  assert.deepEqual(s, [null, 'b'], 'c cannot free b’s seat');
  CO.applySeatClaim(s, 1, 'b', null, 'm');
  assert.deepEqual(s, [null, null]);
  s[0] = CO.ME;
  assert.equal(CO.applySeatClaim(s, 0, 'z', 'z', 'a'), 'kept', 'lower id keeps the seat');
  assert.deepEqual(s, [CO.ME, null]);
  assert.equal(CO.applySeatClaim(s, 0, 'a', 'a', 'z'), 'yield');
  assert.deepEqual(s, ['a', null]);
});

// ── pose buffer ──────────────────────────────────────────────────────────
test('pose buffer: interpolates, short-way heading, holds ends, ring overflow', () => {
  const b = CO.createPoseBuffer(4);
  const o = {};
  assert.equal(b.sample(0, o), false);
  b.push(1, 0, 0, 3.0);
  b.push(2, 10, -4, -3.0, 0.2, 1);
  assert.ok(b.sample(1.5, o));
  assert.ok(Math.abs(o.x - 5) < 1e-9 && Math.abs(o.z + 2) < 1e-9);
  const expect = 3.0 + ((2 * Math.PI - 6.0) / 2); // halfway across ±π, not through 0
  assert.ok(Math.abs(o.heading - expect) < 1e-9, `heading ${o.heading}`);
  b.sample(5, o);
  assert.equal(o.x, 10, 'holds the newest (no extrapolation)');
  assert.equal(o.cap, 1);
  b.sample(0, o);
  assert.equal(o.x, 0, 'holds the oldest');
  assert.equal(b.push(1.5, 0, 0, 0), false, 'out of order dropped');
  for (let i = 3; i <= 8; i++) b.push(i, i, 0, 0);
  assert.equal(b.length, 4);
  b.sample(6.25, o);
  assert.ok(Math.abs(o.x - 6.25) < 1e-9);
  assert.equal(CO.poseDue(0.05, true), false);
  assert.equal(CO.poseDue(0.11, true), true);
  assert.equal(CO.poseDue(0.5, false), false);
  assert.equal(CO.poseDue(1.01, false), true);
});

// ── protocol ─────────────────────────────────────────────────────────────
test('protocol: co-op events shared + validated; raft:sync host-only', () => {
  for (const n of ['item:dropped', 'drop:picked', 'raft:deposit', 'raft:sync', 'vehicle:placed', 'vehicle:pose', 'vehicle:seat']) {
    assert.ok(SHARED_EVENTS.includes(n), n);
  }
  assert.ok(HOST_ONLY_EVENTS.includes('raft:sync'));
  assert.ok(PAUSED_OK_EVENTS.includes('raft:sync'));
  assert.ok(validateEvent({ name: 'vehicle:pose', payload: { vid: 'a:raft', x: 1, z: 2, heading: 0.3, roll: 0, cap: 0 } }));
  assert.equal(validateEvent({ name: 'vehicle:pose', payload: { vid: 'a:raft', x: 1e7, z: 2, heading: 0 } }), null);
  assert.equal(validateEvent({ name: 'vehicle:seat', payload: { vid: 'a:raft', seat: 2 } }), null);
  assert.ok(validateEvent({ name: 'vehicle:seat', payload: { vid: 'a:raft', seat: 1, playerId: null } }));
  assert.equal(validateEvent({ name: 'vehicle:placed', payload: { vid: 'a', type: 'yacht' } }), null);
  assert.equal(validateEvent({ name: 'item:dropped', payload: { dropId: 'a:1', id: 'wood', n: 0 } }), null);
  assert.equal(validateEvent({ name: 'raft:sync', payload: { stageIndex: 1, stock: { wood: -2 } } }), null);
  assert.equal(validateEvent({ name: 'raft:stage', payload: { stageIndex: 1, used: [1] } }), null);
  assert.ok(validateEvent({ name: 'raft:stage', payload: { stageIndex: 1, used: { wood: 3 } } }));
});

// ── end to end: three vehicle systems on one fake relay ──────────────────
const W = createHeightfield();
let clock = 0;
const players = new Map();
function rig(id) {
  const held = new Set();
  const inv = new Map([['paddle', 1]]);
  const toasts = [];
  const events = createEvents();
  let provider = null;
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
    stats: { exhausted: false, dead: false, values: { energy: 100 }, drainEnergy() {} },
    ui: { hint() {}, toast: (t) => toasts.push(t), flash() {}, subtitle() {}, setPrompt() {} },
    audio: { play() {}, setLoop() {} },
    world: W,
    weather: { storm: 0, stormAt: () => 0, wind: { x: 0, z: 0, strength: 0 } },
    time: { day: 1 },
    inventory: {
      count: (k) => inv.get(k) || 0,
      add: (k, n = 1) => inv.set(k, (inv.get(k) || 0) + n),
      remove: (k, n = 1) => inv.set(k, Math.max(0, (inv.get(k) || 0) - n)),
    },
    interact: { addProvider: (fn) => (provider = fn) },
  };
  const me = { id, ctx, held, toasts, events };
  ctx.net = {
    connected: true,
    id,
    name: id.toUpperCase(),
    players,
    now: () => clock,
    relay: (name, p) => broadcast(me, name, p),
  };
  ctx.scene.add(ctx.camera);
  ctx.camera.rotation.order = 'YXZ';
  ctx.player = createController(ctx);
  ctx.player.init();
  ctx.vehicles = createVehicles(ctx);
  ctx.vehicles.init();
  for (const n of ['vehicle:placed', 'vehicle:pose']) events.on(n, (p) => broadcast(me, n, p));
  me.veh = ctx.vehicles;
  me.pl = ctx.player;
  me.cand = () => provider?.(ctx) || null;
  players.set(id, { id, name: id.toUpperCase() });
  return me;
}
const peers = [];
function broadcast(from, name, p) {
  const payload = JSON.parse(JSON.stringify(p)); // like the wire
  assert.ok(validateEvent({ name, payload }), `valid ${name}`);
  for (const o of peers) if (o !== from) o.veh.applyRemote(name, payload, from.id);
}
function step(dt = 1 / 30) {
  clock += dt;
  for (const p of peers) {
    p.pl.update(dt);
    p.veh.update(dt);
  }
}
const run = (s) => {
  for (let t = 0; t < s; t += 1 / 30) step();
};

test('shared raft: placed for everyone, 2 seats, driver moves it, passenger rides, full, capsize throws both', () => {
  const A = rig('a'), B = rig('b'), C = rig('c');
  peers.push(A, B, C);
  const raft = A.veh.debugRaft();
  assert.ok(raft, 'A placed a raft');
  const rb = B.veh.remotes.get('a:raft');
  assert.ok(rb, 'B mirrors A’s raft');
  assert.ok(rb.object.position.distanceTo(raft.object.position) < 0.5);
  // A boards → seat 0
  A.cand().onUse();
  assert.equal(A.veh.current, raft);
  assert.equal(A.veh.seat, 0);
  assert.equal(rb.seats[0], 'a');
  // B walks up and boards → seat 1 (passenger)
  B.pl.teleport(A.pl.position.x, A.pl.position.z);
  B.pl.teleport(raft.object.position.x - Math.sin(raft.heading) * 1.5, raft.object.position.z - Math.cos(raft.heading) * 1.5);
  const cb = B.cand();
  assert.equal(cb?.label, 'Board the raft');
  cb.onUse();
  assert.equal(B.veh.current, rb);
  assert.equal(B.veh.seat, 1);
  assert.deepEqual(raft.seats, [CO.ME, 'b'], 'A sees B in seat 1');
  assert.equal(B.pl.aboard, rb);
  // C finds it full
  C.pl.teleport(raft.object.position.x - Math.sin(raft.heading) * 1.5, raft.object.position.z - Math.cos(raft.heading) * 1.5);
  const cc = C.cand();
  assert.equal(cc?.label, 'The raft is full');
  cc.onUse();
  assert.ok(C.toasts.some((t) => /The raft is full/.test(t)));
  assert.equal(C.veh.current, null);
  // A paddles: B's copy follows (interpolated), B rides at the second seat
  const start = raft.object.position.clone();
  A.held.add('forward');
  run(4);
  A.held.delete('forward');
  run(2.5);
  const moved = raft.object.position.distanceTo(start);
  assert.ok(moved > 2, `A's raft moved ${moved}`);
  const gap = Math.hypot(rb.object.position.x - raft.object.position.x, rb.object.position.z - raft.object.position.z);
  assert.ok(gap < 0.3, `B's copy follows (gap ${gap})`);
  const s2 = new THREE.Vector3();
  rb.seat2.getWorldPosition(s2);
  assert.ok(s2.distanceTo(B.ctx.camera.position) < 1e-6, 'B’s camera at the passenger seat');
  // C's copy also follows
  const rc = C.veh.remotes.get('a:raft');
  assert.ok(Math.hypot(rc.object.position.x - raft.object.position.x, rc.object.position.z - raft.object.position.z) < 0.3);
  // capsize (A simulates) throws both
  A.veh.debugCapsize();
  assert.equal(A.veh.current, null, 'A thrown off');
  run(0.5);
  assert.equal(B.veh.current, null, 'B thrown off too');
  assert.ok(B.toasts.some((t) => /both thrown/.test(t)));
  assert.deepEqual(raft.seats, [null, null], 'seats freed everywhere');
  assert.deepEqual(rb.seats, [null, null]);
  assert.equal(rb.capsized, true);
});

test('shared raft: B can paddle A’s raft (B simulates, A interpolates); disembark frees the seat; leaving removes it', () => {
  const [A, B, C] = peers;
  const raft = A.veh.raft;
  const rb = B.veh.remotes.get('a:raft');
  // right it (A owns it, nobody aboard → A simulates)
  for (let i = 0; i < 60 && raft.flip; i++) step();
  A.pl.teleport(raft.object.position.x + 1, raft.object.position.z);
  const ca = A.cand();
  assert.match(ca?.label || '', /Right the raft/);
  ca.onUse();
  run(1.5);
  assert.equal(raft.capsized, false);
  run(0.5);
  assert.equal(rb.capsized, false, 'B sees it upright');
  // B boards first → seat 0: B drives A's raft
  B.pl.teleport(rb.object.position.x + 1, rb.object.position.z);
  B.cand().onUse();
  assert.equal(B.veh.seat, 0);
  assert.equal(raft.seats[0], 'b');
  const start = rb.object.position.clone();
  B.held.add('forward');
  run(3);
  B.held.delete('forward');
  run(2.5);
  assert.ok(rb.object.position.distanceTo(start) > 1.5, 'B paddled it');
  const gap = Math.hypot(rb.object.position.x - raft.object.position.x, rb.object.position.z - raft.object.position.z);
  assert.ok(gap < 0.3, `A's own raft follows B (gap ${gap})`);
  // B gets off (teleport away = stand up): the seat frees on A's side
  B.pl.teleport(start.x, start.z);
  step();
  assert.equal(B.veh.current, null);
  assert.equal(raft.seats[0], null);
  // A leaves the session: the others drop the mirrored raft
  for (const p of [B, C]) p.events.emit('net:playerLeft', { id: 'a', name: 'A' });
  assert.equal(B.veh.remotes.size, 0);
  assert.equal(C.veh.remotes.size, 0);
  assert.equal(B.ctx.scene.children.includes(rb.object), false);
});

test('solo: no net → one raft, you paddle, no co-op events', () => {
  const emitted = [];
  const S = rig('s');
  S.ctx.net = null;
  const orig = S.events.emit.bind(S.events);
  S.events.emit = (n, p) => {
    emitted.push(n);
    orig(n, p);
  };
  const r = S.veh.debugRaft();
  S.cand().onUse();
  assert.equal(S.veh.seat, 0);
  S.held.add('forward');
  for (let t = 0; t < 2; t += 1 / 30) {
    S.pl.update(1 / 30);
    S.veh.update(1 / 30);
  }
  assert.ok(r.speed > 0, 'paddling');
  assert.ok(!emitted.includes('vehicle:pose') && !emitted.includes('vehicle:seat'), 'no co-op traffic offline');
});

test('seat before placed: hidden mirror, then placed; seatFeet puts a remote passenger on our copy', () => {
  const D = rig('d');
  const v = D.veh;
  v.applyRemote('vehicle:seat', { vid: 'q:raft', seat: 1, playerId: 'p' }, 'p');
  const r = v.remotes.get('q:raft');
  assert.ok(r, 'mirrored on the seat message');
  assert.equal(r.object.visible, false, 'hidden until placed');
  assert.equal(r.seats[1], 'p');
  const out = new THREE.Vector3();
  assert.equal(v.seatFeet('p', out), false, 'not drawn on a hidden raft');
  const raft = peers[0].veh.raft;
  v.applyRemote('vehicle:placed', { vid: 'q:raft', type: 'paddle_raft', x: raft.object.position.x, z: raft.object.position.z, heading: 0 }, 'q');
  assert.equal(r.object.visible, true);
  assert.equal(r.seats[1], 'p', 'seat kept');
  assert.equal(v.seatFeet('p', out), true);
  const s2 = new THREE.Vector3();
  r.seat2.getWorldPosition(s2);
  assert.ok(Math.abs(out.y - (s2.y - 1.05)) < 0.01 && Math.hypot(out.x - s2.x, out.z - s2.z) < 1e-6);
});

console.log(`coop: ${passed} tests passed`);
