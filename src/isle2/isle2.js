// Tempest Isle content (V3-B, SPEC §11): the dock in the cove, the fisherman's motorboat moored at its end, the
// fishing hut on the summit plateau (isle2-hut.js: interior, hearth, lantern, burning it down), the dock hook for the
// fishing minigame (isle2-fishing.js → ctx.fishing, V4-C) and rockfall on the steep upper slopes (isle2-rockfall.js).
//
// Public API (ctx.isle2):
//   motorboat: { object, position (=== object.position), heading (yaw), moored }   (Builder C makes it drivable)
//   isIndoors(pos) → bool (inside the intact hut), partsInHut() → [{ id, taken }]
//   dock: { x, z, dirX, dirZ, length, deckY, end }, isOnDock(x, z, y?), hut (state, hearthPos, floorY, frame...)
//   fishing, rockfall, group, debug: { goHut(), goDock(), burn(), rockfall(), catch() }, init(), update(dt)
import * as THREE from 'three';
import { createFlames, createSmoke, createEmbers } from '../gameplay/fx.js';
import { buildDock, buildMotorboat } from './isle2-models.js';
import { createHut } from './isle2-hut.js';
import { createFishing } from './isle2-fishing.js';
import { createRockfall } from './isle2-rockfall.js';

const DECK_Y = 0.95; // deck top above sea level
const HALF_W = 1.1;
const BOAT_T = 15.6; // the boat lies alongside, near the end
const BOAT_SIDE = 2.3; // m to starboard of the dock center line

