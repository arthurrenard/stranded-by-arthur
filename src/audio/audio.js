// Builder F2 — Audio engine. 100 % procedural WebAudio: one-shot recipes (sounds.js, baked lazily into
// AudioBuffers on the main thread, a few ms per frame), persistent ambient beds (beds.js) mixed by the
// pure math in mix.js, Poisson schedulers for birds / frogs / crackle / drips, positional vehicle loops
// with Doppler, and the event → sound wiring.
//
// Graph:  beds ─► ambBus ─┐
//         one-shots ─► sfxBus ─┼─► worldBus ─► underwater low-pass ─┐
//         sfxBus ─► reverb ────┘                                    ├─► compressor ─► master ─► out
//         UI / body sounds / underwater rumble ─► directBus ────────┘
//
// API: { resume(), play(name, {volume, position, rate, delay}), setLoop(name, volume, position?),
//        setMasterVolume(v), toggleMute(), muted (get/set), stats() }
// Never throws: without WebAudio (node, old browsers) every call is a silent no-op.
import { RECIPES, BAKE_ORDER, resolveName, renderSound } from './sounds.js';
import {
  oceanLevel, oceanCutoff, windLevels, birdRate, cricketLevel, cicadaLevel, frogLevel, riverLevel, lapLevel,
  heartbeat, doppler, panToward, createGate, airCutoff, nightness, altitudeFade,
} from './mix.js';
import {
  gain, bq, makePanner, setPannerPos, makeNoiseBuffers, makeImpulse, Target,
  createOcean, createWind, createRain, createWater, createInsects, createFire, createUnderwater, createRotor, createEngine,
} from './beds.js';
import { clamp01, smoothstep } from '../core/util.js';

const MAX_VOICES = 24;
const AMBIENT_RESERVE = 6; // ambient schedulers leave this many voices free for gameplay sounds
const SENSE_PERIOD = 0.12; // world queries (biome, coast, river, lakes, fires) at ~8 Hz
const BAKE_BUDGET_MS = 2.5;
/** Sounds that bypass the underwater filter (UI, body, inner sounds) when played without a position. */
const DIRECT = new Set(['ui_click', 'ui_open', 'heartbeat', 'chime', 'shimmer', 'bubble', 'hurt', 'gasp']);
/** Shared de-dupe keys: eat and drink are the same "consume" moment (inventory and events may disagree). */
const GATE_KEY = { eat: 'consume', drink: 'consume' };
const LOOP_FACTORIES = { rotor: createRotor, engine: createEngine };
const BIRDS_FOREST = ['bird_whistle', 'bird_whistle', 'bird_trill', 'bird_chirp', 'bird_coo'];
const BIRDS_OPEN = ['bird_chirp', 'bird_chirp', 'bird_trill', 'bird_whistle'];

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const clock = () => now() / 1000;
const finite = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
const copyPos = (p) => (finite(p) ? { x: p.x, y: p.y, z: p.z } : undefined);
const rr = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

