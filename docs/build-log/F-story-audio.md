# Builder F — Story, Rescue, Easter Eggs & Audio (build log)

Status: IN PROGRESS (skeleton written first so an interrupted run can resume)

## Plan / files
- [ ] src/story/models.js — procedural low-poly models (boat, wreck, helicopter, search boat, crates, bottle, volleyball, lean-to, tally rock, stone circle, duck, arms, ladder, butterfly) + shared story lights
- [ ] src/story/fx.js — pooled particles (fog-aware ShaderMaterial), light cone, meteors, aurora
- [ ] src/story/overlay.js — cinematic subtitle / skip hint / flash DOM overlay (z-index 55)
- [ ] src/story/intro.js — intro cutscene play() + wreck + beach crates
- [ ] src/story/rescueLogic.js — pure rescue math (schedule, visibility, signals, hints)
- [ ] src/story/rescue.js — passes, vehicles, attention, flare, spotted cutscene
- [ ] src/audio/sounds.js — one-shot synth recipes
- [ ] src/audio/audio.js — WebAudio engine, beds, loops, event auto-sounds
- [ ] src/story/eastereggs.js — 7 eggs
- [ ] tests/story.test.mjs

## Progress
