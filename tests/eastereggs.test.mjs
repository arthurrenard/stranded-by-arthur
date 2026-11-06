// Unit tests for src/story/eggLogic.js + a headless smoke test that finds all 7 easter eggs through
// src/story/eastereggs.js with stubbed systems. Run: node tests/eastereggs.test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { createHeightfield } from '../src/world/heightfield.js';
import * as L from '../src/story/eggLogic.js';
import { createCarving } from '../src/story/eggCarving.js';
import * as EE from '../src/story/eastereggs.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}`);
    throw e;
  }
}

// ── Pure logic ───────────────────────────────────────────────────────────
test('eggs list', () => {
  assert.equal(L.EGG_TOTAL, 7);
  assert.equal(new Set(L.EGGS.map((e) => e.id)).size, 7);
  assert.equal(L.eggName('duck'), 'Rubber Duck');
});

test('konami: exact sequence matches once, then resets', () => {
  const m = L.createSequenceMatcher();
  const hits = L.KONAMI.map((c) => m.push(c));
  assert.deepEqual(hits, [...Array(9).fill(false), true]);
  assert.equal(m.progress, 0);
  assert.equal(L.KONAMI.map((c) => m.push(c)).filter(Boolean).length, 1, 'completes a second time');
});

test('konami: overlapping prefix (↑↑↑↓↓…) and junk keys', () => {
  const m = L.createSequenceMatcher();
  const seq = ['KeyW', 'ArrowUp', 'ArrowUp', 'ArrowUp', ...L.KONAMI.slice(2)];
  const hits = seq.map((c) => m.push(c));
  assert.equal(hits.at(-1), true);
  assert.equal(hits.filter(Boolean).length, 1);
  const m2 = L.createSequenceMatcher();
  const broken = [...L.KONAMI.slice(0, 5), 'KeyX', ...L.KONAMI.slice(5)];
  assert.equal(broken.map((c) => m2.push(c)).some(Boolean), false, 'a junk key in the middle breaks it');
  // ↑↑↓↓←→←→B then a fresh full code
  const m3 = L.createSequenceMatcher();
  assert.equal([...L.KONAMI.slice(0, 9), ...L.KONAMI].map((c) => m3.push(c)).filter(Boolean).length, 1);
});

test('hour windows with wraparound', () => {
  assert.equal(L.inNightWindow(22), true);
  assert.equal(L.inNightWindow(21.99), false);
  assert.equal(L.inNightWindow(23.9), true);
  assert.equal(L.inNightWindow(0), true);
  assert.equal(L.inNightWindow(2.99), true);
  assert.equal(L.inNightWindow(3), false);
  assert.equal(L.inNightWindow(12), false);
  assert.equal(L.inNightWindow(24), true, '24 == midnight');
  assert.equal(L.inDawnWindow(5.49), false);
  assert.equal(L.inDawnWindow(5.5), true);
  assert.equal(L.inDawnWindow(7.99), true);
  assert.equal(L.inDawnWindow(8), false);
  assert.equal(L.inHourWindow(10, 9, 11), true);
  assert.equal(L.inHourWindow(11, 9, 11), false);
});

test('nightKey: one id per night across midnight', () => {
  assert.equal(L.nightKey(4, 22), 4);
  assert.equal(L.nightKey(5, 2.9), 4);
  assert.equal(L.nightKey(5, 0), 4);
  assert.equal(L.nightKey(5, 3), null);
  assert.equal(L.nightKey(4, 21.99), null);
  assert.equal(L.nightKey(5, 22), 5);
  assert.notEqual(L.nightKey(5, 23), L.nightKey(5, 1));
});

