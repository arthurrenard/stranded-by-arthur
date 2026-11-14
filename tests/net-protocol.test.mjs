// Unit tests for the pure multiplayer protocol helpers (src/net/protocol.js). Run: node tests/net-protocol.test.mjs
// No sockets and no 'ws' (that lives in server/node_modules only); the live server is covered by server/test.mjs.
import assert from 'node:assert/strict';
import {
  MSG,
  LIMITS,
  SHARED_EVENTS,
  ROOM_ALPHABET,
  encode,
  decode,
  makeRoomCode,
  normalizeRoomCode,
  sanitizeName,
  sanitizeChat,
  validateState,
  validateEvent,
  validateHello,
  colorForId,
  makeId,
  createRateLimiter,
  angleDelta,
} from '../src/net/protocol.js';

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

test('encode/decode round trip', () => {
  const s = encode(MSG.STATE, { pos: [1.5, 2, -3], yaw: 0.25, state: { moving: true } });
  assert.equal(typeof s, 'string');
  assert.deepEqual(decode(s), { t: 'state', pos: [1.5, 2, -3], yaw: 0.25, state: { moving: true } });
  assert.deepEqual(decode(encode(MSG.PING)), { t: 'ping' });
  assert.deepEqual(decode(Buffer.from(encode(MSG.CHAT, { text: 'hé ☀' }))), { t: 'chat', text: 'hé ☀' });
  assert.equal(decode(encode(MSG.EVENT, { name: 'harvest', payload: { rid: 'bush:1' } })).payload.rid, 'bush:1');
});

test('decode rejects malformed frames', () => {
  for (const bad of ['', 'nope', '{', '[]', '[1,2]', 'null', '42', '{"x":1}', '{"t":5}', JSON.stringify({ t: 'x'.repeat(33) })])
    assert.equal(decode(bad), null, bad);
  assert.equal(decode(null), null);
  assert.equal(decode(undefined), null);
  assert.equal(decode('{"t":"chat","text":"' + 'a'.repeat(LIMITS.messageBytes) + '"}'), null);
});

test('room codes: 6 letters from the alphabet without I/O', () => {
  assert.equal(ROOM_ALPHABET.length, 24);
  assert.ok(!ROOM_ALPHABET.includes('I') && !ROOM_ALPHABET.includes('O'));
  for (let i = 0; i < 500; i++) {
    const c = makeRoomCode();
    assert.equal(c.length, LIMITS.roomChars);
    for (const ch of c) assert.ok(ROOM_ALPHABET.includes(ch), c);
  }
  assert.equal(makeRoomCode(() => 0), 'AAAAAA');
  assert.equal(makeRoomCode(() => 0.999999), 'ZZZZZZ');
  assert.equal(normalizeRoomCode(' kqwrtd '), 'KQWRTD');
  for (const bad of ['ABCDE', 'ABCDEFG', 'ABC1EF', 'AB CDE', '', null, 42, undefined]) assert.equal(normalizeRoomCode(bad), null, String(bad));
});

test('sanitizeName: controls and <> stripped, 16 chars, fallback', () => {
  assert.equal(sanitizeName('  <Alice>\n '), 'Alice');
  assert.equal(sanitizeName('Bo\u0000b​'), 'Bob');
  assert.equal(sanitizeName('x'.repeat(40)).length, LIMITS.nameChars);
  assert.equal(sanitizeName(''), 'Castaway');
  assert.equal(sanitizeName('<>'), 'Castaway');
  assert.equal(sanitizeName(null), 'Castaway');
  assert.equal(sanitizeName(5, 'Anon'), 'Anon');
});

test('sanitizeChat: controls and <> stripped, whitespace collapsed, 200 chars', () => {
  assert.equal(sanitizeChat('<script>alert(1)</script>'), 'scriptalert(1)/script');
  assert.equal(sanitizeChat(' hi \u0007  there\t\n'), 'hi there');
  assert.equal(sanitizeChat('a b﻿'), 'ab');
  assert.equal(sanitizeChat('y'.repeat(500)).length, LIMITS.chatChars);
  assert.equal(sanitizeChat('   '), '');
  assert.equal(sanitizeChat({}), '');
});

