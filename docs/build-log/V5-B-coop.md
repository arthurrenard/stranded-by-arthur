# V5-B co-op (SPEC §13 "Co-op (B)")

## Done
- [x] protocol.js: new SHARED_EVENTS (item:dropped, drop:picked, raft:deposit, raft:sync, vehicle:placed, vehicle:pose,
      vehicle:seat); raft:sync is HOST_ONLY; PAUSED_OK_EVENTS (relayed while paused: join-time sync); per-event field
      checks in validateEvent (present fields must be well-typed / in range; missing fields are allowed because
      tests/net-protocol.test.mjs requires `{}` to validate for every shared event; receivers ignore incomplete payloads).
      The server imports the same lists, so server/index.js needed no code change.
- [x] server/test.mjs: relay of every new event, malformed payloads dropped, raft:sync host-only.
- [x] raft-logic.js: stockNeedsStatus, consumeStageStock (stock first, then own), depositList, addStock, applyUsed, setStock.
- [x] raft.js: ctx.raft.stock; online the yard's [R] = "Deposit materials" (offline unchanged: "Check the plan");
      raft:deposit {id,n,by} per item; build emits raft:stage {stageIndex, stage, used}; applyStage(index, used),
      applyDeposit, applySync; the host emits raft:sync {stageIndex, stock} on net:playerJoined. objective().needs[i]
      gains `stock` (have = stock + yours). showNeeds counts the stock too.
- [x] vehicle-coop.js (pure): seats (ME sentinel, freeSeat, applySeatClaim with lower-id tie-break, releaseSeats,
      clearRemote, simulatorOf), createPoseBuffer (alloc-free ring, short-way heading), poseDue.
- [x] vehicle-meshes.js: makePaddleRaft also returns `seat2` (passenger, toward the bow).
- [x] vehicles.js: own raft + `remotes` (vid "<netId>:raft"); seat 0 paddles, seat 1 rides (yaw follows the deck);
      simulator = seat-0 occupant else owner; it broadcasts vehicle:pose at ≤10 Hz (1 s heartbeat), others interpolate
      CONFIG.net.interpolationMs behind; capsize forces a pose (cap=1) → every client aboard is thrown off;
      "The raft is full"; passenger gets [R] "Take the paddle" when seat 0 frees; disembark/teleport frees the seat;
      re-announce on net:connected/net:playerJoined via ctx.net.relay; net:playerLeft frees seats and drops that player's
      raft (adopted if you are riding it); net:disconnected drops remotes. Offline: identical to before.
- [x] net.js: pack/apply for all new events (spawnDrop/removeDrop guarded with ?.), raft:stage carries `used`,
      ctx.net.relay(name, payload), PAUSED_OK_EVENTS pass the playing gate.
- [x] Review fixes: raft interpolation delay = max(interpolationMs, 250 ms) (jitter slack at 10 Hz); item:dropped /
      drop:picked are PAUSED_OK (inventory panel may drop while paused); a vehicle:seat for an unknown vid mirrors the raft
      hidden until its vehicle:placed; ctx.vehicles.seatFeet(id, out) and net.js draw a seated remote avatar at its seat on
      OUR copy of the raft (not their lagged one).
- [x] tests/coop.test.mjs: stock, seats, pose buffer, protocol, end-to-end 3-client shared raft, solo unchanged.

## Known limits
- Races: two players picking up the same drop at once (both get it); a concurrent build of the same stage can
  double-spend stock; a deposit crossing a raft:sync may be lost/duplicated (host's sync wins).
- The e2e test uses a zero-latency synchronous fake relay and bypasses net.js pack/apply.
- Late joiners don't see drops that already lie on the ground (no drop sync on join).
- A capsized raft can only be righted by the client that simulates it (its owner when nobody is aboard).
- Remote avatars use the generic `state.aboard`; a sitting/paddle pose belongs in src/player/avatar.js (not owned here).
