// Multiplayer client (V4-B, SPEC §12): ctx.net. Fully optional: with no server configured (CONFIG.net.defaultServer
// and ?server= empty) init() only shows the pause-menu panel (#mp) and nothing else happens.
//
//   ctx.net = { mode:'offline'|'host'|'client', connected, id, name, room, isHost, hostId, ping,
//               players: Map<id,{ id, name, color, pos:Vector3, yaw, pitch, state:{moving,sprinting,swimming,aboard,waving,torch}, ping, avatar }>,
//               create(name, server), join(code, name, server), leave(), send(type, payload), on(type, fn), chat(text) }
//   Events out: net:connected {id, room, isHost} · net:disconnected · net:playerJoined {id,name} · net:playerLeft {id}
//               net:chat {id, name, text, self} · net:host {id}
//
// Shared world: the host's clock is authoritative ('time:set' every 10 s; joiners nudge ctx.time.timeScale for a few
// seconds, or hard-set when the error exceeds 2 game minutes); the host's difficulty wins (ctx.debug.difficulty(id));
// the SHARED_EVENTS of protocol.js are relayed and applied remotely under a module-level `applying` guard so applied
// events never re-send. Remote players are drawn with src/player/avatar.js, buffered CONFIG.net.interpolationMs back.
// The chat + player list live in ./netUI.js (loaded lazily so this module imports cleanly in node).
import { CONFIG } from '../config.js';
import { MSG, ERRORS, PROTOCOL_VERSION, SHARED_EVENTS, encode, decode, normalizeRoomCode, sanitizeName, sanitizeChat, colorForId } from './protocol.js';
import { createAvatar } from '../player/avatar.js';

/** Module-level loop guard: true while a relayed event is being applied locally (listeners must not re-send). */
let applying = false;
export const isApplying = () => applying;

const LS_NAME = 'stranded.mp.name';
const LS_SERVER = 'stranded.mp.server';
const RECONNECT_BASE_MS = 1000, RECONNECT_MAX_MS = 30_000, RECONNECT_TRIES = 8, CONNECT_TIMEOUT_MS = 8000;
const CLOCK_SEND_SEC = 10, CLOCK_HARD_H = 2 / 60, CLOCK_SOFT_SEC = 4, CLOCK_EPS_H = 0.0015, CLOCK_MAX_SCALE = 8;
const PING_SEC = 2, HEARTBEAT_SEC = 3, PANEL_REFRESH_SEC = 1;
const WIN_EVENTS = ['rescue:success', 'raft:sailed'];
const LABEL = { campfire: 'campfire', signal_fire: 'signal fire', shelter: 'shelter', sos: 'SOS sign' };

