// Builder B — Flora. Procedural low-poly vegetation for Driftwood Isle (SPEC §6 B).
//
// create(): builds the species library (several variants per species), places ~3400 trees + boulders (+ ~340 on
//   Tempest Isle, v3: flora/isle2.js) +
//   undergrowth from ctx.world.biomeAt, fills `trees` (Builder C reads it in its init), registers trunk
//   and boulder colliders, indexes crowns for canopyAt(), then bakes everything into merged meshes per
//   64 m chunk (one draw call per chunk, frustum-culled; see flora/bake.js for why not per-variant
//   instancing). Rendering is wrapped in try/catch so a GPU-side problem can never empty `trees`.
// update(): wind/translucency uniforms, undergrowth distance culling, the grass patch around the player,
//   falling trees, sapling growth and ambient drifting leaves (each helper in src/nature/flora/).
//
// V4-E LOD: every tree chunk is baked twice, full detail and low detail (species.buildLowLibrary: the same
//   trees with ≈¼-½ of the triangles), and its single mesh swaps between the two geometries a few times
//   per second: full when the chunk center is within ctx.quality.lodDistance (default 110 m; 10 m
//   hysteresis), low beyond (same material, so the wind sway is identical). Only
//   chunks whose box is within 1.5 x CONFIG.graphics.shadowRange of the camera cast sun shadows; beyond
//   420 m they don't receive them either. Undergrowth chunks are hidden beyond ctx.quality.underDistance
//   (160 m) and the grass patch radius/density follow ctx.quality.grassScale / grassDensity.
//
// Public API: { trees, boulders, canopyAt(x,z), nearestTree(x,z,maxDist,filter?), treesNear(x,z,r),
//   carvedTree, debugFell(tree?), group, init(), update(dt) }
import * as THREE from 'three';
import { buildLibrary, buildLowLibrary } from './flora/species.js';
import { placeTrees, placeUndergrowth } from './flora/placement.js';
import { CanopyIndex } from './flora/canopy.js';
import { ChunkBaker, variantGeometry, hideRange, releaseAfterUpload, CHUNK } from './flora/bake.js';
import { createFloraMaterials } from './flora/materials.js';
import { GrassPatch } from './flora/grass.js';
import { FallingTrees } from './flora/falling.js';
import { Saplings } from './flora/growth.js';
import { placeIsle2Trees, placeIsle2Undergrowth } from './flora/isle2.js';
import { pickLod, boxDist2D } from '../gfx/quality.js';

const UNDER_VIEW_DIST = 160; // undergrowth chunks are hidden beyond this (m, camera to chunk box; ctx.quality.underDistance)
const LOD_DIST = 110; // full-detail tree chunks within this (m, camera to chunk center; ctx.quality.lodDistance)
const LOD_HYST = 10; // m
const SHADOW_K = 1.5; // tree chunks within shadowRange * SHADOW_K (box distance) cast sun shadows
const RECEIVE_DIST = 420; // tree chunks beyond this (center) don't receive shadows (outside the shadow box anyway)
const CULL_EVERY = 0.25; // s between LOD / culling passes (immediately after a camera jump)
const JUMP2 = 30 * 30;
const noRaycast = () => {};

