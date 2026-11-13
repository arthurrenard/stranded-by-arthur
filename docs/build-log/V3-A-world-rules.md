# V3-A world+rules build log

Scope (SPEC §11): terrain.js, water.js, sky.js, weather.js (+world/fx/*), structures.js (storm douse only),
rescue.js / rescueLogic.js (+tests/rescue.test.mjs), nature/res/treeHarvest.js.

## Done
1. **terrain.js**: `colorize(geo, wild)` shared by both grids; Tempest Isle = second mesh `terrain-isle2`
   (`buildGeometry('isle2')`, same material/program, receiveShadow). Wild palette: dark wet rock on cliffs,
   grey-olive wind-swept grass with long streaks along a prevailing gale, slightly duller sand. API + `mesh2`, `meshes`.
   +74k triangles (37k verts), mostly sea floor.
2. **water** (via fx/shared.js): the baked height texture spans the union of both grids (561x553 texels @2.5 m,
   x -500..900, z -880..500). Grid vertices are copied exactly (max in the overlap), the open sea comes from
   heightAt. `heightXform` is now (sx, ox, sz, oz) and `HEIGHT_GLSL` uses both offsets; `sampleHeightData` uses
   the bake extents. Shallows, shore foam, wave damping and the abyss color work around Tempest Isle; every
   lake in `world.lakes` (incl. `isle2pond`) was already rendered, and the pond now samples correct depths.
   water.js itself is unchanged.
3. **sky.js + fx/fogChunks.js**: three's fog chunks are patched at import (re-centered on `ctx.world.isle2` in
   create, before any compile): exp² density x (1 - 0.25 x alt) with alt = smoothstep(6, 55, camera y), plus a
   far haze (exponent 1.3 x (1 - alt) x smoothstep(280, 600, depth)) only for fragments > 400 m from the main
   center and within ~420-760 m of the isle (new `vFogXZ` varying). Clear day from launchBeach: 80/84/85/87 %
   at 550/650/680(peak)/750 m; summit -> peak (806 m) 37 %; every main-island fragment and the rest of the
   sea are exactly the old exp² curve. Rain wipes it out. Near the isle in its storm: horizon/zenith lerp to
   dark slate and fog density +0.0026 x local (on top of the folded rain/storm haze). `sky.localStorm`.
4. **weather.js + fx/isle2Storm.js (pure) + fx/hail.js**: half-day rolls (seed ^ 0x7e57, k = floor((h-6)/12)),
   1-4 h windows inside the half-day (0.25 h lead, 1 h tail), peak 0.8..1, linear real-second ramp
   (stormRampSec, x timeScale, snaps on time:skip / time:set). `stormAt`, `hailAt` (smoothstep 0.55..0.85 of
   the local storm), `isle2Storm {active, intensity, endsAtHours}`, events `isle2:stormStart {intensity,
   endsAtHours}` / `isle2:stormEnd`, `isIndoors(pos)`, `hailExposed`, `hailMesh`, `debugIsle2Storm(on, hours)`,
   `forecast().isle2StormInHours`, `rainAt(x, z)` / `baseRain` (positional rain: island-wide rain + the local
   storm there). Folded at the camera: rain, storm, cloudiness, wind strength (up to ~1.5
   with gusts), airTempOffset (-2.5 °C x hail), kind, uRain. Lightning inside: 0.4x interval, 140-1000 m away.
   From afar (storm > 0.5, camera outside): bolts over the isle every 5-13 s + faint delayed rumbles.
   Hail: 260 instanced pellets (20 tris) that bounce twice and melt, hidden indoors/underwater, fewer under
   canopy. Damage when exposed, batched into ~1.2 hp `ctx.stats.damage(.., 'hail')` hits (damage() flashes
   + plays 'hurt' per call), toast "Hail! Get indoors!" every 25 s. Warning toast within 750 m at stormStart,
   "breaks" toast at stormEnd.
5. **structures.js**: `galeAt(pos)` (stormAt, 0 when indoors) sampled with the env refresh (fires ~1 s, torch
   0.5 s; re-sampled right after lighting). > 0.55: `extinguish(s, 'gale')` / `setTorch(false, 'gale')` with
   "The gale blows your fire out!". Fire rain exposure now uses `ctx.weather.rainAt(firePos)` (so a main-island
   fire isn't drowned while the player stands in the isle storm); the torch keeps camera rain.
6. **rescue**: `attentionRate(..., mul)`, `flareSpots(d, range)` (0 = never), `difficultyRescue(diff)`,
   `passCloseness(c, mul)` (hard -> 0: ~450 m away), `difficultyHint(mul)`, `missHint({flareRange})`.
   rescue.js reads ctx.difficulty per pass. Hard: no miss hints, one-time "wrong stretch of sea" toast after
   the first pass; Medium: one-time haze hint at the first pass start. Flare-miss toast adapts on hard.
   Medium balance (sim): waving alone never; signal fire + waving on passes with closeness >= 0.5 always.
7. **treeHarvest.js**: palm def `bonk: true`; each shake (while playing) rolls CONFIG.palmDeathChance first:
   'land' thud (vol 1.2), white flash, subtitle "Bonk.", event `palm:bonk`, then 0.45 s later (waits out a
   pause) `ctx.stats.damage(1e4, 'coconut')`. God mode: bonk, no death. The 30 % coconut drop is unchanged.

## Tests
- tests/isle2-storm.test.mjs (new, 10): schedule, falloff (main island land >= 599 m > stormOuter), hail/ramp,
  fog numbers, two-island bake, weather integration (forced storm, fold-in, hail damage/indoors, main island
  untouched, scheduled storms), palm bonk.
- tests/rescue.test.mjs: +7 difficulty tests (28 total).

## Left / notes
- GLSL of the patched fog chunks is not compile-checked in node: verify in a browser (`?debug=1&skipintro=1`,
  `__game.weather.debugIsle2Storm(true)`, teleport to the cove).
- Terrain `uWet` (shared material) follows camera rain, so the main island looks wet for a while after sailing
  back from a storm (cosmetic).
- main.js's ctx.debug has no isle2 storm shortcut (not my file): use `__game.weather.debugIsle2Storm(true)`.
