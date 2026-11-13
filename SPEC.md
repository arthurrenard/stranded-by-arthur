# STRANDED — Driftwood Isle · Technical Spec & Module Contract

A first-person 3D survival game (Three.js r187 + Vite, plain ES modules, no TypeScript, no asset files:
**every mesh, texture and sound is procedural**). The player is a vegetarian castaway who survived a
fishing-boat crash and must stay alive until a search party (helicopter or boat) **spots** them.

Run: `npm install --cache /tmp/npm-cache-stranded && npm run dev`, then open http://localhost:5173
Fast test URL: `http://localhost:5173/?debug=1&skipintro=1`

---
## 1. Architecture

```
index.html            overlays (#title, #pause, #loading, #fade, letterbox), #hud root, #game canvas host
src/main.js           ORCHESTRATOR-OWNED. renderer/scene/camera, ctx, system list, loop, state machine, debug
src/config.js         ORCHESTRATOR-OWNED. all tunables (read it! use CONFIG values, don't hardcode)
src/core/*            ORCHESTRATOR-OWNED. util, rng, events, input, clock, spatial (colliders), interact, items
src/world/heightfield.js ORCHESTRATOR-OWNED. island shape + queries (heightAt, waterAt, biomeAt, landmarks…)
src/world/{terrain,water,sky,weather}.js           Builder A
src/nature/flora.js (+ src/nature/flora/*)         Builder B
src/nature/{resources,fauna}.js (+ src/nature/res/*) Builder C
src/player/controller.js, src/survival/{stats,model}.js  Builder D
src/gameplay/{inventory,crafting,structures}.js, src/ui/{hud.js,hud.css} Builder E
src/story/{intro,rescue,eastereggs}.js, src/audio/audio.js (+ src/story/models.js) Builder F
```
**Builders may only create/modify files they own** (helper files inside their own folders/prefix are fine).
If you need something from a core file, work around it locally and report it in your build log.

### Module contract
Every system module exports `create(ctx)` returning an API object. `main.js` assigns it to `ctx.<name>`:

| ctx key | module | builder |
|---|---|---|
| `ctx.ui` | ui/hud.js | E |
| `ctx.audio` | audio/audio.js | F |
| `ctx.sky` | world/sky.js | A |
| `ctx.weather` | world/weather.js | A |
| `ctx.terrain` | world/terrain.js | A |
| `ctx.water` | world/water.js | A |
| `ctx.flora` | nature/flora.js | B |
| `ctx.resources` | nature/resources.js | C |
| `ctx.fauna` | nature/fauna.js | C |
| `ctx.player` | player/controller.js | D |
| `ctx.stats` | survival/stats.js | D |
| `ctx.inventory` | gameplay/inventory.js | E |
| `ctx.crafting` | gameplay/crafting.js | E |
| `ctx.structures` | gameplay/structures.js | E |
| `ctx.rescue` | story/rescue.js | F |
| `ctx.eastereggs` | story/eastereggs.js | F |
| `ctx.intro` | story/intro.js | F |

Lifecycle: all `create(ctx)` run first **in the table order** (do NOT touch other systems inside
create; they may not exist yet), then every `init()` runs in the same order (cross-references are
safe from init on; e.g. resources.init can read `ctx.flora.trees` because flora.init already ran),
then `update(dt)` every frame in the same order, with the `interact` registry right after `stats`.
`dt` = real seconds (clamped ≤ 0.05). Game time per frame: `ctx.time.dtHours` / `ctx.time.dtGameSec`.

**Frame freezing:** while `ctx.state === 'paused'` or a HUD menu is open (`ctx.ui.menuOpen`),
main skips every `update` except ui + audio. Systems must still gate gameplay logic on
`ctx.state === 'playing'` (world animation like water, sway and fauna may run in any state).

States (`ctx.state`): `loading → title → intro → playing ⇄ paused → dead | rescued`.
- title: main orbits the camera over the island; the clock is paused.
- intro: `ctx.intro.play()` (Promise) owns the camera; `ctx.flags.cinematic = true`; the clock is paused.
- After the intro, main calls `ctx.player.teleport(spawn.x, spawn.z, spawn.yaw)` and `ctx.time.setHour(CONFIG.time.startHour)`, sets state `playing`, calls `ctx.ui.setVisible(true)` and emits `game:start`.
- `stats:died` → state `dead` → main calls `ctx.ui.showDeath({cause, day, hour})`.
- `rescue:success` → state `rescued` → main calls `ctx.ui.showWin({day, hour, ...payload})`.
- **Camera ownership:** the controller writes the camera only when `state==='playing' && !flags.cinematic`
  (and may animate a death fall in `dead`). Intro/rescue cutscenes set `ctx.flags.cinematic = true` and drive `ctx.camera` themselves.
  `ctx.camera.rotation.order === 'YXZ'`: yaw = rotation.y (0 = looking north, i.e. -Z), pitch = rotation.x.

Errors in one system's update are caught and logged by main (the game keeps running). Never let
create() throw: guard optional cross-module calls with `?.`.

---
## 2. Shared context (`ctx`) — provided by main/core

```js
ctx.THREE, ctx.config (=CONFIG), ctx.items (=ITEMS), ctx.params (URLSearchParams), ctx.debugMode
ctx.renderer, ctx.scene, ctx.camera            // camera is added to the scene; you can parent things to it
ctx.events   // on(name, fn) -> off, once, emit(name, payload)
ctx.rng      // seeded rng: ctx.rng.fork('myModule') -> independent stream; rng() / .range(a,b) / .int / .pick / .chance
ctx.input    // isDown(action|code), wasPressed(action|code), wasReleased, mouseDX/mouseDY, wheel,
             // locked, lock(), unlock(), onKeyDown(fn(code)) -> off, hold(code,s)/tap(code) (debug)
             // actions are CONFIG.keys names: forward back left right sprint jump interact secondary
             // useItem craft journal map torch wave hotbar mute. Codes: KeyboardEvent.code or 'Mouse0'/'Mouse2'.
ctx.time     // hoursTotal, day (1-based), hour (0..24), dtHours, dtGameSec, hoursPerSec, timeScale, paused,
             // sunDir (Vector3 toward sun), moonDir, daylight (0..1), isNight,
             // setHour(h), skipHours(h) (emits time:skip), hoursUntil(h)
ctx.world    // the heightfield (see §3)
ctx.colliders // add({x,z,r,y0?,y1?,tag?,data?}) -> c, remove(c), query(x,z,r), resolve(pos, radius, feetY, headY) -> standTop
ctx.interact // register({...}) / addProvider(fn): see src/core/interact.js header. Prompts go to ctx.ui.setPrompt.
ctx.flags    // { cinematic, torchLit, waving, sheltered, nearFire, sleeping, godMode, gravityScale, speedScale }
ctx.uniforms // { uTime, uWind (Vector2 dir), uWindStrength, uDaylight, uRain }: share these in shaders
ctx.heatSources // Set<{ position: Vector3, radius, warmth (0..1), kind: 'campfire'|'signal_fire'|'torch' }>  (E adds/removes)
ctx.signals     // Set<{ kind: 'signal_fire'|'campfire'|'sos'|'torch'|'flare', position: Vector3, strength (visibility range m), isActive(): bool }>  (E adds; F adds flare)
ctx.shelters    // Set<{ position: Vector3, radius }>  (E adds)
ctx.stats_summary // { distanceWalked, itemsCrafted, foodsEaten, plantsGathered }: increment as appropriate; shown on the win screen
ctx.fade(to 0|1, seconds) -> Promise     // full-screen black fade
ctx.letterbox(on)                        // cinematic bars
ctx.debug    // see §8
```