export function create(ctx) {
  let ac = null;
  let unavailable = false;
  let muted = false;
  let volume = 0.8; // matches the #opt-vol slider default
  let warned = 0;

  // graph
  let master = null, directBus = null, worldBus = null, ambBus = null, sfxBus = null, uwLP = null;
  let beds = null;
  let N = null;
  let T = null; // Targets on the buses

  // one-shots
  const gate = createGate();
  const voices = []; // { src, g, nodes, id, end, stolen, done }
  const buffers = {}; // id → AudioBuffer[] (sparse by variant)
  const broken = new Set();
  const lastVariant = {};
  const bakeQ = [];
  let bakeIdx = 0;
  const pending = []; // event-driven sounds, flushed at the start of the next update (direct calls win the gate)

  // loops
  const loops = {}; // name → { L, want, x, y, z, hasPos, prevD, vr, rate, vol, air, rateBase, detBase }

  // listener (camera)
  let lx = 0, ly = 0, lz = 0, fx = 0, fy = 0, fz = -1, ux = 0, uy = 1, uz = 0, yaw = 0;

  // sensed environment (throttled)
  const S = {
    alt: 0, coast: 200, gx: 0, gz: 0, forest: 0, meadow: 0, sand: 0, canopy: 0,
    riverD: null, lapLv: 0, lapDx: 0, lapDz: 0, dWater: 999, waterDx: 0, waterDz: 0,
    fireSrc: null, fireLv: 0,
  };
  let senseT = 0;
  const windOut = { base: 0, howl: 0, rustle: 0 };
  let hbT = 0;
  let wet = 0;

  function warn(e) {
    if (warned++ < 3) console.warn('[audio]', e);
  }

  // ── Context & routing ──────────────────────────────────────────────────
  function ensure() {
    if (ac || unavailable) return ac;
    const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
    if (!AC) {
      unavailable = true;
      return null;
    }
    try {
      ac = new AC({ latencyHint: 'interactive' });
    } catch (_) {
      try {
        ac = new AC();
      } catch (e) {
        unavailable = true;
        warn(e);
        return null;
      }
    }
    try {
      build();
    } catch (e) {
      warn(e);
      try {
        ac.close?.();
      } catch (_) {}
      ac = null;
      beds = null;
      unavailable = true;
    }
    return ac;
  }

  function build() {
    master = gain(ac, muted ? 0 : volume);
    master.connect(ac.destination);
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    comp.connect(master);
    directBus = gain(ac, 1);
    directBus.connect(comp);
    uwLP = bq(ac, 'lowpass', 20000, 0.6);
    uwLP.connect(comp);
    worldBus = gain(ac, 1);
    worldBus.connect(uwLP);
    ambBus = gain(ac, 0);
    ambBus.connect(worldBus);
    sfxBus = gain(ac, 1);
    sfxBus.connect(worldBus);
    try {
      const conv = ac.createConvolver();
      conv.buffer = makeImpulse(ac);
      const send = gain(ac, 0.12);
      sfxBus.connect(send);
      send.connect(conv);
      conv.connect(worldBus);
    } catch (_) {
      /* reverb is optional */
    }
    T = {
      amb: new Target(ambBus.gain, 0, 0.9, 0.01), // fades the soundscape in on start
      world: new Target(worldBus.gain, 1, 0.08, 0.01),
      uw: new Target(uwLP.frequency, 20000, 0.06, 0.03, true),
    };
    N = makeNoiseBuffers(ac);
    beds = {
      ocean: createOcean(ac, ambBus, N),
      wind: createWind(ac, ambBus, N),
      rain: createRain(ac, ambBus, N),
      water: createWater(ac, ambBus, N),
      insects: createInsects(ac, ambBus, N),
      fire: createFire(ac, ambBus, N),
      underwater: createUnderwater(ac, directBus, N),
    };
    // bake queue: variant 0 of everything first (so every sound becomes playable fast), then the rest
    // (thunder + crash first: the intro storm plays them seconds after the first click)
    const first = ['thunder', 'crash'].filter((n) => RECIPES[n]);
    const names = [...first, ...BAKE_ORDER.filter((n) => RECIPES[n] && !first.includes(n)), ...Object.keys(RECIPES).filter((n) => !BAKE_ORDER.includes(n) && !first.includes(n))];
    for (const n of names) bakeQ.push([n, 0]);
    for (const n of names) for (let v = 1; v < RECIPES[n].variants; v++) bakeQ.push([n, v]);
  }

  function applyMaster() {
    if (!ac || !master) return;
    try {
      master.gain.setTargetAtTime(muted ? 0 : volume, ac.currentTime, 0.04);
    } catch (_) {
      master.gain.value = muted ? 0 : volume;
    }
  }

  function resume() {
    try {
      const a = ensure();
      if (!a) return;
      if (a.state === 'suspended' || a.state === 'interrupted') a.resume?.()?.catch?.(() => {});
    } catch (e) {
      warn(e);
    }
  }

  const running = () => !!ac && !!beds && ac.state === 'running';

  // ── Baking ─────────────────────────────────────────────────────────────
  function bakeOne(id, v) {
    if (broken.has(id)) return null;
    try {
      const data = renderSound(id, v);
      if (!data || !data.length) {
        broken.add(id);
        return null;
      }
      const sr = RECIPES[id].sr;
      const b = ac.createBuffer(1, data.length, sr);
      if (b.copyToChannel) b.copyToChannel(data, 0);
      else b.getChannelData(0).set(data);
      (buffers[id] || (buffers[id] = []))[v] = b;
      return b;
    } catch (e) {
      broken.add(id);
      warn(e);
      return null;
    }
  }

  function bakeStep(budgetMs) {
    if (bakeIdx >= bakeQ.length) return;
    const t0 = now();
    while (bakeIdx < bakeQ.length && now() - t0 < budgetMs) {
      const [id, v] = bakeQ[bakeIdx++];
      if (!buffers[id]?.[v]) bakeOne(id, v);
    }
  }

  function pickBuffer(id) {
    const arr = buffers[id];
    if (!arr || !arr.length) return bakeOne(id, 0); // first play before the bake reached it
    let n = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i]) n++;
    if (n === 0) return bakeOne(id, 0);
    let k = (Math.random() * n) | 0;
    let idx = -1;
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i]) continue;
      if (k-- === 0) {
        idx = i;
        break;
      }
    }
    if (idx === lastVariant[id] && n > 1) {
      for (let j = 1; j < arr.length; j++) {
        const c = (idx + j) % arr.length;
        if (arr[c]) {
          idx = c;
          break;
        }
      }
    }
    lastVariant[id] = idx;
    return arr[idx];
  }

  // ── Voices ─────────────────────────────────────────────────────────────
  function liveCount() {
    let n = 0;
    for (const v of voices) if (!v.stolen) n++;
    return n;
  }

  function endVoice(v) {
    if (v.done) return;
    v.done = true;
    const i = voices.indexOf(v);
    if (i >= 0) voices.splice(i, 1);
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch (_) {}
    }
  }

  function stealVoice(v) {
    v.stolen = true;
    v.end = Math.min(v.end, clock() + 0.3);
    try {
      const t = ac.currentTime;
      v.g.gain.cancelScheduledValues?.(t);
      v.g.gain.setTargetAtTime(0, t, 0.012);
      v.src.stop(t + 0.07);
    } catch (_) {
      endVoice(v);
    }
  }

  function startVoice(id, opts, internal) {
    const R = RECIPES[id];
    const vol = (opts.volume ?? 1) * R.gain;
    if (!(vol > 0.0005)) return false;
    const pos = opts.position;
    const positional = finite(pos);
    let d = 0;
    if (positional) {
      d = Math.hypot(pos.x - lx, pos.y - ly, pos.z - lz);
      const att = R.ref / (R.ref + R.rolloff * Math.max(0, d - R.ref));
      if (vol * att < 0.002) return false; // inaudible: don't spend a voice
    }
    if (opts.ambient && liveCount() >= MAX_VOICES - AMBIENT_RESERVE) return false;
    const buffer = pickBuffer(id);
    if (!buffer) return false;
    while (liveCount() >= MAX_VOICES) {
      const oldest = voices.find((v) => !v.stolen);
      if (!oldest) break;
      stealVoice(oldest);
    }
    const t = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const rate = Math.max(0.25, Math.min(4, (opts.rate ?? 1) * (1 + (Math.random() * 2 - 1) * R.jitter)));
    src.playbackRate.value = rate;
    const g = ac.createGain();
    g.gain.value = Math.min(4, vol);
    src.connect(g);
    const nodes = [src, g];
    const dest = opts.dest || (!positional && DIRECT.has(id) ? directBus : sfxBus);
    if (positional) {
      let tail = g;
      if (d > 30) {
        const lp = bq(ac, 'lowpass', airCutoff(d), 0.5);
        g.connect(lp);
        tail = lp;
        nodes.push(lp);
      }
      const pn = makePanner(ac, { ref: R.ref, rolloff: R.rolloff, max: 10000 });
      setPannerPos(pn, pos.x, pos.y, pos.z);
      tail.connect(pn);
      pn.connect(dest);
      nodes.push(pn);
    } else g.connect(dest);
    const delay = Math.max(0, Math.min(10, +opts.delay || 0));
    const v = { src, g, nodes, id, end: clock() + delay + buffer.duration / rate + 0.5, stolen: false, done: false, internal };
    src.onended = () => endVoice(v);
    src.start(t + delay);
    voices.push(v);
    return true;
  }

  function playImpl(name, opts, internal) {
    if (!running()) return false;
    const id = resolveName(name);
    if (!id) return false; // unknown names are silently ignored
    const o = opts || {};
    if (!internal && !gate(GATE_KEY[id] || id, clock(), Math.max(0.06, RECIPES[id].cooldown))) return false;
    return startVoice(id, o, internal);
  }

  function play(name, opts) {
    try {
      return playImpl(name, opts, false);
    } catch (e) {
      warn(e);
      return false;
    }
  }

  function sweepVoices() {
    const t = clock();
    for (let i = voices.length - 1; i >= 0; i--) if (t > voices[i].end) endVoice(voices[i]); // onended never fired
  }

  // ── Event auto-sounds ──────────────────────────────────────────────────
  function auto(name, opts) {
    if (!running() || pending.length >= 32) return;
    pending.push([name, opts]);
  }
  function flushPending() {
    for (let i = 0; i < pending.length; i++) play(pending[i][0], pending[i][1]);
    pending.length = 0;
  }
  function wire() {
    const on = (ev, fn) => {
      try {
        ctx.events?.on?.(ev, (p) => {
          try {
            fn(p || {});
          } catch (e) {
            warn(e);
          }
        });
      } catch (_) {}
    };
    on('player:footstep', (p) => {
      const name = p.swim ? 'swim' : resolveName('footstep_' + (p.surface || 'grass')) || 'footstep_grass';
      auto(name, { volume: p.sprint ? 1.15 : 0.85 });
    });
    on('player:jump', () => auto('jump', { volume: 0.8 }));
    on('player:land', (p) => auto('land', { volume: Math.max(0.35, Math.min(1.2, 0.35 + (+p.speed || 0) / 12)) }));
    on('player:enterWater', () => auto('splash', { volume: 0.8 }));
    // (the surfacing gasp is played by stats.js only when breath was actually low)
    on('player:hurt', (p) => {
      const a = +p.amount;
      if (Number.isFinite(a) && a < 1) return;
      auto('hurt', { volume: Number.isFinite(a) ? Math.max(0.5, Math.min(1, 0.5 + a / 30)) : 0.8 });
    });
    on('harvest', () => auto('pickup', { volume: 0.8 }));
    on('craft:done', () => auto('craft'));
    on('item:consumed', (p) => {
      const cat = ctx.items?.[p.id]?.category;
      if (cat === 'drink') auto('drink');
      else if (cat === 'food' || cat === 'medicine') auto('eat');
    });
    on('drink', () => auto('drink'));
    on('fire:lit', (p) => auto('ignite', { position: copyPos(p.fire?.position || p.position) }));
    on('fire:out', (p) => auto('snuff', { position: copyPos(p.fire?.position || p.position) }));
    on('torch:toggle', (p) => {
      if (p.lit === false) auto('snuff', { volume: 0.6 });
    });
    on('food:cooked', () => auto('cook'));
    on('structure:placed', (p) => auto('place', { position: copyPos(p.position) }));
    on('tree:falling', (p) => auto('tree_creak', { position: copyPos(p.position) }));
    on('tree:fell', (p) => auto('tree_crash', { position: copyPos(p.position) }));
    on('weather:thunder', (p) => auto('thunder', { volume: Number.isFinite(+p.intensity) ? 0.5 + 0.5 * clamp01(+p.intensity) : 0.9 }));
    on('easter:found', () => auto('chime'));
    on('flare:fired', (p) => auto('flare', { position: copyPos(p.position) }));
  }

  // ── Listener ───────────────────────────────────────────────────────────
  function readListener() {
    const cam = ctx.camera;
    if (!cam) return;
    cam.updateWorldMatrix?.(true, false);
    const e = cam.matrixWorld?.elements;
    if (!e) return;
    const px = e[12], py = e[13], pz = e[14];
    if (!Number.isFinite(px + py + pz)) return;
    lx = px;
    ly = py;
    lz = pz;
    let a = -e[8], b = -e[9], c = -e[10];
    let l = Math.hypot(a, b, c);
    if (l > 1e-6) {
      fx = a / l;
      fy = b / l;
      fz = c / l;
    }
    a = e[4];
    b = e[5];
    c = e[6];
    l = Math.hypot(a, b, c);
    if (l > 1e-6) {
      ux = a / l;
      uy = b / l;
      uz = c / l;
    }
    if (Math.abs(fx) + Math.abs(fz) > 1e-4) yaw = Math.atan2(-fx, -fz);
  }

  function writeListener() {
    const li = ac.listener;
    if (!li) return;
    if (li.positionX) {
      li.positionX.value = lx;
      li.positionY.value = ly;
      li.positionZ.value = lz;
      li.forwardX.value = fx;
      li.forwardY.value = fy;
      li.forwardZ.value = fz;
      li.upX.value = ux;
      li.upY.value = uy;
      li.upZ.value = uz;
    } else {
      li.setPosition?.(lx, ly, lz);
      li.setOrientation?.(fx, fy, fz, ux, uy, uz);
    }
  }

  // ── Environment sensing (throttled world queries) ─────────────────────
  function sense() {
    const W = ctx.world;
    const x = lx, z = lz;
    const ground = W?.heightAt ? W.heightAt(x, z) : 0;
    S.alt = Math.max(0, ly - Math.max(Number.isFinite(ground) ? ground : 0, 0));
    if (W?.coastDistance) {
      const c = W.coastDistance(x, z);
      S.coast = Number.isFinite(c) ? c : 200;
      S.gx = W.coastDistance(x + 8, z) - S.coast;
      S.gz = W.coastDistance(x, z + 8) - S.coast;
      if (!Number.isFinite(S.gx + S.gz)) S.gx = S.gz = 0;
    }
    const bio = W?.biomeAt?.(x, z);
    S.forest = clamp01(bio?.forest || 0);
    S.meadow = clamp01(bio?.meadow || 0);
    S.sand = clamp01(bio?.sand || 0);
    S.canopy = clamp01(ctx.flora?.canopyAt?.(x, z) || 0);
    // fresh water: river + lakes
    const r = W?.riverAt?.(x, z);
    S.riverD = r && Number.isFinite(r.d) ? r.d : null;
    let dWater = S.riverD != null ? Math.max(0, S.riverD - (r.w || 0)) : 999;
    S.waterDx = S.waterDz = 0;
    S.lapLv = 0;
    let best = 1e9;
    for (const L of W?.lakes || []) {
      const dx = L.x - x, dz = L.z - z;
      const ds = Math.hypot(dx, dz) - (L.waterRadius ?? L.r ?? 0);
      if (Math.abs(ds) < best) {
        best = Math.abs(ds);
        S.lapDx = dx;
        S.lapDz = dz;
      }
    }
    if (best < 1e9) {
      S.lapLv = lapLevel(best);
      if (best < dWater) {
        dWater = best;
        S.waterDx = S.lapDx;
        S.waterDz = S.lapDz;
      }
    }
    S.dWater = dWater;
    // loudest lit fire / torch (a torch in hand must not mask the campfire next to it)
    let fire = null, best2 = 0, lv = 0;
    for (const h of ctx.heatSources || []) {
      if (!h || h.lit === false || !finite(h.position)) continue;
      const d = Math.hypot(h.position.x - x, h.position.y - ly, h.position.z - z);
      const level = (h.kind === 'torch' ? 0.3 : 1) * (1 - smoothstep(22, 40, d));
      const score = level / (1 + 0.15 * d);
      if (score > best2) {
        best2 = score;
        fire = h;
        lv = level;
      }
    }
    S.fireSrc = fire;
    S.fireLv = lv;
  }

  // ── Ambient beds + schedulers ──────────────────────────────────────────
  function ambientAt(dist, minH, maxH, dirX, dirZ, spread) {
    let a = Math.random() * Math.PI * 2;
    if (dirX || dirZ) a = Math.atan2(dirZ, dirX) + (Math.random() * 2 - 1) * spread;
    const x = lx + Math.cos(a) * dist, z = lz + Math.sin(a) * dist;
    const h = ctx.world?.heightAt ? ctx.world.heightAt(x, z) : 0;
    return { x, y: Math.max(Number.isFinite(h) ? h : 0, 0) + rr(minH, maxH), z };
  }

  function ambient(dt, t) {
    const state = ctx.state;
    T.amb.set(state === 'paused' ? 0.4 : state === 'dead' || state === 'rescued' ? 0.55 : 1, t);
    senseT -= dt;
    if (senseT <= 0) {
      senseT = SENSE_PERIOD;
      sense();
    }
    const w = ctx.weather || {};
    const rain = clamp01(+w.rain || 0);
    const storm = clamp01(+w.storm || 0);
    const windS = Math.max(0, Math.min(1.5, +(w.wind?.strength) || 0));
    const tm = ctx.time || {};
    const hour = Number.isFinite(tm.hour) ? tm.hour : 12;
    const daylight = Number.isFinite(tm.daylight) ? tm.daylight : 1;
    const under = !!ctx.player?.headUnderwater;
    const night = nightness(daylight);

    // underwater: muffle the world, add the rumble
    T.uw.set(under ? 420 : 20000, t);
    T.world.set(under ? 0.7 : 1, t);
    beds.underwater.update(t, dt, under ? 0.8 : 0);

    // ocean surf (panned toward the sea: down the coastDistance gradient)
    const oceanPan = panToward(-S.gx, -S.gz, yaw) * 0.55 * smoothstep(-10, 10, S.coast);
    beds.ocean.update(t, dt, oceanLevel(S.coast, S.alt, storm), oceanCutoff(S.coast), oceanPan, storm);

    windLevels(windOut, windS, S.alt, S.canopy, storm, S.forest);
    beds.wind.update(t, dt, windOut, windS);

    const muffled = Math.max(ctx.flags?.sheltered ? 0.6 : 0, S.canopy * 0.45, under ? 1 : 0);
    beds.rain.update(t, dt, rain, muffled);

    const river = riverLevel(S.riverD);
    if (river >= S.lapLv) beds.water.update(t, dt, river, 0, 0);
    else beds.water.update(t, dt, S.lapLv * 0.8, panToward(S.lapDx, S.lapDz, yaw) * 0.5, 1);

    beds.insects.update(
      t, dt,
      cricketLevel(daylight, S.meadow, S.forest, S.sand, rain, S.alt),
      cicadaLevel(hour, daylight, S.forest, rain, S.alt),
    );

    const f = S.fireSrc;
    if (f && finite(f.position)) beds.fire.update(t, dt, S.fireLv, f.position.x, f.position.y, f.position.z);
    else beds.fire.update(t, dt, 0, 0, 0, 0);

    // ── one-shot schedulers (Poisson) ──
    const chance = (rate) => rate > 0 && Math.random() < rate * dt;
    const amb = (name, opts) => playImpl(name, { ...opts, ambient: true }, true);
    if (state === 'paused') return;

    // birdsong by day (louder / richer in the forest)
    if (chance(birdRate(hour, daylight, S.forest, S.meadow, rain, S.alt))) {
      const name = Math.random() < 0.06 * S.forest ? 'woodpecker' : pick(S.forest > 0.35 ? BIRDS_FOREST : BIRDS_OPEN);
      amb(name, { position: ambientAt(rr(8, 36), 3, 11, 0, 0, 0), volume: rr(0.45, 1) });
    }
    // distant gulls along the coast by day
    if (chance(0.06 * clamp01(daylight) * smoothstep(80, 10, S.coast) * (1 - 0.8 * rain) * altitudeFade(S.alt))) {
      amb('gull', { position: ambientAt(rr(25, 70), 8, 22, -S.gx, -S.gz, 1.2), volume: rr(0.4, 0.8) });
    }
    // owls at night in the woods
    if (chance(0.025 * night * S.forest * (1 - rain))) {
      amb('owl', { position: ambientAt(rr(18, 45), 5, 12, 0, 0, 0), volume: rr(0.5, 0.9) });
    }
    // frog chorus near fresh water at night (fauna adds croaks at the real frogs)
    const fl = frogLevel(S.dWater, daylight, rain);
    if (chance(1.6 * fl)) {
      const dist = Math.max(5, S.dWater + rr(2, 12));
      amb('frog', { position: ambientAt(dist, 0.1, 0.4, S.waterDx, S.waterDz, 0.9), volume: rr(0.3, 0.7), rate: rr(0.88, 1.12) });
    }
    // fire crackle through the fire bed's panner
    if (beds.fire.bed.connected && chance(5 * S.fireLv)) amb('crackle', { dest: beds.fire.input, volume: rr(0.35, 1) });
    // drips from the canopy during and after rain
    wet = rain > 0.05 ? Math.max(wet, rain) : Math.max(0, wet - dt / 90);
    if (chance(2.5 * wet * S.canopy * (S.alt < 6 ? 1 : 0) * (under ? 0 : 1))) {
      amb('drip', { position: ambientAt(rr(1, 6), 0.5, 3, 0, 0, 0), volume: rr(0.4, 1) });
    }
    // bubbles while the head is underwater
    if (under && chance(1.4)) amb('bubble', { volume: rr(0.4, 1) });
    // heartbeat at low health (gameplay only)
    const hp = +ctx.stats?.values?.health;
    const hb = state === 'playing' && Number.isFinite(hp) ? heartbeat(hp) : { period: 0, volume: 0 };
    if (hb.period > 0) {
      hbT -= dt;
      if (hbT <= 0) {
        hbT = hb.period;
        playImpl('heartbeat', { volume: hb.volume }, true);
      }
    } else hbT = 0;
  }

  // ── Positional loops (rotor, engine) ───────────────────────────────────
  function setLoop(name, vol, position) {
    try {
      if (!LOOP_FACTORIES[name]) return;
      const v = Math.max(0, Math.min(4, +vol || 0));
      let L = loops[name];
      if (!L) {
        if (!(v > 0)) return;
        L = loops[name] = { L: null, want: 0, x: 0, y: 0, z: 0, hasPos: false, prevD: -1, vr: 0, rate: 1 };
      }
      L.want = v;
      if (finite(position)) {
        L.x = position.x;
        L.y = position.y;
        L.z = position.z;
        L.hasPos = true;
      } else L.hasPos = false;
    } catch (e) {
      warn(e);
    }
  }

  function updateLoops(dt, t) {
    // paused / menu open: main freezes rescue.update, so silence its vehicle loops here
    const hold = ctx.state === 'paused' || (ctx.state === 'playing' && !!ctx.ui?.menuOpen);
    for (const name in loops) {
      const S2 = loops[name];
      if (!S2.L) {
        if (!(S2.want > 0)) continue;
        const L = LOOP_FACTORIES[name](ac, sfxBus, N);
        S2.L = L;
        S2.vol = new Target(L.vol.gain, 0, 0.25, 0.002);
        S2.air = new Target(L.air.frequency, 18000, 0.3, 0.03, true);
        S2.rateBase = L.rate.map((s) => s.playbackRate.value);
        S2.detBase = L.detune.map((o) => o.detune.value);
      }
      const L = S2.L;
      if (S2.want > 0) {
        if (!L.connected) {
          L.panner.connect(L.dest);
          L.connected = true;
        }
        L.silent = 0;
      } else {
        L.silent += dt;
        if (L.connected && L.silent > 3) {
          L.panner.disconnect();
          L.connected = false;
        }
      }
      S2.vol.set(hold ? 0 : S2.want, t);
      if (!L.connected) {
        S2.prevD = -1;
        continue;
      }
      const px = S2.hasPos ? S2.x : lx, py = S2.hasPos ? S2.y : ly, pz = S2.hasPos ? S2.z : lz;
      setPannerPos(L.panner, px, py, pz);
      const d = Math.hypot(px - lx, py - ly, pz - lz);
      S2.air.set(airCutoff(d), t);
      if (S2.hasPos && S2.prevD >= 0 && dt > 0) {
        const vr = (d - S2.prevD) / dt;
        if (Math.abs(vr) < 300) S2.vr += (vr - S2.vr) * Math.min(1, dt * 4); // ignore teleports
      } else if (!S2.hasPos) S2.vr = 0;
      S2.prevD = d;
      const r = doppler(S2.vr);
      if (Math.abs(r - S2.rate) > 0.002) {
        S2.rate = r;
        const cents = 1200 * Math.log2(r);
        L.detune.forEach((o, i) => o.detune.setTargetAtTime(S2.detBase[i] + cents, t, 0.08));
        L.rate.forEach((s, i) => s.playbackRate.setTargetAtTime(S2.rateBase[i] * r, t, 0.08));
      }
    }
  }

  // ── Mute / volume ──────────────────────────────────────────────────────
  function setMuted(m) {
    muted = !!m;
    applyMaster();
  }
  function toggleMute() {
    setMuted(!muted);
    ctx.ui?.toast?.(muted ? 'Sound off' : 'Sound on', { icon: muted ? '🔇' : '🔊' });
  }
  function setMasterVolume(v) {
    const n = +v;
    if (!Number.isFinite(n)) return;
    volume = clamp01(n);
    applyMaster();
  }

  // ── Module contract ────────────────────────────────────────────────────
  const api = {
    init() {
      try {
        wire();
        if (typeof window !== 'undefined' && window.addEventListener) {
          const kick = () => {
            if (!ac || ac.state === 'suspended' || ac.state === 'interrupted') resume();
          };
          window.addEventListener('pointerdown', kick, true);
          window.addEventListener('keydown', kick, true);
        }
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('visibilitychange', () => {
            try {
              if (!ac) return;
              if (document.hidden) ac.suspend?.()?.catch?.(() => {});
              else ac.resume?.()?.catch?.(() => {});
            } catch (_) {}
          });
        }
      } catch (e) {
        warn(e);
      }
    },
    update(dt) {
      try {
        if (ctx.input?.wasPressed?.('mute')) toggleMute();
        if (!running()) {
          pending.length = 0;
          return;
        }
        dt = Math.max(0, Math.min(0.1, +dt || 0));
        const t = ac.currentTime;
        readListener();
        writeListener();
        flushPending();
        bakeStep(BAKE_BUDGET_MS);
        ambient(dt, t);
        updateLoops(dt, t);
        sweepVoices();
      } catch (e) {
        warn(e);
      }
    },
    resume,
    play,
    setLoop,
    setMasterVolume,
    toggleMute,
    get muted() {
      return muted;
    },
    set muted(v) {
      setMuted(v);
    },
    /** Debug: what the engine is doing. */
    stats() {
      return {
        state: ac ? ac.state : unavailable ? 'unavailable' : 'not started',
        voices: liveCount(),
        baked: bakeIdx + '/' + bakeQ.length,
        loops: Object.keys(loops).filter((k) => loops[k].want > 0),
        muted,
        volume,
      };
    },
  };
  return api;
}
