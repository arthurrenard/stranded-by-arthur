# V2-B raft (boat-repair goal) build log

Files: src/gameplay/raft.js, src/gameplay/raft-logic.js (pure), src/gameplay/raft-parts.js (placement),
src/gameplay/raft-meshes.js (procedural models), tests/raft.test.mjs.

## Findings (orientation)
- Seed 20261106: spawn (10.2, 1.3, 290.8), wreck (12.3, -8.7, 352.8) 62 m straight seaward (+z) of spawn.
- Seaward of spawn: sand, flat (slope 0.01), h 0.8 @6 m, 0.4 @10 m, no water until > 14 m. Boatyard fits at 6–10 m.
- coastPoint(b, 1.3) then 2 m inland gives sand>0.6, h 0.6–2.5 at all 24 tested bearings.
- Within 45 m of the wreck ~25 % of random points are ocean 3–8 m deep.
- Bamboo: 10 clumps x 3–6 canes (30–60), regrow 24–48 h, needs flint. Supply is fine; runtime top-up anyway if < 10.
- Cloth: crate1 gives 2; extraSailcloth bundles on beaches. Stats do not drain on time:skip (we apply drains).

## Status
- [x] raft-logic.js (pure: plans, needs, drains, hints)  - [x] raft-parts.js (placement verified in node: all parts placed for 3 plans, site (10.4,0.6,298.8), launch turn 55° clears the wreck by 29 m)  - [x] raft-meshes.js (boats per plan with stage groups matching CONFIG stage ids; parts, mound, boulder, sign, yard, wake, puffs; node smoke OK)  - [x] raft.js (ctx.raft API, parts + dig/break/grab, Boatyard build flow, launch cinematic)  - [x] tests/raft.test.mjs (13 tests incl. placement on the real island and a mocked end-to-end hard run)  - [x] check.mjs all green

## Notes for integration / playtest
- Scene objects are created on 'game:start' (plan frozen then); before that ctx.raft.plan/objective() resolve lazily from ctx.difficulty.
- Interaction labels have no "[E]" (the HUD adds the key). Yard: "Build: <label> (<time>)" / "What's needed?" / "Launch the <name> and sail home"; [R] "Check the plan".
- Build refuses at night (20:00–05:00), while dead, and when the drain would bring thirst/hunger under 5 (avoids an instant death).
- ctx.flags.cinematic is set during the build fade (restored) and the launch (kept on; main switches to 'rescued').
- Launch route: 10 m straight out, then a 55° turn (seed 20261106) that clears the wreck by ~29 m. Skip with Space/Esc (or pointer unlock).
- Debug: __game.raft.debugGiveAll(), .debugComplete(), .debugLaunch().
- placeParts runs a second pass without collider blocking (spacing kept) for anything crowded out, then a last-resort
  spot (console.warn), so a count-1 part (compass, rudder, engine...) can never go missing. Tested with a hostile blocker.
- Checked: resources is built in init (bamboo counts valid at game:start); no time:skip consumer assumes "sleep".
- Not verified in a browser yet: trestle height on the sloping sand, underwater glow visibility from the surface, cinematic framing.
