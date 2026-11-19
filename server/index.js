#!/usr/bin/env node
// STRANDED: Driftwood Isle — multiplayer relay server (V4-B). Node 20+, the 'ws' package only, no database.
//
//   rooms by 6-letter code · host = first player in (re-elected when the host leaves) · welcome carries the
//   host's seed / difficulty / clock · 20 Hz snapshots of player states · event + chat relay (never echoed to
//   the sender, chat sanitized to 200 chars) · ≤ CONFIG.net.maxPlayers per room · PORT env (default 8787) ·
//   GET /health · graceful shutdown.
// V6 reliability (docs/MULTIPLAYER.md § Reliability):
//   · heartbeat: a WebSocket ping frame every HEARTBEAT_MS (15 s); a socket that neither answered a pong nor sent
//     a message for DEAD_MS (60 s) is dropped. Browsers answer ping frames themselves, even in a background tab,
//     so a hidden tab (no rAF → no state messages) stays connected. App-level ping{ts} every 5 s stays for RTT.
//   · grace-period resume: an unexpected close keeps the player in the room as disconnected for RESUME_GRACE_MS
//     (90 s): no playerLeft, no host migration, others get presence{id, connected:false}. hello{room, resumeId,
//     resumeToken} within the window re-attaches the same player (same id, host role kept; presence connected:true).
//     After the window: the normal leave + host migration. bye{} leaves at once.
//   · restart resume: hello{room, resume:true} for an unknown room re-creates it under the same code.
//
// Run:  cd server && npm install && node index.js        Test: node ../tests/net.test.mjs (from the repo root)
// The protocol module is shared with the browser client: ../src/net/protocol.js.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
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

const envMs = (k) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : 0);
const newToken = () => randomBytes(18).toString('base64url'); // 24 chars, only ever sent in that player's own welcome

/**
 * Start the relay. Resolves to { port, rooms, clients, httpServer, wss, close() }.
 * `port: 0` picks a free port (tests). Timings (ms): heartbeatMs / deadMs / graceMs, else the HEARTBEAT_MS /
 * DEAD_MS / RESUME_GRACE_MS env, else LIMITS.
 */