test('mirror, anchors, envelope', () => {
  assert.deepEqual(L.mirrorThrough(-51, -46, -60, -40), { x: -69, z: -34 });
  const a = L.butterflyAnchor(3, 30, 140, 16), b = L.butterflyAnchor(3, 30, 140, 16), c = L.butterflyAnchor(4, 30, 140, 16);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (let d = 1; d < 60; d++) {
    const p = L.butterflyAnchor(d, 30, 140, 16);
    assert.ok(Math.hypot(p.x - 30, p.z - 140) <= 16 + 1e-9);
  }
  assert.equal(L.envelope(0, 60), 0);
  assert.equal(L.envelope(30, 60), 1);
  assert.equal(L.envelope(60, 60), 0);
  assert.ok(Math.abs(L.envelope(2, 60, 4, 6) - 0.5) < 1e-9);
  assert.ok(Math.abs(L.envelope(57, 60, 4, 6) - 0.5) < 1e-9);
});

test('carving cylinder reads left-to-right, upright', () => {
  const { mesh, texture } = createCarving({ radius: 0.6, height: 0.6, arc: 1.45 });
  assert.equal(texture, null, 'no DOM in node');
  const pos = mesh.geometry.attributes.position, uv = mesh.geometry.attributes.uv;
  let left = null, right = null, top = null;
  for (let i = 0; i < pos.count; i++) {
    if (uv.getX(i) === 0) left = pos.getX(i);
    if (uv.getX(i) === 1) right = pos.getX(i);
    if (uv.getY(i) === 1) top = pos.getY(i);
    assert.ok(pos.getZ(i) > 0, 'centered on +Z');
  }
  assert.ok(left < 0 && right > 0, 'u grows toward the viewer\'s right (viewer on +Z)');
  assert.ok(top > 0, 'v = 1 at the top');
});

// ── Headless smoke test: find all 7 eggs ─────────────────────────────────
const world = createHeightfield();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1.6, 0.1, 2600);
scene.add(camera);
const log = { toasts: [], subs: [], journal: [], events: [], sounds: [], effects: [], adds: [], hints: [], colliders: [] };
let simT = 0;
let keyFn = null;
const handles = [];
const LM = world.landmarks;
const ctx = {
  THREE,
  config: CONFIG,
  scene,
  camera,
  state: 'playing',
  world,
  flags: { cinematic: false, sleeping: false, gravityScale: 1, blessed: false },
  time: { day: 1, hour: 12, daylight: 1 },
  player: { position: new THREE.Vector3(0, 0, 0) },
  events: { emit: (n, p) => log.events.push([n, p]), on: () => () => {} },
  ui: {
    toast: (t, o) => log.toasts.push(t),
    subtitle: (t) => log.subs.push(t),
    markJournal: (id, d) => log.journal.push([id, d]),
    hint: (id) => log.hints.push(id),
  },
  audio: { play: (name, o) => log.sounds.push({ name, t: simT, o }) },
  stats: { values: { health: 50, energy: 20 }, applyEffects: (fx) => log.effects.push(fx) },
  inventory: { add: (id, n) => (log.adds.push([id, n]), n) },
  input: { onKeyDown: (fn) => ((keyFn = fn), () => (keyFn = null)) },
  colliders: { add: (c) => (log.colliders.push(c), c), remove: (c) => log.colliders.splice(log.colliders.indexOf(c), 1) },
  interact: {
    register(o) {
      o.removed = false;
      o.remove = () => (o.removed = true);
      o.moves = 0;
      o.moveTo = (x, y, z) => (o.moves++, o.position.set(x, y, z));
      handles.push(o);
      return o;
    },
  },
  flora: { trees: [{ special: 'carvedTree', x: LM.carvedTree.x, z: LM.carvedTree.z, y: world.heightAt(LM.carvedTree.x, LM.carvedTree.z), trunkR: 0.6 }] },
};
const label = (h) => (typeof h.label === 'function' ? h.label(ctx, h) : h.label);
const use = (re) => {
  const h = handles.find((k) => re.test(label(k)));
  assert.ok(h, `interactable ${re}`);
  h.onUse(ctx, h);
  return h;
};
const step = (seconds, dt = 1 / 30) => {
  for (let t = 0; t < seconds; t += dt) {
    simT += dt;
    ee.update(dt);
  }
};

