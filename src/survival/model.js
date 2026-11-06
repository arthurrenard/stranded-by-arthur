// Survival model: the pure math behind body heat, wetness, energy, needs, damage, effects and sleep.
// No three.js, no DOM, no ctx. Functions only read their arguments; tick(), applyEffects(), changeEnergy()
// and simulateSleep() mutate the `state` object they are given (a plain object made by createState()).
// stats.js feeds this model from the game every frame; tests/survival.test.mjs drives the same tick().
//
// Time bases:
//   dtReal  real seconds: energy (stamina), breath, drowning, poison, nausea (physical, player-paced)
//   dtSim   real seconds x timeScale: heat, wetness, need damage, health regen (they follow the clock,
//           so debug speed(20) fast-forwards survival coherently; at timeScale 1 dtSim == dtReal)
//   dtHours game hours: thirst / hunger drains, rain wetting and drying (CONFIG "perHour" values)
import { CONFIG } from '../config.js';

// ── Tunables derived for this model (gameplay rates themselves live in CONFIG.stats) ─────────────
export const K = {
  // Air temperature, °C. Coldest just before dawn, warmest mid-afternoon; nights cool slowly.
  airMin: 11,
  airMax: 26,
  airMinHour: 4.5,
  airMaxHour: 14.5,
  cloudSwingDamp: 0.3, // overcast skies flatten the daily swing (cooler days, milder nights)
  rainChill: 4.5, // °C colder at rain = 1
  waterTemp: { ocean: 19, lake: 16.5, river: 15 },

  // Heat target (body warmth points, 0..100). heat = refHeat + (airTemp - refTemp) * heatPerDegree + ...
  refTemp: 20,
  refHeat: 50,
  heatPerDegree: 3.0,
  sunHeat: 18, // full, high sun with no shade or cloud
  wetCool: 14, // soaked clothes (wetness 1)
  windCoolDry: 4, // per unit wind strength, dry
  windCoolWet: 9, // extra per unit wind strength when soaked (evaporative chill)
  shelterHeat: 6,
  shelterWindBlock: 0.75,
  shelterSunBlock: 0.7,
  fireHeat: 45, // right next to a big fire (nearFire = 1)
  torchHeat: 5,
  walkHeat: 2,
  sprintHeat: 9,
  swimEffortHeat: 3,
  immersionCool: 10, // water steals heat far faster than air
  wadeImmersionMax: 0.6, // waist-deep wading counts as 60 % immersed

  // How fast heat moves toward the target: CONFIG.stats.heatApproachPerSec * factor,
  // factor = clamp(approachMin + |diff| * approachPerDiff, approachMin, approachMax), x waterApproach when immersed.
  approachMin: 0.5,
  approachPerDiff: 1 / 20,
  approachMax: 2.2,
  waterApproach: 2.2,

  // Wetness (0..1). Rates per game hour unless noted.
  swimWetPerSec: 2.5, // swimming soaks you in well under a second
  wadeWetPerSec: 0.35,
  rainWet: 1.7, // at rain = 1, unsheltered, no canopy
  canopyRainBlock: 0.6,
  dryBase: 0.22,
  drySun: 0.8,
  dryFire: 2.4,
  dryWind: 0.35,
  dryRainDamp: 0.8, // drying slows down while it rains

  // Energy
  sinkRegenPerSec: 0.8, // limp floating after exhaustion in deep water: ~25 s under (breath lasts ~18 s) = ~60 dmg. One second chance, not two
  lowNeedRegenAt: 20, // hunger or thirst below this halves energy regen
  lowNeedRegenMult: 0.5,

  // Needs multipliers
  thirstHotMult: 1.5, // sweating when hot
  thirstExertMult: 1.5, // sprinting / hard swimming
  hungerExertMult: 1.3,
  hungerColdMult: 1.3, // shivering burns calories
  sleepDrainMult: 0.5,
  nauseaThirstPerSec: 0.12,

  // Damage thresholds
  coldDamageBelow: 15,
  hotDamageAbove: 92,
  poisonSeconds: 20, // poison effect = total damage dealt over this many seconds
  nauseaMax: 60,

  // Health regen (CONFIG.stats.healthRegenPerSec when all conditions hold)
  regenNeedMin: 30,
  regenHeatMargin: 6, // tolerated outside the comfort band
  regenFireMult: 1.5,

  // Fall damage: over = impact - CONFIG.player.fallDamageSpeed; dmg = over * fallLinear + over^2 * fallQuad
  fallLinear: 3,
  fallQuad: 0.6,

  // Sleep
  sleepHealPerHour: 2,
  sleepMinHealth: 5, // sleep deficits never kill outright: you wake up parched and weak instead
  sleepDeficitDamageMult: 0.5,
  sleepHeatOpen: 30,
  sleepHeatShelter: 12,
  sleepHeatFire: 30,

  // Warning thresholds [low, critical]
  warn: {
    thirst: [25, 10],
    hunger: [25, 10],
    health: [30, 15],
    breath: [55, 25],
    cold: [32, 20], // heat below
    hot: [80, 88], // heat above
    energySwim: 18, // energy below this while swimming = 'low'
  },
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Fresh survival state (all 0..100 except wetness 0..1; poison = damage left, poisonTime / nausea = seconds). */
export function createState(cfg = CONFIG.stats) {
  const st = cfg.start;
  return {
    health: st.health,
    thirst: st.thirst,
    hunger: st.hunger,
    energy: st.energy,
    heat: st.heat,
    wetness: st.wetness,
    breath: st.breath,
    poison: 0,
    poisonTime: 0,
    nausea: 0,
    exhausted: false,
  };
}

// ── Environment ──────────────────────────────────────────────────────────────────────────────────

/** Air temperature (°C) for an hour of day and weather { rain, cloudiness, airTempOffset }. */
export function airTemperature(hour, weather = {}) {
  const h = ((hour % 24) + 24) % 24;
  const rise = K.airMaxHour - K.airMinHour; // warming hours
  const fall = 24 - rise; // cooling hours
  let dh = h - K.airMinHour;
  if (dh < 0) dh += 24;
  const f = dh <= rise ? -Math.cos((Math.PI * dh) / rise) : Math.cos((Math.PI * (dh - rise)) / fall); // -1..1
  const mid = (K.airMin + K.airMax) / 2;
  const amp = (K.airMax - K.airMin) / 2;
  const cloud = clamp01(weather.cloudiness ?? 0);
  const rain = clamp01(weather.rain ?? 0);
  // The weather module already folds rain/storm chill into airTempOffset: take the stronger of the two
  // chills instead of adding them, so rain isn't counted twice.
  const chill = Math.min(weather.airTempOffset ?? 0, -rain * K.rainChill);
  return mid + amp * f * (1 - K.cloudSwingDamp * cloud) + chill;
}

/** Water temperature (°C) by water type. */
export function waterTemperature(type) {
  return K.waterTemp[type] ?? K.waterTemp.ocean;
}

/** 0.4 (sun on the horizon) .. 1 (sun high) — the morning sun is gentle. sunElevation = sunDir.y. */
export function sunStrength(sunElevation) {
  return 0.4 + 0.6 * smoothstep(0.02, 0.6, sunElevation);
}

/** SPEC: daylight x (1 - canopy) x (1 - cloudiness * 0.7); a shelter roof blocks most of it. */
export function sunExposure(daylight, canopy = 0, cloudiness = 0, sheltered = false) {
  const s = clamp01(daylight) * (1 - clamp01(canopy)) * (1 - clamp01(cloudiness) * 0.7);
  return sheltered ? s * (1 - K.shelterSunBlock) : s;
}

/**
 * Body-heat target (0..100) the body drifts toward.
 * env: { airTemp, sun (exposure 0..1), sunElevation, wind (0..1+), wetness, fire (0..1), sheltered,
 *        torch (bool), immersion (0..1), waterTemp }
 * act: { moving, sprinting, swimming }
 */
export function heatTarget(env, act = {}) {
  const wet = clamp01(env.wetness ?? 0);
  let t = K.refHeat + ((env.airTemp ?? K.refTemp) - K.refTemp) * K.heatPerDegree;
  t += (env.sun ?? 0) * K.sunHeat * sunStrength(env.sunElevation ?? 1);
  t -= wet * K.wetCool;
  const windExposure = Math.max(0, env.wind ?? 0) * (env.sheltered ? 1 - K.shelterWindBlock : 1);
  t -= windExposure * (K.windCoolDry + K.windCoolWet * wet);
  if (env.sheltered) t += K.shelterHeat;
  if (env.torch) t += K.torchHeat;
  if (act.sprinting && !act.swimming) t += K.sprintHeat;
  else if (act.moving && !act.swimming) t += K.walkHeat;
  // Immersion: blend toward the water's (cold) pull.
  const imm = clamp01(env.immersion ?? 0);
  if (imm > 0) {
    const waterHeat =
      K.refHeat + ((env.waterTemp ?? K.waterTemp.ocean) - K.refTemp) * K.heatPerDegree - K.immersionCool + (act.moving ? K.swimEffortHeat : 0);
    t = lerp(t, waterHeat, imm);
  }
  t += clamp01(env.fire ?? 0) * K.fireHeat * (1 - imm * 0.7);
  return clamp(t, 0, 100);
}

/** Move heat toward target (faster when far off, much faster when immersed). dtSim seconds. */
export function approachHeat(heat, target, dtSim, immersion = 0, cfg = CONFIG.stats) {
  const diff = target - heat;
  const ad = Math.abs(diff);
  let factor = clamp(K.approachMin + ad * K.approachPerDiff, K.approachMin, K.approachMax);
  if (immersion > 0) factor *= lerp(1, K.waterApproach, clamp01(immersion));
  const step = cfg.heatApproachPerSec * factor * dtSim;
  return ad <= step ? target : heat + Math.sign(diff) * step;
}

/**
 * Wetness after this step. env: { immersion, rain, sheltered, canopy, sun, fire, wind, airTemp }.
 * Swimming soaks to 1 fast; wading wets up to the immersion level; rain wets unless sheltered;
 * sun / fire / wind dry (faster when warm).
 */
export function wetnessStep(w, env, dtHours, dtReal) {
  const imm = clamp01(env.immersion ?? 0);
  if (imm >= 0.999) return Math.min(1, w + K.swimWetPerSec * dtReal);
  if (imm > 0 && w < imm) w = Math.min(imm, w + K.wadeWetPerSec * dtReal);
  const rain = clamp01(env.rain ?? 0);
  const wetting = env.sheltered ? 0 : rain * K.rainWet * (1 - clamp01(env.canopy ?? 0) * K.canopyRainBlock);
  // Air drying (base + wind) slows a lot in cool, humid night air; sun and fire dry regardless.
  const airDry = clamp(0.3 + ((env.airTemp ?? 18) - 10) / 20, 0.25, 1.3);
  let drying = (K.dryBase + Math.max(0, env.wind ?? 0) * K.dryWind) * airDry + (env.sun ?? 0) * K.drySun + clamp01(env.fire ?? 0) * K.dryFire;
  drying *= 1 - rain * K.dryRainDamp * (env.sheltered ? 0.3 : 1);
  // Standing in water keeps you at least as wet as the water line.
  const floor = imm > 0 ? imm : 0;
  return clamp(w + (wetting - drying) * dtHours, floor, 1);
}

// ── Energy (stamina) ─────────────────────────────────────────────────────────────────────────────

/**
 * The single exhaustion rule: hitting 0 sets `exhausted`; it clears only once energy climbs back to
 * CONFIG.stats.energyResumeSprintAt. Every energy change (regen, sprint, jump, food) goes through here.
 */
export function changeEnergy(s, delta, cfg = CONFIG.stats) {
  s.energy = clamp(s.energy + delta, 0, 100);
  if (s.energy <= 0) s.exhausted = true;
  else if (s.exhausted && s.energy >= cfg.energyResumeSprintAt) s.exhausted = false;
  return s.energy;
}

/** Energy rate (per real second) for an activity. act: { moving, sprinting, swimming, sinking } */
export function energyRate(s, act, cfg = CONFIG.stats) {
  let rate;
  if (act.sinking) rate = K.sinkRegenPerSec;
  else if (act.swimming) rate = act.moving ? -(act.sprinting ? cfg.energySwimFastPerSec : cfg.energySwimPerSec) : -cfg.energyTreadPerSec;
  else if (act.sprinting) rate = -cfg.energySprintPerSec;
  else rate = act.moving ? cfg.energyRegenWalkPerSec : cfg.energyRegenIdlePerSec;
  if (rate > 0 && (s.hunger < K.lowNeedRegenAt || s.thirst < K.lowNeedRegenAt)) rate *= K.lowNeedRegenMult;
  return rate;
}

/** Can the player start / keep sprinting (or swim fast, or jump)? */
export function canSprint(s) {
  return !s.exhausted && s.energy > 0;
}

/**
 * Walking speed on land. While exhausted you trudge at exhaustedSpeed at 0 energy, recovering
 * smoothly toward walkSpeed as energy returns to energyResumeSprintAt (when sprint unlocks again).
 */
export function landSpeed(sprintHeld, s, pcfg = CONFIG.player, cfg = CONFIG.stats) {
  if (s.exhausted) return lerp(pcfg.exhaustedSpeed, pcfg.walkSpeed, clamp01(s.energy / cfg.energyResumeSprintAt));
  return sprintHeld && canSprint(s) ? pcfg.sprintSpeed : pcfg.walkSpeed;
}

/** Damage for landing at `impact` m/s (0 below CONFIG.player.fallDamageSpeed). */
export function fallDamage(impact, pcfg = CONFIG.player) {
  const over = impact - pcfg.fallDamageSpeed;
  return over > 0 ? over * K.fallLinear + over * over * K.fallQuad : 0;
}

// ── Needs, damage, regen ─────────────────────────────────────────────────────────────────────────

/** Drain thirst and hunger for dtHours. act: { sprinting, swimming, moving, sleeping } */
export function needsStep(s, act, dtHours, cfg = CONFIG.stats) {
  let tm = 1,
    hm = 1;
  if (s.heat > cfg.heatComfortMax) tm *= lerp(1, K.thirstHotMult, smoothstep(cfg.heatComfortMax, K.hotDamageAbove, s.heat));
  if (s.heat < cfg.heatComfortMin) hm *= lerp(1, K.hungerColdMult, smoothstep(cfg.heatComfortMin, K.coldDamageBelow, s.heat));
  if (act.sprinting || (act.swimming && act.moving)) {
    tm *= K.thirstExertMult;
    hm *= K.hungerExertMult;
  }
  if (act.sleeping) {
    tm *= K.sleepDrainMult;
    hm *= K.sleepDrainMult;
  }
  s.thirst = Math.max(0, s.thirst - cfg.thirstPerHour * tm * dtHours);
  s.hunger = Math.max(0, s.hunger - cfg.hungerPerHour * hm * dtHours);
}

/** Per-second damage rates from bottomed-out needs and extreme heat (time base: dtSim). Fills `out`. */
export function needDamageRates(s, cfg = CONFIG.stats, out = {}) {
  out.dehydration = s.thirst <= 0 ? cfg.dmgThirstPerSec : 0;
  out.starvation = s.hunger <= 0 ? cfg.dmgHungerPerSec : 0;
  out.hypothermia = s.heat < K.coldDamageBelow ? cfg.dmgColdPerSec * (1 + (K.coldDamageBelow - s.heat) / K.coldDamageBelow) : 0;
  out.heatstroke = s.heat > K.hotDamageAbove ? cfg.dmgHotPerSec * (1 + (s.heat - K.hotDamageAbove) / (100 - K.hotDamageAbove)) : 0;
  return out;
}

/** Health regen per second (dtSim) when fed, hydrated, comfortable and not poisoned. */
export function healthRegenRate(s, env = {}, cfg = CONFIG.stats) {
  if (s.thirst < K.regenNeedMin || s.hunger < K.regenNeedMin) return 0;
  if (s.heat < cfg.heatComfortMin - K.regenHeatMargin || s.heat > cfg.heatComfortMax + K.regenHeatMargin) return 0;
  if (s.poison > 0 || s.breath < 100) return 0;
  return cfg.healthRegenPerSec * ((env.fire ?? 0) > 0.3 || env.sheltered ? K.regenFireMult : 1);
}

const _rates = {};
/**
 * One simulation step. Mutates `s`, returns `report`:
 *   { damage (health lost this step), cause (biggest contributor or null), target (heat target), regen }
 * inp: { dtReal, dtSim, dtHours, env, act, god }
 *   env: see heatTarget() + wetnessStep() (airTemp, sun, sunElevation, wind, rain, canopy, fire, sheltered,
 *        torch, immersion, waterTemp)
 *   act: { moving, sprinting, swimming, sinking, headUnderwater }
 * Health damage is applied here (not in god mode); the caller turns it into events / death.
 */
export function tick(s, inp, cfg = CONFIG.stats, report = {}) {
  const { dtReal = 0, dtSim = dtReal, dtHours = 0, env = {}, act = {}, god = false } = inp;

  // Wetness first (it feeds the heat target), then heat.
  s.wetness = wetnessStep(s.wetness, env, dtHours, dtReal);
  env.wetness = s.wetness;
  const target = heatTarget(env, act);
  s.heat = approachHeat(s.heat, target, dtSim, env.immersion ?? 0, cfg);

  if (!god) {
    needsStep(s, act, dtHours, cfg);
    changeEnergy(s, energyRate(s, act, cfg) * dtReal, cfg);
  } else {
    // god mode: no drains (regen still applies, so stamina never runs out)
    changeEnergy(s, Math.max(0, energyRate(s, act, cfg)) * dtReal, cfg);
  }

  // Breath
  if (act.headUnderwater && !god) s.breath = Math.max(0, s.breath - cfg.breathDrainPerSec * dtReal);
  else s.breath = Math.min(100, s.breath + cfg.breathRegenPerSec * dtReal);

  // Nausea: queasy seconds + a little thirst
  if (s.nausea > 0) {
    const d = Math.min(s.nausea, dtReal);
    s.nausea -= d;
    if (!god) s.thirst = Math.max(0, s.thirst - K.nauseaThirstPerSec * d);
  }

  // Damage (largest contributor names the cause)
  let dmg = 0,
    cause = null,
    best = 0;
  if (!god) {
    needDamageRates(s, cfg, _rates);
    for (const c in _rates) {
      const a = _rates[c] * dtSim;
      if (a > 0) {
        dmg += a;
        if (a > best) {
          best = a;
          cause = c;
        }
      }
    }
    if (s.breath <= 0) {
      const a = cfg.dmgDrownPerSec * dtReal;
      dmg += a;
      if (a > best) {
        best = a;
        cause = 'drowning';
      }
    }
  }
  if (s.poison > 0) {
    // spread the remaining poison evenly over the remaining time
    let a;
    if (s.poisonTime <= dtReal) {
      a = s.poison;
      s.poisonTime = 0;
    } else {
      a = (s.poison / s.poisonTime) * dtReal;
      s.poisonTime -= dtReal;
    }
    s.poison = Math.max(0, s.poison - a);
    if (s.poison < 1e-6) {
      s.poison = 0;
      s.poisonTime = 0;
    }
    if (!god) {
      dmg += a;
      if (a > best) {
        best = a;
        cause = 'poison';
      }
    }
  }

  let regen = 0;
  if (dmg > 0) s.health = Math.max(0, s.health - dmg);
  else {
    regen = healthRegenRate(s, env, cfg) * dtSim;
    s.health = Math.min(100, s.health + regen);
  }

  report.damage = dmg;
  report.cause = cause;
  report.target = target;
  report.regen = regen;
  return report;
}

// ── Effects ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Apply item effects with clamping: { health, thirst, hunger, energy, heat, wetness, breath, poison, nausea }.
 * poison = total damage dealt over K.poisonSeconds (stacks); nausea = seconds of queasiness (stacks, capped).
 * Returns the actual deltas applied (after clamping).
 */
export function applyEffects(s, effects = {}, cfg = CONFIG.stats) {
  const d = {};
  const bump = (key, v, lo, hi) => {
    const before = s[key];
    s[key] = clamp(before + v, lo, hi);
    d[key] = s[key] - before;
  };
  for (const key in effects) {
    const v = Number(effects[key]);
    if (!Number.isFinite(v) || v === 0) continue;
    switch (key) {
      case 'health':
      case 'thirst':
      case 'hunger':
      case 'heat':
      case 'breath':
        bump(key, v, 0, 100);
        break;
      case 'wetness':
        bump(key, v, 0, 1);
        break;
      case 'energy': {
        const before = s.energy;
        changeEnergy(s, v, cfg);
        d.energy = s.energy - before;
        break;
      }
      case 'poison':
        if (v > 0) {
          s.poison += v;
          s.poisonTime = Math.max(s.poisonTime, K.poisonSeconds);
        } else {
          s.poison = Math.max(0, s.poison + v);
          if (s.poison === 0) s.poisonTime = 0;
        }
        d.poison = v;
        break;
      case 'nausea':
        bump(key, v, 0, K.nauseaMax);
        break;
      default:
        break;
    }
  }
  return d;
}

// ── Sleep ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Sleep `hours` in one go. env: { fire (0..1), sheltered, rain }.
 * Thirst / hunger drain at 50 % rate; energy restored to 100; heat set by fire / shelter; clothes dry by a
 * fire or under a roof; poison and nausea wear off; health heals while needs last, deficits hurt at half
 * the waking rate but never below K.sleepMinHealth. Returns a summary.
 */
export function simulateSleep(s, hours, env = {}, cfg = CONFIG.stats, secPerHour = CONFIG.time.dayLengthSec / 24) {
  hours = Math.max(0, hours);
  const tRate = cfg.thirstPerHour * K.sleepDrainMult;
  const hRate = cfg.hungerPerHour * K.sleepDrainMult;
  const tLeft = tRate > 0 ? s.thirst / tRate : Infinity; // hours until thirst hits 0
  const hLeft = hRate > 0 ? s.hunger / hRate : Infinity;
  const thirstBefore = s.thirst,
    hungerBefore = s.hunger,
    healthBefore = s.health;
  s.thirst = Math.max(0, s.thirst - tRate * hours);
  s.hunger = Math.max(0, s.hunger - hRate * hours);
  const dryHours = Math.max(0, hours - tLeft);
  const starveHours = Math.max(0, hours - hLeft);
  const deficit = (dryHours * cfg.dmgThirstPerSec + starveHours * cfg.dmgHungerPerSec) * secPerHour * K.sleepDeficitDamageMult;
  const healHours = Math.min(hours, tLeft, hLeft);
  const heal = s.poison > 0 ? 0 : healHours * K.sleepHealPerHour;
  let health = s.health + heal - deficit;
  if (deficit > 0) health = Math.max(Math.min(healthBefore, K.sleepMinHealth), health);
  s.health = clamp(health, 0, 100);

  s.energy = 100;
  s.exhausted = false;
  const fire = clamp01(env.fire ?? 0);
  s.heat = clamp(K.sleepHeatOpen + (env.sheltered ? K.sleepHeatShelter : 0) + fire * K.sleepHeatFire, 20, 66);
  const rain = clamp01(env.rain ?? 0);
  if (rain > 0.05 && !env.sheltered) s.wetness = Math.max(s.wetness, rain);
  else if (fire > 0.2 || env.sheltered) s.wetness = 0;
  else s.wetness *= 0.3;
  s.poison = 0;
  s.poisonTime = 0;
  s.nausea = 0;
  s.breath = 100;
  return {
    hours,
    thirstLost: thirstBefore - s.thirst,
    hungerLost: hungerBefore - s.hunger,
    healed: Math.max(0, s.health - healthBefore),
    damage: deficit,
    heat: s.heat,
  };
}

// ── Warnings ─────────────────────────────────────────────────────────────────────────────────────

/** Warning level for one type: null | 'low' | 'critical'. ctx: { swimming, sinking } */
export function warningLevel(type, s, ctx = {}) {
  const W = K.warn;
  switch (type) {
    case 'thirst':
    case 'hunger':
    case 'health':
    case 'breath': {
      const [lo, crit] = W[type];
      return s[type] <= crit ? 'critical' : s[type] <= lo ? 'low' : null;
    }
    case 'cold':
      return s.heat <= W.cold[1] ? 'critical' : s.heat <= W.cold[0] ? 'low' : null;
    case 'hot':
      return s.heat >= W.hot[1] ? 'critical' : s.heat >= W.hot[0] ? 'low' : null;
    case 'energy':
      if (ctx.sinking) return 'critical';
      if (ctx.swimming && s.energy < W.energySwim) return 'low';
      return s.exhausted ? 'low' : null; // out of breath on land (until sprint unlocks again)
    default:
      return null;
  }
}
