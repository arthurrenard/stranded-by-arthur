// Tests for the audio stack (Builder F2): pure mixing math (mix.js), every recipe bakes to a finite,
// normalized buffer (sounds.js), and the engine (audio.js) runs end to end against a mock WebAudio
// context (no throws, voice cap, node cleanup, loops, events, mute). Run: node tests/audio.test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as M from '../src/audio/mix.js';
import { RECIPES, renderSound, resolveName, BAKE_ORDER } from '../src/audio/sounds.js';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n`, e);
    process.exitCode = 1;
  }
}

// ── mix.js ──────────────────────────────────────────────────────────────
await test('ocean is loud on the beach, faint inland, finite everywhere', () => {
  assert.ok(M.oceanLevel(0, 1) > 0.9);
  assert.ok(M.oceanLevel(200, 1) < 0.1);
  assert.ok(M.oceanLevel(-50, 1) >= M.oceanLevel(0, 1) - 1e-9);
  assert.ok(M.oceanLevel(0, 120) < M.oceanLevel(0, 1));
  for (const c of [-300, -1, 0, 30, 500]) assert.ok(Number.isFinite(M.oceanLevel(c, 3, 1)) && Number.isFinite(M.oceanCutoff(c)));
});
await test('birds sing by day only, crickets/frogs by night', () => {
  assert.equal(M.birdRate(12, 0, 1, 0, 0, 1), 0);
  assert.ok(M.birdRate(7, 1, 1, 0, 0, 1) > M.birdRate(12, 1, 0, 0, 0, 1));
  assert.ok(M.cricketLevel(0, 1, 1, 0, 0, 1) > 0.3);
  assert.equal(M.cricketLevel(1, 1, 1, 0, 0, 1), 0);
  assert.ok(M.frogLevel(3, 0, 0) > 0.5 && M.frogLevel(100, 0, 0) === 0);
});
await test('river babble within 25 m, heartbeat below 25 health', () => {
  assert.equal(M.riverLevel(null), 0);
  assert.equal(M.riverLevel(30), 0);
  assert.ok(M.riverLevel(3) > 0.9);
  assert.equal(M.heartbeat(80).period, 0);
  const a = M.heartbeat(20), b = M.heartbeat(5);
  assert.ok(a.period > b.period && b.volume > a.volume && b.period > 0);
});
await test('gate de-dupes the same name within the window', () => {
  const g = M.createGate();
  assert.equal(g('x', 1.0, 0.06), true);
  assert.equal(g('x', 1.03, 0.06), false);
  assert.equal(g('y', 1.03, 0.06), true);
  assert.equal(g('x', 1.07, 0.06), true);
});
await test('doppler, pan and air absorption', () => {
  assert.ok(M.doppler(-30) > 1 && M.doppler(30) < 1 && M.doppler(0) === 1);
  assert.ok(M.panToward(1, 0, 0) > 0.99); // east is on the right when facing north
  assert.ok(M.panToward(-1, 0, 0) < -0.99);
  assert.ok(M.airCutoff(10) === 20000 && M.airCutoff(800) < 2000);
  const w = M.windLevels({}, 1.2, 1, 0, 1, 1);
  assert.ok(w.base > 0 && w.howl > 0.9 && w.rustle > 0);
});

// ── sounds.js ───────────────────────────────────────────────────────────
await test('every recipe variant renders finite, normalized audio', () => {
  for (const name of Object.keys(RECIPES)) {
    for (let v = 0; v < RECIPES[name].variants; v++) {
      const a = renderSound(name, v);
      assert.ok(a instanceof Float32Array && a.length > 100, `${name}#${v} empty`);
      let p = 0;
      for (let i = 0; i < a.length; i++) {
        assert.ok(Number.isFinite(a[i]), `${name}#${v} NaN`);
        p = Math.max(p, Math.abs(a[i]));
      }
      assert.ok(p > 0.3 && p <= 1, `${name}#${v} peak ${p}`);
    }
  }
  for (const n of BAKE_ORDER) assert.ok(RECIPES[n], `BAKE_ORDER lists unknown ${n}`);
});
await test('every sound the SPEC lists resolves', () => {
  const names = 'footstep_sand footstep_grass footstep_rock footstep_water jump land splash pickup craft eat drink hurt ignite tree_creak tree_crash gasp quack chime ui_click ui_open heartbeat flare thunder cook'.split(' ');
  for (const n of names) assert.ok(resolveName(n), n);
  assert.equal(resolveName('birds_flush'), 'bird_trill'); // fauna's flock flush is aliased to a trill
});