const ee = EE.create(ctx);
test('init builds the eggs', () => {
  ee.init();
  assert.equal(ee.total, 7);
  assert.equal(ee.found.size, 0);
  assert.equal(handles.length, 6, 'bottle, volleyball, note, tally, carving, duck');
  assert.ok(log.colliders.length >= 3 + 8, 'camp + 7 stones + altar');
  assert.equal(typeof keyFn, 'function');
  assert.ok(scene.getObjectByName('eastereggs'));
  step(0.1);
});

test('bottle + camp', () => {
  use(/Read the message/);
  assert.ok(ee.found.has('bottle'));
  assert.equal(label(handles[0]), 'Read the message again');
  step(18);
  assert.ok(log.subs.length >= 3, 'note subtitles played in sequence');
  use(/Say hello to the volleyball/);
  assert.ok(ee.found.has('camp'));
  use(/Pat the volleyball/);
  assert.deepEqual(log.adds, [['rope', 2]], 'rope given exactly once');
  use(/Read the pinned note/);
  use(/Count the marks/);
  assert.ok(log.journal.some(([id]) => id === 'note:castaway'));
});

test('carving (only from the lake side)', () => {
  const h = handles.find((k) => label(k) === 'Read the carving');
  const T = LM.carvedTree, lake = world.lakes[0];
  ctx.player.position.set(T.x + Math.sign(lake.x - T.x) * 2, 0, T.z);
  assert.equal(h.enabled(ctx, h), true);
  ctx.player.position.set(T.x - Math.sign(lake.x - T.x) * 2, 0, T.z);
  assert.equal(h.enabled(ctx, h), false);
  h.onUse(ctx, h);
  assert.ok(ee.found.has('carving'));
});

test('duck quacks back 1.2 s later from across the lake (pause-safe)', () => {
  const h = handles.find((k) => label(k) === 'Squeeze the rubber duck');
  const lake = world.lakes[0];
  assert.ok(Math.abs(h.position.y - lake.level) < 0.5, 'floats at the lake surface, not the bed');
  const p0 = h.position.clone();
  step(3);
  assert.ok(h.moves > 0 && h.position.distanceTo(p0) > 0.01, 'drifts and moves its interactable');
  const n0 = log.sounds.filter((s) => s.name === 'quack').length;
  const t0 = simT;
  h.onUse(ctx, h);
  const dpos = h.position.clone();
  ctx.state = 'paused';
  step(2);
  assert.equal(log.sounds.filter((s) => s.name === 'quack').length, n0 + 1, 'echo waits while paused');
  ctx.state = 'playing';
  step(1.4);
  const q = log.sounds.filter((s) => s.name === 'quack').slice(n0);
  assert.equal(q.length, 2);
  const playDelay = q[1].t - t0 - 2; // minus the paused time
  assert.ok(Math.abs(playDelay - 1.2) < 0.1, `echo delay ${playDelay}`);
  const e = q[1].o.position;
  assert.ok(Math.abs(e.x - (2 * lake.x - dpos.x)) < 0.01 && Math.abs(e.z - (2 * lake.z - dpos.z)) < 0.01, 'mirrored through the lake center');
  assert.ok(ee.found.has('duck'));
});

test('konami -> moon gravity for 60 s', () => {
  ctx.player.position.set(0, world.heightAt(0, 0), 0);
  for (const c of ['KeyW', 'ArrowUp', 'ArrowUp', 'ArrowUp', ...L.KONAMI.slice(2)]) keyFn(c);
  assert.equal(ctx.flags.gravityScale, 0.3);
  assert.ok(ee.found.has('konami'));
  step(59);
  assert.equal(ctx.flags.gravityScale, 0.3);
  step(1.5);
  assert.equal(ctx.flags.gravityScale, 1);
  ctx.state = 'title';
  for (const c of L.KONAMI) keyFn(c);
  assert.equal(ctx.flags.gravityScale, 1, 'ignored outside playing');
  ctx.state = 'playing';
});

