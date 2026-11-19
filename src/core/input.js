// Keyboard + mouse input with pointer lock. Uses KeyboardEvent.code (physical keys), so
// ZQSD on AZERTY keyboards maps to the same actions as WASD on QWERTY automatically.
// Mouse buttons are reported as codes 'Mouse0' (left), 'Mouse1' (middle), 'Mouse2' (right).
// V6: letter-labelled menu actions also match the PRODUCED letter through the pseudo-code 'Letter:x'
// (from KeyboardEvent.key, lowercased), so "M map" works on AZERTY where the printed M is code
// 'Semicolon'. The Letter press is suppressed when the physical code is itself bound to an action, so
// AZERTY's KeyA ('q') stays move-left only. The keyboard layout is detected (getLayoutMap, then
// keydown code-vs-key) and keyLabel(code) gives the label printed on that key ('KeyQ' -> 'A' on AZERTY).
import { CONFIG } from '../config.js';

/** Printed labels that differ from QWERTY, per layout (positional codes only; digits never relabelled). */
export const LAYOUT_LABELS = {
  qwerty: {},
  azerty: { KeyQ: 'A', KeyA: 'Q', KeyW: 'Z', KeyZ: 'W', KeyM: ',', Semicolon: 'M', Comma: ';', Period: ':' },
  qwertz: { KeyY: 'Z', KeyZ: 'Y' },
  other: {},
};
const NAMED = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace',
  ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Mouse0: 'Click', Mouse1: 'Middle-click', Mouse2: 'Right-click',
  Semicolon: ';', Comma: ',', Period: '.', Slash: '/', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
};

/** Label printed on the key with this code for a layout (layoutMap: optional Map code -> key from getLayoutMap). */
export function labelFor(code, layout = 'qwerty', layoutMap = null) {
  if (typeof code !== 'string' || !code) return '';
  if (code.startsWith('Letter:')) return code.slice(7).toUpperCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return 'Num ' + code.slice(6);
  const tab = LAYOUT_LABELS[layout] || {};
  if (tab[code]) return tab[code];
  if (layout === 'other' && layoutMap && (code.startsWith('Key') || code in NAMED)) {
    const k = layoutMap.get?.(code);
    if (typeof k === 'string' && k.length === 1 && k.trim()) return k.toUpperCase();
  }
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  return NAMED[code] || code;
}

/** Classify a layout from a code -> produced-key lookup (Map or plain object). */
export function classifyLayout(map) {
  const get = (c) => {
    const v = map?.get ? map.get(c) : map?.[c];
    return typeof v === 'string' ? v.toLowerCase() : undefined;
  };
  const q = get('KeyQ'), w = get('KeyW'), a = get('KeyA'), y = get('KeyY'), z = get('KeyZ');
  if (q === 'a' || w === 'z' || a === 'q') return 'azerty';
  if (y === 'z' || z === 'y') return 'qwertz';
  if (q === 'q' && w === 'w' && (y === undefined || y === 'y')) return 'qwerty';
  if (q === undefined && w === undefined && a === undefined && y === undefined && z === undefined) return null;
  return 'other';
}

/**
 * Runtime layout hint from one keydown (code + produced key). Returns a layout or null (no information).
 * Only the keys that tell the layouts apart count.
 */
export function layoutFromKey(code, key) {
  if (typeof key !== 'string' || key.length !== 1 || !/^Key[A-Z]$/.test(code)) return null;
  const k = key.toLowerCase();
  if (code === 'KeyM' && k === ',') return 'azerty';
  if (!/^[a-z]$/.test(k)) return /\p{L}/u.test(k) ? 'other' : null;
  const own = code.slice(3).toLowerCase();
  if ((code === 'KeyQ' && k === 'a') || (code === 'KeyW' && k === 'z') || (code === 'KeyA' && k === 'q') || (code === 'KeyZ' && k === 'w')) return 'azerty';
  if ((code === 'KeyY' && k === 'z') || (code === 'KeyZ' && k === 'y')) return 'qwertz';
  if (['q', 'w', 'a', 'y', 'z'].includes(own)) return k === own ? 'qwerty' : 'other';
  return k === own ? null : 'other';
}

/** The pseudo-code for a produced letter, or null (non-letters, modifier combos). */
export function letterCode(e) {
  if (!e || typeof e.key !== 'string' || e.ctrlKey || e.metaKey || e.altKey) return null;
  const k = e.key.toLowerCase();
  return /^[a-z]$/.test(k) ? 'Letter:' + k : null;
}

