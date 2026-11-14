// Bootstrap + game loop + state machine. Owned by the orchestrator. See SPEC.md.
// States: loading -> title -> intro -> playing <-> paused -> dead | rescued
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createRng } from './core/rng.js';
import { createEvents } from './core/events.js';
import { createInput } from './core/input.js';
import { createClock } from './core/clock.js';
import { createColliders } from './core/spatial.js';
import { createInteract } from './core/interact.js';
import { ITEMS } from './core/items.js';
import { fmtHour } from './core/util.js';
import { createHeightfield } from './world/heightfield.js';
import * as Hud from './ui/hud.js';
import * as Audio from './audio/audio.js';
import * as Sky from './world/sky.js';
import * as Weather from './world/weather.js';
import * as Terrain from './world/terrain.js';
import * as Water from './world/water.js';
import * as Flora from './nature/flora.js';
import * as Resources from './nature/resources.js';
import * as Fauna from './nature/fauna.js';
import * as Controller from './player/controller.js';
import * as Stats from './survival/stats.js';
import * as Inventory from './gameplay/inventory.js';
import * as Crafting from './gameplay/crafting.js';
import * as Structures from './gameplay/structures.js';
import * as Raft from './gameplay/raft.js';
import * as Isle2 from './isle2/isle2.js';
import * as Vehicles from './gameplay/vehicles.js';
import * as Net from './net/net.js';
import * as Fishing from './gameplay/fishing.js';
import * as Rescue from './story/rescue.js';
import * as EasterEggs from './story/eastereggs.js';
import * as Intro from './story/intro.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');

function setLoading(text) {
  const el = $('loading-text');
  if (el) el.textContent = text;
}

// ── Renderer / scene / camera ────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.graphics.maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap was removed in r187
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.localClippingEnabled = true; // per-material clipping planes (the wreck's submerged pedestal)
$('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87a9c9);
const camera = new THREE.PerspectiveCamera(CONFIG.graphics.fov, window.innerWidth / window.innerHeight, 0.1, CONFIG.graphics.farPlane);
camera.rotation.order = 'YXZ';
scene.add(camera); // so camera-attached objects (torch, hands) render

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Shared context ───────────────────────────────────────────────────────
const events = createEvents();
const ctx = {
  THREE,
  config: CONFIG,
  items: ITEMS,
  params,
  debugMode: DEBUG,
  renderer,
  scene,
  camera,
  events,
  state: 'loading',
  rng: createRng(CONFIG.seed),
  input: createInput(renderer.domElement, events),
  time: createClock(events),
  colliders: createColliders(),
  // Shared mutable flags (documented in SPEC.md §Flags)
  flags: {
    cinematic: false, // a cutscene owns the camera; player input + interaction disabled
    torchLit: false, // E: player holds a lit torch
    waving: false, // F/rescue: player waving arms (G held)
    sheltered: false, // D: under a shelter roof (computed from ctx.shelters)
    nearFire: 0, // D: 0..1 warmth from the nearest heat source
    sleeping: false,
    typing: false, // multiplayer chat input open: the pointer is free but the world keeps running
    godMode: false,
    gravityScale: 1, // F easter egg (moon gravity) multiplies gravity
    speedScale: 1,
  },
  // Shared shader uniforms: uTime advanced by main, wind by weather, daylight by sky.
  uniforms: {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(1, 0.3).normalize() },
    uWindStrength: { value: 0.35 },
    uDaylight: { value: 1 },
    uRain: { value: 0 },
  },
  heatSources: new Set(), // { position: Vector3, radius, warmth 0..1, kind }
  signals: new Set(), // { kind, position: Vector3, strength (m), isActive(): bool }
  shelters: new Set(), // { position: Vector3, radius }
  stats_summary: { distanceWalked: 0, itemsCrafted: 0, foodsEaten: 0, plantsGathered: 0 },
};
ctx.interact = createInteract(ctx);
window.__game = ctx;

/** Difficulty preset: { id, label, thirstMul, hungerMul, damageMul, regenMul, earlyDamageBelow, ..., plan }.
 *  Default from ?difficulty=easy|medium|hard; the title screen can change it before 'game:start'. */
