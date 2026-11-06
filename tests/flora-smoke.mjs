// Smoke harness for Builder B (flora): a fake ctx with the real heightfield and core modules, no WebGL.
import * as THREE from 'three';
import { CONFIG } from '../src/config.js';
import { createRng } from '../src/core/rng.js';
import { createEvents } from '../src/core/events.js';
import { createColliders } from '../src/core/spatial.js';
import { createHeightfield } from '../src/world/heightfield.js';

export function makeCtx() {
  const events = createEvents();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1.6, 0.1, 2600);
  scene.add(camera);
  const W = createHeightfield();
  const S = W.landmarks.spawn;
  camera.position.set(S.x, S.y + 1.7, S.z);
  const registered = [];
  const log = { audio: [], damage: [], inv: [], toast: [] };
  let hoursTotal = 6.15;
  const time = {
    get hoursTotal() { return hoursTotal; },
    get hour() { return hoursTotal % 24; },
    get day() { return Math.floor(hoursTotal / 24) + 1; },
    dtHours: 0, dtGameSec: 0, daylight: 1, sunDir: new THREE.Vector3(0.4, 0.8, 0.3).normalize(),
    hoursPerSec: 24 / CONFIG.time.dayLengthSec, timeScale: 1, paused: false,
    advance(h) { hoursTotal += h; this.dtHours = h; this.dtGameSec = h * 3600; },
    /** Move the clock without a frame delta (no scheduling pressure). */
    jump(h) { hoursTotal += h; this.dtHours = 0; this.dtGameSec = 0; },
    skipHours(h) { const from = hoursTotal; hoursTotal += h; events.emit('time:skip', { from, to: hoursTotal, hours: h }); },
  };
  const ctx = {
    THREE, config: CONFIG, params: new URLSearchParams(), debugMode: false,
    scene, camera, events, state: 'playing', rng: createRng(CONFIG.seed), time, world: W,
    colliders: createColliders(),
    interact: { register(def) { const h = Object.assign(def, { removed: false, remove() { h.removed = true; } }); registered.push(h); return h; }, addProvider() { return () => {}; } },
    flags: { cinematic: false },
    uniforms: { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0.3).normalize() }, uWindStrength: { value: 0.35 }, uDaylight: { value: 1 }, uRain: { value: 0 } },
    heatSources: new Set(), signals: new Set(), shelters: new Set(),
    stats_summary: { distanceWalked: 0, itemsCrafted: 0, foodsEaten: 0, plantsGathered: 0 },
    audio: { play(name, opts) { log.audio.push({ name, opts }); } },
    stats: { damage(n, cause) { log.damage.push({ n, cause }); } },
    inventory: { add(id, n) { log.inv.push({ id, n }); return n; } },
    ui: { toast(t) { log.toast.push(t); } },
    weather: { wind: { x: 1, z: 0, strength: 0.4 }, cloudiness: 0.2 },
    player: { position: new THREE.Vector3(S.x, S.y, S.z) },
  };
  return { ctx, registered, log, time };
}