/** All codes bound to any CONFIG.keys action (Letter: pseudo-codes excluded). */
function boundCodes() {
  const s = new Set();
  for (const list of Object.values(CONFIG.keys || {})) for (const c of list || []) if (!String(c).startsWith('Letter:')) s.add(c);
  return s;
}

/** Does a keydown (code + event) trigger this action? Letter bindings match the produced letter. */
export function matchesAction(action, code, e, bound = boundCodes()) {
  const list = Array.isArray(action) ? action : CONFIG.keys?.[action] || [action];
  if (list.includes(code)) return true;
  const lc = letterCode(e);
  return !!(lc && !bound.has(code) && list.includes(lc));
}

// Module-level "current layout" so pure UI helpers (hud-data) can label keys without a ctx.
const cur = { layout: 'qwerty', map: null, known: false };
/** Printed label for a positional code on the current layout. */
export function keyLabel(code) {
  return labelFor(code, cur.layout, cur.map);
}
/** Label for an action: its Letter binding's letter when it has one, else its first code's printed label. */
export function actionLabel(action) {
  const list = CONFIG.keys?.[action] || [];
  const letter = list.find((c) => String(c).startsWith('Letter:'));
  if (letter) return letter.slice(7).toUpperCase();
  return list.length ? keyLabel(list[0]) : String(action);
}
/** The current layout id ('qwerty' | 'azerty' | 'qwertz' | 'other'). */
export function currentLayout() {
  return cur.layout;
}
/** Test/debug hook: force the current layout. */
export function setLayout(layout, map = null) {
  cur.layout = LAYOUT_LABELS[layout] ? layout : 'other';
  cur.map = map;
  cur.known = true;
}
/** True once the layout was actually detected (getLayoutMap, or a distinguishing keypress). */
export function layoutKnown() {
  return cur.known;
}

