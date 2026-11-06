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
    start: { health: 88, thirst: 62, hunger: 72, energy: 75, heat: 30, wetness: 1, breath: 100 },
    // Drains per in-game hour
    thirstPerHour: 4.0, // 100 -> 0 in ~25 game hours
    hungerPerHour: 2.6, // 100 -> 0 in ~38 game hours
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
