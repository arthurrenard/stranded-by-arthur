// V4-E perf: pure LOD / quality math (src/gfx/quality.js) + the low-detail tree library (species.js).
import assert from 'node:assert/strict';
import { pickLod, boxDist2D, presetFor, defaultLevel, createAdaptiveRes, QUALITY_PRESETS, QUALITY_LEVELS } from '../src/gfx/quality.js';
import { buildLibrary, buildLowLibrary } from '../src/nature/flora/species.js';
import { createRng } from '../src/core/rng.js';
import { CONFIG } from '../src/config.js';

// ── LOD selection with hysteresis ────────────────────────────────────────
assert.equal(pickLod(false, 50, 110), true, 'near chunk -> full');
assert.equal(pickLod(true, 200, 110), false, 'far chunk -> low');
assert.equal(pickLod(true, 113, 110), true, 'full stays full inside the band');
assert.equal(pickLod(false, 107, 110), false, 'low stays low inside the band');
assert.equal(pickLod(true, 116, 110), false, 'full -> low past D + hyst/2');
assert.equal(pickLod(false, 104, 110), true, 'low -> full under D - hyst/2');
{
  // walking back and forth across the edge never flickers each sample
  let full = true, flips = 0;
  for (let i = 0; i < 400; i++) {
    const d = 110 + Math.sin(i * 0.3) * 4; // +-4 m wobble around the edge
    const next = pickLod(full, d, 110, 10);
    if (next !== full) flips++;
    full = next;
  }
  assert.equal(flips, 0, 'no flicker inside the hysteresis band');
}
assert.equal(boxDist2D(0, 0, 64, 64, 32, 32), 0, 'inside the box');
assert.equal(boxDist2D(0, 0, 64, 64, 64 + 30, 32), 30, 'beside the box');
assert.ok(Math.abs(boxDist2D(0, 0, 64, 64, -3, -4) - 5) < 1e-9, 'corner distance');

// ── quality presets ──────────────────────────────────────────────────────
assert.deepEqual(QUALITY_LEVELS, ['low', 'medium', 'high']);
const mx = CONFIG.graphics.maxPixelRatio;
assert.equal(presetFor('low', 2).pixelRatio, 1);
assert.equal(presetFor('medium', 2).pixelRatio, Math.min(1.25, mx));
assert.equal(presetFor('high', 2).pixelRatio, Math.min(2, mx));
assert.equal(presetFor('high', 1).pixelRatio, 1, 'never above the screen dpr');
assert.equal(presetFor('medium', 1).pixelRatio, 1, 'medium never supersamples a 1x screen');
assert.deepEqual([presetFor('low').shadowMapSize, presetFor('medium').shadowMapSize, presetFor('high').shadowMapSize], [1024, 2048, 2048]);
assert.deepEqual([presetFor('low').lodDistance, presetFor('medium').lodDistance, presetFor('high').lodDistance], [70, 110, 150]);
assert.deepEqual([presetFor('low').grassScale, presetFor('medium').grassScale, presetFor('high').grassScale], [0.55, 0.8, 1]);
assert.equal(presetFor('bogus').level, 'high', 'unknown level falls back to high');
for (const l of QUALITY_LEVELS) assert.ok(QUALITY_PRESETS[l].underDistance <= 160 && QUALITY_PRESETS[l].grassDensity <= 1);
assert.equal(defaultLevel(16384, 8), 'high');
assert.equal(defaultLevel(4096, 8), 'medium', 'small max texture -> medium');
assert.equal(defaultLevel(16384, 4), 'medium', '4 threads -> medium');
assert.equal(defaultLevel(undefined, undefined), 'high');

