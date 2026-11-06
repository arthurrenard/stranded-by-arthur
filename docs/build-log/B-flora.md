# Builder B — Flora (build log, continuation run, IN PROGRESS)

## Done
- `src/nature/flora/palette.js`, `builder.js`, `species.js` (previous run): colors, GeoBuilder primitives, species generators + `buildLibrary(rng)`.
- `src/nature/flora/placement.js`: `placeTrees(world, rng, lib)` → `{ trees, boulders, zones }`, `placeUndergrowth(...)`, `makeZones(world)`, `findClearings(...)`.
  ~3450 trees (oak ~1040, birch ~810, pine ~450, chestnut ~350, apple ~255, palm ~250, snag ~220, willow ~75), ~195 boulders,
  ~13.5k undergrowth items (ferns, bushes, flowers, reeds, lilies, rocks). Carved oak at `landmarks.carvedTree` with `special:'carvedTree'`.
- `src/nature/flora/canopy.js`: `CanopyIndex` (canopyAt, nearestTree, treesNear) on two spatial hashes.
- `src/nature/flora/bake.js`: `ChunkBaker` merges variants into one geometry per 64 m chunk (compact attributes), `hideRange`, `variantGeometry`.
- `src/nature/flora/materials.js`: Lambert + onBeforeCompile wind (world-space, works merged/instanced/props), leaf translucency, flower bloom, grass, depth material.

## Decision: merged chunks instead of InstancedMesh per (variant, chunk)
A node count gave ~1600 non-empty (variant, chunk) groups for trees and ~1500 for undergrowth, which is far over the SPEC §9
budget of ~250 draw calls. Static flora is therefore baked into one merged mesh per 64 m chunk: one draw per chunk, still frustum-culled.
Dynamic things (grass patch, saplings) use InstancedMesh.

- `src/nature/flora/grass.js`: `GrassPatch` (toroidal 11x11 grid of 8 m cells, 72 tufts/cell, lazy biome cache, InstancedMesh).
- `src/nature/flora/falling.js`: `FallingTrees` (wind-weighted schedule, creak, rod physics + bounce, puff, damage, log colliders, gather, decay).
- `src/nature/flora/growth.js`: `Saplings` (2 InstancedMeshes, growth from hoursTotal every 0.3 s, new sprouts, sprout where logs decay).
- `src/nature/flora.js`: entry; create() fills trees/colliders/canopy, bakes chunks (try/catch), wires grass/saplings/falling.
- `tests/flora.test.mjs` (+ `tests/flora-smoke.mjs` fake ctx): placement rules, canopy, colliders, fall lifecycle, damage, growth. PASSING.

## Left
- ambient.js (drifting leaves / pollen), GLSL review, final polish.
