// Builder B (flora) tests: placement rules + a full create/init/update smoke run with a fake ctx (no WebGL).
// Run: node tests/flora.test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeCtx } from './flora-smoke.mjs';
import { create } from '../src/nature/flora.js';

const t0 = performance.now();
const { ctx, registered, log, time } = makeCtx();
const W = ctx.world;
const L = W.landmarks;
const S = L.spawn;
const flora = create(ctx);
ctx.flora = flora;
const createMs = performance.now() - t0;
const trees = flora.trees;
const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// ── trees[] contract ─────────────────────────────────────────────────────
assert.ok(Array.isArray(trees) && trees.length >= 2500 && trees.length <= 4200, `tree budget (${trees.length})`);
const TYPES = ['oak', 'pine', 'birch', 'palm', 'willow', 'apple', 'chestnut', 'snag'];
for (const t of trees) {
  for (const k of ['x', 'z', 'y', 'height', 'trunkR', 'crownR']) assert.ok(Number.isFinite(t[k]), `tree.${k} finite`);
  assert.ok(TYPES.includes(t.type), 'tree type ' + t.type);
  assert.equal(typeof t.alive, 'boolean');
}
const count = (type) => trees.filter((t) => t.type === type).length;
assert.ok(count('apple') >= 25, 'apple trees >= 25');
assert.ok(count('chestnut') >= 25, 'chestnut trees >= 25');
assert.ok(count('palm') >= 120, 'plenty of palms');
for (const type of TYPES) assert.ok(trees.some((t) => t.type === type && d(t, S) < 150), `${type} within 150 m of spawn`);
assert.ok(trees.some((t) => t.type === 'palm' && d(t, S) < 60 && (!L.crate1 || d(t, L.crate1) > 6)), 'palm near the spawn beach');

// ── keep-clear rules ─────────────────────────────────────────────────────
for (const t of trees) {
  const b = W.biomeAt(t.x, t.z);
  assert.ok(!W.waterAt(t.x, t.z), 'no tree in water');
  if (t.type !== 'palm') assert.ok(b.sand <= 0.3, 'only palms on beaches');
  else assert.ok(b.sand > 0.3, 'palms on sand');
  const rv = W.riverAt(t.x, t.z);
  assert.ok(!rv || rv.d >= rv.w + 1.2, 'no tree on the river bank');
  if (t.special) continue;
  assert.ok(d(t, S) >= 8, 'spawn clear (8 m)');
  for (const k of ['crate1', 'crate2', 'castawayCamp', 'bottleBeach']) if (L[k]) assert.ok(d(t, L[k]) >= 6, `${k} clear`);
  assert.ok(d(t, L.summit) >= L.summit.r + 4, 'summit plateau clear');
  assert.ok(d(t, L.meadow) >= L.meadow.r * 0.6, 'meadow core clear');
  if (L.bambooGrove) assert.ok(d(t, L.bambooGrove) >= L.bambooGrove.r + 3, 'bamboo grove clear');
  assert.ok(d(t, L.carvedTree) >= 7.5, 'carved oak stands alone');
}
// carved oak
const carved = trees.find((t) => t.special === 'carvedTree');
assert.ok(carved, 'carved tree exists');
assert.equal(carved.x, L.carvedTree.x);
assert.equal(carved.z, L.carvedTree.z);
assert.equal(carved.type, 'oak');
assert.ok(carved.trunkR > 0.8 && carved.carve && carved.carve.y1 > carved.carve.y0, 'carved trunk data');
assert.ok(flora.carvedTree?.mesh, 'carved oak mesh');

// ── colliders ────────────────────────────────────────────────────────────
const cs = ctx.colliders.query(carved.x, carved.z, 0.5);
assert.ok(cs.some((c) => c.tag === 'tree' && c.data === carved), 'trunk collider');
assert.ok(flora.boulders.length > 80, 'boulders placed');
const bo = flora.boulders[0];
assert.ok(ctx.colliders.query(bo.x, bo.z, 0.1).some((c) => c.tag === 'boulder' && c.y1 === bo.top), 'boulder collider with y1 = top');

// ── canopy / nearestTree ─────────────────────────────────────────────────
assert.ok(flora.canopyAt(S.x, S.z) < 0.2, 'open sky on the spawn beach');
assert.ok(flora.canopyAt(carved.x, carved.z) > 0.6, 'shade under the carved oak');
assert.equal(flora.canopyAt(900, 900), 0, 'no canopy at sea');
let rs = 1;
for (let i = 0; i < 4000; i++) {
  rs = (rs * 16807) % 2147483647;
  const x = ((rs / 2147483647) - 0.5) * 680;
  rs = (rs * 16807) % 2147483647;
  const z = ((rs / 2147483647) - 0.5) * 680;
  const c = flora.canopyAt(x, z);
  assert.ok(c >= 0 && c <= 1, 'canopy in 0..1');
}
const palm = flora.nearestTree(S.x, S.z, 80, (t) => t.type === 'palm');
assert.ok(palm && palm.type === 'palm', 'nearestTree with filter');
assert.equal(flora.nearestTree(900, 900, 20), null, 'nearestTree null when none');