function lsGet(k) {
  try {
    return localStorage.getItem(k) || '';
  } catch (_) {
    return '';
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch (_) {}
}
/** 'host:port' → ws(s)://…, http(s) → ws(s), trailing slashes removed. '' stays ''. */
export function normalizeServer(s) {
  s = (s || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, 'ws');
  else if (!/^wss?:\/\//i.test(s)) s = (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|\d+\.\d+\.\d+\.\d+)/i.test(s) ? 'ws://' : 'wss://') + s;
  return s.replace(/\/+$/, '');
}
const r2 = (v) => Math.round(v * 100) / 100;
const vec = (p) => (p && typeof p.x === 'number' ? [r2(p.x), r2(p.y || 0), r2(p.z)] : Array.isArray(p) ? p.slice(0, 3) : null);

export function create(ctx) {
  const ev = ctx.events;
  const V3 = ctx.THREE?.Vector3;
  const params = ctx.params || new URLSearchParams();
  const hasDOM = typeof document !== 'undefined';

  const handlers = new Map(); // incoming message type -> Set<fn>
  const players = new Map();
  const api = {
    mode: 'offline',
    connected: false,
    id: null,
    name: 'Castaway',
    room: null,
    isHost: false,
    hostId: null,
    server: '',
    ping: 0,
    status: 'offline',
    players,
    create: createRoom,
    join,
    leave,
    send,
    on,
    chat,
    init,
    update,
    isApplying,
    colorFor: colorForId,
  };

  let ws = null, want = null, intentional = false, attempts = 0, connectTimer = 0, reconnectTimer = 0;
  let ui = null; // ./netUI.js instance
  const els = {};
  let panelDirty = true, panelAcc = 0;

  const toast = (text, opts) => ctx.ui?.toast?.(text, { icon: '🌐', kind: 'info', duration: 4, ...(opts || {}) });
  const nameOf = (id) => (id === api.id ? api.name : players.get(id)?.name || 'Someone');

  // ── Players / avatars ──────────────────────────────────────────────────
  function addPlayer(id, name) {
    if (!id || id === api.id) return null;
    let p = players.get(id);
    if (p) {
      if (name && name !== p.name) {
        p.name = name;
        p.avatar?.setName(name);
      }
      return p;
    }
    p = {
      id,
      name: sanitizeName(name),
      color: colorForId(id),
      pos: V3 ? new V3() : { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      state: { moving: false, sprinting: false, swimming: false, aboard: false, waving: false, torch: false },
      ping: 0,
      avatar: null,
    };
    players.set(id, p);
    panelDirty = true;
    return p;
  }
  function removePlayer(id) {
    const p = players.get(id);
    if (!p) return;
    p.avatar?.dispose();
    players.delete(id);
    panelDirty = true;
  }
  function ensureAvatar(p) {
    if (p.avatar || !ctx.scene || !ctx.THREE) return p.avatar;
    try {
      p.avatar = createAvatar(ctx, { name: p.name, color: p.color, id: p.id });
      ctx.scene.add(p.avatar.object);
    } catch (e) {
      console.warn('[net] avatar failed', e);
    }
    return p.avatar;
  }
  function applySnapshot(list) {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (!s || s.id === api.id) continue;
      const p = addPlayer(s.id, s.name);
      if (!p || !Array.isArray(s.pos)) continue;
      p.pos.x = s.pos[0];
      p.pos.y = s.pos[1];
      p.pos.z = s.pos[2];
      p.yaw = s.yaw || 0;
      p.pitch = s.pitch || 0;
      if (s.state) Object.assign(p.state, s.state);
      if (typeof s.ping === 'number') p.ping = s.ping;
      ensureAvatar(p)?.setTarget(p.pos, p.yaw, p.pitch, p.state);
    }
  }

  // ── Status / panel ─────────────────────────────────────────────────────
  function statusText() {
    if (api.connected) {
      const n = players.size + 1;
      return `in room ${api.room}${api.isHost ? ' (host)' : ''} · ${n} player${n === 1 ? '' : 's'}`;
    }
    return want ? 'connecting…' : 'offline';
  }
  function refreshPanel() {
    api.status = statusText();
    if (els.status) els.status.textContent = api.status;
    const busy = !!want;
    els.leave?.classList.toggle('hidden', !busy);
    els.create?.classList.toggle('hidden', busy);
    els.join?.classList.toggle('hidden', busy);
    if (els.room) els.room.classList.toggle('hidden', busy);
    if (els.players) {
      if (!api.connected) els.players.textContent = '';
      else {
        const rows = [`${api.name} (you)${api.isHost ? ' 👑' : ''}`];
        for (const p of players.values()) rows.push(`${p.name}${p.id === api.hostId ? ' 👑' : ''}${p.ping ? ` · ${p.ping} ms` : ''}`);
        els.players.textContent = rows.join('   ·   ');
      }
    }
    panelDirty = false;
  }
  function setOffline() {
    api.mode = 'offline';
    api.connected = false;
    api.isHost = false;
    api.hostId = null;
    api.room = null;
    api.id = null;
    clock.err = 0;
    restoreScale();
    refreshPanel();
  }
  function updateUrl(room) {
    if (!hasDOM || typeof history === 'undefined' || !history.replaceState) return;
    try {
      const u = new URL(location.href);
      if (room) {
        u.searchParams.set('room', room);
        if (want?.server) u.searchParams.set('server', want.server);
      } else u.searchParams.delete('room');
      history.replaceState(null, '', u.toString());
    } catch (_) {}
  }

  // ── Socket ─────────────────────────────────────────────────────────────
  function send(type, fields) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(encode(type, fields));
      return true;
    } catch (_) {
      return false;
    }
  }
  function on(type, fn) {
    let set = handlers.get(type);
    if (!set) handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
  function closeSocket() {
    clearTimeout(connectTimer);
    clearTimeout(reconnectTimer);
    const sock = ws;
    ws = null;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try {
        sock.close(1000, 'leave');
      } catch (_) {}
    }
  }
  function dropRoom(silent) {
    const was = api.connected;
    for (const p of players.values()) p.avatar?.dispose();
    players.clear();
    api.connected = false;
    if (was && !silent) {
      ev.emit('net:disconnected', {});
      ui?.system?.('Disconnected.');
    }
    panelDirty = true;
  }
  function openSocket() {
    if (!want || typeof WebSocket === 'undefined') return setOffline();
    closeSocket();
    refreshPanel();
    let sock;
    try {
      sock = new WebSocket(want.server);
    } catch (e) {
      toast(`Bad server address: ${want.server}`, { kind: 'bad' });
      want = null;
      return setOffline();
    }
    ws = sock;
    connectTimer = setTimeout(() => {
      if (sock === ws && !api.connected) {
        try {
          sock.close();
        } catch (_) {}
      }
    }, CONNECT_TIMEOUT_MS);
    sock.onopen = () => {
      clearTimeout(connectTimer);
      send(MSG.HELLO, {
        name: want.name,
        room: want.room || undefined,
        seed: CONFIG.seed,
        difficulty: ctx.difficulty?.id,
        timeHours: ctx.time?.hoursTotal,
        v: PROTOCOL_VERSION,
      });
    };
    sock.onmessage = (e) => {
      if (sock !== ws) return;
      const m = decode(e.data);
      if (m) handle(m);
    };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (sock !== ws) return;
      clearTimeout(connectTimer);
      ws = null;
      const wasConnected = api.connected;
      dropRoom(false);
      if (intentional || !want) return setOffline();
      scheduleReconnect(wasConnected);
    };
  }
  function scheduleReconnect(wasConnected) {
    attempts++;
    api.connected = false;
    api.mode = 'offline';
    if (attempts > RECONNECT_TRIES) {
      toast('Lost the connection to the session.', { kind: 'bad' });
      want = null;
      updateUrl(null);
      return setOffline();
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempts - 1)) * (0.8 + Math.random() * 0.4);
    if (attempts === 1) toast(wasConnected ? 'Connection lost. Reconnecting…' : 'Connecting…', { kind: 'warn', key: 'net-conn' });
    refreshPanel();
    reconnectTimer = setTimeout(openSocket, delay);
  }

  function start(room, name, server) {
    const url = normalizeServer(server) || normalizeServer(els.server?.value) || normalizeServer(params.get('server')) || normalizeServer(CONFIG.net?.defaultServer);
    if (!url) {
      toast('No multiplayer server set. Enter one (wss://…) in the pause menu.', { kind: 'warn' });
      return false;
    }
    api.name = sanitizeName(name || els.name?.value || params.get('name') || lsGet(LS_NAME));
    api.server = url;
    lsSet(LS_NAME, api.name);
    lsSet(LS_SERVER, url);
    if (els.name) els.name.value = api.name;
    if (els.server) els.server.value = url;
    intentional = false;
    attempts = 0;
    if (ws || api.connected) {
      dropRoom(true);
      closeSocket();
    }
    want = { server: url, room: room || null, name: api.name };
    openSocket();
    return true;
  }
  function createRoom(name, server) {
    return start(null, name, server);
  }
  function join(code, name, server) {
    const c = normalizeRoomCode(code || els.room?.value || '');
    if (!c) {
      toast('Enter the 6-letter room code.', { kind: 'warn' });
      return false;
    }
    return start(c, name, server);
  }
  function leave() {
    const was = api.connected || !!want;
    intentional = true;
    want = null;
    dropRoom(true);
    closeSocket();
    setOffline();
    updateUrl(null);
    if (was) {
      ev.emit('net:disconnected', {});
      toast('Left the session.');
    }
  }
  function chat(text) {
    const t = sanitizeChat(text);
    if (!t || !api.connected) return false;
    if (!send(MSG.CHAT, { text: t })) return false;
    ev.emit('net:chat', { id: api.id, name: api.name, text: t, self: true });
    return true;
  }

  // ── Incoming ───────────────────────────────────────────────────────────
  function handle(m) {
    switch (m.t) {
      case MSG.WELCOME:
        onWelcome(m);
        break;
      case MSG.JOINED: {
        const p = addPlayer(m.id, m.name);
        if (p) {
          ev.emit('net:playerJoined', { id: p.id, name: p.name });
          ui?.system?.(`${p.name} joined.`);
          toast(`${p.name} joined the session.`, { key: 'net-join' });
        }
        break;
      }
      case MSG.LEFT: {
        const p = players.get(m.id);
        if (p) {
          ui?.system?.(`${p.name} left.`);
          removePlayer(m.id);
          ev.emit('net:playerLeft', { id: m.id });
        }
        break;
      }
      case MSG.HOST:
        api.hostId = m.id;
        api.isHost = m.id === api.id;
        api.mode = api.isHost ? 'host' : 'client';
        if (api.isHost) {
          toast('You are now the host: your clock and difficulty lead.', { kind: 'good' });
          clock.err = 0;
          restoreScale();
        } else ui?.system?.(`${nameOf(m.id)} is now the host.`);
        ev.emit('net:host', { id: m.id });
        panelDirty = true;
        break;
      case MSG.SNAPSHOT:
        applySnapshot(m.players);
        panelAcc += 0.34; // pings changed: refresh the pause panel a bit sooner
        break;
      case MSG.EVENT:
        if (typeof m.name === 'string') applyRemote(m.name, m.payload || {}, m.from);
        break;
      case MSG.CHAT: {
        const text = sanitizeChat(m.text);
        if (text) ev.emit('net:chat', { id: m.id, name: sanitizeName(m.name, nameOf(m.id)), text, self: false });
        break;
      }
      case MSG.PING:
        send(MSG.PONG, { ts: m.ts });
        break;
      case MSG.PONG:
        if (typeof m.ts === 'number' && m.ts === lastPingTs) {
          api.ping = Math.max(0, Date.now() - m.ts);
          lastPingTs = 0;
        }
        break;
      case MSG.ERROR:
        onError(m);
        break;
      default:
        break;
    }
    const set = handlers.get(m.t);
    if (set) for (const fn of set) fn(m);
  }
  function onWelcome(m) {
    api.id = m.id;
    api.room = m.room;
    api.isHost = !!m.isHost;
    api.hostId = m.hostId || (m.isHost ? m.id : null);
    api.connected = true;
    api.mode = api.isHost ? 'host' : 'client';
    attempts = 0;
    if (want) want.room = m.room; // reconnects rejoin by code
    for (const p of m.players || []) addPlayer(p.id, p.name);
    refreshPanel();
    updateUrl(m.room);
    ev.emit('net:connected', { id: api.id, room: api.room, isHost: api.isHost });
    if (api.isHost) {
      toast(`Session ${m.room} created. Share the code so friends can join.`, { kind: 'good', duration: 7 });
      ui?.system?.(`Session ${m.room} created. You are the host.`);
    } else {
      toast(`Joined session ${m.room} · ${players.size + 1} players.`, { kind: 'good' });
      ui?.system?.(`Joined session ${m.room}.`);
      if (m.difficulty && ctx.difficulty?.id && m.difficulty !== ctx.difficulty.id) {
        const r = ctx.debug?.difficulty?.(m.difficulty);
        if (r?.id === m.difficulty || ctx.difficulty?.id === m.difficulty) toast(`Difficulty switched to ${m.difficulty} to match the host.`, { icon: '⚖️', kind: 'warn', duration: 6 });
        else toast(`The host plays on ${m.difficulty}.`, { icon: '⚖️', kind: 'warn' });
      }
      if (m.seed != null && m.seed !== CONFIG.seed) toast("The host's island has a different seed: the world may not line up.", { kind: 'warn', duration: 6 });
      if (typeof m.timeHours === 'number' && Number.isFinite(m.timeHours)) setClock(m.timeHours, true);
    }
  }
  function onError(m) {
    const fatal = [ERRORS.NO_ROOM, ERRORS.ROOM_FULL, ERRORS.BAD_HELLO, ERRORS.VERSION].includes(m.code);
    const msg = m.code === ERRORS.NO_ROOM ? 'No such session (or it ended).' : m.code === ERRORS.ROOM_FULL ? 'That session is full.' : m.message || 'Server error.';
    toast(msg, { kind: 'bad', duration: 6 });
    if (fatal) {
      intentional = true;
      want = null;
      closeSocket();
      dropRoom(true);
      setOffline();
      updateUrl(null);
    }
  }

  // ── World events: relay out, apply in ──────────────────────────────────
  function pack(name, p) {
    p = p || {};
    switch (name) {
      case 'harvest':
        return p.rid ? { id: p.id, n: p.n, kind: p.kind, rid: p.rid } : null;
      case 'structure:placed':
        return p.position ? { type: p.type, x: r2(p.position.x), z: r2(p.position.z), yaw: r2(p.yaw || 0), id: p.id } : null;
      case 'fire:lit':
      case 'fire:out': {
        const id = p.id ?? p.fire?.id;
        return id != null ? { id, kind: p.kind } : null;
      }
      case 'food:cooked':
        return { from: p.from, to: p.to, n: p.n };
      case 'raft:stage':
        return typeof p.stageIndex === 'number' ? { stageIndex: p.stageIndex } : null;
      case 'tree:fell':
        return { position: vec(p.position), type: p.type };
      case 'flare:fired':
        return { position: vec(p.position) };
      case 'easter:found':
        return p.id ? { id: p.id, name: p.name, text: p.text } : null;
      case 'rescue:success':
        return { kind: p.kind };
      case 'raft:sailed':
        return { name: p.name, day: p.day };
      default:
        return null;
    }
  }
  function sendEvent(name, payload) {
    return send(MSG.EVENT, { name, payload });
  }
  function wireRelay() {
    for (const name of SHARED_EVENTS) {
      if (name === 'time:set') continue;
      ev.on(name, (p) => {
        if (applying || !api.connected || p?.remote) return;
        const ok = ctx.state === 'playing' || (ctx.state === 'rescued' && WIN_EVENTS.includes(name));
        if (!ok) return;
        const payload = pack(name, p);
        if (payload) sendEvent(name, payload);
      });
    }
    // The host's clock jumps (sleep, debug) go out at once; the periodic time:set is sent from update().
    const hostClock = () => {
      if (applying || !api.connected || !api.isHost) return;
      clockAcc = 0;
      sendEvent('time:set', { hoursTotal: ctx.time.hoursTotal });
    };
    ev.on('time:skip', hostClock);
    ev.on('time:set', hostClock);
  }
  const toV3 = (a) => (Array.isArray(a) && V3 ? new V3(+a[0] || 0, +a[1] || 0, +a[2] || 0) : null);
  function applyRemote(name, p, from) {
    if (name === 'time:set') {
      if (!api.isHost && typeof p.hoursTotal === 'number' && Number.isFinite(p.hoursTotal)) setClock(p.hoursTotal, false);
      return;
    }
    const who = nameOf(from);
    applying = true;
    try {
      switch (name) {
        case 'harvest':
          ctx.resources?.hideById?.(p.rid);
          break;
        case 'structure:placed':
          if (ctx.structures?.placeAt?.(p.type, p.x, p.z, p.yaw)) toast(`${who} built a ${LABEL[p.type] || p.type}.`, { icon: '🏕️', key: 'net-build' });
          break;
        case 'fire:lit':
          ctx.structures?.lightById?.(p.id);
          break;
        case 'fire:out':
          ctx.structures?.extinguishById?.(p.id);
          break;
        case 'food:cooked':
          ev.emit('food:cooked', { from: p.from, to: p.to, n: p.n, remote: true, from_player: from });
          break;
        case 'raft:stage':
          if (ctx.raft?.applyStage?.(p.stageIndex)) toast(`${who} finished a step of the boat.`, { icon: '🔨', key: 'net-raft' });
          break;
        case 'tree:fell':
          ev.emit('tree:fell', { position: toV3(p.position), type: p.type, remote: true });
          break;
        case 'flare:fired': {
          const position = toV3(p.position);
          if (position) ev.emit('flare:fired', { position, remote: true });
          toast(`${who} fired a flare!`, { icon: '🎇', key: 'net-flare' });
          break;
        }
        case 'easter:found': {
          const E = ctx.eastereggs;
          if (E?.found?.has?.(p.id)) break;
          E?.found?.add?.(p.id);
          ctx.ui?.markJournal?.('egg:' + p.id, { name: p.name, text: p.text });
          ev.emit('easter:found', { id: p.id, name: p.name, text: p.text, found: E?.found?.size ?? 0, total: E?.total ?? 0, remote: true, by: who });
          break;
        }
        case 'rescue:success':
          ev.emit('rescue:success', { kind: p.kind, remote: true });
          break;
        case 'raft:sailed':
          ev.emit('raft:sailed', { name: p.name, day: p.day, remote: true });
          break;
        default:
          break;
      }
    } catch (e) {
      console.warn(`[net] applying ${name} failed`, e);
    } finally {
      applying = false;
    }
  }

  // ── Clock sync ─────────────────────────────────────────────────────────
  const clock = { err: 0, scaleSet: null };
  let clockAcc = 0;
  function restoreScale() {
    if (clock.scaleSet !== null && ctx.time && ctx.time.timeScale === clock.scaleSet) ctx.time.timeScale = 1;
    clock.scaleSet = null;
  }
  function setClock(target, hard) {
    const T = ctx.time;
    if (!T) return;
    const err = target - T.hoursTotal;
    if (hard || Math.abs(err) > CLOCK_HARD_H) {
      restoreScale();
      clock.err = 0;
      applying = true;
      try {
        if (err > 0) T.skipHours?.(err);
        else T.setHour?.(((target % 24) + 24) % 24); // the clock cannot rewind days: match the hour of day
      } finally {
        applying = false;
      }
    } else clock.err = Math.abs(err) < CLOCK_EPS_H ? 0 : err;
  }
  function softCorrect(dt) {
    const T = ctx.time;
    if (!T || clock.err === 0) return;
    if (T.paused || ctx.flags?.sleeping) return;
    if (clock.scaleSet !== null && T.timeScale !== clock.scaleSet) {
      // someone else (sleep, debug) drives timeScale: give up this correction
      clock.err = 0;
      clock.scaleSet = null;
      return;
    }
    const perSec = T.hoursPerSec || 24 / 720;
    const scale = Math.max(0, Math.min(CLOCK_MAX_SCALE, 1 + clock.err / CLOCK_SOFT_SEC / perSec));
    const applied = (scale - 1) * perSec * dt;
    const before = clock.err;
    clock.err -= applied;
    if (Math.abs(clock.err) < CLOCK_EPS_H || Math.sign(clock.err) !== Math.sign(before)) {
      clock.err = 0;
      restoreScale();
      return;
    }
    T.timeScale = scale;
    clock.scaleSet = scale;
  }

  // ── Local state at tickHz ──────────────────────────────────────────────
  const out = { pos: [0, 0, 0], yaw: 0, pitch: 0, state: { moving: false, sprinting: false, swimming: false, aboard: false, waving: false, torch: false } };
  const last = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN, flags: -1, at: -1e9 };
  let sendAcc = 0, pingAcc = 0, lastPingTs = 0, sentSec = 0;
  function sendState(dt) {
    const P = ctx.player;
    if (!P?.position) return;
    sendAcc += dt;
    const period = 1 / (CONFIG.net?.tickHz || 15);
    if (sendAcc < period) return;
    sendAcc = Math.min(sendAcc - period, period);
    sentSec += dt;
    const s = out.state;
    s.moving = !!P.moving;
    s.sprinting = !!P.sprinting;
    s.swimming = !!P.swimming;
    s.aboard = !!P.aboard;
    s.waving = !!ctx.flags?.waving;
    s.torch = !!ctx.flags?.torchLit;
    const flags = (s.moving ? 1 : 0) | (s.sprinting ? 2 : 0) | (s.swimming ? 4 : 0) | (s.aboard ? 8 : 0) | (s.waving ? 16 : 0) | (s.torch ? 32 : 0);
    const x = P.position.x, y = P.position.y, z = P.position.z, yaw = P.yaw || 0, pitch = P.pitch || 0;
    const now = performance.now() / 1000;
    const changed =
      Math.abs(x - last.x) > 0.002 || Math.abs(y - last.y) > 0.002 || Math.abs(z - last.z) > 0.002 || Math.abs(yaw - last.yaw) > 0.003 || Math.abs(pitch - last.pitch) > 0.003 || flags !== last.flags;
    if (!changed && now - last.at < HEARTBEAT_SEC) return;
    out.pos[0] = r2(x);
    out.pos[1] = r2(y);
    out.pos[2] = r2(z);
    out.yaw = Math.round(yaw * 1000) / 1000;
    out.pitch = Math.round(pitch * 1000) / 1000;
    if (send(MSG.STATE, out)) {
      last.x = x;
      last.y = y;
      last.z = z;
      last.yaw = yaw;
      last.pitch = pitch;
      last.flags = flags;
      last.at = now;
    }
  }

  // ── Panel (#mp-* in the pause overlay) ─────────────────────────────────
  function wirePanel() {
    if (!hasDOM) return;
    const $ = (id) => document.getElementById(id);
    els.panel = $('mp');
    els.name = $('mp-name');
    els.server = $('mp-server');
    els.create = $('mp-create');
    els.room = $('mp-room');
    els.join = $('mp-join');
    els.leave = $('mp-leave');
    els.status = $('mp-status');
    els.players = $('mp-players');
    els.panel?.classList.remove('hidden');
    const storedName = params.get('name') || lsGet(LS_NAME) || `Castaway${Math.floor(100 + Math.random() * 900)}`;
    api.name = sanitizeName(storedName);
    if (els.name && !els.name.value) els.name.value = api.name;
    const server = normalizeServer(params.get('server')) || lsGet(LS_SERVER) || CONFIG.net?.defaultServer || '';
    if (els.server && !els.server.value) els.server.value = server;
    if (els.room && params.get('room')) els.room.value = normalizeRoomCode(params.get('room')) || '';
    els.name?.addEventListener('change', () => lsSet(LS_NAME, (api.name = sanitizeName(els.name.value))));
    els.server?.addEventListener('change', () => lsSet(LS_SERVER, normalizeServer(els.server.value)));
    els.create?.addEventListener('click', (e) => {
      e.stopPropagation();
      createRoom(els.name?.value, els.server?.value);
    });
    els.join?.addEventListener('click', (e) => {
      e.stopPropagation();
      join(els.room?.value, els.name?.value, els.server?.value);
    });
    els.room?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        join(els.room.value, els.name?.value, els.server?.value);
      }
    });
    els.leave?.addEventListener('click', (e) => {
      e.stopPropagation();
      leave();
    });
    refreshPanel();
  }
  function autoJoin() {
    const room = normalizeRoomCode(params.get('room'));
    const server = normalizeServer(params.get('server')) || normalizeServer(CONFIG.net?.defaultServer);
    if (room && server && !api.connected && !want) join(room, params.get('name') || api.name, server);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  function init() {
    wireRelay();
    wirePanel();
    ev.on('game:start', autoJoin);
    if (hasDOM) {
      import('./netUI.js')
        .then((m) => {
          ui = m.createNetUI(ctx, api);
          ui.init?.();
        })
        .catch((e) => console.warn('[net] chat UI unavailable', e));
    }
  }
  function update(dt) {
    ui?.update?.(dt);
    if (panelDirty || (panelAcc += dt) >= PANEL_REFRESH_SEC) {
      panelAcc = 0;
      refreshPanel();
    }
    if (!api.connected) return;
    for (const p of players.values()) p.avatar?.update(dt);
    pingAcc += dt;
    if (pingAcc >= PING_SEC) {
      pingAcc = 0;
      lastPingTs = Date.now();
      send(MSG.PING, { ts: lastPingTs });
    }
    if (ctx.state !== 'playing' && ctx.state !== 'paused') return;
    sendState(dt);
    if (ctx.state !== 'playing') return;
    if (api.isHost) {
      clockAcc += dt;
      if (clockAcc >= CLOCK_SEND_SEC) {
        clockAcc = 0;
        sendEvent('time:set', { hoursTotal: ctx.time.hoursTotal });
      }
    } else softCorrect(dt);
  }

  return api;
}
