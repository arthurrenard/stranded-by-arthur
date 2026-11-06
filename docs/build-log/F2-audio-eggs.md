# Builder F2 — Audio + Easter eggs (build log)

Status: IN PROGRESS (continuation run; skeleton written first so an interrupted run can resume)

## Plan / files
- [x] src/audio/dsp.js — pure JS DSP (noise, biquad, tones, grains, envelopes, normalize) for baking buffers
- [x] src/audio/sounds.js — one-shot recipes (baked mono buffers, variants, gains, cooldowns)
- [x] src/audio/mix.js — pure mixing math (bed levels, rates, dedupe gate, doppler)
- [x] src/audio/beds.js — persistent WebAudio graphs (surf, wind, rain, water, insects, fire, underwater, rotor, engine)
- [x] src/audio/audio.js — engine: context, routing, voices, events, listener, loops, schedulers
- [ ] src/story/eggLogic.js — pure egg logic (konami, night windows)
- [ ] src/story/eggCarving.js — carved initials texture + mesh
- [ ] src/story/eastereggs.js — the 7 eggs
- [ ] tests/audio.test.mjs, tests/eastereggs.test.mjs

## Progress
- dsp.js, sounds.js (42 recipes, all variants render finite/normalized in node, ~0.5 s total bake), bake.worker.js
  (module worker bakes off the main thread; audio.js falls back to main-thread baking), mix.js, beds.js done.
- NEXT: audio.js (engine) -> eggs.

## Easter eggs (builder F2-eggs)
- [x] src/story/eggLogic.js: pure. EGGS/EGG_TOTAL/eggName, KONAMI + createSequenceMatcher (KMP, overlapping prefixes ok),
  inHourWindow (wraparound), inNightWindow 22–03, inDawnWindow 05:30–08, nightKey(day,hour) (02:00 day 5 -> night 4),
  mirrorThrough, hash01, butterflyAnchor(day,...), envelope(t,dur,in,out).
- [x] src/story/eggCarving.js: drawCarving (canvas, inset carved-wood letters + grain) + createCarving({radius,height,arc})
  -> partial open cylinder centered on local +Z (rotation.y = atan2(dx,dz) to aim it). Node-safe (null texture, invisible).
- [x] src/story/eastereggs.js: the 7 eggs (see file header). Built in init(); timers run on update(dt) (pause-safe).
- [ ] tests/eastereggs.test.mjs (pure logic + headless smoke test of all 7 eggs)

