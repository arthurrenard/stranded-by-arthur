// The fisherman's hut on Tempest Isle's summit plateau (V3-B): the cabin, its interior (bunk, logbook, shelves,
// rod rack, key hook, jerrycan, stone hearth), the lantern that glows in the window at night (a fog-free sprite so
// it reads from the main island), the indoor hearth fire (ctx.heatSources kind 'hearth', storms never douse it), and
// setting the whole thing on fire for fun ([R] twice at the door) → ~70 s blaze → charred ruins.
// ctx contract (SPEC §11): ctx.shelters gets { position, radius, indoor: true }; isIndoors(pos); partsInHut().
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ITEMS, COOKABLE } from '../core/items.js';
import { makeDotTexture } from '../nature/res/materials.js';
import { HUT, BURN, hutWorld, insideHut, hutContents, hutParts, canSleepAt, logbookPages, burnIntensity, clamp01 } from './isle2-logic.js';
import { buildHut } from './isle2-models.js';

const HEARTH_START_H = 6; // game hours of fuel when lit (a well-built hearth burns long)
const HEARTH_WOOD_H = 2;
const HEARTH_MAX_H = 14;
const N_BLAZE = 22; // flame tongues for the burning hut

export function createHut(ctx, { group, rand, fx }) {
  const W = ctx.world;
  const L = W.landmarks;
  const H0 = L.isle2Hut;
  const dock = L.isle2Dock;
  let fx0 = dock.x - H0.x, fz0 = dock.z - H0.z;
  const fl = Math.hypot(fx0, fz0) || 1;
  const frame = { x: H0.x, z: H0.z, fx: fx0 / fl, fz: fz0 / fl };
  // floor: just above the highest ground under the footprint
  let floorY = -Infinity;
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    const p = hutWorld(frame, (i / 4 - 0.5) * HUT.D, (j / 4 - 0.5) * HUT.W);
    floorY = Math.max(floorY, W.heightAt(p.x, p.z));
  }
  floorY += 0.06;
  const at = (u, y, v, out = new THREE.Vector3()) => {
    const p = hutWorld(frame, u, v);
    return out.set(p.x, floorY + y, p.z);
  };

  // ── Meshes ────────────────────────────────────────────────────────────
  const M = buildHut(rand);
  const A = M.anchors;
  const root = new THREE.Group();
  root.name = 'isle2-hut';
  root.position.set(frame.x, floorY, frame.z);
  root.rotation.y = Math.atan2(-frame.fz, frame.fx);
  group.add(root);
  const std = (o = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, flatShading: true, ...o });
  const woodMat = std(); // own instance: it chars while the hut burns
  const stoneMat = std();
  const propMat = std({ roughness: 0.7 });
  const ruinMat = std({ roughness: 1 });
  const glassMat = new THREE.MeshBasicMaterial({ color: 0x2a3640, transparent: true, opacity: 0.55, depthWrite: false });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffc878 });
  const mesh = (geo, mat, name, cast = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = 'isle2-hut-' + name;
    m.castShadow = cast;
    m.receiveShadow = true;
    root.add(m);
    return m;
  };
  const shell = mesh(M.shell, woodMat, 'shell');
  const roof = mesh(M.roof, woodMat, 'roof');
  const stone = mesh(M.stone, stoneMat, 'stone');
  const glass = mesh(M.glass, glassMat, 'glass', false);
  const lanternGlow = mesh(M.lanternGlow, glowMat, 'lantern', false);
  const props = {};
  for (const k in M.props) props[k] = mesh(M.props[k], propMat, k, false);
  const ruins = mesh(M.ruins, ruinMat, 'ruins');
  const ash = mesh(M.ash, ruinMat, 'ash', false);
  ruins.visible = ash.visible = false;
  const roofHome = { y: roof.position.y, rz: roof.rotation.z };

  // One PointLight for the lantern, the hearth and the blaze: created once and only its intensity changes
  // (adding/removing/toggling lights would recompile every material in the scene).
  const light = new THREE.PointLight(0xff9a4a, 0, 10, 2); // intensities match structures.js LIGHT (campfire 24, torch 9)
  light.castShadow = false;
  light.name = 'isle2-hut-light';
  light.position.set(A.lantern.u, A.lantern.y + 0.35, -A.lantern.v);
  root.add(light);
  // Far lantern glow seen through the window from across the sea (fog-free, distance-scaled).
  const farGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: makeDotTexture(32), color: 0xffb466, transparent: true, opacity: 0, depthWrite: false, fog: false, blending: THREE.AdditiveBlending })
  );
  farGlow.name = 'isle2-hut-farglow';
  farGlow.position.set(HUT.D / 2 + 0.25, (HUT.window.y0 + HUT.window.y1) / 2, -(HUT.window.v0 + HUT.window.v1) / 2);
  root.add(farGlow);
  const farGlowWorld = at(HUT.D / 2 + 0.25, (HUT.window.y0 + HUT.window.y1) / 2, (HUT.window.v0 + HUT.window.v1) / 2);

  // ── Colliders (walls leave the doorway open) ───────────────────────────
  const colliders = [];
  const addC = (u, v, r, y1) => {
    const p = hutWorld(frame, u, v);
    colliders.push(ctx.colliders?.add?.({ x: p.x, z: p.z, r, y0: floorY - 1, y1: floorY + y1, tag: 'hut' }));
  };
  {
    const D2 = HUT.D / 2 - HUT.wallT / 2, W2 = HUT.W / 2 - HUT.wallT / 2, r = 0.2, step = 0.32;
    const wallY = HUT.wallH + 0.3;
    for (let v = -W2; v <= W2 + 1e-6; v += step) {
      addC(-D2, v, r, wallY); // back
      if (v <= HUT.door.v0 - r || v >= HUT.door.v1 + r) addC(D2, v, r, wallY); // front, minus the door
    }
    for (let u = -D2 + step; u < D2 - step / 2; u += step) {
      addC(u, W2, r, wallY);
      addC(u, -W2, r, wallY);
    }
    addC(D2, HUT.door.v0 - r, r, wallY);
    addC(D2, HUT.door.v1 + r, r, wallY);
    // furniture
    addC(A.bunk.u, A.bunk.v - 0.5, 0.42, 0.62);
    addC(A.bunk.u, A.bunk.v + 0.5, 0.42, 0.62);
    addC(A.table.u, A.table.v, 0.42, 0.8);
    addC(A.hearth.u, A.hearth.v - 0.08, 0.42, 1.1);
    addC(A.shelves.u, A.shelves.v + 0.05, 0.32, 1.9);
  }

  // ── State ─────────────────────────────────────────────────────────────
  const center = at(0, 0, 0);
  const shelter = { position: center.clone(), radius: 3.4, indoor: true, kind: 'hut' };
  ctx.shelters?.add?.(shelter);
  const hearthPos = at(A.hearth.u, A.hearth.y, A.hearth.v);
  const chimneyTop = at(A.hearth.u, 4.5, A.hearth.v - 0.1);
  const hearth = { lit: false, fuelH: 0, heat: { position: hearthPos, radius: 6.5, warmth: 1, kind: 'hearth', indoor: true, isActive: () => hearth.lit && state !== 'ruins' } };
  let state = 'intact'; // 'intact' | 'burning' | 'ruins'
  let collapsed = false;
  let burnT = 0, smolderT = 0, armedUntil = -1, playTime = 0, hurtAcc = 0, hurtWarned = false;
  let shelf = null; // Map id -> count still on the shelves (fixed at the first search or the fire)
  let shelfPlan = null;
  const given = {}; // id -> pieces the player got (from the shelves or the dropped pickups)
  let logPage = 0;
  let firewoodTaken = false;
  let cookQueue = null; // { ids: [], t, done }
  let ashesEntry = null;
  const blazeHeat = { position: at(0, 1.5, 0), radius: BURN.heatRadius, warmth: 1, kind: 'campfire', isActive: () => state === 'burning' };
  const blazeSignal = { kind: 'signal_fire', position: at(0, 4, 0), strength: 900, isActive: () => state === 'burning' };
  const handles = [];

  const plan = () => ctx.difficulty?.plan || CONFIG.difficulty?.presets?.[CONFIG.difficulty?.default]?.plan || 'raft';
  const has = (id, n = 1) => !!ctx.inventory?.has?.(id, n);
  const count = (id) => ctx.inventory?.count?.(id) ?? 0;
  const toast = (t, o) => ctx.ui?.toast?.(t, o);
  const name = (id) => ITEMS[id]?.name ?? id;

  function ensureShelf() {
    if (shelf) return;
    shelf = new Map();
    shelfPlan = plan();
    for (const e of hutContents(CONFIG.raft, shelfPlan)) shelf.set(e.id, e.n);
  }
  function shelfLeft(id) {
    if (!shelf) return id === 'compass' ? hutParts(CONFIG.raft, plan()).length : 1;
    return shelf.get(id) || 0;
  }

  // ── Interactions ──────────────────────────────────────────────────────
  const intact = () => state === 'intact';
  function search() {
    ensureShelf();
    const got = [], left = [];
    for (const [id, n] of shelf) {
      if (n <= 0) continue;
      const r = ctx.inventory?.add?.(id, n);
      const added = typeof r === 'number' ? Math.max(0, Math.min(n, r)) : n;
      if (added > 0) {
        shelf.set(id, n - added);
        given[id] = (given[id] || 0) + added;
        got.push(added > 1 ? `${added} ${name(id)}s` : name(id));
      }
      if (n - added > 0) left.push(name(id));
    }
    syncProps();
    if (got.length) {
      ctx.audio?.play?.('pickup', { position: center });
      toast(`You find: ${got.join(', ')}.`, { icon: '🎣', kind: 'good', duration: 5 });
      if (given.boat_key && given.fuel_can) ctx.ui?.hint?.('isle2-boat', 'The boat key and a can of fuel: the motorboat at the dock should run now.');
    }
    if (left.length) toast(`No room for: ${left.join(', ')}. They stay on the shelf.`, { icon: '🎒', kind: 'warn', duration: 4 });
  }
  function shelvesEmpty() {
    if (!shelf) return false;
    for (const n of shelf.values()) if (n > 0) return false;
    return true;
  }
  function syncProps() {
    props.rods.visible = shelfLeft('fishing_rod') > 0 && state !== 'ruins';
    props.key.visible = shelfLeft('boat_key') > 0 && state !== 'ruins';
    props.jerrycan.visible = shelfLeft('fuel_can') > 0 && state !== 'ruins';
    props.compass.visible = shelfLeft('compass') > 0 && state !== 'ruins';
    props.firewood.visible = !firewoodTaken && state !== 'ruins';
    props.logbook.visible = state !== 'ruins';
  }

  function sleep() {
    const h = ctx.time?.hour ?? 12;
    if (!canSleepAt(h)) {
      toast("You're not tired yet. The bunk is for the night (19:00 – 05:00).", { icon: '🛏️', duration: 3 });
      return;
    }
    const hrs = ctx.time?.hoursUntil?.(6.5) ?? ((6.5 - h + 24) % 24);
    ctx.stats?.sleep?.(hrs);
  }
  function readLog() {
    const pages = logbookPages(hutParts(CONFIG.raft, shelfPlan || plan()).length > 0);
    const text = pages[logPage % pages.length];
    logPage++;
    if (ctx.ui?.subtitle) ctx.ui.subtitle(text, 8);
    else toast(text, { icon: '📖', kind: 'story', duration: 8 });
  }
  function hearthUse() {
    if (hearth.lit) {
      if (!ctx.inventory?.remove?.('wood', 1)) return toast('You need wood to feed the hearth.', { icon: '🪵', kind: 'warn' });
      hearth.fuelH = Math.min(HEARTH_MAX_H, hearth.fuelH + HEARTH_WOOD_H);
      toast(`The hearth crackles (${Math.round(hearth.fuelH)} h of fuel).`, { icon: '🔥', duration: 2 });
      return;
    }
    if (!has('flint') || !has('pyrite') || !has('wood')) {
      toast('To light the hearth you need flint, pyrite and a piece of wood.', { icon: '🔥', kind: 'warn', duration: 3.5 });
      return;
    }
    ctx.inventory.remove('wood', 1);
    hearth.lit = true;
    hearth.fuelH = HEARTH_START_H;
    ctx.heatSources?.add?.(hearth.heat);
    ctx.audio?.play?.('ignite', { position: hearthPos });
    toast('The hearth roars to life. No storm can reach it in here.', { icon: '🔥', kind: 'good', duration: 3.5 });
  }
  function hearthOut(msg) {
    if (!hearth.lit) return;
    hearth.lit = false;
    hearth.fuelH = 0;
    ctx.heatSources?.delete?.(hearth.heat);
    if (msg) toast(msg, { icon: '🔥', duration: 3 });
  }
  function cookables() {
    let n = 0;
    for (const id of COOKABLE) n += count(id);
    return n;
  }
  function startCook() {
    if (cookQueue) return;
    const ids = [];
    for (const id of COOKABLE) for (let k = count(id); k > 0; k--) ids.push(id);
    if (!ids.length) return;
    cookQueue = { ids, t: 0, done: 0, byId: {} };
    toast(`Cooking ${ids.length} item${ids.length > 1 ? 's' : ''} at the hearth…`, { icon: '🍳', duration: 2 });
  }
  function updateCook(dt) {
    if (!cookQueue) return;
    if (!hearth.lit || state !== 'intact' || ctx.player?.position?.distanceTo?.(hearthPos) > 5) {
      if (cookQueue.done) toast(`Cooked ${cookQueue.done} item${cookQueue.done > 1 ? 's' : ''}.`, { icon: '🍳' });
      cookDone();
      return;
    }
    cookQueue.t += dt;
    const per = CONFIG.fire?.cookSeconds ?? 1.6;
    while (cookQueue.t >= per && cookQueue.ids.length) {
      cookQueue.t -= per;
      const id = cookQueue.ids.shift();
      const to = ITEMS[id]?.cooksInto;
      if (to && ctx.inventory?.remove?.(id, 1)) {
        ctx.inventory.add(to, 1);
        cookQueue.done++;
        cookQueue.byId[id] = (cookQueue.byId[id] || 0) + 1;
      }
    }
    if (!cookQueue.ids.length) {
      toast(`Cooked ${cookQueue.done} item${cookQueue.done > 1 ? 's' : ''} at the hearth.`, { icon: '🍳', kind: 'good' });
      cookDone();
    }
  }
  function cookDone() {
    for (const id in cookQueue.byId) ctx.events?.emit?.('food:cooked', { from: id, to: ITEMS[id]?.cooksInto, n: cookQueue.byId[id] });
    cookQueue = null;
  }
  function canIgnite() {
    return !!ctx.flags?.torchLit || (has('flint') && has('pyrite'));
  }
  function fireDoor() {
    if (!intact()) return;
    if (playTime > armedUntil) {
      armedUntil = playTime + BURN.confirmSec;
      toast('Really? Press R again to set the hut on fire.', { icon: '🔥', kind: 'warn', duration: BURN.confirmSec, key: 'hutfire' });
      return;
    }
    armedUntil = -1;
    ignite();
  }

  function init() {
    const reg = (def) => {
      const h = ctx.interact?.register?.(def);
      if (h) handles.push(h);
      return h;
    };
    reg({ position: at(A.bunk.u, 0.75, A.bunk.v), label: () => (canSleepAt(ctx.time?.hour ?? 12) ? 'Sleep in the bunk' : 'Sleep in the bunk (19:00 – 05:00)'), onUse: sleep, enabled: intact });
    reg({ position: at(A.table.u + 0.05, 0.9, A.table.v - 0.1), label: 'Read the logbook', onUse: readLog, enabled: intact, priority: 0.2 });
    reg({
      position: at(A.shelves.u, 1.15, A.shelves.v),
      label: () => (shelf ? 'Search the shelves (something is left)' : 'Search the shelves'),
      onUse: search,
      enabled: () => intact() && !shelvesEmpty(),
      priority: 0.3,
    });
    reg({
      position: at(A.hearth.u, 0.75, A.hearth.v + 0.25),
      label: () => (hearth.lit ? `Add wood to the hearth (${Math.max(0, Math.round(hearth.fuelH))} h left)` : 'Light the hearth'),
      onUse: hearthUse,
      secondary: {
        label: () => {
          if (!hearth.lit || cookQueue) return '';
          const n = cookables();
          return n > 0 ? `Cook ${n} item${n > 1 ? 's' : ''}` : '';
        },
        onUse: startCook,
      },
      enabled: intact,
    });
    reg({
      position: at(A.firewood.u, 0.35, A.firewood.v + 0.2),
      label: 'Take the firewood',
      onUse: () => {
        const r = ctx.inventory?.add?.('wood', 4);
        if ((typeof r === 'number' ? r : 4) <= 0) return toast('No room for more wood.', { icon: '🪵', kind: 'warn' });
        firewoodTaken = true;
        syncProps();
        ctx.audio?.play?.('pickup', { position: center });
        toast('+4 Wood (dry firewood from the stack)', { icon: '🪵', kind: 'good' });
      },
      enabled: () => intact() && !firewoodTaken,
    });
    reg({
      position: at(A.door.u, 1.1, A.door.v),
      radius: 3.3,
      label: '',
      secondary: { label: () => (playTime <= armedUntil ? 'Really? Press R again' : 'Set the hut on fire'), onUse: fireDoor },
      enabled: () => intact() && canIgnite(),
      priority: -0.4,
    });
    syncProps();
  }

  // ── The blaze ─────────────────────────────────────────────────────────
  const blaze = [];
  const blazeSlot = fx?.flames ? fx.flames.alloc(N_BLAZE + 2) : -1;
  const hearthSlot = fx?.flames ? fx.flames.alloc(4) : -1;
  for (let i = 0; i < N_BLAZE; i++) {
    const roofish = i >= 14;
    const u = (rand() - 0.5) * HUT.D * 0.95, v = (rand() - 0.5) * HUT.W * 0.95;
    const p = at(u, roofish ? 2.1 + rand() * 0.9 : 0.1 + rand() * 1.4, v);
    const d = Math.hypot(u - HUT.D / 2, v - A.door.v);
    blaze.push({ x: p.x, y: p.y, z: p.z, w: 1.1 + rand() * 1.1, h: 1.8 + rand() * 2.2, delay: d / 0.55 + rand() * 1.5, seed: rand() * 10, roof: roofish });
  }
  const puff = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rise: 0, size0: 0, size1: 0, life: 0, r: 0, g: 0, b: 0, alpha: 0, glow: 0, wind: 1 };
  let smokeAcc = 0, emberAcc = 0, chimAcc = 0;
  const charCol = new THREE.Color(0.17, 0.14, 0.12);
  const white = new THREE.Color(1, 1, 1);

  function ignite() {
    if (state !== 'intact') return;
    state = 'burning';
    burnT = 0;
    ensureShelf(); // the contents are fixed now (difficulty can no longer change)
    hearthOut();
    cookQueue = null;
    ctx.heatSources?.add?.(blazeHeat);
    ctx.signals?.add?.(blazeSignal);
    ctx.audio?.play?.('ignite', { position: center, volume: 1 });
    toast('The dry old planks catch at once…', { icon: '🔥', kind: 'warn', duration: 3 });
    pendingToast = { t: 2.6, text: 'Some people just want to watch the world burn.' };
    ctx.events?.emit?.('isle2:hutFire', { position: center.clone() });
  }
  let pendingToast = null;

  function collapse() {
    if (collapsed) return;
    collapsed = true;
    ctx.shelters?.delete?.(shelter);
    ctx.audio?.play?.('tree_crash', { position: center, volume: 0.9 });
    if (fx?.smoke) {
      for (let k = 0; k < 14; k++) {
        puffAt(center.x + (rand() - 0.5) * 4, floorY + 1 + rand() * 2, center.z + (rand() - 0.5) * 4, 0.22, 3.5, 2, 9, 7, 0.7);
      }
    }
    if (fx?.embers) for (let k = 0; k < 60; k++) emberAt(center.x + (rand() - 0.5) * 4, floorY + 1.5, center.z + (rand() - 0.5) * 4, 5);
  }
  function finishBurn() {
    state = 'ruins';
    collapse();
    shell.visible = roof.visible = glass.visible = lanternGlow.visible = false;
    ruins.visible = ash.visible = true;
    stoneMat.color.setRGB(0.55, 0.52, 0.5);
    farGlow.visible = false;
    syncProps();
    for (const c of colliders) if (c) ctx.colliders?.remove?.(c);
    colliders.length = 0;
    // the stone hearth and chimney still stand
    addC(A.hearth.u, A.hearth.v - 0.08, 0.42, 1.1);
    ctx.heatSources?.delete?.(blazeHeat);
    ctx.signals?.delete?.(blazeSignal);
    ctx.heatSources?.delete?.(hearth.heat);
    smolderT = BURN.smolder;
    dropLeftovers();
    toast('The fishing hut is a smoking ruin.', { icon: '🔥', duration: 3.5 });
  }

  /** Everything still on the shelves lands outside the door as pickups (kept: they never despawn). */
  function dropLeftovers() {
    ensureShelf();
    let k = 0;
    const left = [];
    for (const [id, n] of shelf) {
      if (n <= 0) continue;
      const p = hutWorld(frame, HUT.D / 2 + 1.5 + (k % 2) * 0.9, -1.6 + k * 0.75);
      k++;
      const drop = ctx.resources?.spawnItem?.(id, p.x, p.z, n, { keep: true, onPick: (got) => (given[id] = (given[id] || 0) + got) });
      if (drop) shelf.set(id, 0);
      else left.push(id);
    }
    if (left.length && !ashesEntry) {
      // no resources module (or it refused): keep them in the ashes instead
      ashesEntry = ctx.interact?.register?.({
        position: at(HUT.D / 2 + 1.2, 0.4, -0.9),
        label: 'Search the ashes',
        onUse: () => {
          const got = [];
          for (const [id, n] of shelf) {
            if (n <= 0) continue;
            const r = ctx.inventory?.add?.(id, n);
            const added = typeof r === 'number' ? Math.max(0, Math.min(n, r)) : n;
            if (added > 0) (shelf.set(id, n - added), (given[id] = (given[id] || 0) + added), got.push(name(id)));
          }
          if (got.length) toast(`Scorched but whole: ${got.join(', ')}.`, { icon: '🔥', kind: 'good', duration: 4 });
        },
        enabled: () => !shelvesEmpty(),
      });
    }
  }

  function puffAt(x, y, z, grey, rise, s0, s1, life, alpha, glow = 0) {
    puff.x = x; puff.y = y; puff.z = z;
    puff.vx = (rand() - 0.5) * 0.6; puff.vy = 0; puff.vz = (rand() - 0.5) * 0.6;
    puff.rise = rise; puff.size0 = s0; puff.size1 = s1; puff.life = life;
    puff.r = grey; puff.g = grey; puff.b = grey + 0.02; puff.alpha = alpha; puff.glow = glow; puff.wind = 1;
    fx.smoke.emit(puff);
  }
  function emberAt(x, y, z, sp) {
    fx.embers.emit(x, y, z, (rand() - 0.5) * sp, 2 + rand() * sp, (rand() - 0.5) * sp, 1.2 + rand() * 2, 0.04 + rand() * 0.05);
  }

  function updateBlaze(dt) {
    burnT += dt;
    const I = burnIntensity(burnT);
    const night = 1 - clamp01(ctx.time?.daylight ?? 1);
    if (fx?.flames && blazeSlot >= 0) {
      const sink = collapsed ? 0.45 : 1;
      for (let i = 0; i < N_BLAZE; i++) {
        const b = blaze[i];
        const k = clamp01((burnT - b.delay) / 3) * I * (collapsed && b.roof ? 0.35 : 1);
        if (k < 0.02) fx.flames.hide(blazeSlot + i);
        else fx.flames.set(blazeSlot + i, b.x, collapsed ? floorY + 0.1 : b.y, b.z, b.w * (0.6 + 0.4 * k), b.h * k * sink, b.seed, Math.min(1, k * 1.3), 0);
      }
      fx.flames.set(blazeSlot + N_BLAZE, center.x, floorY + 2, center.z, 9 * (0.5 + 0.5 * I), 0, 2.1, 0.7 * I, 1);
      fx.flames.set(blazeSlot + N_BLAZE + 1, center.x, floorY + 4.5, center.z, 15 * I, 0, 4.4, 0.35 * I * (0.4 + 0.6 * night), 1);
    }
    if (fx?.smoke) {
      smokeAcc += dt * (2 + 6 * I);
      while (smokeAcc >= 1) {
        smokeAcc--;
        const g = 0.16 + rand() * 0.12;
        puffAt(center.x + (rand() - 0.5) * 3, floorY + (collapsed ? 1.2 : 3) + rand(), center.z + (rand() - 0.5) * 3, g, 3.2 + rand() * 1.5, 1.6 + rand(), 9 + rand() * 5, 12 + rand() * 5, 0.62, 0.45 * night * I);
      }
    }
    if (fx?.embers) {
      emberAcc += dt * 30 * I;
      while (emberAcc >= 1) {
        emberAcc--;
        emberAt(center.x + (rand() - 0.5) * 4, floorY + 1 + rand() * 2.5, center.z + (rand() - 0.5) * 4, 2.5);
      }
    }
    // the hut chars, then the roof falls in
    const c = clamp01(burnT / 45);
    woodMat.color.copy(white).lerp(charCol, c);
    if (burnT >= BURN.collapseAt) {
      collapse();
      const k = clamp01((burnT - BURN.collapseAt) / 2.2);
      roof.position.y = roofHome.y - k * k * 2.6;
      roof.rotation.z = roofHome.rz + k * 0.35;
      roof.rotation.x = k * 0.12;
      if (k >= 1) roof.visible = false;
      shell.scale.y = 1 - 0.55 * clamp01((burnT - BURN.collapseAt - 1) / 8);
    }
    // standing inside hurts
    const p = ctx.player?.position;
    if (p && insideHut(frame, p.x, p.z, -0.2) && Math.abs(p.y - floorY) < 3) {
      hurtAcc += dt;
      if (!hurtWarned) {
        hurtWarned = true;
        toast("You're inside a burning building! Get out!", { icon: '🔥', kind: 'bad', duration: 3 });
      }
      while (hurtAcc >= 0.5) {
        hurtAcc -= 0.5;
        ctx.stats?.damage?.(BURN.damagePerSec * 0.5 * Math.max(0.3, I), 'fire');
      }
    } else hurtAcc = 0;
    if (burnT >= BURN.seconds) finishBurn();
  }

  function updateSmolder(dt) {
    if (smolderT <= 0) return;
    smolderT -= dt;
    const k = clamp01(smolderT / BURN.smolder);
    if (fx?.flames && blazeSlot >= 0) {
      for (let i = 0; i < N_BLAZE; i++) {
        const b = blaze[i];
        const f = i < 6 ? clamp01((smolderT - BURN.smolder + 25) / 25) : 0; // a few low flames die out
        if (f < 0.02) fx.flames.hide(blazeSlot + i);
        else fx.flames.set(blazeSlot + i, b.x, floorY + 0.05, b.z, 0.7, 0.7 * f, b.seed, f, 0);
      }
      fx.flames.set(blazeSlot + N_BLAZE, center.x, floorY + 0.3, center.z, 6 * k, 0, 2.1, 0.5 * k, 2);
      fx.flames.hide(blazeSlot + N_BLAZE + 1);
      if (smolderT <= 0) for (let i = 0; i < N_BLAZE + 2; i++) fx.flames.hide(blazeSlot + i);
    }
    if (fx?.smoke) {
      smokeAcc += dt * 2.2 * k;
      while (smokeAcc >= 1) {
        smokeAcc--;
        puffAt(center.x + (rand() - 0.5) * 3.5, floorY + 0.4, center.z + (rand() - 0.5) * 3.5, 0.32 + rand() * 0.1, 1.6, 0.8, 4.5, 8, 0.35 * k);
      }
    }
  }

  function updateHearth(dt) {
    if (hearth.lit && ctx.state === 'playing') {
      hearth.fuelH -= ctx.time?.dtHours ?? 0;
      if (hearth.fuelH <= 0) {
        const near = ctx.player?.position && ctx.player.position.distanceTo(hearthPos) < 18;
        hearthOut(near ? 'The hearth has burned down to embers.' : null);
      }
    }
    if (!fx?.flames || hearthSlot < 0) return;
    if (hearth.lit && state === 'intact') {
      const k = clamp01(hearth.fuelH / 1.5) * 0.4 + 0.6;
      fx.flames.set(hearthSlot, hearthPos.x, hearthPos.y, hearthPos.z, 0.38, 0.62 * k, 1.3, 1, 0);
      fx.flames.set(hearthSlot + 1, hearthPos.x + 0.12, hearthPos.y, hearthPos.z + 0.05, 0.28, 0.45 * k, 5.7, 0.9, 0);
      fx.flames.set(hearthSlot + 2, hearthPos.x, hearthPos.y + 0.01, hearthPos.z, 0.6, 0, 2.2, 0.8, 2);
      fx.flames.set(hearthSlot + 3, hearthPos.x, hearthPos.y + 0.35, hearthPos.z, 1.8, 0, 3.3, 0.45, 1);
      if (fx.smoke) {
        chimAcc += dt * 1.3;
        while (chimAcc >= 1) {
          chimAcc--;
          puffAt(chimneyTop.x, chimneyTop.y, chimneyTop.z, 0.7, 1.4, 0.4, 2.6, 7, 0.28);
        }
      }
    } else for (let i = 0; i < 4; i++) fx.flames.hide(hearthSlot + i);
  }

  // ── Lantern, windows, light ────────────────────────────────────────────
  const _cam = new THREE.Vector3();
  let flick = 0;
  function updateLight(dt) {
    const daylight = clamp01(ctx.time?.daylight ?? 1);
    const nightK = clamp01((0.5 - daylight) / 0.3);
    flick += dt;
    const fl = 0.85 + 0.1 * Math.sin(flick * 13.1) + 0.05 * Math.sin(flick * 31.7);
    let I = 0;
    if (state === 'burning') {
      const b = burnIntensity(burnT);
      I = (58 + 14 * Math.sin(flick * 17.3) + 8 * Math.sin(flick * 6.1)) * b;
      light.distance = 36;
      light.position.set(0, 2.2, 0);
    } else if (state === 'intact') {
      if (hearth.lit) {
        I = 16 * fl;
        light.distance = 14;
        light.position.set(A.hearth.u + 0.35, A.hearth.y + 0.6, -(A.hearth.v + 0.35));
      } else {
        I = 6 * nightK * fl;
        light.distance = 10;
        light.position.set(A.lantern.u, A.lantern.y + 0.35, -A.lantern.v);
      }
    } else I = smolderT > 0 ? 9 * clamp01(smolderT / BURN.smolder) * fl : 0;
    light.intensity = I;
    const lit = state === 'intact' ? nightK : 0;
    glowMat.color.setRGB(0.35 + 0.65 * lit, 0.3 + 0.5 * lit, 0.2 + 0.25 * lit);
    glassMat.color.setRGB(0.16 + 0.84 * lit, 0.21 + 0.5 * lit, 0.25 + 0.1 * lit);
    glassMat.opacity = 0.5 + 0.42 * lit;
    // far glow: a few pixels wide even from the main island; the mountain occludes it (depth test)
    if (state === 'intact' && lit > 0.01) {
      ctx.camera.getWorldPosition(_cam);
      const d = _cam.distanceTo(farGlowWorld);
      farGlow.visible = d > 18;
      const s = Math.min(8, Math.max(0.8, d * 0.0065));
      farGlow.scale.set(s, s, 1);
      farGlow.material.opacity = lit * clamp01((d - 18) / 30) * 0.95 * fl;
    } else farGlow.visible = false;
  }

  // ── Per-frame ───────────────────────────────────────────────────────────
  let syncT = 0;
  function update(dt) {
    const playing = ctx.state === 'playing';
    if (playing) playTime += dt;
    if (pendingToast && playing) {
      pendingToast.t -= dt;
      if (pendingToast.t <= 0) {
        toast(pendingToast.text, { icon: '🔥', kind: 'story', duration: 4.5 });
        pendingToast = null;
      }
    }
    if (state === 'burning' && playing) updateBlaze(dt);
    else if (state === 'ruins' && playing) updateSmolder(dt);
    updateHearth(dt);
    if (playing) updateCook(dt);
    updateLight(dt);
    syncT -= dt;
    if (syncT <= 0) {
      syncT = 0.5;
      if (!shelf) syncProps(); // the compass prop follows the difficulty until the first search
    }
  }

  return {
    root,
    frame,
    floorY,
    hearthPos,
    shelter,
    get state() {
      return state;
    },
    get hearthLit() {
      return hearth.lit;
    },
    isIndoors(pos) {
      if (!pos || state === 'ruins' || collapsed) return false;
      if (!insideHut(frame, pos.x, pos.z, 0.02)) return false;
      const y = pos.y ?? floorY;
      return y > floorY - 1.2 && y < floorY + HUT.ridgeH + 0.6;
    },
    partsInHut() {
      const list = hutParts(CONFIG.raft, shelfPlan || plan());
      const seen = {};
      return list.map((p) => {
        seen[p.id] = (seen[p.id] || 0) + 1;
        return { id: p.id, taken: (given[p.id] || 0) >= seen[p.id] };
      });
    },
    /** What is (still) on the shelves: [{ id, n }] (debug / HUD). */
    contents() {
      return shelf ? [...shelf].map(([id, n]) => ({ id, n })) : hutContents(CONFIG.raft, plan()).map((e) => ({ id: e.id, n: e.n }));
    },
    ignite,
    init,
    update,
  };
}