test('validateState: normalizes and rejects bad shapes', () => {
  const s = validateState({ pos: [1.23456, 2, 3], yaw: 1.00049, pitch: 0.2, state: { moving: 1, torch: 'yes', extra: true } });
  assert.deepEqual(s, {
    pos: [1.235, 2, 3],
    yaw: 1,
    pitch: 0.2,
    state: { moving: true, sprinting: false, swimming: false, aboard: false, waving: false, torch: true },
  });
  assert.equal(validateState({ pos: [0, 0, 0], yaw: 0, pitch: 0 }).state.moving, false);
  const bad = [
    null,
    {},
    { pos: [0, 0], yaw: 0, pitch: 0 },
    { pos: [0, 0, NaN], yaw: 0, pitch: 0 },
    { pos: [LIMITS.worldHalf + 1, 0, 0], yaw: 0, pitch: 0 },
    { pos: ['1', 0, 0], yaw: 0, pitch: 0 },
    { pos: [0, 0, 0], yaw: Infinity, pitch: 0 },
    { pos: [0, 0, 0], yaw: 0, pitch: 9 },
    { pos: [0, 0, 0], pitch: 0 },
  ];
  for (const b of bad) assert.equal(validateState(b), null, JSON.stringify(b));
});

test('validateEvent: only shared events, object payloads under 4 KB', () => {
  assert.deepEqual(validateEvent({ name: 'harvest', payload: { rid: 'bush:2' } }), { name: 'harvest', payload: { rid: 'bush:2' } });
  assert.deepEqual(validateEvent({ name: 'raft:stage' }), { name: 'raft:stage', payload: {} });
  for (const n of SHARED_EVENTS) assert.ok(validateEvent({ name: n, payload: {} }), n);
  assert.ok(validateEvent({ name: 'time:set', payload: { hoursTotal: 3 } }), 'time:set passes (host-only is enforced by the server)');
  assert.equal(validateEvent({ name: 'cheat:win', payload: {} }), null);
  assert.equal(validateEvent({ name: 42 }), null);
  assert.equal(validateEvent({ name: 'harvest', payload: [1] }), null);
  assert.equal(validateEvent({ name: 'harvest', payload: 'x' }), null);
  assert.equal(validateEvent({ name: 'harvest', payload: { s: 'x'.repeat(LIMITS.eventBytes) } }), null);
  const circ = {};
  circ.self = circ;
  assert.equal(validateEvent({ name: 'harvest', payload: circ }), null);
  assert.equal(validateEvent(null), null);
});

test('validateHello: sanitized fields', () => {
  const h = validateHello({ name: '<Zoé>', room: 'abcdef', seed: 42, difficulty: 'hard', timeHours: 12.5, v: 1 });
  assert.deepEqual(h, { name: 'Zoé', room: 'ABCDEF', seed: 42, difficulty: 'hard', timeHours: 12.5, v: 1 });
  const e = validateHello({});
  assert.equal(e.name, 'Castaway');
  assert.equal(e.room, null);
  assert.equal(e.timeHours, null);
  assert.equal(validateHello({ timeHours: -1 }).timeHours, null);
  assert.equal(validateHello(null), null);
});

test('colorForId: stable #rrggbb', () => {
  const c = colorForId('abc12345');
  assert.match(c, /^#[0-9a-f]{6}$/);
  assert.equal(colorForId('abc12345'), c);
  assert.match(colorForId(''), /^#[0-9a-f]{6}$/);
});

test('makeId: 8 chars base36', () => {
  for (let i = 0; i < 100; i++) assert.match(makeId(), /^[0-9a-z]{8}$/);
});

test('rate limiter: burst then refill', () => {
  const r = createRateLimiter(2, 4);
  let ok = 0;
  for (let i = 0; i < 10; i++) if (r.allow(1000)) ok++;
  assert.equal(ok, 4);
  assert.equal(r.allow(1400), false);
  assert.equal(r.allow(1600), true); // 0.6 s × 2/s = 1.2 tokens
});

test('angleDelta: shortest signed turn', () => {
  assert.ok(Math.abs(angleDelta(0, Math.PI / 2) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(angleDelta(3, -3) - (2 * Math.PI - 6)) < 1e-9);
  assert.ok(Math.abs(angleDelta(-3, 3) + (2 * Math.PI - 6)) < 1e-9);
});

console.log(`net-protocol: ${passed} tests passed`);
