// V6-L: keyboard layouts (AZERTY / QWERTZ labels, Letter: pseudo-codes) + the HUD's tiny i18n.
// Run: node tests/i18n.test.mjs
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import * as I from '../src/core/i18n.js';
import { labelFor, classifyLayout, layoutFromKey, letterCode, matchesAction, setLayout, keyLabel, actionLabel, createInput } from '../src/core/input.js';
import { compassLabel, heatWord, vehiclePanel, layoutKeys, packHelp, PACK_HELP } from '../src/ui/hud-data.js';

let failed = 0, passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n  ${e.stack || e}`);
  }
}

// ── i18n ────────────────────────────────────────────────────────────────
test('t(): english default, french, fallbacks and vars', () => {
  assert.equal(I.getLang(), 'en');
  assert.equal(I.t('clock.day', { n: 3 }), 'Day 3');
  I.setLang('fr', { persist: false });
  assert.equal(I.t('clock.day', { n: 3 }), 'Jour 3');
  assert.equal(I.t('no.such.key'), 'no.such.key');
  I.DICT.en['test.only'] = 'only {x} english';
  assert.equal(I.t('test.only', { x: 'in' }), 'only in english', 'missing fr falls back to en');
  assert.equal(I.t('test.only'), 'only {x} english', 'missing var keeps the placeholder');
  delete I.DICT.en['test.only'];
  I.setLang('en', { persist: false });
  assert.equal(I.t('clock.day', { n: 1 }), 'Day 1');
});

test('every french key has an english twin (and vice versa)', () => {
  assert.deepEqual(Object.keys(I.DICT.fr).sort(), Object.keys(I.DICT.en).sort());
});

test('detectLang: ?lang, then storage, then navigator', () => {
  assert.deepEqual(I.detectLang({ search: '?lang=fr', stored: 'en', navLang: 'en-US' }), { lang: 'fr', explicit: true });
  assert.deepEqual(I.detectLang({ search: '?debug=1', stored: 'fr', navLang: 'en-US' }), { lang: 'fr', explicit: true });
  assert.deepEqual(I.detectLang({ search: '', stored: null, navLang: 'fr-BE' }), { lang: 'fr', explicit: false });
  assert.deepEqual(I.detectLang({ search: '?lang=xx', stored: 'zz', navLang: 'nl-BE' }), { lang: 'en', explicit: false });
});

test('translatorLang: Chrome translate markers', () => {
  assert.equal(I.translatorLang('', 'en', 'en'), null);
  assert.equal(I.translatorLang('translated-ltr', 'fr', 'en'), 'fr');
  assert.equal(I.translatorLang('foo translated-ltr', 'de', 'en'), 'other');
  assert.equal(I.translatorLang('', 'fr-FR', 'en'), 'fr');
});

test('compass labels per language', () => {
  const en = [0, 45, 90, 135, 180, 225, 270, 315].map((d) => I.compassPoint(d, 'en'));
  const fr = [0, 45, 90, 135, 180, 225, 270, 315].map((d) => I.compassPoint(d, 'fr'));
  assert.deepEqual(en, ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
  assert.deepEqual(fr, ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO']);
  assert.equal(I.compassPoint(346, 'fr'), 'N');
  assert.equal(I.compassPoint(-90, 'fr'), 'O');
  assert.equal(compassLabel(270), 'W', 'hud-data default = current language (en)');
  I.setLang('fr', { persist: false });
  assert.equal(compassLabel(270), 'O');
  assert.equal(compassLabel(225), 'SO');
  assert.equal(heatWord(60), 'Bien');
  assert.match(vehiclePanel({ type: 'paddle_raft' }, { hasPaddle: true }).title, /Radeau/);
  I.setLang('en', { persist: false });
  assert.equal(heatWord(60), 'Comfy');
});

test('onLangChange fires once per real change', () => {
  let n = 0;
  const off = I.onLangChange(() => n++);
  I.setLang('fr', { persist: false });
  I.setLang('fr', { persist: false });
  I.setLang('en', { persist: false });
  off();
  I.setLang('fr', { persist: false });
  I.setLang('en', { persist: false });
  assert.equal(n, 2);
});

// ── keyboard layouts ────────────────────────────────────────────────────
test('labelFor: QWERTY / AZERTY / QWERTZ tables', () => {
  assert.equal(labelFor('KeyQ', 'qwerty'), 'Q');
  assert.equal(labelFor('KeyW', 'qwerty'), 'W');
  assert.equal(labelFor('KeyQ', 'azerty'), 'A');
  assert.equal(labelFor('KeyW', 'azerty'), 'Z');
  assert.equal(labelFor('KeyA', 'azerty'), 'Q');
  assert.equal(labelFor('KeyZ', 'azerty'), 'W');
  assert.equal(labelFor('Semicolon', 'azerty'), 'M');
  assert.equal(labelFor('KeyE', 'azerty'), 'E');
  assert.equal(labelFor('KeyY', 'qwertz'), 'Z');
  assert.equal(labelFor('KeyZ', 'qwertz'), 'Y');
  assert.equal(labelFor('KeyW', 'qwertz'), 'W');
  assert.equal(labelFor('Digit1', 'azerty'), '1', 'digits are never relabelled');
  assert.equal(labelFor('Space', 'azerty'), 'Space');
  assert.equal(labelFor('Letter:m', 'qwerty'), 'M');
  assert.equal(labelFor('KeyD', 'other', new Map([['KeyD', 'e']])), 'E', 'other layouts use the layout map');
});

test('classifyLayout + layoutFromKey', () => {
  assert.equal(classifyLayout(new Map([['KeyQ', 'a'], ['KeyW', 'z'], ['KeyA', 'q']])), 'azerty');
  assert.equal(classifyLayout(new Map([['KeyQ', 'q'], ['KeyW', 'w'], ['KeyY', 'z'], ['KeyZ', 'y']])), 'qwertz');
  assert.equal(classifyLayout(new Map([['KeyQ', 'q'], ['KeyW', 'w'], ['KeyY', 'y'], ['KeyZ', 'z']])), 'qwerty');
  assert.equal(classifyLayout(new Map([['KeyQ', "'"], ['KeyW', ','], ['KeyY', 'f']])), 'other');
  assert.equal(classifyLayout(new Map()), null);
  assert.equal(layoutFromKey('KeyQ', 'a'), 'azerty');
  assert.equal(layoutFromKey('KeyW', 'Z'), 'azerty');
  assert.equal(layoutFromKey('KeyM', ','), 'azerty');
  assert.equal(layoutFromKey('KeyY', 'z'), 'qwertz');
  assert.equal(layoutFromKey('KeyQ', 'q'), 'qwerty');
  assert.equal(layoutFromKey('KeyE', 'e'), null, 'same on every layout: no information');
  assert.equal(layoutFromKey('Digit1', '&'), null);
});

test('keyLabel / actionLabel follow the current layout', () => {
  setLayout('azerty');
  assert.equal(keyLabel('KeyQ'), 'A');
  assert.equal(keyLabel('KeyW'), 'Z');
  assert.equal(actionLabel('map'), 'M');
  assert.equal(actionLabel('drop'), 'A');
  assert.equal(vehiclePanel({ type: 'paddle_raft' }, { hasPaddle: true }).title, '🛶 Paddle raft · Z/S paddle · Q/D steer · E disembark');
  assert.match(packHelp(), /A to drop it\.$/);
  assert.equal(layoutKeys('Q drops the selected stack (Shift+Q one). WASD'), 'A drops the selected stack (Shift+A one). ZQSD');
  setLayout('qwertz');
  assert.equal(keyLabel('KeyW'), 'W');
  assert.equal(keyLabel('KeyZ'), 'Y');
  assert.equal(layoutKeys('W/S paddle, A/D steer'), 'W/S paddle, A/D steer');
  setLayout('qwerty');
  assert.equal(packHelp(), PACK_HELP);
  assert.equal(vehiclePanel({ type: 'paddle_raft' }, { hasPaddle: true }).title, '🛶 Paddle raft · W/S paddle · A/D steer · E disembark');
});

test('Letter: pseudo-code matching (no conflicts with positional codes)', () => {
  assert.equal(letterCode({ key: 'M' }), 'Letter:m');
  assert.equal(letterCode({ key: 'm', ctrlKey: true }), null);
  assert.equal(letterCode({ key: '&' }), null);
  assert.ok(CONFIG.keys.map.includes('Letter:m'));
  // AZERTY: the printed M is code 'Semicolon' -> map
  assert.ok(matchesAction('map', 'Semicolon', { key: 'm' }));
  // QWERTY M still works positionally
  assert.ok(matchesAction('map', 'KeyM', { key: 'm' }));
  // AZERTY KeyA produces 'q' but is move-left: never the drop key (drop stays positional KeyQ)
  assert.ok(!matchesAction('drop', 'KeyA', { key: 'q' }));
  assert.ok(matchesAction('drop', 'KeyQ', { key: 'a' }));
  // Dvorak: KeyC produces 'j' but KeyC is bound (craft): no journal
  assert.ok(!matchesAction('journal', 'KeyC', { key: 'j' }));
  assert.ok(matchesAction('craft', 'KeyC', { key: 'j' }));
});

test('createInput: Letter press/release and layout detection from keydown', () => {
  const handlers = {};
  const fakeTarget = () => ({ addEventListener: (type, fn) => ((handlers[type] ||= []).push(fn)) });
  const saved = { window: globalThis.window, document: globalThis.document };
  globalThis.window = fakeTarget();
  globalThis.document = { addEventListener() {}, pointerLockElement: null };
  try {
    const emitted = [];
    const events = { emit: (n, p) => emitted.push([n, p]) };
    const input = createInput({ addEventListener() {} }, events);
    const fire = (type, code, key) => handlers[type].forEach((fn) => fn({ code, key, repeat: false, preventDefault() {}, target: null }));
    const seen = [];
    input.onKeyDown((code) => seen.push(code));
    fire('keydown', 'Semicolon', 'm'); // AZERTY M
    assert.ok(input.wasPressed('map'));
    assert.ok(input.isDown('Letter:m'));
    assert.deepEqual(seen, ['Semicolon'], 'listeners never see Letter: codes (Konami etc.)');
    input.endFrame(0.016);
    fire('keyup', 'Semicolon', 'M');
    assert.ok(!input.isDown('map'));
    fire('keydown', 'KeyA', 'q'); // AZERTY move-left: no Letter:q, and the layout is learned
    assert.ok(!input.isDown('Letter:q'));
    assert.equal(input.layout, 'azerty');
    assert.equal(input.keyLabel('KeyQ'), 'A');
    assert.ok(emitted.some(([n, p]) => n === 'input:layout' && p.layout === 'azerty'));
    fire('keyup', 'KeyA', 'q');
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    setLayout('qwerty');
  }
});

console.log(`i18n: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
