# Multiplayer (v4 groundwork)
> **Deployed (2026-11-22):** app `stranded-by-arthur-relay` in the Arthur Renard (`personal`) org, region `sjc`, at
> `wss://stranded-by-arthur-relay.fly.dev` (health: https://stranded-by-arthur-relay.fly.dev/health). It's the game's default
> server (`CONFIG.net.defaultServer`). Redeploy after server changes with `fly deploy --config server/fly.toml --remote-only --ha=false .`

STRANDED can be played with friends on the same island: up to **8 castaways per session**, joined by a 6-letter room
code. It is fully optional. With no server configured (`CONFIG.net.defaultServer` empty and no `?server=`), the game
is the usual single-player game. The multiplayer panel still shows in the pause menu, with the Leave button hidden.

- **Client**: `src/net/net.js` (`ctx.net`), `src/net/netUI.js` (chat and player list), `src/player/avatar.js` (remote castaways).
- **Protocol**: `src/net/protocol.js`, JSON over WebSocket, shared by the browser and the server.
- **Server**: `server/index.js`, a small Node 20 relay built on `ws`. It has no database and no accounts.

## 1. Run the server locally

```sh
cd server
npm install
node index.js            # → ws://localhost:8787 · health: http://localhost:8787/health
```

`PORT=9000 node index.js` picks another port. If `npm install` fails on permissions in `~/.npm`, add
`--cache /tmp/npm-cache-stranded`. `MAX_PLAYERS=4 node index.js` lowers the room size.

Start the game in another shell from the repository root:
`./node_modules/.bin/vite --port 5173 --strictPort --host 127.0.0.1` (or `npm run dev`).

## 2. Test with two browser tabs

A room code exists only after someone creates the room. A made-up code such as `ABCDEF` is answered with
"No such session", and the game won't create a room from a code in the URL. The first tab creates the room:

1. **Tab 1 (host)**: open
   `http://localhost:5173/?server=ws://localhost:8787&name=Tab1&skipintro=1`.
   Press **Esc**, then click **Create** in the multiplayer panel. A toast shows the code (e.g. `KQWRTD`), and the address
   bar now ends in `&room=KQWRTD`.
2. **Tab 2 (client)**: open
   `http://localhost:5173/?server=ws://localhost:8787&room=KQWRTD&name=Tab2&skipintro=1`,
   with the real code. The `?server=&room=&name=` parameters auto-join after the title screen, when the game starts.
   You can also type the code in the panel and click **Join**.
3. Each tab sees the other castaway. **Enter** opens the chat (Enter sends, Esc cancels). **P** shows the player list
   with each player's ping and the host badge. Chop a tree, light a fire or build a raft part in one tab, and it
   appears in the other.

Tips:
- Use two windows side by side, or one normal window and one private window. Background tabs are throttled by the
  browser, so their avatars stutter.
- Add `&debug=1` to keep the game from pausing when the pointer is released. `window.__game.net` is the live `ctx.net`.
- Tests:
  - `cd server && npm test` (or `node test.mjs`) drives real WebSocket clients against an in-process server.
  - `node tests/net-protocol.test.mjs` checks the pure protocol helpers. It also runs as part of `npm run check`.

## 3. Deploy on Fly.io (step by step)

The server image must be built from the **repository root**, because the server imports `src/net/protocol.js` and
`src/config.js`. `server/Dockerfile` and `server/fly.toml` are set up for that.

1. **Install flyctl**: `brew install flyctl` (macOS) or `curl -L https://fly.io/install.sh | sh`.
2. **Sign up or log in**: `fly auth signup` (or `fly auth login`). New accounts need a card on file.
3. **Create the app without deploying.** Run this from the repository root:
   ```sh
   fly launch --no-deploy --copy-config --config server/fly.toml
   ```
   Pick a unique app name (the `app` line in `server/fly.toml` is updated) and a region near your players
   (`cdg` = Paris is the default).
4. **Deploy**, from the repository root (the trailing `.` is the build context):
   ```sh
   fly deploy --config server/fly.toml .
   ```
   The build context is the whole repo. If uploads are slow, add a root `.dockerignore` with `node_modules`, `dist` and
   `graphify-out`.
5. **Check it**: `curl https://<app>.fly.dev/health` should return `{"ok":true,...}`. The game's URL is
   **`wss://<app>.fly.dev`**. Fly terminates TLS and forwards to `internal_port 8787`.
6. **Point the game at it**. Choose one:
   - set `CONFIG.net.defaultServer = 'wss://<app>.fly.dev'` in `src/config.js` and rebuild/redeploy the game, or
   - pass it per link: `https://<your-game-host>/?server=wss://<app>.fly.dev`. Players can also paste it into the
     server field of the multiplayer panel. It is remembered in localStorage.
7. **Day to day**:
   - `fly logs` shows joins, leaves and host changes.
   - `fly status` shows the machine state.
   - `fly scale count 1` keeps a single machine. Rooms live in memory, so **do not run more than one machine**, or
     players on different machines can't meet.
   - `auto_stop_machines = "stop"` stops the machine when nobody is connected, and the first connection starts it
     again. That first connection takes a couple of seconds.

## 4. Alternative: Railway

1. Go to railway.app, choose **New Project**, then **Deploy from GitHub repo**, and select this repository.
2. In the service's **Settings**:
   - Keep the root directory at the **repository root**, again because the Dockerfile needs `src/`.
   - Set the Dockerfile path with the variable `RAILWAY_DOCKERFILE_PATH=server/Dockerfile`, or in Settings → Build.
3. Railway sets `PORT` itself, and the server reads it. Optionally set `MAX_PLAYERS`.
4. Under **Networking**, choose **Generate Domain**. The game URL is `wss://<service>.up.railway.app`.
5. Keep **one replica**, for the same reason as on Fly: rooms live in memory.

Any host that runs a Docker image and passes WebSocket upgrades through works the same way. Examples are Render,
a VPS behind Caddy or nginx, or a Raspberry Pi with a tunnel. Pages served over `https://` must use `wss://`.

## 5. What is synced, and what is not (yet)

**Shared by everyone in the room:**
- Player positions, look direction and movement state at `CONFIG.net.tickHz` (15 Hz). The server sends 20 Hz
  snapshots. Remote castaways are rendered `CONFIG.net.interpolationMs` (120 ms) in the past, so they move smoothly.
- **The host's clock is authoritative.** The host sends `time:set` every ~10 s. Clients correct their clock gently, or
  jump to it when the gap is more than 2 game minutes.
- **The host's difficulty wins.** Joining is only possible once a game has started (the panel is in the pause menu,
  and URL auto-join runs when the game starts). So a joiner on another difficulty gets a toast, then the page reloads
  on the host's difficulty (with `skipintro`) and re-joins the same room. The raft parts are already placed for the
  joiner's plan, so the game can't switch in place.
