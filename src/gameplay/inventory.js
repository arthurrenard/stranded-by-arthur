// Inventory (Builder E, v5 slots by V5-A): item stacks in 9 hotbar slots + a 24-slot backpack grid, item use
// (eat / drink / medicine / torch / flare / canteen), dropping items and the drinking interaction provider.
//
// v5 slot model (SPEC §13): one flat array of HOT + PACK slots (0-8 = hotbar, 9-32 = backpack), each
// {id, n} or null, n ≤ stackLimit(id). The old API is unchanged: count/has sum every stack, list() is one
// aggregated {id, n} per item in acquisition order, `hotbar` is a persistent array of 9 item ids (or null).
// add() fills existing stacks, then the hotbar's empty slots, then the backpack; if the bar is full, a usable
// item that is not on it yet evicts the right-most raw material into the backpack. When everything is full the rest spills as a world drop at the
// player's feet (unless { spill: false }). remove() takes from backpack stacks first so the hotbar stays put;
// a hotbar slot emptied by remove() is refilled from the backpack, usable items first. Moves the player makes
// (drag & drop in the panel) are never auto-rearranged.
//
// Input owned here: Digit1-9 + wheel (select), F / right-click (use), Q / Shift+Q (drop the selected stack /
// one item). T (torch) is owned by structures.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ITEMS, isConsumable } from '../core/items.js';
import { effectSummary } from '../ui/hud-data.js';

export const SLOTS = 9;
export const HOT = SLOTS;
export const PACK = 24;
/** Single-stack items (one per slot). Everything else stacks to STACK. */
const SINGLE = new Set(['shovel', 'pickaxe', 'paddle', 'fishing_rod', 'boat_key', 'diving_mask']);
export const STACK = 20;
export const stackLimit = (id) => (SINGLE.has(id) ? 1 : STACK);
/** v2: what F does (explains) for the boat-repair tools. Parts get a generic "bring it to the Boatyard". */
export const TOOL_TEXT = {
  shovel: 'Look for disturbed sand mounds and press E to dig.',
  pickaxe: 'Look for cracked rocks with a glint inside and press E to break them open.',
  diving_mask: 'Keep it in your pack: hold X while swimming to dive, and your breath lasts twice as long.',
  fishing_rod: 'Look at the water and press R to cast.',
};
/** v5: drop key (Q is free in CONFIG.keys; Shift+Q drops one). */
const DROP_KEYS = CONFIG.keys.drop || ['KeyQ'];
/** v4: raw catches are edible but should be cooked (campfire, R). */
const RAW_CATCH = new Set(['raw_fish', 'big_fish', 'crab']);
// v2 tools count as usable so they get a hotbar slot (F explains them, see TOOL_TEXT)
export const isUsable = (id) => !!id && (isConsumable(id) || id === 'torch' || id === 'flare' || id === 'bottle_empty' || id in TOOL_TEXT);

// ── Pure slot helpers (no ctx, unit-tested in tests/inventory-ui.test.mjs) ────────────────────────────
// S is a flat array: S[0..hot-1] hotbar, S[hot..] backpack; each entry {id, n} or null.
export function newSlots(hot = HOT, pack = PACK) {
  return new Array(hot + pack).fill(null);
}
export function slotTotal(S, id) {
  let t = 0;
  for (let i = 0; i < S.length; i++) if (S[i] && S[i].id === id) t += S[i].n;
  return t;
}
/** Free room for `id` across every slot (existing stacks + empty slots). */
export function roomFor(S, id, limit = stackLimit) {
  const L = limit(id);
  let r = 0;
  for (let i = 0; i < S.length; i++) r += S[i] ? (S[i].id === id ? Math.max(0, L - S[i].n) : 0) : L;
  return r;
}
function firstEmpty(S, a, b) {
  for (let i = a; i < b; i++) if (!S[i]) return i;
  return -1;
}
/**
 * addTo(S, id, n, { hot, usable, limit }) -> number stored. Order (SPEC §13): existing stacks (hotbar first),
 * then the hotbar's empty slots, then the backpack. A usable item that is not on a full hotbar yet evicts the
 * right-most non-usable hotbar stack into the backpack and takes its slot.
 */
