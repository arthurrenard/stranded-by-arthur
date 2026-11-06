# STRANDED — notes for Claude sessions

## Resume protocol (save tokens)
1. Read `PROGRESS.md` (the milestone checklist and next step). Read `SPEC.md` only for the sections you need.
2. Don't open every source file to orient. Use the code knowledge graph, which is code-only, built offline and costs 0 LLM tokens:
   - `graphify query "<question>" --budget 800` answers questions like "where is the drinking provider?"
   - `graphify explain "<symbol>"` lists a function's callers and callees, e.g. `graphify explain "createInteract"`
   - `graphify affected "<symbol>"` shows what breaks if it changes
   - `GRAPHIFY_BACKEND=none graphify update .` rebuilds the graph after code changes (run from this folder)
   - The human-readable overview is `graphify-out/GRAPH_REPORT.md`, the interactive one `graphify-out/graph.html`
3. Per-module builder notes are in `docs/build-log/*.md`.
4. Verify with `npm run check` (syntax + unit tests) and `npm run build`. For runtime checks, open `?debug=1&skipintro=1`
   and use `window.__game.debug` (see SPEC.md §8).

## Environment gotchas
- npm: `~/.npm` has root-owned files, so always pass `--cache /tmp/npm-cache-stranded` to `npm install`.
- The desktop app's preview launcher can't run inside ~/Downloads. Start the server from a shell
  (`./node_modules/.bin/vite --port 5173 --strictPort --host 127.0.0.1`), then attach the browser pane to http://localhost:5173.

## Conventions
- Ownership and interfaces are in SPEC.md §1 and §6. Every system is `create(ctx)` → api with `init()` and `update(dt)`.
- All tunables are in `src/config.js`. Everything is procedural: no binary assets.
- The player is vegetarian: plant foods only, no hunting or fishing.
