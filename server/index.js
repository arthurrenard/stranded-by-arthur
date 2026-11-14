#!/usr/bin/env node
// STRANDED: Driftwood Isle — multiplayer relay server (V4-B). Node 20+, the 'ws' package only, no database.
//
//   rooms by 6-letter code · host = first player in (re-elected when the host leaves) · welcome carries the
//   host's seed / difficulty / clock · 20 Hz snapshots of player states · event + chat relay (never echoed to
//   the sender, chat sanitized to 200 chars) · ping/pong keep-alive, idle sockets dropped after 30 s ·
//   ≤ CONFIG.net.maxPlayers per room · PORT env (default 8787) · GET /health · graceful shutdown.
//
// Run:  cd server && npm install && node index.js        Test: node ../tests/net.test.mjs (from the repo root)
// The protocol module is shared with the browser client: ../src/net/protocol.js.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { CONFIG } from '../src/config.js';
import {
  MSG,
  LIMITS,
  ERRORS,
  PROTOCOL_VERSION,
  HOST_ONLY_EVENTS,
  encode,
  decode,
  makeRoomCode,
  makeId,
  sanitizeChat,
  validateState,
  validateEvent,
  validateHello,
  createRateLimiter,
} from '../src/net/protocol.js';

const OPEN = WebSocket.OPEN;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || CONFIG?.net?.maxPlayers || LIMITS.defaultMaxPlayers;
const HOURS_PER_SEC = 24 / (CONFIG?.time?.dayLengthSec || 720);

/**
 * Start the relay. Resolves to { port, rooms, clients, httpServer, wss, close() }.
 * `port: 0` picks a free port (tests).
 */
