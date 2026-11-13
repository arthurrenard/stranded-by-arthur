// Structures (Builder E): campfires, signal fires, SOS signs, lean-to shelters and the held torch.
//
// Placement: crafting.js asks findPlacement(type) (cheap, cached, with a precise reason when blocked) and
// then place(type, placement) BEFORE it consumes the materials (place() never consumes them).
// Every structure goes into `list` ({ type, position, lit, removed, ... }: read by the HUD compass + map),
// gets a collider (except the flat SOS stones), an interactable, and registers itself in the shared sets:
//   ctx.heatSources (lit fires + the lit torch), ctx.signals (fires, SOS, torch), ctx.shelters (lean-to).
// Fire: fuel hours (CONFIG.fire), rain burns fuel faster and a downpour can douse an exposed campfire
// (a lean-to next to the fire keeps it dry), [E] add wood / relight, [R] cook everything cookable,
// sleeping (time:skip) burns the skipped hours. Signal fire: built unlit, [E] light / add leaves (thick
// smoke), [R] add wood. Torch: T (input owned here), camera-attached mesh + flickering light, 4 game hours.
// Rendering: merged procedural meshes on 2 shared materials, one instanced draw call each for flames,
// smoke and embers (./fx.js), and a FIXED pool of point lights (never added/removed at runtime, so no
// material recompiles): the nearest burning fires borrow them each frame.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { ITEMS, COOKABLE } from '../core/items.js';
import { fmtHour } from '../core/util.js';
import * as L from './structure-logic.js';
import { createFlames, createSmoke, createEmbers } from './fx.js';
import { createStructureMaterials, buildCampfire, buildPyre, buildLeanTo, buildSosStone, buildTorch, LEANTO, PAL } from './structure-meshes.js';

const FIRE = CONFIG.fire;
const K = L.K;
const UP = new THREE.Vector3(0, 1, 0);

/** Light tuning (physical units: candela with decay 2). */
export const LIGHT = {
  pool: 3, // point lights shared by the nearest burning fires
  campfire: 24,
  campfireDist: 22,
  campfireY: 0.6,
  signal: 70,
  signalDist: 36,
  signalY: 1.5,
  torch: 9,
  torchDist: 14,
  color: 0xff8a3c,
  torchColor: 0xffa24e,
  maxDist: 90, // fires further than this from the camera don't get a light
};

const NAMES = { campfire: 'campfire', signal_fire: 'signal fire', sos: 'SOS sign', shelter: 'lean-to' };