function setDifficulty(id) {
  const P = CONFIG.difficulty.presets;
  const key = P[id] ? id : CONFIG.difficulty.default;
  ctx.difficulty = { id: key, ...P[key] };
  events.emit('difficulty:set', ctx.difficulty);
  return ctx.difficulty;
}
setDifficulty(params.get('difficulty'));

/** Fade the whole screen to black (1) or clear (0) over `seconds`. Returns a Promise. */
ctx.fade = (to, seconds = 1) =>
  new Promise((res) => {
    const el = $('fade');
    el.style.transition = `opacity ${seconds}s ease`;
    // force reflow so the transition always runs
    void el.offsetWidth;
    el.style.opacity = String(to);
    setTimeout(res, seconds * 1000 + 30);
  });
/** Cinematic letterbox bars on/off. */
ctx.letterbox = (on) => document.body.classList.toggle('letterbox', !!on);

// ── Systems ──────────────────────────────────────────────────────────────
const systems = []; // [{ name, api, always }]
function add(name, mod, opts = {}) {
  let api;
  try {
    api = mod.create(ctx) || {};
  } catch (e) {
    console.error(`[main] ${name}.create() failed`, e);
    reportError(name, e);
    api = {};
  }
  ctx[name] = api;
  systems.push({ name, api, always: !!opts.always, errors: 0 });
  return api;
}

const errorLog = [];
function reportError(name, e) {
  errorLog.push({ system: name, message: String(e?.message || e), stack: e?.stack });
  if (DEBUG) {
    const el = $('debug-errors');
    if (el) el.textContent = `⚠ ${errorLog.length} error(s): ${name}: ${e?.message || e}`;
  }
}

function boot() {
  setLoading('Shaping the island…');
  ctx.world = createHeightfield();

  setLoading('Growing the forest…');
  // Order matters only for init(); create() must not depend on other systems.
  add('ui', Hud, { always: true });
  add('audio', Audio, { always: true });
  add('sky', Sky);
  add('weather', Weather);
  add('terrain', Terrain);
  add('water', Water);
  add('flora', Flora);
  add('resources', Resources);
  add('fauna', Fauna);
  add('player', Controller);
  add('stats', Stats);
  add('inventory', Inventory);
  add('crafting', Crafting);
  add('structures', Structures);
  add('raft', Raft);
  add('isle2', Isle2);
  add('vehicles', Vehicles);
  add('fishing', Fishing);
  add('net', Net, { always: true });
  add('rescue', Rescue);
  add('eastereggs', EasterEggs);
  add('intro', Intro);

  for (const s of systems) {
    try {
      s.api.init?.();
    } catch (e) {
      console.error(`[main] ${s.name}.init() failed`, e);
      reportError(s.name, e);
    }
  }
  // the interaction registry runs right after the player each frame
  const pi = systems.findIndex((s) => s.name === 'stats');
  systems.splice(pi + 1, 0, { name: 'interact', api: ctx.interact, always: false, errors: 0 });

  installDebug();
  wireOverlays();
  ctx.state = 'title';
  $('loading').classList.add('hidden');
  $('title').classList.remove('hidden');
  if (params.has('skipintro') || params.has('autostart')) startGame(true);
  requestAnimationFrame(frame);
}

// ── State transitions ────────────────────────────────────────────────────
async function startGame(skipIntro = false) {
  if (ctx.state !== 'title') return;
  $('title').classList.add('hidden');
  ctx.audio.resume?.();
  ctx.input.lock();
  let yaw = null;
  if (!skipIntro && ctx.intro.play) {
    ctx.state = 'intro';
    ctx.flags.cinematic = true;
    try {
      await ctx.intro.play();
      yaw = camera.rotation.y; // continue looking where the intro's last shot looked
    } catch (e) {
      console.error('[main] intro failed', e);
      reportError('intro', e);
    }
  }
  beginPlaying(yaw);
}