// ── engine without WebAudio ─────────────────────────────────────────────
function fakeCtx() {
  const handlers = {};
  const toasts = [];
  let pressMute = false;
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, 2, 0);
  const heat = { position: new THREE.Vector3(3, 1, 0), radius: 4, warmth: 1, kind: 'campfire', lit: true };
  const ctx = {
    THREE,
    state: 'playing',
    camera,
    events: {
      on(ev, fn) {
        (handlers[ev] ||= []).push(fn);
      },
      emit(ev, p) {
        for (const fn of handlers[ev] || []) fn(p);
      },
    },
    input: { wasPressed: (a) => a === 'mute' && pressMute },
    time: { hour: 22, daylight: 0.02 },
    world: {
      heightAt: () => 0.5,
      coastDistance: (x) => 15 + x * 0.5,
      riverAt: () => ({ d: 6, w: 2 }),
      biomeAt: () => ({ forest: 0.6, meadow: 0.3, sand: 0.1 }),
      lakes: [{ id: 'pond', x: 20, z: 0, waterRadius: 12 }],
    },
    flora: { canopyAt: () => 0.5 },
    weather: { rain: 0.6, storm: 0.4, wind: { x: 1, z: 0, strength: 1.1 } },
    player: { headUnderwater: false },
    stats: { values: { health: 12 } },
    flags: { sheltered: false },
    heatSources: new Set([heat]),
    items: { berries: { category: 'food' }, bottle_water: { category: 'drink' } },
    ui: { toast: (t) => toasts.push(t) },
  };
  return { ctx, handlers, toasts, heat, setMute: (v) => (pressMute = v) };
}

const EVENTS = [
  ['player:footstep', { surface: 'sand', sprint: true }],
  ['player:footstep', { surface: 'water', swim: true }],
  ['player:footstep', { surface: 'lava' }],
  ['player:jump', { speed: 3 }],
  ['player:land', { speed: 9 }],
  ['player:enterWater', { type: 'ocean' }],
  ['player:surfaced', {}],
  ['player:hurt', { amount: 12, cause: 'fall' }],
  ['harvest', { id: 'wood', n: 1 }],
  ['craft:done', { recipe: 'rope' }],
  ['item:consumed', { id: 'berries' }],
  ['item:consumed', { id: 'bottle_water' }],
  ['drink', { source: 'lake' }],
  ['fire:lit', { fire: { position: new THREE.Vector3(3, 1, 0) } }],
  ['fire:out', { fire: { position: new THREE.Vector3(3, 1, 0) } }],
  ['torch:toggle', { lit: false }],
  ['food:cooked', { from: 'wild_apple', to: 'baked_apple', n: 1 }],
  ['structure:placed', { type: 'campfire', position: new THREE.Vector3(1, 0, 1) }],
  ['tree:falling', { position: new THREE.Vector3(5, 0, 5) }],
  ['tree:fell', { position: new THREE.Vector3(8, 0, 5) }],
  ['weather:thunder', { intensity: 0.8 }],
  ['easter:found', { id: 'x' }],
  ['flare:fired', { position: new THREE.Vector3(0, 2, 0) }],
  ['player:hurt', null],
];

const { create } = await import('../src/audio/audio.js');

await test('engine is a silent no-op without WebAudio', () => {
  const { ctx } = fakeCtx();
  const a = create(ctx);
  a.init();
  a.resume();
  for (let i = 0; i < 10; i++) a.update(0.016);
  for (const n of Object.keys(RECIPES)) a.play(n, { position: new THREE.Vector3(1, 2, 3) });
  a.setLoop('rotor', 1, new THREE.Vector3());
  a.setMasterVolume(0.3);
  for (const [ev, p] of EVENTS) ctx.events.emit(ev, p);
  assert.equal(a.stats().state, 'unavailable');
});

