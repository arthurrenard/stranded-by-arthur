# STRANDED — Build Progress (resume file)

> **If you are a new Claude session resuming this project: read this file first, then `SPEC.md`.**
> Don't re-read every source file. Use the code graph instead:
> `graphify query "<question>"`, `graphify explain "<symbol>"`, `graphify update .` (rebuild, no LLM tokens).
> Per-module builder reports live in `docs/build-log/<module>.md`.

## Status legend
- [x] done & verified · [~] written, not yet verified in browser · [ ] todo

## Milestones
1. [x] Project folder, npm deps (three 0.187, simplex-noise 4.0.3, vite 8.3.6), graphify CLI installed (`uv tool install graphifyy`)
2. [x] Core engine written by the orchestrator (main.js, config, core/*, world/heightfield.js, stubs) + `npm run build` passes
3. [x] Builder workflow: all modules built over 3 waves (waves 1+2 were cut off by usage limits; wave 3 used 3 focused agents and finished).
   LESSON: never run more than 3 builder agents at once on this account, and keep prompts narrow.
4. [x] Integration (2026-11-06): `npm run check` passes (77 files, 8 test suites), `vite build` passes, and the game boots with no errors.
   Verified in the browser: intro, movement, swimming/drowning, drink/fill/eat, crafting, campfire + cooking, night fireflies,
   rescue pass, spotted by waving, rescue cutscene, win screen, and all 7 easter eggs. See docs/review-notes.md for the issue list.
5. [x] Review: playtest fixes + contracts audit (7 fixes) + requirements audit (3 fixes, all requirements covered). See docs/review-notes.md.
6. [x] README.md written (run instructions, controls, feature list) + final graphify rebuild

## How to resume
1. `cd stranded && npm install --cache /tmp/npm-cache-stranded` (the user's ~/.npm cache has root-owned files; a custom cache avoids EACCES)
2. `npm run build`: it should pass at every milestone.
3. `npm run dev`, then open http://localhost:5173/?debug=1&skipintro=1 for fast testing. `window.__game` exposes debug helpers (see SPEC.md §Debug).
4. Check the milestone list above and continue at the first unchecked item.

## Log
- 2026-11-06: project started. Core scaffolding done (main/config/core/heightfield + stubs). Verified: build passes, island renders at 60 fps.
- 2026-11-06: builder workflow launched (run id wf_568e3ea1-7e2, same-session resume only). If the session died mid-run,
  check `docs/build-log/*.md`: a module with a build log is (mostly) done; modules still containing `// STUB` need building.
  Find leftover stubs with: `grep -l "// STUB" -r src`
- Tooling: `npm run check` (syntax, imports, unit tests), CLAUDE.md (resume protocol), graphify code graph in graphify-out/.
7. [x] Publish (live + verified 2026-11-06): https://github.com/arthurrenard/stranded-by-arthur (public). Pages: https://arthurrenard.github.io/stranded-by-arthur/
   It deploys through .github/workflows/deploy.yml on every push to main (npm ci, then check, then build, then deploy-pages). vite base is './'.

## v2 update (2026-11-07): requested by the user
Requests: pyrite 15% from stones; easier leaves; apples from apple trees; faster hunger; difficulty picker (easy = old,
medium = faster health + thirst loss, hard = health drops before needs hit 0); death at 0 health or thirst; nights colder
every day; quieter, varying forest wind; MAIN GOAL = rebuild a boat from parts (beach / buried with shovel / in rock with
pickaxe / underwater by diving), with more intricate plans per difficulty; plus chat answers (how to get spotted, a multiplayer plan).
- [x] Core (orchestrator): CONFIG.difficulty + CONFIG.raft + keys.dive, new items, main difficulty + raft win, title picker, SPEC §10
- [x] V2 builders (3 agents, run wf_0679da67-c68, same-session resume only): A tweaks, B raft, C dive+tools+HUD. If interrupted, read docs/build-log/V2-*.md. See SPEC §10 ownership. Check: `grep -l "// STUB" -r src`
- [x] Integrate + playtest (difficulty picker, raft plans, full Easy build + launch + win, shovel dig, apple picking, diving for the engine, thirst-0 death). Commit + push.

## v3 update (2026-11-13): requested by the user
Requests: [E] key badge not bold; 5% palm-shake coconut death; start more thirsty; hunger icon = steak 🥩; Medium = hard to be
seen, Hard = impossible to be seen (boat only); TEMPEST ISLE (smaller second island, a faint outline from the beach and clear from the
summit; a fishing hut atop a dangerous mountain with fishing rods; a motorboat at a dock; violent local storms 40% of half-days with
hail, quick onset, raft/sailboat capsizing, wind dousing outdoor fires; the hut can be set on fire for fun); a paddle raft + paddle
to reach it slowly; more quirks, and a longer objective.
- [x] Core (orchestrator): isle2 terrain grid + queries + landmarks, CONFIG.isle2/vehicles/palmDeathChance/rescueMul/flareRange,
  new items, isle2/vehicles stubs wired in main, SPEC §11 contracts + ownership
- [x] V3 builders DONE (all 3 finished; check passes 97 files / 13 suites; vite build passes). Run wf_11148740-650, same-session resume only): A world+rules, B isle content, C vehicles+HUD. If interrupted, read docs/build-log/V3-*.md. Check: `grep -l "// STUB" -r src`
- [x] v3 playtested in the browser (fog compiles, storm/hail/douse, hut, dock, motorboat, raft, capsize, fishing) and PUSHED (2026-11-20). (old note: browser playtest BEFORE pushing (the fog GLSL patch in src/world/fx/fogChunks.js is not yet compiled in real WebGL). Test: ?debug=1&skipintro=1, the view from launchBeach and the summit, __game.weather.debugIsle2Storm(true), crafting a paddle + paddle raft, paddling to the isle, the hut (search / hearth / burn), the dock motorboat, fishing. Then git push (Pages auto-deploys).

## v4 update (2026-11-20): requested by the user
Requests: refine mechanics + optimize; multiplayer groundwork (player bodies, ids, create/join, interaction) while still playable alone
+ a cheap (<$35/mo) server recommendation; smoother wind; better aesthetics in-game (not the title screen); no overlapping HUD text;
a real fishing minigame (20–45 s bite, reel by pressing a button, can lose the fish, cook fish); coconuts nerfed; intro crash fix (boat
must not fall apart, camera must not fall through) + more impressive animations; AC-style summit drone shot (first time + replay in the
stone circle, also during aurora/meteors); stone runes interactable at night with a significant unlock (→ The Giant's Road causeway);
a Bella message-in-a-bottle easter egg.
- [x] Core: fish items, coconut nerf, CONFIG.fishing/net + keys, fishing/net stubs wired, #mp pause panel, SPEC §12
- [~] Wave 1 (run wf_c8925b6e-3ba) was CUT OFF by usage limits after 1.27M tokens. Real state, from the code, not the logs:
  - A cinematics: intro crash fix DONE; summitShot.js, causeway.js, eggRunes.js, Bella wired in eastereggs.js (needs a browser check).
  - B multiplayer: protocol.js, server/ (index.js, Dockerfile, fly.toml), net.js (759 lines), avatar.js, world-sync hooks DONE.
    MISSING: netUI.js + net.css (chat/player list), docs/MULTIPLAYER.md, net tests.
  - C fishing+HUD: fishing-logic.js + fishing.js DONE. MISSING: HUD fishing widget, overlap audit + toast queue, egg total 9 in the HUD.
  - Orchestrator DONE (2026-11-21): Esc double-pause fix, coconut KO (35 % death, else 10 % hp + 4 h knock-out + 2 h fatigue,
    tests/coconut-ko.test.mjs), Space guard while fishing, smoother wind (beds.js).
  - VERIFIED in a frozen browser snapshot: intro crash (camera ≥ 2.9 m above the sea, deck rigid, debris pops), summit survey (first
    trigger + replay, 154 m orbit, camera restored), runes debugSolve → Giant's Road built, walked 505/525 m onto Tempest Isle without
    swimming, Bella bottle exact text (egg 2/9), egg total 9.
  - Finishing run wf_8ad030be-b01 (2 agents: net UI/docs/tests + HUD widget/overlap) failed once on a network error and was retried.
  - Perf profile at the spawn: 231 calls / 2.67 M tris; trees ≈ 1.4 M tris (71 calls), grass 305k, terrain 320k → wave-2 target: tree LOD.
  - Hosting (searched 2026-11-21): Fly.io shared-cpu-1x 256 MB ≈ $2.19/mo + egress; Railway Hobby $5/mo incl. $5 usage.
  LESSON: at most 2 agents at a time now, with narrow scopes.
- [x] Wave 1 finished (run wf_8ad030be-b01 retried): net UI/docs/tests + HUD fishing widget/toast queue/zones. Two-tab LOCAL multiplayer
  test passed (2026-11-21): create room → join by URL → avatar visible at the right spot → harvest synced (driftwood:2) → chat relayed.
- [x] Wave 2 done + wired (quality.js before sky, post.js around renderer.render). Spawn view now 197 calls / 1.8 M tris
  (was 231 / 2.67 M); golden hour/night reviewed. Was: Wave 2 (2 agents): D aesthetics (colors/materials/lighting/post FX/HUD skin/avatar look), E optimization (tree LOD, shadow
  casters, grass, quality presets + adaptive resolution in NEW src/gfx/quality.js → orchestrator wires it in main.js)
- [~] Integrate + playtest DONE; commit + push in progress (2026-11-21)
