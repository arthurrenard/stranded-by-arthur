# V3-B isle content (Tempest Isle)
Started 2026-11-13. Files: src/isle2/*, src/nature/flora.js + flora/*, src/nature/resources.js + res/* (not treeHarvest.js), src/gameplay/raft-parts.js, tests/isle2.test.mjs.

## Done
- raft-parts.js: placeParts() drops `where === 'isle2hut'` entries (compass stays in the hut); raft.test already filters with isHutPart.
- src/isle2/isle2-logic.js (pure: loot table, hutContents/hutParts, HUT frame, BURN, logbook, ROCKFALL timing).
- src/isle2/isle2-models.js (Bag merge helper, dock, motorboat, hut + ruins, float, boulder).
- tests/isle2.test.mjs (pure + fake-ctx smoke): PASSING.
- src/isle2/isle2-hut.js: cabin + interior, bunk/logbook/shelves/hearth (+cook)/firewood, lantern + fog-free far glow sprite,
  one PointLight (intensity only), wall colliders with an open doorway, shelter {indoor:true}, burn (R twice, 70 s, collapse at 50 s,
  ruins, leftovers dropped via resources.spawnItem(id,x,z,n,{keep,onPick}) or a "Search the ashes" fallback).
- src/isle2/isle2-fishing.js: provider (ocean → E, fresh → R unless rod selected), float + line + held rod, loot.
- src/isle2/isle2-rockfall.js: InstancedMesh of 8 boulders, timer while on isle2 above 35 m, triggers on slope > 0.3. Sim: ~18 % direct hits.
- src/isle2/isle2.js: dock (mesh + 25 collider circles r 1.0, deck 0.95), motorboat moored (bob only while moored), mooring lines, fx, discovery toasts, debug.
  ~6.3k triangles total.

- flora: species.js makeWindPine + lib.windPine (4 variants, own forks); flora/isle2.js placeIsle2Trees/placeIsle2Undergrowth
  (own rng forks, keep-clear: plateau, climb, dock line, cove landing, Rain Pool rim); flora.js appends them (island:'isle2', vk lookup,
  separate tint stream so main-island colors/layout are unchanged). 342 trees (277 wind pines, 34 palms, 31 snags), 97 boulders,
  ~650 undergrowth. flora.test PASSING (222 chunk meshes < 260).

- resources: KINDS.banana (bananaPlant.plant static + bananaPlant.bunch 'growth', regrow 20-28 h) + res/meshes.js bananaPlantGeometry;
  place() keeps main-island logic on main trees only and calls placeIsle2() last (own fork 'resources-isle2'): flint 3, pyrite 2,
  stones 32, sticks 40, leafy shrubs 28, aloe 5, yarrow 6, driftwood 10, logs/shells, 8 banana plants around the Rain Pool,
  9 cattails on its rim, coconuts under 6 cove palms; reserves the plateau, dock line and landing spot.
  spawnItem(id, x, z, n, { keep, onPick }): kept drops are never evicted by the 80-drop cap; onPick(n) after a pickup.
- Bananas are resources (harvestable plants), not flora trees: a new tree type would break flora.test's TYPES contract
  and treeHarvest/falling key off the type.
- Review fixes: insideHut allocation-free; no fire:lit/out or hut 'harvest' emits (HUD would log "campfire" / audio double pickup);
  food:cooked once per item id; light intensities calibrated to structures.js LIGHT (lantern 6, hearth 16, blaze ~58).
- node scripts/check.mjs: all green (97/97 syntax, imports, 13 test files incl. isle2.test.mjs).

## Notes for others
- Fishing at FRESH water only shows "[R] Cast the line" when the drink provider doesn't own the prompt (look further out over
  the water), or "[E]" when the fishing rod is the selected hotbar item. At the sea, "[E] Cast the line" beats "Drink seawater".
- The burning hut registers a ctx.signals 'signal_fire' (strength 900) and a ctx.heatSources 'campfire' (r 11) while it burns.
- Debug: window.__game.isle2.debug.{goDock, goHut, burn, rockfall, catch}().

## Left
Nothing required. Not verified in a browser (no servers in this run).