### Flags ownership
| flag | written by | read by |
|---|---|---|
| cinematic | F (intro/rescue), main | everyone (disable input) |
| torchLit | E | D (warmth), F (visibility), B/C (fireflies may avoid) |
| waving | F (G key) | F, E (HUD indicator) |
| sheltered, nearFire | D | E (HUD), F |
| sleeping | D/E | everyone |
| godMode | debug | D |
| gravityScale, speedScale | F (easter egg) | D |

---
## 3. World queries (`ctx.world`, src/world/heightfield.js)
Island ~640 m wide, centered on (0,0). Grid: 1000 m × 1000 m, 400 cells (2.5 m). North = -Z, east = +X.
- `heightAt(x,z)`: ground height, **exactly** matching the terrain triangles. Off-grid = -30.
- `normalAt(x,z, out?)`, `slopeAt(x,z)` (0 flat .. 1 vertical)
- `waterAt(x,z)` → `null | { type: 'ocean'|'lake'|'river', fresh, surface, depth, id }`
- `riverAt(x,z)` → `null | { d, surface, w (half width), s, u (0 source..1 mouth) }`
- `biomeAt(x,z)` → `{ h, slope, rn, water, sand, rock, highland, meadow, wet, forest }` (weights 0..1; ~1 µs each)
- `islandness(x,z)` (0 center, 1 coastline), `coastDistance(x,z)` (+ inland, − sea)
- `randomLandPoint(rng, filter(x,z,biome)?)` → `{x,y,z} | null`
- `buildGeometry()` → terrain BufferGeometry (position, normal, uv, index). Add your own color attribute.
- `lakes`: `[{ id:'lake'|'pond', name, x, z, r, depth, level, rim, waterRadius }]`. Render each as a flat disc of radius `waterRadius` at `level`.
- `river`: `{ points: [{x,z,s,u,surface,w,dirX,dirZ}], depth, startRadius }`. Render a ribbon from the first point whose distance to the lake center > `startRadius` until `surface < 0` (merges with the ocean).
- `SEA_LEVEL` (0), `ISLAND_RADIUS` (320), `SIZE`, `CELLS`, `CELL`, `heights` (Float32Array grid)
- `summit`: `{ x, z, height, plateauR }`
- `landmarks` (all have x, z, y): `spawn (+yaw)`, `wreck` (offshore, on reef rocks), `crate1`, `crate2`,
  `castawayCamp` (north beach), `bottleBeach` (east beach waterline), `carvedTree` (east of lake),
  `summit`/`stoneCircle` (plateau, r=13), `lake`, `pond` (Spring Pond near the spawn), `duck` (on the lake),
  `bambooGrove` (r=14, near the river), `riverMouth`, `meadow` (r=55, flowers + butterflies)

Verified numbers (seed 20261106): lake level ≈ 13.0, pond level ≈ 5.6, summit ≈ 67 m,
spawn ≈ (10, 1.3, 291), wreck ≈ (12, −8.7, 353).

---
## 4. Items (src/core/items.js)
`ITEMS[id] = { name, icon (emoji), category: resource|tool|food|drink|medicine, desc, effects?, cooksInto?, returns? }`
Effects keys: `health, thirst, hunger, energy, heat, wetness, poison, nausea`.
Ids: wood stone flint pyrite fiber leaves bamboo rope cloth · bottle_empty bottle_water ·
berries wild_apple chanterelle toadstool wild_root chestnut coconut cattail nettle ·
baked_apple grilled_mushroom baked_root roasted_chestnut roasted_cattail nettle_soup ·
aloe yarrow chamomile herbal_tea · torch flare. `COOKABLE` = raw ids with `cooksInto`.
**Vegetarian rule:** there is no hunting, fishing or meat anywhere. Animals are decorative only.

---
## 5. Events (name → payload)
| event | emitted by | payload |
|---|---|---|
| `game:start` | main | {} |
| `input:lock` / `input:unlock` | core input | |
| `time:dawn` / `time:dusk` / `time:newday` | core clock | {day} |
| `time:skip` / `time:set` | core clock | {from,to,hours} |
| `player:footstep` | D | {surface:'sand'|'grass'|'rock'|'water'|'wood', sprint:bool} |
| `player:jump` / `player:land` | D | {speed} on land |
| `player:enterWater` / `player:exitWater` | D | {type} |
| `player:swimStart` / `player:swimEnd` / `player:submerged` / `player:surfaced` | D | |
| `player:hurt` | D | {amount, cause} |
| `stats:warning` | D | {type:'thirst'|'hunger'|'cold'|'hot'|'energy'|'drowning'|'health', level:'low'|'critical'} |
| `stats:died` | D | {cause:'dehydration'|'starvation'|'hypothermia'|'heatstroke'|'drowning'|'poison'|'falling'|'tree'} |
| `stats:sleep` | D | {hours} |
| `item:added` / `item:removed` | E | {id, n, total} |
| `item:consumed` | E | {id} |
| `craft:done` | E | {recipe} |
| `structure:placed` | E | {type, position} |
| `fire:lit` / `fire:out` | E | {fire, kind} |
| `food:cooked` | E | {from, to, n} |
| `drink` | E | {source:'lake'|'river'|'ocean'|'bottle'|'coconut'} |
| `torch:toggle` | E | {lit} |
| `harvest` | C (and B for fallen trees) | {id, n, kind} |
| `tree:falling` / `tree:fell` | B | {position, type} |
| `weather:rainStart` / `weather:rainStop` / `weather:thunder` | A | {intensity} |
| `rescue:passStart` / `rescue:passEnd` / `rescue:spotted` / `rescue:success` | F | {kind} |
| `flare:fired` | E (use item) | {position} |
| `easter:found` | F | {id, name, found, total} |
| `intro:done` | F | {} |

