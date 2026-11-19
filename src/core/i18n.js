// V6 (V6-L): tiny UI-chrome i18n (English + French) for the HUD's dynamic, frequently rewritten texts
// (day/clock card, compass, bars, fishing widget, vehicle panel, banners, a few toasts).
// Story subtitles, lore and panels stay English (a browser translator handles those well).
//
// Language: ?lang=fr|en, then localStorage 'stranded.lang', then navigator.language (fr* -> fr), else en.
// The dynamic HUD nodes are marked translate="no" so a page translator never fights our updates; when the
// page IS being auto-translated to French (Chrome sets <html class="translated-ltr" lang="fr">) and the
// player made no explicit choice, our own strings switch to French automatically (and back when reverted).
// Pure until initI18n() runs: no DOM access at import time (scripts/check.mjs imports every module in node).

export const LANGS = ['en', 'fr'];
const STORE_KEY = 'stranded.lang';

/** Compass points clockwise from north, per language (index = round(deg / 45) % 8). */
export const COMPASS = {
  en: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'],
  fr: ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'],
};

export const DICT = {
  en: {
    'clock.day': 'Day {n}',
    'diff.easy': 'Easy',
    'diff.medium': 'Medium',
    'diff.hard': 'Hard',
    'diff.title': 'Difficulty: {d}',
    'stat.health': 'Health',
    'stat.thirst': 'Thirst',
    'stat.hunger': 'Hunger',
    'stat.energy': 'Energy',
    'stat.heat': 'Body heat (the framed band is comfortable)',
    'heat.Freezing': 'Freezing',
    'heat.Cold': 'Cold',
    'heat.Chilly': 'Chilly',
    'heat.Comfy': 'Comfy',
    'heat.Warm': 'Warm',
    'heat.Hot': 'Hot',
    'heat.Overheating': 'Overheating',
    'fish.waiting': 'Line cast… wait for a bite',
    'fish.bite': 'BITE! Press {k}',
    'fish.fight': "Reel! Tap {k}, don't snap the line",
    'fish.landed': 'Landed!',
    'fish.lost': 'It got away…',
    'fish.snap': 'Snap! The line broke. It got away…',
    'fish.cancel': 'You reel the line in.',
    'fish.early': 'Too early! It got away…',
    'fish.footWaiting': '{k} to reel in',
    'fish.footLeft': '{s} s left · {k} to give up',
    'fish.catch': 'Catch',
    'fish.line': 'Line',
    'veh.motorTitle': '🚤 Motorboat · {f}/{b} throttle · {l}/{r} steer · {e} disembark',
    'veh.headHome': ' · {k} head for home',
    'veh.motorOpenSea': 'Open sea: press {k} to head for home.',
    'veh.landClose': 'Land is close: {e} to step ashore.',
    'veh.motorFar': 'Head out to open sea (> 250 m from any coast) to go home.',
    'veh.raftTitle': '🛶 Paddle raft · {f}/{b} paddle · {l}/{r} steer · {e} disembark',
    'veh.raftFar': 'Tempest Isle lies ~525 m north-east of the north-east beach.',
    'veh.noPaddle': 'No paddle: you can only drift. Craft a Wooden Paddle (wood 2 + rope 1).',
    'veh.tired': 'Too tired to paddle hard: rest, eat or drink.',
    'rescue.boat': '🚤 Search boat offshore!',
    'rescue.heli': '🚁 Search helicopter overhead!',
    'rescue.hot': "They're turning toward you! Keep waving ({k}) and keep your signals burning.",
    'rescue.cold': 'Get into the open, hold {k} to wave, light a signal fire',
    'storm.banner': '⛈️ Storm over Tempest Isle: rafts capsize and fires go out. Get indoors!',
    'journal.badge': '📖 New journal entry · press {k}',
    'opt.lang': 'Language',
    'key.click': 'Click',
    'key.rclick': 'Right-click',
  },
  fr: {
    'clock.day': 'Jour {n}',
    'diff.easy': 'Facile',
    'diff.medium': 'Moyen',
    'diff.hard': 'Difficile',
    'diff.title': 'Difficulté : {d}',
    'stat.health': 'Santé',
    'stat.thirst': 'Soif',
    'stat.hunger': 'Faim',
    'stat.energy': 'Énergie',
    'stat.heat': 'Chaleur corporelle (la bande encadrée est confortable)',
    'heat.Freezing': 'Glacé',
    'heat.Cold': 'Froid',
    'heat.Chilly': 'Frais',
    'heat.Comfy': 'Bien',
    'heat.Warm': 'Tiède',
    'heat.Hot': 'Chaud',
    'heat.Overheating': 'Surchauffe',
    'fish.waiting': 'Ligne lancée… attends une touche',
    'fish.bite': 'TOUCHE ! Appuie sur {k}',
    'fish.fight': 'Mouline ! Tape {k}, sans casser la ligne',
    'fish.landed': 'Pris !',
    'fish.lost': 'Il s’est échappé…',
    'fish.snap': 'Clac ! La ligne a cassé. Il s’est échappé…',
    'fish.cancel': 'Tu ramènes la ligne.',
    'fish.early': 'Trop tôt ! Il s’est échappé…',
    'fish.footWaiting': '{k} pour ramener la ligne',
    'fish.footLeft': 'encore {s} s · {k} pour abandonner',
    'fish.catch': 'Prise',
    'fish.line': 'Ligne',
    'veh.motorTitle': '🚤 Bateau à moteur · {f}/{b} gaz · {l}/{r} diriger · {e} débarquer',
    'veh.headHome': ' · {k} rentrer',
    'veh.motorOpenSea': 'Pleine mer : appuie sur {k} pour rentrer.',
    'veh.landClose': 'La terre est proche : {e} pour débarquer.',
    'veh.motorFar': 'Gagne la pleine mer (> 250 m de toute côte) pour rentrer.',
    'veh.raftTitle': '🛶 Radeau à pagaie · {f}/{b} pagayer · {l}/{r} diriger · {e} débarquer',
    'veh.raftFar': 'L’île des Tempêtes est à ~525 m au nord-est de la plage nord-est.',
    'veh.noPaddle': 'Pas de pagaie : tu ne peux que dériver. Fabrique une pagaie en bois (bois 2 + corde 1).',
    'veh.tired': 'Trop fatigué pour pagayer fort : repose-toi, mange ou bois.',
    'rescue.boat': '🚤 Bateau de recherche au large !',
    'rescue.heli': '🚁 Hélicoptère de recherche au-dessus !',
    'rescue.hot': 'Ils viennent vers toi ! Continue de faire signe ({k}) et garde tes feux allumés.',
    'rescue.cold': 'Va à découvert, maintiens {k} pour faire signe, allume un feu de signalisation',
    'storm.banner': '⛈️ Tempête sur l’île des Tempêtes : les radeaux chavirent et les feux s’éteignent. Mets-toi à l’abri !',
    'journal.badge': '📖 Nouvelle entrée du journal · appuie sur {k}',
    'opt.lang': 'Langue',
    'key.click': 'Clic',
    'key.rclick': 'Clic droit',
  },
};

