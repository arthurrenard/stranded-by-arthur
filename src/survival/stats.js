// Survival stats: wires the pure survival model (./model.js) to the game world.
// Reads the clock, weather, canopy, heat sources, shelters and the player; writes ctx.flags.nearFire /
// ctx.flags.sheltered; emits stats:warning, stats:died, stats:sleep and player:hurt; gives HUD feedback
// (toasts, damage flash) and plays the 'hurt' sound. See SPEC.md §6 D.
//
// Time bases (see model.js): energy / breath / poison / nausea use real dt; heat, wetness, need damage and
// regen use dt x timeScale; thirst / hunger drains use ctx.time.dtHours.
import { CONFIG } from '../config.js';
import * as M from './model.js';

const ENV_INTERVAL = 0.25; // real seconds between environment samples (canopy, heat sources, shelters)
const WARN_INTERVAL = 0.25; // real seconds between warning checks
const WARN_COOLDOWN = { low: 90, critical: 40 }; // real seconds before the same warning can repeat
const WARN_TYPES = ['thirst', 'hunger', 'cold', 'hot', 'energy', 'drowning', 'health'];
// Weather fallbacks when ctx.weather is missing (tests/survival.test.mjs uses the same).
const DEFAULT_WEATHER = { rain: 0, cloudiness: 0.25, wind: 0.35, airTempOffset: 0 };
const VALID_CAUSES = new Set(['dehydration', 'starvation', 'hypothermia', 'heatstroke', 'drowning', 'poison', 'falling', 'tree']);

