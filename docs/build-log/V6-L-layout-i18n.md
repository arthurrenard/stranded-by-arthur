# V6-L: keyboard layouts + French UI chrome

Status: done (check.mjs green, tests/i18n.test.mjs 11/11). Not browser-verified in this pass.

## Keyboard layouts (src/core/input.js, config keys)
- Movement and the keys around it stay positional (KeyboardEvent.code).
- New pseudo-code `Letter:x` (from `e.key`, lowercased, a-z, no Ctrl/Alt/Meta) is pressed/released with
  its physical key (released by code on keyup). It is suppressed when the physical code is itself bound
  to any CONFIG.keys action, so AZERTY KeyA ('q') stays move-left only and Dvorak KeyC ('j') stays craft.
  `onKeyDown` listeners still only see real codes (Konami / skip-key matchers are unaffected).
- CONFIG.keys: craft/journal/map/scoreboard/mute gain `Letter:c/j/m/p/n`. New `drop: ['KeyQ']` (positional).
- Layout detection: `navigator.keyboard.getLayoutMap()` (authoritative, try/catch), else learned from
  keydown code-vs-key. `input.layout` ('qwerty'|'azerty'|'qwertz'|'other'), `input.layoutKnown`,
  `input.keyLabel(code)`, `input.actionLabel(action)`, `input.matches(action, code, e)`; event `input:layout`.
  Module-level exports `keyLabel`, `actionLabel`, `labelFor`, `classifyLayout`, `layoutFromKey`, `setLayout`
  (pure tables for tests and hud-data). Digits are never relabelled.
- Hints: `layoutKeys(text)` in hud-data rewrites W/S, A/D, WASD, "Q drop(s)", Shift+Q for the layout; applied
  to toasts, subtitles, tip cards, journal tips/tip grids, pack help (`packHelp()`), vehicle panel, prompt
  badges, recipe descriptions and slot tooltips. Title + pause controls lists use `data-keys` labels filled by main.js (shows "WASD / ZQSD"
  until the layout is known). Added a "drop" entry to those lists.

## French (src/core/i18n.js)
- Language: ?lang=fr|en, localStorage 'stranded.lang', navigator.language fr*, else en. Defaults to en
  until `initI18n()` (main.js) runs, so node tests stay English.
- `t(key, vars)` with en fallback then key; `compassPoint(deg, lang)` (fr: N NE E SE S SO O NO);
  `onLangChange`; `translatorLang()` + a MutationObserver on <html class/lang>: when Chrome auto-translates
  to French (translated-ltr / lang=fr) and the player made no explicit choice, our strings switch to French.
- HUD: clock card, compass (+ readout), stat bar rows + heat + depth (status chips stay translatable), fishing widget, vehicle panel, banners, journal badge and
  prompt key badges are `translate="no"` + `.notranslate`. Root-cause fix of the "Jour/Day" flicker: the
  HUD compared its text against the DOM (`textContent !== day`), which the translator rewrites; it now
  uses a cached `setText()` (el._t). Translated: day, difficulty badge + tooltip, compass, bar tooltips,
  heat word, fishing phases/foot/labels, vehicle panel, rescue + storm banners, journal badge.
- Pause overlay: EN / FR toggle (persists). Language/layout changes refresh the HUD strings live.
- Out of scope: story subtitles, lore, panels, prompts' action labels (left to the browser translator).
- Controls lists: "Click"/"Right-click" follow the language too (refreshed on lang + layout change).