// ── adaptive resolution controller ───────────────────────────────────────
{
  const run = (a, ms, seconds) => {
    let r = a.ratio;
    for (let t = 0; t < seconds * 1000; t += ms) r = a.step(ms);
    return r;
  };
  const a = createAdaptiveRes({ cap: 1.5 });
  assert.equal(run(a, 16.7, 10), 1.5, 'steady 60 fps keeps the cap');
  assert.equal(run(a, 30, 2.5), 1.5, 'not lowered before 3 s');
  const r1 = run(a, 30, 1.2);
  assert.ok(Math.abs(r1 - 1.35) < 1e-9, `lowered by 0.15 after 3 s slow (${r1})`);
  assert.ok(Math.abs(run(a, 30, 30) - 0.75) < 1e-9, 'floor 0.75');
  assert.equal(run(a, 30, 30), 0.75, 'stays at the floor');
  assert.equal(run(a, 400, 5), 0.75, 'hitches > 250 ms ignored');
  assert.equal(run(a, 16.7, 20), 0.75, '60 fps vsync (16.7 ms) is not "fast": no raise');
  const up = run(a, 8, 6.8);
  assert.ok(Math.abs(up - 0.9) < 1e-9, `raised by 0.15 after 6 s fast (${up})`);
  assert.ok(Math.abs(run(a, 8, 60) - 1.5) < 1e-9, 'back up to the cap, not beyond');
  // quality change: jumps to the new cap
  a.setCap(1);
  assert.equal(a.ratio, 1);
  assert.ok(Math.abs(run(a, 30, 3.6) - 0.85) < 1e-9, 'adapts from the new cap');
  // cap below the floor (low level on a 0.7 dpr screen) never goes lower than the cap
  const b = createAdaptiveRes({ cap: 0.7 });
  assert.equal(run(b, 40, 20), 0.7);
}

// ── low-detail tree library: same trees, far fewer triangles ─────────────
{
  const fork = () => createRng(CONFIG.seed).fork('flora').fork('lib');
  const lib = buildLibrary(fork());
  const low = buildLowLibrary(fork());
  let F = 0, L = 0;
  for (const key of Object.keys(low)) {
    assert.equal(low[key].length, lib[key].length, `${key}: same variant count`);
    low[key].forEach((V, i) => {
      const Fv = lib[key][i];
      F += Fv.nIdx / 3;
      L += V.nIdx / 3;
      assert.ok(V.nIdx < Fv.nIdx, `${key}[${i}] has fewer triangles`);
      // same tree: bounds within 20 % of the full variant's largest extent
      const bb = (P) => {
        const a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < P.length; k += 3) for (let j = 0; j < 3; j++) (a[j] = Math.min(a[j], P[k + j])), (b[j] = Math.max(b[j], P[k + j]));
        return [a, b];
      };
      const [a0, b0] = bb(Fv.pos), [a1, b1] = bb(V.pos);
      const size = Math.max(b0[0] - a0[0], b0[1] - a0[1], b0[2] - a0[2]);
      for (let j = 0; j < 3; j++) assert.ok(Math.abs(a0[j] - a1[j]) < size * 0.2 && Math.abs(b0[j] - b1[j]) < size * 0.2, `${key}[${i}] same bounds`);
      assert.ok(V.barkCount <= V.nIdx && V.leaf.length === V.nVerts, `${key}[${i}] valid layout`);
    });
  }
  for (const key of ['oak', 'chestnut', 'willow', 'apple']) {
    const f = lib[key].reduce((s, V) => s + V.nIdx, 0), l = low[key].reduce((s, V) => s + V.nIdx, 0);
    assert.ok(l / f < 0.4, `${key} low detail under 40 % (${((l / f) * 100).toFixed(0)} %)`);
  }
  // the full library is untouched by building the low one (rng streams are per-variant forks)
  const again = buildLibrary(fork());
  assert.deepEqual(Array.from(again.oak[0].pos.slice(0, 30)), Array.from(lib.oak[0].pos.slice(0, 30)), 'full library deterministic');
  console.log(`perf tests passed: low-detail trees ${(L / 1000).toFixed(1)}k / ${(F / 1000).toFixed(1)}k triangles per variant set (${((L / F) * 100).toFixed(0)} %)`);
}