function beginPlaying(yaw = null) {
  const L = ctx.world.landmarks.spawn;
  ctx.flags.cinematic = false;
  ctx.letterbox(false);
  ctx.time.setHour(CONFIG.time.startHour);
  ctx.player.teleport?.(L.x, L.z, Number.isFinite(yaw) ? yaw : L.yaw);
  ctx.state = 'playing';
  ctx.ui.setVisible?.(true);
  $('fade').style.opacity = '0';
  ctx.events.emit('game:start', {});
  if (!ctx.input.locked) ctx.input.lock();
}

events.on('stats:died', (p) => {
  if (ctx.state !== 'playing') return;
  ctx.state = 'dead';
  ctx.input.unlock();
  ctx.ui.showDeath?.({ cause: p?.cause || 'unknown', day: ctx.time.day, hour: ctx.time.hour });
});
events.on('raft:sailed', (p) => {
  if (ctx.state !== 'playing') return;
  ctx.state = 'rescued';
  ctx.input.unlock();
  ctx.ui.showWin?.({ day: ctx.time.day, hour: ctx.time.hour, method: 'raft', ...(p || {}) });
});
events.on('rescue:success', (p) => {
  if (ctx.state !== 'playing') return;
  ctx.state = 'rescued';
  ctx.input.unlock();
  ctx.ui.showWin?.({ day: ctx.time.day, hour: ctx.time.hour, ...(p || {}) });
});

function wireOverlays() {
  for (const btn of document.querySelectorAll('[data-difficulty]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setDifficulty(btn.dataset.difficulty);
      startGame(false);
    });
  }
  // Only REQUEST the lock here: the overlay stays up until pointerlockchange confirms it ('input:lock').
  // (Hiding it first made it pop up a second time whenever the browser refused the lock.)
  $('pause').addEventListener('click', () => {
    if (ctx.state !== 'paused') return;
    ctx.input.lock();
  });
  events.on('input:lockError', () => {
    if (ctx.state !== 'paused') return;
    const cta = document.querySelector('#pause .cta');
    if (cta) cta.textContent = 'Click again to resume';
  });
  events.on('input:unlock', () => {
    if (DEBUG) return; // automation-friendly: never auto-pause in debug mode
    if (ctx.state === 'playing' && !ctx.ui.menuOpen && !ctx.flags.cinematic && !ctx.flags.typing) {
      ctx.state = 'paused';
      $('pause').classList.remove('hidden');
    }
  });
  events.on('input:lock', () => {
    if (ctx.state === 'paused') {
      ctx.state = 'playing';
      $('pause').classList.add('hidden');
      const cta = document.querySelector('#pause .cta');
      if (cta) cta.textContent = 'Click to resume';
    }
  });
  const sens = $('opt-sens');
  const vol = $('opt-vol');
  sens?.addEventListener('input', () => (CONFIG.player.mouseSensitivity = 0.0022 * Number(sens.value)));
  vol?.addEventListener('input', () => ctx.audio.setMasterVolume?.(Number(vol.value)));
  for (const el of document.querySelectorAll('[data-stop]')) el.addEventListener('click', (e) => e.stopPropagation());
}

// ── Main loop ────────────────────────────────────────────────────────────
let last = performance.now();
let fpsAcc = 0, fpsFrames = 0, fps = 0;
let titleAngle = 0;
let unlockedFor = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = (now - last) / 1000;
  last = now;
  if (stepping) return; // debug.step() is driving the simulation
  tick(Math.min(0.05, Math.max(0, rawDt)), rawDt);
}

