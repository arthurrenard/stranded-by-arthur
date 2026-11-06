// Unit tests for the pure timeline helpers of src/story/flareFx.js. Run: node tests/flare.test.mjs
import assert from 'node:assert/strict';
import { FLARE, flareHeight, flareGlow, flareLightIntensity } from '../src/story/flareFx.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`✗ ${name}\n`, e);
    process.exitCode = 1;
  }
}

test('flare climbs ~120 m, then sinks slowly under its parachute', () => {
  assert.equal(flareHeight(0), 0);
  assert.equal(flareHeight(-1), 0);
  assert.ok(flareHeight(1) > 50, 'fast climb at first');
  assert.ok(Math.abs(flareHeight(FLARE.riseTime) - 120) < 1e-9);
  let prev = 0;
  for (let t = 0.1; t <= FLARE.riseTime; t += 0.1) {
    const h = flareHeight(t);
    assert.ok(h >= prev, 'monotonic climb');
    prev = h;
  }
  const end = flareHeight(FLARE.burn);
  assert.ok(end < 120 && end > 100, 'still high when it burns out');
});

test('glow envelope: ignites fast, burns ~8 s, fades at the end', () => {
  assert.equal(flareGlow(0), 0);
  assert.equal(flareGlow(FLARE.burn), 0);
  assert.equal(flareGlow(FLARE.burn + 1), 0);
  assert.equal(flareGlow(0.5), 1);
  assert.equal(flareGlow(5), 1);
  const late = flareGlow(FLARE.burn - FLARE.fadeOut / 2);
  assert.ok(late > 0.4 && late < 0.6);
  assert.ok(FLARE.burn >= 7.5 && FLARE.burn <= 9.5, '~8 s of light');
});

test('light intensity keeps ~FLARE.lux under the head at any height (decay 2)', () => {
  for (const h of [10, 40, 80, 120]) {
    const I = flareLightIntensity(h, 1);
    const d = h + 1.7;
    assert.ok(Math.abs(I / (d * d) - FLARE.lux) < 1e-9);
  }
  assert.equal(flareLightIntensity(60, 0), 0);
  assert.ok(flareLightIntensity(0, 1) > 0, 'never zero distance');
});

console.log(`flare tests: ${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
