// V6: the real browser client (src/net/net.js) against the real relay, in node ('ws' stands in for the browser
// WebSocket). Drop + resume, failed attempts across a server restart, leave() = bye, host hand-off to a client.
// Run: cd server && node client.test.mjs   (part of npm test)
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { MSG, PROTOCOL_VERSION, encode, decode } from '../src/net/protocol.js';
import { startServer } from './index.js';

globalThis.WebSocket = WebSocket;
const { create } = await import('../src/net/net.js');

const GRACE = 4000;
const watchdog = setTimeout(() => {
  console.error('✗ timed out');
  process.exit(1);
}, 40_000);
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
async function until(fn, label, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await sleep(20);
  }
}

const opts = { host: '127.0.0.1', log: () => {}, heartbeatMs: 200, deadMs: 1000, graceMs: GRACE };
let srv = null, PORT = 0;
for (let i = 0; i < 6 && !srv; i++) {
  try {
    srv = await startServer({ ...opts, port: 9001 + Math.floor(Math.random() * 40_000) });
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e;
  }
}
PORT = srv.port;
const URL_ = `ws://127.0.0.1:${PORT}`;

/** A net.js instance with a fake ctx that records events and toasts. */
function makeClient() {
  const listeners = new Map();
  const log = [];
  const toasts = [];
  const events = {
    on(n, fn) {
      if (!listeners.has(n)) listeners.set(n, new Set());
      listeners.get(n).add(fn);
      return () => listeners.get(n).delete(fn);
    },
    emit(n, p) {
      log.push({ n, p });
      for (const fn of listeners.get(n) || []) fn(p);
    },
  };
  const ctx = { events, ui: { toast: (text) => toasts.push(text) }, params: new URLSearchParams(), time: { hoursTotal: 30 } };
  const net = create(ctx);
  net.init();
  return { net, log, toasts, count: (n) => log.filter((e) => e.n === n).length, toastCount: (re) => toasts.filter((t) => re.test(t)).length };
}
/** A raw-socket friend (no auto replies except ws pongs). */
function rawFriend() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_);
    const f = { ws, msgs: [] };
    ws.on('message', (d) => {
      const m = decode(d);
      if (m && m.t !== MSG.PING && m.t !== MSG.SNAPSHOT) f.msgs.push(m);
    });
    ws.on('open', () => resolve(f));
    ws.on('error', reject);
  });
}
const has = (f, pred) => f.msgs.some(pred);
const serverSocketOf = (id) => [...srv.clients].find((p) => p.id === id)?.ws;

let H, F, room;
await step('drop + resume: same id, host kept, players kept, no net:disconnected, one toast each', async () => {
  H = makeClient();
  assert.equal(H.net.create('Host', URL_), true);
  await until(() => H.net.connected, 'host connected');
  room = H.net.room;
  const id = H.net.id;
  F = await rawFriend();
  F.ws.send(encode(MSG.HELLO, { v: PROTOCOL_VERSION, name: 'Friend', room }));
  await until(() => H.net.players.size === 1, 'friend seen');
  await until(() => has(F, (m) => m.t === MSG.WELCOME), 'friend welcome');
  F.welcome = F.msgs.find((m) => m.t === MSG.WELCOME);
  F.msgs.length = 0;
  serverSocketOf(id).terminate();
  await until(() => H.net.reconnecting, 'reconnecting');
  assert.equal(H.net.players.size, 1, 'players kept during the outage');
  assert.equal(H.count('net:disconnected'), 0);
  await until(() => H.net.connected, 'reconnected');
  assert.equal(H.net.id, id, 'same id');
  assert.equal(H.net.isHost, true, 'still host');
  assert.equal(H.net.reconnecting, false);
  assert.equal(H.log.filter((e) => e.n === 'net:connected').at(-1).p.resumed, true);
  await until(() => has(F, (m) => m.t === MSG.PRESENCE && m.connected === true), 'friend sees presence true');
  assert.ok(has(F, (m) => m.t === MSG.PRESENCE && m.connected === false), 'presence false first');
  assert.ok(!has(F, (m) => [MSG.LEFT, MSG.HOST, MSG.JOINED].includes(m.t)), 'no leave/host/join');
  assert.equal(H.toastCount(/Reconnecting/), 1);
  assert.equal(H.toastCount(/^Reconnected/), 1);
  assert.equal(H.count('net:disconnected'), 0);
});

await step('the friend drops and resumes: shown as away, then back (no playerLeft on our side)', async () => {
  const before = H.count('net:playerLeft');
  const fid = [...H.net.players.keys()][0];
  F.ws.terminate(); // network drop, no bye
  await until(() => H.net.players.get(fid)?.away === true, 'away');
  assert.equal(H.count('net:playerLeft'), before);
  assert.equal(H.net.players.size, 1);
  const joinedBefore = H.count('net:playerJoined');
  const fw = F.welcome;
  F = await rawFriend();
  F.ws.send(encode(MSG.HELLO, { v: PROTOCOL_VERSION, name: 'Friend', room, resume: true, resumeId: fw.id, resumeToken: fw.token }));
  await until(() => H.net.players.get(fid)?.away === false, 'back');
  assert.equal(H.count('net:playerJoined'), joinedBefore + 1, 'net:playerJoined{resumed} so the host re-syncs');
  assert.equal(H.log.filter((e) => e.n === 'net:playerJoined').at(-1).p.resumed, true);
  F.ws.terminate(); // gone again (the server restarts next)
});

await step('several failed attempts across a server restart: back in with the same id, toasts not repeated', async () => {
  const id = H.net.id;
  await srv.close();
  await until(() => H.net.reconnecting, 'reconnecting after the restart');
  await sleep(2500); // a few attempts fail meanwhile
  assert.equal(H.net.connected, false);
  srv = await startServer({ ...opts, port: PORT });
  await until(() => H.net.connected, 'back after the restart', 15_000);
  assert.equal(H.net.id, id, 'id kept across the restart');
  assert.equal(H.net.room, room, 'same room code');
  assert.equal(H.net.isHost, true);
  assert.equal(H.toastCount(/Reconnecting/), 2, 'one per outage');
  assert.equal(H.toastCount(/Lost the connection/), 0);
  assert.equal(H.count('net:disconnected'), 0);
  assert.equal(H.net.players.size, 0, 'the friend (not back yet) is reconciled away');
});

await step('host hand-off: a client becomes host when the host leave()s, and leave() is immediate', async () => {
  const C = makeClient();
  C.net.join(room, 'Client', URL_);
  await until(() => C.net.connected && H.net.players.size === 1, 'client joined');
  assert.equal(C.net.isHost, false);
  const t0 = Date.now();
  H.net.leave();
  await until(() => C.net.players.size === 0 && C.net.isHost, 'client is host', 1000);
  assert.ok(Date.now() - t0 < GRACE / 2, 'no grace window for a leave');
  assert.ok(C.count('net:host') >= 1);
  assert.ok(C.count('net:playerLeft') >= 1);
  assert.equal(H.net.connected, false);
  assert.equal(H.net.reconnecting, false);
  assert.equal(H.count('net:disconnected'), 1, 'one net:disconnected for the real leave');
  await sleep(1200); // nothing reconnects after a leave
  assert.equal(H.net.connected, false);
  C.net.leave();
});

try {
  F?.ws.terminate();
} catch (_) {}
await srv.close();
console.log(`client tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