let stepping = false;
/** One simulation + render step. Also used by debug.step() for deterministic automated tests. */
function tick(dt, rawDt = dt, render = true) {
  const frozen = ctx.state === 'paused' || (ctx.state === 'playing' && ctx.ui.menuOpen);
  ctx.time.paused = frozen || ctx.state === 'title' || ctx.state === 'intro' || ctx.state === 'loading';
  ctx.time.update(dt);
  if (!frozen) ctx.uniforms.uTime.value += dt;

  if (ctx.state === 'title') titleCamera(dt);

  for (const s of systems) {
    if (frozen && !s.always) continue;
    if (!s.api.update) continue;
    try {
      s.api.update(dt);
    } catch (e) {
      s.errors++;
      if (s.errors <= 3) console.error(`[main] ${s.name}.update() threw`, e);
      if (s.errors === 1) reportError(s.name, e);
    }
  }

  // Fallback: lost pointer lock while playing (e.g. menu closed outside a gesture)
  if (!DEBUG && ctx.state === 'playing' && !ctx.ui.menuOpen && !ctx.flags.cinematic && !ctx.flags.typing && !ctx.input.locked) {
    unlockedFor += dt;
    if (unlockedFor > 0.4) {
      ctx.state = 'paused';
      $('pause').classList.remove('hidden');
    }
  } else unlockedFor = 0;

  if (render) renderer.render(scene, camera);
  ctx.input.endFrame(dt);

  if (DEBUG) {
    fpsAcc += rawDt;
    fpsFrames++;
    if (fpsAcc > 0.5) {
      fps = fpsFrames / fpsAcc;
      fpsAcc = 0;
      fpsFrames = 0;
      const p = ctx.player?.position;
      const info = renderer.info.render;
      $('debug-hud').textContent =
        `${fps.toFixed(0)} fps · ${ctx.state} · day ${ctx.time.day} ${fmtHour(ctx.time.hour)} · ` +
        (p ? `pos ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} · ` : '') +
        `calls ${info.calls} · tris ${(info.triangles / 1000).toFixed(0)}k`;
    }
  }
}

function titleCamera(dt) {
  titleAngle += dt * 0.03;
  const r = 420;
  camera.position.set(Math.sin(titleAngle) * r, 120, Math.cos(titleAngle) * r);
  camera.lookAt(0, 15, 0);
}

// ── Debug helpers (window.__game.debug) ──────────────────────────────────
function installDebug() {
  const lm = ctx.world.landmarks;
  ctx.debug = {
    errors: () => errorLog,
    setHour: (h) => ctx.time.setHour(h),
    skip: (h) => ctx.time.skipHours(h),
    speed: (s) => (ctx.time.timeScale = s),
    teleport: (x, z, yaw) => ctx.player.teleport?.(x, z, yaw),
    goto: (name, dx = 0, dz = 0) => {
      const L = lm[name];
      if (!L) return Object.keys(lm);
      ctx.player.teleport?.(L.x + dx, L.z + dz);
      return L;
    },
    give: (id, n = 1) => ctx.inventory.add?.(id, n),
    god: (on = true) => (ctx.flags.godMode = on),
    hold: (code, s = 0.5) => ctx.input.hold(code, s),
    tap: (code) => ctx.input.tap(code),
    look: (yaw, pitch = 0) => {
      if (ctx.player) {
        ctx.player.yaw = yaw;
        ctx.player.pitch = pitch;
      }
    },
    weather: (opts) => ctx.weather.set?.(opts),
    rescuePass: (kind) => ctx.rescue.debugStartPass?.(kind),
    stats: () => (ctx.stats.values ? { ...ctx.stats.values } : null),
    start: (skipIntro = true, difficulty) => {
      if (difficulty) setDifficulty(difficulty);
      return startGame(skipIntro);
    },
    difficulty: (id) => (id ? setDifficulty(id) : ctx.difficulty),
    /**
     * Run the simulation for `seconds` of game-loop time synchronously at a fixed dt (default 1/60),
     * independent of requestAnimationFrame throttling (hidden tabs). Renders once at the end.
     * Optional `each(t)` callback runs before every step (e.g. to hold keys).
     */
    step: (seconds = 1, dt = 1 / 60, each = null) => {
      stepping = true;
      try {
        const n = Math.max(1, Math.round(seconds / dt));
        for (let i = 0; i < n; i++) {
          each?.(i * dt);
          tick(dt, dt, i === n - 1);
        }
      } finally {
        stepping = false;
        last = performance.now();
      }
      return ctx.player?.position?.clone?.();
    },
    state: () => ctx.state,
    landmarks: () => lm,
  };
  if (DEBUG) document.body.classList.add('debug');
}

// Let the loading text paint before the heavy synchronous generation.
setTimeout(() => {
  try {
    boot();
  } catch (e) {
    console.error(e);
    setLoading('Failed to start: ' + e.message);
  }
}, 30);
