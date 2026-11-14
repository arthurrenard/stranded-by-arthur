# V4-B multiplayer (build log)

Owner files: src/net/* (net.js, protocol.js, netUI.js, net.css), src/player/avatar.js, server/* (package.json, index.js,
Dockerfile, fly.toml, README.md), docs/MULTIPLAYER.md, tests/net.test.mjs. Additive ID/apply hooks in
src/nature/resources.js, src/gameplay/structures.js, src/gameplay/raft.js.

## Plan
- [x] protocol.js (schemas, encode/decode, room codes, sanitizers, validation, rate limiter)
- [x] server/index.js (+ package.json, Dockerfile, fly.toml, README.md)
- [x] hooks: resources rid + hideById/regrowById; structures placeAt/lightById/extinguishById + ids on payloads; raft applyStage
- [ ] avatar.js (procedural castaway, animation, name tag, interpolation)
- [x] net.js (ctx.net, panel wiring, URL params, host rules, clock sync, event relay with loop guard, avatars)
- [x] netUI.js + net.css (chat, player list)
- [x] docs/MULTIPLAYER.md
- [x] tests (server/test.mjs + tests/net-protocol.test.mjs instead of tests/net.test.mjs); node --check; scripts/check.mjs green

## Done
- protocol.js: MSG/LIMITS/SHARED_EVENTS/HOST_ONLY_EVENTS/ERRORS, encode/decode (16 KB cap), 6-letter room codes (no I/O),
  sanitizeName/sanitizeChat (controls + <> stripped, 16/200 chars), validateState/validateEvent/validateHello, colorForId,
  makeId, token-bucket rate limiter, angleDelta.
- server/index.js (~290 lines): rooms, host election + re-election, welcome with the host's seed/difficulty/clock
  (extrapolated), 20 Hz dirty-only snapshots that never include the recipient (a joiner marks the room dirty so it gets
  one at once), event relay (SHARED_EVENTS only, time:set host-only, never echoed), chat relay (sanitized, 2/s),
  ping/pong + 30 s idle drop, MAX_PLAYERS env / CONFIG.net.maxPlayers, PORT env (8787), GET /health, SIGINT/SIGTERM shutdown,
  `startServer({port})` export for tests. Dockerfile (node:20-alpine, build from repo root), fly.toml (shared-cpu-1x,
  internal_port 8787, auto stop/start), README.md.
- hooks: resources.js `rid` ('kind:index', deterministic from the seed) on every 'harvest' payload + hideById/regrowById;
  structures.js placeAt(type,x,z,yaw) (emits structure:placed with remote:true), ids on fire:lit/fire:out/structure:placed,
  lightById/extinguishById; raft.js applyStage(index) (never backwards), exported on ctx.raft.

- netUI.js + net.css (finisher): createNetUI(ctx, net) → {init, update, system}; Enter opens chat (sets ctx.ui.menuOpen
  before unlock like hud panels, so the local sim freezes while typing), Enter sends + re-locks, Esc/blur cancels (stays
  unlocked → main pauses once); 8 s lines colored by colorForId; P = player list (1 Hz refresh); bottom 96px, lifted above
  .hud-stats if they overlap; hidden while offline.
- net.js (finisher): mid-game join on another difficulty → toast + reload with ?difficulty=<host>&server&room&name&skipintro=1
  (once: the reload writes ?mpdiff=<host>; skipped when it is present or the preset is unknown); before game:start → ctx.debug.difficulty(id).
  Clients get a ctx.time.skipHours guard (syncSkipGuard: installed iff connected && !isHost, passes through while net's
  own clock sync is applying; toast key 'net-skip'); restored on leave / host promotion. Native WebSocket only.
- docs/MULTIPLAYER.md (local run, two tabs via Create → copy code, Fly.io + Railway, synced / not synced, limits, cost TODO).
- server/test.mjs (npm test in server/): 10 checks green (welcome/host, snapshots exclude recipient, event relay no echo +
  unknown dropped + time:set host-only, chat sanitize/cap, room full with MAX_PLAYERS=3, no_room/version, host
  re-election, room gone when empty). Idle drop not testable (LIMITS frozen, no override). README tests section updated.

- tests/net-protocol.test.mjs: 12 pure checks (encode/decode, room codes, sanitizers, validators, colors, ids, rate limiter,
  angleDelta), no 'ws'. scripts/check.mjs green (16 tests).

## Left
- Cost numbers in docs/MULTIPLAYER.md §7 (TODO for the orchestrator).
- Not in this builder's files: server idle-drop override for tests (LIMITS frozen); stats.js sleep still shows its own
  "You slept" toast on a client when the skip is refused; a root .dockerignore would shrink the Fly build context.
- avatar.js exists (src/player/avatar.js, used by net.js) but was not in the finisher's file list and was not reviewed;
  its Plan box stays unchecked.
- In-browser verification of chat/player list/difficulty reload not done (no browser in this pass).
