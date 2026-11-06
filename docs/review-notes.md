# Orchestrator playtest notes (2026-11-06)

Verified in the browser (`?debug=1`, with `__game.debug.step()`):
- Boot: no errors, 3,448 trees (8 species), ~150 draw calls, ~1–2.7 M triangles, ~60 fps (M-series).
- Movement, sprint, jump, swim and drowning work. Drinking at the pond works (+12), as do filling the canteen, eating
  (grilled chanterelle +20 hunger), crafting (campfire, canteen, torch), lighting a fire, cooking and nearFire warmth.
- Night: fireflies, moths around the fire, stars and firelight look great.
- Intro: storm at sea, then the reef, then the dawn beach wake-up and the "Marguerite" subtitle, then playing. Works end to end.

## Issues to fix
1. FIXED (made more dangerous: sinkRegenPerSec 0.9 → 0.8, ~60 dmg per exhaustion, a second one kills). [D] Energy regenerates while the player is exhausted in deep water, so they sink and resurface forever instead of drowning.
   Fix: no energy regen while swimming.
2. FIXED (Light vs Relight via s.everLit). [E] A newly built campfire says "Relight the fire (1 wood)". It should say "Light the fire".
3. FIXED, real bug: makeCampfire never set the start fuel, so a new campfire died instantly; it now starts with campfireStartFuelHours. (The burn rate itself was fine.) [E] Campfire fuel seems to drain far too fast (−0.22 h of fuel in ~6.5 real s ≈ 0.054 game h, so ~4× too fast?). Check the units.
4. FIXED (water alpha now uses the optical path depth/V.y, and the wreck geometry is clipped below y=-2.5). [F/A] A pale rectangle on the water around the wreck at the waterline (a foam quad, or the intro sea mesh left visible?).
5. [main] The intro ended facing the wreck, then snapped north. FIXED: main keeps the camera's yaw after the intro.
6. Performance: up to 2.7 M triangles. Check the grass/flora LOD if fps is low on weaker machines.
7. FIXED: rain was chilling the air twice (model rainChill + weather airTempOffset); the model now takes the stronger of the two.
8. Verified balance: an idle player starts cold+wet (heat 28), is dry by ~8:00, comfortable by ~8:30 and warm by 14:00 in full sun;
   with no water they die on night 1 (thirst + cold), which is the intended survival pressure.
9. Verified the rescue (debug pass, waving on the beach → spotted → hover + ladder cutscene → win screen) and all 7 easter eggs.

## Contracts audit (wf_44063d94-85c, agent "contracts") — all 7 findings FIXED
- The helicopter/boat loop droned on while paused or with a menu open: audio.js now holds the loops at 0 while frozen.
- Every warning showed two toasts plus duplicate hints: stats.js owns the toasts and the HUD owns the hints.
- A gasp played on every surfacing: the unconditional auto-gasp is removed (stats.js gasps only when breath < 50).
- Rotor/engine loops were attenuated for distance twice: rescue.js now passes fades only and the panner handles distance.
- 'birds_flush' had no recipe: aliased to bird_trill (test updated).
- The HUD's red hurt flash overrode stats' colour-coded flashes for continuous damage: the HUD now skips those causes.
- Intro lightning ignored its strength, and stale thunder could follow the cut to the calm dawn: the strike passes strength/distance,
  and time:set clears pending thunder.
The requirements audit (the second agent) was interrupted by the session end; it was relaunched on its own.

## Requirements audit (wf_f1db6eae-c9a): every requirement implemented and reachable, no soft-locks
(Nearest to spawn: wood 4 m, stone 11 m, flint 35 m, fiber 35 m, leaves 47 m, pyrite 81 m, bamboo 219 m.)
- FIXED: sleeping by a fire used the bedtime fire warmth for the whole night even if it burned out. It now averages bedtime and wake-up.
- FIXED: the HUD's "You can sleep here" chip showed next to signal fires, or when R would cook. It now uses structures.canSleepHere().
- FIXED: medicine was wasted at full health. It's now refused with a toast.
- SKIPPED (negligible): a few small per-frame allocations in interact.js.
