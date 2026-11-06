// Central interaction registry. Every "press E to ..." in the game goes through here so
// there is exactly one prompt and one target at a time.
//
// register({
//   position: THREE.Vector3 | {x,y,z},   // world position of the thing (live reference is fine)
//   radius?: number,                      // max distance from the camera (default CONFIG.player.reach)
//   label: string | (ctx, self) => string,// primary action label, shown as "[E] label"
//   onUse: (ctx, self) => void,           // primary action (E / left click)
//   secondary?: { label: string | fn, onUse: fn },  // optional "[R] label" action
//   enabled?: (ctx, self) => boolean,     // hide when false
//   priority?: number,                    // tie-breaker bonus (default 0)
//   data?: any,
// }) -> handle (the same object, with .remove() and .moveTo(x,y,z))
//
// addProvider((ctx) => candidate | null) for things that aren't points (drinking from a river).
// A candidate is { label, onUse, secondary?, score? }; higher score wins (registered points score ~0..3).
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { SpatialHash } from './spatial.js';

export function createInteract(ctx) {
  const hash = new SpatialHash(6);
  const providers = new Set();
  const camPos = new THREE.Vector3();
  const viewDir = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const near = [];
  let current = null;
  let cooldown = 0;
  let lastPromptKey = '';

  function evalLabel(l, self) {
    return typeof l === 'function' ? l(ctx, self) : l;
  }

  const api = {
    /** The currently focused candidate (or null). */
    get current() {
      return current;
    },
    register(def) {
      const p = def.position;
      const h = Object.assign(def, {
        x: p.x,
        z: p.z,
        r: 0,
        radius: def.radius ?? CONFIG.player.reach,
        priority: def.priority ?? 0,
        removed: false,
      });
      h.remove = () => {
        if (h.removed) return;
        h.removed = true;
        hash.remove(h);
        if (current && current.source === h) current = null;
      };
      h.moveTo = (x, y, z) => {
        if (h.position.set) h.position.set(x, y, z);
        else Object.assign(h.position, { x, y, z });
        hash.move(h, x, z);
      };
      hash.insert(h);
      return h;
    },
    addProvider(fn) {
      providers.add(fn);
      return () => providers.delete(fn);
    },
    /** Called once per frame by main while playing. */
    update(dt) {
      cooldown = Math.max(0, cooldown - dt);
      const enabled = ctx.state === 'playing' && !ctx.ui?.menuOpen && !ctx.flags.cinematic && !ctx.stats?.dead;
      if (!enabled) {
        current = null;
        setPrompt(null);
        return;
      }
      ctx.camera.getWorldPosition(camPos);
      ctx.camera.getWorldDirection(viewDir);

      let best = null;
      let bestScore = -Infinity;
      near.length = 0;
      hash.query(camPos.x, camPos.z, CONFIG.player.reach + 3, near);
      for (const h of near) {
        if (h.removed) continue;
        if (h.enabled && !h.enabled(ctx, h)) continue;
        tmp.set(h.position.x, h.position.y, h.position.z).sub(camPos);
        const d = tmp.length();
        if (d > h.radius) continue;
        const dot = d > 1e-4 ? viewDir.dot(tmp) / d : 1;
        if (dot < 0.8 && d > 1.1) continue;
        const score = dot * 3 - d * 0.35 + h.priority;
        if (score > bestScore) {
          bestScore = score;
          best = h;
        }
      }
      let cand = null;
      if (best) {
        cand = {
          source: best,
          label: evalLabel(best.label, best),
          onUse: () => best.onUse(ctx, best),
          secondary: best.secondary
            ? { label: evalLabel(best.secondary.label, best), onUse: () => best.secondary.onUse(ctx, best) }
            : null,
          score: bestScore,
        };
      }
      for (const p of providers) {
        let c = null;
        try {
          c = p(ctx);
        } catch (e) {
          console.error('[interact] provider threw', e);
        }
        if (c && (c.score ?? 1) > (cand ? cand.score : -Infinity)) cand = { source: null, score: 1, ...c };
      }
      // A candidate may have an empty primary label (secondary-only).
      current = cand && (cand.label || cand.secondary?.label) ? cand : null;

      if (current) {
        const lines = [];
        if (current.label) lines.push({ key: 'E', label: current.label });
        if (current.secondary?.label) lines.push({ key: 'R', label: current.secondary.label });
        setPrompt(lines);
        if (cooldown <= 0) {
          if (current.label && ctx.input.wasPressed('interact')) {
            cooldown = 0.18;
            current.onUse();
          } else if (current.secondary?.label && ctx.input.wasPressed('secondary')) {
            cooldown = 0.18;
            current.secondary.onUse();
          }
        }
      } else setPrompt(null);
    },
  };

  function setPrompt(lines) {
    const key = lines ? lines.map((l) => l.key + l.label).join('|') : '';
    if (key === lastPromptKey) return;
    lastPromptKey = key;
    ctx.ui?.setPrompt?.(lines);
  }

  return api;
}