let lang = 'en';
let explicit = false; // ?lang= or a stored choice: the translator never overrides it
let baseLang = 'en'; // what we'd use without a page translator
const listeners = new Set();

/** Normalise any language tag to 'fr' | 'en' | null. */
export function normLang(tag) {
  if (typeof tag !== 'string') return null;
  const t = tag.trim().toLowerCase();
  if (t.startsWith('fr')) return 'fr';
  if (t.startsWith('en')) return 'en';
  return null;
}

/** Pure detection: { search, stored, navLang } -> { lang, explicit }. */
export function detectLang({ search = '', stored = null, navLang = '' } = {}) {
  let q = null;
  try {
    q = normLang(new URLSearchParams(search).get('lang'));
  } catch (_) {
    q = null;
  }
  if (q) return { lang: q, explicit: true };
  const s = normLang(stored);
  if (s) return { lang: s, explicit: true };
  return { lang: normLang(navLang) === 'fr' ? 'fr' : 'en', explicit: false };
}

/**
 * Pure: the language a page translator is showing, from the <html> element's class + lang
 * (origLang = the lang attribute we shipped). Returns 'fr' | 'en' | 'other' | null (not translated).
 */
export function translatorLang(className, htmlLang, origLang = 'en') {
  const cls = String(className || '');
  const translated = /\btranslated-(ltr|rtl)\b/.test(cls);
  const changed = !!htmlLang && normLang(htmlLang) !== normLang(origLang);
  if (!translated && !changed) return null;
  return normLang(htmlLang) || (translated ? 'other' : null);
}

export function getLang() {
  return lang;
}

/** Switch language. persist: remember the choice (explicit; the translator no longer overrides it). */
export function setLang(l, { persist = true } = {}) {
  const n = normLang(l) || 'en';
  if (persist) {
    explicit = true;
    baseLang = n;
    try {
      globalThis.localStorage?.setItem(STORE_KEY, n);
    } catch (_) {
      /* private mode */
    }
  }
  if (n === lang) return;
  const prev = lang;
  lang = n;
  for (const fn of [...listeners]) {
    try {
      fn(n, prev);
    } catch (e) {
      console.error(e);
    }
  }
}

/** Subscribe to language changes: fn(lang, prev). Returns unsubscribe. */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Translate key with {var} substitution. Falls back to English, then to the key itself. */
export function t(key, vars) {
  let s = DICT[lang]?.[key];
  if (s == null) s = DICT.en[key];
  if (s == null) s = String(key);
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  return s;
}

/** Compass point for a bearing (0 = N, clockwise) in a language (default: current). */
export function compassPoint(deg, l = lang) {
  const names = COMPASS[l] || COMPASS.en;
  const d = Number(deg) || 0;
  return names[Math.round((((d % 360) + 360) % 360) / 45) % 8];
}

let observer = null;
/** Browser init (main.js): detect the language and watch for a page translator. Safe to call twice. */
export function initI18n() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return lang;
  let stored = null;
  try {
    stored = window.localStorage?.getItem(STORE_KEY) ?? null;
  } catch (_) {
    stored = null;
  }
  const d = detectLang({ search: window.location?.search || '', stored, navLang: navigator?.language || '' });
  explicit = d.explicit;
  baseLang = d.lang;
  const html = document.documentElement;
  const orig = html.getAttribute('lang') || 'en';
  const apply = () => {
    if (explicit) return setLang(baseLang, { persist: false });
    const tl = translatorLang(html.className, html.getAttribute('lang'), orig);
    setLang(tl === 'fr' ? 'fr' : tl === 'en' ? 'en' : baseLang, { persist: false });
  };
  apply();
  if (!observer && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(apply);
    observer.observe(html, { attributes: true, attributeFilter: ['class', 'lang'] });
  }
  return lang;
}

/** Mark a DOM element so browser translators leave it alone (our text updates would fight them). */
export function noTranslate(el) {
  if (!el?.setAttribute) return el;
  el.setAttribute('translate', 'no');
  el.classList?.add('notranslate');
  return el;
}
