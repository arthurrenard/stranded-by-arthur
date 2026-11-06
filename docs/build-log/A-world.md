# Builder A — World (terrain, water, sky, weather)

Status: CONTINUATION RUN in progress (terrain + sky were finished by the first builder).

## Files
- src/world/terrain.js — DONE (first builder)
- src/world/sky.js — DONE (first builder). Reads ctx.weather.{cloudiness, rain, storm (0..1 number)}, exposes flash(), setUnderwater(), setFogDensity()
- src/world/fx/{glsl,shared,skyPalette,terrainColors}.js — DONE (first builder)
- src/world/fx/weatherModel.js — pure weather schedule (node-testable) — DONE (day 1: sunny morning, one shower ≥16:36; ~1.35 showers/day; 14 % storms from day 2)
- src/world/weather.js — DONE: auto/manual state machine, instanced rain streaks (GPU wrap), lightning bolt + sky flash + delayed thunder, primary+secondary rainbow, gusty wind → uWind/uWindStrength/uRain. Headless sim verified (storm preset, auto return, rainbow after intro storm).
- src/world/fx/waterWaves.js — wave model shared by GLSL + CPU — TODO
- src/world/water.js — ocean, lakes, river, underwater — TODO
- tests/world.test.mjs — TODO

## Plan notes
- weather.storm is a smoothed 0..1 number (sky.js lerps with it); truthy while stormy.
- water writes shared uTide / uWave each frame; overrides scene.fog after sky.update while underwater.