export function addTo(S, id, n, opts = {}) {
  const hot = opts.hot ?? HOT;
  const usable = opts.usable ?? isUsable;
  const L = (opts.limit ?? stackLimit)(id);
  n = Math.floor(n);
  if (!(n > 0)) return 0;
  let left = n;
  for (let i = 0; i < S.length && left > 0; i++) {
    const s = S[i];
    if (s && s.id === id && s.n < L) {
      const k = Math.min(L - s.n, left);
      s.n += k;
      left -= k;
    }
  }
  let inHot = false;
  for (let i = 0; i < hot; i++) if (S[i] && S[i].id === id) inHot = true;
  while (left > 0) {
    let i = firstEmpty(S, 0, hot);
    if (i < 0 && !inHot) {
      if (usable(id)) {
        // evict the right-most non-usable hotbar stack into the backpack
        const free = firstEmpty(S, hot, S.length);
        if (free >= 0) {
          for (let k = hot - 1; k >= 0; k--) {
            if (S[k] && !usable(S[k].id)) {
              S[free] = S[k];
              S[k] = null;
              i = k;
              break;
            }
          }
        }
      }
    }
    if (i < 0) i = firstEmpty(S, hot, S.length);
    if (i < 0) break;
    const k = Math.min(L, left);
    S[i] = { id, n: k };
    left -= k;
    if (i < hot) inHot = true;
  }
  return n - left;
}
/** removeFrom(S, id, n, hot) -> array of hotbar indices that became empty, or null if there were not enough. */
export function removeFrom(S, id, n, hot = HOT) {
  n = Math.floor(n);
  if (!(n > 0)) return [];
  if (slotTotal(S, id) < n) return null;
  let left = n;
  const emptied = [];
  // backpack from the end first, then the hotbar from the right
  for (let i = S.length - 1; i >= hot && left > 0; i--) {
    const s = S[i];
    if (!s || s.id !== id) continue;
    const k = Math.min(s.n, left);
    s.n -= k;
    left -= k;
    if (s.n <= 0) S[i] = null;
  }
  for (let i = hot - 1; i >= 0 && left > 0; i--) {
    const s = S[i];
    if (!s || s.id !== id) continue;
    const k = Math.min(s.n, left);
    s.n -= k;
    left -= k;
    if (s.n <= 0) {
      S[i] = null;
      emptied.push(i);
    }
  }
  return emptied;
}
/**
 * moveSlot(S, from, to, { split, limit }) -> true if anything moved. Empty target: move (split: half,
 * rounded up). Same item: merge up to the stack limit. Different item: swap (not when splitting).
 */
export function moveSlot(S, from, to, opts = {}) {
  if (from === to || from < 0 || to < 0 || from >= S.length || to >= S.length) return false;
  const a = S[from];
  if (!a) return false;
  const b = S[to];
  const amount = opts.split ? Math.ceil(a.n / 2) : a.n;
  if (!b) {
    if (amount >= a.n) {
      S[to] = a;
      S[from] = null;
    } else {
      S[to] = { id: a.id, n: amount };
      a.n -= amount;
    }
    return true;
  }
  if (b.id === a.id) {
    const L = (opts.limit ?? stackLimit)(a.id);
    const k = Math.min(Math.max(0, L - b.n), amount);
    if (k <= 0) return false;
    b.n += k;
    a.n -= k;
    if (a.n <= 0) S[from] = null;
    return true;
  }
  if (opts.split) return false;
  S[to] = a;
  S[from] = b;
  return true;
}
/** takeFrom(S, i, n?) -> {id, n} taken out of slot i (whole stack by default), or null. */
export function takeFrom(S, i, n) {
  const s = S[i];
  if (!s) return null;
  const k = Math.max(1, Math.min(s.n, Math.floor(n ?? s.n)));
  s.n -= k;
  if (s.n <= 0) S[i] = null;
  return { id: s.id, n: k };
}
/** refillHot(S, i, hot, usable): put a backpack stack into the empty hotbar slot i (usable items first,
 *  only items that have no hotbar slot yet). Returns true if it moved one. */
export function refillHot(S, i, hot = HOT, usable = isUsable) {
  if (S[i]) return false;
  let best = -1;
  for (let k = hot; k < S.length; k++) {
    const s = S[k];
    if (!s) continue;
    let shown = false;
    for (let h = 0; h < hot; h++) if (S[h] && S[h].id === s.id) shown = true;
    if (shown) continue;
    if (usable(s.id)) {
      best = k;
      break;
    }
    if (best < 0) best = k;
  }
  if (best < 0) return false;
  S[i] = S[best];
  S[best] = null;
  return true;
}