- World events, each applied once with no echo:
  - harvested resources (by a stable per-instance id)
  - placed structures (campfire, signal fire, shelter, SOS sign)
  - fires lit or out
  - cooked food
  - **raft stages: the raft is shared**
  - felled trees
  - flares
  - easter eggs: one finder counts for everyone
  - the win: a rescue or sailing away ends the game for everyone together
- Chat: 200 characters, 2 messages per second. Control characters and `<>` are stripped.

**Not synced (yet):**
- **Inventories are per player.** What you gather is yours. Only the world change (the bush is empty) is shared.
- Health, hunger, thirst, stamina, warmth and death are per player.
- **Time skips are host-only.** A client can still sleep, build and travel, but those actions don't move a client's
  clock forward. The client sees "In multiplayer the host's clock rules: only the host can skip time". When the host
  skips time, everyone's clock follows.
- Animals and fauna, weather and storm timing, fishing and cinematics are all local.
- The island must match. Everyone needs the same build and seed, and a joiner on a different seed gets a warning only.
- **No anti-cheat.** The server checks message shapes, sizes and rates, and allows only known event names. It trusts
  the content: a modified client can teleport, fake events or win. Play with friends.

## 6. Limits

- **8 players per room** (`CONFIG.net.maxPlayers`, or the server's `MAX_PLAYERS` env). Extra joiners get "That session
  is full."
- **No persistence.** Rooms live only in the server's memory. A room disappears when its last player leaves, and every
  room disappears when the server restarts. Each player's own game state is unaffected (each tab keeps its world).
- **Host hand-off.** When the host leaves, the next player becomes host and their clock leads from then on.
- **Disconnects.** See § 6c Reliability: a dropped player keeps their slot (same id, host role) for 90 s and the client
  retries forever (backoff 0.5 → 8 s) until it is back in.
- **Message caps.** 16 KB per message, 4 KB per event payload. 30 state updates and 30 events per second are accepted
  per player. Positions beyond ±5000 m are rejected.

## 6b. Restarts and the Fly trial
The relay keeps rooms in memory, so a server restart (a deploy, Fly maintenance, or the **Fly trial, which stops machines after
5 minutes until a card is added at https://fly.io/trial**) drops everyone. Clients reconnect automatically and send `resume`, so
the server re-creates the room under the same code: you see "Connection lost. Reconnecting…" for a few seconds, then play on.
With a card on file the 5-minute cutoff goes away (invoices under $5 are waived, and this server costs about $2/month).

## 6c. Reliability (V6)
A real 2-player session (Belgium ↔ California) lost a player ~11 min in although the server never restarted. Causes: the
server dropped sockets that sent no *application* message for 30 s (a background tab stops rAF, so no state/pings),
background tabs throttle the client's reconnect timers, and every reconnect came back as a new player (new id, new avatar,
host role lost). Now:

- **Heartbeat (server).** Every `HEARTBEAT_MS` (15 s) the server sends a WebSocket *ping frame*. Browsers answer those
  themselves, even in a hidden tab. A socket is dropped only if it neither answered a pong nor sent any message for `DEAD_MS`
  (60 s). There is no app-message idle rule any more. The app-level `ping{ts}` every 5 s stays (RTT for the player list).
- **Grace-period resume.** When a socket closes without a `bye`, the player stays in the room as *disconnected* for
  `RESUME_GRACE_MS` (90 s): no `playerLeft`, no host migration; the others get `presence{id, connected:false}` and show the
  avatar's tag as "Name (away)". The welcome carries a random `token` (only to that player). On reconnect the client sends
  `hello{room, resume:true, resumeId, resumeToken}`; inside the window the server re-attaches the same player (same id, host
  role kept, `welcome{resumed:true}`, `presence{connected:true}` to the others: the host then re-sends `raft:sync` and
  vehicles re-announce). A resume also works over a half-open socket the server still thinks is alive (it is retired). A
  wrong token just joins as a new player. After the window: the normal `playerLeft` + host migration (to a connected player).
  A new joiner never waits for a disconnected host.
- **Restart resume** (unchanged): `resume:true` for an unknown room re-creates it under the same code (keeping the old id).
- **Client.** An unexpected close keeps the room, id, host role, players and avatars (`ctx.net.reconnecting`); no
  `net:disconnected` is emitted for a blip. It retries forever (0.5, 1, 2, 4, 8, 8… s, ±20 % jitter), and at once on
  `online` and when the tab becomes visible. A 10 s `setInterval` (not rAF) sends an app ping and treats 20 s without any
  inbound message as a dead socket. Toasts: "Connection lost. Reconnecting…" once, "Reconnected." once; "Lost the
  connection" only on a fatal error (e.g. the room filled up meanwhile). After a resume the host re-sends `time:set`; a
  client's clock is corrected softly unless it is > 2 game minutes off. `leave()` (and closing the tab, `pagehide`)
  sends `bye{}`, which removes the player at once.
- **Tests:** `cd server && npm test` runs `reliability.test.mjs` (raw sockets) and `client.test.mjs` (the real net.js over `ws`) with short `heartbeatMs / deadMs / graceMs` (also
  settable by the `HEARTBEAT_MS`, `DEAD_MS`, `RESUME_GRACE_MS` env).
- **Deploy note:** rooms live in one process's memory, so the relay must run as **exactly one** Fly machine (never scale
  it out). `auto_stop_machines` only stops a machine with no connections; set `min_machines_running = 1` (or
  `auto_stop_machines = "off"`) to also avoid the cold start for the first player.