export function createInput(canvas, events) {
  const down = new Set();
  const pressed = new Set(); // went down this frame
  const released = new Set();
  const virtualHolds = new Map(); // code -> seconds remaining (debug / automation)
  const keyListeners = new Set();
  let mdx = 0, mdy = 0, wheel = 0;
  let locked = false;
  const codeLetter = new Map(); // physical code -> Letter: pseudo-code pressed with it
  const BOUND = boundCodes();
  let layoutLocked = false; // true once getLayoutMap answered (authoritative)
  const layoutVotes = { qwerty: 0, azerty: 0, qwertz: 0, other: 0 };

  function setLayoutNow(l, map = null) {
    if (!l) return;
    const prev = cur.layout, wasKnown = cur.known;
    cur.layout = l;
    cur.known = true;
    if (map) cur.map = map;
    if (l !== prev || !wasKnown) events?.emit('input:layout', { layout: l, prev });
  }
  try {
    const kb = typeof navigator !== 'undefined' ? navigator.keyboard : null;
    const p = kb?.getLayoutMap?.();
    if (p && p.then) {
      p.then((map) => {
        const l = classifyLayout(map);
        if (l) {
          layoutLocked = true;
          setLayoutNow(l, map);
        }
      }).catch(() => {});
    }
  } catch (_) {
    /* unsupported (Firefox / Safari / iframe policy): keydown fallback below */
  }
  function learnLayout(e) {
    if (layoutLocked || !e || e.ctrlKey || e.metaKey || e.altKey) return;
    const l = layoutFromKey(e.code, e.key);
    if (!l) return;
    layoutVotes[l]++;
    // a single distinguishing key is enough for azerty/qwertz; 'other' needs two votes (dead keys etc.)
    if ((l !== cur.layout || !cur.known) && (l !== 'other' || layoutVotes.other >= 2)) setLayoutNow(l);
  }

  const PREVENT = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  function press(code) {
    if (!down.has(code)) pressed.add(code);
    down.add(code);
  }
  function release(code) {
    if (down.has(code)) released.add(code);
    down.delete(code);
  }

  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if (PREVENT.has(e.code)) e.preventDefault();
    if (!e.repeat) {
      learnLayout(e);
      press(e.code);
      const lc = letterCode(e);
      if (lc && !BOUND.has(e.code)) {
        codeLetter.set(e.code, lc);
        press(lc);
      }
      for (const fn of keyListeners) fn(e.code, e);
    }
  });
  window.addEventListener('keyup', (e) => {
    release(e.code);
    const lc = codeLetter.get(e.code);
    if (lc) {
      codeLetter.delete(e.code);
      release(lc);
    }
  });
  window.addEventListener('blur', () => {
    for (const c of [...down]) release(c);
  });
  canvas.addEventListener('mousedown', (e) => press('Mouse' + e.button));
  window.addEventListener('mouseup', (e) => release('Mouse' + e.button));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('mousemove', (e) => {
    if (!locked) return;
    mdx += e.movementX || 0;
    mdy += e.movementY || 0;
  });
  window.addEventListener(
    'wheel',
    (e) => {
      wheel += Math.sign(e.deltaY);
    },
    { passive: true }
  );
  // A refused lock (no user gesture, or the browser's ~1 s cooldown after an Escape exit).
  document.addEventListener('pointerlockerror', () => events?.emit('input:lockError'));
  document.addEventListener('pointerlockchange', () => {
    const was = locked;
    locked = document.pointerLockElement === canvas;
    if (locked !== was) events?.emit(locked ? 'input:lock' : 'input:unlock');
  });

  const api = {
    /** V6: detected keyboard layout: 'qwerty' | 'azerty' | 'qwertz' | 'other'. */
    get layout() {
      return cur.layout;
    },
    /** V6: true once the layout was detected (before that, layout is the 'qwerty' default). */
    get layoutKnown() {
      return cur.known;
    },
    /** V6: label printed on the key with this code ('KeyQ' -> 'A' on AZERTY). */
    keyLabel,
    /** V6: label for a CONFIG.keys action (letter bindings show their letter). */
    actionLabel,
    /** V6: does this keydown (code, event) trigger the action? (for onKeyDown listeners) */
    matches(action, code, e) {
      return matchesAction(action, code, e, BOUND);
    },
    get locked() {
      return locked;
    },
    /** Request pointer lock (must be called from a user gesture). */
    lock() {
      try {
        const p = canvas.requestPointerLock?.();
        if (p && p.catch) p.catch(() => {});
      } catch (_) {
        /* ignore */
      }
    },
    unlock() {
      if (document.pointerLockElement) document.exitPointerLock();
    },
    /** True while any of the given codes (string or array, or a CONFIG.keys action name) is held. */
    isDown(codeOrAction) {
      return resolve(codeOrAction).some((c) => down.has(c) || virtualHolds.has(c));
    },
    /** True only on the frame the key went down. */
    wasPressed(codeOrAction) {
      return resolve(codeOrAction).some((c) => pressed.has(c));
    },
    wasReleased(codeOrAction) {
      return resolve(codeOrAction).some((c) => released.has(c));
    },
    /** Mouse movement since last frame (pixels). */
    get mouseDX() {
      return mdx;
    },
    get mouseDY() {
      return mdy;
    },
    /** Wheel steps since last frame (+1 down, -1 up). */
    get wheel() {
      return wheel;
    },
    /** Subscribe to raw keydown codes (e.g. for Konami code). Returns unsubscribe. */
    onKeyDown(fn) {
      keyListeners.add(fn);
      return () => keyListeners.delete(fn);
    },
    /** Debug/automation: hold a key for `seconds` of real time. */
    hold(code, seconds = 0.5) {
      virtualHolds.set(code, seconds);
      pressed.add(code);
    },
    /** Debug/automation: simulate a tap. */
    tap(code) {
      pressed.add(code);
      for (const fn of keyListeners) fn(code, null);
    },
    /** Debug/automation: inject mouse look. */
    look(dx, dy) {
      mdx += dx;
      mdy += dy;
    },
    /** Called by main at the END of every frame. */
    endFrame(dt) {
      pressed.clear();
      released.clear();
      mdx = 0;
      mdy = 0;
      wheel = 0;
      for (const [c, t] of virtualHolds) {
        const nt = t - dt;
        if (nt <= 0) {
          virtualHolds.delete(c);
          released.add(c);
        } else virtualHolds.set(c, nt);
      }
    },
    clearAll() {
      codeLetter.clear();
      down.clear();
      pressed.clear();
      virtualHolds.clear();
    },
  };

  function resolve(codeOrAction) {
    if (Array.isArray(codeOrAction)) return codeOrAction;
    if (CONFIG.keys[codeOrAction]) return CONFIG.keys[codeOrAction];
    return [codeOrAction];
  }

  return api;
}
