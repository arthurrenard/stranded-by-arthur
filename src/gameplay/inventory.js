// Inventory (Builder E): item counts, a 9-slot hotbar auto-filled with owned items, item use
// (eat / drink / medicine / torch / flare / canteen) and the drinking interaction provider.
//
// Hotbar rules (stable): an item keeps its slot while you own it. A newly owned item takes the first
// free slot; if the bar is full, a usable item (food, drink, medicine, torch, flare, canteen) evicts the
// right-most raw material (which stays in the backpack, visible in the crafting panel). When a slot
// empties it is refilled from the backpack, usable items first.
//
// Input owned here: Digit1-9 + wheel (select), F / right-click (use). T (torch) is owned by structures.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ITEMS, isConsumable } from '../core/items.js';
import { effectSummary } from '../ui/hud-data.js';

export const SLOTS = 9;
export const isUsable = (id) => !!id && (isConsumable(id) || id === 'torch' || id === 'flare' || id === 'bottle_empty');

export function create(ctx) {
  const counts = new Map();
  const slots = new Array(SLOTS).fill(null);
  const order = []; // every id ever owned, in acquisition order (backpack order)
  let selectedIndex = 0;
  let version = 0;
  let playTime = 0;
  let sipCooldown = 0;
  let flareArmedUntil = -1;
  const delayed = []; // [{ at, fn }] messages that fire after a delay of play time
  const _cam = new THREE.Vector3();
  const _dir = new THREE.Vector3();

  const ui = () => ctx.ui;
  const toast = (text, opts) => ctx.ui?.toast?.(text, opts);
  const play = (name, opts) => ctx.audio?.play?.(name, opts);

  // ── Core inventory ─────────────────────────────────────────────────────
  function count(id) {
    return counts.get(id) || 0;
  }
  function has(id, n = 1) {
    return count(id) >= n;
  }
  function placeInHotbar(id) {
    if (slots.includes(id)) return;
    let i = slots.indexOf(null);
    if (i < 0 && isUsable(id)) {
      for (let k = SLOTS - 1; k >= 0; k--) {
        if (!isUsable(slots[k])) {
          i = k;
          break;
        }
      }
    }
    if (i >= 0) slots[i] = id;
  }
  function refillSlot(i) {
    let best = null;
    for (const id of order) {
      if (!(counts.get(id) > 0) || slots.includes(id)) continue;
      if (isUsable(id)) {
        best = id;
        break;
      }
      if (!best) best = id;
    }
    slots[i] = best;
  }

  /** add(id, n = 1, { silent }) -> number added. silent: no pickup feed line (e.g. returned canteens). */
  function add(id, n = 1, opts = {}) {
    n = Math.floor(n);
    if (!ITEMS[id]) {
      console.warn('[inventory] unknown item id', id);
      return 0;
    }
    if (!(n > 0)) return 0;
    const before = count(id);
    counts.set(id, before + n);
    if (!order.includes(id)) order.push(id);
    if (before === 0) placeInHotbar(id);
    version++;
    ctx.events.emit('item:added', { id, n, total: before + n, silent: !!opts.silent });
    return n;
  }
  /** remove(id, n = 1) -> true if there were enough (nothing is removed otherwise). */
  function remove(id, n = 1) {
    n = Math.floor(n);
    if (!(n > 0)) return true;
    const have = count(id);
    if (have < n) return false;
    const left = have - n;
    if (left > 0) counts.set(id, left);
    else {
      counts.delete(id);
      const i = slots.indexOf(id);
      if (i >= 0) {
        slots[i] = null;
        refillSlot(i);
      }
    }
    version++;
    ctx.events.emit('item:removed', { id, n, total: left });
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
  function select(i) {
    i = Math.max(0, Math.min(SLOTS - 1, Math.floor(i)));
    if (i !== selectedIndex) {
      selectedIndex = i;
      version++;
      play('ui_click', { volume: 0.25 });
    }
    return slots[i];
  }
  function selectStep(dir) {
    const filled = slots.some(Boolean);
    let i = selectedIndex;
    for (let k = 0; k < SLOTS; k++) {
      i = (i + dir + SLOTS) % SLOTS;
      if (!filled || slots[i]) break;
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
  function useItem(id = slots[selectedIndex]) {
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
    /** Hotbar slots (array of 9 item ids or null). Read-only for other modules. */
    get hotbar() {
      return slots;
    },
    get selectedIndex() {
      return selectedIndex;
    },
    get selected() {
      return slots[selectedIndex] || null;
    },
    /** Bumped on every change (HUD re-renders when it changes). */
    get version() {
      return version;
    },
  };
  return api;
}
