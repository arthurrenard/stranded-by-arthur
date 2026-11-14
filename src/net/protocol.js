// Multiplayer protocol (V4-B): shared by the browser client (src/net/net.js) and the Node relay server
// (server/index.js). Plain JSON messages { t: <type>, ...fields } over one WebSocket. No DOM, no three.js,
// no dependencies, so it can be imported from both sides and unit-tested in node.
//
// Flow:  client  hello{name, room?, seed, difficulty, timeHours, v}
//        server  welcome{id, room, isHost, players:[{id,name}], seed, difficulty, timeHours, hostId}
//        client  state{pos:[x,y,z], yaw, pitch, state:{moving,sprinting,swimming,aboard,waving,torch}}  (tickHz)
//        server  snapshot{players:[{id, pos, yaw, pitch, state, ping}]}  (20 Hz, never includes the recipient)
//        client  event{name, payload}  → server relays event{name, payload, from} to everyone else in the room
//        client  chat{text}            → server relays chat{id, name, text} to everyone else (sanitized, 200 chars)
//        both    ping{ts} ↔ pong{ts}   (the server also uses its own pings to measure each player's RTT)
//        server  playerJoined{id,name} / playerLeft{id} / host{id} / error{code, message}

export const PROTOCOL_VERSION = 1;

export const MSG = Object.freeze({
  HELLO: 'hello',
  WELCOME: 'welcome',
  STATE: 'state',
  SNAPSHOT: 'snapshot',
  EVENT: 'event',
  CHAT: 'chat',
  PING: 'ping',
  PONG: 'pong',
  JOINED: 'playerJoined',
  LEFT: 'playerLeft',
  HOST: 'host',
  ERROR: 'error',
});

export const LIMITS = Object.freeze({
  nameChars: 16,
  chatChars: 200,
  roomChars: 6,
  messageBytes: 16 * 1024, // any single frame larger than this is dropped
  eventBytes: 4096, // serialized event payload
  stateHz: 30, // state updates accepted per second (the client sends CONFIG.net.tickHz = 15)
  eventsPerSec: 30,
  chatPerSec: 2,
  idleMs: 30_000, // a socket silent for this long is dropped
  pingMs: 5_000, // server → client keep-alive pings
  snapshotHz: 20,
  defaultMaxPlayers: 8,
  worldHalf: 5000, // positions beyond ±this are rejected
});

/** World events a client may relay to the room (SPEC §12). Anything else is dropped by the server. */
export const SHARED_EVENTS = Object.freeze([
  'harvest',
  'structure:placed',
  'fire:lit',
  'fire:out',
  'food:cooked',
  'raft:stage',
  'tree:fell',
  'flare:fired',
  'easter:found',
  'rescue:success',
  'raft:sailed',
  'time:set',
]);
/** Only the room host may send these. */
export const HOST_ONLY_EVENTS = Object.freeze(['time:set']);

export const ERRORS = Object.freeze({
  NO_ROOM: 'no_room', // join: unknown code
  ROOM_FULL: 'room_full',
  BAD_HELLO: 'bad_hello',
  VERSION: 'version', // protocol mismatch
  NOT_IN_ROOM: 'not_in_room',
});

// ── Encoding ─────────────────────────────────────────────────────────────
export function encode(type, fields) {
  return JSON.stringify(fields ? { t: type, ...fields } : { t: type });
}

/** Parse one frame. Returns the message object ({ t, ... }) or null when it is not a valid message. */
export function decode(raw) {
  if (typeof raw !== 'string') {
    if (raw == null) return null;
    try {
      raw = typeof raw.toString === 'function' ? raw.toString('utf8') : String(raw);
    } catch (_) {
      return null;
    }
  }
  if (raw.length === 0 || raw.length > LIMITS.messageBytes) return null;
  try {
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string' || m.t.length > 32) return null;
    return m;
  } catch (_) {
    return null;
  }
}

// ── Room codes ───────────────────────────────────────────────────────────
// 24 letters: no I/O (easy to confuse with 1/0 when read aloud).
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export function makeRoomCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < LIMITS.roomChars; i++) s += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length) % ROOM_ALPHABET.length];
  return s;
}