---
## 6. Module responsibilities & public APIs

### A — World (terrain.js, water.js, sky.js, weather.js)
- **terrain**: build the mesh from `ctx.world.buildGeometry()`, vertex colors per biome (sand, grass/meadow
  tints, forest-floor, rock, highland, wet mud near water, underwater sand darkening with depth), subtle
  noise variation, `receiveShadow`. Optional detail via onBeforeCompile (e.g. world-space noise). API: `{ mesh }`.
- **water**: ocean (large plane or ring at SEA_LEVEL with custom wave shader: depth-ish color via distance from
  island, foam near shore via `ctx.world` sampled into a texture, sun specular, wave height scaled by weather wind,
  fog-compatible), lake + pond discs, river ribbon with flow (scrolling normal/UV along `s`). Underwater effect:
  when the camera is below a water surface, tint/fog the screen (a CSS or a fullscreen quad). API: `{ isCameraUnderwater }`.
- **sky**: sky dome (three/examples/jsm/objects/Sky.js is fine) driven by `ctx.time.sunDir`; sunrise/sunset colors;
  stars + moon at night; drifting clouds; scene fog color matched to sky; **the single shadow-casting DirectionalLight**
  following the player (`CONFIG.graphics.shadowRange`, `shadowMapSize`), HemisphereLight + ambient tuned for
  day/dusk/night (night must be dark-blue but navigable). Update `ctx.uniforms.uDaylight`. API: `{ sun (DirectionalLight), hemi, setFogDensity? }`.
- **weather**: automatic weather cycle (mostly clear, occasional rain showers ~1–2 per in-game day, lasting 0.5–2 h, thunder
  rarely, rainbow after rain in daytime), rain particles around the camera, wind direction/strength (updates
  `ctx.uniforms.uWind/uWindStrength/uRain`). During the intro the storm is forced via `set()`.
  API: `{ rain (0..1), cloudiness (0..1), wind: {x, z, strength}, airTempOffset (°C), set({rain?, cloudiness?, wind?, storm?, auto?}, transitionSec?), lightning() }`.

### B — Flora (flora.js)
Procedural low-poly vegetation, all with InstancedMesh, **chunked** (e.g. 64 m tiles) so frustum culling works.
- Tree types: oak, pine (highlands), birch, palm (beaches), willow (wet), apple tree, chestnut tree, dead snag.
  Procedurally generated variety (several mesh variants per type, random scale/rotation/tint).
- Wind sway via `material.onBeforeCompile` with `ctx.uniforms.uTime/uWind/uWindStrength` (also patch the depth material for shadows, or accept static shadows).
- Undergrowth: ferns, decorative bushes, grass (dense instanced grass near the player, re-centered as they move), flowers in meadows that
  **open by day and close at night** (scale/tilt by `ctx.time.daylight`), reeds near water, boulders (with colliders).
- **Plant growth**: saplings that visibly grow over in-game days into small trees; flowers that bloom.
- **Falling trees**: every so often (more in wind/storms) an old/dead tree near (but not on) the player creaks
  (`tree:falling`) and topples with a physical-looking rotation; it hurts the player if it lands on them
  (`ctx.stats.damage(30,'tree')`). The fallen log stays and registers an interactable
  "Gather wood from fallen tree" (wood ×4, `ctx.inventory.add`), then decays away.
- Tree trunks register colliders. No trees on beaches except palms; none in water, on rock, on the summit plateau, near the
  spawn (8 m) or inside `meadow` cores.
- API: `{ trees: [{ x, z, y, type, height, trunkR, crownR, alive }], canopyAt(x,z) → 0..1 (shade/cover from the sky),
  nearestTree(x,z,maxDist,filter?) }`. `trees` must be filled in `create()` or `init()` (C reads it in its init).

### C — Resources & Fauna (resources.js, fauna.js)
- **resources**: every harvestable object, with a small low-poly mesh and an `interact.register` entry. Pick up →
  `ctx.inventory.add(id, n)`, `harvest` event, audio `pickup`. Plants **regrow** after 1–2 in-game days (shrink to a sprout,
  then grow back). Placement by biome:
  - sticks/branches → wood (forest floor, plentiful), stones (riverbeds, beaches, highlands),
    **flint** (dark glassy, riverbeds + beach, ~14), **pyrite** (brassy, metallic sparkle, highlands/rocky/summit, ~12). Make sure
    at least 2 flint and 2 pyrite are within ~120 m of the spawn so fire is reachable on day 1.
  - berry bushes (forest edges), wild apples under apple trees, chestnuts under chestnut trees, coconuts under palms,
    chanterelles in shady forest (with toadstools nearby as the trap), wild yam vines (forest floor), cattails at the water's edge,
    nettles (forest edges), tall grass → fiber (meadows), leafy shrubs → leaves, **bamboo grove** at `landmarks.bambooGrove`
    (cutting needs flint: otherwise toast "You need something sharp, like flint").
  - medicinal: aloe (sunny beaches/dry), yarrow + chamomile (meadows).
  - The wreck crates are F's; do not place them.
  - API: `{ spawnItem(id, x, z, n?) }` (a dropped pickup).
- **fauna** (decorative, never hunted): butterflies (day, near flowers/meadows; instanced flapping wings), **fireflies** (night,
  near water + meadows, blinking additive Points), birds (flocks circling by day; scatter when the player sprints near),
  dragonflies over water by day, fish shadows in the lake, frogs croaking at night (call `ctx.audio`). API: `{}`.

