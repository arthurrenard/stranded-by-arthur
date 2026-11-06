// Fauna (Builder C) headless tests: habitat rasters, shader patches, and a full runtime simulation
// of every subsystem (create -> init -> hundreds of update frames at noon / dusk / midnight, sprinting
// through flocks) on the real heightfield. main.js swallows update errors, so this is the only place
// a silently dead subsystem would show up.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHeightfield } from '../src/world/heightfield.js';
import { createRng } from '../src/core/rng.js';
import { createEvents } from '../src/core/events.js';
import { buildHabitat, buildCoastRing, buildWaterEdges, patchFlap, pickEdgeNear } from '../src/nature/res/faunaShared.js';
import * as Fauna from '../src/nature/fauna.js';

const world = createHeightfield();
const L = world.landmarks;

// ── habitat rasters ─────────────────────────────────────────────────────
{
  const H = buildHabitat(world);
  const lake = world.lakes[0];
  assert.ok(H.sample(H.butterfly, L.meadow.x, L.meadow.z) > 0.6, 'meadow is butterfly habitat');
  assert.ok(H.sample(H.firefly, L.meadow.x, L.meadow.z) > 0.4, 'meadow has fireflies');
  assert.equal(H.sample(H.firefly, 0, 420), 0, 'no fireflies at sea');
  assert.equal(H.sample(H.butterfly, lake.x, lake.z), 0, 'no butterflies spawn on the lake');
  // a lake-shore point has strong firefly weight
  let best = 0;
  for (let a = 0; a < Math.PI * 2; a += 0.2) {
    const x = lake.x + Math.cos(a) * (lake.waterRadius + 4), z = lake.z + Math.sin(a) * (lake.waterRadius + 4);
    best = Math.max(best, H.sample(H.firefly, x, z));
  }
  assert.ok(best > 0.6, 'lake shore is firefly habitat');
  const out = { x: 0, z: 0, w: 0 };
  let hits = 0;
  const rand = createRng(5);
  for (let i = 0; i < 200; i++) if (H.pick(H.butterfly, rand, L.meadow.x, L.meadow.z, 0, 40, 8, out)) hits++;
  assert.ok(hits > 150, 'picking butterfly spots in the meadow succeeds');

  const ring = buildCoastRing(world);
  assert.equal(ring.length, 72);
  for (const c of ring) {
    assert.ok(Math.hypot(c.x, c.z) > 150 && Math.hypot(c.x, c.z) < 372, 'coast ring point near the coastline');
    assert.ok(world.heightAt(c.x, c.z) > 0.2);
  }
  assert.ok(ring.filter((c) => c.landOk).length > 50, 'most coast points have a beach landing spot');

  const edges = buildWaterEdges(world, createRng(3));
  assert.ok(edges.filter((e) => e.waterId === 'lake').length > 40, 'lake edges');
  assert.ok(edges.filter((e) => e.waterId === 'pond').length > 8, 'pond edges');
  assert.ok(edges.filter((e) => e.waterId === 'river').length > 20, 'river edges');
  for (const e of edges) assert.ok(Number.isFinite(e.surface) && Math.abs(e.y - e.surface) < 1.2, 'edge sits by the water surface');
  const e = pickEdgeNear(edges, createRng(9), L.pond.x, L.pond.z, 30);
  assert.ok(e && e.waterId === 'pond', 'pickEdgeNear finds the pond');
}

// ── shader patches really inject (a mismatched chunk name would silently no-op) ──
{
  const m = patchFlap(new THREE.MeshLambertMaterial({ vertexColors: true }), 'test', { glow: 0.2 });
  const lib = THREE.ShaderLib.lambert;
  const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} };
  m.onBeforeCompile(shader);
  assert.ok(shader.vertexShader.includes('attribute vec3 aFlap'), 'flap pars injected');
  assert.ok(shader.vertexShader.includes('fauna-flap: rotate wing normals'), 'flap normal injected');
  assert.ok(shader.vertexShader.includes('fauna-flap: fold'), 'flap position injected');
  assert.ok(shader.fragmentShader.includes('fauna-glow'), 'glow injected');
  assert.equal(m.customProgramCacheKey(), 'fauna-flap-test');
}

