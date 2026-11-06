# Builder C (continuation) — Fauna (build log)

STATUS: IN PROGRESS. If this line is still here, the run was interrupted; resume from "Left".

Design: fauna.js is a thin orchestrator; one creature system per helper under src/nature/res/,
each `(ctx, shared) -> { object, init(), update(dt, frame) }`.
- res/faunaShared.js   habitat rasters (8 m grid baked at init), coast ring, water edges, flap shader patch, utils
- res/faunaMeshes.js   procedural geometries (butterfly, bird, dragonfly, fish, frog, lily pad/flower, ripple)
- res/faunaFireflies.js  Points + custom additive ShaderMaterial (fog-aware), recycled around the player
- res/faunaButterflies.js butterflies (day, meadows, rest on yarrow/chamomile) + moths at fires (night)
- res/faunaBirds.js    flocks (swifts high, songbirds low + foraging), gulls (coast), bats (dusk); scatter
- res/faunaWater.js    dragonflies, fish shadows, lily pads + flowers, frogs (croak), ripple rings

Done:
- res/faunaShared.js (habitat rasters bake in ~17 ms, coast ring 72 pts, 164 water edges, patchFlap, playSound)
- res/faunaMeshes.js (all geometries build, no NaN)
- res/faunaFireflies.js (380 Points, additive fog-aware ShaderMaterial, shader-side drift/blink, recycling)
- res/faunaButterflies.js (44 butterflies + 10 moths at heat sources, one InstancedMesh, flap patch)
- fauna.js orchestrator (focus, jump detection, per-subsystem error isolation, counts())
- tests/fauna.test.mjs (habitat, shader patch injection, runtime sim noon/midnight/walk; passes)
- res/faunaBirds.js (swift/song/gull/hawk/bat flocks: air->descend->ground->flush state machine, scatter on sprint)
- res/faunaWater.js (130 lily pads + 26 lilies, 21 fish shadows, 14 dragonflies, 29 frogs w/ croak + splash, ripple pool)

Left: extend test (dragonflies by day at the lake, bird flush on sprint, frog leap), polish pass, final report
