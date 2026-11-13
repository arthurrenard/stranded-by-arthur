// Fishing (V3-B). Vegetarian: the line only ever brings up junk and treasure, never a fish.
// With a fishing_rod, standing on the dock, a beach or a lakeshore and looking at water:
//   ocean → "[E] Cast the line" (beats "Drink seawater"); fresh water → "[R] Cast the line" when drinking doesn't
//   own the prompt (look further out), or E when the rod is the selected hotbar item.
// After 4–12 s a bite toast, then a catch from FISHING_LOOT (isle2-logic.js): ctx.inventory.add + 'harvest' {kind:'fishing'}.
// A float bobs where the line landed; a rod is held in view while fishing.
import * as THREE from 'three';
import { ITEMS } from '../core/items.js';
import { CAST_RANGE, biteDelay, rollCatch, BOTTLE_MESSAGES } from './isle2-logic.js';
import { buildFloat, Bag } from './isle2-models.js';

const SPOT_CACHE_S = 0.12;

export function createFishing(ctx, { group, rand, isOnDock }) {
  const W = ctx.world;
  const _cam = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _tip = new THREE.Vector3();
  const spot = { ok: false, x: 0, z: 0, surface: 0, fresh: false, t: 0 };
  let spotAge = 1;
  let active = null; // { x, z, surface, t, wait, phase: 'fly'|'wait'|'bite', fromX, fromZ, biteT }
  let msgIndex = 0;
  let lastCastAt = -10, clock = 0;

  // ── meshes: float, line, held rod ──
  const floatMesh = new THREE.Mesh(buildFloat(rand), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true }));
  floatMesh.name = 'isle2-fishing-float';
  floatMesh.visible = false;
  group.add(floatMesh);
  const lineGeo = new THREE.BufferGeometry();
  const linePos = new Float32Array(6);
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
  const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xe8e8e0, transparent: true, opacity: 0.55 }));
  line.frustumCulled = false;
  line.visible = false;
  line.name = 'isle2-fishing-line';
  group.add(line);
  const rodBag = new Bag(rand);
  rodBag.cyl(0.006, 0.016, 1.3, 5, 0, 0.65, 0, 0x6a4a2a);
  rodBag.cyl(0.03, 0.03, 0.05, 8, 0.03, 0.18, 0, 0x9a9da3, 0, 0, Math.PI / 2);
  const rod = new THREE.Mesh(rodBag.build(), floatMesh.material);
  rod.name = 'isle2-held-rod';
  rod.position.set(0.32, -0.42, -0.55);
  rod.rotation.set(-1.0, 0.15, -0.25);
  rod.visible = false;
  rod.frustumCulled = false;
  const rodTip = new THREE.Object3D();
  rodTip.position.set(0, 1.3, 0);
  rod.add(rodTip);
  ctx.camera?.add?.(rod);

  /** Where a cast from the current view would land (cached briefly). */
  function findSpot() {
    if (spotAge < SPOT_CACHE_S) return spot.ok ? spot : null;
    spotAge = 0;
    spot.ok = false;
    ctx.camera.getWorldPosition(_cam);
    ctx.camera.getWorldDirection(_dir);
    if (_dir.y > 0.06) return null;
    const [r0, r1] = CAST_RANGE;
    if (_dir.y < -0.03) {
      for (let t = r0; t <= r1; t += 0.5) {
        const x = _cam.x + _dir.x * t, y = _cam.y + _dir.y * t, z = _cam.z + _dir.z * t;
        if (W.heightAt(x, z) > y) return null; // the ray hits the ground first
        const w = W.waterAt(x, z);
        if (w && y <= w.surface + 0.2) return setSpot(x, z, w);
      }
    }
    // near-horizontal: lob it ~9 m ahead
    const hl = Math.hypot(_dir.x, _dir.z) || 1;
    const x = _cam.x + (_dir.x / hl) * 9, z = _cam.z + (_dir.z / hl) * 9;
    const w = W.waterAt(x, z);
    if (w && _cam.y - w.surface < 6) return setSpot(x, z, w);
    return null;
  }
  function setSpot(x, z, w) {
    if (!(w.depth > 0.4)) return null;
    spot.ok = true;
    spot.x = x;
    spot.z = z;
    spot.surface = w.surface;
    spot.fresh = !!w.fresh;
    return spot;
  }
  /** On the dock, a beach, a lakeshore or a river bank (not in the water, not aboard). */
  function standingOk(p) {
    const pl = ctx.player;
    if (pl.swimming || pl.inWater || pl.aboard || pl.diving || pl.headUnderwater) return false;
    if (isOnDock?.(p.x, p.z, p.y)) return true;
    const b = W.biomeAt(p.x, p.z);
    if (b.sand > 0.3) return true;
    if ((W.coastDistance?.(p.x, p.z) ?? 99) < 7) return true;
    for (const l of W.lakes || []) if (Math.hypot(p.x - l.x, p.z - l.z) < (l.waterRadius ?? l.r) + 7) return true;
    const rv = W.riverAt?.(p.x, p.z);
    return !!rv && rv.d < rv.w + 5;
  }

  function provider(c) {
    if (c.state !== 'playing' || c.flags?.cinematic) return null;
    if (active) {
      return { label: active.phase === 'bite' ? 'Reel in!' : 'Reel in the line', onUse: reel, score: 2.5 };
    }
    if (!c.inventory?.has?.('fishing_rod')) return null;
    const p = c.player?.position;
    if (!p) return null;
    const s = findSpot();
    if (!s || !standingOk(p)) return null;
    const selected = c.inventory.selected === 'fishing_rod';
    if (s.fresh && !selected) return { label: '', secondary: { label: 'Cast the line', onUse: cast }, score: 0.5 };
    return { label: 'Cast the line', onUse: cast, score: selected ? 1.6 : 0.65 };
  }

  function cast() {
    if (active || clock - lastCastAt < 0.6) return;
    const s = findSpot();
    const p = ctx.player?.position;
    if (!s || !p) return;
    lastCastAt = clock;
    active = { x: s.x, z: s.z, surface: s.surface, t: 0, wait: biteDelay(rand()), phase: 'fly', fromX: p.x, fromZ: p.z, biteT: 0 };
    rod.visible = true;
    floatMesh.visible = true;
    line.visible = true;
    ctx.audio?.play?.('craft', { volume: 0.4 });
    ctx.ui?.toast?.('You cast the line… wait for a bite.', { icon: '🎣', duration: 2.5, key: 'fishing' });
  }
  function stop() {
    active = null;
    rod.visible = false;
    floatMesh.visible = false;
    line.visible = false;
  }
  function reel() {
    if (!active) return;
    if (active.phase === 'bite') return land();
    stop();
    ctx.ui?.toast?.('You reel in the line. Nothing on the hook.', { icon: '🎣', duration: 2, key: 'fishing' });
  }
  function land() {
    const e = rollCatch(rand());
    const id = e.item || e.id;
    const n = e.n[0] + Math.floor(rand() * (e.n[1] - e.n[0] + 1));
    const pos = active ? new THREE.Vector3(active.x, active.surface, active.z) : null;
    stop();
    const r = ctx.inventory?.add?.(id, n);
    const added = typeof r === 'number' ? Math.max(0, r) : n;
    if (added < n) {
      const p = ctx.player?.position;
      if (p) ctx.resources?.spawnItem?.(id, p.x + 0.6, p.z + 0.4, n - added);
    }
    if (pos) ctx.audio?.play?.('splash', { position: pos, volume: 0.5 }); // (the 'harvest' event plays the pickup sound)
    const nm = ITEMS[id]?.name ?? id;
    const icon = ITEMS[id]?.icon;
    if (e.id === 'old_boot') ctx.ui?.toast?.('You reel in… an old boot. Classic.', { icon, duration: 3 });
    else if (e.id === 'message') {
      const text = BOTTLE_MESSAGES[msgIndex < BOTTLE_MESSAGES.length ? msgIndex : Math.floor(rand() * BOTTLE_MESSAGES.length)];
      msgIndex++;
      ctx.ui?.toast?.('A message in a bottle!', { icon: '📜', kind: 'story', duration: 3 });
      if (ctx.ui?.subtitle) ctx.ui.subtitle(text, 9);
      else ctx.ui?.toast?.(text, { icon: '📜', kind: 'story', duration: 9 });
    } else if (id === 'hull_plank') ctx.ui?.toast?.('A hull plank from the Marguerite, snagged on your hook!', { icon, kind: 'good', duration: 3.5 });
    else ctx.ui?.toast?.(`You reel in: ${n > 1 ? n + ' × ' : ''}${nm}`, { icon, kind: 'good', duration: 2.5 });
    ctx.events?.emit?.('harvest', { id, n, kind: 'fishing' });
  }

  function update(dt) {
    clock += dt;
    spotAge += dt;
    if (!active) return;
    const p = ctx.player?.position;
    const playing = ctx.state === 'playing';
    if (!p || (playing && (ctx.player.swimming || ctx.player.inWater || ctx.player.aboard || Math.hypot(p.x - active.fromX, p.z - active.fromZ) > 3.5 || !ctx.inventory?.has?.('fishing_rod')))) {
      stop();
      return;
    }
    if (playing) {
      active.t += dt;
      if (active.phase === 'fly' && active.t > 0.6) {
        active.phase = 'wait';
        ctx.audio?.play?.('splash', { position: floatMesh.position, volume: 0.25 });
      } else if (active.phase === 'wait' && active.t > active.wait) {
        active.phase = 'bite';
        active.biteT = 0;
        ctx.ui?.toast?.('Something tugs at the line!', { icon: '🎣', kind: 'good', duration: 1.6, key: 'fishing' });
        ctx.audio?.play?.('splash', { position: floatMesh.position, volume: 0.45 });
      } else if (active.phase === 'bite') {
        active.biteT += dt;
        if (active.biteT > 1.1) return land();
      }
    }
    // float + line
    const T = clock;
    let fx = active.x, fy = active.surface + 0.02 + Math.sin(T * 2.3) * 0.02, fz = active.z;
    rodTip.getWorldPosition(_tip);
    if (active.phase === 'fly') {
      const k = Math.min(1, active.t / 0.6);
      fx = _tip.x + (active.x - _tip.x) * k;
      fz = _tip.z + (active.z - _tip.z) * k;
      fy = _tip.y + (active.surface - _tip.y) * k + Math.sin(k * Math.PI) * 1.2;
    } else if (active.phase === 'bite') fy = active.surface - 0.05 + Math.sin(T * 19) * 0.05;
    floatMesh.position.set(fx, fy, fz);
    linePos[0] = _tip.x;
    linePos[1] = _tip.y;
    linePos[2] = _tip.z;
    linePos[3] = fx;
    linePos[4] = fy + 0.1;
    linePos[5] = fz;
    lineGeo.attributes.position.needsUpdate = true;
  }

  return {
    init() {
      ctx.interact?.addProvider?.(provider);
    },
    update,
    provider,
    get active() {
      return active ? { phase: active.phase, x: active.x, z: active.z } : null;
    },
    /** Debug: land a catch now. */
    debugCatch() {
      active = active || { x: 0, z: 0, surface: 0, t: 0, wait: 0, phase: 'bite', fromX: 0, fromZ: 0, biteT: 0 };
      land();
    },
  };
}