test('stone circle at night: once per night, effects', () => {
  const S = LM.summit;
  ctx.time.hour = 23;
  ctx.time.daylight = 0;
  ctx.player.position.set(S.x + 1, world.heightAt(S.x, S.z), S.z + 1);
  step(0.1);
  assert.ok(ee.found.has('circle'));
  assert.deepEqual(log.effects, [{ energy: 80, health: 15 }]);
  assert.ok(log.toasts.includes('The island seems to watch over you.'));
  step(66);
  const lines = scene.getObjectsByProperty('type', 'LineSegments');
  assert.ok(lines.length === 1 && lines[0].visible === false, 'meteors hidden after the shower');
  ctx.time.day = 2;
  ctx.time.hour = 1; // same night (started on day 1)
  step(1);
  assert.equal(log.effects.length, 1, 'once per night');
  ctx.time.hour = 23; // next night
  step(0.1);
  assert.equal(log.effects.length, 2, 'again the next night');
  step(66);
  ctx.time.hour = 12;
  ctx.time.daylight = 1;
});

test('golden butterfly at dawn lands on your hand -> blessed', () => {
  ctx.time.day = 3;
  ctx.time.hour = 6;
  ctx.time.daylight = 0.5;
  ctx.player.position.set(0, 0, 0);
  step(0.2);
  const g = scene.getObjectByName('golden-butterfly');
  assert.ok(g && g.visible, 'visible at dawn');
  assert.ok(Math.hypot(g.position.x - LM.meadow.x, g.position.z - LM.meadow.z) < 24, 'in the meadow');
  ctx.player.position.set(g.position.x + 0.5, g.position.y - 1.1, g.position.z);
  step(0.8);
  step(1.0);
  assert.equal(g.parent, camera.children[0], 'perched on the hand');
  const w = g.getWorldPosition(new THREE.Vector3()); // camera at the origin looking down -Z
  assert.ok(w.z < -0.6 && w.z > -1.3 && Math.abs(w.x) < 0.5 && w.y < 0 && w.y > -0.6, `in view: ${w.toArray().map((v) => v.toFixed(2))}`);
  assert.ok(camera.children.length === 1, 'arm on the camera');
  assert.ok(!ctx.flags.blessed);
  step(4);
  assert.ok(ctx.flags.blessed, 'blessed after perching');
  assert.ok(ee.found.has('butterfly'));
  assert.ok(log.toasts.includes('You feel lucky.'));
  step(3);
  assert.equal(g.visible, false);
  assert.equal(camera.children[0].visible, false, 'arm lowered');
  ctx.time.day = 4;
  step(0.5);
  assert.equal(g.visible, false, 'gone for good once found');
});

test('all 7 found, events + journal', () => {
  assert.equal(ee.found.size, 7);
  const ev = log.events.filter(([n]) => n === 'easter:found').map(([, p]) => p);
  assert.equal(ev.length, 7);
  assert.deepEqual(ev.map((p) => p.found), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(ev.every((p) => p.total === 7 && p.name && typeof p.text === 'string'));
  const eggJ = log.journal.filter(([id]) => id.startsWith('egg:')).map(([id]) => id.slice(4));
  assert.deepEqual(new Set(eggJ), new Set(L.EGGS.map((e) => e.id)));
  assert.ok(log.sounds.filter((s) => s.name === 'chime').length >= 7);
  for (const v of [ctx.camera.position]) assert.ok(Number.isFinite(v.x));
  ee.dispose();
  assert.ok(handles.every((h) => h.removed));
  assert.equal(log.colliders.length, 0);
  assert.equal(scene.getObjectByName('eastereggs'), undefined);
});

console.log(`eastereggs: ${passed} tests passed`);