// ── runtime simulation ──────────────────────────────────────────────────
function makeCtx() {
  const time = { daylight: 1, hour: 12, hoursTotal: 12, isNight: false };
  const audioCalls = [];
  const ctx = {
    THREE,
    world,
    rng: createRng(20261106),
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(72, 16 / 9, 0.1, 2600),
    events: createEvents(),
    time,
    uniforms: {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector2(1, 0.3).normalize() },
      uWindStrength: { value: 0.35 },
      uDaylight: { value: 1 },
      uRain: { value: 0 },
    },
    flags: { cinematic: false, torchLit: false },
    state: 'playing',
    heatSources: new Set(),
    player: { position: new THREE.Vector3(L.meadow.x, world.heightAt(L.meadow.x, L.meadow.z), L.meadow.z), sprinting: false, moving: true },
    audio: { play: (name, opts) => audioCalls.push({ name, opts }) },
    resources: { kinds: { yarrow: { iy: 0.35, instances: [] }, chamomile: { iy: 0.16, instances: [] } } },
  };
  // a few fake meadow flowers for butterflies to land on
  const fr = createRng(11);
  for (let i = 0; i < 60; i++) {
    const x = L.meadow.x + (fr() - 0.5) * 60, z = L.meadow.z + (fr() - 0.5) * 60;
    ctx.resources.kinds.yarrow.instances.push({ x, z, y: world.heightAt(x, z), harvestedAt: -1, kind: { iy: 0.35 } });
  }
  return { ctx, audioCalls };
}

function setHour(ctx, h) {
  ctx.time.hour = h;
  // simple daylight curve (matches the clock's dawn ~5-7, dusk ~18-20)
  const d = h < 5 || h > 20 ? 0 : h < 7 ? (h - 5) / 2 : h > 18 ? (20 - h) / 2 : 1;
  ctx.time.daylight = d;
  ctx.time.isNight = d < 0.2;
  ctx.uniforms.uDaylight.value = d;
}

function checkMatrices(mesh, label) {
  const a = mesh.instanceMatrix?.array;
  if (!a) return;
  for (let i = 0; i < a.length; i++) assert.ok(Number.isFinite(a[i]), `${label}: finite instance matrix`);
}

function simulate(ctx, api, frames, dt = 1 / 60, each = null) {
  let ms = 0;
  for (let i = 0; i < frames; i++) {
    ctx.uniforms.uTime.value += dt;
    each?.(i);
    const t0 = performance.now();
    api.update(dt);
    ms += performance.now() - t0;
  }
  return ms / frames;
}

