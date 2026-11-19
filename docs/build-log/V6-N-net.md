# V6-N-net — multiplayer reliability (heartbeat, grace resume, bye)

Status: done (2026-11-18). Files: src/net/net.js, src/net/protocol.js, server/index.js, server/test.mjs,
server/resume.test.mjs, server/reliability.test.mjs (new), server/package.json, tests/net-protocol.test.mjs, docs/MULTIPLAYER.md.

- [x] protocol: MSG.BYE / MSG.PRESENCE; LIMITS.heartbeatMs 15 s, deadMs 60 s, resumeGraceMs 90 s (idleMs removed);
      validateHello → resumeId / resumeToken (charset-checked). PROTOCOL_VERSION unchanged (fields optional).
- [x] server: ws.ping() heartbeat, alive = pong or any message within DEAD_MS; grace window on unexpected close
      (presence false, no leave/host); resume by id+token (also over a half-open socket); host migration prefers a
      connected player; bye = immediate leave; timings via startServer options or HEARTBEAT_MS / DEAD_MS / RESUME_GRACE_MS.
- [x] client: keep room/id/host/avatars while reconnecting; forever backoff 0.5→8 s ±20 %; reconnect now on online /
      visible; 10 s setInterval app ping + 20 s stale-socket watchdog; bye on leave / pagehide / difficulty reload;
      "(away)" name tag on presence false; reconcile players on a resumed welcome; soft clock after resume.
- [x] tests: server/reliability.test.mjs (8 steps, raw sockets), server/client.test.mjs (4 steps, the real net.js over ws:
      drop+resume, friend away/back, failed attempts across a restart, leave = bye + host hand-off), resume test keeps
      id, protocol tests; npm test + scripts/check.mjs pass.
- Known: events sent while a player is disconnected are not replayed (host raft stock can miss deposits made during
  its outage); start() during an outage leaves the old slot for the grace window; old-client tabs never send bye.
