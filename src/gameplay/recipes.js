// Recipe data + pure requirement checks (Builder E). No THREE / DOM, unit-tested in tests/gameplay.test.mjs.
//
// needs: [{ id, n }]  or  [{ any: [{ id, n }, ...] }]  (first affordable alternative is used)
// tools: item ids that must be in the inventory but are NOT consumed (flint + pyrite for sparks)
// place: structure type to build in front of the player (structures.place)
// atFire: only craftable within 3 m of a lit fire
// warnLast: { id, text }: after crafting, warn with `text` if none of item `id` is left (pickaxe → flint)
import { ITEMS } from '../core/items.js';

export const RECIPES = [
  {
    id: 'canteen',
    name: 'Bamboo Canteen',
    icon: '🫙',
    section: 'item',
    desc: 'A hollow cane sealed with fiber. Fill it at fresh water (R).',
    needs: [
      { id: 'bamboo', n: 1 },
      { id: 'fiber', n: 2 },
    ],
    gives: { id: 'bottle_empty', n: 1 },
  },
  {
    id: 'rope',
    name: 'Rope',
    icon: '🪢',
    section: 'item',
    desc: 'Twisted plant fiber. Lashes a shelter together.',
    needs: [{ id: 'fiber', n: 4 }],
    gives: { id: 'rope', n: 1 },
  },
  {
    id: 'torch',
    name: 'Torch',
    icon: '🔥',
    section: 'item',
    desc: 'Burns for 4 hours: light, a little warmth, and a signal at night. T to light.',
    needs: [{ id: 'wood', n: 1 }, { any: [{ id: 'fiber', n: 1 }, { id: 'cloth', n: 1 }] }],
    gives: { id: 'torch', n: 1 },
  },
  // ── v2 tools (SPEC §10): dig up buried boat parts, break open rocks, dive longer ──
  {
    id: 'shovel',
    name: 'Wooden Shovel',
    icon: '🪏',
    section: 'item',
    desc: 'Digs up boat parts buried in the sand. Look for disturbed mounds and press E.',
    needs: [
      { id: 'wood', n: 2 },
      { id: 'stone', n: 1 },
      { id: 'rope', n: 1 },
    ],
    gives: { id: 'shovel', n: 1 },
  },
  {
    id: 'pickaxe',
    name: 'Flint Pickaxe',
    icon: '⛏️',
    section: 'item',
    desc: 'Breaks open cracked rocks where something glints inside. Uses up one flint.',
    needs: [
      { id: 'wood', n: 2 },
      { id: 'flint', n: 1 },
      { id: 'rope', n: 1 },
    ],
    gives: { id: 'pickaxe', n: 1 },
    // fire needs flint in the pack: warn when the craft used the last one
    warnLast: { id: 'flint', text: "That was your last flint: you'll need another to make fire." },
  },
  {
    id: 'diving_mask',
    name: 'Diving Mask',
    icon: '🤿',
    section: 'item',
    desc: 'Keep it in your pack to hold your breath much longer underwater (hold X to dive).',
    needs: [
      { id: 'bamboo', n: 1 },
      { id: 'cloth', n: 1 },
      { id: 'rope', n: 1 },
    ],
    gives: { id: 'diving_mask', n: 1 },
  },
  {
    id: 'campfire',
    name: 'Campfire',
    icon: '🔥',
    section: 'place',
    verb: 'Build',
    desc: 'Warmth, light and cooking. Feed it wood. Seen from afar at night.',
    needs: [
      { id: 'wood', n: 3 },
      { id: 'stone', n: 4 },
    ],
    tools: ['flint', 'pyrite'],
    place: 'campfire',
  },
  {
    id: 'signal_fire',
    name: 'Signal Fire',
    icon: '💨',
    section: 'place',
    verb: 'Build',
    desc: 'A tall pyre. Light it when the search party is near: its smoke is visible for miles.',
    needs: [
      { id: 'wood', n: 8 },
      { id: 'leaves', n: 5 },
    ],
    tools: ['flint', 'pyrite'],
    place: 'signal_fire',
  },
  {
    id: 'sos',
    name: 'SOS Sign',
    icon: '🆘',
    section: 'place',
    verb: 'Build',
    desc: 'Giant letters of stone on the sand, readable from the air by day.',
    needs: [{ id: 'stone', n: 10 }],
    place: 'sos',
  },
  {
    id: 'shelter',
    name: 'Lean-to Shelter',
    icon: '🏕️',
    section: 'place',
    verb: 'Build',
    desc: 'A leaf roof on a wooden frame. Keeps the rain off; sleep here at night.',
    needs: [{ id: 'wood', n: 6 }, { id: 'leaves', n: 6 }, { any: [{ id: 'rope', n: 1 }, { id: 'fiber', n: 3 }] }],
    place: 'shelter',
  },
  {
    id: 'herbal_tea',
    name: 'Herbal Tea',
    icon: '🍵',
    section: 'fire',
    verb: 'Brew',
    desc: 'Yarrow and chamomile steeped in hot water. Heals and warms.',
    needs: [
      { id: 'yarrow', n: 1 },
      { id: 'chamomile', n: 1 },
      { id: 'bottle_water', n: 1 },
    ],
    atFire: true,
    gives: { id: 'herbal_tea', n: 1 },
  },
  {
    id: 'nettle_soup',
    name: 'Nettle Soup',
    icon: '🍲',
    section: 'fire',
    verb: 'Cook',
    desc: 'Nettles boiled in your canteen. No sting, lots of goodness.',
    needs: [
      { id: 'nettle', n: 2 },
      { id: 'bottle_water', n: 1 },
    ],
    atFire: true,
    gives: { id: 'nettle_soup', n: 1 },
  },
];

