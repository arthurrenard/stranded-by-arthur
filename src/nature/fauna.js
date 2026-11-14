// Builder C — Fauna: purely decorative wildlife on Driftwood Isle (SPEC §6 C). Never hunted or eaten.
//
// Thin orchestrator. Each creature family lives in its own helper (src/nature/res/fauna*.js) as
// `(ctx, shared) -> { object, init(), update(dt, frame), count() }`:
//   faunaFireflies   night: a few hundred blinking additive Points near water / meadows / forest edges
//   faunaButterflies day: instanced flapping butterflies in meadows (rest on flowers); night: moths at fires
//   faunaBirds       day: high circling flocks, low songbird flocks that forage on the ground, gulls
//                    along the beaches, all scattering when the player sprints near; dusk: bats
//   faunaWater       dragonflies over fresh water (day), fish shadows in Mirror Lake + Spring Pond,
//                    lily pads + water lilies, frogs on pads / banks croaking at night, ripple rings
//
// Shared state baked once in init (faunaShared.js): habitat rasters (8 m), coast ring, water edges.
// Everything updates only around the "focus" (the player while playing, the spawn beach before), uses
// InstancedMesh / Points (≈10 draw calls total), and allocates nothing per frame.
// World animation runs in every state; reactions to the player only while playing (not in cinematics).
//
// Public API (ctx.fauna): { counts(), debug(name), group, init(), update(dt) }   (SPEC: {} + init/update)
import * as THREE from 'three';
import { buildHabitat, buildCoastRing, buildWaterEdges } from './res/faunaShared.js';
import { createFireflies } from './res/faunaFireflies.js';
import { createButterflies } from './res/faunaButterflies.js';
import { createBirds } from './res/faunaBirds.js';
import { createWaterLife } from './res/faunaWater.js';

const JUMP_DIST = 40; // focus moving farther than this in one frame = teleport -> re-seed everything
const NEAR_DIST = 150; // V4-E: butterflies / birds farther than this from the camera aren't drawn every frame

export function create(ctx) {
  const group = new THREE.Group();
  group.name = 'fauna';

  const shared = {
    habitat: null,
    ring: null,
    edges: null,
    focus: new THREE.Vector3(),
    rand: ctx.rng.fork('fauna'),
    geoRand: ctx.rng.fork('fauna-geo'),
  };
  // per-frame state handed to every subsystem (one object, mutated in place)
  const frame = {
    t: 0,
    daylight: 1,
    rain: 0,
    hour: 12,
    playing: false,
    px: 0,
    py: 0,
    pz: 0,
    sprinting: false,
    jumped: true,
    camX: 0, // camera world position (V4-E distance culling)
    camY: 0,
    camZ: 0,
    near2: NEAR_DIST * NEAR_DIST,
  };
  const camV = new THREE.Vector3();

  const factories = [
    ['fireflies', createFireflies],
    ['butterflies', createButterflies],
    ['birds', createBirds],
    ['water', createWaterLife],
  ];
  const systems = [];
  for (const [name, make] of factories) {
    try {
      const s = make(ctx, shared);
      const objs = Array.isArray(s.object) ? s.object : [s.object];
      for (const o of objs) if (o) group.add(o);
      systems.push({ name, s, errors: 0, ok: true });
    } catch (e) {
      console.error(`[fauna] ${name} create failed`, e);
    }
  }
  ctx.scene?.add(group);

  let lastX = NaN, lastZ = NaN;
  let forceJump = true;

  /** The point fauna lives around: the player while playing, the spawn beach before the game starts. */
  function updateFocus() {
    const st = ctx.state;
    const pre = st === 'loading' || st === 'title' || st === 'intro';
    const p = !pre ? ctx.player?.position : null;
    if (p && Number.isFinite(p.x)) shared.focus.copy(p);
    else {
      const L = ctx.world.landmarks?.spawn ?? { x: 0, z: 0 };
      shared.focus.set(L.x, ctx.world.heightAt(L.x, L.z), L.z);
    }
    const f = shared.focus;
    const moved = Number.isFinite(lastX) ? Math.hypot(f.x - lastX, f.z - lastZ) : Infinity;
    frame.jumped = forceJump || moved > JUMP_DIST;
    forceJump = false;
    lastX = f.x;
    lastZ = f.z;
  }

  function run(sys, fn) {
    if (!sys.ok) return;
    try {
      fn();
    } catch (e) {
      sys.errors++;
      if (sys.errors <= 3) console.error(`[fauna] ${sys.name} failed`, e);
      if (sys.errors > 30) sys.ok = false; // a broken subsystem must not spam every frame
    }
  }

  function init() {
    const W = ctx.world;
    shared.habitat = buildHabitat(W);
    shared.ring = buildCoastRing(W);
    shared.edges = buildWaterEdges(W, shared.rand);
    updateFocus();
    forceJump = true;
    for (const sys of systems) run(sys, () => sys.s.init?.());
    ctx.events?.on?.('time:skip', () => (forceJump = true));
    ctx.events?.on?.('game:start', () => (forceJump = true));
  }

  function update(dt) {
    if (!shared.habitat) return;
    updateFocus();
    frame.t += dt;
    frame.daylight = ctx.time?.daylight ?? 1;
    frame.hour = ctx.time?.hour ?? 12;
    frame.rain = ctx.weather?.rain ?? ctx.uniforms?.uRain?.value ?? 0;
    frame.playing = ctx.state === 'playing' && !ctx.flags?.cinematic;
    const P = ctx.player?.position;
    if (P) {
      frame.px = P.x;
      frame.py = P.y;
      frame.pz = P.z;
    } else {
      frame.px = shared.focus.x;
      frame.py = shared.focus.y;
      frame.pz = shared.focus.z;
    }
    frame.sprinting = !!ctx.player?.sprinting && ctx.player?.moving !== false;
    if (ctx.camera) ctx.camera.getWorldPosition(camV);
    else camV.copy(shared.focus);
    frame.camX = camV.x;
    frame.camY = camV.y;
    frame.camZ = camV.z;
    for (const sys of systems) run(sys, () => sys.s.update(dt, frame));
  }

  function counts() {
    const out = {};
    for (const sys of systems) {
      try {
        out[sys.name] = sys.s.count?.() ?? null;
      } catch (_) {
        out[sys.name] = 'error';
      }
      if (!sys.ok) out[sys.name] = 'disabled';
    }
    return out;
  }

  /** Debug introspection of one subsystem, e.g. __game.fauna.debug('birds'). */
  function debug(name) {
    const sys = systems.find((x) => x.name === name);
    return sys?.s.debug?.() ?? null;
  }

  return { group, counts, debug, init, update };
}
