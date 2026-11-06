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
7. [ ] Publish: GitHub repo arthurrenard/stranded-by-arthur + GitHub Pages (Actions workflow .github/workflows/deploy.yml)
