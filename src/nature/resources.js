// Builder C — Resources: every harvestable thing on Driftwood Isle (SPEC §6 C).
//
// Design
// - Each KIND (stick, flint, berry bush, ...) has one procedural geometry per part and one
//   InstancedMesh per part (=> one draw call per part). Multi-part kinds (berry bush = bush + berries,
//   shrub = twigs + foliage, bamboo = stump + stalk) share instance slots across their parts.
// - Instances live in a coarse grid. Around the player only the instances within the kind's view
//   distance are written into the InstancedMesh (rebuilt when the player moves a few meters), so
//   small things cost nothing far away. A few localized kinds (bamboo grove, outcrop boulders,
//   fallback palm) are "global": written once and frustum-culled as a whole.
// - Every harvestable instance registers ONE ctx.interact entry (enabled only when grown).
// - Harvest -> ctx.inventory.add, 'harvest' event, audio 'pickup', toast, particle burst, pop anim.
// - Regrowth is computed from absolute game time (ctx.time.hoursTotal), so sleeping (skipHours)
//   regrows plants too. Modes: 'growth' (fruit/mushrooms grow from 0), 'sprout' (shrinks to a sprout
//   and grows back), 'shoot' (bamboo shoot), 'respawn' (sticks/stones/fallen fruit reappear when
//   the player is not looking nearby), 'static' (part never changes).
//
// Public API (ctx.resources): { spawnItem(id, x, z, n?), nearest(kindOrItem, x?, z?), counts(),
//   kinds, regrowAll(), init(), update(dt) }
// v2: stones hide pyrite (15 %), berry bushes / nettles also give leaves, many more leafy shrubs near the spawn, and
//   the trees themselves can be harvested (apples, chestnuts, palm shake, birch / willow leaves: res/treeHarvest.js).
// v3 (V3-B): Tempest Isle resources (placeIsle2, placed last with their own rng fork so the main island's layout never
//   shifts): sticks, stones, flint, pyrite, leafy shrubs, wild banana plants by the Rain Pool (bunches regrow ~1 day),
//   aloe + yarrow, cattails at the Rain Pool, driftwood + coconuts in the cove. spawnItem(id, x, z, n, { keep, onPick })
//   (keep: never evicted by the 80-drop cap; onPick(n) after each pickup).
import * as THREE from 'three';
import { ITEMS } from '../core/items.js';
import { clamp01, smoothstep, lerp } from '../core/util.js';
import * as M from './res/meshes.js';
import { createResourceMaterials, makeDotTexture } from './res/materials.js';
import { Placer, F, waterEdgePoints, riverBankPoints } from './res/placement.js';
import { createTreeHarvest } from './res/treeHarvest.js';

const TAU = Math.PI * 2;
const GRID = 24; // instance grid cell (m)
const gkey = (ix, iz) => (ix + 512) * 1024 + (iz + 512);
const easeOut = (t) => 1 - (1 - t) * (1 - t);

/**
 * Kind table.
 *  item/n:   inventory id and amount range [min,max]
 *  plant:    counts toward stats_summary.plantsGathered
 *  regrow:   [min,max] game hours until it is back
 *  view:     render distance (m); Infinity = global (written once)
 *  iy:       interaction point height above the ground (visual center)
 *  extra:    [[item, n], ...] always given on top of a harvest (v2: leaves from berry bushes / nettles)
 *  bonus:    { item, chance, msg } a lucky extra (v2: pyrite in 15 % of stones)
 *  align:    tilt to the ground normal (things lying on the ground)
 *  space:    spacing radius (m) for placement
 *  scale:    [min,max] uniform scale; squash: per-axis random variation
 *  parts:    [geometryKey, materialKey, mode, castShadow?]
 */
const KINDS = {
  stick: { item: 'wood', n: [1, 2], label: 'Pick up Sticks', regrow: [24, 48], view: 85, iy: 0.1, align: true, space: 0.9, scale: [0.8, 1.25], burst: 0x8a6a4a, parts: [['stick', 'solid', 'respawn']] },
  stone: { item: 'stone', n: [1, 1], bonus: { item: 'pyrite', chance: 0.15, msg: '…and a brassy glint: Pyrite!' }, label: 'Pick up Stone', regrow: [24, 48], view: 75, iy: 0.1, align: true, space: 0.7, scale: [0.8, 1.45], squash: 0.18, burst: 0x9a948a, parts: [['stone', 'solid', 'respawn']] },
  flint: { item: 'flint', n: [1, 1], label: 'Pick up Flint', regrow: [60, 84], view: 75, iy: 0.1, align: true, space: 1.2, scale: [1.1, 1.3], burst: 0x6a7c96, parts: [['flint', 'mineral', 'respawn']] },
  pyrite: { item: 'pyrite', n: [1, 1], label: 'Pick up Pyrite', regrow: [60, 84], view: 85, iy: 0.12, align: true, space: 1.2, scale: [1.05, 1.3], burst: 0xe2c45a, parts: [['pyrite', 'mineral', 'respawn']] },
  berry: { item: 'berries', n: [2, 3], extra: [['leaves', 2]], label: 'Harvest Blackberries', plant: true, regrow: [24, 48], view: 130, iy: 0.55, space: 1.7, scale: [0.85, 1.3], burst: 0x3a1d4a, parts: [['berryBush.bush', 'solid', 'static', true], ['berryBush.berries', 'glossy', 'growth']] },
  apple: { item: 'wild_apple', n: [1, 2], label: 'Pick up Wild Apples', plant: true, regrow: [24, 48], view: 70, iy: 0.08, align: true, space: 0.8, scale: [1.1, 1.35], burst: 0xa6bf3c, parts: [['applePile', 'glossy', 'respawn']] },
  chestnut: { item: 'chestnut', n: [2, 3], label: 'Gather Chestnuts', plant: true, regrow: [24, 48], view: 70, iy: 0.08, align: true, space: 0.8, scale: [1.1, 1.35], burst: 0x8a6a3a, parts: [['chestnutPile', 'glossy', 'respawn']] },
  coconut: { item: 'coconut', n: [1, 1], label: 'Pick up Coconut', plant: true, regrow: [24, 48], view: 95, iy: 0.14, align: true, space: 1.0, scale: [0.95, 1.1], burst: 0x86603a, parts: [['coconutPile', 'solid', 'respawn']] },
  chanterelle: { item: 'chanterelle', n: [2, 2], label: 'Pick Chanterelles', plant: true, regrow: [24, 48], view: 70, iy: 0.1, align: true, space: 0.9, scale: [1.0, 1.3], burst: 0xf4c24a, parts: [['chanterelle', 'solid', 'growth']] },
  toadstool: { item: 'toadstool', n: [1, 1], label: null, plant: true, regrow: [24, 48], view: 75, iy: 0.12, align: true, space: 0.9, scale: [1.0, 1.3], burst: 0xdc3a24, parts: [['toadstool', 'solid', 'growth']] },
  yam: { item: 'wild_root', n: [1, 2], label: 'Dig up Wild Yam', plant: true, regrow: [24, 48], view: 80, iy: 0.3, space: 1.2, scale: [0.95, 1.25], burst: 0x6f9e40, parts: [['yam', 'foliage', 'sprout']] },
  cattail: { item: 'cattail', n: [1, 2], label: 'Pull up Cattail Roots', plant: true, regrow: [24, 48], view: 100, iy: 0.7, space: 1.0, scale: [0.85, 1.15], burst: 0x93ad52, parts: [['cattail', 'foliage', 'sprout']] },
  nettle: { item: 'nettle', n: [2, 2], extra: [['leaves', 2]], label: 'Pick Nettles (they sting!)', plant: true, regrow: [24, 48], view: 85, iy: 0.4, space: 1.1, scale: [0.9, 1.25], burst: 0x4f7d34, parts: [['nettle', 'foliage', 'sprout']] },
  grass: { item: 'fiber', n: [2, 2], label: 'Cut Tall Grass', plant: true, regrow: [24, 40], view: 95, iy: 0.5, space: 1.0, scale: [0.8, 1.2], burst: 0xc9c274, parts: [['tallGrass', 'foliage', 'sprout']] },
  shrub: { item: 'leaves', n: [3, 3], label: 'Gather Leaves', plant: true, regrow: [24, 40], view: 130, iy: 0.55, space: 1.5, scale: [0.85, 1.3], burst: 0x6fae45, parts: [['shrub.twigs', 'solid', 'static'], ['shrub.foliage', 'solid', 'sprout', true]] },
  bamboo: { item: 'bamboo', n: [1, 1], label: 'Cut Bamboo', requires: 'flint', requiresMsg: 'You need something sharp, like flint', plant: true, regrow: [24, 48], view: Infinity, iy: 1.35, radius: 3.2, space: 0.7, scale: [0.85, 1.15], burst: 0x8fbc50, parts: [['bamboo.stump', 'solid', 'static'], ['bamboo.stalk', 'foliage', 'shoot', true]] },
  aloe: { item: 'aloe', n: [1, 1], label: 'Cut an Aloe Leaf', plant: true, regrow: [24, 48], view: 85, iy: 0.2, space: 1.2, scale: [0.95, 1.3], burst: 0x9ab48a, parts: [['aloe', 'solid', 'sprout']] },
  yarrow: { item: 'yarrow', n: [1, 1], label: 'Pick Yarrow', plant: true, regrow: [24, 48], view: 85, iy: 0.35, space: 1.0, scale: [0.95, 1.25], burst: 0xf6f3e8, parts: [['yarrow', 'foliage', 'sprout']] },
  chamomile: { item: 'chamomile', n: [1, 2], label: 'Pick Chamomile', plant: true, regrow: [24, 48], view: 75, iy: 0.16, space: 0.9, scale: [1.0, 1.3], burst: 0xf2c11e, parts: [['chamomile', 'foliage', 'sprout']] },
  banana: { item: 'banana', n: [2, 3], label: 'Pick Bananas', plant: true, regrow: [20, 28], view: 140, iy: 1.45, radius: 3.4, space: 2.6, scale: [0.9, 1.15], burst: 0xe0cc48, parts: [['bananaPlant.plant', 'foliage', 'static', true], ['bananaPlant.bunch', 'glossy', 'growth']] },
  driftwood: { item: 'wood', n: [2, 2], label: 'Gather Driftwood', regrow: [24, 48], view: 95, iy: 0.12, align: true, space: 1.4, scale: [0.9, 1.3], burst: 0xcfc4b0, parts: [['driftwoodPiece', 'solid', 'respawn']] },
  // ── decor (not interactive) ──
  log: { decor: true, view: 170, align: true, space: 3.2, scale: [0.8, 1.3], parts: [['driftLog', 'solid', 'static', true]] },
  shell: { decor: true, view: 55, align: true, space: 0.45, scale: [0.8, 1.5], tints: [0xffffff, 0xf9d9cc, 0xf3cba2, 0xe9e2f2, 0xf2e6c8], parts: [['shell', 'solid', 'static']] },
  boulder: { decor: true, view: Infinity, space: 1.5, scale: [1, 1], parts: [['boulder', 'solid', 'static', true]] },
  palm: { decor: true, view: Infinity, space: 2, scale: [1, 1], parts: [['palm', 'foliage', 'static', true]] },
};

