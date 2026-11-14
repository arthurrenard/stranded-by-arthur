// Fishing minigame: the pure state machine (V4-C). No THREE, no DOM, no ctx: fishing.js drives it and draws it,
// tests/fishing.test.mjs checks it.
//
//   const L = createFishingLogic(CONFIG.fishing, rng);   // rng() → [0,1)
//   L.cast();                     // idle → waiting (the first FLY_SEC the float is in the air)
//   L.tick(dt, { reel, cancel, moved });                  // booleans for this frame; returns L.state
//   L.state = { phase, t, flying, progress, tension, timeLeft, biteAt, nibbles, nibble, run, loot, size, duration,
//               result: null | { reason, loot, rodLost }, events: [] }
//
// Phases: 'idle' → 'waiting' → 'bite' → 'fight' → 'landed' | 'lost' → (RESULT_SEC later) 'idle'.
// Events pushed to state.events (the host drains them and sets events.length = 0): 'cast', 'plop', 'nibble', 'bite',
// 'hooked', 'run', 'landed', 'lost' (state.result.reason says why: snap | escaped | gone | early | moved | cancel), 'idle'.

export const FLY_SEC = 0.6; // float flight time after the cast
export const RESULT_SEC = 1.6; // how long 'landed' / 'lost' stays before 'idle'
export const BOTTLE_CHANCE = 0.05; // a junk catch becomes a lore bottle this often
export const ROD_LOSS_CHANCE = 0.15; // snapping the line on the biggest fish may take the rod with it
export const BOTTLE_ID = 'message'; // pseudo loot id: fishing.js gives a bottle_empty + a BOTTLE_MESSAGES text
export const SIZE = { big_fish: 1, raw_fish: 0.35, crab: 0.3 }; // fight length factor; junk = JUNK_SIZE
export const JUNK_SIZE = 0.08;
export const RUN = { drainMul: 5, tapGainMul: 0.6, tapTensionMul: 1.5, relaxMul: 0.6, creep: 0.08, creepPerSize: 0.1 };
export const HOOK_PROGRESS = 0.15; // head start when the fish is hooked
export const HOOK_TENSION = 0.25;

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, k) => a + (b - a) * k;

/** [{ id, p }] in table order (the host's CONFIG.fishing.loot object). */
export function lootEntries(loot) {
  return Object.keys(loot || {}).map((id) => ({ id, p: +loot[id] || 0 }));
}
/** Sum of the table (should be 1). */
export function lootSum(loot) {
  return lootEntries(loot).reduce((s, e) => s + e.p, 0);
}
/** Loot id for r in [0,1): cumulative over the table; the last entry catches rounding. */
export function pickLoot(loot, r) {
  const E = lootEntries(loot);
  if (!E.length) return null;
  let acc = 0;
  for (const e of E) {
    acc += e.p;
    if (r < acc) return e.id;
  }
  return E[E.length - 1].id;
}
export const isFish = (id) => id in SIZE;
export const isJunk = (id) => !isFish(id);
export const sizeOf = (id) => SIZE[id] ?? JUNK_SIZE;

/** Seconds a fish fights, from cfg.fightDurationSec = [min, max] and its size. */
export function fightDuration(cfg, id) {
  const [a, b] = cfg.fightDurationSec || [6, 14];
  return lerp(a, b, clamp01(sizeOf(id)));
}
/** Seconds until the bite, from r in [0,1). */
export function biteDelay(cfg, r) {
  return lerp(cfg.biteMinSec ?? 20, cfg.biteMaxSec ?? 45, clamp01(r));
}
/** 1–3 nibble times (false alarms) strictly inside (0.25·biteAt, 0.85·biteAt), ascending, ≥ 1.5 s apart. */
export function nibbleTimes(biteAt, rng) {
  const n = 1 + Math.floor(rng() * 3);
  const lo = biteAt * 0.25, hi = biteAt * 0.85;
  const out = [];
  for (let i = 0; i < n; i++) out.push(lo + (hi - lo) * rng());
  out.sort((a, b) => a - b);
  for (let i = 1; i < out.length; i++) if (out[i] - out[i - 1] < 1.5) out[i] = out[i - 1] + 1.5;
  while (out.length && out[out.length - 1] > hi) out.pop();
  return out.length ? out : [lo + (hi - lo) * 0.5];
}

