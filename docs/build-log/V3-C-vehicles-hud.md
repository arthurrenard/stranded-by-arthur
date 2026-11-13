# V3-C vehicles + HUD (build log)

Owner files: src/gameplay/vehicles.js (+ vehicle-*.js), src/player/controller.js, src/gameplay/recipes.js + crafting.js,
src/gameplay/raft.js + raft-logic.js (+ tests/raft.test.mjs), src/ui/hud*.js + hud.css, tests/vehicles.test.mjs.

## Plan
- [x] vehicle-logic.js (pure) + tests/vehicles.test.mjs (8 tests pass)
- [x] recipes (paddle, paddle raft) + crafting routing (place: 'paddle_raft' -> ctx.vehicles.findRaftSpot/placeRaft)
- [x] controller: setSeat(obj, vehicle)/syncSeat(dt)/aboard; teleport stands up; currents via vehicle-logic.currentsAt (no snap between islands)
- [x] vehicles.js (+ vehicle-meshes.js, vehicle-cine.js): paddle raft, motorboat, capsizing, head-home cinematic; e2e tests in tests/vehicles.test.mjs (11 pass)
- [x] raft.js/raft-logic.js: hut parts in parts() (+ raft:part where isle2hut), isle2hut hint, Boatyard boat voyage to Tempest Isle + back + storm flip + right it + sail home (vehicle-voyage.js); raft tests 17 pass
- [x] HUD: key badge weight 500, steak hunger icon (bar/warnings/effects/death; stats.js toasts remapped in hud toast()), coconut/hail/fire deaths, vehicle panel, storm banner (stacked with rescue), two-island map (MAP_BOUNDS, BASE 384, FOG 150, glimpse), isle2 landmarks, raft compass marker + map pins, journal Tempest Isle section, one-time sighting hint; tests in tests/vehicles.test.mjs (14 pass)
- [x] node scripts/check.mjs: all green (syntax, imports, every test)

## Log
- started 2026-11-13
- raft-logic: hintFor 'isle2hut' + isHutPart(); raft tests filter hut parts from placement (raft test green)

## Contracts as built
- `ctx.vehicles`: `current`, `raft`, `motorboat`, `fueled`, `canHeadHome`, `canDisembark`, `findRaftSpot()`, `placeRaft(spot)`,
  `board(rec)`, `disembark()`, `headHome()`, `debugRaft()` (paddle + raft at the launch beach), `debugMotorboat()` (key + fuel,
  teleport to the dock), `debugCapsize()`. Events: vehicle:placed / vehicle:board / vehicle:leave / vehicle:capsized, raft:voyage {to}.
- `ctx.player`: `aboard`, `setSeat(seatObj | null, vehicle)`, `syncSeat(dt)`; `teleport()` always stands the player up.
- Motorboat: once started, vehicles.js owns its transform (`moored = false`); isle2.js stops animating it (it already does).
- `ctx.raft`: `away`, `voyage` ({ away, capsized, active, position, sailToIsle(), sailBack(), debugCapsize() }); parts() lists
  'isle2hut' entries (found = ctx.isle2.partsInHut()[i].taken, or a raft:part {where:'isle2hut'} event).
- Crafting: recipe `place: 'paddle_raft'` is routed to ctx.vehicles (not structures).
- Design choices: the hard-mode motor launch (plan 'motorboat') never flips while moored at Tempest Isle (motorboats don't
  capsize); a paddle raft can't go beyond 1150 m from the main center unless within 430 m of Tempest Isle (swell pushes it back);
  between the islands the swimmer currents are capped and never snap (vehicle-logic.currentsAt).

- Review fixes: corridor currents capped at 1.5 (beat the fastest swim: tested both directions with the real controller, nobody
  swims across); MAP_BOUNDS widened to { x0: -365, z0: -840, size: 1230 } (every coast >= 10 m inside, tested); helm seat for
  isle2's motorboat; no energy drain while paddling exhausted (crawl and recover).

## Left / known
- src/survival/stats.js (not mine) still passes the leaves icon for hunger warning toasts; hud.js toast() remaps it to the steak.
- Not verified in a browser (no servers per instructions). The HUD was smoke-tested in node with a fake DOM.
