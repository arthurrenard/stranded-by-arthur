# STRANDED relay server

A ~300-line Node 20 WebSocket relay for *STRANDED: Driftwood Isle* multiplayer. No database, no accounts:
players meet in a room identified by a 6-letter code, the first player in is the **host** (its seed, difficulty
and clock win; a new host is elected when it leaves), and the server relays everyone's state, world events and chat.

```
cd server
npm install
node index.js            # listens on :8787 → ws://localhost:8787, GET http://localhost:8787/health
PORT=9000 node index.js  # another port
MAX_PLAYERS=4 node index.js
```

Then open the game twice with `?server=ws://localhost:8787` (see `docs/MULTIPLAYER.md` for the full walkthrough,
the Fly.io / Railway deployment and the cost estimate).

## What it does
- **Rooms**: `hello{name}` creates a room (code like `KQWRTD`), `hello{name, room}` joins one (`error{code:'no_room'|'room_full'}` otherwise).
- **Welcome**: `welcome{id, room, isHost, hostId, players, seed, difficulty, timeHours}`; others get `playerJoined`.
- **Snapshots**: clients send `state` (≤ 30 Hz accepted), the server sends `snapshot{players}` at 20 Hz to each
  player, never including the recipient, only when something changed.
- **Events**: `event{name, payload}` is relayed as `event{name, payload, from}` to everyone *else* in the room.
  Only names in `SHARED_EVENTS` (src/net/protocol.js) pass; `time:set` only from the host.
- **Chat**: `chat{text}` → `chat{id, name, text}` to everyone else, control characters and `<>` stripped, 200 chars, 2 msg/s.
- **Keep-alive**: the server pings every 5 s and drops sockets silent for 30 s; clients may ping too (`ping{ts}` → `pong{ts}`).
- **Health**: `GET /health` → `{ ok, rooms, players, sockets, maxPlayers, uptime }`.
- **Shutdown**: SIGINT/SIGTERM close every socket with code 1001 and exit.

## Files
- `index.js` — the server (`export async function startServer({ port })` for tests; runs when executed directly).
- `../src/net/protocol.js` — message types, validation, sanitizing, room codes (shared with the browser client).
- `Dockerfile` — `node:20-alpine`; build from the repository root: `docker build -f server/Dockerfile .`
- `fly.toml` — one `shared-cpu-1x` machine, `internal_port 8787`, auto stop/start.

## Tests
From the repository root: `node tests/net.test.mjs` (starts the server in-process on a random port > 9000 and
drives two WebSocket clients through join / snapshot / event / chat / host re-election).
