// Keyboard + mouse input with pointer lock. Uses KeyboardEvent.code (physical keys), so
// ZQSD on AZERTY keyboards maps to the same actions as WASD on QWERTY automatically.
// Mouse buttons are reported as codes 'Mouse0' (left), 'Mouse1' (middle), 'Mouse2' (right).
import { CONFIG } from '../config.js';

export function createInput(canvas, events) {
  const down = new Set();
  const pressed = new Set(); // went down this frame
  const released = new Set();
  const virtualHolds = new Map(); // code -> seconds remaining (debug / automation)
  const keyListeners = new Set();
  let mdx = 0, mdy = 0, wheel = 0;
  let locked = false;

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
      press(e.code);
      for (const fn of keyListeners) fn(e.code, e);
    }
  });
  window.addEventListener('keyup', (e) => release(e.code));
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
  document.addEventListener('pointerlockchange', () => {
    const was = locked;
    locked = document.pointerLockElement === canvas;
    if (locked !== was) events?.emit(locked ? 'input:lock' : 'input:unlock');
  });

  const api = {
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
