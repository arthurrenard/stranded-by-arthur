// Coconut knock-out (CONFIG.coconutKO): stats.knockOut() + the fatigue window. Runs stats.js against a fake ctx.
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import * as Stats from '../src/survival/stats.js';

function fakeCtx(difficulty = CONFIG.difficulty.presets.hard) {
  const handlers = {};
  const toasts = [];
  const time = {
    hoursTotal: 10, hour: 10, day: 1, dtHours: 0, timeScale: 1, paused: false, daylight: 1, isNight: false,
    sunDir: { x: 0, y: 1, z: 0 },
    skipHours(h) { this.hoursTotal += h; this.hour = this.hoursTotal % 24; },
  };
  const ctx = {
    state: 'playing', difficulty: { id: 'hard', ...difficulty }, time,
    flags: { cinematic: false, godMode: false, sleeping: false },
    events: { on(n, f) { (handlers[n] ||= []).push(f); return () => {}; }, emit(n, p) { (handlers[n] || []).forEach((f) => f(p)); } },
    ui: { toast: (t) => toasts.push(t), subtitle() {}, flash() {}, hint() {} },
    fade: () => Promise.resolve(),
    heatSources: new Set(), shelters: new Set(),
    player: { position: { x: 0, y: 2, z: 0 }, swimming: false, moving: false, sprinting: false, inWater: false, headUnderwater: false },
    weather: { rain: 0, cloudiness: 0, wind: { x: 1, z: 0, strength: 0.2 }, airTempOffset: 0 },
    flora: { canopyAt: () => 0 },
    world: { biomeAt: () => ({ sand: 1 }), waterAt: () => null, heightAt: () => 1, islandAt: () => 'main' },
  };
  return { ctx, toasts };
}

const { ctx, toasts } = fakeCtx();
const st = Stats.create(ctx);
st.init?.();
Object.assign(st.values, { health: 90, thirst: 60, hunger: 60, energy: 90 });
const ok = await st.knockOut();
assert.equal(ok, true, 'knockOut resolves true');
assert.equal(ctx.time.hoursTotal, 14, 'skips 4 game hours');
assert.ok(Math.abs(st.values.health - 10) < 1e-6, `wakes at 10 % health (got ${st.values.health})`);
assert.ok(st.values.thirst < 60 && st.values.thirst >= 20, `thirstier but floored (got ${st.values.thirst})`);
assert.ok(st.values.hunger < 60 && st.values.hunger >= 20, `hungrier but floored (got ${st.values.hunger})`);
assert.ok(st.values.energy <= 18 + 1e-6, `low energy (got ${st.values.energy})`);
assert.equal(st.fatigued, true, 'fatigued after waking');
assert.equal(st.dead, false, 'not dead');
assert.equal(ctx.flags.sleeping, false, 'sleeping flag cleared');
assert.ok(toasts.some((t) => /pounding headache/.test(t)), 'wake-up toast');

// rest a while (well fed) during the headache: energy must stay at or below the cap
Object.assign(st.values, { thirst: 90, hunger: 90 });
for (let i = 0; i < 600; i++) st.update(1 / 20); // 30 real s of idling
assert.ok(st.values.energy <= CONFIG.coconutKO.fatigueEnergyCap + 1e-6, `energy capped during fatigue (got ${st.values.energy.toFixed(1)})`);
assert.equal(st.dead, false, 'hard-mode grace: survives the first seconds at 10 % health');

// after the headache window the cap lifts
ctx.time.hoursTotal += 2.1;
st.update(1 / 20);
assert.equal(st.fatigued, false, 'fatigue ends after 2 game hours');
console.log('coconut-ko: all checks passed');
