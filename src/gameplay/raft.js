// Builder V2-B — the boat-repair goal (SPEC §10). The main way home: find boat parts around the island
// (beach / buried: shovel / rock: pickaxe / underwater near the wreck: dive), build the plan's stages in order
// at the Boatyard on the spawn beach (each stage costs game hours), then launch and sail home (cinematic).
//
// ctx.raft: { plan, planId, stageIndex, complete, sailed, building, site (Vector3), objective(), parts(),
//             debugGiveAll(), debugComplete(), debugLaunch(), init(), update(dt) }
// Events out: raft:part {id, where}, raft:stage {stageIndex, stage}, raft:complete {plan}, raft:sailed {plan, name, day}
// Events in:  game:start (resolve the plan from ctx.difficulty, spawn everything), difficulty:set, item:added/removed,
//             input:unlock (skips the launch cinematic).
// Flags:      ctx.flags.cinematic during the build fade (restored) and the launch (kept: the game is over).
// v3 (V3-C): 'isle2hut' parts (CONFIG.raft.parts.*.where) are not scattered here: they wait in Tempest Isle's fishing
// hut (ctx.isle2 gives them) and parts() lists them with where 'isle2hut' (found = taken). The finished boat can also
// sail to Tempest Isle and back ([R] at the Boatyard, see vehicle-voyage.js); sailing home from there is the same win.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ITEMS } from '../core/items.js';
import * as L from './raft-logic.js';
import { placeParts, findSite, findLaunchTurn, buildPath, pathAt } from './raft-parts.js';
import * as M from './raft-meshes.js';
import { createVoyage } from './vehicle-voyage.js';

