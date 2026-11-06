# Builder E — Structures (continuation build log)

STATUS: IN PROGRESS. If this line is still here, the run was interrupted: check each file below with
`node --check`, run `node tests/structures.test.mjs`, then finish the first file marked todo.

| file | status |
|---|---|
| src/gameplay/structure-logic.js (pure: fuel, rain/douse, signals, sleep window, cook queue, SOS layout, placement candidates) | done |
| tests/structures.test.mjs | done (12 tests pass) |
| src/gameplay/fx.js (flame/glow/coal billboards, smoke puffs, embers; fog-aware shaders) | done |
| src/gameplay/structure-meshes.js (procedural campfire, pyre, lean-to, SOS stones, torch; shared materials) | done |
| src/gameplay/structures.js (system + API used by crafting/inventory/hud) | written, syntax + import OK; integration test next |
| tests/structures.system.test.mjs (mock ctx: place/fuel/rain/cook/torch/sleep/skip) | todo |

API that callers rely on (from crafting.js / inventory.js / hud*.js):
- place(type, placement) -> structure | null (must not consume materials; emits structure:placed; toasts)
- findPlacement(type) -> { ok, reason, x, y, z, yaw } (cheap; called on every crafting panel refresh)
- nearestFire(pos, maxDist, litOnly) -> structure | null (XZ distance; includes signal fires)
- toggleTorch() -> bool; T key read here (ctx.input.wasPressed('torch'))
- getters: list [{type, position, lit, removed}], torch {lit, burnLeft (h)}, cooking (bool)
