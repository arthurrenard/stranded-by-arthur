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
