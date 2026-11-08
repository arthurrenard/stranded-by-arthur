# 🏝️ STRANDED: Driftwood Isle

Your fishing boat, the *Marguerite*, went down on a reef during a pre-dawn storm. You wake up on an unknown forest island, cold,
soaked and alone. **Rebuild a boat from the wreckage and sail home, or get spotted by the search party.**

A first-person 3D survival game in the browser, built with Three.js. Everything is procedural: the island, trees, plants,
animals, the boat, the helicopter, textures, and every sound effect. There are no asset files.

## ▶️ Play it online

**https://arthurrenard.github.io/stranded-by-arthur/**

It runs in any desktop browser with WebGL (Chrome, Edge, Firefox or Safari) and needs a keyboard and mouse. Every push to `main`
rebuilds and redeploys it through GitHub Actions (`.github/workflows/deploy.yml`).

## How to run locally

You need [Node.js](https://nodejs.org) 20.19+ or 22.12+ (required by Vite 8).

```bash
git clone https://github.com/arthurrenard/stranded-by-arthur.git
cd stranded-by-arthur
npm install
npm run dev
```

Open **http://localhost:5173** and click **Click to begin**. Headphones recommended.

- **Production build:** `npm run build`, then `npm run preview` (serves the `dist/` folder).
- **Checks:** `npm run check` (syntax-checks and imports all 77 source files, then runs the 8 unit-test suites).
- If `npm install` fails with `EACCES` on `~/.npm`, use a fresh cache: `npm install --cache /tmp/npm-cache-stranded`.

## Controls

| Key | Action |
|---|---|
| **W A S D** (or **Z Q S D** on AZERTY, arrows) | Move |
| **Shift** | Sprint (costs energy) |
| **Space** | Jump (costs energy) · swim up / keep your head above water |
| **X** (hold, in water) | Dive (a diving mask lets you hold your breath twice as long) |
| **E** / left click | Interact (pick up, drink, search, add wood, read…) |
| **R** | Secondary action (cook, fill canteen…) |
| **F** / right click | Use the selected item (eat, drink, fire the flare…) |
| **1–9** / mouse wheel | Select a hotbar slot |
| **Tab** / **C** | Crafting |
| **J** | Journal (survival tips, plants discovered, secrets) |
| **M** | Map (fog of war reveals as you explore) |
| **T** | Light / stow a torch |
| **G** (hold) | Wave your arms at the search party |
| **N** | Mute |
| **Esc** | Pause (mouse sensitivity and volume sliders) |

## Quick survival guide (spoiler-light)
1. **Get dry and warm.** You start soaked and chilly. Stand in the morning sun on the beach; wet clothes chill you much faster.
2. **Drink.** Spring Pond is just inland from where you wake up. Lakes and rivers are fresh water, but the ocean is not.
   Craft a **bamboo canteen** to carry water.
3. **Find flint and pyrite.** Flint is dark and glassy, found on beaches and riverbeds. Pyrite is brassy fool's gold, found on rocky
   ground. Struck together they make sparks. Gather **wood** and **stones** for a **campfire**.
4. **Eat plants, and cook them.** Cooked food is about 2–3× more nourishing. Some mushrooms are deadly, so learn which ones (journal).
5. **Get seen.** Search passes start on the afternoon of day 1 and come closer each day. Stay in the open (beach or summit), hold **G**
   to wave, build a **signal fire** (huge smoke column) or an **SOS sign** on the sand, and save the flare for when they're close.

## Difficulty and the main goal
Pick a difficulty on the title screen. Each one builds a more intricate boat from more parts:

| | Easy | Medium | Hard |
|---|---|---|---|
| Survival | the base rates | thirst ×1.35, health damage ×1.7, slower healing | thirst ×1.6, damage ×2.3; health drains when hunger or thirst drops below 30 |
| Nights | 1.5 °C colder each day | 2.6 °C colder each day | 3.6 °C colder each day |
| Boat | **Driftwood Raft**: 4 stages (hull, mast, sail, water) | **Outrigger Sailboat**: 7 stages, plus a buried rudder and compass | **Motor Launch**: 8 stages, plus an engine and propeller on the seabed, buried fuel, spark plugs inside a rock |

On every difficulty, reaching **0 health or 0 thirst kills you**, and hunger drops faster than before.

**How to rebuild the boat:**
- Parts are spread around the island. **Hull planks** and the mast wash up on beaches all around the coast.
- Some parts are **buried**: look for a sand mound marked with crossed sticks and dig with a **shovel** (wood 2 + stone 1 + rope 1).
- Some are **wedged in cracked, glinting rocks**: break them with a **pickaxe** (wood 2 + flint 1 + rope 1).
- Some lie **on the seabed by the wreck**: swim out and hold **X** to dive. Craft a **diving mask** (bamboo + cloth + rope) for longer breath.
- Bring everything to the **Boatyard** sign on the starting beach. Each stage takes a few in-game hours to build, by daylight only.
- When the boat is finished, launch it and sail home. The objective tracker (top-left) and **J → Boat** show what's missing and where to look.

## What's in the game

### Everything you asked for
- **Walk, sprint, jump.** Sprinting and jumping burn energy. At 0 energy you're forced to walk (and can't jump) until you recover.
- **Intro cutscene** (about 25 s, skippable with Space): the storm at sea, the reef, the crash, then you wake up on the beach at dawn.
  The wreck stays on the reef for the rest of the game.