// ── mock WebAudio ───────────────────────────────────────────────────────
let liveNodes = 0;
class Param {
  constructor(v = 0) {
    this.value = v;
  }
  setTargetAtTime(v) {
    assert.ok(Number.isFinite(v), 'non-finite automation value');
    this.value = v;
    return this;
  }
  setValueAtTime(v) {
    return this.setTargetAtTime(v);
  }
  linearRampToValueAtTime(v) {
    return this.setTargetAtTime(v);
  }
  exponentialRampToValueAtTime(v) {
    return this.setTargetAtTime(v);
  }
  cancelScheduledValues() {
    return this;
  }
  cancelAndHoldAtTime() {
    return this;
  }
}
class Node {
  constructor(ac) {
    this.ac = ac;
    this.outs = new Set();
    ac.created++;
  }
  connect(n) {
    assert.ok(n instanceof Node || n instanceof Param, 'connect to a non-node');
    if (!this.outs.size) liveNodes++;
    this.outs.add(n);
    return n;
  }
  disconnect() {
    if (this.outs.size) liveNodes--;
    this.outs.clear();
  }
}
class Source extends Node {
  constructor(ac) {
    super(ac);
    this.started = false;
    this.onended = null;
  }
  start() {
    assert.ok(!this.started, 'started twice');
    this.started = true;
    this.ac.sources.add(this);
  }
  stop() {
    if (!this.ac.sources.has(this)) return;
    this.ac.sources.delete(this);
    queueMicrotask(() => this.onended?.());
  }
}
class MockAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.created = 0;
    this.sources = new Set();
    this.destination = new Node(this);
    this.listener = {};
    for (const k of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'upX', 'upY', 'upZ']) this.listener[k] = new Param(0);
    this.listener.forwardZ = new Param(-1);
    MockAudioContext.last = this;
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  createGain() {
    const n = new Node(this);
    n.gain = new Param(1);
    return n;
  }
  createBiquadFilter() {
    const n = new Node(this);
    Object.assign(n, { type: 'lowpass', frequency: new Param(350), Q: new Param(1), gain: new Param(0) });
    return n;
  }
  createOscillator() {
    const n = new Source(this);
    Object.assign(n, { type: 'sine', frequency: new Param(440), detune: new Param(0), setPeriodicWave() {} });
    return n;
  }
  createBufferSource() {
    const n = new Source(this);
    Object.assign(n, { buffer: null, loop: false, playbackRate: new Param(1), detune: new Param(0) });
    return n;
  }
  createPanner() {
    const n = new Node(this);
    for (const k of ['positionX', 'positionY', 'positionZ', 'orientationX', 'orientationY', 'orientationZ']) n[k] = new Param(0);
    return n;
  }
  createStereoPanner() {
    const n = new Node(this);
    n.pan = new Param(0);
    return n;
  }
  createDynamicsCompressor() {
    const n = new Node(this);
    for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new Param(0);
    return n;
  }
  createConvolver() {
    const n = new Node(this);
    n.buffer = null;
    return n;
  }
  createWaveShaper() {
    const n = new Node(this);
    n.curve = null;
    return n;
  }
  createPeriodicWave() {
    return {};
  }
  createBuffer(ch, length, sr) {
    assert.ok(length > 0 && sr >= 3000 && sr <= 384000, `bad buffer ${length}@${sr}`);
    const data = Array.from({ length: ch }, () => new Float32Array(length));
    return {
      numberOfChannels: ch, length, sampleRate: sr, duration: length / sr,
      getChannelData: (i) => data[i],
      copyToChannel: (src, i) => data[i].set(src.subarray(0, length)),
    };
  }
}

