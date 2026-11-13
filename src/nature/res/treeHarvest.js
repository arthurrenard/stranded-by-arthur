// v2 tree harvests (owned by resources.js): pick apples, gather chestnuts, shake palms for coconuts and strip leaves
// from birches / willows, straight from the standing trees in ctx.flora.trees.
// One ctx.interact entry per eligible tree, on the trunk ~1.4 m up. interact.js indexes entries in a spatial hash, so
// thousands cost nothing per frame. After a harvest the entry is hidden (enabled() false) until it regrows (~1 game day).
// A fallen tree (alive === false) is hidden for good. Entry `data` deliberately has no `__res` flag: resources.js treats
// `__res` data as an instanced mesh slot (hover pulse).
// v3: every palm shake has a CONFIG.palmDeathChance (5 %) chance to drop a coconut on your head: game over ('coconut').
import { ITEMS } from '../../core/items.js';
import { CONFIG } from '../../config.js';

/** Per tree type: what a harvest gives. `chance` = success odds per try (palm shake); a miss costs `missCooldownH`. */
export const TREE_HARVESTS = {
  apple: { label: 'Pick apples', item: 'wild_apple', n: [2, 3], burst: 0xa6bf3c, sound: 'pickup' },
  chestnut: { label: 'Gather chestnuts', item: 'chestnut', n: [1, 3], burst: 0x8a6a3a, sound: 'pickup' },
  palm: {
    label: 'Shake the palm',
    item: 'coconut',
    n: [1, 1],
    chance: 0.3,
    bonk: true, // v3: CONFIG.palmDeathChance per shake drops a coconut on your head (see bonk())
    missCooldownH: 0.025, // ~0.75 real s: the fronds are still swaying
    missMsg: ['The fronds rustle, but nothing falls. Shake again!', 'Nothing yet… the coconuts hang on tight.', 'A few dry fronds drift down. No coconut.'],
    burst: 0x86603a,
    sound: 'tree_creak',
  },
  birch: { label: 'Gather leaves', item: 'leaves', n: [3, 3], burst: 0x7fb84e, sound: 'pickup' },
  willow: { label: 'Gather leaves', item: 'leaves', n: [3, 3], burst: 0x8fbf5a, sound: 'pickup' },
};
/** Game hours until a harvested tree can be harvested again. */
export const TREE_REGROW_H = [20, 28];
const TRUNK_UP = 1.4; // interaction point height on the trunk (m above the ground)
const RADIUS = 2.6; // reach from the camera to that point (plus the trunk radius)

/**
 * deps: { rand () => 0..1, now () => game hours, burst(x, y, z, color, count), itemName(id) }
 * Returns { add(tree), entries, count, regrowAll() }.
 */