export const RECIPE_BY_ID = Object.fromEntries(RECIPES.map((r) => [r.id, r]));

const icon = (id) => ITEMS[id]?.icon ?? '❔';
const name = (id) => ITEMS[id]?.name ?? id;

/**
 * Check a recipe against the inventory.
 * @param recipe one of RECIPES
 * @param count  (id) => number owned
 * @param env    { nearFire: bool, placement?: (type) => { ok, reason } }
 * @returns { ok, reason, reqs: [{ id, icon, name, have, need, ok, tool?, label? }], use: [{ id, n }] }
 */
export function checkRecipe(recipe, count, env = {}) {
  const reqs = [];
  const use = [];
  const missing = [];
  for (const need of recipe.needs) {
    if (need.any) {
      const alt = need.any.find((a) => count(a.id) >= a.n);
      if (alt) {
        use.push({ id: alt.id, n: alt.n });
        reqs.push({ id: alt.id, icon: icon(alt.id), name: name(alt.id), have: count(alt.id), need: alt.n, ok: true });
      } else {
        const label = need.any.map((a) => `${icon(a.id)} ${count(a.id)}/${a.n}`).join(' or ');
        reqs.push({ id: need.any[0].id, icon: icon(need.any[0].id), name: need.any.map((a) => name(a.id)).join(' or '), have: count(need.any[0].id), need: need.any[0].n, ok: false, label });
        missing.push(need.any.map((a) => `${a.n} ${name(a.id)}`).join(' or '));
      }
    } else {
      const have = count(need.id);
      const ok = have >= need.n;
      reqs.push({ id: need.id, icon: icon(need.id), name: name(need.id), have, need: need.n, ok });
      if (ok) use.push({ id: need.id, n: need.n });
      else missing.push(`${need.n - have} more ${name(need.id)}`);
    }
  }
  const missingTools = [];
  for (const t of recipe.tools || []) {
    const ok = count(t) >= 1;
    reqs.push({ id: t, icon: icon(t), name: name(t), have: count(t), need: 1, ok, tool: true });
    if (!ok) missingTools.push(name(t));
  }
  let reason = null;
  if (recipe.atFire && !env.nearFire) reason = 'Stand next to a lit fire.';
  else if (missing.length) reason = 'Need ' + missing.join(', ') + '.';
  else if (missingTools.length) reason = `Need ${missingTools.join(' and ')} in your pack to strike sparks (not used up).`;
  else if (recipe.place && env.placement) {
    const p = env.placement(recipe.place);
    if (p && !p.ok) reason = p.reason || "Can't build here.";
  }
  return { ok: !reason, reason, reqs, use };
}

/** Warning text after crafting `recipe` when it used up the last of an important item, else null. */
export function lastUseWarning(recipe, count) {
  const w = recipe?.warnLast;
  if (!w || count(w.id) > 0) return null;
  return w.text;
}