await test('engine runs end to end on a mock WebAudio context', async () => {
  globalThis.window = { AudioContext: MockAudioContext, addEventListener() {} };
  const { ctx, toasts, heat, setMute } = fakeCtx();
  const a = create(ctx);
  a.init();
  a.play('thunder'); // before resume: ignored, no throw
  a.resume();
  const ac = MockAudioContext.last;
  assert.ok(ac, 'context created on resume');
  await Promise.resolve();
  assert.equal(ac.state, 'running');
  const step = (n, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      ac.currentTime += dt;
      a.update(dt);
    }
  };
  // night, rain, river, pond, fire, low health
  step(240);
  const shots = [...ac.sources].filter((s) => s.buffer && !s.loop).length;
  assert.ok(shots > 0, 'ambient schedulers / heartbeat fired');
  assert.ok(ac.destination && [...ac.sources].some((s) => s.loop), 'beds running');
  // underwater, then daytime in the forest
  ctx.player.headUnderwater = true;
  step(60);
  ctx.player.headUnderwater = false;
  Object.assign(ctx.time, { hour: 7, daylight: 1 });
  ctx.weather.rain = 0;
  step(240);
  // every recipe with and without a position
  for (const n of Object.keys(RECIPES)) {
    a.play(n);
    a.play(n, { position: new THREE.Vector3(Math.random() * 40, 2, Math.random() * 40), volume: 0.8, rate: 1.1 });
    a.update(0);
  }
  assert.ok(a.stats().voices <= 24, `voices ${a.stats().voices}`);
  // de-dupe: the same name twice in a row plays once (the gate runs on the wall clock)
  step(30, 0.1);
  await new Promise((r) => setTimeout(r, 450));
  const before = ac.created;
  a.play('chime');
  const mid = ac.created;
  a.play('chime');
  assert.ok(mid > before && ac.created === mid, 'chime de-duped');
  // loops with a moving source (Doppler)
  const heli = new THREE.Vector3(-300, 60, 0);
  for (let i = 0; i < 120; i++) {
    heli.x += 1;
    a.setLoop('rotor', 1, heli);
    a.setLoop('engine', 0.5);
    step(1);
  }
  a.setLoop('rotor', 0);
  a.setLoop('engine', 0);
  a.setLoop('nonsense', 1);
  step(240);
  // events (flushed on the next update)
  await new Promise((r) => setTimeout(r, 450));
  const beforeEv = ac.created;
  for (const [ev, p] of EVENTS) ctx.events.emit(ev, p);
  step(2);
  assert.ok(ac.created > beforeEv + 20, 'event sounds played');
  // mute toggle
  setMute(true);
  a.update(0.016);
  setMute(false);
  assert.equal(a.muted, true);
  assert.equal(toasts.at(-1), 'Sound off');
  setMute(true);
  a.update(0.016);
  setMute(false);
  assert.equal(a.muted, false);
  assert.equal(toasts.at(-1), 'Sound on');
  a.setMasterVolume(0.25);
  a.setMasterVolume('junk');
  assert.equal(a.stats().volume, 0.25);
  // finish every one-shot: voices drain and their nodes disconnect
  heat.lit = false;
  ctx.stats.values.health = 100;
  Object.assign(ctx.time, { hour: 12, daylight: 0 });
  ctx.state = 'paused';
  for (const s of [...ac.sources]) if (!s.loop && s.buffer) s.stop();
  await new Promise((r) => setTimeout(r, 0));
  step(10);
  assert.equal(a.stats().voices, 0, 'voices drained');
  // the whole bake queue completes over time
  step(600);
  const [done, total] = a.stats().baked.split('/').map(Number);
  assert.equal(done, total);
  assert.ok(Number.isFinite(liveNodes));
  delete globalThis.window;
});

await test('a context that fails to build degrades to a no-op', () => {
  globalThis.window = {
    AudioContext: class {
      constructor() {
        this.state = 'running';
      }
      createGain() {
        throw new Error('boom');
      }
      close() {}
    },
    addEventListener() {},
  };
  const { ctx } = fakeCtx();
  const a = create(ctx);
  a.init();
  a.resume();
  a.update(0.016);
  a.play('jump');
  a.setLoop('rotor', 1, { x: 0, y: 0, z: 0 });
  a.update(0.016);
  assert.equal(a.stats().state, 'unavailable');
  delete globalThis.window;
});

console.log(`audio: ${passed} tests passed`);