export async function startServer({ port = Number(process.env.PORT) || 8787, host = '0.0.0.0', log = console.log } = {}) {
  const rooms = new Map(); // code -> { code, players: Map<id, client>, hostId, seed, difficulty, timeHours, timeAt, dirty }
  const clients = new Set();
  const ids = new Set();

  // ── HTTP (health) ──────────────────────────────────────────────────────
  const httpServer = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/health' || url === '/') {
      let players = 0;
      for (const r of rooms.values()) players += r.players.size;
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, players, sockets: clients.size, maxPlayers: MAX_PLAYERS, uptime: Math.round(process.uptime()) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: LIMITS.messageBytes, perMessageDeflate: false });

  // ── Helpers ────────────────────────────────────────────────────────────
  function send(c, type, fields) {
    if (c.ws.readyState === OPEN) c.ws.send(encode(type, fields));
  }
  function broadcast(room, type, fields, except = null) {
    const raw = encode(type, fields);
    for (const p of room.players.values()) if (p !== except && p.ws.readyState === OPEN) p.ws.send(raw);
  }
  function makeRoom() {
    let code;
    do code = makeRoomCode();
    while (rooms.has(code));
    const room = { code, players: new Map(), hostId: null, seed: null, difficulty: null, timeHours: null, timeAt: 0, dirty: false };
    rooms.set(code, room);
    return room;
  }
  /** The host's clock extrapolated to now (the host corrects it with time:set every ~10 s anyway). */
  function roomTime(room) {
    if (room.timeHours == null) return null;
    return room.timeHours + ((Date.now() - room.timeAt) / 1000) * HOURS_PER_SEC;
  }

  // ── Message handling ───────────────────────────────────────────────────
  function onHello(c, m) {
    if (c.room) return;
    const h = validateHello(m);
    if (!h) return send(c, MSG.ERROR, { code: ERRORS.BAD_HELLO, message: 'Malformed hello.' });
    if (h.v !== PROTOCOL_VERSION) {
      send(c, MSG.ERROR, { code: ERRORS.VERSION, message: `Protocol v${h.v} not supported (server speaks v${PROTOCOL_VERSION}).` });
      return c.ws.close(1002, 'protocol version');
    }
    let room;
    if (h.room) {
      room = rooms.get(h.room);
      if (!room) return send(c, MSG.ERROR, { code: ERRORS.NO_ROOM, message: `No session ${h.room}.` });
      if (room.players.size >= MAX_PLAYERS) return send(c, MSG.ERROR, { code: ERRORS.ROOM_FULL, message: `Session ${h.room} is full.` });
    } else room = makeRoom();
    c.name = h.name;
    c.room = room;
    const isHost = room.players.size === 0;
    if (isHost) {
      room.hostId = c.id;
      room.seed = h.seed;
      room.difficulty = h.difficulty;
      room.timeHours = h.timeHours;
      room.timeAt = Date.now();
    }
    const players = [...room.players.values()].map((p) => ({ id: p.id, name: p.name }));
    room.players.set(c.id, c);
    room.dirty = true; // the newcomer gets a snapshot of everyone on the next tick
    send(c, MSG.WELCOME, {
      id: c.id,
      room: room.code,
      isHost,
      hostId: room.hostId,
      players,
      seed: room.seed,
      difficulty: room.difficulty,
      timeHours: roomTime(room),
      maxPlayers: MAX_PLAYERS,
    });
    broadcast(room, MSG.JOINED, { id: c.id, name: c.name }, c);
    log(`[net] ${c.name} (${c.id}) ${isHost ? 'created' : 'joined'} ${room.code} · ${room.players.size} player(s)`);
  }

  function onLeave(c) {
    const room = c.room;
    if (!room) return;
    c.room = null;
    room.players.delete(c.id);
    log(`[net] ${c.name} (${c.id}) left ${room.code} · ${room.players.size} player(s)`);
    if (room.players.size === 0) return void rooms.delete(room.code);
    broadcast(room, MSG.LEFT, { id: c.id });
    if (room.hostId === c.id) {
      const next = room.players.values().next().value;
      room.hostId = next.id;
      broadcast(room, MSG.HOST, { id: next.id, name: next.name });
      log(`[net] ${next.name} (${next.id}) now hosts ${room.code}`);
    }
  }

  function onMessage(c, raw) {
    c.lastSeen = Date.now();
    const m = decode(raw);
    if (!m) return;
    switch (m.t) {
      case MSG.HELLO:
        return onHello(c, m);
      case MSG.PING:
        return send(c, MSG.PONG, { ts: typeof m.ts === 'number' ? m.ts : null, now: Date.now() });
      case MSG.PONG:
        if (c.pingSentAt && m.ts === c.pingSentAt) {
          c.ping = Date.now() - c.pingSentAt;
          c.pingSentAt = 0;
        }
        return;
      case MSG.STATE: {
        if (!c.room || !c.stateRate.allow()) return;
        const s = validateState(m);
        if (!s) return;
        c.state = s;
        c.room.dirty = true;
        return;
      }
      case MSG.EVENT: {
        const room = c.room;
        if (!room || !c.eventRate.allow()) return;
        const e = validateEvent(m);
        if (!e) return;
        if (HOST_ONLY_EVENTS.includes(e.name) && room.hostId !== c.id) return;
        if (e.name === 'time:set' && typeof e.payload.hoursTotal === 'number' && Number.isFinite(e.payload.hoursTotal)) {
          room.timeHours = e.payload.hoursTotal;
          room.timeAt = Date.now();
        }
        broadcast(room, MSG.EVENT, { name: e.name, payload: e.payload, from: c.id }, c);
        return;
      }
      case MSG.CHAT: {
        if (!c.room || !c.chatRate.allow()) return;
        const text = sanitizeChat(m.text);
        if (!text) return;
        broadcast(c.room, MSG.CHAT, { id: c.id, name: c.name, text }, c);
        return;
      }
      default:
        return;
    }
  }

  wss.on('connection', (ws) => {
    let id = makeId();
    while (ids.has(id)) id = makeId();
    ids.add(id);
    const c = {
      id,
      ws,
      name: 'Castaway',
      room: null,
      state: null,
      ping: 0,
      lastSeen: Date.now(),
      pingSentAt: 0,
      stateRate: createRateLimiter(LIMITS.stateHz, LIMITS.stateHz * 2),
      eventRate: createRateLimiter(LIMITS.eventsPerSec, LIMITS.eventsPerSec),
      chatRate: createRateLimiter(LIMITS.chatPerSec, 4),
    };
    clients.add(c);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) onMessage(c, data);
    });
    ws.on('close', () => {
      clients.delete(c);
      ids.delete(c.id);
      onLeave(c);
    });
    ws.on('error', () => {});
  });

  // ── Timers: snapshots (20 Hz), keep-alive + idle drop (every 5 s) ──────
  const snapTimer = setInterval(() => {
    for (const room of rooms.values()) {
      if (!room.dirty || room.players.size < 2) continue;
      room.dirty = false;
      for (const c of room.players.values()) {
        if (c.ws.readyState !== OPEN) continue;
        const players = [];
        for (const p of room.players.values()) {
          if (p === c || !p.state) continue;
          players.push({ id: p.id, pos: p.state.pos, yaw: p.state.yaw, pitch: p.state.pitch, state: p.state.state, ping: p.ping });
        }
        if (players.length) c.ws.send(encode(MSG.SNAPSHOT, { players, ts: Date.now() }));
      }
    }
  }, Math.round(1000 / LIMITS.snapshotHz));

  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const c of clients) {
      if (now - c.lastSeen > LIMITS.idleMs) {
        log(`[net] dropping idle ${c.name} (${c.id})`);
        c.ws.terminate(); // 'close' → onLeave
        continue;
      }
      if (c.ws.readyState === OPEN) {
        c.pingSentAt = now;
        c.ws.send(encode(MSG.PING, { ts: now }));
      }
    }
  }, LIMITS.pingMs);

  function close() {
    clearInterval(snapTimer);
    clearInterval(pingTimer);
    for (const c of clients) {
      try {
        c.ws.close(1001, 'server shutting down');
      } catch (_) {}
    }
    return new Promise((resolve) => {
      wss.close(() => httpServer.close(() => resolve()));
      setTimeout(() => {
        for (const c of clients) c.ws.terminate();
        resolve();
      }, 1500).unref();
    });
  }

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });
  return { port: httpServer.address().port, rooms, clients, httpServer, wss, close };
}

// ── CLI entry ────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const srv = await startServer();
  console.log(`[net] STRANDED relay listening on :${srv.port} (max ${MAX_PLAYERS} players/room) · GET /health`);
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[net] ${sig}: shutting down…`);
    srv.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