{
  const { ctx, audioCalls } = makeCtx();
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  const api = Fauna.create(ctx);
  assert.equal(typeof api.init, 'function');
  assert.equal(typeof api.update, 'function');
  const tInit = performance.now();
  api.init();
  const initMs = performance.now() - tInit;
  ctx.fauna = api;

  // noon in the meadow
  setHour(ctx, 12);
  const noonMs = simulate(ctx, api, 600);
  const noon = api.counts();
  assert.ok(noon.butterflies >= 15, `butterflies in the meadow at noon (${noon.butterflies})`);

  // midnight at the lake shore
  const lake = world.lakes[0];
  const sx = lake.x + lake.waterRadius + 3, sz = lake.z;
  ctx.player.position.set(sx, world.heightAt(sx, sz), sz);
  setHour(ctx, 0.5);
  ctx.heatSources.add({ position: new THREE.Vector3(sx + 3, world.heightAt(sx + 3, sz), sz), radius: 7, warmth: 1, kind: 'campfire' });
  const nightMs = simulate(ctx, api, 900);
  const night = api.counts();
  assert.ok(night.fireflies >= 250, `fireflies at night by the lake (${night.fireflies})`);
  const ff = api.group.getObjectByName('fireflies');
  assert.ok(ff && ff.visible, 'fireflies visible at night');
  assert.ok(ff.material.uniforms.uNight.value > 0.9, 'fireflies fully faded in');
  assert.ok(ff.material.fog === true && ff.material.fragmentShader.includes('fog_pars_fragment'), 'fireflies fog-aware');
  const pos = ff.geometry.attributes.position.array;
  for (let i = 0; i < pos.length; i++) assert.ok(Number.isFinite(pos[i]), 'finite firefly positions');

  // walk across the island at night (recycling), then back to day
  const nightWalkMs = simulate(ctx, api, 600, 1 / 60, (i) => ctx.player.position.set(sx + i * 0.12, world.heightAt(sx + i * 0.12, sz), sz));
  setHour(ctx, 12);
  simulate(ctx, api, 120);
  assert.equal(ff.visible, false, 'fireflies hidden by day');

  // daytime at the lake shore: dragonflies, fish, lilies open
  setHour(ctx, 11);
  ctx.player.position.set(sx, world.heightAt(sx, sz), sz);
  const lakeMs = simulate(ctx, api, 600);
  const lakeDay = api.counts();
  assert.ok(lakeDay.water.dragonflies >= 8, `dragonflies over the lake by day (${lakeDay.water.dragonflies})`);
  const fish = api.group.getObjectByName('fish');
  let fishIn = 0;
  for (let i = 0; i < fish.count; i++) {
    const m = new THREE.Matrix4();
    fish.getMatrixAt(i, m);
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    if (m.elements[0] === 0 && m.elements[5] === 0) continue;
    const w = world.waterAt(p.x, p.z);
    assert.ok(w && w.fresh, 'fish stay in the water');
    fishIn++;
  }
  assert.ok(fishIn >= 16, `lake fish drawn (${fishIn})`);

  // birds: wait for a songbird flock to land, then sprint at it -> it flushes
  ctx.player.position.set(L.meadow.x, world.heightAt(L.meadow.x, L.meadow.z), L.meadow.z);
  simulate(ctx, api, 2);
  let grounded = null;
  for (let i = 0; i < 60 * 120 && !grounded; i++) {
    ctx.uniforms.uTime.value += 1 / 30;
    api.update(1 / 30);
    grounded = api.debug('birds').find((f) => f.kind === 'song' && f.state === 'ground');
  }
  assert.ok(grounded, 'a songbird flock lands to forage');
  const before = audioCalls.length;
  ctx.player.sprinting = true;
  ctx.player.position.set(grounded.x + 10, world.heightAt(grounded.x + 10, grounded.z), grounded.z);
  simulate(ctx, api, 3);
  const after = api.debug('birds').filter((f) => f.kind === 'song');
  assert.ok(after.some((f) => f.state === 'flush' || f.state === 'air'), 'sprinting near the flock flushes it');
  assert.ok(audioCalls.slice(before).some((c) => c.name === 'birds_flush'), 'flush sound');
  ctx.player.sprinting = false;

  // frogs: walk up to one at night -> it leaps into the water with a splash
  setHour(ctx, 23);
  const frogs = api.debug('water').frogs;
  const fg = frogs.find((g) => !g.pad) ?? frogs[0];
  ctx.player.position.set(fg.x + 12, world.heightAt(fg.x + 12, fg.z), fg.z);
  simulate(ctx, api, 30);
  const before2 = audioCalls.length;
  ctx.player.position.set(fg.x + 1, world.heightAt(fg.x + 1, fg.z), fg.z);
  simulate(ctx, api, 60);
  assert.ok(audioCalls.slice(before2).some((c) => c.name === 'splash'), 'frog leaps into the water');
  simulate(ctx, api, 900); // croaking chorus
  assert.ok(audioCalls.some((c) => c.name === 'frog' && c.opts?.position?.isVector3), 'frogs croak at night with a position');

  // title state: fauna anchors at the spawn beach, no player reactions
  ctx.state = 'title';
  simulate(ctx, api, 60);
  ctx.state = 'playing';

  for (const o of api.group.children) checkMatrices(o, o.name);
  console.error = origError;
  assert.deepEqual(errors, [], 'no subsystem errors:\n' + errors.join('\n'));
  console.log(
    `fauna ok: init ${initMs.toFixed(0)} ms, update noon ${noonMs.toFixed(3)} ms, night ${nightMs.toFixed(3)} ms, ` +
      `night walk ${nightWalkMs.toFixed(3)} ms, lake day ${lakeMs.toFixed(3)} ms; counts noon ${JSON.stringify(noon)} night ${JSON.stringify(night)}; ` +
      `audio ${audioCalls.length} calls`
  );
  assert.ok(noonMs < 0.8 && nightMs < 0.8 && lakeMs < 0.8, 'fauna update stays cheap');
}