export function create(ctx) {
  const W = ctx.world;
  const rng = ctx.rng.fork('flora');
  const lib = buildLibrary(rng.fork('lib'));
  const { trees, boulders } = placeTrees(W, rng.fork('trees'), lib);
  // v3: Tempest Isle (own rng forks, appended after the main island so its seeded layout never shifts).
  // Entries get island:'isle2'; wind-bent pines keep type 'pine' with vk:'windPine' (the variant library key).
  let isle2 = { trees: [], boulders: [] };
  try {
    if (W.isle2) isle2 = placeIsle2Trees(W, rng.fork('isle2-trees'), lib, trees.length);
  } catch (e) {
    console.error('[flora] Tempest Isle placement failed', e);
  }
  for (const t of isle2.trees) trees.push(t);
  for (const o of isle2.boulders) boulders.push(o);

  // Internal per-tree state, kept off the public entries: collider, chunk handle, variant.
  const meta = trees.map((t) => ({ collider: null, handle: null, V: t.v < 0 ? lib.carvedOak : lib[t.vk ?? t.type][t.v] }));

  // ── Canopy index + colliders (no rendering involved: always available) ──
  const canopy = new CanopyIndex();
  for (const t of trees) canopy.add(t);
  for (const t of trees) {
    meta[t.id].collider = ctx.colliders.add({
      x: t.x,
      z: t.z,
      r: Math.max(0.16, t.trunkR * 1.12),
      y0: t.y - 2,
      y1: t.y + t.height,
      tag: 'tree',
      data: t,
    });
  }
  for (const o of boulders) {
    o.collider = ctx.colliders.add({ x: o.x, z: o.z, r: o.r, y0: o.y - 1.5, y1: o.top, tag: 'boulder', data: o });
  }
  const carved = trees.find((t) => t.special === 'carvedTree') || null;

  // ── Rendering ────────────────────────────────────────────────────────
  const group = new THREE.Group();
  group.name = 'flora';
  let mats = null;
  const underMeshes = []; // { mesh, box }
  const treeChunks = []; // { mesh, gFull, gLow, cx, cz, box, isFull }
  let carvedMesh = null;
  const subsystems = []; // helpers with update(dt) (grass, falling, growth, ambient)
  let underCount = 0;
  let saplings = null;
  let falling = null;
  let grass = null;
  try {
    ctx.scene?.add(group);
    mats = createFloraMaterials(ctx);
    const tintMain = rng.fork('tint');
    const tint2 = rng.fork('isle2-tint'); // Tempest Isle colors: separate stream (main-island tints unchanged)
    let tint = tintMain;

    // Trees + boulders: merged per chunk, cast + receive shadows, swaying depth material.
    // A second baker gets the low-detail twin of every instance (same chunk keys).
    const tb = new ChunkBaker();
    let low = null;
    try {
      low = buildLowLibrary(rng.fork('lib'));
    } catch (e) {
      console.error('[flora] low-detail trees failed (full detail everywhere)', e);
    }
    const tbLo = low ? new ChunkBaker() : null;
    const lowOf = (key, v, V) => low?.[key]?.[v] ?? V;
    for (const t of trees) {
      if (t.special) continue; // the carved oak is its own mesh (Builder F decorates it)
      tint = t.island === 'isle2' ? tint2 : tintMain;
      const k = 0.86 + tint() * 0.26;
      let leaf = [k * (1 + (tint() - 0.5) * 0.14), k, k * (1 + (tint() - 0.5) * 0.12)];
      // a few early-autumn crowns for warm accents in the green
      if ((t.type === 'birch' || t.type === 'oak' || t.type === 'chestnut') && tint() < 0.045) {
        leaf = tint() < 0.5 ? [1.75, 1.08, 0.42] : [1.55, 0.82, 0.36];
      }
      const bk = 0.88 + tint() * 0.24;
      const bark = [bk, bk, bk];
      meta[t.id].tint = { leaf, bark };
      const inst = { x: t.x, y: t.y, z: t.z, rot: t.rot, s: t.s, phase: t.phase, leafTint: leaf, barkTint: bark };
      meta[t.id].handle = tb.add(meta[t.id].V, inst);
      if (tbLo) meta[t.id].handleLo = tbLo.add(lowOf(t.vk ?? t.type, t.v, meta[t.id].V), inst);
    }
    for (const o of boulders) {
      tint = o.island === 'isle2' ? tint2 : tintMain;
      const k = 0.9 + tint() * 0.2;
      const inst = { x: o.x, y: o.y, z: o.z, rot: o.rot, s: o.s, phase: 0, windK: 0, barkTint: [k, k, k], leafTint: [k, k, k] };
      tb.add(lib.boulder[o.v], inst);
      tbLo?.add(lowOf('boulder', o.v, lib.boulder[o.v]), inst);
    }
    const treeMesh = (c, name) => {
      const m = new THREE.Mesh(c.geometry, mats.tree);
      m.name = name;
      m.castShadow = true;
      m.receiveShadow = true;
      m.customDepthMaterial = mats.depth; // same wind sway in the shadow pass
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.raycast = noRaycast; // CPU arrays are released after upload
      releaseAfterUpload(c.geometry, true); // keep the index: falling trees collapse their range
      group.add(m);
      return m;
    };
    const byKey = new Map();
    for (const c of tb.build()) {
      const tc = { mesh: treeMesh(c, `flora-trees-${c.ix},${c.iz}`), gFull: c.geometry, gLow: null, cx: (c.ix + 0.5) * CHUNK, cz: (c.iz + 0.5) * CHUNK, box: c.geometry.boundingBox, isFull: true };
      byKey.set(c.key, tc);
      treeChunks.push(tc);
    }
    if (tbLo) {
      for (const c of tbLo.build()) {
        const tc = byKey.get(c.key);
        if (!tc) continue;
        tc.gLow = c.geometry;
        releaseAfterUpload(c.geometry, true); // uploaded the first time the chunk shows its low detail
      }
    }

    // Undergrowth: ferns, bushes, flowers (bloom attribute), reeds, lily pads, rocks.
    const under = placeUndergrowth(W, rng.fork('under'), lib, trees, boulders);
    const nMainUnder = under.length;
    try {
      if (W.isle2) for (const it of placeIsle2Undergrowth(W, rng.fork('isle2-under'), lib, isle2.trees, isle2.boulders)) under.push(it);
    } catch (e) {
      console.error('[flora] Tempest Isle undergrowth failed', e);
    }
    const ub = new ChunkBaker({ close: true });
    for (let ui = 0; ui < under.length; ui++) {
      const it = under[ui];
      tint = ui < nMainUnder ? tintMain : tint2;
      const V = lib[it.kind][it.v];
      const k = it.kind === 'flower' ? 1 : 0.85 + tint() * 0.3;
      const tl = it.kind === 'flower' ? null : [k * (1 + (tint() - 0.5) * 0.1), k, k];
      ub.add(V, { x: it.x, y: it.y, z: it.z, rot: it.rot, s: it.s, phase: tint(), leafTint: tl, barkTint: tl, windK: it.kind === 'rock' ? 0 : 1 });
    }
    for (const c of ub.build()) {
      const m = new THREE.Mesh(c.geometry, mats.under);
      m.name = `flora-under-${c.ix},${c.iz}`;
      m.castShadow = false;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.raycast = noRaycast;
      releaseAfterUpload(c.geometry);
      group.add(m);
      underMeshes.push({ mesh: m, box: c.geometry.boundingBox });
    }
    underCount = under.length;

    // The carved landmark oak: standalone mesh, unrotated, so the carving can be wrapped on its trunk.
    if (carved) {
      const g = variantGeometry(lib.carvedOak, { phase: carved.phase });
      g.clearGroups();
      carvedMesh = new THREE.Mesh(g, mats.tree);
      carvedMesh.name = 'flora-carved-oak';
      carvedMesh.position.set(carved.x, carved.y, carved.z);
      carvedMesh.castShadow = true;
      carvedMesh.receiveShadow = true;
      carvedMesh.customDepthMaterial = mats.depth;
      carvedMesh.matrixAutoUpdate = false;
      carvedMesh.updateMatrix();
      group.add(carvedMesh);
    }

    // Dense grass patch that follows the player.
    grass = new GrassPatch(ctx, mats);
    group.add(grass.mesh);
    subsystems.push(grass);

    // Saplings that grow over the days, and old/dead trees that sometimes fall.
    saplings = new Saplings(ctx, { lib, mats, group, canopyAt: (x, z) => canopy.canopyAt(x, z) });
    subsystems.push(saplings);
    falling = new FallingTrees(ctx, {
      lib,
      trees,
      meta,
      mats,
      group,
      canopy,
      retireTree: (t) => retireTree(t),
      onDecay: (x, z) => saplings?.sproutAt(x, z),
    });
    subsystems.push(falling);
  } catch (e) {
    console.error('[flora] rendering setup failed (trees/colliders/canopy still valid)', e);
  }

  // ── Shared helpers for the subsystems ────────────────────────────────
  /** Remove a standing tree from the world state (it fell): collider, canopy, chunk mesh. */
  function retireTree(t) {
    const m = meta[t.id];
    if (!m) return;
    if (m.collider) ctx.colliders.remove(m.collider);
    m.collider = null;
    canopy.remove(t);
    if (m.handle) hideRange(m.handle);
    if (m.handleLo) hideRange(m.handleLo);
    t.alive = false;
    t.standing = false;
  }

  // ── Per-frame state ──────────────────────────────────────────────────
  const camPos = new THREE.Vector3();
  const lastCull = new THREE.Vector3(NaN, 0, NaN);
  let cullTimer = 0;
  let grassK = 1, grassD = 1;
  // The first frames render the full-detail chunks once, so their geometry is uploaded and the CPU copies
  // are released (releaseAfterUpload) instead of sitting in the JS heap until the player walks near.
  let lodWarmup = 2;

  /** Tree chunk LOD + shadow flags (camPos is current). */
  function updateTreeChunks() {
    const Q = ctx.quality;
    const D = Q?.lodDistance ?? LOD_DIST;
    const castR = (ctx.config?.graphics?.shadowRange ?? 70) * SHADOW_K;
    const x = camPos.x, z = camPos.z;
    for (let i = 0; i < treeChunks.length; i++) {
      const tc = treeChunks[i];
      const dx = tc.cx - x, dz = tc.cz - z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (tc.gLow) {
        const full = pickLod(tc.isFull, d, D, LOD_HYST);
        if (full !== tc.isFull) {
          tc.isFull = full;
          tc.mesh.geometry = full ? tc.gFull : tc.gLow;
        }
      }
      const b = tc.box;
      const m = tc.mesh;
      m.castShadow = boxDist2D(b.min.x, b.min.z, b.max.x, b.max.z, x, z) < castR;
      m.receiveShadow = d < RECEIVE_DIST;
    }
  }

  function cullUndergrowth() {
    const R = ctx.quality?.underDistance ?? UNDER_VIEW_DIST;
    const R2 = R * R;
    for (const u of underMeshes) {
      const b = u.box;
      const dx = Math.max(b.min.x - camPos.x, 0, camPos.x - b.max.x);
      const dz = Math.max(b.min.z - camPos.z, 0, camPos.z - b.max.z);
      const dy = Math.max(b.min.y - camPos.y, 0, camPos.y - b.max.y);
      u.mesh.visible = dx * dx + dz * dz + dy * dy < R2;
    }
  }

  const api = {
    trees,
    boulders,
    group,
    lib,
    /** The landmark oak entry (special:'carvedTree', carve:{radius,y0,y1,faceYaw}) and its mesh. */
    carvedTree: carved ? { tree: carved, mesh: carvedMesh } : null,
    /** 0 (open sky) .. 1 (dense shade) at (x, z). */
    canopyAt(x, z) {
      return canopy.canopyAt(x, z);
    },
    /** Nearest standing tree within maxDist (filter(tree) -> bool). Returns the entry or null. */
    nearestTree(x, z, maxDist = 30, filter = null) {
      return canopy.nearestTree(x, z, maxDist, filter);
    },
    /** Standing trees within r of (x, z). */
    treesNear(x, z, r, out = []) {
      return canopy.treesNear(x, z, r, out);
    },
    /** Debug: make a tree fall now (the given entry, or a suitable one 25-70 m from the player). */
    debugFell(tree) {
      return falling ? falling.debugFell(tree) : null;
    },
    /** Growing saplings ({x, z, born, growH, maxS, ...}). */
    get saplings() {
      return saplings ? saplings.list : [];
    },
    /** Trees currently falling or lying on the ground. */
    get fallen() {
      return falling ? falling.active.map((f) => ({ tree: f.t, phase: f.phase, gathered: f.gathered })) : [];
    },
    /** Internal (helpers): per-tree meta, retire a tree, materials, chunk size, tree chunk LOD state. */
    _internal: { meta, retireTree, canopy, get mats() { return mats; }, CHUNK, treeChunks },
    /** Debug: tree chunk LOD counts { full, low, casting }. */
    lodStats() {
      let full = 0, lowN = 0, casting = 0;
      for (const tc of treeChunks) {
        if (tc.isFull || !tc.gLow) full++;
        else lowN++;
        if (tc.mesh.castShadow) casting++;
      }
      return { full, low: lowN, casting };
    },
    get undergrowthCount() {
      return underCount;
    },
    init() {
      for (const s of subsystems) s.init?.();
    },
    update(dt) {
      mats?.update();
      cullTimer -= dt;
      if (ctx.camera && (treeChunks.length || underMeshes.length)) {
        ctx.camera.getWorldPosition(camPos);
        if (cullTimer <= 0 || !(camPos.distanceToSquared(lastCull) < JUMP2)) {
          cullTimer = CULL_EVERY;
          lastCull.copy(camPos);
          if (lodWarmup > 0) {
            lodWarmup--;
            cullTimer = 0;
          } else updateTreeChunks();
          cullUndergrowth();
        }
      }
      if (grass) {
        const k = ctx.quality?.grassScale ?? 1, gd = ctx.quality?.grassDensity ?? 1;
        if (k !== grassK || gd !== grassD) {
          grassK = k;
          grassD = gd;
          grass.setScale(k, gd);
        }
      }
      for (const s of subsystems) s.update(dt);
    },
  };
  return api;
}