### D — Player & Survival (controller.js, stats.js, model.js)
- **controller**: first-person. Mouse look (pointer lock; `CONFIG.player.mouseSensitivity`), WASD/ZQSD, **sprint** (Shift,
  costs energy; impossible when exhausted until energy ≥ `energyResumeSprintAt`, then you walk at `exhaustedSpeed` while energy is 0),
  **jump** (Space, costs energy, not when exhausted), gravity × `ctx.flags.gravityScale`, ground from `ctx.world.heightAt`,
  slope sliding on very steep ground, colliders via `ctx.colliders.resolve` (step up ≤ 0.45 m), head bob + footstep events
  (`player:footstep` with surface from biome), fall damage, world boundary (`CONFIG.world.boundary`: currents push back + toast).
  **Swimming** when water depth at the feet > `CONFIG.player.swimDepth`: bob at the surface, Space = swim up, slower, energy drain,
  and when energy hits 0 in deep water the head sinks under (breath drains → drowning). Underwater camera when the head is below the surface.
  API: `{ position (feet, Vector3), velocity, yaw, pitch, onGround, inWater, waterInfo, swimming, headUnderwater, sprinting,
  moving, teleport(x,z,yaw?), eyePosition(out), lookDir(out), enabled }`.
- **stats**: health, thirst, hunger, energy, heat (body warmth 0..100, comfortable 40..75), wetness (0..1), breath, poison, nausea.
  Pure math in `model.js` (unit-testable with node). Environment: air temperature from time of day (cold night, warm afternoon),
  weather (rain −, wind −), sun exposure (`ctx.time.daylight × (1 − ctx.flora.canopyAt)` × (1 − cloudiness·0.7)), wetness
  (strong cooling; swimming → 1, rain → up unless sheltered, dries faster in sun/near fire), fire warmth from `ctx.heatSources`
  (sets `ctx.flags.nearFire`), shelter (`ctx.shelters` → `ctx.flags.sheltered`), sprinting warms. The start state is cold and wet
  (`CONFIG.stats.start`), so the morning sun should bring heat into the comfort zone within ~2–3 in-game hours unless swimming.
  Damage when thirst/hunger hit 0, hypothermia, heatstroke, drowning, poison. Health regenerates slowly when needs are met.
  Emits `stats:warning` (rate-limited) and `stats:died` once. Seawater: `applyEffects({thirst:-8, health:-2})` via E.
  `sleep(hours)` → fades out (`ctx.fade`), `ctx.time.skipHours`, restores energy, drains thirst/hunger at 50 % rate for the
  skipped hours, sets heat depending on fire/shelter, emits `stats:sleep`.
  API: `{ values: {health, thirst, hunger, energy, heat, wetness, breath}, max, applyEffects(effects, source?),
  damage(amount, cause), drainEnergy(n), exhausted, dead, deathCause, env: {airTemp, sun, wind, fire, sheltered}, sleep(hours) }`.

### E — Gameplay & UI (inventory.js, crafting.js, structures.js, hud.js, hud.css)
- **inventory**: counts per item id, hotbar (9 slots auto-filled with owned items, scroll/1-9 to select), `F`/right-click = use
  the selected item: eat/drink/medicine → `ctx.stats.applyEffects(ITEMS[id].effects)`, give `returns`, `item:consumed`,
  `flare` → `flare:fired` event (F renders it), `torch` → toggle torch. Drinking provider (`interact.addProvider`): looking at /
  standing in water within reach → "[E] Drink" (fresh: thirst +12 per sip; ocean: "Drink seawater" → thirst −8, health −2, warning
  toast), "[R] Fill canteen" when you have `bottle_empty` and the water is fresh.
  API: `{ add(id,n=1) → n added, remove(id,n=1) → bool, count(id), has(id,n=1), list() → [{id,n}], selected (id|null), select(i) }`.
- **crafting** (Tab/C panel): recipes with requirements, greyed when missing, a craft button. Placeables are placed ~2.5 m in front of
  the player on valid ground (not in water, slope < 0.35). Recipes:
  - Bamboo Canteen: bamboo 1 + fiber 2 → bottle_empty · Rope: fiber 4 → rope · Torch: wood 1 + fiber 1 (or cloth 1) → torch
  - Campfire (place): wood 3 + stone 4, **needs flint + pyrite in inventory (not consumed)**
  - Signal Fire (place): wood 8 + leaves 5, needs flint + pyrite, must be in the open (`ctx.flora.canopyAt < 0.35`)
  - SOS Sign (place): stone 10, must be on sand (`biome.sand > 0.5`); giant S-O-S of stones on the beach
  - Lean-to Shelter (place): wood 6 + leaves 6 + (rope 1 or fiber 3)
  - At a lit fire only: Herbal Tea (yarrow 1 + chamomile 1 + bottle_water 1), Nettle Soup (nettle 2 + bottle_water 1)
- **structures**: campfire (flames with flicker shader, PointLight with shadow off, smoke particles, embers; fuel hours from
  CONFIG.fire, `[E] Add wood`, `[R] Cook N items` cooks all COOKABLE items at `cookSeconds` each; rain shortens fuel; out of fuel
  → `fire:out`, can be relit with flint+pyrite), signal fire (big pyre; tall dense white smoke column visible from far; adding leaves
  boosts smoke for 1 h), SOS sign, lean-to (shelter radius 3: `[E] Sleep until morning` (only 19:00–05:00, near a fire or in a
  shelter) → `ctx.stats.sleep(...)`), held torch (camera-attached mesh + flickering PointLight, burns 4 game hours).
  Register heat sources, signals and shelters in the ctx Sets. Signal strengths (m): signal fire smoke 650 by day / 500 at night,
  campfire 120 by day / 350 at night, SOS 220 (daylight only), torch 160 at night only.
- **hud** (DOM, `#hud`): bars for Health ❤️, Thirst 💧, Hunger 🍃, Energy ⚡ and Heat 🌡️ (Heat as a gauge with the comfort zone
  marked; blue when cold, red when hot), wet 💦 / sheltered / near-fire status icons, breath bubbles when submerged, compass strip
  (top), day + clock with sun/moon (top-right), hotbar (bottom), crosshair + interaction prompt, toasts (stack, right), subtitles
  (bottom-center, for story), one-time hints (tutorial: first drink, fire, food…), low-health red vignette, cold frost vignette,
  damage flash, nausea/poison wobble. Panels: crafting (Tab/C), journal (J: survival tips, plants discovered and whether they're
  safe, easter eggs found x/N), map (M: canvas top-down render of `ctx.world` heights with explored-area fog of war, player arrow,
  discovered landmarks). Death screen (cause, time survived, "Try again" → reload) and win screen (rescued! days survived,
  stats_summary, easter eggs found). Opening a panel: `menuOpen = true`, `ctx.input.unlock()`; closing: `menuOpen = false` and
  `ctx.input.lock()` **inside the keydown handler** (`ctx.input.onKeyDown`) so pointer lock is allowed.
  API: `{ menuOpen, setVisible(b), toast(text, {icon?, kind?:'info'|'good'|'warn'|'bad'|'story', duration?}), setPrompt(lines|null)
  (lines = [{key:'E', label}]), subtitle(text, seconds?), hint(id, text), flash(color, seconds), showDeath(info), showWin(info),
  markJournal(entryId, data?) }`.

