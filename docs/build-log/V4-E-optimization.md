# V4-E — Optimization (tree LOD, shadow culling, quality levels)

Goal: same look up close, much cheaper far away. Baseline measured in the browser at the spawn looking north:
231 draw calls, 2.67 M triangles (trees ≈ 1.4 M in 71 calls, grass 305 k, terrain 320 k, undergrowth ≈ 170 k).

## Done

1. **Tree LOD** (`flora/builder.js`, `flora/species.js`, `flora.js`)
   - `withLowDetail(fn)` puts every GeoBuilder created inside it in low-detail mode: tubes/cones 7→4 / 5→3 / 4→3
     sides, long tubes drop every other inner ring, detail-1 blobs keep their 12 base icosahedron vertices with
     the detail-0 faces, fronds half the segments, willow strands one quad (every other one), fruit octahedra
     skipped. **Each primitive still makes exactly the same `rng()` / colorFn calls**, so a variant rebuilt
     from the same named fork is the same tree (same branches, blobs, colors), only coarser.
   - `buildLowLibrary(rng)` = the chunk-baked variants (8 tree species, wind pines, boulders) in low mode.
     The full library is byte-identical to before (sha1 of all variant arrays checked).
   - Per species low/full triangles: oak 31 %, chestnut 24 %, willow 23 %, apple 32 %, birch 41 %, palm 46 %,
     pine 60 %, wind pine 60 %, snag 72 %, boulder 25 %; weighted by placement ≈ 35 %.
   - flora bakes each chunk twice (second ChunkBaker, same keys) and keeps ONE mesh per chunk that swaps
     `geometry` (gFull / gLow) every 0.25 s (and right after a camera jump > 30 m): full when the chunk center is
     within `ctx.quality.lodDistance` (default 110 m) with 10 m hysteresis (`pickLod`). Same material + depth
     material, so wind sway is identical. Mesh count / draw calls unchanged (tests count meshes).
   - `retireTree` collapses both handles (`handle`, `handleLo`), so falling trees leave no ghost. Colliders,
     canopyAt, saplings, falling trees and treeHarvest use the tree entries / full library as before.
   - The first 2 updates skip the LOD pass so the full geometries get uploaded once and their CPU arrays released.
2. **Shadows**: only chunks whose box is within 1.5 × `CONFIG.graphics.shadowRange` (105 m) of the camera set
   `castShadow`; chunks beyond 420 m also stop receiving (receiveShadow is a uniform in three r187, no recompile).
3. **Grass + undergrowth**: `GrassPatch.setScale(radiusK, densityK)` rebuilds the instanced patch with 11/9/7
   cells per side and round(72·density) tuft slots (uniform subsample); flora calls it when
   `ctx.quality.grassScale/grassDensity` change. Undergrowth chunks hidden beyond `ctx.quality.underDistance`
   (160 m high, 145 medium, 125 low; was 170 m).
4. **`src/gfx/quality.js`** (new): presets low/medium/high (pixel-ratio cap 1 / 1.25 / min(dpr, maxPixelRatio),
   never above the screen dpr; shadow map 1024/2048/2048; LOD 70/110/150 m; grass radius 0.55/0.8/1, density
   0.7/0.85/1), adaptive resolution (smoothed frame time > 22 ms for 3 s → ratio −0.15, floor 0.75; < 14 ms for
   6 s → +0.15 up to the cap; only while playing and visible; re-asserted each frame), localStorage
   `stranded.quality`, default high / medium on weak GPUs, "Graphics" select appended to `#pause .options`.
   Shadow map size change disposes `sun.shadow.map` so three reallocates it. Getters: level, lodDistance,
   grassScale, grassDensity, underDistance, pixelRatio, stats. Emits `quality:change`.
   Wiring (orchestrator, main.js): `add('quality', Quality, { always: true })` before 'sky'.
5. **Fauna**: fauna.js puts the camera position in `frame` (camX/Y/Z, near2 = 150²). Butterflies/moths farther
   than 150 m are not drawn and the mesh is hidden (no upload) while none is live. Birds: hidden flocks zeroed
   once, flocks > 150 m refresh matrices every 3rd frame, mesh hidden while no flock is out (sim untouched, so
   relocation still works). Water: ripple / dragonfly meshes hidden while empty (ripple update skipped).
6. **tests/perf.test.mjs**: pickLod hysteresis (no flicker), boxDist2D, presets, defaultLevel, the adaptive
   controller (lower, floor, hitches ignored, raise to the cap, setCap), low library (fewer tris, same bounds,
   oak/chestnut/willow/apple < 40 %).

## Numbers (node, spawn, 113 tree chunks)

- Tree triangles in view: 1.79 M → 0.70 M at the default 110 m, ×0.39 (low 0.66 M, medium 0.68 M, high 0.75 M,
  ×0.37 / 0.38 / 0.42). Applied to the browser baseline: trees ≈ 1.4 M → ≈ 0.55 M (medium) / ≈ 0.6 M (high).
- Shadow pass (ortho 140 m box, far 700 m, center = spawn + 21 m forward; three already frustum-culls casters):
  high sun (0.4, 0.8, 0.3): 10 calls / 193 k tris → 10 / 146 k; low sun 15°: 18 / 294 k → 10 / 146 k.
  The castShadow cut only binds when the sun is low; the LOD makes the rest.
- Grass: 8712 instances (305 k tris) high, 4941 (≈ 173 k) medium, 2450 (≈ 86 k) low.
- Draw calls in the main pass: unchanged for trees (one per chunk); fewer shadow-pass calls; −1…3 fauna calls when empty.

## Known issues / notes

- On a 60 Hz display frames sit at ≈ 16.7 ms, so the "< 14 ms for 6 s" raise never fires: once the
  resolution was lowered it only comes back on a quality change (set() resets to the cap) or on a > 60 Hz display.
- Low quality uses LOD 70 m, so a few shadow-casting chunks (≤ 105 m) cast from the low-detail trees.
- GPU memory for trees ≈ 1.35 × before (both LODs resident).
- sky.js:268 sizes the stars with `uPixelRatio = min(devicePixelRatio, maxPixelRatio)` at init, so when the adaptive
  resolution lowers the ratio the stars are drawn slightly larger relative to the scene (not my file; harmless).
- Changing quality while paused applies pixel ratio + shadow map at once; tree LOD / grass / undergrowth follow on
  resume (flora doesn't update while frozen).
- Chunks never seen at the title screen upload their full geometry when first approached (small one-time upload).
- resources.js (bamboo) untouched: not in the measured budget. Fireflies unchanged (already local + GPU-animated).
