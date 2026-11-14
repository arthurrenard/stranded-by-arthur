# V4-B multiplayer (build log)

Owner files: src/net/* (net.js, protocol.js, netUI.js, net.css), src/player/avatar.js, server/* (package.json, index.js,
Dockerfile, fly.toml, README.md), docs/MULTIPLAYER.md, tests/net.test.mjs. Additive ID/apply hooks in
src/nature/resources.js, src/gameplay/structures.js, src/gameplay/raft.js.

## Plan
- [x] protocol.js (schemas, encode/decode, room codes, sanitizers, validation, rate limiter)
- [x] server/index.js (+ package.json, Dockerfile, fly.toml, README.md)
- [x] hooks: resources rid + hideById/regrowById; structures placeAt/lightById/extinguishById + ids on payloads; raft applyStage
- [ ] avatar.js (procedural castaway, animation, name tag, interpolation)
- [ ] net.js (ctx.net, panel wiring, URL params, host rules, clock sync, event relay with loop guard, avatars)
- [ ] netUI.js + net.css (chat, player list)
- [ ] docs/MULTIPLAYER.md
- [ ] tests/net.test.mjs; node --check; scripts/check.mjs green

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

## Left
- avatar.js, net.js, netUI.js + net.css, docs/MULTIPLAYER.md, tests/net.test.mjs, verification.