/** Upper-cases and trims; returns null unless the result is exactly 6 letters A–Z. */
export function normalizeRoomCode(s) {
  if (typeof s !== 'string') return null;
  const c = s.trim().toUpperCase();
  return /^[A-Z]{6}$/.test(c) ? c : null;
}

// ── Text sanitizing ──────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\ufeff]', 'g');

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(CONTROL, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function sanitizeName(s, fallback = 'Castaway') {
  const n = cleanText(s, LIMITS.nameChars);
  return n || fallback;
}

export function sanitizeChat(s) {
  return cleanText(s, LIMITS.chatChars);
}

// ── Validation ───────────────────────────────────────────────────────────
function num(v, lo = -1e9, hi = 1e9) {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}
function r3(v) {
  return Math.round(v * 1000) / 1000;
}

/** Normalize a client `state` message. Returns { pos:[x,y,z], yaw, pitch, state:{...} } or null. */
export function validateState(o) {
  if (!o || typeof o !== 'object') return null;
  const p = o.pos;
  const H = LIMITS.worldHalf;
  if (!Array.isArray(p) || p.length !== 3 || !num(p[0], -H, H) || !num(p[1], -H, H) || !num(p[2], -H, H)) return null;
  if (!num(o.yaw, -100, 100) || !num(o.pitch, -4, 4)) return null;
  const s = o.state && typeof o.state === 'object' ? o.state : {};
  return {
    pos: [r3(p[0]), r3(p[1]), r3(p[2])],
    yaw: r3(o.yaw),
    pitch: r3(o.pitch),
    state: {
      moving: !!s.moving,
      sprinting: !!s.sprinting,
      swimming: !!s.swimming,
      aboard: !!s.aboard,
      waving: !!s.waving,
      torch: !!s.torch,
    },
  };
}

/** Normalize a client `event` message. Returns { name, payload } or null. */
export function validateEvent(o) {
  if (!o || typeof o !== 'object' || typeof o.name !== 'string') return null;
  if (!SHARED_EVENTS.includes(o.name)) return null;
  let payload = o.payload;
  if (payload === undefined || payload === null) payload = {};
  if (typeof payload !== 'object' || Array.isArray(payload)) return null;
  let size = 0;
  try {
    size = JSON.stringify(payload).length;
  } catch (_) {
    return null;
  }
  if (size > LIMITS.eventBytes) return null;
  return { name: o.name, payload };
}

/** Normalize a `hello`. Returns { name, room|null, seed|null, difficulty|null, timeHours|null, v } or null. */
export function validateHello(o) {
  if (!o || typeof o !== 'object') return null;
  const v = typeof o.v === 'number' ? o.v : PROTOCOL_VERSION;
  return {
    name: sanitizeName(o.name),
    room: normalizeRoomCode(o.room),
    seed: num(o.seed) ? o.seed : null,
    difficulty: typeof o.difficulty === 'string' ? cleanText(o.difficulty, 16) || null : null,
    timeHours: num(o.timeHours, 0, 1e6) ? o.timeHours : null,
    v,
  };
}

// ── Ids & colors ─────────────────────────────────────────────────────────
export function hashString(s) {
  let h = 2166136261 >>> 0; // FNV-1a
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255);
  };
  return '#' + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Stable, readable name color for a player id (also used for the avatar's shirt). */
export function colorForId(id) {
  const h = hashString(id);
  return hslToHex(h % 360, 0.62, 0.6);
}

/** Short random id (8 chars, base36). */
export function makeId(rand = Math.random) {
  let s = '';
  while (s.length < 8) s += Math.floor(rand() * 36 ** 6).toString(36);
  return s.slice(0, 8);
}

// ── Rate limiting (token bucket) ─────────────────────────────────────────
export function createRateLimiter(perSec, burst = Math.max(1, Math.ceil(perSec))) {
  let tokens = burst;
  let last = 0;
  return {
    /** True when one more action is allowed at time `now` (ms). */
    allow(now = Date.now()) {
      if (last === 0) last = now;
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSec);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

/** Shortest signed angle from a to b (radians), for yaw interpolation. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