// ── rendering objects exist (no GPU needed) ──────────────────────────────
const meshes = [];
flora.group.traverse((o) => o.isMesh && meshes.push(o));
assert.ok(meshes.length > 60 && meshes.length < 260, `chunk meshes within the draw budget (${meshes.length})`);
assert.ok(flora.group.getObjectByName('flora-grass'), 'grass patch');

// ── lifecycle smoke: init + updates ──────────────────────────────────────
flora.init();
ctx.player.position.set(L.meadow.x + 30, W.heightAt(L.meadow.x + 30, L.meadow.z), L.meadow.z);
for (let i = 0; i < 2000; i++) {
  ctx.uniforms.uTime.value += 0.016;
  time.advance(0.016 * time.hoursPerSec);
  flora.update(0.016);
}
assert.ok(flora.saplings.length >= 30, 'saplings planted');
time.jump(0); // dtHours = 0 from here: only explicit falls

// ── falling tree: creak -> fall -> impact -> gather -> decay ─────────────
const before = log.audio.length;
const ft = flora.debugFell();
assert.ok(ft, 'debugFell found a tree');
assert.equal(ft.standing, false);
assert.equal(ft.alive, false);
assert.ok(!ctx.colliders.query(ft.x, ft.z, 0.05).some((c) => c.tag === 'tree' && c.data === ft), 'trunk collider removed');
assert.ok(log.audio.slice(before).some((a) => a.name === 'tree_creak' && a.opts?.position?.isVector3), 'creak with Vector3 position');
let fellEvent = null;
ctx.events.on('tree:fell', (e) => (fellEvent = e));
for (let i = 0; i < 60 * 12 && !fellEvent; i++) flora.update(1 / 60);
assert.ok(fellEvent && fellEvent.position?.isVector3, 'tree:fell emitted');
assert.ok(log.audio.some((a) => a.name === 'tree_crash'), 'crash sound');
for (let i = 0; i < 120; i++) flora.update(1 / 60);
assert.equal(flora.fallen[0].phase, 'lying', 'settled on the ground');
const h = registered.find((r) => r.label === 'Gather wood from fallen tree' && !r.removed);
assert.ok(h && h.radius >= 4, 'gather interactable registered');
let harvest = null;
ctx.events.on('harvest', (e) => (harvest = e));
h.onUse(ctx, h);
assert.deepEqual(log.inv.at(-1), { id: 'wood', n: 4 });
assert.deepEqual(harvest, { id: 'wood', n: 4, kind: 'fallenTree' });
assert.ok(h.removed, 'interactable removed after gathering');
for (let i = 0; i < 60 * 4; i++) flora.update(1 / 60);
assert.equal(flora.fallen.length, 0, 'gathered log faded away');

// natural decay of an ungathered log after ~1.5 days
const ft2 = flora.debugFell();
assert.ok(ft2, 'second fell');
for (let i = 0; i < 60 * 12; i++) flora.update(1 / 60);
time.jump(40);
flora.update(0.016);
assert.equal(flora.fallen.length, 0, 'log decayed after ~1.5 in-game days');

// damage when standing in the fall zone: fell a tree, then stand on its fall line before impact
const ft3 = flora.debugFell();
assert.ok(ft3, 'third fell');
const dmgBefore = log.damage.length;
const pivot = flora.group.children.filter((o) => o.name === 'flora-falling-tree').at(-1);
for (let i = 0; i < 60 * 12 && flora.fallen.at(-1)?.phase !== 'lying'; i++) {
  // the pivot's local +Y axis points along the fall once it tilts: stand ~40 % along it
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(pivot.quaternion);
  const l = Math.hypot(up.x, up.z);
  if (l > 1e-3) {
    const x = ft3.x + (up.x / l) * ft3.height * 0.4, z = ft3.z + (up.z / l) * ft3.height * 0.4;
    ctx.player.position.set(x, W.heightAt(x, z), z);
  }
  flora.update(1 / 60);
}
assert.ok(log.damage.length > dmgBefore && log.damage.at(-1).n === 30 && log.damage.at(-1).cause === 'tree', 'crushed in the fall zone');

// scheduled falls happen over in-game hours when trees are near
const nFallen0 = log.audio.filter((a) => a.name === 'tree_creak').length;
for (let i = 0; i < 4000; i++) {
  time.advance(0.004); // ~16 in-game hours total
  flora.update(0.016);
}
time.jump(0);
const nFallen1 = log.audio.filter((a) => a.name === 'tree_creak').length;
assert.ok(nFallen1 > nFallen0, 'scheduled falls occur');

// growth: saplings get bigger over time
const sp = flora.saplings[0];
const s0 = sp.lastS;
time.jump(30);
for (let i = 0; i < 30; i++) flora.update(0.05);
assert.ok(sp.lastS >= s0, 'sapling grows');

console.log(`flora tests passed: ${trees.length} trees (${TYPES.map((t) => t + ' ' + count(t)).join(', ')}), ` +
  `${flora.boulders.length} boulders, ${flora.undergrowthCount} undergrowth, ${meshes.length} meshes, ` +
  `${flora.saplings.length} saplings, create ${createMs.toFixed(0)} ms`);
