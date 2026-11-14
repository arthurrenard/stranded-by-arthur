# V4-C — fishing minigame + HUD overlap (build log)

Owner files: src/gameplay/fishing.js, src/gameplay/fishing-logic.js (pure), src/isle2/isle2-fishing.js (retired shim),
the fishing hook in src/isle2/isle2.js, src/ui/hud.js, hud-panels.js, hud-map.js, hud-data.js, hud.css,
src/gameplay/inventory.js, tests/fishing.test.mjs.

## Status
- [x] 1. fishing-logic.js pure state machine + tests (tests/fishing.test.mjs green)
- [x] 2. fishing.js (float, line, rod, audio, loot, toasts, harvest, lore bottle)
- [x] 3. isle2-fishing.js retired → shim hands isOnDock to ctx.fishing (standalone fallback keeps tests/isle2.test.mjs green); isle2.js: comment only
- [x] 4. HUD fishing widget (centre column under the prompt) + journal clues (Secrets tab) + inventory hints (Fishing tip already in hud-data.js TIPS)
- [x] 5. HUD overlap audit + zone table in hud.css + toast queue (≤4 visible, queue 10, same-key merge incl. queued, newest last); .hud-left (obj+tip), .hud-center (prompt+fish), subtitle bottom 126 / 180 aboard (#hud.hud-veh), vehicle bottom 122
- [x] 6. eastereggs.total instead of literal 7 (journal.eggsTotal getter/setter → ctx.eastereggs.total, fallback 9; win screen)
- [x] 7. node --check (hud.js, hud-panels.js, inventory.js), scripts/check.mjs exit 0 (no browser run)

## Design (decided before coding)
- Logic/host split: fishing-logic.js has no THREE/DOM; `createFishingLogic(cfg, rng)` → `{ state, cast(), reel(), cancel(), tick(dt, input) }`
  with `input = { reel, cancel, moved }`. Phases: idle → waiting (first 0.6 s = float in flight) → bite → fight → landed|lost → idle.
  Events are pushed to `state.events` and drained by the host (no per-frame allocation).
- Loot is rolled at cast time (so the fight length is known): CONFIG.fishing.loot, plus a 5 % lore-bottle swap on junk catches
  (BOTTLE_MESSAGES from isle2-logic.js kept). Fish size: big_fish 1, raw_fish 0.35, crab 0.3, junk 0.08 → fightDurationSec lerp.
- Fight: tap = +reelTapGain progress, +tensionPerTap tension; tension relaxes tensionRelaxPerSec; baseline drain reelDrain/s,
  ×5 during a "run" (bursts, bigger fish run longer/more often; tension also creeps during a run and taps cost ×1.5).
  tension ≥ 1 → snap (15 % rod loss when the loot was big_fish); timer out → escaped; bite not hooked in hookWindowSec → gone;
  reel while waiting → "too early" (the nibbles are the false alarms).
- Interact: while active the provider returns a secondary-only candidate (score 9) so Mouse0 is not swallowed as "interact" and R = cancel.
  Aboard a vehicle the cast prompt only appears when the rod is the selected hotbar item (so the vehicle prompt stays).
- controller.js is not mine: Space still jumps on land while fishing until a `!ctx.fishing?.active` guard is added (reported).

## Notes
(filled in as pieces land)
- Fishing widget: phase text map FISH_TEXT in hud.js; bars only in fight/landed; tension ok <0.55 ≤ warn <0.8 ≤ hot, pulse ≥0.85;
  prompt gets .off while ctx.fishing.fighting (the widget footer shows "R to give up" instead). DOM written only on change.
- Clues: markJournal('clue:*') → panels.journal.clues → Secrets tab "Rune clues found: N" + a log line.
- Inventory: TOOL_TEXT.fishing_rod (also makes the rod hotbar-usable); raw_fish/big_fish/crab warn "Cook it at a campfire first" (effects unchanged).
- Open: controller.js still jumps on Space while fishing (not my file); the net chat zone (src/net) is not HUD-owned.
