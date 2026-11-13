// Every gameplay tunable lives here so balancing never needs a code hunt.
// Units: distances in meters, speeds in m/s, "perHour" = per in-game hour, "perSec" = per real second.
export const CONFIG = {
  seed: 20261106,

  time: {
    dayLengthSec: 720, // real seconds for one in-game 24h day (1 game hour = 30 real s)
    startHour: 6.15, // early morning, right after the intro
    introHour: 5.2, // pre-dawn storm during the crash cutscene
  },

  world: {
    size: 1000, // terrain grid spans [-size/2, size/2] on x and z
    cells: 400, // grid cells per side (2.5 m spacing); mesh vertices == query grid
    islandRadius: 320,
    seaLevel: 0,
    boundary: 470, // beyond this, currents push the player back
  },

  player: {
    eyeHeight: 1.7,
    radius: 0.35,
    walkSpeed: 4.2,
    sprintSpeed: 7.6,
    exhaustedSpeed: 2.8, // speed when energy hit 0 (forced slow walk)
    swimSpeed: 2.3,
    swimFastSpeed: 3.6,
    jumpVelocity: 6.2,
    gravity: 20,
    mouseSensitivity: 0.0022,
    reach: 3.0, // interaction distance from the eye
    swimDepth: 1.25, // water deeper than this at the feet = swimming
    fallDamageSpeed: 13, // landing faster than this hurts
  },

  stats: {
    start: { health: 88, thirst: 45, hunger: 72, energy: 75, heat: 30, wetness: 1, breath: 100 }, // you swallowed seawater: start thirsty
    // Drains per in-game hour
    thirstPerHour: 4.0, // 100 -> 0 in ~25 game hours (x difficulty.thirstMul)
    hungerPerHour: 4.2, // 100 -> 0 in ~24 game hours (x difficulty.hungerMul)
    thirstZeroKills: true, // reaching 0 thirst is fatal (dehydration), on every difficulty
    // Energy (stamina) per real second
    energySprintPerSec: 6.5,
    energyJump: 4,
    energySwimPerSec: 2.2,
    energySwimFastPerSec: 6.0,
    energyTreadPerSec: 1.2, // idle in deep water
    energyRegenIdlePerSec: 5,
    energyRegenWalkPerSec: 2.2,
    energyResumeSprintAt: 20, // after exhaustion, sprint unlocks again at this energy
    // Heat (body warmth) 0 = freezing, 100 = heatstroke; comfortable 40..75
    heatComfortMin: 40,
    heatComfortMax: 75,
    heatApproachPerSec: 0.35, // how fast heat moves toward the environment target
    // Damage per real second when a stat bottoms out
    dmgThirstPerSec: 0.45,
    dmgHungerPerSec: 0.28,
    dmgColdPerSec: 0.35, // heat < 15
    dmgHotPerSec: 0.3, // heat > 92
    dmgDrownPerSec: 9,
    breathDrainPerSec: 5.5, // ~18 s underwater
    breathRegenPerSec: 25,
    healthRegenPerSec: 0.06, // when well fed, hydrated, comfortable
  },

  fire: {
    campfireStartFuelHours: 3,
    fuelPerWoodHours: 1.5,
    maxFuelHours: 12,
    signalFireFuelHours: 6,
    warmthRadius: 7,
    cookSeconds: 1.6, // real seconds per item
  },

  rescue: {
    // In-game hours (absolute, since start of day 1 at 00:00) when the search party passes.
    // Later passes fly closer. Each pass: kind, start hour, route closeness 0..1.
    passes: [
      { kind: 'helicopter', at: 15.0, closeness: 0.25 },
      { kind: 'boat', at: 24 + 9.5, closeness: 0.45 },
      { kind: 'helicopter', at: 24 + 16.5, closeness: 0.55 },
      { kind: 'helicopter', at: 48 + 8.0, closeness: 0.7 },
      { kind: 'boat', at: 48 + 13.0, closeness: 0.75 },
      { kind: 'helicopter', at: 48 + 19.5, closeness: 0.8 }, // night pass: fires/torches/flares shine
      { kind: 'helicopter', at: 72 + 9.0, closeness: 0.9 },
    ],
    // After the scripted list, passes repeat every N hours with closeness 1.
    repeatEveryHours: 7,
    spotThreshold: 100, // attention points needed to be spotted during a pass
  },

  // Picked on the title screen (ctx.difficulty = { id, ...preset }). Every survival rate is multiplied by these.
  difficulty: {
    default: 'easy',
    presets: {
      easy: {
        label: 'Easy',
        blurb: 'A forgiving island. Build a simple driftwood raft.',
        thirstMul: 1,
        hungerMul: 1,
        damageMul: 1, // health lost from bottomed-out needs, cold, heat, drowning, poison
        regenMul: 1,
        earlyDamageBelow: 0, // hard: health starts dropping when hunger/thirst fall below this
        earlyDamagePerSec: 0,
        nightChillPerDay: 1.5, // °C colder at night for each day survived (nights get worse)
        rescueMul: 1, // multiplier on the search party's attention gain
        flareRange: 700, // m: a flare within this of a pass = instant spot (0 = flares are never seen)
        plan: 'raft',
      },
      medium: {
        label: 'Medium',
        blurb: 'Thirst and wounds hit harder. Build an outrigger sailboat.',
        thirstMul: 1.35,
        hungerMul: 1.2,
        damageMul: 1.7,
        regenMul: 0.6,
        earlyDamageBelow: 0,
        earlyDamagePerSec: 0,
        nightChillPerDay: 2.6,
        rescueMul: 0.3, // hard to be seen: build a boat or work very hard on signals
        flareRange: 250,
        plan: 'sailboat',
      },
      hard: {
        label: 'Hard',
        blurb: 'Hunger and thirst hurt long before they run out. Rebuild a motor launch.',
        thirstMul: 1.6,
        hungerMul: 1.4,
        damageMul: 2.3,
        regenMul: 0.35,
        earlyDamageBelow: 30,
        earlyDamagePerSec: 0.22, // at 0 (scales linearly from earlyDamageBelow down to 0)
        nightChillPerDay: 3.6,
        rescueMul: 0, // the search party can't see you at all: your only way home is by boat
        flareRange: 0,
        plan: 'motorboat',
      },
    },
  },

  // The main goal: rebuild a boat from parts scattered around the island and sail away.
  // Stages are built in order at the build site on the spawn beach; each takes `hours` of game time.
  // `needs` are item ids from src/core/items.js. Builder notes live in docs/build-log/B-raft.md.
  raft: {
    plans: {
      raft: {
        name: 'Driftwood Raft',
        stages: [
          { id: 'hull', label: 'Lash the hull together', needs: { wood: 10, rope: 2, hull_plank: 3 }, hours: 1.5 },
          { id: 'mast', label: 'Raise the mast', needs: { mast_pole: 1, rope: 1 }, hours: 0.75 },
          { id: 'sail', label: 'Rig the sail', needs: { cloth: 2, rope: 1 }, hours: 0.75 },
          { id: 'supplies', label: 'Load water for the voyage', needs: { bottle_water: 1 }, hours: 0.25 },
        ],
      },
      sailboat: {
        name: 'Outrigger Sailboat',
        stages: [
          { id: 'hull', label: 'Build the hull', needs: { wood: 14, rope: 3, hull_plank: 5 }, hours: 2.5 },
          { id: 'outrigger', label: 'Fit the outrigger float', needs: { bamboo: 4, wood: 4, rope: 2 }, hours: 1.5 },
          { id: 'mast', label: 'Raise the mast', needs: { mast_pole: 1, rope: 2 }, hours: 1 },
          { id: 'sail', label: 'Rig the sail', needs: { cloth: 3, rope: 1 }, hours: 1 },
          { id: 'rudder', label: 'Mount the rudder', needs: { rudder: 1, rope: 1 }, hours: 0.75 },
          { id: 'navigation', label: 'Fix the compass to the helm', needs: { compass: 1 }, hours: 0.25 },
          { id: 'supplies', label: 'Load water for the voyage', needs: { bottle_water: 2 }, hours: 0.25 },
        ],
      },
      motorboat: {
        name: 'Motor Launch (the Marguerite’s tender)',
        stages: [
          { id: 'hull', label: 'Patch the hull', needs: { wood: 18, rope: 4, hull_plank: 7 }, hours: 3 },
          { id: 'outrigger', label: 'Fit the outrigger float', needs: { bamboo: 4, wood: 4, rope: 2 }, hours: 1.5 },
          { id: 'rudder', label: 'Mount the rudder', needs: { rudder: 1, rope: 1 }, hours: 1 },
          { id: 'engine', label: 'Bolt on the outboard engine', needs: { engine_block: 1, propeller: 1, rope: 1 }, hours: 2 },
          { id: 'ignition', label: 'Fit the spark plugs', needs: { spark_plug: 1 }, hours: 0.75 },
          { id: 'fuel', label: 'Fill the tank', needs: { fuel_can: 1 }, hours: 0.25 },
          { id: 'navigation', label: 'Fix the compass to the helm', needs: { compass: 1 }, hours: 0.25 },
          { id: 'supplies', label: 'Load water for the voyage', needs: { bottle_water: 2 }, hours: 0.25 },
        ],
      },
    },
    // How many of each part exist in the world (spares included so the player isn't soft-locked),
    // and how they're hidden: beach (lying on sand), buried (shovel), rock (wedged in rock: pickaxe),
    // underwater (seabed near the wreck: dive with X).
    parts: {
      hull_plank: { where: 'beach', count: { raft: 5, sailboat: 7, motorboat: 9 } },
      mast_pole: { where: 'beach', count: { raft: 1, sailboat: 1, motorboat: 0 } },
      rudder: { where: 'buried', count: { raft: 0, sailboat: 1, motorboat: 1 } },
      compass: { where: 'isle2hut', count: { raft: 0, sailboat: 1, motorboat: 1 } }, // in the fishing hut on Tempest Isle
      fuel_can: { where: 'buried', count: { raft: 0, sailboat: 0, motorboat: 1 } },
      spark_plug: { where: 'rock', count: { raft: 0, sailboat: 0, motorboat: 1 } },
      engine_block: { where: 'underwater', count: { raft: 0, sailboat: 0, motorboat: 1 } },
      propeller: { where: 'underwater', count: { raft: 0, sailboat: 0, motorboat: 1 } },
    },
    extraSailcloth: { raft: 1, sailboat: 2, motorboat: 0 }, // cloth bundles washed up on beaches (crate1 gives 2)
  },

  // Tempest Isle (second island): violent local storms + travel by water.
  isle2: {
    stormChance: 0.4, // chance that each half-day (06-18 / 18-06) brings a storm to Tempest Isle
    stormRampSec: 30, // real seconds for a storm to roll in or clear (they come in quick)
    stormInner: 320, // m from the isle center: full storm inside this
    stormOuter: 560, // m: no storm beyond this (the main island is never affected)
    hailDamagePerSec: 0.45, // while exposed to hail (x difficulty damageMul)
    capsizePerSec: 0.06, // chance per second at full storm that a raft or sailboat flips
  },
  vehicles: {
    paddleRaft: { speed: 2.3, reverse: 1.0, turnRate: 0.9, energyPerSec: 0.45 }, // slow but it gets you there
    motorboat: { speed: 8.5, reverse: 2.5, turnRate: 1.1 },
    boardRadius: 3.2,
  },
  palmDeathChance: 0.05, // shaking a palm: a coconut may land on your head (game over)

  // Fishing minigame (src/gameplay/fishing.js): cast, wait, hook, reel with a tension bar.
  fishing: {
    biteMinSec: 20, // real seconds before a fish bites (min)
    biteMaxSec: 45, // (max)
    hookWindowSec: 2.2, // press reel within this of the bite or the fish is gone
    reelTapGain: 0.11, // progress per reel tap
    reelDrain: 0.03, // progress lost per second while the fish fights
    tensionPerTap: 0.17, // tension added per tap (snaps the line at 1)
    tensionRelaxPerSec: 0.5,
    fightDurationSec: [6, 14], // a fish fights this long (bigger = longer)
    loot: { raw_fish: 0.5, big_fish: 0.14, crab: 0.14, old_boot: 0.1, rope: 0.04, cloth: 0.04, hull_plank: 0.04 },
  },

  // Multiplayer groundwork (src/net/*, server/). Offline by default: the game is fully playable alone.
  net: {
    defaultServer: '', // e.g. 'wss://stranded-by-arthur.fly.dev'; can also be set with ?server=
    tickHz: 15, // state updates per second sent to the server
    maxPlayers: 8,
    interpolationMs: 120, // remote avatars are rendered this far in the past for smooth motion
  },

  keys: {
    forward: ['KeyW', 'ArrowUp'],
    back: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    sprint: ['ShiftLeft', 'ShiftRight'],
    jump: ['Space'],
    interact: ['KeyE', 'Mouse0'],
    secondary: ['KeyR'],
    useItem: ['KeyF', 'Mouse2'],
    craft: ['Tab', 'KeyC'],
    journal: ['KeyJ'],
    map: ['KeyM'],
    torch: ['KeyT'],
    wave: ['KeyG'],
    dive: ['KeyX'], // hold to dive while swimming (Space rises)
    reel: ['Space', 'Mouse0'], // fishing: hook and reel
    chat: ['Enter'], // multiplayer chat
    scoreboard: ['KeyP'], // multiplayer: who is online
    hotbar: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'],
    mute: ['KeyN'],
  },

  graphics: {
    maxPixelRatio: 1.5,
    shadowMapSize: 2048,
    shadowRange: 70, // half-size of the sun shadow box, follows the player
    farPlane: 2600,
    fov: 72,
  },
};
