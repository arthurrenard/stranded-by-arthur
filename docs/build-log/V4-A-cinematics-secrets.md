# V4-A — cinematics + secrets (build log)

Owner: V4-A. Files: src/story/* (intro.js, introSea.js, fx.js, models.js, overlay.js, eastereggs.js, egg*.js, summitShot.js, causeway.js), tests/story*.test.mjs.

## Status
- [x] 1. Intro crash fix (rigid boat group, camera on boat transform, freeze after impact, pop FX) — intro.js/introSea.js/fx.js
      rewritten in the first session (T timeline, SLOWMO, CREST, impactK rest pose, deckCamera via boat.matrixWorld, clamp SEA+0.4).
      This session: verified (node --check, import smoke, pure timeline test in tests/story.test.mjs).
- [ ] 2. Summit survey cinematic (summitShot.js)
- [ ] 3. Rune puzzle + The Giant's Road (eastereggs.js + causeway.js)
- [ ] 4. Bella bottle
- [ ] 5. ctx.eastereggs.showActive
- [ ] 6. tests/story.test.mjs

## Already in place from the first session (do not redo)
- eggRunes.js: GLYPHS (7), drawGlyph, pickSolution(rand), evaluate(lit, solution), inRuneNight, clueTexts.
- eggLogic.js: EGGS has 9 entries (bella, causeway) → EGG_TOTAL = 9.
- eggCarving.js: drawCarving(g,w,h,glyphs) + createCarving({glyphs}).
- models.js: createStoneCircle → { runeMats[7], haloMats[7], beam, beamMat, glowMat, stones }, createTallyRock(glyphs), createNoteSign(glyphs, lines).
- tests/eastereggs.test.mjs still asserts the old total 7 → must read L.EGG_TOTAL (9).

## Notes
- Cinematic pattern (vehicle-cine.js / rescue.js): set ctx.flags.cinematic + ctx.letterbox(true); the controller leaves the
  camera alone while cinematic; restore and clear at the end; ctx.input.lock() from the skip keydown.
- Hut door: ctx.isle2.hut.frame {x,z,fx,fz}; door center = hutWorld(frame, HUT.D/2 + 0.6, -0.9). isle2 is created before
  eastereggs in main.js, but the hut can fail → place the note lazily in update() when the frame exists.