export function createFishingLogic(cfg, rng = Math.random) {
  const state = {
    phase: 'idle',
    t: 0, // seconds in the current phase
    flying: false,
    progress: 0,
    tension: 0,
    timeLeft: 0, // bite: hook window left; fight: fight time left; else 0
    biteAt: 0,
    nibbles: [],
    nibbleIdx: 0,
    nibble: 0, // 0..1 float dip from a nibble (decays)
    run: false,
    runLeft: 0,
    nextRun: 0,
    loot: null,
    size: 0,
    duration: 0,
    result: null,
    events: [],
    casts: 0,
  };
  const emit = (e) => state.events.push(e);

  function setPhase(p) {
    state.phase = p;
    state.t = 0;
  }
  function finish(phase, reason) {
    const rodLost = reason === 'snap' && state.loot === 'big_fish' && rng() < (cfg.rodLossChance ?? ROD_LOSS_CHANCE);
    state.result = { reason, loot: phase === 'landed' ? state.loot : null, rodLost, size: state.size };
    state.run = false;
    state.nibble = 0;
    state.flying = false;
    setPhase(phase);
    emit(phase);
  }

  function cast() {
    if (state.phase !== 'idle') return false;
    let loot = pickLoot(cfg.loot, rng());
    if (isJunk(loot) && rng() < (cfg.bottleChance ?? BOTTLE_CHANCE)) loot = BOTTLE_ID;
    state.loot = loot;
    state.size = sizeOf(loot);
    state.duration = fightDuration(cfg, loot);
    state.biteAt = biteDelay(cfg, rng());
    state.nibbles = nibbleTimes(state.biteAt, rng);
    state.nibbleIdx = 0;
    state.nibble = 0;
    state.progress = 0;
    state.tension = 0;
    state.timeLeft = 0;
    state.run = false;
    state.result = null;
    state.flying = true;
    state.casts++;
    setPhase('waiting');
    emit('cast');
    return true;
  }

  /** The reel key (Space / click). Returns true when it did something. */
  function reel() {
    const p = state.phase;
    if (p === 'waiting') {
      if (state.flying) return false;
      finish('lost', 'early');
      return true;
    }
    if (p === 'bite') {
      state.progress = HOOK_PROGRESS;
      state.tension = HOOK_TENSION;
      state.timeLeft = state.duration;
      state.nextRun = 0.8 + rng() * 1.2;
      state.run = false;
      setPhase('fight');
      emit('hooked');
      return true;
    }
    if (p === 'fight') {
      const run = state.run;
      state.progress += (cfg.reelTapGain ?? 0.11) * (run ? RUN.tapGainMul : 1);
      state.tension += (cfg.tensionPerTap ?? 0.17) * (run ? RUN.tapTensionMul : 1);
      if (state.tension >= 1) {
        state.tension = 1;
        finish('lost', 'snap');
      } else if (state.progress >= 1) {
        state.progress = 1;
        finish('landed', 'landed');
      }
      return true;
    }
    return false;
  }

  /** R while active, or the host (moved away, fell in the water, lost the rod). */
  function cancel(reason = 'cancel') {
    const p = state.phase;
    if (p === 'idle' || p === 'landed' || p === 'lost') return false;
    finish('lost', reason);
    return true;
  }

  function tick(dt, input) {
    if (!(dt > 0)) dt = 0;
    const p = state.phase;
    if (p === 'idle') return state;
    if (input) {
      if (input.cancel && cancel('cancel')) return state;
      if (input.moved && p !== 'landed' && p !== 'lost' && cancel('moved')) return state;
      if (input.reel && reel() && state.phase !== p) return state;
    }
    state.t += dt;
    const t = state.t;
    switch (state.phase) {
      case 'waiting': {
        if (state.flying && t >= FLY_SEC) {
          state.flying = false;
          emit('plop');
        }
        state.nibble = Math.max(0, state.nibble - dt / 0.45);
        while (state.nibbleIdx < state.nibbles.length && t >= state.nibbles[state.nibbleIdx]) {
          state.nibbleIdx++;
          state.nibble = 1;
          emit('nibble');
        }
        if (t >= state.biteAt) {
          state.nibble = 0;
          state.timeLeft = cfg.hookWindowSec ?? 2.2;
          setPhase('bite');
          emit('bite');
        }
        break;
      }
      case 'bite': {
        state.timeLeft = Math.max(0, (cfg.hookWindowSec ?? 2.2) - t);
        if (state.timeLeft <= 0) finish('lost', 'gone');
        break;
      }
      case 'fight': {
        state.timeLeft = Math.max(0, state.timeLeft - dt);
        if (state.run) {
          state.runLeft -= dt;
          state.tension = Math.min(1, state.tension + (RUN.creep + RUN.creepPerSize * state.size) * dt);
          if (state.runLeft <= 0) {
            state.run = false;
            state.nextRun = 1.2 + rng() * 2.2 * (1.2 - state.size * 0.7);
          }
        } else {
          state.nextRun -= dt;
          if (state.nextRun <= 0) {
            state.run = true;
            state.runLeft = 0.5 + rng() * 0.6 + state.size * 0.6;
            emit('run');
          }
        }
        state.tension = Math.max(0, state.tension - (cfg.tensionRelaxPerSec ?? 0.5) * (state.run ? RUN.relaxMul : 1) * dt);
        state.progress = Math.max(0, state.progress - (cfg.reelDrain ?? 0.03) * (state.run ? RUN.drainMul : 1) * dt);
        if (state.tension >= 1) finish('lost', 'snap');
        else if (state.timeLeft <= 0) finish('lost', 'escaped');
        break;
      }
      case 'landed':
      case 'lost': {
        if (t >= RESULT_SEC) {
          setPhase('idle');
          emit('idle');
        }
        break;
      }
    }
    return state;
  }

  return { state, cast, reel, cancel, tick, get active() { return state.phase !== 'idle'; } };
}