- **A lively forest:**
  - ~3,400 procedurally generated trees of 8 kinds: oak, pine, birch, palm, willow, apple, chestnut and dead snags.
  - Swaying grass, ferns and reeds.
  - Meadow flowers that open by day and close at night.
  - **Butterflies** by day and **fireflies** at night.
  - **Plant growth:** saplings grow over the days and harvested plants regrow.
  - **Falling trees:** they creak, then topple. Don't be under one; the fallen log gives wood.
- **Survival stats:**
  - **Health**, **Thirst**, **Hunger**, **Energy** and **Heat**. Heat is body warmth, shown as a gauge with a comfort zone; too cold
    or too hot hurts.
  - Wetness and breath are also tracked.
- **Medicinal plants:** aloe, yarrow and chamomile restore health. Herbal tea, brewed at a fire, heals the most.
- **Water:** drink straight from the pond, lake or river, or craft a canteen and fill it.
- **Vegetarian food only:** blackberries, wild apples, chestnuts, coconuts, chanterelles, wild yam, cattail and nettles. **Cooking
  multiplies nutrition**, e.g. raw yam +6 → baked yam +32.
- **Cold, wet start:** you begin at heat 30, soaked. The morning sun dries you in about an hour and warms you into the comfort zone
  by about 8:30.
- **Dangerous swimming:** it drains energy fast. Run out in deep water and you sink: breath runs out and you drown. You get one
  second chance; a second exhaustion is usually fatal.
- **Fire:** scattered wood + stones + **flint and pyrite** ("two rocks that go together") → campfire.
- **Rescue:** a scheduled search party, by helicopter or boat, has to actually **see** you before you're rescued.
- **7 easter eggs** (see below).

### Extra mechanics I added
- **Day/night cycle:** 12 real minutes per day, with sunrise and sunset colors, stars, a moon and cold nights.
- **Weather:** clear and cloudy days, rain showers, rare thunderstorms with lightning, and rainbows after rain. Rain soaks you, chills
  the air and drains fires.
- **Visibility-based rescue:**
  - Passes get closer each day, and night passes use a spotlight.
  - An attention meter fills from being in the open, waving, and your signals: signal fire smoke, SOS sign, campfire or torch at
    night, and the flare.
  - The rescue cutscene: the helicopter hovers and drops a rope ladder, or a dinghy comes for you from the boat.
- **Crafting:**
  - Bamboo canteen, rope, torch.
  - Campfire (add wood, cook everything at once, relight it).
  - **Signal fire** (green leaves make extra-thick smoke).
  - **SOS sign** of stones on the beach.
  - **Lean-to shelter:** sleep through the night next to a fire, and it keeps the rain off.
- **Sleeping:** skip to morning to restore energy. Thirst and hunger still drain while you sleep, and you can sleep through a
  search pass.
- **Poisonous red toadstools** grow near the edible chanterelles. Eating one poisons you and makes you nauseous: wobbly green vision.
- **Seawater** makes you thirstier. **Fall damage.** **Ocean currents** turn you back at the edge of the world.
- **Torch:** light, a little warmth, and visibility at night. It burns out, and rain can put it out.
- **The beach crates** from the wreck: rope, sailcloth, and an **emergency flare**.
- **Map** with fog of war and discovered landmarks; **journal** with tips, a plant guide and the secrets you've found;
  **compass**; **day/clock**; tutorial **hints**; status chips (wet, warm by fire, sheltered, raining, waving).
- **Wildlife (all decorative, never hunted):** bird flocks that scatter when you sprint, gulls, owls, dragonflies, fish in the lake,
  frogs and lily pads.
- **Water rendering:** shore foam, rain ripples, and an underwater view with Snell's window.
- **Procedural soundscape:** surf louder near the coast, wind, birdsong, crickets, frogs, rain, river babble, fire crackle,
  positional helicopter rotor, an underwater muffle, and a heartbeat when you're hurt.
- **Win screen** with your stats: time survived, distance walked, items crafted, meals, plants gathered and secrets found.

### 🥚 Easter eggs (spoilers!)
<details><summary>Show the 7 secrets</summary>

1. **Message in a bottle:** bobbing at the east beach waterline. It hints at…
2. **The castaway's camp:** on the north beach: a collapsed lean-to, a rock with "43 days" tallied on it, and a volleyball friend
   with a painted face. Say hello for a gift.
3. **The stone circle:** on the summit plateau. Its runes glow at night. Stand in the middle between 22:00 and 03:00 for a meteor
   shower, an aurora, and a blessing.
4. **The golden butterfly:** only in the meadow at dawn (05:30–08:00). Walk up to it gently. It brings luck: +10% rescue attention.
5. **Konami code:** ↑ ↑ ↓ ↓ ← → ← → B A gives moon gravity for 60 s.
6. **Carved initials:** a big old oak east of Mirror Lake has *"A.R. ♥ this island"* carved in its bark.
7. **The rubber duck:** floating on Mirror Lake. Squeeze it, then listen.
</details>

## For developers
- **Debug mode:** `http://localhost:5173/?debug=1&skipintro=1` shows FPS, position and time, and never auto-pauses. `window.__game.debug`
  has `setHour(h)`, `goto('summit')`, `give('flint', 2)`, `god()`, `rescuePass('helicopter')`, `step(seconds)` (deterministic
  simulation, even in a background tab) and more (SPEC.md §8).
- **Architecture:** see `SPEC.md`. Every system is `create(ctx) → { init, update }`, wired together in `src/main.js`; all tunables live
  in `src/config.js`.
- **Resuming work:** `PROGRESS.md` (milestones), `docs/build-log/` (per-module notes), `docs/review-notes.md` (playtest log),
  and a zero-token code graph: `graphify query "…"` / `graphify explain "…"` / `GRAPHIFY_BACKEND=none graphify update .`.
