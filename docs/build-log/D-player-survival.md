# Builder D: Player & Survival

Status: DONE (wave 1). The orchestrator verified it in the browser on 2026-11-06, since the builder was cut off before writing this log.

Files: src/player/controller.js, src/survival/stats.js, src/survival/model.js (pure math), tests/survival.test.mjs (passes).

## Verified with `__game.debug.step()`
- Walking covers ~4.0 m/s and sprinting ~7.5 m/s, matching CONFIG. Sprinting drains energy. Jumping works (+0.7 m at 0.25 s).
- Deep water (depth > 1.25) gives swimming = true, wetness 1 and energy drain of ~2.2/s. At 0 energy the head sinks,
  breath drains, then health drops (−33 over ~25 s).
- The start state is cold and wet, and the HUD shows "Chilly" plus shivering warnings.

## Known issues / TODO
- Energy regenerates while the player sinks, so they surface again: an endless sink/surface loop instead of real drowning.
  Planned fix: no energy regen in deep water.