// Flavor text for warnings: [type][level] -> lines (rotated). Icons / toast kinds per type.
const MESSAGES = {
  thirst: {
    low: ['Your lips are cracked — you need water', 'Your mouth feels like sand. Find fresh water.', 'Thirsty… a stream or the lake would do.'],
    critical: ["You're dizzy with thirst — drink something, now!", 'Your head pounds. You need fresh water!'],
  },
  hunger: {
    low: ['Your stomach growls. Forage something to eat.', 'You feel hollow — berries, nuts, roots… anything.', 'Hungry. The forest must have something edible.'],
    critical: ["You're weak with hunger.", 'Your hands tremble. You need food!'],
  },
  cold: {
    low: ["You're shivering…", 'Your teeth chatter. Get dry — find sun or a fire.', 'The chill is creeping into your bones.'],
    critical: ["Your fingers are numb — you're freezing! Get to a fire.", "You can't stop shaking. Warmth, now!"],
  },
  hot: {
    low: ['The heat is getting to you — find some shade.', 'Sweat stings your eyes. Rest in the shade.'],
    critical: ["You're overheating! Get out of the sun and drink.", 'Your head spins in the heat!'],
  },
  energy: {
    low: ["You're out of breath — slow down.", 'Your legs burn. Catch your breath.'],
    swim: ['Your arms are getting heavy — head for shallow water!', "You're tiring. Swim back to shore!"],
    critical: ["You're too exhausted to stay afloat!", 'Your limbs give out — you are sinking!'],
  },
  drowning: {
    low: ['Your lungs are burning…'],
    critical: ['You need air!', 'Air! You need air!'],
  },
  health: {
    low: ["You're badly hurt. Eat well, stay warm and rest.", 'Every step hurts. Look after yourself.'],
    critical: ['Your vision blurs… you are close to the end.', "You won't last long like this."],
  },
};
const ICONS = { thirst: '💧', hunger: '🍃', cold: '🥶', hot: '🥵', energy: '⚡', drowning: '🫧', health: '❤️' };
const FLASH = {
  hypothermia: 'rgba(150, 205, 255, 0.40)',
  heatstroke: 'rgba(255, 140, 40, 0.40)',
  poison: 'rgba(120, 190, 60, 0.40)',
  drowning: 'rgba(20, 60, 140, 0.45)',
  default: 'rgba(200, 24, 24, 0.50)',
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function create(ctx) {
  const S = CONFIG.stats;
  const values = M.createState(); // stable object, mutated in place (HUD + debug hold references)
  const max = { health: 100, thirst: 100, hunger: 100, energy: 100, heat: 100, wetness: 1, breath: 100, poison: 100, nausea: M.K.nauseaMax };
  // Live environment (also the model's env input; stable object)
  const env = {
    airTemp: 15,
    sun: 0,
    sunElevation: 0,
    wind: DEFAULT_WEATHER.wind,
    rain: 0,
    cloudiness: DEFAULT_WEATHER.cloudiness,
    canopy: 0,
    fire: 0,
    sheltered: false,
    torch: false,
    immersion: 0,
    waterTemp: M.waterTemperature('ocean'),
    target: values.heat, // current body-heat target (for the HUD / debugging)
    wetness: values.wetness,
  };
  const act = { moving: false, sprinting: false, swimming: false, sinking: false, headUnderwater: false, sleeping: false };
  const tickIn = { dtReal: 0, dtSim: 0, dtHours: 0, env, act, god: false };
  const report = {};

  let dead = false;
  let deathCause = null;
  let sleepingNow = false;
  let envTimer = 0;
  let warnTimer = 0;
  let clock = 0; // real seconds while playing (for cooldowns)
  const lastWarn = {}; // `${type}:${level}` -> clock time
  const msgIndex = {};
  // Continuous damage is batched into one player:hurt / flash every so often instead of every frame.
  let pendingHurt = 0;
  let pendingCause = null;
  let hurtEmitTimer = 0;
  let lastFlashAt = -1e9;
  let lastHurtSoundAt = -1e9;
  // Positive one-off toasts (re-armed by the opposite condition)
  let dryToastArmed = true;
  let warmToastArmed = true;

  // ── Helpers ────────────────────────────────────────────────────────────
  function playerPos() {
    return ctx.player?.position ?? null;
  }

  function toast(text, opts) {
    ctx.ui?.toast?.(text, opts);
  }

  function pickMessage(type, key) {
    const lines = MESSAGES[type]?.[key];
    if (!lines || !lines.length) return null;
    const id = type + ':' + key;
    const i = msgIndex[id] ?? 0;
    msgIndex[id] = i + 1;
    return lines[i % lines.length];
  }

  /** Sample weather, canopy, heat sources and shelters into `env` (throttled; cheap anyway). */
  function sampleEnv() {
    const t = ctx.time;
    const w = ctx.weather;
    const u = ctx.uniforms;
    env.rain = clamp01(num(w?.rain, num(u?.uRain?.value, DEFAULT_WEATHER.rain)));
    env.cloudiness = clamp01(num(w?.cloudiness, DEFAULT_WEATHER.cloudiness));
    env.wind = clamp(num(w?.wind?.strength, num(u?.uWindStrength?.value, DEFAULT_WEATHER.wind)), 0, 1.5);
    const airTempOffset = num(w?.airTempOffset, 0);
    env.airTemp = M.airTemperature(num(t?.hour, 12), { rain: env.rain, cloudiness: env.cloudiness, airTempOffset });
    env.sunElevation = num(t?.sunDir?.y, 0.5);

    const p = playerPos();
    let canopy = 0,
      fire = 0,
      torch = !!ctx.flags.torchLit,
      sheltered = false;
    if (p) {
      canopy = clamp01(num(ctx.flora?.canopyAt?.(p.x, p.z), 0));
      if (ctx.heatSources) {
        for (const h of ctx.heatSources) {
          if (!h || !h.position) continue;
          if (h.active === false || h.lit === false) continue;
          if (typeof h.isActive === 'function' && !h.isActive()) continue;
          const dx = h.position.x - p.x,
            dz = h.position.z - p.z,
            dy = (h.position.y ?? p.y) - (p.y + 0.8);
          const d = Math.sqrt(dx * dx + dz * dz + dy * dy * 0.5);
          const r = num(h.radius, CONFIG.fire.warmthRadius);
          const f = clamp01(num(h.warmth, 1)) * (1 - smoothstep(r * 0.3, r, d));
          if (h.kind === 'torch') {
            if (f > 0.05) torch = true; // a held/placed torch: a little warmth, not "near a fire"
          } else if (f > fire) fire = f;
        }
      }
      if (ctx.shelters) {
        for (const s of ctx.shelters) {
          if (!s || !s.position) continue;
          const dx = s.position.x - p.x,
            dz = s.position.z - p.z;
          const r = num(s.radius, 3);
          if (dx * dx + dz * dz < r * r && Math.abs((s.position.y ?? p.y) - p.y) < 3.5) {
            sheltered = true;
            break;
          }
        }
      }
    }
    env.canopy = canopy;
    env.fire = fire;
    env.torch = torch;
    env.sheltered = sheltered;
    env.sun = M.sunExposure(num(t?.daylight, 1), canopy, env.cloudiness, sheltered);
    ctx.flags.nearFire = fire;
    ctx.flags.sheltered = sheltered;
  }

  /** Per-frame: what the body is doing, and how immersed it is. */
  function sampleBody() {
    const pl = ctx.player;
    act.moving = !!pl?.moving;
    act.swimming = !!pl?.swimming;
    act.sprinting = !!pl?.sprinting;
    act.headUnderwater = !!pl?.headUnderwater;
    act.sinking = act.swimming && values.exhausted;
    act.sleeping = false;
    const wi = pl?.waterInfo;
    if (act.swimming || act.headUnderwater) env.immersion = 1;
    else if (pl?.inWater && wi) env.immersion = clamp01(num(wi.depth, 0) / CONFIG.player.swimDepth) * M.K.wadeImmersionMax;
    else env.immersion = 0;
    env.waterTemp = M.waterTemperature(wi?.type);
  }

  function canHurt() {
    return !dead && !ctx.flags.godMode && ctx.state === 'playing' && !ctx.flags.cinematic;
  }

  /** Visual + audio hurt feedback. `big` = discrete hit (always flashes). */
  function feedback(amount, cause, big) {
    const color = FLASH[cause] || FLASH.default;
    if (big) {
      const a = clamp(0.3 + amount / 40, 0.3, 0.75);
      ctx.ui?.flash?.(color.replace(/[\d.]+\)$/, a.toFixed(2) + ')'), clamp(0.3 + amount / 60, 0.3, 0.9));
      ctx.audio?.play?.('hurt', { volume: clamp(0.5 + amount / 40, 0.5, 1) });
      lastFlashAt = clock;
      lastHurtSoundAt = clock;
      return;
    }
    // continuous damage: soft flash, more often when it hurts more
    const rate = amount / Math.max(0.25, hurtEmitTimer || 1);
    const flashGap = clamp(4 / Math.max(rate, 0.1), 1.2, 5);
    if (clock - lastFlashAt > flashGap) {
      ctx.ui?.flash?.(color, 0.4);
      lastFlashAt = clock;
    }
    if (clock - lastHurtSoundAt > Math.max(flashGap * 1.5, 2.5)) {
      ctx.audio?.play?.('hurt', { volume: 0.45 });
      lastHurtSoundAt = clock;
    }
  }

  function die(cause) {
    if (dead) return;
    if (ctx.state !== 'playing' || ctx.flags.cinematic) return; // main ignores stats:died outside 'playing'
    dead = true;
    deathCause = VALID_CAUSES.has(cause) ? cause : cause || 'unknown';
    values.health = 0;
    if (pendingHurt > 0) {
      ctx.events.emit('player:hurt', { amount: pendingHurt, cause: pendingCause || deathCause });
      pendingHurt = 0;
    }
    ctx.events.emit('stats:died', { cause: deathCause });
  }

  function flushHurt(force) {
    if (pendingHurt <= 0) return;
    if (!force && pendingHurt < 0.5 && hurtEmitTimer < 3) return;
    ctx.events.emit('player:hurt', { amount: pendingHurt, cause: pendingCause || 'unknown' });
    feedback(pendingHurt, pendingCause, false);
    pendingHurt = 0;
    hurtEmitTimer = 0;
  }

  function causeFromEffects(effects, source) {
    const src = String(source ?? '').toLowerCase();
    if (src.includes('sea') || src.includes('ocean') || src.includes('salt')) return 'dehydration';
    if ((effects.poison ?? 0) > 0 || src.includes('toadstool')) return 'poison';
    if (VALID_CAUSES.has(src)) return src;
    return 'poison'; // raw chanterelles, nettle stings: something you ate
  }

  // ── Warnings ───────────────────────────────────────────────────────────
  function checkWarnings() {
    for (const type of WARN_TYPES) {
      let level;
      if (type === 'drowning') level = act.headUnderwater || values.breath < 100 ? M.warningLevel('breath', values) : null;
      else if (type === 'energy') level = M.warningLevel('energy', values, act);
      else level = M.warningLevel(type, values);
      if (!level) continue;
      const key = type + ':' + level;
      const last = lastWarn[key] ?? -1e9;
      if (clock - last < WARN_COOLDOWN[level]) continue;
      // a critical warning also silences the 'low' one for its cooldown
      lastWarn[key] = clock;
      if (level === 'critical') lastWarn[type + ':low'] = clock;
      ctx.events.emit('stats:warning', { type, level });
      const msgKey = type === 'energy' && level === 'low' && act.swimming ? 'swim' : level;
      const text = pickMessage(type, msgKey);
      if (text) toast(text, { icon: ICONS[type], kind: level === 'critical' ? 'bad' : 'warn', duration: level === 'critical' ? 5 : 4 });
      // tutorial hints for warnings are owned by the HUD (WARNINGS table in hud-data.js)
    }
    // Positive feedback
    if (values.wetness > 0.9) dryToastArmed = true;
    else if (dryToastArmed && values.wetness < 0.55 && env.immersion === 0) {
      if (env.fire > 0.3) {
        toast('Steam rises from your clothes by the fire', { icon: '♨️', kind: 'good' });
        dryToastArmed = false;
      } else if (env.sun > 0.25) {
        toast('Your clothes are drying in the sun', { icon: '☀️', kind: 'good' });
        dryToastArmed = false;
      } else if (values.wetness < 0.25) dryToastArmed = false;
    }
    if (values.heat < M.K.warn.cold[0]) warmToastArmed = true;
    else if (warmToastArmed && values.heat >= S.heatComfortMin + 2) {
      warmToastArmed = false;
      toast(env.fire > 0.3 ? "The fire's warmth seeps into your bones" : 'You feel warm again', { icon: '🌡️', kind: 'good' });
    }
  }

  function reset() {
    Object.assign(values, M.createState());
    dead = false;
    deathCause = null;
    pendingHurt = 0;
    pendingCause = null;
    hurtEmitTimer = 0;
    dryToastArmed = true;
    warmToastArmed = true;
    for (const k in lastWarn) delete lastWarn[k];
    envTimer = 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────
  const api = {
    values,
    max,
    env,
    /** True after energy hit 0 until it climbs back to CONFIG.stats.energyResumeSprintAt (no sprint/jump). */
    get exhausted() {
      return values.exhausted;
    },
    get dead() {
      return dead;
    },
    get deathCause() {
      return deathCause;
    },
    get sleeping() {
      return sleepingNow;
    },

    init() {
      ctx.events.on('game:start', reset);
      // A desperate gasp when surfacing with almost no air left.
      ctx.events.on('player:surfaced', () => {
        if (ctx.state === 'playing' && values.breath < 50) ctx.audio?.play?.('gasp', { volume: 0.9 });
      });
      sampleEnv();
    },

    /**
     * Apply item effects ({health, thirst, hunger, energy, heat, wetness, poison, nausea}).
     * `source` (item id or 'seawater') names the cause if it hurts. Returns the applied deltas (or null).
     */
    applyEffects(effects, source) {
      if (!effects || dead) return null;
      let eff = effects;
      if (ctx.flags.godMode && ((effects.health ?? 0) < 0 || (effects.poison ?? 0) > 0)) {
        eff = { ...effects };
        if (eff.health < 0) delete eff.health;
        delete eff.poison;
      }
      const hurts = (eff.health ?? 0) < 0;
      if (hurts && !canHurt()) {
        eff = { ...eff };
        delete eff.health;
      }
      const d = M.applyEffects(values, eff, S);
      if ((d.health ?? 0) < 0) {
        const cause = causeFromEffects(eff, source);
        ctx.events.emit('player:hurt', { amount: -d.health, cause });
        feedback(-d.health, cause, true);
        if (values.health <= 0) die(cause);
      }
      return d;
    },

    /** Direct damage (fall, falling tree…). Ignored in god mode or outside 'playing'. Returns damage dealt. */
    damage(amount, cause = 'unknown') {
      amount = Number(amount);
      if (!(amount > 0) || !canHurt()) return 0;
      const before = values.health;
      values.health = Math.max(0, before - amount);
      const dealt = before - values.health;
      ctx.events.emit('player:hurt', { amount: dealt, cause });
      feedback(dealt, cause, true);
      if (values.health <= 0) die(cause);
      return dealt;
    },

    /** Spend energy (jump cost…). Uses the model's single exhaustion rule. Returns the energy left. */
    drainEnergy(n) {
      n = Number(n);
      if (!(n > 0) || ctx.flags.godMode || dead) return values.energy;
      return M.changeEnergy(values, -n, S);
    },

    /**
     * Sleep `hours`: fade out, skip the clock, drain thirst/hunger at half rate, restore energy, set heat by
     * fire/shelter, fade in. Only while playing. Resolves true when slept, false if refused.
     */
    async sleep(hours) {
      hours = Number(hours);
      if (!(hours > 0) || sleepingNow || dead || ctx.state !== 'playing' || ctx.flags.cinematic) return false;
      hours = clamp(hours, 0.25, 16);
      sleepingNow = true;
      ctx.flags.sleeping = true;
      const fade = (to, s) => (typeof ctx.fade === 'function' ? ctx.fade(to, s) : Promise.resolve());
      try {
        await fade(1, 1.2);
        sampleEnv(); // fire / shelter at bedtime
        const fireAtBed = env.fire;
        ctx.time?.skipHours?.(hours); // structures burns (and may put out) fires synchronously here
        sampleEnv(); // fire state at wake-up
        const fire = (fireAtBed + env.fire) / 2; // a fire that died mid-night only half counts
        const r = M.simulateSleep(values, hours, { fire, sheltered: env.sheltered, rain: env.rain }, S);
        ctx.events.emit('stats:sleep', { hours, ...r });
        envTimer = 0;
        await fade(0, 1.5);
        let text = 'You wake up rested';
        if (values.thirst < 15) text = 'You wake up rested, but your throat is parched';
        else if (values.hunger < 15) text = 'You wake up rested, but starving';
        else if (values.heat < M.K.warn.cold[0]) text = 'You wake up stiff with cold';
        toast(text, { icon: '🌅', kind: 'good' });
        return true;
      } catch (e) {
        console.error('[stats] sleep failed', e);
        return false;
      } finally {
        ctx.flags.sleeping = false;
        sleepingNow = false;
      }
    },

    /** Debug helper: set some values, e.g. __game.stats.setValues({ thirst: 5, heat: 20 }). */
    setValues(partial = {}) {
      for (const k in partial) if (k in values && typeof partial[k] === typeof values[k]) values[k] = partial[k];
      if ('energy' in partial) M.changeEnergy(values, 0, S);
      return { ...values };
    },

    update(dt) {
      if (ctx.state !== 'playing' || dead || ctx.flags.cinematic || ctx.flags.sleeping || sleepingNow) return;
      if (ctx.time?.paused) return;
      clock += dt;

      envTimer -= dt;
      if (envTimer <= 0) {
        envTimer = ENV_INTERVAL;
        sampleEnv();
      }
      sampleBody();

      tickIn.dtReal = dt;
      tickIn.dtSim = dt * num(ctx.time?.timeScale, 1);
      tickIn.dtHours = num(ctx.time?.dtHours, 0);
      tickIn.god = !!ctx.flags.godMode;
      M.tick(values, tickIn, S, report);
      env.target = report.target;

      if (report.damage > 0) {
        pendingHurt += report.damage;
        pendingCause = report.cause || pendingCause;
      }
      if (pendingHurt > 0) hurtEmitTimer += dt;
      else hurtEmitTimer = 0;
      if (values.health <= 0) {
        die(report.cause || pendingCause || 'unknown');
        return;
      }
      if (hurtEmitTimer >= 1.2) flushHurt(false);

      warnTimer -= dt;
      if (warnTimer <= 0) {
        warnTimer = WARN_INTERVAL;
        checkWarnings();
      }
    },
  };
  return api;
}
