// Multiplayer chat + player list overlay (SPEC §12). Created lazily by net.js (browser only):
//   createNetUI(ctx, net) → { init(), update(dt), system(text), isOpen() }
// - Enter opens a chat input bottom-left. Like a HUD panel it sets ctx.ui.menuOpen BEFORE unlocking the pointer
//   (so main doesn't pause the game); Enter sends + re-locks (keydown = user gesture), Esc / blur cancels and leaves
//   the pointer unlocked (Escape is not a gesture for pointer lock), so main shows the pause overlay once.
// - Messages appear above the hotbar for 8 s, the sender's name colored by its id (protocol colorForId).
// - P toggles the player list (name, ping, host badge).
// - Own container on document.body (z-index 20); hidden entirely while offline. Text only via textContent.
import './net.css';
import { CONFIG } from '../config.js';
import { colorForId, sanitizeChat, LIMITS } from './protocol.js';

const SHOW_SEC = 8; // keep in sync with the net-msg-life animation in net.css
const MAX_LINES = 40;
const LIST_REFRESH_SEC = 1;
const GAP_PX = 10;

export function createNetUI(ctx, net) {
  let root = null, list = null, listHead = null, listBody = null, log = null, input = null;
  const lines = []; // { el, until } in arrival order
  let now = 0, liveFrom = 0; // lines[liveFrom..] are still within SHOW_SEC
  let open = false, ownMenu = false, listOpen = false, listAcc = 0, shown = false;

  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    if (parent) parent.appendChild(e);
    return e;
  }

  // ── Layout: never under the hotbar, and lifted above the bottom-left stats panel when they would overlap ──
  function place() {
    if (!root) return;
    let bottom = 96;
    try {
      const stats = document.querySelector('.hud-stats');
      const r = stats?.getBoundingClientRect?.();
      if (r && r.width > 0 && r.height > 0 && r.left < 16 + 360 && r.right > 16) bottom = Math.max(bottom, Math.round(innerHeight - r.top + GAP_PX));
    } catch (_) {}
    root.style.bottom = `${bottom}px`;
  }

  // ── Messages ───────────────────────────────────────────────────────────
  function addLine(name, text, color, kind) {
    if (!root || !text) return;
    const row = el('div', kind ? `net-msg ${kind}` : 'net-msg', log);
    if (name) {
      const n = el('b', 'net-name', row, name);
      if (color) n.style.color = color;
      el('span', 'net-sep', row, ': ');
    }
    el('span', 'net-text', row, text);
    lines.push({ el: row, until: now + SHOW_SEC });
    while (lines.length > MAX_LINES) {
      lines.shift().el.remove();
      if (liveFrom > 0) liveFrom--;
    }
  }
  function system(text) {
    addLine(null, String(text || ''), null, 'sys');
  }

  // ── Chat input ─────────────────────────────────────────────────────────
  function openChat() {
    if (open || !root || !net.connected) return false;
    if (ctx.state !== 'playing' || ctx.ui?.menuOpen || ctx.flags?.cinematic) return false;
    open = true;
    ownMenu = false;
    // ctx.flags.typing (set BEFORE unlocking): main neither pauses nor freezes the world while you chat,
    // so the host's clock keeps running for everyone
    ctx.flags.typing = true;
    ctx.input?.clearAll?.(); // no key stays "held" while the input has focus
    ctx.input?.unlock?.();
    place();
    root.classList.add('open');
    input.value = '';
    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      input.focus();
    }
    return true;
  }
  /** viaEnter: the closing keydown is a user gesture, so the pointer can be re-locked. */
  function closeChat(viaEnter) {
    if (!open) return;
    open = false;
    root.classList.remove('open');
    input.value = '';
    input.blur();
    ctx.flags.typing = false;
    ownMenu = false;
    if (viaEnter && ctx.state === 'playing') ctx.input?.lock?.();
  }

  // ── Player list ────────────────────────────────────────────────────────
  function addRow(id, name, ping, host, self) {
    const row = el('div', self ? 'net-row self' : 'net-row', listBody);
    el('i', 'net-dot', row).style.background = colorForId(id || '');
    el('span', 'net-pname', row, self ? `${name} (you)` : name);
    if (host) el('span', 'net-host', row, 'HOST');
    el('span', 'net-ping', row, ping > 0 ? `${Math.round(ping)} ms` : '–');
  }
  function renderList() {
    if (!listBody) return;
    const max = CONFIG.net?.maxPlayers || LIMITS.defaultMaxPlayers;
    listHead.textContent = `Session ${net.room || '—'} · ${net.players.size + 1}/${max}`;
    listBody.textContent = '';
    addRow(net.id, net.name, net.ping, net.isHost, true);
    for (const p of net.players.values()) addRow(p.id, p.name, p.ping, p.id === net.hostId, false);
  }
  function setList(on) {
    listOpen = !!on;
    list.classList.toggle('hidden', !listOpen);
    listAcc = 0;
    if (listOpen) renderList();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  function init() {
    if (root || typeof document === 'undefined' || !document.body) return;
    root = el('div', 'net-ui hidden', document.body);
    list = el('div', 'net-list hidden', root);
    listHead = el('div', 'net-list-head', list);
    listBody = el('div', 'net-list-body', list);
    log = el('div', 'net-log', root);
    log.setAttribute('aria-live', 'polite');
    const bar = el('div', 'net-input', root);
    input = el('input', '', bar);
    input.type = 'text';
    input.maxLength = LIMITS.chatChars;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Say something… (Enter to send, Esc to cancel)';
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = sanitizeChat(input.value);
        closeChat(true);
        if (text) net.chat?.(text);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeChat(false);
      }
    });
    input.addEventListener('blur', () => {
      if (open) closeChat(false);
    });

    const ev = ctx.events;
    ev?.on?.('net:chat', (m) => {
      if (m && m.text) addLine(m.name || 'Someone', m.text, colorForId(m.id || ''), m.self ? 'self' : '');
    });
    ev?.on?.('net:connected', () => system('Enter to chat · P for the player list.'));
    if (typeof addEventListener === 'function') addEventListener('resize', place);
    place();
  }

  function update(dt) {
    if (!root) return;
    now += dt;
    const want = !!net.connected;
    if (want !== shown) {
      shown = want;
      root.classList.toggle('hidden', !shown);
      if (shown) place();
      else {
        closeChat(false);
        if (listOpen) setList(false);
      }
    }
    while (liveFrom < lines.length && lines[liveFrom].until <= now) lines[liveFrom++].el.classList.add('old');
    if (!shown) return;
    if (open && ctx.state !== 'playing') closeChat(false);
    if (ctx.state === 'playing' && !open) {
      if (ctx.input?.wasPressed?.('chat')) openChat();
      else if (ctx.input?.wasPressed?.('scoreboard')) setList(!listOpen);
    }
    if (listOpen && (listAcc += dt) >= LIST_REFRESH_SEC) {
      listAcc = 0;
      renderList();
    }
  }

  return { init, update, system, isOpen: () => open, openChat, closeChat };
}
