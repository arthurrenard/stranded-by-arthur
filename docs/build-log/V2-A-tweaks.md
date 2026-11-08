# V2-A tweaks — build log

Files: src/nature/resources.js (+ src/nature/res/treeHarvest.js), src/survival/model.js, src/survival/stats.js,
tests/survival.test.mjs, src/audio/beds.js (+ wind call in src/audio/audio.js).

## Plan
1. [x] Pyrite 15% from stones (resources.js harvest bonus)
2. [x] Leaves: +2 leaves from berry bushes / nettles; more shrubs near spawn; "Gather leaves" on birch/willow (treeHarvest.js)
3. [x] Tree fruit: apples / chestnuts / palm shake (treeHarvest.js), regrow ~1 game day
4. [x] Difficulty in model.js + stats.js (mults, early damage, thirst 0 kills, warnings 20/10)
5. [x] Nights colder every day (model.nightChill), tuned by node sim in tests/survival.test.mjs
6. [x] Diving mask: breath drain x0.5
7. [x] Wind: canopy/inland quieting + slow random envelope (beds.js), audio.js passes canopy/storm/coast/forest

## Done / left
- DONE survival (model.js, stats.js, tests/survival.test.mjs: 49 pass).
  - model: difficultyOf(d) (fallback presets.easy), needsStep/needDamageRates/healthRegenRate/simulateSleep take a trailing
    `diff`; tick reads inp.diff + inp.breathMul. earlyNeedDamage() (hard). thirstZeroKills -> instant 'dehydration' death
    (after nausea, god exempt). nightFactor(hour), nightChill(hoursTotal, perDay) (night N = floor((hT+12)/24), cap 14).
  - Hypothermia curve made steeper (K.coldCurveBase 0.25 / coldCurveSlope 4.5, was 1/1) so a mild chill nibbles and a deep
    freeze kills. Night sims (dry, open, full needs, from 100 hp): easy n1 0 / n3 62 / n4 dead; medium n1 0 / n2 dead;
    hard n1 60 (survives) / n2 dead; fire 0.9 = no damage nights 1-5 on all difficulties.
  - sleep: diff mults, thirst floor 5 (thirstZeroKills), env.chill (avg night chill) freezes open-air sleepers (min 5 hp).
  - stats: env.nightChill folded into env.airTemp; tickIn.diff each frame (lazy); diving_mask -> breathMul 0.5 (sampled at 4 Hz);
    thirst warnings 20/10 with "You're dying of thirst: drink NOW!"; dusk toast when tonight is >= 2.5 °C colder.
- DONE resources (resources.js + new res/treeHarvest.js). Headless smoke (flora-smoke ctx): pyrite 14.8 % over 3860 stone
  picks; berry/nettle +2 leaves (one combined toast, 'harvest' per item); +30 shrubs around spawn (16-150 m, off sand) and
  +70 forest shrubs, placed LAST in place() so earlier seeded spots don't move (264 total, 53 within 150 m);
  1739 tree entries (birch 806, chestnut 352, apple 256, palm 251, willow 74) incl. the fallback palm; priority -0.3,
  y = ground + 1.4, radius 2.6 + trunkR, hidden 20-28 game h after a harvest (palm miss: 0.025 h), hidden when the tree falls.
  regrowAll() also resets trees; counts().treeHarvests; api.treeHarvests.
- DONE wind (beds.js + audio.js wind call only). beds.WindEnvelope: lulls 10-40 s at 15-25 %, rise 5-15 s to 65-100 %,
  hold 2-8 s, fall 5-15 s. createWind.update(t, dt, w, strength, o?) now steps at 4 Hz (WIND_STEP); o = { canopy, storm,
  coast, forest }: shelter 1-0.55*canopy (x windLevels' 0.55 = ~0.25 at full canopy), inland forest x0.65 (coast 25-110 m),
  storm pins the envelope to the peak and cancels the quieting. audio.js passes a stable windOpts object. mix.js untouched.
- DONE stats.applyEffects: negative health effects (raw food, seawater) x damageMul (copied, item defs never mutated).
- VERIFIED: node --check on all touched files, import smoke, scripts/check.mjs all green (survival 49 tests).
- LEFT: nothing. Not playtested in a browser (orchestrator).
- DONE (after review) fire shield: M.shieldedChill(chill, fire) = chill x (1 - 0.5 fire), applied in stats.sampleEnv after the
  fire is sampled (and in the test sim). Fire warmth = 0.6 + 0.4 flameLevel(fuel), so a low-fuel fire (0.6) beside you still
  saves hard night 5; ~5 m off (0.3) does not. Removed a tautological fall assert. check.mjs green again.
