# Builder F1 — Intro + Rescue (build log)

Status: DONE (browser runtime not verified; node checks + fake-ctx smoke only)

Shared, read-only (done by the previous F builder, shared with F2): src/story/models.js, src/story/fx.js, src/story/overlay.js.

## Plan / files
- [x] src/story/rescueLogic.js: pure rescue math (schedule, routes, attention, hints), node-testable
- [x] tests/rescue.test.mjs: unit tests + whole-pass balance simulation
- [x] src/story/introSea.js: storm swell mesh + matching JS wave function for the intro boat
- [x] src/story/intro.js: intro cutscene play(), permanent wreck, beach crates + debris
- [x] src/story/rescueVehicles.js: helicopter + search boat rigs (rotors, lights, spotlight, wake, rotor wash)
- [x] src/story/flareFx.js: flare rocket, trail, red light
- [x] src/story/rescue.js: scheduler, passes, attention, waving arms, flare hook, spotted cutscene

## Progress
- rescueLogic.js + tests/rescue.test.mjs DONE (21 tests incl. whole-pass balance sim; `node tests/rescue.test.mjs`).
  Balance (K in rescueLogic): pass 1 unwinnable without a signal fire; boat day 2 ~50 % when waving on the beach;
  heli 0.7+ waving on the beach = spotted; signal fire spots on every pass; canopy / underwater = 0.
  Crew slows down (speedFactor) once attention > 25 % so a half-noticed player gets a longer look.
- introSea.js DONE: flat-shaded storm swell patch (MeshStandardMaterial + onBeforeCompile, fog-safe), JS twin
  surfaceAt() so the boat floats on the visible waves; flattens + foams over the reef, fades toward the island.
- intro.js DONE: 26 s timeline (deck / wide / impact / black / wake / sit / rise), skip via Space/Enter/Escape or
  pointer-unlock (fade 0.35 s -> finalize -> intro:done -> resolve), 45 s safety timeout, try/catch -> finish.
  Ends at exactly spawn eye height + spawn.yaw (verified headless). Permanent wreck at (wreck.x, 0, wreck.z) yaw 0.35,
  reef colliders, debris, crate1 (rope 1 + cloth 2) / crate2 (flare 1 + toast) searchable once (lid opens).
  Uses getStoryLights(): spot = lightning, point = deck lamp; both reset to 0 at the end.
- rescueVehicles.js DONE (previous run): heli + boat rigs share getStoryLights().spot; call both rigs' update() every frame.
- flareFx.js DONE: createFlareFx(ctx, {light}) -> fire(position, dir) handle {position (live), t, burning, done, height}.
  Climb 120 m in 3 s (ease-out), parachute sink 2 m/s + wind drift, burn 8.5 s. Smoke (normal) + glow/sparks (additive)
  particle pools; head = 2 additive sprites (glowTexture). Uses the shared story PointLight (passed in by rescue.js; no
  runtime light add): color/decay 2/distance 0 set on every fire, intensity keeps ~0.6 lux under the head. Adds a
  {kind:'flare', strength 700, isActive} entry to ctx.signals while burning. Pure helpers flareHeight/flareGlow/
  flareLightIntensity tested in tests/flare.test.mjs.
- rescue.js DONE: scheduler (nextIndex = firstPassIndexAfter; re-synced on time:set; passes > 1.5 h stale are dropped;
  deferred while cinematic/sleeping), seeded per-pass rng (ctx.rng.fork('rescue:i')), same draw order as the balance sim.
  Heli follows terrain (low-passed), boat bobs; searchlight at night sweeps then drifts onto the player as attention builds.
  Attention via rescueLogic.attentionRate (canopy/biome sampled at 4 Hz, weather vis, blessed). Toasts: start (with
  bearing), "They're turning toward you!" (>50 %, once), missHint on a miss, sleptThroughText after waking, "No one saw
  it…" when a flare burns out unseen. Flares spot when the vehicle is within 700 m of the burning head (after 0.9 s).
  Spotted: flags.cinematic + letterbox, heli bezier-descends to 25 m above the player (14 m offset, ridge clearance),
  ladder unrolls, rotor wash; boat sails along the coast to the nearest deep water. Camera looks up at the vehicle,
  subtitles, fade(1,2) then rescue:success {method, passes, kind} (fallback timer 2.6 s; deferred if not 'playing').
  Loops ('rotor'/'engine') silenced whenever state != playing. Arms (createArm) parented to the camera while G held.
- Verified: node --check + import of rescue.js / flareFx.js; tests/flare.test.mjs (3); `node scripts/check.mjs` passes.
  Fake-ctx smoke (scratchpad, not in tests/): scheduled 15:00 pass -> passStart/passEnd + missHint; debug heli + waving on
  the beach -> turning toast, spotted (waving), subtitles, success; time:skip 14->22 -> slept-through toast after waking;
  debug boat + flare -> spotted (flare) -> success; lone flare -> "No one saw it…" + signal removed; night heli + signal
  fire -> spotted (signal_fire); state 'paused' silences the loops.
- Not verified in a browser: arm pose in view, flare sprite/light look, heli hover framing, boat approach on the real coast.
- Scheduler fix: a pass that falls due while another pass/cinematic/sleep blocks it starts as soon as possible (heldBack), the 1.5 h stale drop only applies to time jumps. flags.cinematic stays on after rescue:success (game over, HUD hidden under the win screen at z 58 > #fade 50).