const TAU = Math.PI * 2;
const STEP = 0.5;
const PATH_N = 560; // 280 m of launch route
const SPEED = { raft: 9, sailboat: 12, motorboat: 16 };
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => {
  const u = clamp01((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function create(ctx) {
  const RC = ctx.config?.raft || CONFIG.raft;
  const SC = ctx.config?.stats || CONFIG.stats;
  const ev = ctx.events;
  const count = (id) => ctx.inventory?.count?.(id) ?? 0;
  const nameOf = (id) => ITEMS[id]?.name || id;
  const iconOf = (id) => ITEMS[id]?.icon || '';
  const toast = (text, opts) => ctx.ui?.toast?.(text, opts);
  const play = (n, o) => ctx.audio?.play?.(n, o);

  let started = false, planId = null, plan = null;
  let stageIndex = 0, complete = false, sailed = false, busy = false;
  const site = new THREE.Vector3();
  let siteInfo = null;
  let root = null, mats = null, boat = null, puffs = null, wake = null;
  const handles = [];
  const boatColliders = [];
  let hullColliders = false;
  const records = [];
  const partsView = [];
  const foundIds = new Set();
  let action = null;
  let cine = null;
  let clock = 0;
  const hutViews = []; // v3: parts kept in the fishing hut on Tempest Isle
  const hullCols = []; // v3: the hull colliders at the yard (lifted while the boat is away)
  const voyage = createVoyage(ctx, {
    boat: () => boat,
    planId: () => planId,
    planName: () => plan?.name || 'boat',
    speed: () => SPEED[planId] || 10,
    site,
    siteInfo: () => siteInfo,
    fadeTo: (to, s) => fadeTo(to, s),
    hideYardBoat,
    showYardBoat,
    onSailed: emitSailed,
  });

  // ── plan + objective ─────────────────────────────────────────────────────
  const curPlanId = () => (started ? planId : L.planIdFor(ctx.difficulty, RC));
  const curPlan = () => (started ? plan : L.resolvePlan(RC, curPlanId()));
  let dirty = true, cachedPlan = null, cachedStage = -1;
  const status = [];
  const obj = { title: '', stageIndex: 0, stageCount: 0, stageLabel: '', needs: [], ready: false, complete: false, hint: '' };
  const markDirty = () => (dirty = true);

  function hintInfo(id) {
    return {
      where: RC.parts?.[id]?.where,
      hasShovel: count('shovel') > 0,
      hasPickaxe: count('pickaxe') > 0,
      hasMask: count('diving_mask') > 0,
      hasFlint: count('flint') > 0,
    };
  }

  function objective() {
    const p = curPlan();
    if (!dirty && cachedPlan === p && cachedStage === stageIndex) return obj;
    dirty = false;
    cachedPlan = p;
    cachedStage = stageIndex;
    const stages = p.stages || [];
    const st = stages[stageIndex];
    obj.title = p.name;
    obj.stageIndex = stageIndex;
    obj.stageCount = stages.length;
    obj.complete = !st;
    if (!st) {
      obj.stageLabel = sailed ? 'Sailed home' : 'Launch the boat';
      obj.needs = [];
      obj.ready = !sailed;
      obj.hint = sailed ? '' : `The ${p.name} is ready: launch it from the Boatyard (05:00–20:00)`;
      return obj;
    }
    L.needsStatus(st, count, status);
    obj.stageLabel = st.label;
    obj.needs = status.map((s) => ({ id: s.id, have: s.have, need: s.need }));
    obj.ready = L.isReady(status);
    const miss = status.find((s) => s.have < s.need);
    obj.hint = miss ? L.hintFor(miss.id, hintInfo(miss.id)) : `Everything is ready: build “${st.label}” at the Boatyard`;
    return obj;
  }

  // ── start: resolve the plan, build the yard, scatter the parts ───────────
  function start() {
    if (started) return;
    started = true;
    planId = L.planIdFor(ctx.difficulty, RC);
    plan = L.resolvePlan(RC, planId);
    stageIndex = 0;
    complete = plan.stages.length === 0;
    dirty = true;
    try {
      buildYard();
    } catch (e) {
      console.error('[raft] boatyard build failed', e);
    }
    try {
      spawnParts();
    } catch (e) {
      console.error('[raft] part placement failed', e);
    }
    try {
      topUpBamboo();
    } catch (e) {
      console.error('[raft] bamboo top-up failed', e);
    }
    ctx.ui?.hint?.('boat-goal', 'Your way home: rebuild a boat at the Boatyard on this beach. Press J, then the Boat tab, for the plan.');
  }

  function buildYard() {
    mats = M.createRaftMaterials();
    root = new THREE.Group();
    root.name = 'raft';
    ctx.scene.add(root);
    const rand = ctx.rng.fork('raft-mesh');
    const W = ctx.world;
    const yaw = siteInfo.yaw;
    const yardGroup = new THREE.Group();
    yardGroup.position.copy(site);
    yardGroup.rotation.y = yaw;
    root.add(yardGroup);
    yardGroup.add(M.makeYardProps(planId, mats, rand));
    boat = M.makeBoat(planId, mats, rand);
    boat.group.rotation.order = 'YXZ';
    boat.group.position.set(site.x, site.y + boat.spec.cradle, site.z);
    boat.group.rotation.y = yaw;
    root.add(boat.group);

    // signpost on the inland port corner, facing up the beach
    const sl = { x: -(boat.spec.beam / 2 + 1.3), z: -boat.spec.length / 2 - 1.1 };
    const sx = site.x + Math.cos(yaw) * sl.x + Math.sin(yaw) * sl.z;
    const sz = site.z - Math.sin(yaw) * sl.x + Math.cos(yaw) * sl.z;
    const sy = Math.max(W.heightAt(sx, sz), 0);
    const sign = M.makeSign(mats);
    sign.position.set(sx, sy - 0.05, sz);
    sign.rotation.y = yaw + 0.25;
    root.add(sign);
    const sc = ctx.colliders?.add?.({ x: sx, z: sz, r: 0.12, y0: sy - 0.5, y1: sy + 1.7, tag: 'sign', data: { owner: 'raft' } });
    if (sc) boatColliders.push(sc);

    const def = () => ({
      label: yardLabel,
      onUse: yardUse,
      enabled: () => started && !busy && !cine && !sailed && !voyage.active,
      secondary: {
        label: () => (voyage.away ? '' : complete ? 'Sail to Tempest Isle' : 'Check the plan'),
        onUse: () => (voyage.away ? null : complete ? voyage.sailToIsle() : showPlan()),
      },
    });
    const h1 = ctx.interact?.register?.({ ...def(), position: new THREE.Vector3(site.x, site.y + 1.0, site.z), radius: 5, priority: 0.4 });
    const h2 = ctx.interact?.register?.({ ...def(), position: new THREE.Vector3(sx, sy + 1.45, sz), radius: 3, priority: 0 });
    if (h1) handles.push(h1);
    if (h2) handles.push(h2);

    puffs = M.createPuffs(mats);
    root.add(puffs.mesh);
    wake = M.makeWake(mats);
    wake.visible = false;
    root.add(wake);
    refreshBoat();
  }

  /** World xz of a point in the boat's local frame at the yard. */
  function yardPoint(lx, lz) {
    const yaw = siteInfo.yaw;
    return { x: site.x + Math.cos(yaw) * lx + Math.sin(yaw) * lz, z: site.z - Math.sin(yaw) * lx + Math.cos(yaw) * lz };
  }

  function refreshBoat() {
    if (!boat) return;
    const stages = plan.stages;
    for (let i = 0; i < stages.length; i++) {
      const o = boat.parts[stages[i].id];
      if (o) o.visible = i < stageIndex;
    }
    const hullBuilt = stages.findIndex((s) => s.id === 'hull') < stageIndex;
    if (hullBuilt && !hullColliders && ctx.colliders?.add) {
      hullColliders = true;
      const sp = boat.spec;
      const r = Math.min(sp.beam / 2, 1.2);
      const n = Math.max(2, Math.ceil(sp.length / (r * 1.6)));
      for (let k = 0; k < n; k++) {
        const lz = -sp.length / 2 + r + ((sp.length - 2 * r) * k) / (n - 1);
        const p = yardPoint(0, lz);
        const c = ctx.colliders.add({ x: p.x, z: p.z, r, y0: site.y - 0.5, y1: site.y + sp.cradle + sp.depth, tag: 'boat', data: { owner: 'raft' } });
        if (c) {
          boatColliders.push(c);
          hullCols.push(c);
        }
      }
    }
  }

  function spawnParts() {
    const W = ctx.world, LM = W.landmarks;
    const rng = ctx.rng.fork('raft');
    const all = L.partList(RC, planId);
    const list = all.filter((p) => !L.isHutPart(p));
    const hut = LM.isle2Hut || LM.isle2 || { x: 0, z: 0 };
    for (const p of all) {
      if (!L.isHutPart(p)) continue;
      const v = { id: p.id, where: 'isle2hut', found: false, position: new THREE.Vector3(hut.x, hut.y ?? 0, hut.z) };
      hutViews.push(v);
    }
    const avoid = [
      { x: site.x, z: site.z, r: 10 },
      { x: LM.spawn.x, z: LM.spawn.z, r: 5 },
      LM.castawayCamp && { x: LM.castawayCamp.x, z: LM.castawayCamp.z, r: 9, tag: 'camp' },
      LM.crate1 && { x: LM.crate1.x, z: LM.crate1.z, r: 5 },
      LM.crate2 && { x: LM.crate2.x, z: LM.crate2.z, r: 5 },
      LM.bottleBeach && { x: LM.bottleBeach.x, z: LM.bottleBeach.z, r: 5 },
    ].filter(Boolean);
    const blocked = (x, z, r) => {
      const q = ctx.colliders?.query?.(x, z, r, []);
      return !!q && q.length > 0;
    };
    const placed = placeParts(W, rng, list, { avoid, blocked });
    const rand = ctx.rng.fork('raft-parts-mesh');
    for (const e of placed) addRecord(e, rand);
    for (const v of hutViews) partsView.push(v);
  }

  /** v3: hut parts are found once taken from the hut (ctx.isle2.partsInHut() or a raft:part event). */
  function refreshHut() {
    if (!hutViews.length) return;
    let list = null;
    try {
      list = ctx.isle2?.partsInHut?.();
    } catch (e) {
      list = null;
    }
    if (!Array.isArray(list)) return;
    const seen = {};
    for (const v of hutViews) {
      const k = (seen[v.id] = (seen[v.id] ?? -1) + 1);
      let n = -1;
      for (const e of list) {
        if (e?.id !== v.id || ++n !== k) continue;
        if (e.taken) v.found = true;
        break;
      }
    }
  }
  function onPart(p) {
    if (p?.where !== 'isle2hut') return;
    const v = hutViews.find((h) => h.id === p.id && !h.found);
    if (v) v.found = true;
    foundIds.add(p.id);
    dirty = true;
  }

  /** v3: the boat sails to Tempest Isle: lift its yard colliders (the group is moved by the voyage). */
  function hideYardBoat() {
    for (const c of hullCols) {
      ctx.colliders?.remove?.(c);
      const i = boatColliders.indexOf(c);
      if (i >= 0) boatColliders.splice(i, 1);
    }
    hullCols.length = 0;
    hullColliders = false;
    dirty = true;
  }
  /** v3: back on its cradle at the Boatyard. */
  function showYardBoat() {
    if (!boat) return;
    boat.group.position.set(site.x, site.y + boat.spec.cradle, site.z);
    boat.group.rotation.set(0, siteInfo.yaw, 0);
    refreshBoat();
    dirty = true;
  }

  function addRecord(e, rand) {
    const rec = { id: e.id, where: e.where, position: new THREE.Vector3(e.x, e.y, e.z), found: false, group: null, handle: null };
    rec.view = { id: e.id, where: e.where, found: false, position: rec.position };
    const nm = nameOf(e.id);
    const reg = (def) => ctx.interact?.register?.({ ...def, enabled: () => !rec.found && (!action || action.rec !== rec) && !cine });
    if (e.where === 'buried') {
      const m = M.makeMound(mats, rand);
      m.group.position.set(e.x, e.y, e.z);
      rec.group = m.group;
      rec.mound = m;
      rec.handle = reg({
        position: new THREE.Vector3(e.x, e.y + 0.35, e.z),
        label: () => (count('shovel') > 0 ? 'Dig here' : 'Dig (needs a shovel)'),
        onUse: () => {
          if (count('shovel') > 0) startAction(rec, 'dig');
          else toast('Something is buried here. You need a shovel to dig (craft: wood, stone, rope).', { icon: '⛏️', kind: 'warn', key: 'raft-tool' });
        },
      });
    } else if (e.where === 'rock') {
      const b = M.makeBoulder(mats, rand);
      b.group.position.set(e.x, e.y - 0.12, e.z);
      b.group.rotation.y = rand() * TAU;
      rec.group = b.group;
      rec.boulder = b;
      rec.collider = ctx.colliders?.add?.({ x: e.x, z: e.z, r: 0.95, y0: e.y - 1, y1: e.y + 1.2, tag: 'rock', data: { owner: 'raft' } }) || null;
      rec.handle = reg({
        position: new THREE.Vector3(e.x, e.y + 0.75, e.z),
        radius: 3.4,
        label: () => (count('pickaxe') > 0 ? 'Break it open' : 'Break the rock (needs a pickaxe)'),
        onUse: () => {
          if (count('pickaxe') > 0) startAction(rec, 'break');
          else toast('Something glints inside the crack. You need a pickaxe to break it (craft: wood, flint, rope).', { icon: '🪨', kind: 'warn', key: 'raft-tool' });
        },
      });
    } else {
      const g = M.makePartMesh(e.id, mats);
      g.position.set(e.x, e.y, e.z);
      g.rotation.y = rand() * TAU;
      rec.group = g;
      if (e.where === 'underwater') {
        M.glowify(g, mats);
        const s = M.makeGlint(mats, true);
        s.position.set(0, 0.5, 0);
        g.add(s);
        rec.glint = s;
      }
      rec.handle = reg({
        position: new THREE.Vector3(e.x, e.y + (e.where === 'underwater' ? 0.3 : 0.2), e.z),
        radius: e.where === 'underwater' ? 2.8 : undefined,
        label: e.where === 'underwater' ? `Grab the ${nm}` : `Pick up ${nm}`,
        onUse: () => collect(rec),
      });
    }
    if (rec.boulder) rec.glint = rec.boulder.glint;
    rec.phase = rand() * TAU;
    root.add(rec.group);
    records.push(rec);
    partsView.push(rec.view);
  }

  function collect(rec) {
    if (rec.found) return;
    rec.found = true;
    rec.view.found = true;
    rec.handle?.remove?.();
    rec.handle = null;
    if (rec.boulder) {
      rec.boulder.boulder.visible = false;
      rec.boulder.rubble.visible = true;
    } else if (rec.group) rec.group.visible = false;
    if (rec.collider) {
      ctx.colliders?.remove?.(rec.collider);
      rec.collider = null;
    }
    const first = !foundIds.has(rec.id) && count(rec.id) === 0;
    foundIds.add(rec.id);
    ctx.inventory?.add?.(rec.id, 1, first ? { silent: true } : undefined);
    play('pickup', { position: rec.position });
    ev.emit('raft:part', { id: rec.id, where: rec.where });
    if (first) toast(`${nameOf(rec.id)}: ${L.FIRST_FIND[rec.id] || ITEMS[rec.id]?.desc || 'For the boat.'}`, { icon: iconOf(rec.id), kind: 'story', duration: 6 });
    ctx.ui?.markJournal?.('part:' + rec.id, { id: rec.id, name: nameOf(rec.id), icon: iconOf(rec.id), where: rec.where });
    dirty = true;
  }

  function startAction(rec, kind) {
    if (action || rec.found) return;
    action = { rec, kind, t: 0, T: 1.2, next: 0 };
  }

  function updateAction(dt) {
    const a = action, rec = a.rec, p = rec.position, dig = a.kind === 'dig';
    a.t += dt;
    while (a.t >= a.next && a.next < a.T) {
      puffs?.emit(p.x, p.y + (dig ? 0.15 : 0.7), p.z, dig ? 7 : 5, dig ? 0xd9c49a : 0x9a948a);
      play(dig ? 'footstep_sand' : 'footstep_rock', { position: p, volume: 1 });
      a.next += 0.3;
    }
    const u = clamp01(a.t / a.T);
    if (dig && rec.mound) {
      rec.mound.mound.scale.y = 0.3 * (1 - 0.75 * u);
      rec.mound.sticks.visible = u < 0.5;
    } else if (rec.boulder) {
      rec.boulder.boulder.position.x = Math.sin(a.t * 70) * 0.035 * (1 - u * 0.5);
    }
    if (a.t >= a.T) {
      action = null;
      collect(rec);
    }
  }

  function topUpBamboo() {
    const n = ctx.resources?.counts?.()?.bamboo;
    const G = ctx.world.landmarks.bambooGrove;
    if (!G || typeof n !== 'number' || n >= 10 || !ctx.resources?.spawnItem) return;
    const W = ctx.world, rng = ctx.rng.fork('raft-bamboo');
    for (let k = 0, made = 0; k < 80 && made < 10 - n; k++) {
      const a = rng() * TAU, r = 2 + rng() * (G.r || 12);
      const x = G.x + Math.cos(a) * r, z = G.z + Math.sin(a) * r;
      if (W.waterAt(x, z) || W.slopeAt(x, z) > 0.4) continue;
      ctx.resources.spawnItem('bamboo', x, z, 1);
      made++;
    }
  }

  // ── the Boatyard interaction ─────────────────────────────────────────────
  function yardLabel() {
    if (!started) return '';
    if (voyage.away) return `Your ${plan.name} is moored at Tempest Isle`;
    if (complete) return L.isWorkHour(ctx.time.hour) ? `Launch the ${plan.name} and sail home` : 'Too dark to sail: wait for dawn';
    const st = plan.stages[stageIndex];
    return objective().ready ? `Build: ${st.label} (${L.fmtHours(st.hours)})` : 'What’s needed?';
  }
  function yardUse() {
    if (!started || busy || cine || sailed || voyage.active) return;
    if (voyage.away) {
      toast(`Your ${plan.name} is moored off the cove on Tempest Isle. Sail it home from there, or back here.`, { icon: '⛵', kind: 'info', key: 'raft-away' });
      return;
    }
    if (complete) return tryLaunch();
    if (objective().ready) return build();
    showNeeds();
  }
  function showNeeds() {
    const st = plan.stages[stageIndex];
    if (!st) return;
    L.needsStatus(st, count, status);
    const miss = L.missingText(status, (id) => `${iconOf(id)} ${nameOf(id)}`);
    const m = status.find((s) => s.have < s.need);
    dirty = true;
    toast(`${st.label} (step ${stageIndex + 1}/${plan.stages.length}) needs ${miss}. ${m ? L.hintFor(m.id, hintInfo(m.id)) + '.' : ''}`, {
      icon: '🛶',
      kind: 'info',
      duration: 7,
      key: 'raft-needs',
    });
  }
  function showPlan() {
    if (!started) return;
    const lines = plan.stages.map((s, i) => `${i < stageIndex ? '✔' : i === stageIndex ? '▶' : '○'} ${s.label}`);
    toast(`${plan.name}: ${lines.join(' · ')}`, { icon: '📋', kind: 'info', duration: 8, key: 'raft-plan' });
  }

  function fadeTo(to, s) {
    try {
      const p = ctx.fade?.(to, s);
      if (p && typeof p.then === 'function') return p.catch(() => {});
    } catch (e) {
      /* fall through */
    }
    return new Promise((res) => setTimeout(res, s * 1000));
  }

  async function build() {
    if (busy || complete || ctx.stats?.dead) return;
    const st = plan.stages[stageIndex];
    if (!st) return;
    if (!L.isWorkHour(ctx.time.hour)) {
      toast('Too dark to work: rest or wait for dawn', { icon: '🌙', kind: 'warn', key: 'raft-night' });
      return;
    }
    const drain = L.buildDrain(st.hours, SC, ctx.difficulty);
    const v = ctx.stats?.values;
    if (v && Number.isFinite(v.thirst) && v.thirst + drain.thirst < 5) {
      toast(`You’re too thirsty to work for ${L.fmtHours(st.hours)}. Drink first.`, { icon: '💧', kind: 'warn', key: 'raft-need' });
      return;
    }
    if (v && Number.isFinite(v.hunger) && v.hunger + drain.hunger < 5) {
      toast(`You’re too hungry to work for ${L.fmtHours(st.hours)}. Eat something first.`, { icon: '🍎', kind: 'warn', key: 'raft-need' });
      return;
    }
    if (!L.consumeStage(st, count, (id, n) => ctx.inventory?.remove?.(id, n))) return showNeeds();
    busy = true;
    const prevCine = ctx.flags.cinematic;
    ctx.flags.cinematic = true;
    play('craft', { volume: 1 });
    let died = false;
    try {
      await fadeTo(1, 0.8);
      ctx.time?.skipHours?.(st.hours);
      ctx.stats?.applyEffects?.(drain, 'work');
      died = !!ctx.stats?.dead;
      if (!died) {
        stageIndex++;
        complete = stageIndex >= plan.stages.length;
        refreshBoat();
        dirty = true;
      }
      await fadeTo(0, 1);
    } finally {
      ctx.flags.cinematic = prevCine;
      busy = false;
    }
    if (died || ctx.stats?.dead) return;
    play('place', { position: site });
    const next = plan.stages[stageIndex];
    toast(`${st.label}: done (${stageIndex}/${plan.stages.length}).${next ? ' Next: ' + next.label + '.' : ''}`, { icon: '🔨', kind: 'good', duration: 5 });
    ev.emit('raft:stage', { stageIndex, stage: st });
    if (complete) onComplete();
  }

  function onComplete() {
    dirty = true;
    play('chime');
    toast(`The ${plan.name} is finished! Launch it from the Boatyard (05:00–20:00) and sail home, or press R there to sail it to Tempest Isle.`, {
      icon: '⛵',
      kind: 'story',
      duration: 8,
    });
    ev.emit('raft:complete', { plan: planId });
  }

  function tryLaunch() {
    if (!complete || cine || sailed || voyage.away || voyage.active || ctx.stats?.dead) return;
    if (!L.isWorkHour(ctx.time.hour)) {
      toast('Too dark to sail: wait for dawn (05:00)', { icon: '🌙', kind: 'warn', key: 'raft-night' });
      return;
    }
    startCine();
  }

  // ── launch cinematic ─────────────────────────────────────────────────────
  function startCine() {
    if (!boat || cine || sailed) return;
    const W = ctx.world;
    const turn = findLaunchTurn(W, siteInfo, W.landmarks.wreck);
    const path = buildPath(siteInfo, turn, new Float32Array(PATH_N * 3), STEP);
    for (const c of boatColliders) ctx.colliders?.remove?.(c);
    boatColliders.length = 0;
    for (const s of plan.stages) if (boat.parts[s.id]) boat.parts[s.id].visible = true;
    ctx.flags.cinematic = true;
    ctx.letterbox?.(true);
    const dx = siteInfo.dirX, dz = siteInfo.dirZ, lx = -dz, lz = dx;
    const cx = site.x - dx * 6 + lx * 7, cz = site.z - dz * 6 + lz * 7;
    const cam = ctx.camera;
    cam.rotation.order = 'YXZ';
    cine = {
      t: 0,
      s: 0,
      path,
      pt: { x: site.x, z: site.z, heading: siteInfo.yaw },
      camA: new THREE.Vector3(cx, Math.max(W.heightAt(cx, cz), 0) + 2.2, cz),
      eye: new THREE.Vector3(),
      vmax: SPEED[planId] || 10,
      sub1: false,
      sub2: false,
      splashed: false,
      fading: false,
      wantEmit: false,
    };
    play('place', { position: site, volume: 1 });
  }

  const aimOut = { yaw: 0, pitch: 0 };
  function aim(from, tx, ty, tz) {
    const dx = tx - from.x, dy = ty - from.y, dz = tz - from.z;
    aimOut.yaw = Math.atan2(-dx, -dz);
    aimOut.pitch = Math.atan2(dy, Math.hypot(dx, dz) || 1e-6);
    return aimOut;
  }

  function beginFade(sec) {
    const c = cine;
    if (!c || c.fading) return;
    c.fading = true;
    fadeTo(1, sec).then(() => {
      c.wantEmit = true;
    });
  }

  function updateCine(dt) {
    const c = cine, W = ctx.world, g = boat.group, sp = boat.spec, cam = ctx.camera;
    c.t += dt;
    if (!c.fading && c.t > 0.4 && (ctx.input?.wasPressed?.('Space') || ctx.input?.wasPressed?.('Escape'))) beginFade(0.8);
    const v = c.t < 3 ? 0.6 + (3.4 * c.t) / 3 : Math.min(c.vmax, 4 + (c.t - 3) * 2.4);
    c.s = Math.min(c.s + v * dt, (PATH_N - 2) * STEP);
    pathAt(c.path, c.s, c.pt, STEP);
    const sea = W.SEA_LEVEL ?? 0;
    const ground = W.heightAt(c.pt.x, c.pt.z);
    const floatY = sea - sp.draft + Math.sin(c.t * 1.7) * 0.07;
    const landY = ground + sp.cradle * Math.max(0, 1 - c.s / 3);
    const wet = clamp01((floatY - ground) / 0.6);
    g.position.set(c.pt.x, Math.max(floatY, landY), c.pt.z);
    g.rotation.set(Math.sin(c.t * 1.3) * 0.03 * wet, c.pt.heading, Math.sin(c.t * 1.1) * 0.045 * wet);
    if (!c.splashed && floatY > ground + 0.05) {
      c.splashed = true;
      play('splash', { position: g.position, volume: 1.2 });
    }
    const h = c.pt.heading, fx = Math.sin(h), fz = Math.cos(h);
    if (wake) {
      wake.visible = wet > 0.2;
      mats.wake.opacity = 0.55 * wet * Math.min(1, v / 6);
      wake.position.set(g.position.x - fx * sp.length * 0.5, sea + 0.04, g.position.z - fz * sp.length * 0.5);
      wake.rotation.y = h;
    }
    if (planId === 'motorboat') ctx.audio?.setLoop?.('engine', 0.8 * wet, g.position);

    // camera: beach shot, then aboard looking back at the island, then ahead to the horizon
    let yaw, pitch;
    if (c.t < 3.2) {
      c.eye.copy(c.camA);
      aim(c.eye, g.position.x, g.position.y + 0.8, g.position.z);
      yaw = aimOut.yaw;
      pitch = aimOut.pitch;
    } else {
      c.eye.set(g.position.x - fx * sp.length * 0.3, g.position.y + sp.depth + 1.35, g.position.z - fz * sp.length * 0.3);
      const S = W.landmarks.summit || W.landmarks.spawn;
      aim(c.eye, S.x, (S.y ?? 20) * 0.45, S.z);
      const k = smooth(7.2, 9.6, c.t);
      yaw = aimOut.yaw + wrap(Math.atan2(-fx, -fz) - aimOut.yaw) * k;
      pitch = aimOut.pitch + (0.02 - aimOut.pitch) * k;
    }
    cam.position.copy(c.eye);
    cam.rotation.set(pitch, yaw, 0);

    if (!c.sub1 && c.t > 3.6) {
      c.sub1 = true;
      ctx.ui?.subtitle?.('The island shrinks behind you…', 4);
    }
    if (!c.sub2 && c.t > 8.2) {
      c.sub2 = true;
      ctx.ui?.subtitle?.('Home is that way.', 3.5);
    }
    if (!c.fading && c.t > 10.5) beginFade(1.5);
    if (c.wantEmit) finishCine();
  }

  function finishCine() {
    if (ctx.state !== 'playing' || sailed) return;
    sailed = true;
    dirty = true;
    cine = null;
    if (wake) wake.visible = false;
    if (planId === 'motorboat') ctx.audio?.setLoop?.('engine', 0);
    ctx.letterbox?.(false);
    // flags.cinematic stays on: the game is over (state 'rescued'), the win screen covers the HUD
    ev.emit('raft:sailed', { plan: planId, name: plan.name, day: ctx.time.day });
  }
  /** v3: the same win after sailing home from Tempest Isle (vehicle-voyage.js cinematic). */
  function emitSailed() {
    if (ctx.state !== 'playing' || sailed) return;
    sailed = true;
    dirty = true;
    ev.emit('raft:sailed', { plan: planId, name: plan.name, day: ctx.time.day });
  }

  // ── debug ────────────────────────────────────────────────────────────────
  function debugGiveAll() {
    const rem = L.remainingNeeds(curPlan(), stageIndex);
    for (const id in rem) {
      const lack = rem[id] - count(id);
      if (lack > 0) ctx.inventory?.add?.(id, lack, { silent: true });
    }
    dirty = true;
    return rem;
  }
  function debugComplete() {
    if (!started) start();
    if (complete) return;
    stageIndex = plan.stages.length;
    complete = true;
    refreshBoat();
    onComplete();
  }
  function debugLaunch() {
    if (!started) return;
    if (!complete) debugComplete();
    startCine();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  const api = {
    get plan() {
      return curPlan();
    },
    get planId() {
      return curPlanId();
    },
    get stageIndex() {
      return stageIndex;
    },
    get complete() {
      return complete;
    },
    get sailed() {
      return sailed;
    },
    get building() {
      return busy;
    },
    /** v3: the finished boat is moored at Tempest Isle. */
    get away() {
      return voyage.away;
    },
    voyage,
    site,
    objective,
    parts: () => {
      refreshHut();
      return partsView;
    },
    debugGiveAll,
    debugComplete,
    debugLaunch,
    init() {
      try {
        siteInfo = findSite(ctx.world);
      } catch (e) {
        console.error('[raft] site search failed', e);
        const S = ctx.world.landmarks.spawn;
        siteInfo = { x: S.x, y: ctx.world.heightAt(S.x, S.z), z: S.z + 6, dirX: 0, dirZ: 1, yaw: 0 };
      }
      site.set(siteInfo.x, siteInfo.y, siteInfo.z);
      ev.on('game:start', start);
      ev.on('difficulty:set', markDirty);
      ev.on('item:added', markDirty);
      ev.on('item:removed', markDirty);
      ev.on('raft:part', onPart);
      voyage.init();
      ev.on('input:unlock', () => {
        if (cine && cine.t > 0.3) beginFade(0.8);
      });
    },
    update(dt) {
      if (ctx.state !== 'playing' || !started) return;
      clock += dt;
      if (mats) {
        const pulse = 0.5 + 0.5 * Math.sin(clock * 2.4);
        for (const m of mats.glow) m.emissiveIntensity = 0.2 + 0.6 * pulse;
        mats.glintRock.opacity = 0.2 + 0.8 * pulse * pulse * pulse;
        mats.glintSea.opacity = 0.3 + 0.55 * pulse;
        for (let i = 0; i < records.length; i++) {
          const r = records[i];
          if (r.found || !r.glint) continue;
          const q = 0.5 + 0.5 * Math.sin(clock * 2.4 + r.phase);
          r.glint.scale.setScalar(r.where === 'underwater' ? 1.1 + 0.6 * q : 0.3 + 0.35 * q * q);
        }
      }
      puffs?.update(dt);
      if (action) updateAction(dt);
      if (cine) updateCine(dt);
      voyage.update(dt);
    },
  };
  return api;
}