### F — Story & Audio (intro.js, rescue.js, eastereggs.js, audio.js, models.js)
- **intro** `play()` → Promise (≈25 s, skippable with Space/Enter/Escape, show "Space to skip"): pre-dawn storm at sea (call
  `ctx.weather.set({storm:true})`, `ctx.time.setHour(CONFIG.time.introHour)`), the procedural fishing boat (models.js) pitching in
  waves near `landmarks.wreck`, lightning, it hits the reef, camera shake, fade to black, subtitles ("…the engine died…",
  "…the boat hit something…"), then fade in to the camera lying on the beach at the spawn, blinking awake and getting up to the
  player's eye height. Restore weather (`set({storm:false, auto:true})`), `letterbox` on/off, then emit `intro:done` and resolve.
  The wreck (broken hull on the reef) stays in the world permanently. Beach debris at `crate1` (searchable crate: rope 1 + cloth 2;
  the canteen is NOT in the crate, it must be crafted) and `crate2` (flare 1), as interactables.
- **rescue**: the search schedule from `CONFIG.rescue.passes` (absolute game hours) plus repeats. Each pass: a procedural helicopter
  (rotating rotors, spotlight at night) or a search boat flies/sails a route across/around the island (closer routes for higher
  `closeness`); `rescue:passStart`, the audio rotor loop, toast "You hear a helicopter!". While it's active, accumulate an
  **attention** meter from: distance to the player when in the open (`canopyAt < 0.4`), waving (G, sets `ctx.flags.waving`; best
  on beaches/summit), active `ctx.signals` within their strength radius of the vehicle (signal-fire smoke is the best, SOS by day,
  campfire/torch at night, flare = instant huge boost within 700 m). When attention ≥ `CONFIG.rescue.spotThreshold` →
  `rescue:spotted`: the vehicle turns toward the player, hovers/approaches (cinematic: `flags.cinematic`, letterbox, the camera
  looks up at it), subtitles, fade → emit `rescue:success` with `{ method, passes }`. Missed pass → toast with a hint
  ("They didn't see you… a signal fire's smoke is visible for miles"). Passes during sleep are missed (`time:skip`).
  The flare (on `flare:fired`): a red rocket + glowing smoke trail + a red light for ~8 s.
  API: `{ activePass, nextPassHours(), debugStartPass(kind) }`.
- **eastereggs** (7, each with a toast + `easter:found` + journal entry; see the list in §7).
- **audio**: WebAudio, 100 % procedural (noise buffers, oscillators, filters, envelopes). `resume()` on the first click.
  Ambient beds that crossfade by context: ocean waves (louder near the coast, `ctx.world.coastDistance`), wind (weather), daytime
  birdsong (synth chirps), night crickets + frogs near water, rain, thunder, river/stream babble near the river, fire crackle
  near `ctx.heatSources`, helicopter rotor (positional), underwater muffle (lowpass when `ctx.player.headUnderwater`).
  One-shots: footstep_{sand,grass,rock,water}, jump, land, splash, pickup, craft, eat, drink, hurt, ignite, tree_creak, tree_crash,
  gasp, quack, chime (easter), ui_click, ui_open, heartbeat (loop when health < 25), flare.
  API: `{ resume(), play(name, {volume?, position?: Vector3, rate?}), setLoop(name, volume, position?), setMasterVolume(v), muted }`
  (N toggles mute).

---
## 7. Easter eggs (F owns them unless noted)
1. **Message in a bottle**: a bottle bobbing at `bottleBeach`; it reads a note from a previous castaway hinting at their camp to the north.
2. **The castaway's camp** at `castawayCamp`: a collapsed lean-to, a tally-marked rock ("43 days"), and a volleyball with a
   painted face and handprint. The note says they were rescued thanks to a signal fire. Gives 2 rope + a journal page.
3. **Stone circle** on the summit plateau: standing stones that glow at night; standing in the middle between 22:00 and 03:00
   triggers a meteor shower + aurora for a minute, restores energy, +15 health, "The island seems to watch over you."
4. **The golden butterfly**: a rare glowing golden butterfly in the meadow at dawn (05:30–08:00). If the player walks up to it
   it lands on their hand, then grants a permanent +10 % rescue attention.
5. **Konami code** (↑ ↑ ↓ ↓ ← → ← → B A): "Moon gravity" for 60 s (`ctx.flags.gravityScale = 0.3`).
6. **Carved initials**: a tree at `carvedTree` with "A.R. ♥ this island" carved in the bark (canvas texture). The player's initials.
7. **Rubber duck** floating on Mirror Lake at `landmarks.duck`; it quacks (audio), and quacks back from somewhere else.

---
## 8. Debug (`window.__game` = ctx; `ctx.debug`)
`?debug=1` shows FPS/pos/time, never auto-pauses on pointer-unlock (automation-friendly). `?skipintro=1` starts playing immediately.
`__game.debug`: `setHour(h)`, `skip(h)`, `speed(s)`, `teleport(x,z,yaw?)`, `goto(landmarkName, dx?, dz?)`, `give(id,n)`, `god(on)`,
`hold(code,s)`, `tap(code)`, `look(yaw,pitch)`, `weather(opts)`, `rescuePass(kind)`, `stats()`, `start()`, `state()`, `landmarks()`, `errors()`.

---
## 9. Art direction & performance
Stylized low-poly with flat-ish shading (MeshStandardMaterial roughness ≥ 0.8 or MeshLambertMaterial), vertex colors, warm
golden mornings, saturated greens, teal shallows → deep blue, pinkish dusk, dark-blue nights. Palette: sand #e8d6a8, wet sand
#c9b48a, grass #6a9a3e, meadow #8fb84f, forest floor #4a6430, rock #8a847a, dark rock #5d5750, oak leaves #4f8a35, pine
#2f5d3a, birch leaves #93bd4c, palm #6fa33c, bark #6b4f36, birch bark #e8e4da, shallow water #3fb7c4, deep #1d5f8a.
Target 60 fps on a laptop: InstancedMesh everything that repeats, chunk for frustum culling, merge static geometry, ≤ ~250 draw
calls, one shadow-casting light, particles as Points/instanced quads, no per-frame allocations in hot loops (reuse
vectors), and no `new THREE.Material` per object.