## Audio engine (builder F2-audio)
- [x] src/audio/audio.js: the engine. The AudioContext is created lazily on the first `resume()`, and capture-phase
  pointerdown/keydown listeners resume it while it is suspended (the `?skipintro` start has no gesture). It also
  suspends while the tab is hidden. Routing: beds → ambBus, one-shots → sfxBus (+ a 0.12 convolver reverb send) →
  worldBus → underwater low-pass (420 Hz while `headUnderwater`) → compressor → master. UI and body sounds (ui_*,
  heartbeat, chime, hurt, gasp, bubble) and the underwater rumble use directBus, which skips the low-pass.
  Muting goes through the master gain. N toggles it in update() with the toast "Sound off"/"Sound on".
  `setMasterVolume(v)` is clamped and stored before the context exists (default 0.8, the slider's default).
- The listener follows `ctx.camera.matrixWorld` every frame (position, forward, up). The yaw used for stereo-pan
  beds is derived from the forward vector, so it also works for the title orbit and cinematics.
- Beds update every frame through Target ramps. World queries (heightAt, coastDistance plus a 2-sample gradient,
  biomeAt, canopyAt, riverAt, lakes, heatSources) run at about 8 Hz.
  - ocean: level from coastDistance, panned toward the sea
  - wind: weather.wind.strength, canopy and storm
  - rain: weather.rain, muffled when sheltered, under canopy or underwater
  - water: river babble while riverAt.d < 25, otherwise lake lapping panned toward the lake
  - insects: crickets at night, cicadas in the afternoon
  - fire: positional, at the loudest lit heat source within about 40 m (level / (1 + 0.15 d)); a torch is 0.3 of a fire,
    so a torch in hand never masks the campfire next to it
  - underwater rumble
  The ambient bus fades in on start and ducks to 0.4 while paused and to 0.55 when dead or rescued.
- Poisson schedulers fire one-shots:
  - birds by day (birdRate; forest mix vs open mix, woodpecker in the forest)
  - distant gulls near the coast
  - owls at night in the forest
  - a frog chorus toward the nearest fresh water (frogLevel)
  - fire crackle, routed into the fire bed's panner
  - canopy drips during and after rain
  - bubbles underwater
  - the heartbeat at health < 25 (state 'playing' only)
  These ambient one-shots never take the last 6 voices.
- One-shots: `play(name, {volume, position, rate, delay})` resolves aliases, and unknown names are ignored silently
  (fauna plays 'birds_flush'). The de-dupe gate runs on the wall clock with a window of max(60 ms, recipe cooldown);
  eat and drink share one key. Each voice is BufferSource → gain → (air low-pass beyond 30 m) → HRTF panner (when a
  position is given) → bus. Positional sounds that would be inaudible are culled, the cap is 24 voices (the oldest
  is stolen with a 12 ms fade), every voice is disconnected on onended, and a sweep catches any onended that never
  fires.
- Event auto-sounds are queued and flushed at the start of the next update(). Same-frame direct `play()` calls
  (structures, resources, crafting, inventory, falling, weather all play their own sounds, often with a position)
  therefore always win the gate, so nothing doubles.
- Loops: `setLoop('rotor'|'engine', volume, position?)` can be called before the context exists. The graph is built
  lazily on the first volume > 0. The panner connects while the volume is > 0 and disconnects after 3 s of silence.
  Air absorption uses airCutoff(d). Doppler comes from the smoothed radial velocity and is applied to oscillator
  detune (cents) and source playbackRate. With no position, the loop sits at the listener.
- Baking runs on the main thread: one variant at a time in BAKE_ORDER, with thunder/crash first (the intro storm) and then variant 0 of every sound, at about
  2.5 ms per frame (around 3 s for everything). A play() of a sound that is not baked yet bakes variant 0
  synchronously. bake.worker.js is unused: it can't be browser-tested here, and the main-thread path is simpler.
- [x] tests/audio.test.mjs: mix.js math, every recipe variant renders finite and normalized, all SPEC sound names
  resolve, the engine is a no-op without WebAudio, and an end-to-end run on a mock AudioContext:
  - beds and schedulers at night/rain/river/fire/low health, underwater, then daytime
  - every recipe with and without a position
  - the 24-voice cap and the de-dupe
  - rotor/engine Doppler loops on and off
  - every subscribed event
  - mute toggle and its toasts, volume clamping
  - voices drain to 0 and the bake queue finishes
  It also checks that a context whose graph build throws degrades to a no-op.
- [x] tests/eastereggs.test.mjs: 15 tests (konami incl. ↑↑↑ overlap/junk/repeat, windows + nightKey edges, mirror, anchors,
  envelope, carving UV orientation) + a headless smoke test (real heightfield/scene/camera, stubbed systems) that finds all 7
  eggs: rope +2 once, moon gravity 0.3 -> 1 after 60 s, circle once per night (+energy to 100, +15 hp), butterfly perches on
  the camera arm in view -> blessed, duck echo 1.2 s later mirrored through the lake center and frozen while paused, dispose().
  `node scripts/check.mjs` passes.
- Placement notes: bottle floats ~13 m seaward of bottleBeach (first ground < sea-0.12 along the radial); camp props sit 4 m
  inland of castawayCamp in a frame whose local +Z is seaward (ball faces the fire pit); stone circle R 8.5 around the summit
  (+ altar collider top +0.27 m, steppable); carving faces Mirror Lake (atan2 to lakes[0]), NOT flora's carve.faceYaw (that
  one points at the spawn), base y = tree.y (falls back to heightAt), 1.4 m up; duck at lakes[0].level (landmarks.duck.y is
  the lake bed), 1.6 m drift circle, handle.moveTo each frame.
- API: { found:Set, total:7, init, update, dispose, debugShower() }. Interactables: "Read the message", "Say hello to the
  volleyball"/"Pat the volleyball", "Read the pinned note", "Count the marks", "Read the carving" (lake side only),
  "Squeeze the rubber duck". Hints: ctx.ui.hint('egg-stones'|'egg-butterfly').
- Not verified in a browser (no server per instructions): visual tuning of the carving texture, rune glow, arm pose.
Status (eggs): DONE.
- Follow-up: flora's carved oak keeps a clean 12-sided bark cylinder (r 0.95) all the way round for y 0.4–2.6, so facing
  the lake is safe; the carving arc adapts to the trunk (min(1.45, 1.15/r) rad, ~1.15 m band). HUD hint() dedupes by id.