export function create(ctx) {
  const W = ctx.world;
  const L = W?.landmarks || {};
  const rand = ctx.rng.fork('isle2');
  const group = new THREE.Group();
  group.name = 'isle2';
  let hut = null, fishing = null, rockfall = null;
  const api = {
    group,
    motorboat: null,
    hut: null,
    dock: null,
    fishing: null,
    rockfall: null,
    isIndoors: (pos) => !!hut?.isIndoors(pos),
    partsInHut: () => hut?.partsInHut() ?? [],
    isOnDock: () => false,
    init,
    update,
    debug: {},
  };
  if (!W || !L.isle2Dock || !L.isle2Hut) return api;
  try {
    ctx.scene?.add(group);
  } catch (e) {
    console.error('[isle2] scene add failed', e);
  }

  // shared fire fx (hut blaze, hearth, rockfall dust)
  let fx = null;
  try {
    fx = { flames: createFlames(ctx, 32), smoke: createSmoke(ctx, 360), embers: createEmbers(ctx, 220) };
  } catch (e) {
    console.error('[isle2] fx setup failed', e);
  }

  const woodMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, flatShading: true });

  // ── Dock ────────────────────────────────────────────────────────────────
  const D = L.isle2Dock;
  const len = D.length ?? 18;
  const perpX = -D.dirZ, perpZ = D.dirX; // dock-local +Z (starboard when facing out to sea)
  const dockAt = (t, s = 0, out = new THREE.Vector3(), y = 0) => out.set(D.x + D.dirX * t + perpX * s, y, D.z + D.dirZ * t + perpZ * s);
  const dock = { x: D.x, z: D.z, dirX: D.dirX, dirZ: D.dirZ, length: len, deckY: DECK_Y, halfW: HALF_W, end: dockAt(len, 0, undefined, DECK_Y) };
  api.dock = dock;
  const dockColliders = [];
  let bollards = [];
  try {
    const seabed = (t) => W.heightAt(D.x + D.dirX * t, D.z + D.dirZ * t);
    const g = buildDock(rand, { length: len, start: 0.4, halfW: HALF_W, deckY: DECK_Y, seabed });
    bollards = g.bollards;
    const root = new THREE.Group();
    root.name = 'isle2-dock';
    root.position.set(D.x, 0, D.z);
    root.rotation.y = Math.atan2(-D.dirZ, D.dirX);
    const m = new THREE.Mesh(g.wood, woodMat);
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
    const rope = new THREE.Mesh(g.rope, woodMat);
    root.add(rope);
    group.add(root);
  } catch (e) {
    console.error('[isle2] dock mesh failed', e);
  }
  // walkable deck: a chain of circles topped at the deck height (posts go down to the seabed)
  for (let t = 1.0; t <= len - 0.3 + 1e-6; t += 0.7) {
    const p = dockAt(t);
    const c = ctx.colliders?.add?.({ x: p.x, z: p.z, r: 1.0, y0: -6, y1: DECK_Y, tag: 'dock' });
    if (c) dockColliders.push(c);
  }
  function isOnDock(x, z, y) {
    const dx = x - D.x, dz = z - D.z;
    const t = dx * D.dirX + dz * D.dirZ, s = dx * perpX + dz * perpZ;
    if (t < 0.4 || t > len + 0.3 || Math.abs(s) > HALF_W + 0.15) return false;
    return y === undefined || y > DECK_Y - 0.35;
  }
  api.isOnDock = isOnDock;

  // ── Motorboat ───────────────────────────────────────────────────────────
  const heading = Math.atan2(-D.dirX, -D.dirZ); // bow out to sea (yaw convention: forward = (-sin h, -cos h))
  const boatHome = dockAt(BOAT_T, BOAT_SIDE);
  let boatParts = null;
  let mooring = null;
  const mooringPos = new Float32Array(12);
  try {
    boatParts = buildMotorboat(rand);
    const object = new THREE.Group();
    object.name = 'isle2-motorboat';
    object.rotation.order = 'YXZ';
    object.position.set(boatHome.x, 0.02, boatHome.z);
    object.rotation.y = heading;
    const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, flatShading: true, side: THREE.DoubleSide });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfd6e2, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.35, depthWrite: false });
    const add = (geo, mat, name, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.name = 'isle2-motorboat-' + name;
      m.castShadow = cast;
      m.receiveShadow = true;
      object.add(m);
    };
    add(boatParts.hull, hullMat, 'hull');
    add(boatParts.trim, woodMat, 'trim');
    add(boatParts.glass, glassMat, 'glass', false);
    group.add(object);
    api.motorboat = { object, position: object.position, heading, moored: true, type: 'motorboat', name: "the fisherman's motorboat" };
    // mooring lines from the cleats to two bollards
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(mooringPos, 3).setUsage(THREE.DynamicDrawUsage));
    mooring = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xb59c6a }));
    mooring.frustumCulled = false;
    mooring.name = 'isle2-mooring';
    group.add(mooring);
  } catch (e) {
    console.error('[isle2] motorboat failed', e);
  }
  const bollardTop = (b) => dockAt(b.t, b.z, new THREE.Vector3(), DECK_Y + 0.55);
  const moorA = bollards[1] ? bollardTop(bollards[1]) : dock.end.clone();
  const moorB = bollards[2] ? bollardTop(bollards[2]) : dock.end.clone();

  // ── Hut, fishing, rockfall ──────────────────────────────────────────────
  try {
    hut = createHut(ctx, { group, rand: ctx.rng.fork('isle2-hut'), fx });
    api.hut = hut;
  } catch (e) {
    console.error('[isle2] hut failed', e);
  }
  try {
    fishing = createFishing(ctx, { group, rand: ctx.rng.fork('isle2-fishing'), isOnDock });
    api.fishing = fishing;
  } catch (e) {
    console.error('[isle2] fishing failed', e);
  }
  try {
    rockfall = createRockfall(ctx, { group, rand: ctx.rng.fork('isle2-rockfall'), fx, isIndoors: (p) => api.isIndoors(p) });
    api.rockfall = rockfall;
  } catch (e) {
    console.error('[isle2] rockfall failed', e);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────
  const seen = { dock: false, hut: false, isle: false };
  let T = 0, stormT = 0, storm = 0, seenT = 0;
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();

  function init() {
    hut?.init();
    fishing?.init();
  }

  function updateBoat(dt) {
    const mb = api.motorboat;
    if (!mb) return;
    if (mooring) mooring.visible = !!mb.moored;
    if (!mb.moored) return; // Builder C owns it now: never write to it again
    stormT -= dt;
    if (stormT <= 0) {
      stormT = 0.5;
      storm = Math.min(1, Math.max(0, ctx.weather?.stormAt?.(mb.position.x, mb.position.z) ?? 0));
    }
    const o = mb.object;
    const k = 1 + storm * 4;
    o.position.y = 0.02 + Math.sin(T * 1.1) * 0.04 * k + Math.sin(T * 2.7 + 1.3) * 0.015 * k;
    o.rotation.y = mb.heading;
    o.rotation.x = Math.sin(T * 0.9) * 0.015 * k;
    o.rotation.z = Math.sin(T * 1.3 + 1) * 0.025 * k;
    if (mooring && boatParts) {
      o.updateMatrixWorld();
      _a.copy(boatParts.cleatBow).applyMatrix4(o.matrixWorld);
      _b.copy(boatParts.cleatStern).applyMatrix4(o.matrixWorld);
      mooringPos[0] = _a.x; mooringPos[1] = _a.y; mooringPos[2] = _a.z;
      mooringPos[3] = moorA.x; mooringPos[4] = moorA.y; mooringPos[5] = moorA.z;
      mooringPos[6] = _b.x; mooringPos[7] = _b.y; mooringPos[8] = _b.z;
      mooringPos[9] = moorB.x; mooringPos[10] = moorB.y; mooringPos[11] = moorB.z;
      mooring.geometry.attributes.position.needsUpdate = true;
    }
  }

  function updateDiscovery(dt) {
    seenT -= dt;
    if (seenT > 0 || ctx.state !== 'playing') return;
    seenT = 0.5;
    const p = ctx.player?.position;
    if (!p) return;
    if (!seen.isle && W.islandAt?.(p.x, p.z) === 'isle2' && !ctx.player.aboard) {
      seen.isle = true;
      ctx.ui?.toast?.('Tempest Isle. The wind never quite stops here.', { icon: '🏝️', kind: 'story', duration: 4 });
    }
    if (!seen.dock && Math.hypot(p.x - dock.end.x, p.z - dock.end.z) < 12 && api.motorboat?.moored) {
      seen.dock = true;
      ctx.ui?.toast?.('A motorboat, tied up at the end of the pier! No key in the ignition, though.', { icon: '🚤', kind: 'story', duration: 5 });
      ctx.ui?.hint?.('isle2-key', 'Whoever owns that boat probably keeps the key somewhere up the mountain.');
    }
    if (!seen.hut && hut && Math.hypot(p.x - hut.frame.x, p.z - hut.frame.z) < 15 && Math.abs(p.y - hut.floorY) < 6) {
      seen.hut = true;
      const night = (ctx.time?.daylight ?? 1) < 0.4;
      ctx.ui?.toast?.(night ? "A fisherman's hut… and the lantern inside is still lit." : "A fisherman's hut, battered by the wind. Nobody answers.", { icon: '🛖', kind: 'story', duration: 4.5 });
    }
  }

  function update(dt) {
    T += dt;
    try {
      updateBoat(dt);
    } catch (e) {
      console.error('[isle2] boat', e);
    }
    hut?.update(dt);
    fishing?.update(dt);
    rockfall?.update(dt);
    updateDiscovery(dt);
    if (fx) {
      fx.smoke.update(dt);
      fx.embers.update(dt);
      fx.flames.commit();
    }
  }

  // ── Debug helpers (window.__game.isle2.debug) ───────────────────────────
  const tp = (x, z, yaw = 0) => ctx.player?.teleport?.(x, z, yaw);
  api.debug = {
    goDock: () => tp(dock.end.x - D.dirX * 3, dock.end.z - D.dirZ * 3, heading),
    goHut: () => hut && tp(hut.frame.x + hut.frame.fx * 4.5, hut.frame.z + hut.frame.fz * 4.5, Math.atan2(hut.frame.fx, hut.frame.fz)),
    burn: () => hut?.ignite(),
    rockfall: () => rockfall?.debugTrigger(),
    catch: () => fishing?.debugCatch(),
  };
  return api;
}