**Three r187 notes:** use `THREE.PCFShadowMap` (PCFSoftShadowMap was removed); `THREE.Clock` is deprecated (use `ctx.time`);
color management is on: set `texture.colorSpace = THREE.SRGBColorSpace` for color canvas textures; light intensities
are physical (DirectionalLight ~2–4, Hemisphere ~0.5–1.5). Imports: `import * as THREE from 'three'` and
`import { Sky } from 'three/examples/jsm/objects/Sky.js'` etc. `simplex-noise` v4: `import { createNoise2D, createNoise3D } from 'simplex-noise'`.

---
## 10. Update v2 (2026-11-07): difficulty, the boat-repair goal, diving, harsher survival
New in core (orchestrator): `CONFIG.difficulty` presets (easy/medium/hard), `CONFIG.raft` (plans + part placement),
`CONFIG.keys.dive` (X), new items in `src/core/items.js` (tools: shovel, pickaxe, diving_mask; parts: hull_plank, mast_pole,
rudder, compass, fuel_can, spark_plug, engine_block, propeller; `PARTS` export), title-screen difficulty picker.

**`ctx.difficulty`** = `{ id: 'easy'|'medium'|'hard', label, thirstMul, hungerMul, damageMul, regenMul, earlyDamageBelow,
earlyDamagePerSec, nightChillPerDay, plan }`. It always exists (main sets a default before create), and the title screen may change
it before `game:start` (event `difficulty:set`). **Read it lazily** (in update or on `game:start`), never cache it in create.

**Win conditions:** `rescue:success` (search party) OR `raft:sailed` {plan, day} (boat rebuilt and launched). Main shows the win
screen with `method: 'raft'` for the latter.