export function create(ctx) {
  const S = newSlots(); // the slots (hotbar + backpack)
  const hotIds = new Array(SLOTS).fill(null); // persistent: rewritten in place by sync()
  const counts = new Map();
  const order = []; // every id ever owned, in acquisition order (list() order)
  let selectedIndex = 0;
  let version = 0;
  let playTime = 0;
  let sipCooldown = 0;
  let flareArmedUntil = -1;
  const delayed = []; // [{ at, fn }] messages that fire after a delay of play time
  const _cam = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _drop = { x: 0, z: 0 };

  const ui = () => ctx.ui;
  const toast = (text, opts) => ctx.ui?.toast?.(text, opts);
  const play = (name, opts) => ctx.audio?.play?.(name, opts);

  // ── Core inventory ─────────────────────────────────────────────────────
  function sync() {
    for (let i = 0; i < SLOTS; i++) hotIds[i] = S[i] ? S[i].id : null;
    counts.clear();
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (s) counts.set(s.id, (counts.get(s.id) || 0) + s.n);
    }
    version++;
  }
  function count(id) {
    return counts.get(id) || 0;
  }
  function has(id, n = 1) {
    return count(id) >= n;
  }

  /** add(id, n = 1, { silent, spill }) -> number handled. silent: no pickup feed line (e.g. returned canteens).
   *  spill (default true): what does not fit is dropped at the player's feet and counts as handled (returns n);
   *  with spill: false (or no world to drop into) it returns only the number stored in the pack. */
  function add(id, n = 1, opts = {}) {
    n = Math.floor(n);
    if (!ITEMS[id]) {
      console.warn('[inventory] unknown item id', id);
      return 0;
    }
    if (!(n > 0)) return 0;
    const before = count(id);
    const stored = addTo(S, id, n);
    if (stored > 0 && !order.includes(id)) order.push(id);
    sync();
    if (stored > 0) ctx.events.emit('item:added', { id, n: stored, total: before + stored, silent: !!opts.silent });
    const rest = n - stored;
    if (rest > 0 && opts.spill !== false) {
      const p = ctx.player?.position;
      if (p && ctx.resources?.spawnDrop) {
        ctx.resources.spawnDrop(id, rest, p.x, p.z);
        toast(`Your pack is full: dropped ${rest} ${ITEMS[id].name} at your feet.`, { icon: '🎒', kind: 'warn', key: 'packfull', duration: 3 });
        // callers read the return value as "taken from the source" (harvests, shelves, catches): the spilled rest
        // is in the world now, so count it as handled (no duplicates); pickups pass spill: false for the real count
        return n;
      } else toast(`Your pack is full: no room for ${ITEMS[id].name}.`, { icon: '🎒', kind: 'warn', key: 'packfull', duration: 3 });
    }
    return stored;
  }
  /** remove(id, n = 1) -> true if there were enough (nothing is removed otherwise). */
  function remove(id, n = 1) {
    n = Math.floor(n);
    if (!(n > 0)) return true;
    const emptied = removeFrom(S, id, n);
    if (!emptied) return false;
    for (const i of emptied) refillHot(S, i);
    sync();
    ctx.events.emit('item:removed', { id, n, total: count(id) });
    return true;
  }
  function list() {
    const out = [];
    for (const id of order) {
      const n = counts.get(id);
      if (n > 0) out.push({ id, n });
    }
    return out;
  }
  /** Move/merge/swap/split between two slot indices (0-8 hotbar, 9-32 backpack). */
  function move(from, to, opts = {}) {
    const ok = moveSlot(S, from, to, { split: !!opts.split });
    if (ok) {
      sync();
      play('ui_click', { volume: 0.2 });
      ctx.events.emit('inventory:changed', { from, to });
    }
    return ok;
  }

  /** Where a drop lands: ~1.2 m in front of the player on the ground, or at the feet when that is deep water. */
  function dropPoint() {
    const p = ctx.player?.position;
    if (!p) return null;
    let fx = 0, fz = 0;
    if (ctx.camera?.getWorldDirection) {
      ctx.camera.getWorldDirection(_dir);
      const hl = Math.hypot(_dir.x, _dir.z);
      if (hl > 1e-4) {
        fx = _dir.x / hl;
        fz = _dir.z / hl;
      }
    }
    _drop.x = p.x + fx * 1.2;
    _drop.z = p.z + fz * 1.2;
    const w = ctx.world?.waterAt?.(_drop.x, _drop.z);
    if ((w && w.depth > 0.5) || ctx.player?.inWater || ctx.player?.swimming) {
      _drop.x = p.x;
      _drop.z = p.z;
    }
    return _drop;
  }
  /** dropSlot(i, n?) -> number dropped: n items (whole stack by default) from slot i become a world pickup. */
  function dropSlot(i, n) {
    const s = S[i];
    if (!s || !ctx.resources?.spawnDrop) return 0;
    const at = dropPoint();
    if (!at) return 0;
    const t = takeFrom(S, i, n);
    if (!t) return 0;
    sync();
    ctx.events.emit('item:removed', { id: t.id, n: t.n, total: count(t.id), dropped: true });
    ctx.resources.spawnDrop(t.id, t.n, at.x, at.z);
    play('ui_click', { volume: 0.3 });
    const it = ITEMS[t.id];
    toast(`Dropped ${t.n > 1 ? t.n + ' ' : ''}${it?.name || t.id}`, { icon: it?.icon, key: 'drop', duration: 1.6 });
    return t.n;
  }
  function dropSelected(one = false) {
    if (!S[selectedIndex]) return 0;
    return dropSlot(selectedIndex, one ? 1 : undefined);
  }
  function select(i) {
    i = Math.max(0, Math.min(SLOTS - 1, Math.floor(i)));
    if (i !== selectedIndex) {
      selectedIndex = i;
      version++;
      play('ui_click', { volume: 0.25 });
    }
    return hotIds[i];
  }
  function selectStep(dir) {
    const filled = hotIds.some(Boolean);
    let i = selectedIndex;
    for (let k = 0; k < SLOTS; k++) {
      i = (i + dir + SLOTS) % SLOTS;
      if (!filled || hotIds[i]) break;
    }
    select(i);
  }

  // ── Water ──────────────────────────────────────────────────────────────
  /** Water the player can drink from: { w (waterAt result), how: 'look'|'feet' } or null. */
  function findWater() {
    const world = ctx.world;
    const pl = ctx.player;
    if (!world || !pl?.position || pl.headUnderwater) return null;
    ctx.camera.getWorldPosition(_cam);
    ctx.camera.getWorldDirection(_dir);
    const reach = CONFIG.player.reach;
    // 1) the view ray reaching a water surface within reach
    if (_dir.y < -0.08) {
      for (let t = 0.7; t <= reach + 0.3; t += 0.4) {
        const x = _cam.x + _dir.x * t, y = _cam.y + _dir.y * t, z = _cam.z + _dir.z * t;
        const w = world.waterAt(x, z);
        if (w && y <= w.surface + 0.5 && _cam.y - w.surface < reach) return { w, how: 'look', down: _dir.y };
      }
      // 2) a point ~1.5 m ahead / below the camera (kneeling at the bank)
      const hl = Math.hypot(_dir.x, _dir.z) || 1;
      const ax = _cam.x + (_dir.x / hl) * 1.5, az = _cam.z + (_dir.z / hl) * 1.5;
      const w = world.waterAt(ax, az);
      if (w && _cam.y - w.surface < 2.4 && w.depth > 0.05) return { w, how: 'look', down: _dir.y };
    }
    // 3) standing in water
    const p = pl.position;
    const wf = world.waterAt(p.x, p.z);
    if (wf && (pl.inWater || p.y < wf.surface + 0.05) && wf.depth > 0.1) return { w: wf, how: 'feet', down: _dir.y };
    return null;
  }

  function waterLabel(w) {
    if (w.type === 'river') return 'Drink from the river';
    if (w.id === 'pond') return 'Drink from the pond';
    if (w.type === 'lake') return 'Drink from the lake';
    return 'Drink';
  }

  function sip(w) {
    if (sipCooldown > 0) return;
    sipCooldown = 0.55;
    const v = ctx.stats?.values;
    if (v && v.thirst >= 99.5) {
      toast("You're not thirsty right now.", { icon: '💧', key: 'drink', duration: 1.8 });
      return;
    }
    ctx.stats?.applyEffects?.({ thirst: 12 }, 'water');
    ctx.events.emit('drink', { source: w.type });
    play('drink');
    const now = ctx.stats?.values?.thirst;
    toast(now != null ? `Cool, fresh water. Thirst ${Math.round(now)}%` : 'Cool, fresh water. +12 💧', { icon: '💧', kind: 'good', key: 'drink', duration: 2 });
  }
  function drinkSea() {
    if (sipCooldown > 0) return;
    sipCooldown = 0.8;
    ctx.stats?.applyEffects?.({ thirst: -8, health: -2 }, 'seawater');
    ctx.events.emit('drink', { source: 'ocean' });
    play('drink');
    toast('Bleh! Salt water. You feel even thirstier.', { icon: '🌊', kind: 'warn', key: 'sea' });
  }
  function fillCanteen() {
    if (!has('bottle_empty')) {
      toast('You need an empty canteen. Craft one from bamboo + fiber.', { icon: '🫙', kind: 'warn', key: 'fill' });
      return false;
    }
    remove('bottle_empty', 1);
    add('bottle_water', 1, { silent: true });
    play('splash', { volume: 0.5 });
    toast('Canteen filled with fresh water.', { icon: '🫗', kind: 'good', key: 'fill' });
    return true;
  }

  // ── Using items ────────────────────────────────────────────────────────
  function later(seconds, fn) {
    delayed.push({ at: playTime + seconds, fn });
  }

  function consume(id) {
    const it = ITEMS[id];
    const fx = it.effects || {};
    const v = ctx.stats?.values;
    if (v) {
      if (it.category === 'food' && v.hunger >= 98 && !(fx.thirst > 0) && id !== 'toadstool') {
        toast("You're too full to eat right now.", { icon: '😌', key: 'full', duration: 2 });
        return false;
      }
      if (it.category === 'drink' && v.thirst >= 99) {
        toast("You're not thirsty right now.", { icon: '💧', key: 'full', duration: 2 });
        return false;
      }
      if (it.category === 'medicine' && v.health >= 99.5 && !(fx.thirst > 0) && !(fx.energy > 0)) {
        toast("You're not hurt right now. Save it for later.", { icon: '🌿', key: 'full', duration: 2 });
        return false;
      }
    }
    ctx.stats?.applyEffects?.(fx, id);
    remove(id, 1);
    if (it.returns) add(it.returns, 1, { silent: true });
    ctx.events.emit('item:consumed', { id });
    const drinky = it.category === 'drink' || id === 'coconut' || id === 'herbal_tea';
    play(drinky ? 'drink' : 'eat');
    if (id === 'bottle_water') ctx.events.emit('drink', { source: 'bottle' });
    if (id === 'coconut') ctx.events.emit('drink', { source: 'coconut' });
    if (ctx.stats_summary && id !== 'bottle_water') ctx.stats_summary.foodsEaten++;

    const verb = it.category === 'drink' || id === 'herbal_tea' ? 'Drank' : it.category === 'medicine' ? 'Used' : 'Ate';
    if (id === 'toadstool') {
      toast('You ate the Red Toadstool. It tastes… odd.', { icon: it.icon, key: 'eat' });
      later(5, () => {
        toast('You feel sick… that mushroom was poisonous!', { icon: '🤢', kind: 'bad' });
        ui()?.flash?.('#6a9a20', 1.4, 0.35);
        ui()?.markJournal?.('plant:toadstool', { poisonous: true });
        play('gasp');
      });
      return true;
    }
    const harmful = (fx.health || 0) < 0 || fx.nausea > 0;
    toast(`${verb} ${it.name}   ${effectSummary(fx)}`, { icon: it.icon, kind: harmful ? 'warn' : 'good', key: 'eat', duration: 3 });
    if (id === 'chanterelle') {
      later(1.5, () => toast('Your stomach cramps. Chanterelles are much better cooked.', { icon: '😖', kind: 'warn' }));
      ui()?.hint?.('raw_chanterelle', 'Raw chanterelles upset the stomach. Cook them at a campfire first (R at the fire).');
    } else if (id === 'nettle') {
      toast('Ouch! Raw nettles sting. Boil them into soup at a fire.', { icon: '🌿', kind: 'warn' });
    } else if (RAW_CATCH.has(id)) {
      later(1.2, () => toast('Cook it at a campfire first (R at the fire): raw, it turns your stomach.', { icon: '🔥', kind: 'warn', key: 'rawcatch' }));
    } else if (id === 'wild_root') {
      later(1.5, () => toast('Bitter… your stomach turns. Bake it next time.', { icon: '🥔', kind: 'warn' }));
    }
    return true;
  }

  function fireFlare() {
    const active = ctx.rescue?.activePass;
    if (!active && playTime > flareArmedUntil) {
      flareArmedUntil = playTime + 3;
      toast('Nobody is around to see it. Press F again to fire the flare anyway.', { icon: '🧨', kind: 'warn', key: 'flare' });
      return false;
    }
    flareArmedUntil = -1;
    if (!remove('flare', 1)) return false;
    ctx.camera.getWorldPosition(_cam);
    ctx.camera.getWorldDirection(_dir);
    const position = new THREE.Vector3().copy(_cam).addScaledVector(_dir, 0.6);
    ctx.events.emit('flare:fired', { position });
    toast('You fire the flare high into the sky!', { icon: '🧨', kind: 'good', key: 'flare' });
    return true;
  }

  /** Use an item (default: the selected one). Returns true if something happened. */
  function useItem(id = hotIds[selectedIndex]) {
    if (!id || !has(id)) return false;
    if (ctx.state !== 'playing' || ctx.flags.cinematic) return false;
    const it = ITEMS[id];
    if (id === 'torch') return !!ctx.structures?.toggleTorch?.();
    if (id === 'flare') return fireFlare();
    if (id === 'bottle_empty') {
      const f = findWater();
      if (f?.w?.fresh) return fillCanteen();
      toast('Stand by the pond, river or lake and press R to fill it.', { icon: '🫙', key: 'fill' });
      return false;
    }
    if (isConsumable(id)) return consume(id);
    // v2 tools and boat parts: not used directly, so say what they are for
    const how = TOOL_TEXT[id] || (it?.category === 'part' ? 'Bring it to the Boatyard on the beach where you washed ashore (Journal → Boat).' : null);
    if (how) {
      toast(`${it.name}: ${how}`, { icon: it.icon, key: 'mat', duration: 4.5 });
      return false;
    }
    toast(`${it.name} is a crafting material. Press Tab to craft.`, { icon: it.icon, key: 'mat', duration: 2.5 });
    return false;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  function init() {
    ctx.interact?.addProvider?.((c) => {
      if (c.state !== 'playing' || c.flags.cinematic) return null;
      const f = findWater();
      if (!f) return null;
      const w = f.w;
      if (!w.fresh) {
        // don't nag while wading in the surf: only when looking down at it
        if (f.down > -0.35) return null;
        return { label: 'Drink seawater', onUse: drinkSea, score: 0.6 };
      }
      const empty = count('bottle_empty');
      return {
        label: waterLabel(w),
        onUse: () => sip(w),
        secondary: empty > 0 ? { label: empty > 1 ? `Fill canteen (${empty} empty)` : 'Fill canteen', onUse: fillCanteen } : null,
        score: f.how === 'look' ? 1.1 : 0.8,
      };
    });
  }

  function update(dt) {
    sipCooldown = Math.max(0, sipCooldown - dt);
    if (ctx.state !== 'playing' || ctx.ui?.menuOpen) return;
    playTime += dt;
    for (let i = delayed.length - 1; i >= 0; i--) {
      if (playTime >= delayed[i].at) {
        const d = delayed[i];
        delayed.splice(i, 1);
        d.fn();
      }
    }
    if (ctx.flags.cinematic || ctx.stats?.dead) return;
    const input = ctx.input;
    const keys = CONFIG.keys.hotbar;
    for (let i = 0; i < keys.length; i++) if (input.wasPressed(keys[i])) select(i);
    const wheel = input.wheel;
    if (wheel) selectStep(wheel > 0 ? 1 : -1);
    if (input.wasPressed('useItem')) useItem();
    if (input.wasPressed(DROP_KEYS)) dropSelected(!!input.isDown?.('sprint'));
  }

  const api = {
    init,
    update,
    add,
    remove,
    count,
    has,
    list,
    select,
    selectStep,
    useItem,
    useSelected: () => useItem(),
    findWater,
    fillCanteen,
    move,
    dropSlot,
    dropSelected,
    stackLimit,
    HOT,
    PACK,
    /** Hotbar slots (persistent array of 9 item ids or null). Read-only for other modules. */
    get hotbar() {
      return hotIds;
    },
    /** v5: every slot (0-8 hotbar, 9-32 backpack), each {id, n} or null. Read-only: use move/dropSlot. */
    get slots() {
      return S;
    },
    /** v5: stack size in slot i (0 if empty). */
    slotN: (i) => S[i]?.n || 0,
    get selectedIndex() {
      return selectedIndex;
    },
    get selected() {
      return hotIds[selectedIndex] || null;
    },
    /** Bumped on every change (HUD re-renders when it changes). */
    get version() {
      return version;
    },
  };
  return api;
}
