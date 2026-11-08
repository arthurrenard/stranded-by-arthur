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
  // Nights get colder every day: offset = -difficulty.nightChillPerDay x nights survived x nightFactor(hour),
  // capped. nightFactor ramps 0 -> 1 from 19:00 to 02:00, holds until 05:00, and is back to 0 by 08:00.
  nightChillMax: 14,
  nightRampStart: 19,
  nightCoreStart: 2,
  nightCoreEnd: 5,
  nightRampEnd: 8,
  fireChillShield: 0.5, // a fire's pocket of warm air cancels this share of the night chill at fire = 1 (a low fire still helps)
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
  // hypothermia rate = dmgColdPerSec x (coldCurveBase + coldCurveSlope x depth), depth = (15 - heat) / 15:
  // a mild chill only nibbles, a deep freeze kills fast (x1 at heat 12, x3.25 at heat 5, x4.75 at heat 0). Tuned with
  // the night simulations in tests/survival.test.mjs (easy night 3 near-lethal, hard night 2 lethal, hard night 1 not).
  coldCurveBase: 0.25,
  coldCurveSlope: 4.5,
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
  sleepThirstFloor: 5, // with CONFIG.stats.thirstZeroKills, sleep never takes thirst below this (you wake up parched)
  sleepChillShelter: 0.5, // a roof keeps half of the night chill off a sleeper

  // Warning thresholds [low, critical]
  warn: {
    thirst: [20, 10], // thirst 0 is fatal (CONFIG.stats.thirstZeroKills)
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

// ── Difficulty ───────────────────────────────────────────────────────────────────────────────────
const NO_DIFF = { id: 'easy', thirstMul: 1, hungerMul: 1, damageMul: 1, regenMul: 1, earlyDamageBelow: 0, earlyDamagePerSec: 0, nightChillPerDay: 0 };
/** The difficulty in effect: ctx.difficulty, else CONFIG.difficulty.presets.easy. Read every field with ?? (partial objects ok). */
export function difficultyOf(d) {
  return d || CONFIG.difficulty?.presets?.easy || NO_DIFF;
}
const num1 = (v, f) => (typeof v === 'number' && Number.isFinite(v) ? v : f);

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

/** 0 by day .. 1 in the dead of night (02:00-05:00), smooth ramps around it. hour 0..24. */
export function nightFactor(hour) {
  const x = (((hour + 12) % 24) + 24) % 24; // hours since noon: 19:00 = 7, 02:00 = 14, 05:00 = 17, 08:00 = 20
  const up = smoothstep(K.nightRampStart - 12, K.nightCoreStart + 12, x);
  const down = 1 - smoothstep(K.nightCoreEnd + 12, K.nightRampEnd + 12, x);
  return up * down;
}

/**
 * Extra night chill (°C, <= 0) at absolute game hour `hoursTotal`: nights get colder every day.
 * The night that starts on the evening of day N counts N nights (same as `day - 1` at 02:00-05:00, but continuous
 * through midnight). -min(K.nightChillMax, perDay x N) x nightFactor(hour).
 */
export function nightChill(hoursTotal, perDay = 0) {
  const n = Math.max(0, Math.floor((hoursTotal + 12) / 24));
  const hour = ((hoursTotal % 24) + 24) % 24;
  const c = Math.min(K.nightChillMax, Math.max(0, perDay) * n);
  return c > 0 ? -c * nightFactor(hour) : 0;
}

/** The night chill felt at a fire (0..1): the fire's warm pocket of air cancels part of it. */
export function shieldedChill(chill, fire = 0) {
  return chill * (1 - K.fireChillShield * clamp01(fire));
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

/** Drain thirst and hunger for dtHours. act: { sprinting, swimming, moving, sleeping }; diff: difficulty (mults). */
export function needsStep(s, act, dtHours, cfg = CONFIG.stats, diff = null) {
  const D = difficultyOf(diff);
  let tm = num1(D.thirstMul, 1),
    hm = num1(D.hungerMul, 1);
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

/** Health lost per second (no damageMul) from a need below difficulty.earlyDamageBelow: 0 there .. earlyDamagePerSec at 0. */
export function earlyNeedDamage(value, diff = null) {
  const D = difficultyOf(diff);
  const below = num1(D.earlyDamageBelow, 0);
  if (!(below > 0) || value >= below) return 0;
  return num1(D.earlyDamagePerSec, 0) * clamp01((below - value) / below);
}

/**
 * Per-second damage rates from bottomed-out needs and extreme heat (time base: dtSim). Fills `out`.
 * All x difficulty.damageMul; on hard (earlyDamageBelow > 0) low hunger / thirst hurt before they run out
 * (that part is the preset's own per-second rate, not multiplied again).
 */
export function needDamageRates(s, cfg = CONFIG.stats, out = {}, diff = null) {
  const D = difficultyOf(diff);
  const m = num1(D.damageMul, 1);
  out.dehydration = (s.thirst <= 0 ? cfg.dmgThirstPerSec * m : 0) + earlyNeedDamage(s.thirst, D);
  out.starvation = (s.hunger <= 0 ? cfg.dmgHungerPerSec * m : 0) + earlyNeedDamage(s.hunger, D);
  out.hypothermia = s.heat < K.coldDamageBelow ? cfg.dmgColdPerSec * m * (K.coldCurveBase + K.coldCurveSlope * (K.coldDamageBelow - s.heat) / K.coldDamageBelow) : 0;
  out.heatstroke = s.heat > K.hotDamageAbove ? cfg.dmgHotPerSec * m * (1 + (s.heat - K.hotDamageAbove) / (100 - K.hotDamageAbove)) : 0;
  return out;
}

/** Health regen per second (dtSim) when fed, hydrated, comfortable and not poisoned (x difficulty.regenMul). */
export function healthRegenRate(s, env = {}, cfg = CONFIG.stats, diff = null) {
  if (s.thirst < K.regenNeedMin || s.hunger < K.regenNeedMin) return 0;
  if (s.heat < cfg.heatComfortMin - K.regenHeatMargin || s.heat > cfg.heatComfortMax + K.regenHeatMargin) return 0;
  if (s.poison > 0 || s.breath < 100) return 0;
  return cfg.healthRegenPerSec * num1(difficultyOf(diff).regenMul, 1) * ((env.fire ?? 0) > 0.3 || env.sheltered ? K.regenFireMult : 1);
}

const _rates = {};
/**
 * One simulation step. Mutates `s`, returns `report`:
 *   { damage (health lost this step), cause (biggest contributor or null), target (heat target), regen }
 * inp: { dtReal, dtSim, dtHours, env, act, god, diff, breathMul }
 *   diff: the difficulty (ctx.difficulty; default easy): need drain / damage / regen multipliers, early damage
 *   breathMul: breath drain multiplier (0.5 with the diving mask)
 *   env: see heatTarget() + wetnessStep() (airTemp, sun, sunElevation, wind, rain, canopy, fire, sheltered,
 *        torch, immersion, waterTemp)
 *   act: { moving, sprinting, swimming, sinking, headUnderwater }
 * Health damage is applied here (not in god mode); the caller turns it into events / death.
 * With cfg.thirstZeroKills, thirst reaching 0 is fatal at once (cause 'dehydration').
 */
export function tick(s, inp, cfg = CONFIG.stats, report = {}) {
  const { dtReal = 0, dtSim = dtReal, dtHours = 0, env = {}, act = {}, god = false } = inp;
  const D = difficultyOf(inp.diff);
  const dmgMul = num1(D.damageMul, 1);

  // Wetness first (it feeds the heat target), then heat.
  s.wetness = wetnessStep(s.wetness, env, dtHours, dtReal);
  env.wetness = s.wetness;
  const target = heatTarget(env, act);
  s.heat = approachHeat(s.heat, target, dtSim, env.immersion ?? 0, cfg);

  if (!god) {
    needsStep(s, act, dtHours, cfg, D);
    changeEnergy(s, energyRate(s, act, cfg) * dtReal, cfg);
  } else {
    // god mode: no drains (regen still applies, so stamina never runs out)
    changeEnergy(s, Math.max(0, energyRate(s, act, cfg)) * dtReal, cfg);
  }

  // Breath
  if (act.headUnderwater && !god) s.breath = Math.max(0, s.breath - cfg.breathDrainPerSec * num1(inp.breathMul, 1) * dtReal);
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
    needDamageRates(s, cfg, _rates, D);
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
      const a = cfg.dmgDrownPerSec * dmgMul * dtReal;
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
      dmg += a * dmgMul;
      if (a * dmgMul > best) {
        best = a * dmgMul;
        cause = 'poison';
      }
    }
  }
  // Dehydration is fatal: thirst at 0 (also after nausea) ends it, whatever else is going on.
  if (!god && cfg.thirstZeroKills && s.thirst <= 0 && s.health > 0) {
    dmg = Math.max(dmg, s.health);
    cause = 'dehydration';
  }

  let regen = 0;
  if (dmg > 0) s.health = Math.max(0, s.health - dmg);
  else {
    regen = healthRegenRate(s, env, cfg, D) * dtSim;
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
 * Sleep `hours` in one go. env: { fire (0..1), sheltered, rain, chill (average night chill °C over the sleep, <= 0) }.
 * Thirst / hunger drain at 50 % rate (x difficulty mults); energy restored to 100; heat set by fire / shelter and the
 * night chill; clothes dry by a fire or under a roof; poison and nausea wear off; health heals (x regenMul) while
 * needs last; deficits and freezing hurt at half the waking rate (x damageMul) but never below K.sleepMinHealth.
 * With cfg.thirstZeroKills, sleep never takes thirst below K.sleepThirstFloor. Returns a summary.
 */
export function simulateSleep(s, hours, env = {}, cfg = CONFIG.stats, secPerHour = CONFIG.time.dayLengthSec / 24, diff = null) {
  const D = difficultyOf(diff);
  const dmgMul = num1(D.damageMul, 1);
  hours = Math.max(0, hours);
  const tRate = cfg.thirstPerHour * K.sleepDrainMult * num1(D.thirstMul, 1);
  const hRate = cfg.hungerPerHour * K.sleepDrainMult * num1(D.hungerMul, 1);
  const thirstBefore = s.thirst,
    hungerBefore = s.hunger,
    healthBefore = s.health;
  const tFloor = cfg.thirstZeroKills ? Math.min(thirstBefore, K.sleepThirstFloor) : 0;
  const tLeft = tRate > 0 ? Math.max(0, s.thirst - tFloor) / tRate : Infinity; // hours until thirst bottoms out
  const hLeft = hRate > 0 ? s.hunger / hRate : Infinity;
  s.thirst = Math.max(tFloor, s.thirst - tRate * hours);
  s.hunger = Math.max(0, s.hunger - hRate * hours);
  const dryHours = cfg.thirstZeroKills ? 0 : Math.max(0, hours - tLeft);
  const starveHours = Math.max(0, hours - hLeft);

  const fire = clamp01(env.fire ?? 0);
  const chill = Math.min(0, num1(env.chill, 0));
  const exposure = (1 - fire) * (env.sheltered ? K.sleepChillShelter : 1);
  const heat = K.sleepHeatOpen + (env.sheltered ? K.sleepHeatShelter : 0) + fire * K.sleepHeatFire + chill * K.heatPerDegree * exposure;
  const freeze = heat < K.coldDamageBelow ? clamp((K.coldDamageBelow - heat) / K.coldDamageBelow, 0, 1.5) : 0;

  const deficit =
    (dryHours * cfg.dmgThirstPerSec + starveHours * cfg.dmgHungerPerSec + hours * freeze * cfg.dmgColdPerSec) *
    secPerHour * K.sleepDeficitDamageMult * dmgMul;
  const healHours = freeze > 0 ? 0 : Math.min(hours, tLeft, hLeft);
  const heal = s.poison > 0 ? 0 : healHours * K.sleepHealPerHour * num1(D.regenMul, 1);
  let health = s.health + heal - deficit;
  if (deficit > 0) health = Math.max(Math.min(healthBefore, K.sleepMinHealth), health);
  s.health = clamp(health, 0, 100);

  s.energy = 100;
  s.exhausted = false;
  s.heat = clamp(heat, freeze > 0 ? 8 : 20, 66);
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
    froze: freeze > 0,
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
