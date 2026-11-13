// Crafting (Builder E): recipe availability, requirement checks (materials, flint + pyrite tools,
// "at a lit fire", placement validity) and crafting itself. The panel UI lives in src/ui/hud-panels.js
// and calls available() / craft(id). Recipe data + pure checks: ./recipes.js.
import { RECIPES, RECIPE_BY_ID, checkRecipe, lastUseWarning } from './recipes.js';

export function create(ctx) {
  const count = (id) => ctx.inventory?.count?.(id) ?? 0;
  const toast = (t, o) => ctx.ui?.toast?.(t, o);

  /** The lit fire within 3 m of the player, or null. */
  function nearLitFire() {
    const p = ctx.player?.position;
    if (!p) return null;
    return ctx.structures?.nearestFire?.(p, 3, true) ?? null;
  }

  const NOT_NOW = { ok: false, reason: 'Building is not available right now.' };
  /** v3: the paddle raft is placed by ctx.vehicles at the water's edge; everything else by structures. */
  function placementOf(type) {
    if (type === 'paddle_raft') return ctx.vehicles?.findRaftSpot?.() ?? NOT_NOW;
    return ctx.structures?.findPlacement?.(type) ?? NOT_NOW;
  }

  /** Per-call environment (placement results are cached for the call). */
  function env() {
    const cache = {};
    return {
      nearFire: !!nearLitFire(),
      placement: (type) => (cache[type] ??= placementOf(type)),
    };
  }

  /** Requirement status of one recipe: { ok, reason, reqs, use }. */
  function status(id) {
    const r = RECIPE_BY_ID[id];
    return r ? checkRecipe(r, count, env()) : { ok: false, reason: 'Unknown recipe.', reqs: [], use: [] };
  }

  /** View models for the crafting panel. Fire-only recipes appear only near a lit fire. */
  function available() {
    const e = env();
    const out = [];
    for (const r of RECIPES) {
      if (r.atFire && !e.nearFire) continue;
      const s = checkRecipe(r, count, e);
      out.push({
        id: r.id,
        name: r.name,
        icon: r.icon,
        desc: r.desc,
        section: r.section,
        verb: r.verb || 'Craft',
        ok: s.ok,
        reason: s.reason,
        reqs: s.reqs,
      });
    }
    return out;
  }

  /** Craft (or build) a recipe. Returns { ok, placed, reason?, structure? }. */
  function craft(id) {
    const r = RECIPE_BY_ID[id];
    if (!r) return { ok: false, reason: 'Unknown recipe.' };
    if (ctx.state !== 'playing' || ctx.flags.cinematic) return { ok: false, reason: 'Not now.' };
    const inv = ctx.inventory;
    if (!inv?.remove) return { ok: false, reason: 'No inventory.' };
    const e = env();
    const s = checkRecipe(r, count, e);
    if (!s.ok) {
      toast(s.reason, { icon: r.icon, kind: 'warn', key: 'craft' });
      ctx.audio?.play?.('ui_click');
      return { ok: false, reason: s.reason };
    }
    let structure = null;
    if (r.place) {
      structure =
        (r.place === 'paddle_raft'
          ? ctx.vehicles?.placeRaft?.(e.placement(r.place))
          : ctx.structures?.place?.(r.place, e.placement(r.place))) ?? null;
      if (!structure) {
        toast("You can't build that here.", { icon: r.icon, kind: 'warn', key: 'craft' });
        return { ok: false, reason: "Can't build here." };
      }
    }
    for (const u of s.use) inv.remove(u.id, u.n);
    if (r.gives) inv.add(r.gives.id, r.gives.n);
    if (ctx.stats_summary) ctx.stats_summary.itemsCrafted++;
    ctx.events.emit('craft:done', { recipe: r.id, name: r.name });
    ctx.audio?.play?.('craft');
    if (!structure) {
      const warn = lastUseWarning(r, count);
      if (warn) toast(`Crafted ${r.name}. ${warn}`, { icon: r.icon, kind: 'warn', key: 'craft', duration: 6 });
      else toast(`Crafted ${r.name}.`, { icon: r.icon, kind: 'good', key: 'craft' });
    }
    return { ok: true, placed: !!structure, structure };
  }

  return { init() {}, recipes: RECIPES, available, status, craft, nearLitFire };
}