## 7. Cost

Checked on 2026-11-21. Prices change, so confirm on the pricing pages before you rely on them.

| Host | What you run | Cost |
|---|---|---|
| **Fly.io** (recommended) | one `shared-cpu-1x` machine with 256 MB, `auto_stop_machines` on | about **$2.19/month** if it ran 24/7, billed per second, so less with auto-stop; plus outbound bandwidth |
| **Railway** | the Hobby plan | **$5/month**, which includes $5 of usage; a small Node server like this one normally fits inside it |

**Bandwidth estimate.** Each player sends about 15 small state updates per second, and the server sends 20 snapshots per second
to each player. With 4 players that's on the order of 50–100 KB/s while a session runs, so a few game nights a week stay
in the low single-digit GB per month. Both options are far below a $35/month budget.

**Free tiers that sleep** (e.g. Render's free web service) also work, but the first player of a session waits for a cold start
(tens of seconds), and a sleeping server drops the room.

Sources: https://fly.io/pricing, https://fly.io/pricing-update/, https://www.activepieces.com/blog/railway-pricing-2026-plans-usage-rates-and-costs.md

## v5 co-op events (2026-11-22)
Relayed (SHARED_EVENTS, client + server): `item:dropped` / `drop:picked` (world pickups by dropId), `raft:deposit` (the Boatyard's
shared stock), `raft:sync` (host → joiners: stage + stock), `vehicle:placed` / `vehicle:pose` (driver, ~10 Hz) / `vehicle:seat`
(2-seat paddle raft). Known gaps: drops already on the ground aren't sent to late joiners; two players grabbing the same drop at the
same instant can both get it; a capsized raft can only be righted by the player simulating it.
