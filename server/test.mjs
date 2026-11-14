// Relay server integration test. Run: cd server && node test.mjs   (or npm test). Uses 'ws' from server/node_modules.
// Starts the server in-process on a random port > 9000 and drives real WebSocket clients through: welcome + host
// flag, snapshot relay (never the recipient), event relay (never echoed, unknown names dropped, time:set host-only),
// chat sanitizing, room full, unknown room, host re-election on leave, the room disappearing when empty.
// Idle drop (30 s) is not tested: LIMITS.idleMs is frozen in protocol.js and the server has no override.
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { MSG, ERRORS, ROOM_ALPHABET, PROTOCOL_VERSION, encode, decode, sanitizeChat } from '../src/net/protocol.js';

process.env.MAX_PLAYERS = '3'; // read when index.js loads → dynamic import below
const { startServer } = await import('./index.js');

const watchdog = setTimeout(() => {
  console.error('✗ timed out');
  process.exit(1);
}, 25_000);
watchdog.unref();

let passed = 0, failed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n`, e);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Test client: a queue of decoded messages + waitFor(pred) ─────────────
const sockets = new Set();
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const c = { ws, msgs: [], waiters: [], closed: false };
    sockets.add(c);
    ws.on('message', (data) => {
      const m = decode(data);
      if (!m) return;
      const i = c.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const [w] = c.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(m);
      } else c.msgs.push(m);
    });
    ws.on('close', () => (c.closed = true));
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
const sendTo = (c, type, fields) => c.ws.send(encode(type, fields));
function waitFor(c, pred, label = 'message', ms = 2000) {
  const i = c.msgs.findIndex(pred);
  if (i >= 0) return Promise.resolve(c.msgs.splice(i, 1)[0]);
  return new Promise((resolve, reject) => {
    const w = { pred, resolve, timer: 0 };
    w.timer = setTimeout(() => {
      c.waiters.splice(c.waiters.indexOf(w), 1);
      reject(new Error(`timed out waiting for ${label}`));
    }, ms);
    c.waiters.push(w);
  });
}
async function none(c, pred, label, ms = 300) {
  await sleep(ms);
  assert.equal(c.msgs.findIndex(pred), -1, `unexpected ${label}`);
}
const is = (t) => (m) => m.t === t;
async function hello(c, fields) {
  sendTo(c, MSG.HELLO, { v: PROTOCOL_VERSION, ...fields });
  return waitFor(c, (m) => m.t === MSG.WELCOME || m.t === MSG.ERROR, 'welcome/error');
}
async function closeClient(c) {
  if (c.closed) return;
  await new Promise((r) => {
    c.ws.once('close', r);
    c.ws.close();
  });
}

// ── Server on a random port > 9000 ───────────────────────────────────────
let srv = null;
for (let i = 0; i < 6 && !srv; i++) {
  const port = 9001 + Math.floor(Math.random() * 40_000);
  try {
    srv = await startServer({ port, host: '127.0.0.1', log: () => {} });
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e;
  }
}
assert.ok(srv && srv.port > 9000, 'server started');
const PORT = srv.port;

let A, B, C, wa, wb, room;

await step('welcome: the first player creates a room and is the host', async () => {
  A = await connect(PORT);
  wa = await hello(A, { name: 'Alice', seed: 42, difficulty: 'hard', timeHours: 30 });
  assert.equal(wa.t, MSG.WELCOME);
  assert.equal(wa.isHost, true);
  assert.equal(typeof wa.id, 'string');
  assert.equal(wa.hostId, wa.id);
  assert.deepEqual(wa.players, []);
  room = wa.room;
  assert.match(room, /^[A-Z]{6}$/);
  for (const ch of room) assert.ok(ROOM_ALPHABET.includes(ch), `room letter ${ch}`);
});

await step("welcome: a joiner is not the host and gets the host's seed/difficulty/clock", async () => {
  B = await connect(PORT);
  wb = await hello(B, { name: 'Bob', room: room.toLowerCase(), difficulty: 'easy', seed: 7 });
  assert.equal(wb.t, MSG.WELCOME);
  assert.equal(wb.isHost, false);
  assert.equal(wb.room, room);
  assert.equal(wb.hostId, wa.id);
  assert.notEqual(wb.id, wa.id);
  assert.deepEqual(wb.players, [{ id: wa.id, name: 'Alice' }]);
  assert.equal(wb.difficulty, 'hard');
  assert.equal(wb.seed, 42);
  assert.ok(wb.timeHours >= 30 && wb.timeHours < 31, `extrapolated clock ${wb.timeHours}`);
  const j = await waitFor(A, is(MSG.JOINED), 'playerJoined');
  assert.deepEqual([j.id, j.name], [wb.id, 'Bob']);
});

await step('snapshots: relay state to others, never include the recipient', async () => {
  sendTo(A, MSG.STATE, { pos: [1, 2, 3], yaw: 0.5, pitch: -0.1, state: { moving: true, torch: 1 } });
  const sb = await waitFor(B, (m) => m.t === MSG.SNAPSHOT && m.players.some((p) => p.id === wa.id), 'snapshot with A');
  const pa = sb.players.find((p) => p.id === wa.id);
  assert.deepEqual(pa.pos, [1, 2, 3]);
  assert.equal(pa.yaw, 0.5);
  assert.equal(pa.state.moving, true);
  assert.equal(pa.state.torch, true);
  assert.ok(sb.players.every((p) => p.id !== wb.id), 'B is not in its own snapshot');
  sendTo(B, MSG.STATE, { pos: [4, 5, 6], yaw: 0, pitch: 0, state: {} });
  const sa = await waitFor(A, (m) => m.t === MSG.SNAPSHOT && m.players.some((p) => p.id === wb.id), 'snapshot with B');
  assert.ok(sa.players.every((p) => p.id !== wa.id), 'A is not in its own snapshot');
  sendTo(A, MSG.STATE, { pos: [1e9, 0, 0], yaw: 0, pitch: 0 }); // out of the world → rejected, keeps the old state
  await sleep(120);
  B.msgs.length = 0;
  sendTo(B, MSG.STATE, { pos: [4, 5, 7], yaw: 0, pitch: 0, state: {} });
  const sb2 = await waitFor(B, (m) => m.t === MSG.SNAPSHOT && m.players.some((p) => p.id === wa.id), 'snapshot after bad state');
  assert.deepEqual(sb2.players.find((p) => p.id === wa.id).pos, [1, 2, 3]);
});

await step('events: relayed to the others with `from`, never echoed, unknown names dropped', async () => {
  sendTo(B, MSG.EVENT, { name: 'harvest', payload: { rid: 'bush:3', kind: 'bush' } });
  const e = await waitFor(A, (m) => m.t === MSG.EVENT && m.name === 'harvest', 'harvest event');
  assert.equal(e.from, wb.id);
  assert.equal(e.payload.rid, 'bush:3');
  sendTo(B, MSG.EVENT, { name: 'cheat:win', payload: {} });
  await none(A, (m) => m.t === MSG.EVENT && m.name === 'cheat:win', 'unknown event');
  await none(B, is(MSG.EVENT), 'echo to the sender', 50);
});

await step('events: time:set only from the host', async () => {
  sendTo(B, MSG.EVENT, { name: 'time:set', payload: { hoursTotal: 99 } });
  await none(A, (m) => m.t === MSG.EVENT && m.name === 'time:set', 'time:set from a client');
  sendTo(A, MSG.EVENT, { name: 'time:set', payload: { hoursTotal: 40 } });
  const t = await waitFor(B, (m) => m.t === MSG.EVENT && m.name === 'time:set', 'time:set from the host');
  assert.equal(t.payload.hoursTotal, 40);
});

await step('chat: sanitized, capped at 200 chars, not echoed', async () => {
  const raw = '<b>hi</b>\u0007   there​';
  sendTo(A, MSG.CHAT, { text: raw });
  const m = await waitFor(B, is(MSG.CHAT), 'chat');
  assert.equal(m.id, wa.id);
  assert.equal(m.name, 'Alice');
  assert.equal(m.text, sanitizeChat(raw));
  assert.equal(m.text, 'bhi/b there');
  sendTo(A, MSG.CHAT, { text: 'x'.repeat(500) });
  const long = await waitFor(B, is(MSG.CHAT), 'long chat');
  assert.equal(long.text.length, 200);
  sendTo(A, MSG.CHAT, { text: ' \n\t ' }); // empty after sanitizing → dropped
  await none(B, is(MSG.CHAT), 'empty chat');
  await none(A, is(MSG.CHAT), 'chat echo', 0);
});

await step('room full: the 4th player of a MAX_PLAYERS=3 room is refused', async () => {
  C = await connect(PORT);
  const wc = await hello(C, { name: '<Cara>\n', room });
  assert.equal(wc.t, MSG.WELCOME);
  assert.equal(wc.isHost, false);
  const j = await waitFor(A, is(MSG.JOINED), 'playerJoined C');
  assert.equal(j.name, 'Cara');
  C.id = wc.id;
  const D = await connect(PORT);
  const wd = await hello(D, { name: 'Dan', room });
  assert.equal(wd.t, MSG.ERROR);
  assert.equal(wd.code, ERRORS.ROOM_FULL);
  await closeClient(D);
});

await step('unknown room and bad protocol version are refused', async () => {
  const E = await connect(PORT);
  const we = await hello(E, { name: 'Eve', room: room === 'ZZZZZZ' ? 'YYYYYY' : 'ZZZZZZ' });
  assert.equal(we.t, MSG.ERROR);
  assert.equal(we.code, ERRORS.NO_ROOM);
  await closeClient(E);
  const F = await connect(PORT);
  const wf = await hello(F, { name: 'Fay', v: 999 });
  assert.equal(wf.t, MSG.ERROR);
  assert.equal(wf.code, ERRORS.VERSION);
  await closeClient(F);
});

await step('host leaves: playerLeft, then the next player is elected host', async () => {
  await closeClient(A);
  for (const c of [B, C]) {
    const l = await waitFor(c, is(MSG.LEFT), 'playerLeft');
    assert.equal(l.id, wa.id);
    const h = await waitFor(c, is(MSG.HOST), 'host');
    assert.equal(h.id, wb.id);
  }
  sendTo(B, MSG.EVENT, { name: 'time:set', payload: { hoursTotal: 41 } }); // the new host may now set the clock
  const t = await waitFor(C, (m) => m.t === MSG.EVENT && m.name === 'time:set', 'time:set from the new host');
  assert.equal(t.payload.hoursTotal, 41);
});

await step('the room disappears when its last player leaves', async () => {
  await closeClient(B);
  await closeClient(C);
  await sleep(100);
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(h.rooms, 0);
  assert.equal(h.players, 0);
  const G = await connect(PORT);
  const wg = await hello(G, { name: 'Gus', room });
  assert.equal(wg.code, ERRORS.NO_ROOM);
  await closeClient(G);
});

console.log('- idle drop (30 s, no override in index.js): not tested');

for (const c of sockets) {
  try {
    c.ws.terminate();
  } catch (_) {}
}
await srv.close();
console.log(`server tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