export function create(ctx) {
  const rng = ctx.rng?.fork ? ctx.rng.fork('structures') : Math.random;
  const list = []; // every structure, in build order
  const fires = []; // campfires + signal fires
  const shelters = []; // lean-tos
  const mats = createStructureMaterials(ctx);
  const root = new THREE.Group();
  root.name = 'structures';
  ctx.scene.add(root);

  const flames = createFlames(ctx, 256);
  const smoke = createSmoke(ctx, 760);
  const embers = createEmbers(ctx, 380);
  let sosStoneGeo = buildSosStone(rng);

  // Shader pre-warm: tiny meshes with every material variant this module uses (plain, foliage,
  // instanced) render below the island for the first frames, so building the first structure doesn't
  // stall on a shader compile. Removed after a few frames.
  const prewarm = new THREE.Group();
  prewarm.name = 'structures-prewarm';
  prewarm.position.set(0, -900, 0);
  for (const m of [new THREE.Mesh(sosStoneGeo, mats.solid), new THREE.Mesh(sosStoneGeo, mats.leaf), new THREE.InstancedMesh(sosStoneGeo, mats.solid, 1)]) {
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
    m.scale.setScalar(0.01);
    prewarm.add(m);
  }
  root.add(prewarm);
  let prewarmFrames = 0;

  // Fixed light pool (created once: changing the light count would recompile every material).
  const fireLights = [];
  for (let i = 0; i < LIGHT.pool; i++) {
    const l = new THREE.PointLight(LIGHT.color, 0, LIGHT.campfireDist, 2);
    l.castShadow = false;
    l.position.set(0, -500, 0);
    l.name = 'structure-fire-light-' + i;
    ctx.scene.add(l);
    fireLights.push(l);
  }

  // ── Held torch (camera child) ─────────────────────────────────────────
  const torchMesh = buildTorch(rng);
  const torchGroup = new THREE.Group();
  torchGroup.name = 'held-torch';
  const torchObj = new THREE.Mesh(torchMesh.geometry, mats.solid);
  torchObj.castShadow = false;
  torchObj.receiveShadow = false;
  torchObj.frustumCulled = false;
  torchGroup.add(torchObj);
  const torchTip = new THREE.Object3D();
  torchTip.position.copy(torchMesh.tip);
  torchGroup.add(torchTip);
  // the light lives directly on the camera and is never hidden (intensity 0 when stowed): toggling a
  // light's visibility changes the light count and would recompile every material
  const torchLight = new THREE.PointLight(LIGHT.torchColor, 0, LIGHT.torchDist, 2);
  torchLight.castShadow = false;
  torchLight.name = 'held-torch-light';
  ctx.camera.add(torchGroup);
  ctx.camera.add(torchLight);
  torchObj.visible = false;

  const torch = { lit: false, burnLeft: K.torchBurnHours, douse: 0, warned: false, show: 0, bob: 0, canopy: 0, envT: 0, emberAcc: 0 };
  const torchSlot = flames.alloc(3);
  const torchHeat = { position: new THREE.Vector3(), radius: 2, warmth: 0.35, kind: 'torch', lit: true };
  const torchSignal = {
    kind: 'torch',
    position: new THREE.Vector3(),
    strength: K.torchNight,
    isActive: () => L.torchSignalActive(torch.lit, ctx.time?.daylight ?? 1),
  };
  /** Stable object read by the HUD chip ("Torch · 3h 20m"). */
  const torchApi = {
    get lit() {
      return torch.lit;
    },
    get burnLeft() {
      return torch.lit ? torch.burnLeft : null;
    },
  };

  // ── Cooking state ──────────────────────────────────────────────────────
  const cook = { fire: null, t: 0, item: null, done: 0, total: 0, batch: new Map(), cooked: new Map() };

  // scratch (no allocations in the per-frame paths)
  const _cam = new THREE.Vector3();
  const _tip = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const chosen = new Array(LIGHT.pool).fill(null);
  const chosenD = new Array(LIGHT.pool).fill(Infinity);
  let rain = 0;
  const placeCacheMap = new Map();

  // ── Helpers ────────────────────────────────────────────────────────────
  const toast = (t, o) => ctx.ui?.toast?.(t, o);
  const hint = (id, t) => ctx.ui?.hint?.(id, t);
  const count = (id) => ctx.inventory?.count?.(id) ?? 0;
  const has = (id, n = 1) => count(id) >= n;
  const playing = () => ctx.state === 'playing';
  const daylight = () => ctx.time?.daylight ?? 1;
  const rainNow = () => {
    const r = ctx.weather?.rain ?? ctx.uniforms?.uRain?.value ?? 0;
    return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  };
  const canopyAt = (x, z) => {
    const c = ctx.flora?.canopyAt?.(x, z);
    return Number.isFinite(c) ? c : 0;
  };
  function fmtH(h) {
    h = Math.max(0, h);
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return hh > 0 ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
  }
  function distXZ(a, b) {
    return Math.hypot(a.x - b.x, a.z - b.z);
  }
  /** Local (lx, lz) of a structure rotated by yaw -> world {x, z}. Matches Object3D rotation.y. */
  function toWorld(cx, cz, yaw, lx, lz) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: cx + lx * c + lz * s, z: cz - lx * s + lz * c };
  }
  function nearShelter(pos, extra = 1) {
    for (const s of shelters) if (!s.removed && distXZ(pos, s.shelter.position) < s.shelter.radius + extra) return s;
    return null;
  }

  // ── Placement ──────────────────────────────────────────────────────────
  function fail(reason) {
    return { ok: false, reason };
  }

  /** Validate one spot for a structure type. */
  function checkSpot(type, x, z, yaw) {
    const W = ctx.world;
    if (!W) return fail('The island is not ready yet.');
    const fp = L.FOOTPRINT[type];
    const y = W.heightAt(x, z);
    if (W.waterAt(x, z) || y < (W.SEA_LEVEL ?? 0) + 0.15) return fail("You can't build in the water. Find dry ground.");
    // footprint ring: no water, not too uneven
    let minH = y, maxH = y;
    const ringR = type === 'sos' ? 0 : fp.r;
    if (ringR > 0) {
      for (let k = 0; k < 6; k++) {
        const a = yaw + (k * Math.PI) / 3;
        const sx = x + Math.cos(a) * ringR, sz = z + Math.sin(a) * ringR;
        const h = W.heightAt(sx, sz);
        if (W.waterAt(sx, sz) || h < (W.SEA_LEVEL ?? 0) + 0.1) return fail("Too close to the water's edge. Move a little inland.");
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    const maxSlope = type === 'shelter' ? 0.28 : 0.35;
    if (W.slopeAt(x, z) > maxSlope || maxH - minH > Math.max(0.35, fp.r * 0.6)) return fail('The ground is too steep here. Find a flatter spot.');
    // per-type rules
    if (type === 'signal_fire' && canopyAt(x, z) >= 0.35) return fail('A signal fire needs open sky: move away from the trees (a beach or a clearing).');
    if (type === 'sos') {
      // center and both ends of the letters must be on sand; read the biome fields immediately
      for (const lx of [-3.6, 0, 3.6]) {
        const p = toWorld(x, z, yaw, lx, 0);
        if (W.waterAt(p.x, p.z)) return fail('The SOS sign needs a wide dry stretch of beach. Step back from the water.');
        const sand = W.biomeAt(p.x, p.z).sand;
        if (!(sand > 0.5)) return fail('The SOS sign must be laid out on an open sandy beach.');
      }
    }
    // obstacles: trees, boulders, other colliders
    const probes = type === 'sos' ? [-2.8, 0, 2.8] : [0];
    const hits = [];
    for (const lx of probes) {
      const p = toWorld(x, z, yaw, lx, 0);
      hits.length = 0;
      ctx.colliders?.query?.(p.x, p.z, type === 'sos' ? 1.4 : fp.r, hits);
      for (const c of hits) {
        if (c.tag === 'structure' && type === 'sos') continue; // checked below by footprint
        return fail(c.tag === 'structure' ? 'Too close to something you built.' : 'Something is in the way (a tree or a rock). Try a clearer spot.');
      }
    }
    // other structures (footprints must not overlap)
    for (const s of list) {
      if (s.removed) continue;
      const other = L.FOOTPRINT[s.type];
      const ro = s.type === 'sos' ? other.halfW : other.r;
      const rs = type === 'sos' ? fp.halfW : fp.r;
      if (Math.hypot(s.position.x - x, s.position.z - z) < (ro + rs) * 0.85) return fail(`Too close to your ${NAMES[s.type] || 'structure'}.`);
    }
    return { ok: true, reason: null, type, x, y, z, yaw };
  }

  /** Find a valid spot ~2.5 m in front of the player (tries a few nearby spots). Cached for 0.2 s. */
  function findPlacement(type) {
    if (!L.FOOTPRINT[type]) return fail('Unknown structure.');
    const pl = ctx.player;
    const p = pl?.position;
    if (!p || !ctx.world) return fail('Not now.');
    if (pl.swimming || (pl.inWater && (pl.waterInfo?.depth ?? 0) > 0.35)) return fail("You can't build while standing in water.");
    const yaw = Number.isFinite(pl.yaw) ? pl.yaw : ctx.camera.rotation.y;
    const key = `${p.x.toFixed(1)}|${p.z.toFixed(1)}|${yaw.toFixed(2)}|${list.length}`;
    const now = performance.now();
    const c = placeCacheMap.get(type);
    if (c && c.key === key && now - c.t < 200) return c.res;
    const cands = L.placementCandidates(p.x, p.z, yaw, type);
    let first = null, res = null;
    for (const cand of cands) {
      const r = checkSpot(type, cand.x, cand.z, type === 'campfire' ? yaw : cand.yaw);
      if (r.ok) {
        res = r;
        break;
      }
      if (!first) first = r;
    }
    res = res || first || fail("Can't build here.");
    placeCacheMap.set(type, { key, t: now, res });
    return res;
  }

  /** Build a structure (materials are consumed by crafting AFTER this returns non-null). */
  function place(type, placement) {
    if (!L.FOOTPRINT[type]) return null;
    let pl = placement && placement.ok && Number.isFinite(placement.x) ? placement : findPlacement(type);
    if (!pl?.ok) return null;
    // re-validate (the cached spot may be stale if something was built meanwhile)
    const again = checkSpot(type, pl.x, pl.z, pl.yaw);
    if (!again.ok) {
      pl = findPlacement(type);
      if (!pl?.ok) return null;
    }
    let s = null;
    try {
      if (type === 'campfire') s = makeCampfire(pl);
      else if (type === 'signal_fire') s = makeSignalFire(pl);
      else if (type === 'shelter') s = makeShelter(pl);
      else if (type === 'sos') s = makeSos(pl);
    } catch (e) {
      console.error('[structures] build failed', e);
      return null;
    }
    if (!s) return null;
    list.push(s);
    placeCacheMap.clear();
    ctx.events?.emit?.('structure:placed', { type, position: s.position.clone(), structure: s });
    afterBuild(s);
    return s;
  }

  function afterBuild(s) {
    if (s.type === 'campfire') {
      lightFire(s, 'build');
      toast('You strike flint on pyrite and the kindling catches. The campfire is lit!', { icon: '🔥', kind: 'good', key: 'build' });
      hint('campfire', 'Campfire: look at it and press E to add wood (1 wood = 1.5 h), R to cook all your raw food. Rain burns fuel faster, and a downpour can drown an exposed fire.');
    } else if (s.type === 'signal_fire') {
      toast('Signal fire built. Light it (E) when the search party is near: its smoke is seen for miles.', { icon: '💨', kind: 'good', key: 'build' });
      hint('signal', 'Signal fire: E lights it (flint + pyrite), then E adds green leaves for an extra-thick smoke column for an hour. It burns about 6 hours: light it when you hear the search party.');
    } else if (s.type === 'shelter') {
      toast('Lean-to built. The roof keeps the rain off you, and a fire next to it.', { icon: '🏕️', kind: 'good', key: 'build' });
      hint('shelter', 'Shelter: from 19:00 to 05:00, stand under the roof and press E to sleep until morning. A campfire next to it keeps you warm.');
    } else if (s.type === 'sos') {
      toast('You lay out a giant S O S in stones. It can be read from the air in daylight.', { icon: '🆘', kind: 'good', key: 'build' });
    }
  }

  // ── Building blocks ────────────────────────────────────────────────────
  function baseStructure(type, pl) {
    const s = {
      id: list.length + 1,
      type,
      position: new THREE.Vector3(pl.x, pl.y, pl.z),
      yaw: pl.yaw,
      lit: false,
      removed: false,
      colliders: [],
      handle: null,
      group: new THREE.Group(),
      seed: rng() * 100,
    };
    s.group.name = 'structure-' + type;
    s.group.position.copy(s.position);
    root.add(s.group);
    return s;
  }
  /** Tilt a group to the ground normal (around its yaw). */
  function tiltToGround(g, x, z, yaw, amount = 1) {
    const n = ctx.world.normalAt(x, z, _n);
    _q.setFromUnitVectors(UP, n);
    if (amount < 1) _q.slerp(new THREE.Quaternion(), 1 - amount);
    g.quaternion.copy(_q).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
  }
  function addCollider(s, x, z, r, y0, y1) {
    const c = ctx.colliders?.add?.({ x, z, r, y0, y1, tag: 'structure', data: s });
    if (c) s.colliders.push(c);
  }
  function mesh(geo, mat, cast = true) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    return m;
  }

  /** Shared fire fields (campfire + signal fire). */
  function fireFields(s, big) {
    s.fuel = 0;
    s.douse = 0;
    s.warned = false;
    s.boost = 0;
    s.ember = 0;
    s.flame = 0;
    s.flare = 0;
    s.canopy = canopyAt(s.position.x, s.position.z);
    s.covered = false;
    s.rainEff = 0;
    s.envT = 0;
    s.smokeAcc = 0;
    s.emberAcc = 0;
    s.big = big;
    s.camDist = 0;
    s.heat = {
      position: new THREE.Vector3(s.position.x, s.position.y + 0.4, s.position.z),
      radius: big ? FIRE.warmthRadius * 1.35 : FIRE.warmthRadius,
      warmth: 1,
      kind: s.type,
      lit: false,
      fire: s,
    };
    s.heat.isActive = () => s.lit;
    const sig = {
      kind: s.type,
      position: new THREE.Vector3(s.position.x, s.position.y + (big ? 3 : 1), s.position.z),
      isActive: () => s.lit && !s.removed,
      fire: s,
    };
    Object.defineProperty(sig, 'strength', {
      enumerable: true,
      get: () => (big ? L.signalFireStrength(daylight(), s.boost > 0) : L.campfireStrength(daylight())),
    });
    s.signal = sig;
    ctx.signals?.add?.(sig);
    const n = big ? 10 : 7;
    s.flameSlot = flames.alloc(n);
    s.flameCount = s.flameSlot >= 0 ? n : 0;
    // tongue layout (local offsets from the center, sizes); the last two slots: glow halo + coal bed
    s.tongues = [];
    if (big) {
      s.tongues.push([0, 0, 1.3, 2.7]);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + rng() * 0.4, r = 0.4 + rng() * 0.25;
        s.tongues.push([Math.cos(a) * r, Math.sin(a) * r, 0.75 + rng() * 0.3, 1.5 + rng() * 0.7]);
      }
    } else {
      s.tongues.push([0, 0, 0.6, 1.05]);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4 + rng() * 0.3, r = 0.13 + rng() * 0.07;
        s.tongues.push([Math.cos(a) * r, Math.sin(a) * r, 0.34 + rng() * 0.1, 0.6 + rng() * 0.25]);
      }
    }
    fires.push(s);
  }

  function makeCampfire(pl) {
    const s = baseStructure('campfire', pl);
    const g = buildCampfire(rng);
    const inner = new THREE.Group();
    inner.add(mesh(g.base, mats.solid));
    s.logs = mesh(g.logs, mats.solid);
    inner.add(s.logs);
    s.group.add(inner);
    s.group.position.y -= 0.03;
    tiltToGround(inner, pl.x, pl.z, rng() * Math.PI * 2, 0.8);
    fireFields(s, false);
    s.fuel = FIRE.campfireStartFuelHours; // built with kindling: lit on placement (afterBuild)
    s.everLit = false;
    addCollider(s, pl.x, pl.z, 0.55);
    s.handle = ctx.interact?.register?.({
      position: new THREE.Vector3(pl.x, pl.y + 0.55, pl.z),
      radius: 3.7,
      label: () => campfireLabel(s),
      onUse: () => campfirePrimary(s),
      secondary: { label: () => campfireSecondaryLabel(s), onUse: () => campfireSecondary(s) },
      data: s,
    });
    return s;
  }

  function makeSignalFire(pl) {
    const s = baseStructure('signal_fire', pl);
    const g = buildPyre(rng);
    const inner = new THREE.Group();
    inner.add(mesh(g.base, mats.solid));
    s.logs = mesh(g.logs, mats.solid);
    s.leaves = mesh(g.leaves, mats.leaf);
    s.pyre = new THREE.Group();
    s.pyre.add(s.logs, s.leaves);
    inner.add(s.pyre);
    s.group.add(inner);
    s.group.position.y -= 0.04;
    tiltToGround(inner, pl.x, pl.z, rng() * Math.PI * 2, 0.6);
    fireFields(s, true);
    s.fuel = FIRE.signalFireFuelHours; // stacked, ready to light
    s.leafVis = 1;
    addCollider(s, pl.x, pl.z, 1.2);
    s.handle = ctx.interact?.register?.({
      position: new THREE.Vector3(pl.x, pl.y + 1.1, pl.z),
      radius: 4.3,
      label: () => signalLabel(s),
      onUse: () => signalPrimary(s),
      secondary: { label: () => signalSecondaryLabel(s), onUse: () => signalSecondary(s) },
      data: s,
    });
    return s;
  }

  function makeShelter(pl) {
    const s = baseStructure('shelter', pl);
    const g = buildLeanTo(rng);
    s.group.add(mesh(g.frame, mats.solid), mesh(g.roof, mats.leaf));
    s.group.rotation.y = pl.yaw; // open side (local +Z) faces the builder
    // colliders: the two front posts and the low back edge (the inside stays walkable)
    for (const [lx, lz] of LEANTO.posts) {
      const p = toWorld(pl.x, pl.z, pl.yaw, lx, lz);
      addCollider(s, p.x, p.z, 0.13);
    }
    for (const lx of [-1.0, 0, 1.0]) {
      const p = toWorld(pl.x, pl.z, pl.yaw, lx, LEANTO.backZ + 0.25);
      addCollider(s, p.x, p.z, 0.42);
    }
    const c = toWorld(pl.x, pl.z, pl.yaw, 0, (LEANTO.frontZ + LEANTO.backZ) / 2);
    s.shelter = { position: new THREE.Vector3(c.x, ctx.world.heightAt(c.x, c.z), c.z), radius: 3, structure: s };
    ctx.shelters?.add?.(s.shelter);
    shelters.push(s);
    const ip = toWorld(pl.x, pl.z, pl.yaw, 0, 0.1);
    s.handle = ctx.interact?.register?.({
      position: new THREE.Vector3(ip.x, pl.y + 0.9, ip.z),
      radius: 3.9,
      label: () => (L.isSleepHour(ctx.time?.hour ?? 12) ? 'Sleep until morning' : 'Sleep until morning (from 19:00)'),
      onUse: () => trySleep(),
      data: s,
    });
    return s;
  }

  function makeSos(pl) {
    const s = baseStructure('sos', pl);
    s.group.position.set(0, 0, 0); // stones carry world-space matrices
    const pts = L.sosLayout();
    const im = new THREE.InstancedMesh(sosStoneGeo, mats.solid, pts.length);
    im.castShadow = true;
    im.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const col = new THREE.Color();
    const tones = [PAL.darkRock, 0x6b655d, 0x544e48, 0x7a746b];
    for (let i = 0; i < pts.length; i++) {
      // letter coordinates: x to the reader's right (local +X), y away from the reader (local -Z)
      const w = toWorld(pl.x, pl.z, pl.yaw, pts[i].x + (rng() - 0.5) * 0.12, -pts[i].y + (rng() - 0.5) * 0.12);
      const sx = 0.24 + rng() * 0.1;
      sc.set(sx * (1 + rng() * 0.35), 0.13 + rng() * 0.06, sx);
      q.setFromAxisAngle(UP, rng() * Math.PI * 2);
      pos.set(w.x, ctx.world.heightAt(w.x, w.z) + sc.y * 0.35, w.z);
      m.compose(pos, q, sc);
      im.setMatrixAt(i, m);
      im.setColorAt(i, col.set(tones[Math.floor(rng() * tones.length)]).multiplyScalar(0.9 + rng() * 0.2));
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    s.group.add(im);
    const sig = { kind: 'sos', position: s.position.clone().setY(pl.y + 0.2), isActive: () => !s.removed && daylight() >= K.sosMinDaylight, structure: s };
    Object.defineProperty(sig, 'strength', { enumerable: true, get: () => L.sosStrength(daylight()) });
    s.signal = sig;
    ctx.signals?.add?.(sig);
    return s;
  }

  // ── Fire life cycle ────────────────────────────────────────────────────
  function lightFire(s, why) {
    if (s.lit) return;
    s.lit = true;
    s.everLit = true;
    s.douse = 0;
    s.envT = 0; // re-sample canopy / shelter / gale next frame
    s.warned = false;
    s.flare = 1;
    s.heat.lit = true;
    ctx.heatSources?.add?.(s.heat);
    ctx.events?.emit?.('fire:lit', { fire: s, kind: s.type, reason: why });
    ctx.audio?.play?.('ignite', { position: s.position });
    burstEmbers(s, s.big ? 50 : 22);
  }

  function extinguish(s, reason) {
    if (!s.lit) return;
    s.lit = false;
    s.heat.lit = false;
    s.ember = K.emberHours;
    ctx.heatSources?.delete?.(s.heat);
    if (cook.fire === s) stopCooking('fire');
    ctx.events?.emit?.('fire:out', { fire: s, kind: s.type, reason });
    const p = ctx.player?.position;
    const near = !p || distXZ(p, s.position) < 120;
    if (!near) return;
    if (reason === 'gale') {
      toast('The gale blows your fire out!', { icon: '🌬️', kind: 'warn', key: 'fire' + s.id });
      return;
    }
    if (s.type === 'campfire') {
      if (reason === 'rain') toast('The downpour drowned your campfire! Relight it: flint + pyrite + 1 wood.', { icon: '🌧️', kind: 'warn', key: 'fire' + s.id });
      else toast('Your campfire burned out. Relight it with flint + pyrite and 1 wood.', { icon: '🪵', kind: 'warn', key: 'fire' + s.id });
    } else {
      toast('The signal fire has burned down. Add wood (R) to rebuild it.', { icon: '💨', kind: 'warn', key: 'fire' + s.id });
    }
  }

  function burstEmbers(s, n) {
    const y = s.position.y + (s.big ? 0.8 : 0.25);
    for (let i = 0; i < n; i++) {
      const a = rng() * 6.283, sp = 0.4 + rng() * (s.big ? 1.6 : 0.9);
      embers.emit(s.position.x + Math.cos(a) * 0.15, y + rng() * 0.3, s.position.z + Math.sin(a) * 0.15, Math.cos(a) * sp, 1.8 + rng() * 2.5, Math.sin(a) * sp, 1 + rng() * 1.6, 0.03 + rng() * 0.035);
    }
  }

  // ── Campfire interaction ──────────────────────────────────────────────
  function campfireLabel(s) {
    if (!s.lit) {
      const verb = s.everLit ? 'Relight' : 'Light';
      return has('wood') && has('flint') && has('pyrite') ? `${verb} the fire (1 wood)` : `${verb} (flint + pyrite + 1 wood)`;
    }
    const left = `🔥 ${fmtH(L.hoursLeft(s.fuel, s.rainEff))}`;
    if (s.fuel >= FIRE.maxFuelHours - 0.05) return `Fire is well stocked · ${left}`;
    return has('wood') ? `Add wood · ${left}` : `Add wood (you have none) · ${left}`;
  }
  function campfirePrimary(s) {
    if (!playing()) return;
    if (!s.lit) {
      const miss = [];
      if (!has('flint')) miss.push('flint');
      if (!has('pyrite')) miss.push('pyrite');
      if (!has('wood')) miss.push('1 wood');
      if (miss.length) {
        toast(`To relight the fire you need ${miss.join(', ')}.`, { icon: '🪵', kind: 'warn', key: 'fire' });
        ctx.audio?.play?.('ui_click');
        return;
      }
      ctx.inventory.remove('wood', 1);
      s.fuel = Math.min(FIRE.maxFuelHours, Math.max(0, s.fuel) + FIRE.fuelPerWoodHours);
      lightFire(s, 'relight');
      toast(`Sparks fly and the fire catches again. 🔥 ${fmtH(s.fuel)}`, { icon: '🔥', kind: 'good', key: 'fire' });
      return;
    }
    feedWood(s);
  }
  function feedWood(s) {
    const max = s.big ? FIRE.maxFuelHours : FIRE.maxFuelHours;
    if (s.fuel >= max - 0.05) {
      toast('The fire is already well stocked.', { icon: '🔥', key: 'fire' });
      return;
    }
    if (!has('wood')) {
      toast('You need wood. Gather fallen sticks on the forest floor.', { icon: '🪵', kind: 'warn', key: 'fire' });
      ctx.audio?.play?.('ui_click');
      return;
    }
    const r = L.addWood(s.fuel, 1, FIRE, max);
    if (r.used < 1) return;
    ctx.inventory.remove('wood', 1);
    s.fuel = r.fuel;
    s.douse = Math.max(0, s.douse - 0.25);
    s.flare = 1;
    if (s.type === 'signal_fire' && !s.lit) s.leafVis = Math.max(s.leafVis, 0.5);
    burstEmbers(s, s.big ? 30 : 16);
    ctx.audio?.play?.('ignite', { position: s.position, volume: 0.35 });
    toast(`You add wood. 🔥 ${fmtH(L.hoursLeft(s.fuel, s.rainEff))} of fuel.`, { icon: '🪵', kind: 'good', key: 'fire' });
  }
  function campfireSecondaryLabel(s) {
    if (cook.fire === s) return `Stop cooking (${cook.done}/${cook.total})`;
    if (!s.lit) return '';
    const q = L.cookQueue(count, COOKABLE, ITEMS);
    if (q.total > 0) return `Cook ${q.total} item${q.total > 1 ? 's' : ''}`;
    if (!cook.fire && L.sleepBlocker(sleepState()) === null) return 'Sleep by the fire';
    return '';
  }
  function campfireSecondary(s) {
    if (!playing()) return;
    if (cook.fire === s) {
      stopCooking('player');
      return;
    }
    if (!s.lit) return;
    const q = L.cookQueue(count, COOKABLE, ITEMS);
    if (q.total > 0) startCooking(s);
    else trySleep();
  }

  // ── Signal fire interaction ───────────────────────────────────────────
  function signalLabel(s) {
    if (s.lit) {
      const thick = s.boost > 0 ? ` (thick smoke ${fmtH(s.boost)})` : '';
      return has('leaves', K.leavesPerBoost) ? `Add green leaves${thick}` : `Add green leaves (need ${K.leavesPerBoost})${thick}`;
    }
    if (s.fuel < 1) return 'Signal fire (burned down): add wood with R';
    return has('flint') && has('pyrite') ? 'Light the signal fire' : 'Light the signal fire (needs flint + pyrite)';
  }
  function signalPrimary(s) {
    if (!playing()) return;
    if (s.lit) {
      if (!has('leaves', K.leavesPerBoost)) {
        toast(`You need ${K.leavesPerBoost} green leaves to make thick white smoke.`, { icon: '🍃', kind: 'warn', key: 'fire' });
        ctx.audio?.play?.('ui_click');
        return;
      }
      if (s.boost >= K.maxBoostHours - 0.05) {
        toast('The smoke column is as thick as it gets.', { icon: '💨', key: 'fire' });
        return;
      }
      ctx.inventory.remove('leaves', K.leavesPerBoost);
      s.boost = Math.min(K.maxBoostHours, s.boost + K.boostHours);
      s.flare = 0.6;
      toast(`Green leaves hiss on the flames: a thick white column rises! (${fmtH(s.boost)})`, { icon: '💨', kind: 'good', key: 'fire' });
      return;
    }
    if (s.fuel < 1) {
      toast('Not enough fuel left on the pyre. Add wood (R) first.', { icon: '🪵', kind: 'warn', key: 'fire' });
      return;
    }
    if (!has('flint') || !has('pyrite')) {
      toast('You need flint and pyrite to strike a spark.', { icon: '🔹', kind: 'warn', key: 'fire' });
      ctx.audio?.play?.('ui_click');
      return;
    }
    lightFire(s, 'light');
    toast('The pyre roars to life. Smoke climbs high into the sky!', { icon: '🔥', kind: 'good', key: 'fire' });
    hint('signal-lit', 'Green leaves (E) make the smoke extra thick for an hour: the best way to be seen by day.');
  }
  function signalSecondaryLabel(s) {
    const max = FIRE.maxFuelHours;
    if (s.fuel >= max - 0.05) return '';
    const what = s.lit ? `Add wood · 🔥 ${fmtH(L.hoursLeft(s.fuel, s.rainEff))}` : `Add wood to the pyre (${fmtH(s.fuel)} of fuel)`;
    return has('wood') ? what : `${what} (no wood)`;
  }
  function signalSecondary(s) {
    if (!playing()) return;
    feedWood(s);
  }

  // ── Cooking ────────────────────────────────────────────────────────────
  function startCooking(s) {
    if (cook.fire) stopCooking('switch');
    const first = L.nextCookable(count, COOKABLE, ITEMS);
    if (!first) {
      toast('Nothing to cook. Wild apples, chanterelles, yam roots, chestnuts and cattails all cook well.', { icon: '🍳', key: 'cook' });
      return;
    }
    cook.fire = s;
    cook.t = 0;
    cook.item = first;
    cook.done = 0;
    cook.total = L.cookQueue(count, COOKABLE, ITEMS).total;
    cook.batch.clear();
    cook.cooked.clear();
    ctx.audio?.play?.('cook', { position: s.position });
    cookToast();
  }
  function cookToast() {
    const it = ITEMS[cook.item];
    if (!it) return;
    toast(`Cooking ${it.name} → ${ITEMS[it.cooksInto]?.name || ''} (${cook.done + 1}/${cook.total})`, { icon: '🍳', key: 'cook', duration: FIRE.cookSeconds + 1.5 });
  }
  function flushBatch(id) {
    const n = cook.batch.get(id) || 0;
    if (n > 0) {
      ctx.events?.emit?.('food:cooked', { from: id, to: ITEMS[id].cooksInto, n });
      cook.cooked.set(ITEMS[id].cooksInto, (cook.cooked.get(ITEMS[id].cooksInto) || 0) + n);
    }
    cook.batch.delete(id);
  }
  function finishCooking(why) {
    for (const id of [...cook.batch.keys()]) flushBatch(id);
    const parts = [];
    for (const [to, n] of cook.cooked) parts.push(`${n} ${ITEMS[to]?.name || to}`);
    const fire = cook.fire;
    cook.fire = null;
    cook.item = null;
    if (parts.length) {
      const pre = why === 'done' ? 'Cooked' : why === 'fire' ? 'The fire went out. Cooked' : 'Stopped. Cooked';
      toast(`${pre}: ${parts.join(', ')}.`, { icon: '🍽️', kind: 'good', key: 'cook' });
      hint('cooked', 'Cooked food is much more nourishing. Select it in the hotbar and press F to eat.');
    } else if (why === 'away') toast('You stepped away from the fire.', { icon: '🍳', key: 'cook' });
    cook.cooked.clear();
    return fire;
  }
  function stopCooking(why = 'player') {
    if (!cook.fire) return;
    finishCooking(why);
  }
  function updateCooking(dt) {
    if (!cook.fire) return;
    if (!playing()) return; // pause (dead/rescued states end it below)
    const f = cook.fire;
    const p = ctx.player?.position;
    if (!f.lit) return stopCooking('fire');
    if (ctx.flags.sleeping) return stopCooking('sleep');
    if (p && distXZ(p, f.position) > 4.2) return stopCooking('away');
    cook.t += dt;
    if (cook.t < FIRE.cookSeconds) return;
    cook.t -= FIRE.cookSeconds;
    const id = cook.item;
    const to = ITEMS[id]?.cooksInto;
    // re-read: the item may have been eaten while it cooked
    if (to && count(id) > 0 && ctx.inventory?.remove?.(id, 1)) {
      ctx.inventory.add(to, 1);
      cook.batch.set(id, (cook.batch.get(id) || 0) + 1);
      cook.done++;
      if (f) f.flare = Math.max(f.flare, 0.3);
    }
    const next = L.nextCookable(count, COOKABLE, ITEMS);
    if (next !== id) flushBatch(id);
    if (!next) {
      finishCooking('done');
      return;
    }
    cook.item = next;
    cook.total = cook.done + L.cookQueue(count, COOKABLE, ITEMS).total;
    ctx.audio?.play?.('cook', { position: f.position });
    cookToast();
  }

  // ── Sleep ──────────────────────────────────────────────────────────────
  let sleepBusy = false;
  function sleepState() {
    return { hour: ctx.time?.hour ?? 12, sheltered: !!ctx.flags.sheltered, nearFire: ctx.flags.nearFire || 0, cooking: !!cook.fire };
  }
  async function trySleep() {
    if (!playing() || sleepBusy || ctx.stats?.sleeping) return false;
    const b = L.sleepBlocker(sleepState());
    if (b === 'notTired') {
      toast(`You're not tired enough to sleep yet. You can sleep from 19:00 until 05:00 (now ${fmtHour(ctx.time?.hour ?? 12)}).`, { icon: '🌙', key: 'sleep' });
      return false;
    }
    if (b === 'cooking') {
      toast('Finish cooking first.', { icon: '🍳', key: 'sleep' });
      return false;
    }
    if (b === 'exposed') {
      toast('Too exposed to sleep here. Get under the lean-to roof, or lie down right next to a fire.', { icon: '🌙', kind: 'warn', key: 'sleep' });
      return false;
    }
    if (!ctx.stats?.sleep) return false;
    if (torch.lit) setTorch(false, 'sleep');
    stopCooking('sleep');
    sleepBusy = true;
    try {
      return !!(await ctx.stats.sleep(ctx.time.hoursUntil(K.wakeHour)));
    } catch (e) {
      console.error('[structures] sleep failed', e);
      return false;
    } finally {
      sleepBusy = false;
    }
  }

  // ── Torch ──────────────────────────────────────────────────────────────
  function setTorch(on, why) {
    if (torch.lit === on) return;
    torch.lit = on;
    ctx.flags.torchLit = on;
    if (on) {
      if (!(torch.burnLeft > 0)) torch.burnLeft = K.torchBurnHours;
      torch.douse = 0;
      torch.warned = false;
      torch.gale = 0;
      torch.envT = 0; // re-sample canopy + gale next frame
      ctx.heatSources?.add?.(torchHeat);
      ctx.audio?.play?.('ignite', { volume: 0.5 });
    } else {
      ctx.heatSources?.delete?.(torchHeat);
    }
    ctx.events?.emit?.('torch:toggle', { lit: on, reason: why });
  }

  /** T / F on a torch: light it (sparks or a nearby fire) or stow it. Returns true if something happened. */
  function toggleTorch() {
    if (!playing() || ctx.flags.cinematic) return false;
    if (torch.lit) {
      setTorch(false, 'stow');
      toast(`You smother and stow the torch (${fmtH(torch.burnLeft)} left).`, { icon: '🔥', key: 'torch' });
      return true;
    }
    if (!has('torch')) {
      toast("You don't have a torch. Craft one (Tab): 1 wood + 1 fiber.", { icon: '🔥', kind: 'warn', key: 'torch' });
      return false;
    }
    const pl = ctx.player;
    if (pl?.swimming || pl?.headUnderwater) {
      toast("You can't light a torch in the water.", { icon: '🌊', kind: 'warn', key: 'torch' });
      return false;
    }
    const p = pl?.position;
    const fire = p ? nearestFire(p, 3.5, true) : null;
    if (!fire && !(has('flint') && has('pyrite'))) {
      toast('You need flint and pyrite to strike a spark, or light the torch at a fire.', { icon: '🔹', kind: 'warn', key: 'torch' });
      return false;
    }
    setTorch(true, fire ? 'fire' : 'sparks');
    toast(fire ? 'You light the torch from the fire.' : 'Sparks catch the fiber wrap: the torch is lit.', { icon: '🔥', kind: 'good', key: 'torch' });
    return true;
  }

  function updateTorch(dt, dtH) {
    const pl = ctx.player;
    const p = pl?.position;
    if (torch.lit && playing()) {
      if (!has('torch')) setTorch(false, 'lost');
      else if (pl?.swimming || pl?.headUnderwater) {
        setTorch(false, 'water');
        toast('Your torch hissed out in the water.', { icon: '🌊', kind: 'warn', key: 'torch' });
      } else if (ctx.flags.sleeping) setTorch(false, 'sleep');
      else {
        torch.burnLeft -= dtH;
        // rain: canopy/shelter shield the flame
        torch.envT -= dt;
        if (torch.envT <= 0 && p) {
          torch.envT = 0.5;
          torch.canopy = canopyAt(p.x, p.z);
          torch.gale = galeAt(p); // v3: Tempest Isle storm
        }
        const eff = L.rainExposure(rain, torch.canopy, !!ctx.flags.sheltered);
        torch.douse = L.torchDouseStep(torch.douse, dtH, eff);
        if (!torch.warned && torch.douse > 0.45) {
          torch.warned = true;
          toast('The rain is putting out your torch! Find cover under trees or a roof.', { icon: '🌧️', kind: 'warn', key: 'torch' });
        }
        if (torch.gale > 0.55) {
          setTorch(false, 'gale');
          toast('The gale blows your fire out!', { icon: '🌬️', kind: 'warn', key: 'torch' });
        } else if (torch.burnLeft <= 0) {
          ctx.inventory?.remove?.('torch', 1);
          torch.burnLeft = K.torchBurnHours; // the next torch is fresh
          setTorch(false, 'burnt');
          const more = count('torch');
          toast(more > 0 ? `Your torch burned out. Press T to light another (${more} left).` : 'Your torch burned out.', { icon: '🔥', kind: 'warn', key: 'torch' });
        } else if (torch.douse >= 1) {
          setTorch(false, 'rain');
          toast('The rain put out your torch.', { icon: '🌧️', kind: 'warn', key: 'torch' });
        }
      }
    }
    // follow the player (heat + signal)
    if (p) {
      torchHeat.position.set(p.x, p.y + 1.2, p.z);
      torchSignal.position.set(p.x, p.y + 1.8, p.z);
    }
    // visuals: raise/lower the held torch, bob with the walk, flicker the light
    const target = torch.lit ? 1 : 0;
    torch.show += (target - torch.show) * Math.min(1, dt * 7);
    if (torch.show < 0.01 && !torch.lit) torch.show = 0;
    const visible = torch.show > 0.01;
    torchObj.visible = visible;
    const t = ctx.uniforms.uTime.value;
    if (visible) {
      if (pl?.moving) torch.bob += dt * (pl.sprinting ? 11 : 8);
      const bobY = Math.sin(torch.bob) * 0.012, bobX = Math.cos(torch.bob * 0.5) * 0.01;
      torchGroup.position.set(0.3 + bobX, -0.34 + bobY - (1 - torch.show) * 0.4, -0.56);
      torchGroup.rotation.set(-0.32 + Math.sin(torch.bob) * 0.02, 0, 0.2);
    }
    const fl = flicker(t, 1.7);
    torchLight.position.copy(torchMesh.tip).applyEuler(torchGroup.rotation).add(torchGroup.position);
    torchLight.position.y += 0.1;
    torchLight.intensity = torch.lit ? LIGHT.torch * torch.show * fl : 0;
    if (torchSlot >= 0) {
      if (torch.lit && torch.show > 0.05) {
        torchTip.getWorldPosition(_tip);
        const k = torch.show;
        flames.set(torchSlot, _tip.x, _tip.y - 0.02, _tip.z, 0.1 * k, 0.24 * k, 3.7, 1, 0);
        flames.set(torchSlot + 1, _tip.x + 0.012, _tip.y - 0.01, _tip.z, 0.07 * k, 0.16 * k, 8.1, 0.8, 0);
        flames.set(torchSlot + 2, _tip.x, _tip.y + 0.07, _tip.z, 0.75 * k, 0, 1.3, 0.38 * fl * (0.4 + 0.6 * (1 - daylight())), 1);
        torch.emberAcc += dt * 2.2;
        while (torch.emberAcc >= 1) {
          torch.emberAcc--;
          embers.emit(_tip.x, _tip.y + 0.12, _tip.z, (rng() - 0.5) * 0.3, 0.8 + rng() * 0.8, (rng() - 0.5) * 0.3, 0.6 + rng() * 0.6, 0.012 + rng() * 0.01);
        }
      } else {
        flames.hide(torchSlot);
        flames.hide(torchSlot + 1);
        flames.hide(torchSlot + 2);
      }
    }
  }

  /** Multi-frequency flicker around 1 (seeded per fire). */
  function flicker(t, seed) {
    return 0.84 + 0.08 * Math.sin(t * 13.1 + seed) + 0.05 * Math.sin(t * 7.3 + seed * 2.1) + 0.03 * Math.sin(t * 23.7 + seed * 5.3);
  }

  // ── Per-frame fire update ──────────────────────────────────────────────
  /** v3: Tempest Isle storm strength at pos (0 when indoors: inside an indoor shelter such as the fishing hut). */
  function galeAt(pos) {
    const g = Number(ctx.weather?.stormAt?.(pos.x, pos.z)) || 0;
    if (g <= 0.55) return g;
    const indoor = ctx.weather?.isIndoors ? ctx.weather.isIndoors(pos) : !!ctx.isle2?.isIndoors?.(pos);
    return indoor ? 0 : g;
  }

  function updateFire(s, dt, dtH) {
    // environment (canopy can change when a tree falls; a lean-to may be built next to it)
    s.envT -= dt;
    if (s.envT <= 0) {
      s.envT = 1 + rng() * 0.2;
      s.canopy = canopyAt(s.position.x, s.position.z);
      s.covered = !!nearShelter(s.position, 1);
      s.gale = galeAt(s.position); // v3: Tempest Isle storm
    }
    // v3: rain where the fire is (api.rain is at the camera, which may be inside Tempest Isle's storm)
    const rainHere = ctx.weather?.rainAt ? Number(ctx.weather.rainAt(s.position.x, s.position.z)) || 0 : rain;
    s.rainEff = L.rainExposure(rainHere, s.canopy, s.covered);
    if (playing() && s.lit) {
      s.fuel = L.burnFuel(s.fuel, dtH, s.rainEff);
      if (s.boost > 0) s.boost = Math.max(0, s.boost - dtH);
      if (s.type === 'campfire') {
        s.douse = L.douseStep(s.douse, dtH, s.rainEff);
        if (!s.warned && s.douse > K.douseWarnAt) {
          s.warned = true;
          const p = ctx.player?.position;
          if (p && distXZ(p, s.position) < 80)
            toast('The downpour is drowning your campfire! Feed it wood, or build a lean-to beside it.', { icon: '🌧️', kind: 'warn', key: 'fire' + s.id });
        }
        if (s.douse < 0.2) s.warned = false;
      }
      if (s.gale > 0.55) extinguish(s, 'gale');
      else if (s.fuel <= 0) extinguish(s, 'fuel');
      else if (s.douse >= 1) extinguish(s, 'rain');
    }
    if (!s.lit && s.ember > 0) s.ember = Math.max(0, s.ember - dtH * (1 + s.rainEff * 4));

    // visual level (smoothed), flare-ups when fed
    const target = s.lit ? L.flameLevel(s.fuel) * (1 - 0.3 * s.rainEff) + s.flare * 0.35 : 0;
    s.flame += (target - s.flame) * Math.min(1, dt * (target > s.flame ? 4 : 1.5));
    s.flare = Math.max(0, s.flare - dt * 1.2);
    s.heat.warmth = s.lit ? 0.6 + 0.4 * Math.min(1, L.flameLevel(s.fuel)) : 0;
    const emberK = s.ember / K.emberHours;

    // the wood visibly burns down (campfire logs / pyre)
    const fuelK = Math.min(1, s.fuel / (s.big ? FIRE.signalFireFuelHours : 6));
    if (s.type === 'campfire') {
      const k = 0.5 + 0.5 * fuelK;
      s.logs.scale.set(0.75 + 0.25 * k, k, 0.75 + 0.25 * k);
    } else {
      const k = 0.35 + 0.65 * fuelK;
      s.pyre.scale.set(0.8 + 0.2 * k, k, 0.8 + 0.2 * k);
      // green brush burns off first once lit; restacking (wood) brings a little back
      if (s.lit) s.leafVis = Math.max(0, s.leafVis - dt * 0.02);
      s.leaves.visible = s.leafVis > 0.03;
      s.leaves.scale.setScalar(Math.max(0.03, s.leafVis));
    }

    drawFire(s, dt, emberK);
  }

  function drawFire(s, dt, emberK) {
    const P = s.position;
    const f = s.flame;
    const t = ctx.uniforms.uTime.value;
    const night = 1 - daylight();
    _cam.copy(ctx.camera.position);
    s.camDist = Math.hypot(P.x - _cam.x, P.z - _cam.z);
    if (s.flameSlot >= 0) {
      const n = s.tongues.length;
      const by = P.y + (s.big ? 0.15 : 0.04);
      for (let i = 0; i < n; i++) {
        const [ox, oz, w, h] = s.tongues[i];
        if (f < 0.02) flames.hide(s.flameSlot + i);
        else flames.set(s.flameSlot + i, P.x + ox, by, P.z + oz, w * (0.55 + 0.45 * f), h * f, s.seed + i * 1.37, Math.min(1, f * 1.4), 0);
      }
      // glow halo (stronger at night) + coal bed (also while the embers cool)
      const glowI = f * (0.25 + 0.75 * night) * flicker(t, s.seed);
      if (glowI < 0.01) flames.hide(s.flameSlot + n);
      else flames.set(s.flameSlot + n, P.x, P.y + (s.big ? 1.3 : 0.5), P.z, (s.big ? 7 : 2.8) * (0.6 + 0.4 * f), 0, s.seed, glowI, 1);
      const coal = Math.max(f * 0.9, emberK * 0.8);
      if (coal < 0.01) flames.hide(s.flameSlot + n + 1);
      else flames.set(s.flameSlot + n + 1, P.x, P.y + 0.05, P.z, s.big ? 2.3 : 1.0, 0, s.seed * 1.3, coal, 2);
    }

    // smoke + embers (campfires far away don't bother; signal smoke is visible from afar)
    const far = !s.big && s.camDist > 260;
    if (far) return;
    const rainy = s.rainEff;
    if (s.big) {
      let rate = 0;
      if (s.lit) rate = (s.boost > 0 ? 15 : 7.5) * (0.4 + 0.6 * Math.min(1, f * 1.3));
      else if (emberK > 0) rate = 2.5 * emberK;
      s.smokeAcc += dt * rate;
      const boost = s.boost > 0;
      while (s.smokeAcc >= 1) {
        s.smokeAcc--;
        const a = rng() * 6.283, r = rng() * 0.5;
        const white = boost ? 0.97 : 0.9 - rng() * 0.06;
        smoke.emit({
          x: P.x + Math.cos(a) * r,
          y: P.y + 2.2 + rng() * 0.6,
          z: P.z + Math.sin(a) * r,
          rise: (s.lit ? 4.2 : 1.6) + (rng() - 0.5) * 1.2,
          size0: 1.8 + rng() * 0.9,
          size1: (boost ? 15 : 11) + rng() * 4,
          life: s.lit ? 20 + rng() * 6 : 10 + rng() * 4,
          r: white, g: white, b: white + 0.02,
          alpha: s.lit ? (boost ? 0.78 : 0.55) : 0.3 * emberK,
          glow: 0.4 * night * f,
          wind: 1,
        });
      }
    } else {
      let rate = 0;
      if (s.lit) rate = 2 + rainy * 2.5;
      else if (emberK > 0) rate = 1.6 * emberK;
      s.smokeAcc += dt * rate;
      while (s.smokeAcc >= 1) {
        s.smokeAcc--;
        const grey = s.lit ? 0.52 + rainy * 0.25 + rng() * 0.06 : 0.42;
        smoke.emit({
          x: P.x + (rng() - 0.5) * 0.25,
          y: P.y + (s.lit ? 0.75 + f * 0.4 : 0.25),
          z: P.z + (rng() - 0.5) * 0.25,
          rise: 1.1 + rng() * 0.5,
          size0: 0.35 + rng() * 0.2,
          size1: 2.2 + rng() * 1.2,
          life: 6 + rng() * 2.5,
          r: grey, g: grey, b: grey + 0.02,
          alpha: (s.lit ? 0.2 + rainy * 0.15 : 0.18 * emberK),
          glow: 0.3 * night * f,
          wind: 0.7,
        });
      }
    }
    if (s.lit && f > 0.05) {
      s.emberAcc += dt * (s.big ? 16 : 5) * f;
      while (s.emberAcc >= 1) {
        s.emberAcc--;
        const a = rng() * 6.283, r = rng() * (s.big ? 0.7 : 0.2);
        embers.emit(
          P.x + Math.cos(a) * r,
          P.y + (s.big ? 0.8 + rng() * 1.6 : 0.3 + rng() * 0.4) * f,
          P.z + Math.sin(a) * r,
          (rng() - 0.5) * 0.6,
          (s.big ? 2.2 : 1.3) + rng() * 1.4,
          (rng() - 0.5) * 0.6,
          (s.big ? 2 : 1.1) + rng() * 1.4,
          (s.big ? 0.05 : 0.03) + rng() * 0.025,
        );
      }
    }
  }

  /** Give the fixed light pool to the nearest burning fires. */
  function assignLights() {
    for (let i = 0; i < LIGHT.pool; i++) {
      chosen[i] = null;
      chosenD[i] = Infinity;
    }
    for (const s of fires) {
      const glow = Math.max(s.flame, (s.ember / K.emberHours) * 0.12);
      if (glow < 0.02 || s.camDist > LIGHT.maxDist) continue;
      // insertion into the small sorted array
      let d = s.camDist;
      let cur = s;
      for (let i = 0; i < LIGHT.pool; i++) {
        if (d < chosenD[i]) {
          const td = chosenD[i], ts = chosen[i];
          chosenD[i] = d;
          chosen[i] = cur;
          d = td;
          cur = ts;
          if (!cur) break;
        }
      }
    }
    const t = ctx.uniforms.uTime.value;
    for (let i = 0; i < LIGHT.pool; i++) {
      const l = fireLights[i];
      const s = chosen[i];
      if (!s) {
        if (l.intensity !== 0) l.intensity = 0;
        continue;
      }
      const glow = Math.max(s.flame, (s.ember / K.emberHours) * 0.12);
      const fade = 1 - Math.min(1, Math.max(0, (s.camDist - LIGHT.maxDist * 0.7) / (LIGHT.maxDist * 0.3)));
      const fl = flicker(t, s.seed);
      const j = 0.03 * glow;
      l.position.set(s.position.x + Math.sin(t * 9.1 + s.seed) * j, s.position.y + (s.big ? LIGHT.signalY : LIGHT.campfireY) * (0.6 + 0.4 * glow), s.position.z + Math.cos(t * 8.3 + s.seed) * j);
      l.distance = s.big ? LIGHT.signalDist : LIGHT.campfireDist;
      l.intensity = (s.big ? LIGHT.signal : LIGHT.campfire) * glow * fl * fade;
    }
  }

  /** Nearest fire within maxDist (XZ) of pos; litOnly skips cold ones. Includes signal fires. */
  function nearestFire(pos, maxDist = 3, litOnly = true) {
    if (!pos) return null;
    let best = null, bd = maxDist;
    for (const s of fires) {
      if (s.removed || (litOnly && !s.lit)) continue;
      const d = distXZ(pos, s.position);
      if (d <= bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  function init() {
    ctx.signals?.add?.(torchSignal);
    // Sleeping skips the clock without dtHours: burn the skipped hours here.
    ctx.events?.on?.('time:skip', (p) => {
      const h = Number(p?.hours ?? (p?.to ?? 0) - (p?.from ?? 0));
      if (!(h > 0)) return;
      if (torch.lit) setTorch(false, 'sleep');
      stopCooking('sleep');
      rain = rainNow();
      for (const s of fires) {
        if (!s.lit) continue;
        s.fuel = L.burnFuel(s.fuel, h, s.rainEff);
        s.boost = Math.max(0, s.boost - h);
        if (s.fuel <= 0) {
          extinguish(s, 'fuel');
          s.ember = 0;
        }
      }
    });
    ctx.events?.on?.('stats:died', () => stopCooking('dead'));
  }

  function update(dt) {
    if (prewarmFrames >= 0 && ++prewarmFrames > 4) {
      root.remove(prewarm);
      prewarmFrames = -1;
    }
    const dtH = playing() ? ctx.time?.dtHours || 0 : 0;
    if (playing() && !ctx.flags.cinematic && !ctx.ui?.menuOpen && ctx.input?.wasPressed?.('torch')) toggleTorch();
    rain = rainNow();
    for (let i = 0; i < fires.length; i++) updateFire(fires[i], dt, dtH);
    updateCooking(dt);
    updateTorch(dt, dtH);
    assignLights();
    smoke.update(dt);
    embers.update(dt);
    flames.commit();
  }

  /** True when a sleep action is actually available where the player stands (HUD "You can sleep here" chip). */
  function canSleepHere() {
    if (L.sleepBlocker(sleepState()) !== null) return false;
    if (ctx.flags.sheltered) return true;
    const f = nearestFire(ctx.player?.position, 3.5, true);
    return !!f && f.type === 'campfire' && L.cookQueue(count, COOKABLE, ITEMS).total === 0;
  }

  return {
    init,
    update,
    canSleepHere,
    /** Every structure: { type, position, lit, removed, ... } (HUD compass + map). */
    get list() {
      return list;
    },
    /** { lit, burnLeft (game hours, null when stowed) } */
    get torch() {
      return torchApi;
    },
    /** True while the R-cook queue runs. */
    get cooking() {
      return !!cook.fire;
    },
    get cookProgress() {
      return cook.fire ? { item: cook.item, done: cook.done, total: cook.total, t: cook.t / FIRE.cookSeconds } : null;
    },
    place,
    findPlacement,
    nearestFire,
    toggleTorch,
    isTorchLit: () => torch.lit,
    sleep: trySleep,
    /** Debug: build in front of the player without materials, e.g. __game.structures.debugPlace('signal_fire'). */
    debugPlace(type) {
      return place(type, findPlacement(type));
    },
    /** Debug: set the fuel of the nearest fire. */
    debugFuel(hours, maxDist = 30) {
      const s = nearestFire(ctx.player?.position, maxDist, false);
      if (s) s.fuel = Math.max(0, Number(hours) || 0);
      return s?.fuel;
    },
    lights: fireLights,
  };
}