/** Geometry factories by key ('berryBush.bush' -> berryBushGeometry().bush). */
const GEOS = {
  stick: M.stickGeometry,
  stone: M.stoneGeometry,
  flint: M.flintGeometry,
  pyrite: M.pyriteGeometry,
  berryBush: M.berryBushGeometry,
  applePile: M.applePileGeometry,
  chestnutPile: M.chestnutPileGeometry,
  coconutPile: M.coconutPileGeometry,
  chanterelle: M.chanterelleGeometry,
  toadstool: M.toadstoolGeometry,
  yam: M.yamGeometry,
  cattail: M.cattailGeometry,
  nettle: M.nettleGeometry,
  tallGrass: M.tallGrassGeometry,
  shrub: M.shrubGeometry,
  bamboo: M.bambooGeometry,
  aloe: M.aloeGeometry,
  yarrow: M.yarrowGeometry,
  chamomile: M.chamomileGeometry,
  driftwoodPiece: M.driftwoodPieceGeometry,
  bananaPlant: M.bananaPlantGeometry,
  driftLog: M.driftLogGeometry,
  shell: M.shellGeometry,
  boulder: M.boulderGeometry,
  palm: M.palmGeometry,
  bundle: M.bundleGeometry,
  leafPile: M.leafPileGeometry,
};

/** Which mesh a dropped item (spawnItem) uses. */
const DROP_LOOK = {
  wood: ['stick', 'solid'],
  stone: ['stone', 'solid'],
  flint: ['flint', 'mineral'],
  pyrite: ['pyrite', 'mineral'],
  wild_apple: ['applePile', 'glossy'],
  baked_apple: ['applePile', 'glossy'],
  chestnut: ['chestnutPile', 'glossy'],
  roasted_chestnut: ['chestnutPile', 'glossy'],
  coconut: ['coconutPile', 'solid'],
  chanterelle: ['chanterelle', 'solid'],
  toadstool: ['toadstool', 'solid'],
  leaves: ['leafPile', 'foliage'],
  fiber: ['leafPile', 'foliage'],
  nettle: ['leafPile', 'foliage'],
  aloe: ['aloe', 'solid'],
};