export function createTreeHarvest(ctx, deps) {
  const { rand, now, burst, itemName } = deps;
  const entries = [];
  const audioPos = ctx.THREE ? new ctx.THREE.Vector3() : { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
  let missIndex = 0;

  /** Register one tree ({ x, z, y?, type, height?, trunkR?, alive?, special? }). Returns the entry or null. */
  function add(tree) {
    const def = tree && TREE_HARVESTS[tree.type];
    if (!def || !ctx.interact?.register || tree.special || tree.alive === false) return null;
    if (!Number.isFinite(tree.x) || !Number.isFinite(tree.z) || (tree.height ?? 5) < 2) return null;
    const gy = Number.isFinite(tree.y) ? tree.y : ctx.world?.heightAt?.(tree.x, tree.z) ?? 0;
    const up = Math.min(TRUNK_UP, Math.max(0.8, (tree.height ?? 5) * 0.35));
    const e = { tree, def, readyAt: -1, x: tree.x, y: gy + up, z: tree.z, handle: null };
    e.handle = ctx.interact.register({
      position: { x: e.x, y: e.y, z: e.z },
      radius: RADIUS + (tree.trunkR ?? 0.25),
      label: def.label,
      priority: -0.3, // fruit piles at the foot of the trunk win when both are in view
      onUse: () => harvest(e),
      enabled: () => tree.alive !== false && now() >= e.readyAt,
      data: { __tree: true, tree, type: tree.type },
    });
    entries.push(e);
    return e;
  }

  function harvest(e) {
    const { def, tree } = e;
    const t = now();
    if (tree.alive === false || t < e.readyAt) return;
    if (def.sound) {
      audioPos.set(e.x, e.y + 0.6, e.z);
      ctx.audio?.play?.(def.sound, { position: audioPos, volume: def.sound === 'tree_creak' ? 0.45 : 1 });
    }
    if (def.bonk && ctx.state === 'playing' && rand() < (CONFIG.palmDeathChance ?? 0.05)) {
      bonk(e);
      return;
    }
    if (def.chance != null && rand() >= def.chance) {
      e.readyAt = t + (def.missCooldownH ?? 0);
      burst(e.x, e.y + 1.4, e.z, 0x9a8a50, 6);
      const lines = def.missMsg || ['Nothing falls.'];
      ctx.ui?.toast?.(lines[missIndex++ % lines.length], { icon: '🌴', kind: 'info', duration: 2 });
      return;
    }
    const n = def.n[0] + Math.floor(rand() * (def.n[1] - def.n[0] + 1));
    const r = ctx.inventory?.add?.(def.item, n);
    const added = typeof r === 'number' ? r : n;
    if (added <= 0) {
      ctx.ui?.toast?.(`No room for more ${itemName(def.item)}`, { icon: ITEMS[def.item]?.icon, kind: 'warn', duration: 2.5 });
      return;
    }
    e.readyAt = t + TREE_REGROW_H[0] + rand() * (TREE_REGROW_H[1] - TREE_REGROW_H[0]);
    if (def.sound !== 'pickup') {
      audioPos.set(e.x, e.y, e.z);
      ctx.audio?.play?.('pickup', { position: audioPos });
    }
    burst(e.x, e.y + 0.4, e.z, def.burst ?? 0x88aa55, 14);
    if (ctx.stats_summary) ctx.stats_summary.plantsGathered = (ctx.stats_summary.plantsGathered || 0) + 1;
    const extra = tree.type === 'palm' ? ' (a coconut thuds down!)' : '';
    ctx.ui?.toast?.(`+${added} ${itemName(def.item)}${extra}`, { icon: ITEMS[def.item]?.icon, kind: 'good', duration: 2 });
    ctx.events?.emit?.('harvest', { id: def.item, n: added, kind: 'tree_' + tree.type });
  }

  /** A coconut lands on the player's head: thud, white flash, "Bonk.", then death (god mode: just the bonk). */
  function bonk(e) {
    e.readyAt = now() + (e.def.missCooldownH ?? 0);
    const p = ctx.player?.position;
    audioPos.set(p ? p.x : e.x, p ? p.y + 1.7 : e.y, p ? p.z : e.z);
    ctx.audio?.play?.('land', { volume: 1.2 });
    ctx.ui?.flash?.('#fff', 0.2);
    ctx.ui?.subtitle?.('Bonk.', 2);
    burst(audioPos.x, audioPos.y + 0.2, audioPos.z, 0x86603a, 10);
    ctx.events?.emit?.('palm:bonk', { tree: e.tree });
    if (ctx.flags?.godMode) return;
    // a beat for the gag to land, then lights out (waits out a pause)
    const kill = () => {
      if (ctx.state === 'paused') return void setTimeout(kill, 250);
      if (ctx.state === 'playing' && !ctx.flags?.godMode) ctx.stats?.damage?.(1e4, 'coconut');
    };
    setTimeout(kill, 450);
  }

  function regrowAll() {
    for (const e of entries) e.readyAt = -1;
  }

  return {
    add,
    entries,
    get count() {
      return entries.length;
    },
    regrowAll,
  };
}