export async function startServer({
  port = Number(process.env.PORT) || 8787,
  host = '0.0.0.0',
  log = console.log,
  heartbeatMs = envMs('HEARTBEAT_MS') || LIMITS.heartbeatMs,
  deadMs = envMs('DEAD_MS') || LIMITS.deadMs,
  graceMs = envMs('RESUME_GRACE_MS') || LIMITS.resumeGraceMs,
} = {}) {
  const rooms = new Map(); // code -> { code, players: Map<id, client>, hostId, seed, difficulty, timeHours, timeAt, dirty }
  const clients = new Set(); // players with a live socket (+ sockets that have not said hello yet)
  const ids = new Set(); // every id in use, including disconnected players waiting in their grace window
  let closing = false; // shutting down: closes are final (no grace window)

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
    if (c.ws && c.ws.readyState === OPEN) c.ws.send(encode(type, fields));
  }
  function broadcast(room, type, fields, except = null) {
    const raw = encode(type, fields);
    for (const p of room.players.values()) if (p !== except && !p.disconnected && p.ws.readyState === OPEN) p.ws.send(raw);
  }
  function makeRoom(wanted = null) {
    let code = wanted && !rooms.has(wanted) ? wanted : null;
    while (!code || rooms.has(code)) code = makeRoomCode();
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
      // V6: the same player coming back (socket dropped, tab woke up, network switch) → re-attach, same id + role
      const prev = room && h.resumeId && h.resumeToken ? room.players.get(h.resumeId) : null;
      if (prev && prev !== c && prev.token === h.resumeToken) return resumePlayer(c, prev, h);
      // the server restarted (deploy, maintenance) and lost its in-memory rooms: a returning player brings the room back
      if (!room && h.resume) {
        room = makeRoom(h.room);
        // keep the old id too (avatars stay put on the other side) when nobody else uses it
        if (h.resumeId && !ids.has(h.resumeId)) {
          ids.delete(c.id);
          c.id = h.resumeId;
          ids.add(c.id);
        }
        log(`[net] ${h.name} resumed ${h.room} after a restart`);
      }
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
    const players = playerList(room, c);
    c.token = newToken();
    room.players.set(c.id, c);
    room.dirty = true; // the newcomer gets a snapshot of everyone on the next tick
    sendWelcome(c, room, players, false);
    broadcast(room, MSG.JOINED, { id: c.id, name: c.name }, c);
    log(`[net] ${c.name} (${c.id}) ${isHost ? 'created' : 'joined'} ${room.code} · ${room.players.size} player(s)`);
  }
  function playerList(room, except) {
    const out = [];
    for (const p of room.players.values()) if (p !== except) out.push({ id: p.id, name: p.name, connected: !p.disconnected });
    return out;
  }
  function sendWelcome(c, room, players, resumed) {
    send(c, MSG.WELCOME, {
      id: c.id,
      room: room.code,
      isHost: room.hostId === c.id,
      hostId: room.hostId,
      players,
      seed: room.seed,
      difficulty: room.difficulty,
      timeHours: roomTime(room),
      maxPlayers: MAX_PLAYERS,
      token: c.token,
      resumed,
    });
  }

  /** Move the fresh socket `c` (its hello just matched) onto the existing player record `prev`. */
  function resumePlayer(c, prev, h) {
    const room = prev.room;
    const oldWs = prev.ws;
    const wasDisconnected = !!prev.disconnected;
    clearTimeout(prev.graceTimer);
    prev.graceTimer = null;
    // the temporary record of this socket goes away; the socket now belongs to `prev`
    clients.delete(c);
    ids.delete(c.id);
    c.room = null;
    prev.ws = c.ws;
    c.ws.client = prev;
    prev.disconnected = false;
    prev.name = h.name;
    prev.ping = 0;
    prev.pingSentAt = 0;
    clients.add(prev);
    // a half-open old socket the server had not noticed yet: retire it quietly (its 'close' is ignored)
    if (oldWs && oldWs !== c.ws) {
      oldWs.client = null;
      try {
        oldWs.terminate();
      } catch (_) {}
    }
    room.dirty = true;
    sendWelcome(prev, room, playerList(room, prev), true);
    broadcast(room, MSG.PRESENCE, { id: prev.id, name: prev.name, connected: true }, prev);
    log(`[net] ${prev.name} (${prev.id}) resumed ${room.code}${wasDisconnected ? '' : ' (replaced a stale socket)'}${room.hostId === prev.id ? ' as host' : ''}`);
  }

  /** The socket of a player in a room closed without a bye: keep the player for the grace window. */
  function onDrop(c) {
    const room = c.room;
    if (!room || c.disconnected) return;
    c.disconnected = true;
    c.state = null; // no frozen pose in the snapshots meanwhile (the others keep the last one they got)
    broadcast(room, MSG.PRESENCE, { id: c.id, name: c.name, connected: false }, c);
    log(`[net] ${c.name} (${c.id}) dropped from ${room.code}: holding the slot ${Math.round(graceMs / 1000)} s`);
    c.graceTimer = setTimeout(() => {
      c.graceTimer = null;
      if (c.disconnected) onLeave(c);
    }, graceMs);
    c.graceTimer.unref?.();
  }

  /** The player leaves the room for good (bye, or the grace window ran out). */
  function onLeave(c) {
    clearTimeout(c.graceTimer);
    c.graceTimer = null;
    const room = c.room;
    if (c.disconnected) ids.delete(c.id); // its socket is long gone
    if (!room) return;
    c.room = null;
    room.players.delete(c.id);
    log(`[net] ${c.name} (${c.id}) left ${room.code} · ${room.players.size} player(s)`);
    if (room.players.size === 0) return void rooms.delete(room.code);
    broadcast(room, MSG.LEFT, { id: c.id });
    if (room.hostId === c.id) {
      let next = null;
      for (const p of room.players.values()) if (!p.disconnected) { next = p; break; }
      next = next || room.players.values().next().value; // everyone is reconnecting: the first one back still hosts
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
      case MSG.BYE:
        return onLeave(c); // an intentional leave: no grace window

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
    ws.client = c; // re-pointed when a resume hands this socket to an existing player
    ws.lastAlive = Date.now();
    ws.on('pong', () => (ws.lastAlive = Date.now()));
    ws.on('message', (data, isBinary) => {
      ws.lastAlive = Date.now();
      if (!isBinary && ws.client) onMessage(ws.client, data);
    });
    ws.on('close', () => {
      const p = ws.client;
      ws.client = null;
      if (!p || p.ws !== ws) return; // a socket replaced by a resume
      clients.delete(p);
      if (p.room && !closing) return onDrop(p); // unexpected: hold the player for the grace window
      ids.delete(p.id);
      onLeave(p);
    });
    ws.on('error', () => {});
  });

  // ── Timers: snapshots (20 Hz), keep-alive + idle drop (every 5 s) ──────
  const snapTimer = setInterval(() => {
    for (const room of rooms.values()) {
      if (!room.dirty || room.players.size < 2) continue;
      room.dirty = false;
      for (const c of room.players.values()) {
        if (c.disconnected || c.ws.readyState !== OPEN) continue;
        const players = [];
        for (const p of room.players.values()) {
          if (p === c || !p.state || p.disconnected) continue;
          players.push({ id: p.id, pos: p.state.pos, yaw: p.state.yaw, pitch: p.state.pitch, state: p.state.state, ping: p.ping });
        }
        if (players.length) c.ws.send(encode(MSG.SNAPSHOT, { players, ts: Date.now() }));
      }
    }
  }, Math.round(1000 / LIMITS.snapshotHz));

  // app-level pings: RTT for the player list + a steady inbound stream the client uses to spot a dead socket
  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const c of clients) {
      if (c.ws.readyState === OPEN) {
        c.pingSentAt = now;
        c.ws.send(encode(MSG.PING, { ts: now }));
      }
    }
  }, LIMITS.pingMs);

  // WebSocket-level heartbeat: alive = answered a ping frame or sent anything within deadMs
  const beatTimer = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (now - (ws.lastAlive || 0) > deadMs) {
        const p = ws.client;
        log(`[net] dropping dead socket${p ? ` of ${p.name} (${p.id})` : ''}`);
        ws.terminate(); // 'close' → grace window
        continue;
      }
      if (ws.readyState === OPEN) {
        try {
          ws.ping();
        } catch (_) {}
      }
    }
  }, heartbeatMs);

  function close() {
    closing = true;
    clearInterval(snapTimer);
    clearInterval(pingTimer);
    clearInterval(beatTimer);
    for (const room of rooms.values()) for (const p of room.players.values()) clearTimeout(p.graceTimer);
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