export function create(ctx) {
  const THREE_ = ctx.THREE || THREE;
  const W = ctx.world;
  const rand = ctx.rng.fork('resources');
  const geoRand = ctx.rng.fork('resources-geo');
  const kinds = {}; // key -> runtime kind
  const regrowing = new Set();
  const anims = new Map(); // inst -> t (pop animation)
  const touched = new Set(); // meshes whose instance buffers need upload this frame
  const drops = [];
  const pendingDrops = [];
  const group = new THREE_.Group();
  group.name = 'resources';
  let mats = null;
  let built = false;
  let dirty = true;
  let rebuildTimer = 0, growTimer = 0, T = 0;
  let lastX = 1e9, lastZ = 1e9;
  let hoverInst = null;
  let toadKnown = false;
  const geoCache = {};
  const _m4 = new THREE_.Matrix4();
  const _q = new THREE_.Quaternion();
  const _q2 = new THREE_.Quaternion();
  const _v = new THREE_.Vector3();
  const _s = new THREE_.Vector3();
  const _up = new THREE_.Vector3(0, 1, 0);
  const _n = new THREE_.Vector3();
  const _c = new THREE_.Color();
  const _scale = [1, 1, 1];
  const audioPos = new THREE_.Vector3();

  const rr = (a, b) => a + (b - a) * rand();
  const now = () => ctx.time?.hoursTotal ?? 0;
  const playerPos = () => ctx.player?.position ?? ctx.camera.position;
  const extraTrees = []; // trees we plant ourselves (fallback palm): harvestable like flora's
  let treeHarvest = null; // created in init (needs burst / itemName)

  function geometry(key) {
    if (geoCache[key]) return geoCache[key];
    const [base, sub] = key.split('.');
    const made = GEOS[base](geoRand);
    if (sub) {
      for (const k in made) geoCache[base + '.' + k] = made[k];
    } else geoCache[key] = made;
    return geoCache[key];
  }

  // ── Kind runtime objects ────────────────────────────────────────────────
  function kind(key) {
    if (kinds[key]) return kinds[key];
    const def = KINDS[key];
    const k = {
      key,
      ...def,
      global: def.view === Infinity,
      instances: [],
      grid: new Map(),
      visible: [],
      meshes: [],
      defaultRegrow: def.regrow,
    };
    kinds[key] = k;
    return k;
  }

  /** Add one instance of a kind at a placement {x, z, y?}. */
  function addInstance(key, p, opts = {}) {
    const k = kind(key);
    const y = (p.y ?? W.heightAt(p.x, p.z)) + (opts.dy ?? 0);
    const s = opts.scale ?? rr(k.scale[0], k.scale[1]);
    const sq = k.squash ?? 0;
    _s.set(s * (1 + (rand() - 0.5) * sq * 2), s * (1 + (rand() - 0.5) * sq * 2), s * (1 + (rand() - 0.5) * sq * 2));
    if (opts.scaleVec) _s.set(opts.scaleVec[0], opts.scaleVec[1], opts.scaleVec[2]);
    const yaw = opts.yaw ?? rand() * TAU;
    _q.setFromAxisAngle(_up, yaw);
    if (k.align) {
      W.normalAt(p.x, p.z, _n);
      _n.lerp(_up, 0.15).normalize();
      _q2.setFromUnitVectors(_up, _n);
      _q.premultiply(_q2);
    } else if (!k.decor || opts.lean) {
      // plants: a tiny random lean so clumps don't look stamped
      _v.set(rr(-1, 1), 0, rr(-1, 1)).normalize();
      _q2.setFromAxisAngle(_v, rr(0, opts.lean ?? 0.07));
      _q.premultiply(_q2);
    }
    _v.set(p.x, y, p.z);
    _m4.compose(_v, _q, _s);
    const inst = {
      __res: true,
      kind: k,
      x: p.x,
      y,
      z: p.z,
      base: new Float32Array(16),
      tint: [1, 1, 1],
      harvestedAt: -1,
      regrowH: 24,
      slot: -1,
      handle: null,
      data: opts.data ?? null,
    };
    _m4.toArray(inst.base);
    if (k.tints) _c.set(k.tints[Math.floor(rand() * k.tints.length)]);
    else {
      const j = 1 + (rand() - 0.5) * 0.18;
      _c.setRGB(j * (1 + (rand() - 0.5) * 0.06), j, j * (1 + (rand() - 0.5) * 0.06));
    }
    inst.tint[0] = _c.r;
    inst.tint[1] = _c.g;
    inst.tint[2] = _c.b;
    k.instances.push(inst);
    const gk = gkey(Math.floor(p.x / GRID), Math.floor(p.z / GRID));
    let cell = k.grid.get(gk);
    if (!cell) k.grid.set(gk, (cell = []));
    cell.push(inst);
    return inst;
  }

  // ── Growth / visibility ────────────────────────────────────────────────
  function growth(inst, t) {
    if (inst.harvestedAt < 0) return 1;
    return clamp01((t - inst.harvestedAt) / inst.regrowH);
  }
  function isReady(inst) {
    if (inst.harvestedAt < 0) return true;
    if (inst.kind.parts.some((p) => p[2] === 'respawn')) return false; // restored by tickRegrow
    if (growth(inst, now()) >= 1) {
      restore(inst);
      return true;
    }
    return false;
  }
  function restore(inst) {
    inst.harvestedAt = -1;
    regrowing.delete(inst);
    if (inst.slot >= 0) writeInst(inst);
  }

  /** Scale vector for a part mode at growth g (writes into _scale). */
  function modeScale(mode, inst, g) {
    let s = 1;
    switch (mode) {
      case 'static':
        s = 1;
        break;
      case 'growth':
        s = g >= 1 ? 1 : easeOut(g) * 0.95;
        break;
      case 'sprout':
        s = g >= 1 ? 1 : 0.14 + 0.86 * easeOut(g);
        break;
      case 'shoot': {
        const e = g >= 1 ? 1 : easeOut(g);
        _scale[0] = 0.6 + 0.4 * e;
        _scale[1] = 0.06 + 0.94 * e;
        _scale[2] = 0.6 + 0.4 * e;
        return _scale;
      }
      case 'respawn':
        s = inst.harvestedAt < 0 ? 1 : 0;
        break;
    }
    _scale[0] = _scale[1] = _scale[2] = s;
    return _scale;
  }

  /** Write all part matrices of a visible instance into its slot. */
  function writeInst(inst, writeColor = false) {
    const k = inst.kind;
    if (inst.slot < 0) return;
    const t = now();
    const g = growth(inst, t);
    const fade = inst.fade ?? 1;
    const animT = anims.get(inst);
    const hover = inst === hoverInst ? 1 + 0.045 * Math.sin(T * 10) : 1;
    for (let j = 0; j < k.meshes.length; j++) {
      const mesh = k.meshes[j];
      const mode = k.parts[j][2];
      const sc = modeScale(mode, inst, g);
      let sx = sc[0], sy = sc[1], sz = sc[2];
      if (animT !== undefined && mode !== 'static') {
        // pop: swell 20 % then shrink into the post-harvest state
        if (animT < 0.07) {
          const u = 1 + 0.2 * (animT / 0.07);
          sx = sy = sz = u;
        } else {
          const e = smoothstep(0.07, 0.28, animT);
          sx = lerp(1.2, sx, e);
          sy = lerp(1.2, sy, e);
          sz = lerp(1.2, sz, e);
        }
      }
      sx *= fade * hover;
      sy *= fade * hover;
      sz *= fade * hover;
      const a = mesh.instanceMatrix.array;
      const o = inst.slot * 16;
      const b = inst.base;
      a[o] = b[0] * sx; a[o + 1] = b[1] * sx; a[o + 2] = b[2] * sx; a[o + 3] = b[3];
      a[o + 4] = b[4] * sy; a[o + 5] = b[5] * sy; a[o + 6] = b[6] * sy; a[o + 7] = b[7];
      a[o + 8] = b[8] * sz; a[o + 9] = b[9] * sz; a[o + 10] = b[10] * sz; a[o + 11] = b[11];
      a[o + 12] = b[12]; a[o + 13] = b[13]; a[o + 14] = b[14]; a[o + 15] = b[15];
      if (writeColor) {
        const c = mesh.instanceColor.array;
        c[inst.slot * 3] = inst.tint[0];
        c[inst.slot * 3 + 1] = inst.tint[1];
        c[inst.slot * 3 + 2] = inst.tint[2];
        mesh.instanceColor.needsUpdate = true;
      }
      touched.add(mesh);
    }
  }

  /** Re-select the instances near (px,pz) for a culled kind and write them. */
  function rebuildKind(k, px, pz) {
    for (const inst of k.visible) inst.slot = -1;
    k.visible.length = 0;
    const r = k.view, r2 = r * r;
    const x0 = Math.floor((px - r) / GRID), x1 = Math.floor((px + r) / GRID);
    const z0 = Math.floor((pz - r) / GRID), z1 = Math.floor((pz + r) / GRID);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const cell = k.grid.get(gkey(ix, iz));
        if (!cell) continue;
        for (const inst of cell) {
          const dx = inst.x - px, dz = inst.z - pz;
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          inst.slot = k.visible.length;
          k.visible.push(inst);
          inst.fade = smoothstep(r, r - 14, Math.sqrt(d2));
          writeInst(inst, true);
        }
      }
    }
    for (const m of k.meshes) {
      m.count = k.visible.length;
      m.visible = m.count > 0;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  function rebuildAll(px, pz) {
    for (const key in kinds) {
      const k = kinds[key];
      if (!k.global && k.meshes.length) rebuildKind(k, px, pz);
    }
    lastX = px;
    lastZ = pz;
    rebuildTimer = 0;
    dirty = false;
  }

  /** Create the InstancedMeshes of a kind (after all its instances are placed). */
  function buildKindMeshes(k) {
    const n = k.instances.length;
    if (!n) return;
    for (const [gkeyName, matKey, mode, shadow] of k.parts) {
      const geo = geometry(gkeyName);
      const mesh = new THREE_.InstancedMesh(geo, mats[matKey], n);
      mesh.name = 'res-' + k.key + '-' + gkeyName;
      mesh.instanceMatrix.setUsage(THREE_.DynamicDrawUsage);
      mesh.instanceColor = new THREE_.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      mesh.castShadow = !!shadow;
      mesh.receiveShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = k.global; // culled kinds always sit around the camera
      group.add(mesh);
      k.meshes.push(mesh);
    }
    if (k.global) {
      k.visible = k.instances.slice();
      k.instances.forEach((inst, i) => {
        inst.slot = i;
        inst.fade = 1;
        writeInst(inst, true);
      });
      for (const m of k.meshes) {
        m.count = n;
        m.visible = true;
        m.instanceMatrix.needsUpdate = true;
        m.computeBoundingSphere();
      }
    }
  }

  // ── Harvest ────────────────────────────────────────────────────────────
  function labelFor(k) {
    if (k.key === 'toadstool') return () => (toadKnown ? 'Pick Red Toadstool (poisonous!)' : 'Pick Red Toadstool (poisonous?)');
    return k.label;
  }

  function registerInteract(inst) {
    const k = inst.kind;
    if (k.decor || !ctx.interact?.register) return;
    inst.handle = ctx.interact.register({
      position: { x: inst.x, y: inst.y + k.iy * (inst.base[5] > 0 ? Math.hypot(inst.base[4], inst.base[5], inst.base[6]) : 1), z: inst.z },
      radius: k.radius,
      label: labelFor(k),
      onUse: () => harvest(inst),
      enabled: () => isReady(inst),
      data: inst,
    });
  }

  function itemName(id) {
    return ITEMS[id]?.name ?? id;
  }

  function harvest(inst) {
    const k = inst.kind;
    if (!isReady(inst)) return;
    if (k.requires && ctx.inventory?.has && !ctx.inventory.has(k.requires)) {
      ctx.ui?.toast?.(k.requiresMsg, { icon: '🔪', kind: 'warn', duration: 3 });
      ctx.audio?.play?.('ui_click');
      return;
    }
    const n = k.n[0] + Math.floor(rand() * (k.n[1] - k.n[0] + 1));
    const r = ctx.inventory?.add?.(k.item, n);
    const added = typeof r === 'number' ? r : n;
    if (added <= 0) {
      ctx.ui?.toast?.(`No room for more ${itemName(k.item)}`, { icon: ITEMS[k.item]?.icon, kind: 'warn', duration: 2.5 });
      return;
    }
    const t = now();
    inst.harvestedAt = t;
    inst.regrowH = rr(k.regrow[0], k.regrow[1]);
    regrowing.add(inst);
    anims.set(inst, 0);
    if (hoverInst === inst) hoverInst = null;
    audioPos.set(inst.x, inst.y + 0.3, inst.z);
    ctx.audio?.play?.('pickup', { position: audioPos });
    if (k.plant && ctx.stats_summary) ctx.stats_summary.plantsGathered = (ctx.stats_summary.plantsGathered || 0) + 1;
    let text = `+${added} ${itemName(k.item)}`;
    const gifts = [];
    if (k.extra) {
      for (const [id, en] of k.extra) {
        const er = ctx.inventory?.add?.(id, en);
        const got = typeof er === 'number' ? er : en;
        if (got > 0) (text += `, +${got} ${itemName(id)}`), gifts.push([id, got]);
      }
    }
    ctx.ui?.toast?.(text, { icon: ITEMS[k.item]?.icon, kind: 'good', duration: 2 });
    if (k.bonus && rand() < k.bonus.chance) {
      const br = ctx.inventory?.add?.(k.bonus.item, 1);
      if ((typeof br === 'number' ? br : 1) > 0) {
        ctx.ui?.toast?.(k.bonus.msg, { icon: ITEMS[k.bonus.item]?.icon, kind: 'good', duration: 3 });
        burst(inst.x, inst.y + 0.15, inst.z, 0xe2c45a, 10);
        gifts.push([k.bonus.item, 1]);
      }
    }
    burst(inst.x, inst.y + k.iy * 0.8, inst.z, k.burst ?? 0x88aa55, k.key === 'bamboo' ? 22 : 14);
    if (k.key === 'nettle') {
      ctx.ui?.flash?.('rgba(255,150,90,0.22)', 0.35);
      ctx.ui?.toast?.('Ouch! The nettles sting your fingers.', { icon: '🌿', kind: 'warn', duration: 2.5 });
    }
    ctx.events.emit('harvest', { id: k.item, n: added, kind: k.key });
    for (const [id, got] of gifts) ctx.events.emit('harvest', { id, n: got, kind: k.key });
  }

  // ── Particle bursts (pooled Points) ────────────────────────────────────
  const BURST_N = 220;
  const bPos = new Float32Array(BURST_N * 3).fill(-9999);
  const bCol = new Float32Array(BURST_N * 3);
  const bVel = new Float32Array(BURST_N * 3);
  const bLife = new Float32Array(BURST_N);
  let bNext = 0, bActive = 0;
  let burstPoints = null;
  function burst(x, y, z, color, count) {
    if (!burstPoints) return;
    _c.set(color);
    for (let i = 0; i < count; i++) {
      const p = bNext;
      bNext = (bNext + 1) % BURST_N;
      const a = rand() * TAU, sp = 0.6 + rand() * 1.4;
      bPos[p * 3] = x + Math.cos(a) * 0.1;
      bPos[p * 3 + 1] = y;
      bPos[p * 3 + 2] = z + Math.sin(a) * 0.1;
      bVel[p * 3] = Math.cos(a) * sp;
      bVel[p * 3 + 1] = 1.6 + rand() * 1.8;
      bVel[p * 3 + 2] = Math.sin(a) * sp;
      const j = 0.75 + rand() * 0.5;
      bCol[p * 3] = Math.min(1, _c.r * j);
      bCol[p * 3 + 1] = Math.min(1, _c.g * j);
      bCol[p * 3 + 2] = Math.min(1, _c.b * j);
      bLife[p] = 0.55 + rand() * 0.4;
    }
    bActive = 1.2;
    burstPoints.geometry.attributes.color.needsUpdate = true;
  }
  function updateBursts(dt) {
    if (bActive <= 0 || !burstPoints) return;
    bActive -= dt;
    for (let i = 0; i < BURST_N; i++) {
      if (bLife[i] <= 0) continue;
      bLife[i] -= dt;
      if (bLife[i] <= 0) {
        bPos[i * 3 + 1] = -9999;
        continue;
      }
      bVel[i * 3 + 1] -= 7 * dt;
      const drag = 1 - 1.5 * dt;
      bVel[i * 3] *= drag;
      bVel[i * 3 + 2] *= drag;
      bPos[i * 3] += bVel[i * 3] * dt;
      bPos[i * 3 + 1] += bVel[i * 3 + 1] * dt;
      bPos[i * 3 + 2] += bVel[i * 3 + 2] * dt;
    }
    burstPoints.geometry.attributes.position.needsUpdate = true;
  }

  // ── Dropped items (spawnItem) ──────────────────────────────────────────
  function spawnItem(id, x, z, n = 1, opts = null) {
    if (!ITEMS[id] || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    n = Math.max(1, Math.floor(n));
    if (!built) {
      pendingDrops.push([id, x, z, n, opts]);
      return { id, n, pending: true };
    }
    const [gk, mk] = DROP_LOOK[id] ?? ['bundle', 'solid'];
    const mesh = new THREE_.Mesh(geometry(gk), mats[mk]);
    const g = W.heightAt(x, z);
    const water = W.waterAt(x, z);
    const floating = !!water && water.depth > 0.15;
    const y = floating ? water.surface - 0.03 : g;
    mesh.position.set(x, y, z);
    mesh.rotation.y = rand() * TAU;
    const s = gk === 'bundle' ? 1 : 1.25;
    mesh.scale.setScalar(s);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'res-drop-' + id;
    group.add(mesh);
    const drop = { id, n, mesh, floating, x, z, y, t: rand() * 10, handle: null, removed: false, keep: !!opts?.keep, onPick: opts?.onPick || null };
    drop.remove = () => removeDrop(drop);
    if (ctx.interact?.register) {
      drop.handle = ctx.interact.register({
        position: { x, y: y + 0.15, z },
        label: () => `Pick up ${itemName(drop.id)}${drop.n > 1 ? ' ×' + drop.n : ''}`,
        onUse: () => pickDrop(drop),
        priority: 0.3,
        data: drop,
      });
    }
    drops.push(drop);
    if (drops.length > 80) {
      const old = drops.find((d) => !d.keep); // kept drops (the hut's key, compass…) are never evicted
      if (old) removeDrop(old);
    }
    return drop;
  }
  function removeDrop(drop) {
    if (drop.removed) return;
    drop.removed = true;
    drop.handle?.remove?.();
    group.remove(drop.mesh);
    const i = drops.indexOf(drop);
    if (i >= 0) drops.splice(i, 1);
  }
  function pickDrop(drop) {
    const r = ctx.inventory?.add?.(drop.id, drop.n);
    const added = typeof r === 'number' ? r : drop.n;
    if (added <= 0) {
      ctx.ui?.toast?.(`No room for more ${itemName(drop.id)}`, { icon: ITEMS[drop.id]?.icon, kind: 'warn', duration: 2.5 });
      return;
    }
    audioPos.copy(drop.mesh.position);
    ctx.audio?.play?.('pickup', { position: audioPos });
    ctx.ui?.toast?.(`+${added} ${itemName(drop.id)}`, { icon: ITEMS[drop.id]?.icon, kind: 'good', duration: 2 });
    burst(drop.x, drop.mesh.position.y + 0.1, drop.z, 0xe8d6a8, 8);
    drop.n -= added;
    try {
      drop.onPick?.(added);
    } catch (e) {
      console.error('[resources] onPick', e);
    }
    if (drop.n <= 0) removeDrop(drop);
  }
  function updateDrops(dt) {
    for (const d of drops) {
      if (!d.floating) continue;
      d.t += dt;
      d.mesh.position.y = d.y + Math.sin(d.t * 1.7) * 0.035;
      d.mesh.rotation.z = Math.sin(d.t * 1.1) * 0.08;
      d.mesh.rotation.y += dt * 0.15;
    }
  }

  // ── Placement ──────────────────────────────────────────────────────────
  function place() {
    const L = W.landmarks;
    const S = L.spawn;
    const placer = new Placer(W, { colliders: ctx.colliders });
    const allTrees = Array.isArray(ctx.flora?.trees) ? ctx.flora.trees : [];
    placer.addTrees(allTrees);
    const trees = allTrees.filter((t) => t.island !== 'isle2'); // main-island logic below (v3: Tempest Isle has its own pass)
    // Story props owned by Builder F: keep their spots clear.
    placer.reserve(S.x, S.z, 3);
    for (const [name, r] of [['crate1', 4], ['crate2', 4], ['castawayCamp', 10], ['bottleBeach', 3], ['carvedTree', 2.5]]) {
      if (L[name]) placer.reserve(L[name].x, L[name].z, r);
    }
    if (L.stoneCircle) placer.reserve(L.stoneCircle.x, L.stoneCircle.z, (L.stoneCircle.r ?? 13) + 3);

    const put = (key, pts, opts) => pts.forEach((p) => addInstance(key, p, opts));
    const sp = (key) => KINDS[key].space;
    const canopy = (x, z) => ctx.flora?.canopyAt?.(x, z) ?? 0;
    const alive = (t) => t && t.alive !== false && (t.height ?? 5) > 2.5;

    // 1. Spawn starter kit (guaranteed: fire on day 1, food and water nearby) ───────────────
    // Flint on the dry beach right around the spawn.
    const beachDry = (x, z, b) => b.sand > 0.55 && b.h > 0.45 && !b.water;
    let pts = placer.around(rand, S.x, S.z, 9, 38, 2, sp('flint'), beachDry);
    if (pts.length < 2) pts = pts.concat(placer.around(rand, S.x, S.z, 5, 60, 2 - pts.length, sp('flint'), (x, z, b) => !b.water));
    put('flint', pts);
    // Driftwood + stones + an aloe on the spawn beach.
    put('driftwood', placer.around(rand, S.x, S.z, 7, 45, 3, sp('driftwood'), beachDry));
    put('stone', placer.around(rand, S.x, S.z, 6, 40, 4, sp('stone'), beachDry));
    put('aloe', placer.around(rand, S.x, S.z, 15, 70, 2, sp('aloe'), F.upperBeach));
    put('log', placer.around(rand, S.x, S.z, 12, 40, 2, sp('log'), beachDry));

    // Rocky outcrop with pyrite, 50-100 m inland (north half), with collider boulders.
    buildOutcrop(placer, S);

    // Berries, fiber, leaves and sticks at the forest edge just inland.
    const edgeNear = (x, z, b) => b.forest > 0.15 && b.forest < 0.75 && b.sand < 0.45 && b.slope < 0.3;
    put('berry', placer.around(rand, S.x, S.z, 22, 80, 3, sp('berry'), edgeNear));
    put('grass', placer.around(rand, S.x, S.z, 20, 80, 4, sp('grass'), edgeNear));
    put('shrub', placer.around(rand, S.x, S.z, 22, 80, 4, sp('shrub'), edgeNear));
    put('stick', placer.around(rand, S.x, S.z, 18, 75, 6, sp('stick'), (x, z, b) => b.sand < 0.6 && b.slope < 0.3));

    // Coconuts: at the nearest palm, or a palm of our own if flora has none near the spawn.
    const palm = placer.nearestTree(S.x, S.z, 80, (t) => t.type === 'palm' && alive(t));
    if (palm) coconutsUnder(placer, palm, 2);
    else fallbackPalm(placer, S);

    // 2. Rare minerals ─────────────────────────────────────────────────────────────────────
    put('flint', placer.scatter(rand, 3, sp('flint'), (x, z, b) => F.beach(x, z, b) && Math.hypot(x - S.x, z - S.z) > 80));
    put('flint', riverBankPoints(W, rand, 40).filter((p) => placer.tryAt(p.x, p.z, sp('flint'), null)).slice(0, 5));
    if (L.riverMouth) put('flint', placer.around(rand, L.riverMouth.x, L.riverMouth.z, 4, 30, 2, sp('flint'), (x, z, b) => b.h > 0.3));
    const summitPts = L.summit ? placer.around(rand, L.summit.x, L.summit.z, 17, 45, 4, sp('pyrite'), (x, z, b) => b.slope < 0.6) : [];
    put('pyrite', summitPts);
    put('pyrite', placer.scatter(rand, 5, sp('pyrite'), F.rocky));

    // 3. Bamboo grove ────────────────────────────────────────────────────────────────────────
    if (L.bambooGrove) buildBamboo(placer, L.bambooGrove);

    // 4. Food & medicine ─────────────────────────────────────────────────────────────────────
    const fruitTrees = (type, max, per) => {
      let c = 0;
      for (const t of trees) {
        if (c >= max) break;
        if (t.type !== type || !alive(t)) continue;
        const nPiles = per();
        for (let i = 0; i < nPiles; i++) {
          const a = rand() * TAU;
          const tr = t.trunkR ?? 0.3;
          const maxD = Math.max(tr + 0.8, (t.crownR ?? 2.5) * 0.8);
          const d = tr + 0.45 + rand() * (maxD - tr - 0.45);
          const p = placer.tryAt(t.x + Math.cos(a) * d, t.z + Math.sin(a) * d, 0.7, null, { ignoreColliders: true });
          if (p) {
            addInstance(type === 'apple' ? 'apple' : type === 'chestnut' ? 'chestnut' : 'coconut', p);
            c++;
          }
        }
      }
      return c;
    };
    fruitTrees('apple', 48, () => 1 + (rand() < 0.55 ? 1 : 0));
    fruitTrees('chestnut', 48, () => 1 + (rand() < 0.55 ? 1 : 0));
    fruitTrees('palm', 36, () => (rand() < 0.6 ? 1 : 0));

    put('berry', placer.scatter(rand, 42, sp('berry'), F.forestEdge));
    // Chanterelles in shady forest, red toadstools nearby as the trap.
    const shady = (x, z, b) =>
      F.forestDeep(x, z, b) && (canopy(x, z) > 0.4 || !trees.length || placer.nearestTree(x, z, 6.5) !== null);
    const chant = placer.scatter(rand, 40, sp('chanterelle'), shady);
    put('chanterelle', chant);
    for (const c of chant) {
      if (rand() < 0.65) put('toadstool', placer.around(rand, c.x, c.z, 1.6, 4.5, 1, sp('toadstool'), (x, z, b) => b.forest > 0.4 && b.slope < 0.35));
    }
    put('toadstool', placer.scatter(rand, 8, sp('toadstool'), F.forestFloor));
    put('yam', placer.scatter(rand, 30, sp('yam'), F.forestFloor));
    put('nettle', placer.scatter(rand, 22, sp('nettle'), F.forestEdge));
    put('nettle', placer.scatter(rand, 14, sp('nettle'), (x, z, b) => F.wet(x, z, b) && b.forest > 0.2));
    // Cattails at the water's edge (Spring Pond first: it is the spawn's closest fresh water).
    const edges = waterEdgePoints(W, rand);
    const pondEdges = edges.filter((e) => e.waterId === 'pond');
    const otherEdges = edges.filter((e) => e.waterId !== 'pond');
    let nCat = 0;
    for (const e of pondEdges) if (nCat < 9 && placer.tryAt(e.x, e.z, sp('cattail'), null, { ignoreColliders: true })) (addInstance('cattail', e), nCat++);
    for (const e of shuffle(otherEdges)) if (nCat < 64 && placer.tryAt(e.x, e.z, sp('cattail'), null, { ignoreColliders: true })) (addInstance('cattail', e), nCat++);
    // Medicine
    put('aloe', placer.scatter(rand, 24, sp('aloe'), (x, z, b) => F.upperBeach(x, z, b) && canopy(x, z) < 0.3));
    const meadowCore = (x, z, b) => F.meadow(x, z, b);
    const M0 = L.meadow;
    if (M0) {
      put('yarrow', placer.around(rand, M0.x, M0.z, 0, M0.r * 0.9, 12, sp('yarrow'), meadowCore));
      put('chamomile', placer.around(rand, M0.x, M0.z, 0, M0.r * 0.9, 12, sp('chamomile'), meadowCore));
      put('grass', placer.around(rand, M0.x, M0.z, 0, M0.r, 50, sp('grass'), meadowCore));
    }
    put('yarrow', placer.scatter(rand, 20, sp('yarrow'), meadowCore));
    put('chamomile', placer.scatter(rand, 20, sp('chamomile'), meadowCore));

    // 5. Plentiful basics ────────────────────────────────────────────────────────────────────
    put('grass', placer.scatter(rand, 120, sp('grass'), meadowCore));
    put('grass', placer.scatter(rand, 45, sp('grass'), F.grassland));
    put('shrub', placer.scatter(rand, 120, sp('shrub'), (x, z, b) => b.forest > 0.35 && b.slope < 0.35 && b.sand < 0.2));
    put('shrub', placer.scatter(rand, 40, sp('shrub'), F.forestEdge));
    put('stick', placer.scatter(rand, 300, sp('stick'), F.forestFloor));
    put('stone', placer.scatter(rand, 70, sp('stone'), F.beach));
    put('stone', riverBankPoints(W, rand, 120).filter((p) => placer.tryAt(p.x, p.z, sp('stone'), null)).slice(0, 55));
    put('stone', placer.scatter(rand, 60, sp('stone'), F.highland));
    put('driftwood', placer.scatter(rand, 40, sp('driftwood'), F.beach));

    // 6. Beach decor ─────────────────────────────────────────────────────────────────────────
    put('log', placer.scatter(rand, 26, sp('log'), F.beach));
    put('shell', placer.scatter(rand, 340, sp('shell'), F.waterline, 340 * 60));

    // 7. v2: leafy shrubs everywhere, especially within ~150 m of the spawn (leaves for shelters, beds and smoke).
    // Placed last so every earlier placement keeps its seeded spot; kept off the open sand (raft build site).
    const leafy = (x, z, b) => b.sand < 0.3 && b.slope < 0.35 && b.rock < 0.35 && (b.forest > 0.1 || b.meadow > 0.25);
    put('shrub', placer.around(rand, S.x, S.z, 16, 150, 30, sp('shrub'), leafy));
    put('shrub', placer.scatter(rand, 70, sp('shrub'), (x, z, b) => b.forest > 0.2 && b.slope < 0.4 && b.sand < 0.25 && b.rock < 0.3));

    // 8. v3: Tempest Isle (last, with its own rng fork for sampling).
    try {
      placeIsle2(placer, allTrees);
    } catch (e) {
      console.error('[resources] Tempest Isle placement failed', e);
    }
  }

  /** v3: Tempest Isle resources. Sampling uses its own fork; addInstance's per-instance looks come last in `rand`. */
  function placeIsle2(placer, allTrees) {
    const I = W.isle2;
    const L = W.landmarks;
    if (!I || !L.isle2Hut) return;
    const r2 = ctx.rng.fork('resources-isle2');
    const D = L.isle2Dock;
    // keep the hut plateau, the dock (+ the moored boat) and the landing spot clear
    placer.reserve(L.isle2Hut.x, L.isle2Hut.z, (L.isle2Hut.r ?? 9) + 3);
    if (D) for (let t = -3; t <= (D.length ?? 18) + 2; t += 2) placer.reserve(D.x + D.dirX * t, D.z + D.dirZ * t, t > 8 ? 4.2 : 2.4);
    if (L.isle2Cove) placer.reserve(L.isle2Cove.x, L.isle2Cove.z, 3.5);
    const put = (key, pts) => pts.forEach((p) => addInstance(key, p));
    const sp = (key) => KINDS[key].space;
    /** count points on Tempest Isle passing filter(x, z, b). */
    const on = (count, space, filter, tries = count * 60) => {
      const out = [];
      for (let t = 0; t < tries && out.length < count; t++) {
        const q = W.randomLandPoint(r2, null, 20, 'isle2');
        if (!q) continue;
        const p = placer.tryAt(q.x, q.z, space, filter);
        if (p) out.push(p);
      }
      return out;
    };
    const cove = (x, z, b) => b.sand > 0.55 && b.h > 0.4 && b.h < 3 && b.slope < 0.3;
    const ground = (x, z, b) => b.sand < 0.3 && b.slope < 0.4 && b.h > 1;
    put('flint', on(3, sp('flint'), cove));
    put('pyrite', on(2, sp('pyrite'), (x, z, b) => b.h > 30 && b.slope < 0.6 && b.sand < 0.1));
    put('stone', on(16, sp('stone'), cove));
    put('stone', on(16, sp('stone'), (x, z, b) => b.sand < 0.2 && b.slope < 0.55 && b.h > 3));
    put('stick', on(40, sp('stick'), (x, z, b) => ground(x, z, b) && placer.nearestTree(x, z, 7, (t) => t.island === 'isle2') !== null));
    put('shrub', on(28, sp('shrub'), (x, z, b) => ground(x, z, b) && b.slope < 0.35));
    put('aloe', on(5, sp('aloe'), (x, z, b) => b.sand > 0.25 && b.sand < 0.95 && b.h > 1 && b.h < 6 && b.slope < 0.3));
    put('yarrow', on(6, sp('yarrow'), (x, z, b) => ground(x, z, b) && b.slope < 0.3 && b.h < 40));
    put('driftwood', on(10, sp('driftwood'), cove));
    put('log', on(4, sp('log'), cove));
    put('shell', on(40, sp('shell'), (x, z, b) => b.sand > 0.6 && b.h > 0.12 && b.h < 1.1, 40 * 60));
    // the Rain Pool: banana plants around it, cattails on its rim
    const P = L.isle2Pond;
    if (P) {
      put('banana', placer.around(r2, P.x, P.z, (P.r ?? 6) + 2.5, (P.r ?? 6) + 18, 8, sp('banana'), (x, z, b) => b.sand < 0.35 && b.slope < 0.32));
      let nCat = 0;
      for (const e of waterEdgePoints(W, r2)) {
        if (e.waterId !== 'isle2pond' || nCat >= 9) continue;
        if (placer.tryAt(e.x, e.z, sp('cattail'), null, { ignoreColliders: true })) (addInstance('cattail', e), nCat++);
      }
    }
    // coconuts under a few cove palms
    let nPalm = 0;
    for (const t of allTrees) {
      if (nPalm >= 6) break;
      if (t.island !== 'isle2' || t.type !== 'palm' || t.alive === false) continue;
      if (r2() < 0.5) continue;
      coconutsUnder(placer, t, 1);
      nPalm++;
    }
  }

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function coconutsUnder(placer, palm, count) {
    for (let i = 0, made = 0; i < 40 && made < count; i++) {
      const a = rand() * TAU, d = (palm.trunkR ?? 0.25) + 0.5 + rand() * 1.6;
      const p = placer.tryAt(palm.x + Math.cos(a) * d, palm.z + Math.sin(a) * d, sp0('coconut'), null, { ignoreColliders: true });
      if (p) (addInstance('coconut', p), made++);
    }
  }
  const sp0 = (key) => KINDS[key].space;

  /** If flora has no palm near the spawn, plant one of ours on the beach with coconuts under it. */
  function fallbackPalm(placer, S) {
    const cand = placer.around(rand, S.x, S.z, 12, 32, 1, 3, (x, z, b) => b.sand > 0.4 && b.h > 1.1 && b.slope < 0.25);
    const p = cand[0] ?? placer.around(rand, S.x, S.z, 8, 60, 1, 3, (x, z, b) => b.h > 1.0 && b.slope < 0.3)[0];
    if (!p) return;
    addInstance('palm', p, { scale: 1, yaw: rand() * TAU, dy: -0.05 });
    ctx.colliders?.add?.({ x: p.x, z: p.z, r: 0.22, y0: p.y - 1, y1: p.y + 6, tag: 'tree', data: { kind: 'palm', owner: 'resources' } });
    placer.trees.insert({ x: p.x, z: p.z, r: 0, trunkR: 0.25, tree: { x: p.x, z: p.z, type: 'palm' } });
    extraTrees.push({ x: p.x, z: p.z, y: p.y, type: 'palm', height: 6, trunkR: 0.22, crownR: 2.4, alive: true });
    coconutsUnder(placer, { x: p.x, z: p.z, trunkR: 0.25 }, 2);
  }

  /** A small rocky outcrop (boulders with colliders) near the spawn with pyrite at its base. */
  function buildOutcrop(placer, S) {
    let best = null, bestScore = -Infinity;
    for (let t = 0; t < 900; t++) {
      const a = rand() * TAU, d = 48 + rand() * 52;
      const x = S.x + Math.sin(a) * d, z = S.z - Math.cos(a) * d;
      const b = W.biomeAt(x, z);
      if (b.water || b.sand > 0.35 || b.slope > 0.22 || b.h < 2.2) continue;
      if (placer.nearestTree(x, z, 5)) continue;
      if (!placer.free(x, z, 4)) continue;
      let ok = true;
      for (let k = 0; k < 6 && ok; k++) {
        const ka = (k / 6) * TAU;
        if (W.waterAt(x + Math.cos(ka) * 4, z + Math.sin(ka) * 4)) ok = false;
      }
      if (!ok) continue;
      const north = Math.cos(a); // 1 = straight inland (north) of the spawn
      const score = north * 1.2 - Math.abs(d - 68) * 0.03 + (b.forest < 0.6 ? 0.6 : 0) - b.slope * 3;
      if (score > bestScore) (bestScore = score), (best = { x, z });
    }
    if (!best) best = { x: S.x, z: S.z - 55 };
    const boulders = [];
    const layout = [
      [0, 0, 1.55, 1.15],
      [2.1, 0.6, 1.0, 0.85],
      [-1.8, 1.2, 1.15, 0.9],
      [0.7, -2.0, 0.8, 0.7],
      [-1.1, -1.6, 0.65, 0.6],
      [2.6, -1.6, 0.55, 0.5],
      [-3.0, -0.3, 0.5, 0.45],
    ];
    const rot = rand() * TAU;
    for (const [lx, lz, s, sy] of layout) {
      const x = best.x + lx * Math.cos(rot) - lz * Math.sin(rot);
      const z = best.z + lx * Math.sin(rot) + lz * Math.cos(rot);
      const y = W.heightAt(x, z);
      addInstance('boulder', { x, z, y }, { scaleVec: [s * rr(0.9, 1.15), sy * rr(0.9, 1.1), s * rr(0.9, 1.15)], dy: -0.3 * sy });
      boulders.push({ x, z, r: s * 0.9 });
      ctx.colliders?.add?.({ x, z, r: s * 0.92, y0: y - 2, y1: y + sy * 0.95, tag: 'rock', data: { owner: 'resources' } });
      placer.mark(x, z, s * 1.05);
    }
    // pyrite nuggets tucked against the boulders
    let made = 0;
    for (let t = 0; t < 80 && made < 3; t++) {
      const b = boulders[Math.floor(rand() * 4)];
      const a = rand() * TAU;
      const d = b.r + 0.35 + rand() * 0.4;
      const p = placer.tryAt(b.x + Math.cos(a) * d, b.z + Math.sin(a) * d, 0.9, null, { ignoreColliders: true });
      if (p) (addInstance('pyrite', p), made++);
    }
    for (let t = 0; t < 60; t++) {
      const b = boulders[Math.floor(rand() * boulders.length)];
      const a = rand() * TAU;
      const d = b.r + 0.4 + rand() * 1.2;
      const p = placer.tryAt(b.x + Math.cos(a) * d, b.z + Math.sin(a) * d, 0.7, null, { ignoreColliders: true });
      if (p) addInstance('stone', p);
      if (kinds.stone.instances.length >= 8) break;
    }
    const f = placer.around(rand, best.x, best.z, 3.5, 7, 1, 1, null);
    if (f[0]) addInstance('flint', f[0]);
    outcropCenter = best;
  }
  let outcropCenter = null;

  /** Bamboo grove: clumps of tall canes (with thin colliders) around landmarks.bambooGrove. */
  function buildBamboo(placer, G) {
    const clumps = [];
    for (let t = 0; t < 200 && clumps.length < 10; t++) {
      const a = rand() * TAU, d = Math.sqrt(rand()) * G.r * 0.85;
      const x = G.x + Math.cos(a) * d, z = G.z + Math.sin(a) * d;
      if (W.waterAt(x, z) || W.slopeAt(x, z) > 0.4) continue;
      if (clumps.some((c) => Math.hypot(c.x - x, c.z - z) < 3.2)) continue;
      clumps.push({ x, z });
    }
    for (const c of clumps) {
      const n = 3 + Math.floor(rand() * 4);
      for (let i = 0, made = 0; i < 30 && made < n; i++) {
        const a = rand() * TAU, d = rand() * 1.3;
        const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
        const p = placer.tryAt(x, z, KINDS.bamboo.space, null, { ignoreColliders: true });
        if (!p) continue;
        const s = rr(0.85, 1.15);
        addInstance('bamboo', p, { scaleVec: [rr(0.9, 1.1), s, rr(0.9, 1.1)], lean: 0.06 });
        ctx.colliders?.add?.({ x: p.x, z: p.z, r: 0.07, y0: p.y - 1, y1: p.y + 6.5 * s, tag: 'bamboo', data: { owner: 'resources' } });
        made++;
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  function init() {
    mats = createResourceMaterials(ctx);
    ctx.scene.add(group);
    try {
      place();
    } catch (e) {
      console.error('[resources] placement failed', e);
    }
    for (const key in kinds) {
      const k = kinds[key];
      try {
        buildKindMeshes(k);
      } catch (e) {
        console.error('[resources] mesh build failed for', key, e);
      }
      for (const inst of k.instances) registerInteract(inst);
    }
    // v2: harvest from the trees themselves (apples, chestnuts, palm shake, birch / willow leaves)
    try {
      treeHarvest = createTreeHarvest(ctx, { rand, now, burst: (x, y, z, c, n) => burst(x, y, z, c, n), itemName });
      const trees = Array.isArray(ctx.flora?.trees) ? ctx.flora.trees : [];
      for (const t of trees) treeHarvest.add(t);
      for (const t of extraTrees) treeHarvest.add(t);
    } catch (e) {
      console.error('[resources] tree harvests failed', e);
    }
    // particle bursts
    const bg = new THREE_.BufferGeometry();
    bg.setAttribute('position', new THREE_.BufferAttribute(bPos, 3).setUsage(THREE_.DynamicDrawUsage));
    bg.setAttribute('color', new THREE_.BufferAttribute(bCol, 3).setUsage(THREE_.DynamicDrawUsage));
    burstPoints = new THREE_.Points(
      bg,
      new THREE_.PointsMaterial({ size: 0.09, sizeAttenuation: true, vertexColors: true, map: makeDotTexture(), alphaTest: 0.35 })
    );
    burstPoints.frustumCulled = false;
    burstPoints.name = 'res-bursts';
    group.add(burstPoints);

    ctx.events.on('item:consumed', (p) => {
      if (p?.id === 'toadstool') toadKnown = true;
    });
    ctx.events.on('game:start', () => (dirty = true));
    ctx.events.on('time:skip', () => (growTimer = 1));
    built = true;
    for (const d of pendingDrops.splice(0)) spawnItem(...d);
    const P = playerPos();
    rebuildAll(P.x, P.z);
  }

  /** Every ~0.5 s: grow harvested plants, respawn sticks/stones/fruit when the player is away. */
  function tickRegrow(px, pz) {
    const t = now();
    for (const inst of regrowing) {
      const g = growth(inst, t);
      const respawn = inst.kind.parts.some((p) => p[2] === 'respawn');
      if (respawn) {
        if (g >= 1 && Math.hypot(inst.x - px, inst.z - pz) > 22) restore(inst);
      } else {
        if (inst.slot >= 0 && !anims.has(inst)) writeInst(inst);
        if (g >= 1) restore(inst);
      }
    }
  }

  function update(dt) {
    if (!built) return;
    T += dt;
    const P = playerPos();
    mats.setDaylight(ctx.time?.daylight ?? 1);
    rebuildTimer += dt;
    const mdx = P.x - lastX, mdz = P.z - lastZ;
    if (dirty || rebuildTimer > 1.5 || mdx * mdx + mdz * mdz > 9) rebuildAll(P.x, P.z);
    growTimer += dt;
    if (growTimer > 0.5) {
      growTimer = 0;
      tickRegrow(P.x, P.z);
    }
    // pop animations
    for (const [inst, t] of anims) {
      const nt = t + dt;
      if (nt > 0.3) {
        anims.delete(inst);
      } else anims.set(inst, nt);
      if (inst.slot >= 0) writeInst(inst);
    }
    // hover pulse on the focused harvestable
    const cur = ctx.interact?.current?.source?.data;
    const target = cur && cur.__res && !anims.has(cur) ? cur : null;
    if (target !== hoverInst) {
      const prev = hoverInst;
      hoverInst = target;
      if (prev && prev.slot >= 0) writeInst(prev);
    }
    if (hoverInst && hoverInst.slot >= 0) writeInst(hoverInst);
    updateBursts(dt);
    updateDrops(dt);
    for (const m of touched) m.instanceMatrix.needsUpdate = true;
    touched.clear();
  }

  // ── Debug / introspection ──────────────────────────────────────────────
  function counts() {
    const out = {};
    for (const key in kinds) out[key] = kinds[key].instances.length;
    out.treeHarvests = treeHarvest?.count ?? 0;
    return out;
  }
  /** Nearest ready instance of a kind key or item id (for debug: __game.resources.nearest('flint')). */
  function nearest(what, x, z) {
    const P = playerPos();
    x ??= P.x;
    z ??= P.z;
    let best = null, bd = Infinity;
    for (const key in kinds) {
      const k = kinds[key];
      if (key !== what && k.item !== what) continue;
      for (const inst of k.instances) {
        if (inst.harvestedAt >= 0) continue;
        const d = Math.hypot(inst.x - x, inst.z - z);
        if (d < bd) (bd = d), (best = inst);
      }
    }
    return best ? { kind: best.kind.key, x: best.x, y: best.y, z: best.z, dist: bd } : null;
  }
  function regrowAll() {
    for (const inst of [...regrowing]) restore(inst);
    treeHarvest?.regrowAll();
    dirty = true;
  }

  return {
    spawnItem,
    nearest,
    counts,
    regrowAll,
    get kinds() {
      return kinds;
    },
    get outcrop() {
      return outcropCenter;
    },
    get drops() {
      return drops;
    },
    /** v2: harvestable trees ({ tree, def, readyAt, x, y, z, handle }). */
    get treeHarvests() {
      return treeHarvest?.entries ?? [];
    },
    init,
    update,
  };
}
