// V6 reliability: WebSocket heartbeat, grace-period resume, bye. Real sockets, short timings.
// Run: cd server && node reliability.test.mjs   (part of npm test)
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION, encode, decode } from '../src/net/protocol.js';
import { startServer } from './index.js';

const HEARTBEAT = 100, DEAD = 450, GRACE = 900;
const watchdog = setTimeout(() => {
  console.error('✗ timed out');
  process.exit(1);
}, 30_000);
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

let srv = null;
for (let i = 0; i < 6 && !srv; i++) {
  try {
    srv = await startServer({ port: 9001 + Math.floor(Math.random() * 40_000), host: '127.0.0.1', log: () => {}, heartbeatMs: HEARTBEAT, deadMs: DEAD, graceMs: GRACE });
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e;
  }
}
const PORT = srv.port;

// ── Test client (never answers app-level pings: only ws protocol pongs keep it alive) ──
const sockets = new Set();
function connect(opts = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, opts);
    const c = { ws, msgs: [], waiters: [], closed: false };
    sockets.add(c);
    ws.on('message', (data) => {
      const m = decode(data);
      if (!m || m.t === MSG.PING || m.t === MSG.SNAPSHOT) return;
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
function waitFor(c, pred, label, ms = 2000) {
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
const is = (t) => (m) => m.t === t;
const noneOf = (c, types, label) => assert.equal(c.msgs.findIndex((m) => types.includes(m.t)), -1, `unexpected ${label}: ${JSON.stringify(c.msgs)}`);
async function hello(c, fields) {
  sendTo(c, MSG.HELLO, { v: PROTOCOL_VERSION, ...fields });
  return waitFor(c, (m) => m.t === MSG.WELCOME || m.t === MSG.ERROR, 'welcome/error');
}
const health = async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
const untilClosed = (c, ms) =>
  new Promise((resolve) => {
    if (c.closed) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    c.ws.once('close', () => {
      clearTimeout(t);
      resolve(true);
    });
  });

await step('heartbeat: a client that sends nothing but answers ping frames stays connected (hidden tab)', async () => {
  const A = await connect();
  const w = await hello(A, { name: 'Sleepy' });
  assert.equal(w.t, MSG.WELCOME);
  await sleep(DEAD * 3); // no app message at all for 3× the dead window
  assert.equal(A.closed, false, 'still connected');
  assert.equal((await health()).players, 1);
  sendTo(A, MSG.BYE);
  A.ws.close();
});

await step('heartbeat: a dead client (no pong, no message) is dropped after DEAD_MS', async () => {
  const D = await connect({ autoPong: false });
  await hello(D, { name: 'Ghost' });
  const t0 = Date.now();
  const closed = await untilClosed(D, DEAD + HEARTBEAT * 4 + 500);
  assert.equal(closed, true, 'dropped');
  assert.ok(Date.now() - t0 >= DEAD - 50, `not before DEAD_MS (${Date.now() - t0} ms)`);
  await sleep(GRACE + 200); // its grace window runs out too
  assert.equal((await health()).players, 0);
});

let A, B, wa, wb, room;
await step('grace: an abrupt close + reconnect keeps the same id and host role, no playerLeft/host', async () => {
  A = await connect();
  wa = await hello(A, { name: 'Host', timeHours: 30, difficulty: 'hard' });
  room = wa.room;
  assert.equal(wa.isHost, true);
  assert.match(wa.token, /^[A-Za-z0-9_-]{16,64}$/);
  B = await connect();
  wb = await hello(B, { name: 'Friend', room });
  await waitFor(A, is(MSG.JOINED), 'joined');
  A.ws.terminate(); // network drop: no close frame, no bye
  const p = await waitFor(B, is(MSG.PRESENCE), 'presence false');
  assert.deepEqual([p.id, p.connected], [wa.id, false]);
  await sleep(GRACE / 3);
  A = await connect();
  const w2 = await hello(A, { name: 'Host', room, resume: true, resumeId: wa.id, resumeToken: wa.token, timeHours: 99 });
  assert.equal(w2.t, MSG.WELCOME);
  assert.equal(w2.id, wa.id, 'same id');
  assert.equal(w2.isHost, true, 'still the host');
  assert.equal(w2.resumed, true);
  assert.deepEqual(w2.players, [{ id: wb.id, name: 'Friend', connected: true }]);
  assert.ok(w2.timeHours < 31, 'the room clock was not reset by the resuming hello');
  const p2 = await waitFor(B, is(MSG.PRESENCE), 'presence true');
  assert.deepEqual([p2.id, p2.connected], [wa.id, true]);
  await sleep(GRACE + 200); // past the original grace window: nothing may fire now
  noneOf(B, [MSG.LEFT, MSG.HOST, MSG.JOINED], 'leave/host/join after a resume');
  sendTo(A, MSG.EVENT, { name: 'time:set', payload: { hoursTotal: 41 } }); // still host-authoritative
  const t = await waitFor(B, (m) => m.t === MSG.EVENT && m.name === 'time:set', 'time:set from the resumed host');
  assert.equal(t.from, wa.id);
  wa = { ...wa, ...w2 };
});

await step('grace: resume over a half-open socket the server still thinks is alive', async () => {
  const old = A;
  A = await connect();
  const w = await hello(A, { name: 'Host', room, resume: true, resumeId: wa.id, resumeToken: wa.token });
  assert.equal(w.id, wa.id);
  assert.equal(w.isHost, true);
  assert.equal(await untilClosed(old, 1000), true, 'the stale socket is retired');
  await sleep(150);
  noneOf(B, [MSG.LEFT, MSG.HOST], 'leave/host for a replaced socket');
  B.msgs.length = 0;
});

await step('grace: a wrong token is a new player, never a hijack', async () => {
  const X = await connect();
  const w = await hello(X, { name: 'Mallory', room, resume: true, resumeId: wa.id, resumeToken: 'x'.repeat(24) });
  assert.equal(w.t, MSG.WELCOME);
  assert.notEqual(w.id, wa.id);
  assert.equal(w.isHost, false);
  await waitFor(B, is(MSG.JOINED), 'joined Mallory');
  sendTo(X, MSG.BYE);
  await waitFor(B, is(MSG.LEFT), 'Mallory left');
  X.ws.close();
});

await step('grace expired: the normal leave + host migration', async () => {
  A.ws.terminate();
  await waitFor(B, (m) => m.t === MSG.PRESENCE && !m.connected, 'presence false');
  const t0 = Date.now();
  const l = await waitFor(B, is(MSG.LEFT), 'playerLeft', GRACE + 1500);
  assert.ok(Date.now() - t0 >= GRACE - 100, 'not before the grace window');
  assert.equal(l.id, wa.id);
  const h = await waitFor(B, is(MSG.HOST), 'host');
  assert.equal(h.id, wb.id);
  // too late to resume: joins as a new player (not the host)
  A = await connect();
  const w = await hello(A, { name: 'Host', room, resume: true, resumeId: wa.id, resumeToken: wa.token });
  assert.equal(w.t, MSG.WELCOME);
  assert.equal(w.isHost, false);
  assert.equal(w.hostId, wb.id);
});

await step('bye: leaves at once (no grace window)', async () => {
  B.msgs.length = 0;
  A.msgs.length = 0;
  sendTo(B, MSG.BYE);
  const t0 = Date.now();
  const l = await waitFor(A, is(MSG.LEFT), 'playerLeft after bye', 400);
  assert.ok(Date.now() - t0 < GRACE / 2);
  assert.equal(l.id, wb.id);
  const h = await waitFor(A, is(MSG.HOST), 'host after bye', 400);
  noneOf(A, [MSG.PRESENCE], 'presence for a bye');
  assert.ok(h.id);
  B.ws.close();
  sendTo(A, MSG.BYE);
  A.ws.close();
  await sleep(100);
  assert.equal((await health()).rooms, 0);
});

await step('a host whose socket dropped: a new player just joins (no waiting), the host resumes as host', async () => {
  const H = await connect();
  const wh = await hello(H, { name: 'H' });
  H.ws.terminate();
  await sleep(50);
  const N = await connect();
  const wn = await hello(N, { name: 'N', room: wh.room });
  assert.equal(wn.t, MSG.WELCOME);
  assert.equal(wn.isHost, false);
  assert.deepEqual(wn.players, [{ id: wh.id, name: 'H', connected: false }]);
  const H2 = await connect();
  const w2 = await hello(H2, { name: 'H', room: wh.room, resume: true, resumeId: wh.id, resumeToken: wh.token });
  assert.equal(w2.isHost, true);
  for (const c of [N, H2]) {
    sendTo(c, MSG.BYE);
    c.ws.close();
  }
});

for (const c of sockets) {
  try {
    c.ws.terminate();
  } catch (_) {}
}
await srv.close();
console.log(`reliability tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
