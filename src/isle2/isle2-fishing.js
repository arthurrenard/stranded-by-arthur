// Retired (V4-C): the fishing minigame now lives in src/gameplay/fishing.js (ctx.fishing), which casts anywhere at
// water, from land, this dock or a raft. This shim only hands isle2's dock test to ctx.fishing so the dock counts as a
// place to stand. Without a wired ctx.fishing (unit tests, standalone use) it creates and drives its own instance.
import { create as createFishingSystem } from '../gameplay/fishing.js';

export function createFishing(ctx, { isOnDock } = {}) {
  let own = null; // standalone instance when main.js did not add ctx.fishing
  const sys = () => ctx.fishing?.setDockTest ? ctx.fishing : own;
  return {
    init() {
      if (!ctx.fishing?.setDockTest) {
        own = createFishingSystem(ctx);
        own.init();
      }
      sys()?.setDockTest?.(isOnDock);
    },
    update(dt) {
      own?.update(dt);
    },
    get provider() {
      return sys()?.provider;
    },
    get active() {
      const s = sys();
      return s?.active ? { phase: s.phase, x: s.spot?.x, z: s.spot?.z } : null;
    },
    /** Debug: land a catch now. */
    debugCatch() {
      sys()?.debug?.catch?.();
    },
  };
}
