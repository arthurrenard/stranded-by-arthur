# V5-A inventory: slots, drag & drop, dropping items (SPEC §13 "Inventory (A)")

Files: src/gameplay/inventory.js, src/ui/hud.js, hud-panels.js, hud-data.js, hud.css, src/nature/resources.js (drops),
tests/inventory-ui.test.mjs

## Status (all done)
- [x] pure slot helpers in inventory.js (newSlots, addTo, removeFrom, moveSlot, takeFrom, refillHot, roomFor, slotTotal,
      stackLimit) + tests/inventory-ui.test.mjs (15 tests, incl. the resources pending-drop contract)
- [x] inventory.js slot model behind the old API, Q / Shift+Q drop (CONFIG.keys.drop if ever added, else KeyQ)
- [x] resources.spawnDrop / removeDrop + item:dropped / drop:picked
- [x] panel UI: 6×4 backpack grid + 9-slot hotbar row, pointer drag & drop, tooltip, Drop buttons, right-click drop
- [x] HUD hotbar shows the slot's own stack size; one-time "hotbar full" hint mentions Tab drag + Q

## Model
- One flat array S: 0-8 hotbar, 9-32 backpack; {id, n} or null. stackLimit: 1 for shovel, pickaxe, paddle,
  fishing_rod, boat_key, diving_mask; 20 for everything else (flint/pyrite/torch/flare/parts included).
- `inventory.hotbar` is a persistent 9-array of ids rewritten in place by sync() (no allocation; HUD + fishing read it
  per frame). `inventory.slots` exposes S read-only; `slotN(i)`, `move(from, to, {split})`, `dropSlot(i, n?)`,
  `dropSelected(one)`, `stackLimit`, `HOT`, `PACK`.
- add() (SPEC §13 order): existing stacks → the hotbar's empty slots → the backpack. A usable item not yet on a
  full hotbar evicts the right-most non-usable hotbar stack into the backpack (keeps the v2 test). When full, the rest spills at the feet via spawnDrop and add() returns n (callers like
  harvest / the hut shelf / fishing treat the return as "taken", so nothing duplicates). pickDrop passes
  { spill: false } and gets the real stored count.
- remove(): backpack stacks first (from the end), then hotbar; a hotbar slot emptied by remove() is refilled from
  the backpack (usable first, only items not already on the bar). User moves are never auto-rearranged.
- Drop position: player + horizontal camera dir × 1.2; at the feet if that point is water deeper than 0.5 m or the
  player is in the water (spawnItem floats drops on water deeper than 0.15).

## Drops (resources.js)
- spawnDrop(id, n, x, z, dropId?) wraps spawnItem (same DROP_LOOK meshes, label "Pick up <n> <item>"), keeps a
  dropId → drop Map. A locally generated id (`<net.id when connected | local>:<counter>`) emits item:dropped
  {dropId, id, n, x, z}; a remote apply passes the id and emits nothing (and is a no-op if that id already exists).
- removeDrop(dropId | drop): removes without giving the item, emits nothing (also clears a pending one).
- drop:picked {dropId} on full pickup; a partial pickup (pack full) emits drop:picked and re-spawns the rest under
  a new dropId (so others stay in sync); the 80-drop cap emits drop:picked for an evicted shared drop.
- The internal removal is now destroyDrop(drop) (drop.remove() still works).
- Player drops of boat parts and one-of tools (KEEP_DROPS) are `keep` (never evicted by the 80-drop cap).

## Known gaps
- Not browser-verified (no Vite/browser in this run). An eviction during a remote apply runs under net's `applying`
  guard so its drop:picked is not relayed (edge case). A pending (pre-build) remote spawnDrop is not deduped by dropId.
- Behaviour change: in the backpack a single click selects a slot, a double click uses it (was single click use).

## Panel (hud-panels.js)
- Click a slot: select it (info box with Use / Drop all / Drop 1). Second click within 350 ms uses a consumable /
  torch / flare (manual double-click: the re-render replaces the element). Drag (5 px threshold, pointer capture,
  ghost with pointer-events none): drop on a slot = move/merge/swap; Shift on release = split half; release outside
  the panel = drop the stack (Shift: one). Right-click = drop stack (Shift: one). Hover + 1-9 = move to that hotbar
  slot; hover + Q = drop (Shift: one). Backdrop click-to-close is ignored mid-drag. Column scroll kept across re-renders.
