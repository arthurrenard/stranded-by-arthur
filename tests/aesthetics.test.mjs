// V4-D aesthetics: pure palette / lighting checks (no GPU). Saturation is HSV saturation of sRGB values.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { terrainColor, hsvSat, PAL as TPAL } from '../src/world/fx/terrainColors.js';
import { PAL as FPAL } from '../src/nature/flora/palette.js';
import { makeSkyState, skyState } from '../src/world/fx/skyPalette.js';
import { createPost } from '../src/gfx/post.js';

const toS = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgb = (lin) => lin.map(toS);

// 1. terrain: every old key still exists; grass blend space stays muted (sat <= 0.45)
for (const k of 'sand sandDune wetSand grass grassLush grassDry meadow meadowGold forest forestLitter wetGrass mud highland pineFloor rock darkRock lightRock seabedShallow seabedMid seabedDeep lakebed lakebedDeep riverbed'.split(' ')) {
  assert.ok(Array.isArray(TPAL[k]) && TPAL[k].length === 3, `terrain PAL.${k} kept`);
}
for (const k of ['grass', 'grassLush', 'grassDry', 'grassSage', 'meadow', 'meadowGold', 'forest', 'wetGrass', 'damp', 'highland']) {
  assert.ok(hsvSat(TPAL[k]) <= 0.45, `terrain swatch ${k} sat ${hsvSat(TPAL[k]).toFixed(3)} <= 0.45`);
}
const out = [0, 0, 0];
let maxSat = 0;
for (const n0 of [-1, -0.5, 0, 0.5, 1])
  for (const n1 of [-1, 0, 1])
    for (const n2 of [-1, 0, 1])
      for (const sun of [-1, 0, 0.5, 1])
        for (const meadow of [0, 0.5, 1])
          for (const forest of [0, 1]) {
            const b = { h: 6, slope: 0.12, rn: 0.3, water: null, sand: 0, rock: 0, highland: 0, meadow, wet: 0, forest };
            terrainColor(b, n1, n2, 0.3, Infinity, out, { n0, sun, cav: 0 });
            for (const v of out) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, 'terrain color in range');
            maxSat = Math.max(maxSat, hsvSat(srgb(out)));
          }
assert.ok(maxSat <= 0.45, `grass blend max sat ${maxSat.toFixed(3)} <= 0.45`);
// back-compat: the 6-arg call still works; crevices are darker than ridges
const b0 = { h: 6, slope: 0.3, rn: 0.3, water: null, sand: 0, rock: 0, highland: 0, meadow: 0, wet: 0, forest: 0 };
const a6 = terrainColor(b0, 0, 0, 0, Infinity, [0, 0, 0]);
const gully = terrainColor(b0, 0, 0, 0, Infinity, [0, 0, 0], { n0: 0, sun: 0, cav: 1 });
const ridge = terrainColor(b0, 0, 0, 0, Infinity, [0, 0, 0], { n0: 0, sun: 0, cav: -1 });
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
assert.ok(lum(gully) < lum(a6) && lum(a6) < lum(ridge), 'concavity AO: gully < flat < ridge');

// 2. flora: every old key kept; foliage greens muted (birch autumn accent excepted)
for (const k of 'oakLeaf oakLeafLight oakLeafDark pine pineLight pineDark birchLeaf birchLeafLight palm palmDark willow willowDark appleLeaf apple appleBlush chestnutLeaf catkin sapling bark barkDark barkLight barkGrey birchBark birchMark palmTrunk palmTrunkDark coconut snag snagDark heartwood fungus fungusOrange rock rockLight rockDark moss fern fernLight bush bushLight blossomWhite blossomPink reed reedDry cattail lily lilyDark lotusPink lotusWhite grass meadow forestFloor dryGrass duneGrass'.split(' ')) {
  assert.ok(Array.isArray(FPAL[k]) && FPAL[k].length === 3, `flora PAL.${k} kept`);
}
assert.equal(FPAL.flowers.length, 7);
for (const k of ['oakLeaf', 'oakLeafLight', 'oakLeafDark', 'pine', 'pineLight', 'pineDark', 'birchLeaf', 'palm', 'palmDark', 'willow', 'willowDark', 'appleLeaf', 'chestnutLeaf', 'sapling', 'fern', 'bush', 'moss', 'grass', 'meadow']) {
  const s = hsvSat(srgb(FPAL[k]));
  assert.ok(s <= 0.55, `flora ${k} sat ${s.toFixed(3)} <= 0.55`);
}
assert.ok(lum(FPAL.bark) < lum(FPAL.birchBark) * 0.2, 'bark reads dark');

// 3. sky: finite everywhere, night fill floor kept, dimmer clear-day fill, warmer low sun
const st = makeSkyState();
for (let e = -1; e <= 1.0001; e += 0.05)
  for (const storm of [0, 1])
    for (const cloud of [0, 0.6, 1]) {
      skyState(e, -e, cloud, storm, storm, 0.7, st);
      for (const k of ['sunI', 'moonI', 'hemiI', 'ambI', 'fogDensity', 'starVis', 'sunsetAmt', 'cloudShadow', 'golden'])
        assert.ok(Number.isFinite(st[k]), `sky ${k} finite at e=${e.toFixed(2)}`);
      for (const f of ['zen', 'hor', 'glow', 'sun', 'cLit', 'cDark', 'hSky', 'hGnd', 'amb'])
        for (const v of st[f]) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1.0001, `sky ${f} in range`);
    }
skyState(-0.6, 0.5, 0.1, 0, 0, 1, st);
const nightHemi = st.hemiI;
assert.ok(nightHemi >= 0.8, `night hemiI ${nightHemi.toFixed(2)} >= 0.8 (navigable)`);
skyState(0.7, -0.5, 0.1, 0, 0, 1, st);
assert.ok(st.hemiI < nightHemi && st.hemiI >= 0.6, `clear-day hemiI ${st.hemiI.toFixed(2)} lower than night`);
const noonWarm = st.sun[2] / st.sun[0];
const noonI = st.sunI;
skyState(0.07, -0.5, 0.1, 0, 0, 1, st);
assert.ok(st.sun[2] / st.sun[0] < noonWarm - 0.2, 'golden-hour key light is warmer (more orange) than noon');
assert.ok(st.golden > 0.5, 'golden-hour boost active at low sun');
assert.ok(noonI > 2.5, 'noon sun intensity');

// 4. post overlay: skipped on the title screen, restores renderer state, nopost disables it
let calls = 0;
const info = { autoReset: true };
const renderer = { render() { calls++; }, autoClear: true, info, domElement: { clientWidth: 1600, clientHeight: 900 } };
const ctx = { THREE, renderer, scene: {}, camera: {}, state: 'title', uniforms: { uDaylight: { value: 1 } }, params: new URLSearchParams('') };
const post = createPost(ctx);
post.render();
assert.equal(calls, 1, 'title: plain render only');
ctx.state = 'playing';
post.render();
assert.equal(calls, 3, 'in game: scene + overlay');
assert.equal(renderer.autoClear, true);
assert.equal(info.autoReset, true);
post.enabled = false;
post.render();
assert.equal(calls, 4, 'disabled: plain render');
assert.equal(createPost({ ...ctx, params: new URLSearchParams('nopost') }).enabled, false, '?nopost');

console.log(`aesthetics ok (grass max sat ${maxSat.toFixed(3)}, night hemi ${nightHemi.toFixed(2)})`);
