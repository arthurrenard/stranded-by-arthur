# V2-C dive + UI (build log)

STATUS: DONE (awaiting orchestrator integration/playtest)

| piece | file(s) | status |
|---|---|---|
| 1 diving (X dive, Space rise, float up, seabed clamp, diving/depth) | src/player/controller.js | DONE (velocity-target dive branch in swimVertical; sinking never lifts you; vertical dive counts as moving for swim energy) |
| 2 tool recipes (shovel, pickaxe + last-flint warn, diving mask) + use texts | recipes.js, crafting.js, inventory.js | DONE (recipe.warnLast + lastUseWarning(); inventory TOOL_TEXT export) |
| 3 HUD: objective tracker, rescue banner + compass marker, difficulty badge, breath/depth, raft win text | hud.js, hud.css, hud-data.js | DONE (pure helpers in hud-data: objectiveView/Sig, partsSummary, relBearing, compassPlace, raftWinText; badge inside the clock card; journal badge 92px, toasts 120px) |
| 4 Journal Boat tab + map Boatyard pin | hud-panels.js | DONE (journal opens on Boat tab) |
| 5 dive tutorial hint | hud.js | DONE (player:swimStart after game:start; plus tool/part first-pickup hints, boat start hint, raft:* journal log) |
| verify (node --check, smoke import, tests, scripts/check.mjs) | tests/v2-dive-ui.test.mjs | DONE (16 tests incl. the real controller on a mock seabed; check.mjs all green; fake-DOM HUD smoke run in scratchpad) |

Notes:
- Map pins are drawn in hud-panels.js renderMap (hud-map.js only draws the canvas), so the Boatyard pin lives there.
- Diving: X held -> dive mode (velocity targets: -1.5 down, +2.0 Space, +0.8 float); feet >= ground+0.35 (never above float level);
  handback to the old float spring 0.3 m below float level. Sinking (exhausted) disables dive mode and never lifts you; after
  recovering at depth you float up gently. `diving`/`depth` reset in teleport/endSwim/death.
- Crafting: recipe.warnLast {id,text} + recipes.lastUseWarning(); the craft toast becomes one warn toast (same 'craft' key).
- HUD: tracker hides on null objective / cinematic / dead / rescued; rescue banner + red compass marker (clamped to the strip
  edge with an arrow); Boatyard ⛵ compass marker (in range only); difficulty pill in the clock card; depth readout in the breath row.
- Journal opens on the new Boat tab by default. Map: Boatyard pin + legend line (pins live in hud-panels.js renderMap).
- Win: method 'raft' -> "HOMEWARD BOUND!" + raftWinText(name), name from payload.name | CONFIG.raft.plans[plan].name | plan.name | ctx.raft.plan.name.
- Tools (shovel/pickaxe/diving_mask) count as isUsable so they win a hotbar slot; F explains them; actionHint '[F] How to use it'. Dive hint is scheduled 6 s after the first swim (after the basic swim hint).