### Ownership (v2)
| builder | files | job |
|---|---|---|
| V2-A tweaks | src/nature/resources.js (+res/*), src/survival/model.js, src/survival/stats.js, tests/survival.test.mjs, src/audio/beds.js (+audio.js wind only) | pyrite 15% from stones, easier leaves, pick apples/chestnuts from the trees, difficulty rules + thirst-0 death + nights colder every day, diving-mask breath bonus, quieter/varying forest wind |
| V2-B raft | src/gameplay/raft.js (+ src/gameplay/raft-*.js), tests/raft.test.mjs, docs/build-log/V2-B-raft.md | parts in the world (beach / buried / rock / underwater), dig/break/grab interactions, build site + staged visual boat, build time, launch cutscene, `raft:sailed` |
| V2-C dive+UI | src/player/controller.js, src/gameplay/recipes.js (+crafting.js if needed), src/gameplay/inventory.js, src/ui/hud*.js + hud.css | dive controls, tool recipes, objective tracker, rescue attention meter + vehicle on compass, journal Boat tab, win text for 'raft' |

### `ctx.raft` API (V2-B implements, V2-C displays)
```js
ctx.raft.plan            // CONFIG.raft.plans[ctx.difficulty.plan] (+ id)
ctx.raft.stageIndex      // 0..stages.length (== length when complete)
ctx.raft.complete        // all stages built
ctx.raft.site            // THREE.Vector3 of the build site (spawn beach)
ctx.raft.objective()     // { title, stageIndex, stageCount, stageLabel, needs: [{ id, have, need }], ready, complete, hint }
ctx.raft.parts()         // [{ id, where: 'beach'|'buried'|'rock'|'underwater', found: bool, position: Vector3 }] (map/journal)
ctx.raft.debugGiveAll(), ctx.raft.debugComplete()
```
Events: `raft:part` {id, where} (picked up), `raft:stage` {stageIndex, stage}, `raft:complete`, `raft:sailed` {plan, day}.
Tools: digging a `buried` part needs `shovel` in the inventory, breaking a `rock` part needs `pickaxe`, and `underwater` parts lie on the
seabed 3–8 m deep near the wreck. Grab them by diving (X) close enough; interact uses the camera position, so it works underwater.

### Diving (V2-C, controller)
While swimming, holding **X** dives (descend ~1.5 m/s, horizontal swim speed ×0.85). **Space** rises, and releasing both lets you float
up gently. The breath meter drains while the head is under; with `diving_mask` in the inventory it drains ×0.5 (V2-A, stats).
Expose `ctx.player.diving` (bool) and `ctx.player.depth` (m below the surface, eye). Energy drain while diving = swim rate.

### Tool recipes (V2-C, recipes.js)
Shovel: wood 2 + stone 1 + rope 1 · Flint Pickaxe: wood 2 + flint 1 + rope 1 (keeps 1 flint so fire still works only if the player
has 2, so warn) · Diving Mask: bamboo 1 + cloth 1 + rope 1.

---
## 11. Update v3 (2026-11-13): Tempest Isle, travel by water, harsher rules
Core (orchestrator, done): Tempest Isle terrain in `src/world/heightfield.js`, a second grid merged into every query.
- `ctx.world.isle2` = `{ id:'isle2', name:'Tempest Isle', x:660, z:-640, R:150, half, x0, z0, cell, cells, N1, toMain, heights, peak:{x,z,height≈100,plateauR:9} }`
- `ctx.world.grids` = `[{ id:'main'|'isle2', heights, x0, z0, cell, cells, N1 }]`; `buildGeometry('isle2')` builds the second terrain mesh.
- `ctx.world.islandAt(x,z)` → `'main'|'isle2'|null`; `ctx.world.isle2ness(x,z)`; `randomLandPoint(rng, filter, maxTries, 'isle2')`.
- heightAt/waterAt/biomeAt/coastDistance/slopeAt cover both islands. `lakes` has a third entry `{id:'isle2pond', island:'isle2'}`
  (every lake has `island`).
- Landmarks: `isle2` (center), `isle2Cove` (landing beach), `isle2Dock` {x,z (on the beach at the waterline), dirX, dirZ (seaward),
  length 18 (end depth ~3 m)}, `isle2Hut` (summit plateau, y≈100), `isle2Pond`, `launchBeach` (main-island beach facing the isle,
  525 m of sea to the cove).
- Config: `CONFIG.isle2` (storms), `CONFIG.vehicles`, `CONFIG.palmDeathChance` 0.05, `stats.start.thirst` 45,
  difficulty `rescueMul` (1 / 0.3 / 0) and `flareRange` (700 / 250 / 0), `CONFIG.raft.parts.compass.where = 'isle2hut'`.
- Items: paddle, fishing_rod, boat_key, banana, old_boot.
- New systems (main order: …raft, **isle2**, **vehicles**): `src/isle2/isle2.js` → `ctx.isle2`, `src/gameplay/vehicles.js` → `ctx.vehicles`.

### Ownership (v3)
| builder | files |
|---|---|
| V3-A world+rules | src/world/terrain.js, water.js, sky.js, weather.js (+world/fx/*), src/gameplay/structures.js (storm douse only), src/story/rescue.js + rescueLogic.js, src/nature/res/treeHarvest.js |
| V3-B isle content | src/isle2/* (new), src/nature/flora.js + flora/*, src/nature/resources.js + res/* (NOT treeHarvest.js), src/gameplay/raft-parts.js |
| V3-C vehicles+HUD | src/gameplay/vehicles.js (+vehicle-*.js), src/player/controller.js, src/gameplay/recipes.js + crafting.js, src/gameplay/raft.js + raft-logic.js, src/ui/hud*.js + hud.css |

### Contracts between them
- **Weather (A)**: `ctx.weather.stormAt(x,z)` → 0..1 local Tempest Isle storm intensity; `ctx.weather.hailAt(x,z)` → 0..1;
  `ctx.weather.isle2Storm` = `{ active, intensity, endsAtHours }`; events `isle2:stormStart` / `isle2:stormEnd`. The existing global fields
  (`rain, cloudiness, wind, storm, airTempOffset`) describe the weather **at the camera**, so the local storm is folded in there.
  Audio, stats and particles then follow automatically.
- **Indoors (B)**: the fishing hut adds `{ position, radius, indoor: true }` to `ctx.shelters`. `ctx.isle2.isIndoors(pos)` → bool.
  Storms douse every lit fire/torch whose position is not indoors (A, in structures.js). Hail hurts only when not indoors/sheltered.
- **Motorboat (B → C)**: `ctx.isle2.motorboat` = `{ object: THREE.Object3D, position: Vector3, heading (rad, yaw convention), moored: bool }`.
  B builds it moored at the dock end. C makes it rideable (needs `boat_key`, and one `fuel_can` used on the first start).
- **Hut parts (B → C)**: `ctx.isle2.partsInHut()` → `[{ id, taken }]` for raft parts whose `where === 'isle2hut'` (C shows them in raft.parts()
  with `where:'isle2hut'`). Searching the hut gives fishing rods, the boat key, a fuel can, and the plan's isle2hut parts.
- **Vehicles (C)**: `ctx.vehicles.current` = null | `{ type:'paddle_raft'|'motorboat'|'boat', object, speed }`. While aboard, `ctx.player.aboard`
  is the vehicle, the controller skips walking/swimming physics, and the currents/boundary don't apply. Rafts and sail boats can
  **capsize** in `stormAt > 0.5` (CONFIG.isle2.capsizePerSec × intensity): the player is thrown into the water, and the raft drifts upside
  down until it is righted ([E] when stormAt < 0.3). Motorboat win: driving out to open sea away from both islands (> 1300 m from the
  main center, or [R] "Head for home" when > 250 m off any coast) → `raft:sailed` {plan:'motorboat_dock', name:"the fisherman's motorboat", day}.
- **Death causes (C shows)**: 'coconut' (A, treeHarvest), 'hail' (A, weather), 'fire' (B: standing in the burning hut).

---
## 12. Update v4 (2026-11-20): cinematics, secrets, fishing, multiplayer groundwork, polish
Core (orchestrator, done): fish items (`raw_fish`→`grilled_fish`, `big_fish`→`grilled_bigfish`, `crab`→`cooked_crab`; all cook at a
campfire through the existing COOKABLE path), coconut nerfed (hunger 7, thirst 14), `CONFIG.fishing`, `CONFIG.net`, keys `reel`
(Space/Mouse0), `chat` (Enter), `scoreboard` (P); new systems `ctx.fishing` (src/gameplay/fishing.js, after vehicles) and `ctx.net`
(src/net/net.js, always-on, last); a hidden multiplayer panel `#mp` in the pause overlay (index.html, styles in style.css) with
`#mp-name #mp-server #mp-create #mp-room #mp-join #mp-leave #mp-status #mp-players`.

### Ownership (v4, wave 1)
| builder | files |
|---|---|
| V4-A cinematics+secrets | src/story/* (intro.js, introSea.js, fx.js, models.js, overlay.js, eastereggs.js, egg*.js, NEW summitShot.js, causeway.js), tests/story*.test.mjs |
| V4-B multiplayer | src/net/* (NEW), src/player/avatar.js (NEW), server/* (NEW), docs/MULTIPLAYER.md; ID/apply hooks only in src/nature/resources.js, src/gameplay/structures.js, src/gameplay/raft.js |
| V4-C fishing+HUD | src/gameplay/fishing.js, src/isle2/isle2-fishing.js (retire into fishing.js), the fishing hook in src/isle2/isle2.js, src/ui/hud*.js + hud.css, src/gameplay/inventory.js |

### Ownership (v4, wave 2, after wave 1 lands)
| V4-D aesthetics+wind | src/world/* (+fx), src/audio/beds.js (wind), the wind model in src/world/weather.js (+fx/weatherModel.js) |
| V4-E optimization | src/nature/flora/* + flora.js, src/nature/fauna.js + res/fauna*.js, instancing/culling in src/nature/resources.js, scripts/perf.mjs |

### Contracts
**Intro (A):** the boat must stay rigid through the crash (hull/cabin/mast stay one group; shake and tilt the group), and the camera
rig must be attached to the boat's transform so it never falls through the deck or below the sea. After impact: hard cut/fade, never
free fall. "Make it pop": a wave crest at impact, spray burst, flying planks, the swinging lamp, lightning synced with the impact.

**Summit survey (A, `src/story/summitShot.js`):** the first time the player stands on the summit plateau (within landmarks.summit.r)
→ a ~14 s skippable cinematic: the camera lifts off, does a slow 360° orbit of the main island at ~150 m altitude looking slightly down
(Tempest Isle visible in the distance), a title card ("DRIFTWOOD ISLE · day N"), then swoops back into the player's eyes. Sets
`ctx.flags.cinematic`, `ctx.letterbox`, restores camera/yaw/pitch exactly, re-locks the pointer (call `ctx.input.lock()` from the
skip keydown when possible). Replay: `[E] Survey the island` registered at the center of the stone circle, always available; during the
circle's aurora/meteor shower the shot keeps those effects running (they are in eastereggs.js: expose `ctx.eastereggs.showActive`).
Emits `summit:survey` {first}. Must never run while aboard a vehicle, dead, or in another cinematic.

**Rune puzzle (A):** at night (22:00–05:00) each of the 7 standing stones shows a distinct rune glyph (canvas texture) and offers
`[E] Touch the rune` toggling its glow (chime). The solution = a seeded set of 4 stones; three clues in the world: 4 small glyphs under
the initials on the carved tree, a scratched glyph row on the castaway camp's tally rock, and a logbook page in the fishing hut ("the four
that face the storm…"). Found clues appear in the journal (ctx.ui.markJournal('clue:…')). Wrong set lit for > 3 s → the glows fade with a
low rumble. Correct set → **The Giant's Road** (`causeway.js`): a 30 s cinematic (stones blaze, a beam, the sea pulls back along a line),
then a stone causeway ~3 m wide rises ~0.7 m above sea level from landmarks.launchBeach to landmarks.isle2Cove (a merged mesh of slabs
with gaps/puddles + a chain of ctx.colliders with y1 at the deck so it is walkable; permanent), `easter:found` id `causeway` ("The Giant's
Road"), a big achievement toast, journal entry. Rafts/boats must not collide with it fatally (C: vehicles treat the causeway colliders as
walls, tag 'causeway'). **Bella bottle (A):** a second message in a bottle on a different beach: text exactly
"My heart longs for you. I love you Bella" (egg id `bella`). `ctx.eastereggs.total` becomes 9; HUD/journal must read the total from
`ctx.eastereggs.total` (C), never a literal 7.

**Fishing (C, `ctx.fishing`):** with a `fishing_rod`, looking at any ocean/lake/river water from land, a dock or a raft → `[R] Cast the
line` (or E when free). The float lands with a plop; wait `CONFIG.fishing.biteMinSec..biteMaxSec` (real seconds, with small nibbles as
false alarms); a BITE: the float dips, a "!" + sound, press `reel` (Space/click) within `hookWindowSec` or it's gone; then the FIGHT:
tap reel to add progress (`reelTapGain`) and tension (`tensionPerTap`), tension relaxes over time; progress drains while the fish runs;
tension ≥ 1 snaps the line (lose the fish, 15 % chance to lose the rod on the biggest fish); a timer runs out → the fish escapes;
progress ≥ 1 → landed: loot by `CONFIG.fishing.loot` (bigger fish = longer fight), toast with the catch, 'harvest' {kind:'fishing'}.
API `{ active, phase:'idle'|'waiting'|'bite'|'fight'|'landed'|'lost', progress, tension, timeLeft, cast(), reel(), cancel() }`; the HUD
shows a tension/progress widget under the crosshair. Movement cancels the cast. The old isle2-fishing.js logic is retired (keep its lore
bottle as a rare catch). Cooking: the campfire already cooks every COOKABLE item.

**HUD overlap (C):** toasts never overlap: one column, measured heights, at most 4 visible, same-key merge; the objective tracker,
hint box, storm/rescue banners, vehicle panel, subtitle, prompt and fishing widget get distinct non-overlapping zones at 1280×720 and
at 1920×1080; subtitles sit above the hotbar; the chip row never collides with the bars. The title screen stays exactly as it is.

**Multiplayer (B):** fully optional; offline when `CONFIG.net.defaultServer` and `?server=` are empty, but the panel still shows (Leave
hidden). `ctx.net` = `{ mode:'offline'|'host'|'client', connected, id, name, room, isHost, players: Map<id,{id,name,pos:Vector3,yaw,pitch,
state:{moving,sprinting,swimming,aboard,waving,torch}}>, create(name, server), join(code, name, server), leave(), send(type, payload),
on(type, fn), chat(text) }`. Events: `net:connected` {id, room, isHost}, `net:disconnected`, `net:playerJoined` {id,name},
`net:playerLeft` {id}, `net:chat` {id, name, text}. Protocol (JSON over WebSocket, `src/net/protocol.js` shared with the server):
`hello{name,room?}` → `welcome{id,room,isHost,players,seed,difficulty,timeHours}`, `state{pos,yaw,pitch,state}` at `tickHz`, `snapshot{players}`
from the server, `event{name,payload}` relayed to everyone else, `chat{text}`, `ping/pong`. The host's difficulty wins: a joiner on a
different difficulty switches (`ctx.debug.difficulty(id)` exists) with a toast. Shared world: the host's clock is authoritative (`time:set`
every ~10 s, soft-corrected); these events are relayed and applied remotely **without re-emitting** (loop guard): `harvest` (resources
need a stable per-instance id: expose `ctx.resources.hideById(id)` / instance ids on the harvest payload), `structure:placed`
(`ctx.structures.placeAt(type,x,z,yaw)`), `fire:lit`/`fire:out` (by structure id), `food:cooked`, `raft:stage`, `tree:fell`, `flare:fired`,
`easter:found` (shared: anyone finding = everyone), `rescue:success` / `raft:sailed` (everyone wins together). Remote players render with
`src/player/avatar.js` `createAvatar(ctx,{name,color})` → `{ object, setTarget(pos,yaw,pitch,state), update(dt), dispose() }`: a low-poly
procedural castaway (~700 tris: torn shirt, shorts, hair, skin tone/shirt color from the id), procedural idle/walk/run/swim/wave/paddle
animation, a canvas name tag that fades beyond 120 m, interpolated `CONFIG.net.interpolationMs` behind. Chat: Enter opens a small input
(unlocks the pointer; Esc/Enter closes and re-locks), messages above the hotbar for 8 s; P shows the player list. `server/`: a plain Node
`ws` server (no DB): rooms by 6-letter code, host = first player, ≤ maxPlayers, relays state/events, 20 Hz snapshots, drops idle
sockets, `PORT` env, a `Dockerfile` + `fly.toml`, and `docs/MULTIPLAYER.md` (how to run locally with two tabs, how to deploy on Fly.io
/ Railway, costs). The URL params `?server=&room=&name=` auto-join after the title screen.
