// HUD (Builder E): survival bars, heat gauge, status chips, compass, clock, hotbar, prompts,
// toasts, subtitles, tutorial hints, screen-edge vignettes, panels (crafting / journal / map),
// death + win screens. Everything is DOM inside #hud; styles in hud.css.
//
// Layering: #hud stays a static box so its fixed children choose their own z-index against the
// global overlays (letterbox 40, #fade 50, #title/#pause 60). The gameplay layer (.hud-game) is hidden
// with the class "hud-off" until setVisible(true); subtitles + toasts live outside it so the intro
// can use them while the HUD is off.
import './hud.css';
import { CONFIG } from '../config.js';
import { ITEMS } from '../core/items.js';
import { clamp, clamp01, fmtHour, angleDiff } from '../core/util.js';
import { DEATH, RESCUE_METHOD, fmtDuration, heatWord, compassLabel, STRUCTURE_ICON, objectiveView, objectiveSig, raftWinText, relBearing, compassPlace, HUNGER_ICON, deathLead, vehiclePanel, stormBannerOn, isleSightingDue } from './hud-data.js';
import { createPanels } from './hud-panels.js';
import { createMap } from './hud-map.js';

const PX_PER_DEG = 3;
const RAD2DEG = 180 / Math.PI;
const MAX_TOASTS = 6;
// v3: stats.js still toasts hunger warnings with the leaves icon; the hunger STAT icon is now a steak
const HUNGER_TEXT = /hung|starv|stomach|famish|hollow|edible|eat\b|food/i;

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

const WARNINGS = {
  thirst: { icon: '💧', low: 'You are getting thirsty.', critical: 'You are dying of thirst! Find fresh water.', hint: 'Drink at Spring Pond, the river or Mirror Lake: look at the water and press E.' },
  hunger: { icon: HUNGER_ICON, low: 'Your stomach growls.', critical: 'You are starving!', hint: 'Berries, apples, chestnuts and coconuts are safe. Cooked food fills you up far more.' },
  cold: { icon: '🥶', low: 'You are getting cold.', critical: 'You are freezing! Get warm, now.', hint: 'Stand in the sun, stay by a campfire, or light a torch (T). Being wet makes cold much worse.' },
  hot: { icon: '🥵', low: 'You are overheating.', critical: 'Heatstroke! Get into the shade and drink.', hint: 'Tree shade and water cool you down. Don\'t sprint in the afternoon sun.' },
  energy: { icon: '⚡', low: 'You are getting tired.', critical: 'You are exhausted.', hint: 'Rest a moment: energy comes back while you stand still. Baked yam and chamomile help.' },
  drowning: { icon: '🫧', low: 'You are running out of air!', critical: 'You are drowning! Swim up (Space)!', hint: 'Hold Space to swim up. Swimming while exhausted makes you sink.' },
  health: { icon: '❤️', low: 'You are badly hurt.', critical: 'You are close to death!', hint: 'Aloe, yarrow and chamomile heal you. Health also regenerates when you are fed, hydrated and warm.' },
};

export function create(ctx) {
  const hasDom = typeof document !== 'undefined';
  const KEYS = CONFIG.keys;
  const PANEL_KEYS = { craft: KEYS.craft, journal: KEYS.journal, map: KEYS.map };

  const api = {
    menuOpen: false,
    init,
    update,
    setVisible,
    toast,
    setPrompt,
    subtitle,
    hint,
    flash,
    showDeath,
    showWin,
    markJournal,
    openPanel,
    closePanel,
    /** Name of the open panel or null. */
    get panel() {
      return panels ? panels.current : null;
    },
    /** Append a line to the journal's event log. */
    log: (icon, text) => panels?.log(icon, text),
  };

  // ── State ──────────────────────────────────────────────────────────────
  let root = null;
  const E = {}; // element refs
  let panels = null;
  let map = null;
  let visible = false;
  let playClock = 0; // real seconds spent playing (not paused, no menu)
  let startHours = null; // ctx.time.hoursTotal at game:start
  let screenShown = false;
  const seenHints = new Set();
  const hintQueue = [];
  let hintActive = null; // { until }
  let hintGapUntil = 0;
  const scheduled = []; // [{ at, id, text }]
  const toasts = new Map(); // key -> { el, timer }
  let subtitleTimer = 0;
  let lastHurtFlash = -1;
  let fogAcc = 0, slowAcc = 0, fastAcc = 0;
  let nauseaLevel = 0;
  let localPoisonUntil = 0, localNauseaUntil = 0;
  let canvasWobbling = false;
  let hotbarSig = '';
  let journalUnread = false;
  const vigCache = { health: -1, cold: -1, hot: -1, poison: -1, water: -1 };
  const barCache = {};
  const chipCache = {};
  // v2: objective tracker, rescue banner, compass specials
  let objAcc = 1, objSig = null;
  let rescueKind = null, rescuePct = -1, rescueTipKey = '';
  let diveHintArmed = false;
  // v3: vehicle panel, Tempest Isle storm banner, first sighting of the isle
  let vehSig = '', stormShown = false, isleSighted = false;

  if (hasDom) build();

  // ── DOM construction ───────────────────────────────────────────────────
  function build() {
    root = document.getElementById('hud');
    if (!root) {
      root = el('div', '', document.body);
      root.id = 'hud';
    }
    root.classList.remove('hidden');
    root.classList.add('hud-off');
    root.textContent = '';

    const game = (E.game = el('div', 'hud-layer hud-game', root));

    // vignettes
    const vig = el('div', 'hud-vig', game);
    E.vigHealth = el('div', 'vig vig-health', vig);
    E.vigCold = el('div', 'vig vig-cold', vig);
    E.vigHot = el('div', 'vig vig-hot', vig);
    E.vigPoison = el('div', 'vig vig-poison', vig);
    E.vigWater = el('div', 'vig vig-water', vig);
    E.flash = el('div', 'hud-flash', vig);

    // compass
    const cmp = (E.compass = el('div', 'hud-compass', game));
    E.cmpStrip = el('div', 'cmp-strip', cmp);
    for (let d = -180; d <= 540; d += 15) {
      const deg = ((d % 360) + 360) % 360;
      const x = (d + 180) * PX_PER_DEG;
      const major = deg % 45 === 0;
      const t = el('div', 'cmp-tick' + (major ? ' major' : ''), E.cmpStrip);
      t.style.left = x + 'px';
      if (major) {
        const name = compassLabel(deg);
        const l = el('div', 'cmp-label' + (name.length > 1 ? ' minor' : '') + (deg === 0 ? ' north' : ''), E.cmpStrip, name);
        l.style.left = x + 'px';
      }
    }
    E.cmpMarkers = [];
    for (let i = 0; i < 6; i++) E.cmpMarkers.push(el('div', 'cmp-marker', cmp));
    E.cmpYard = el('div', 'cmp-marker cmp-yard', cmp, '⛵');
    E.cmpYard.title = 'Boatyard';
    E.cmpRescue = el('div', 'cmp-marker cmp-rescue', cmp, '🚁');
    E.cmpRaft = el('div', 'cmp-marker cmp-yard', cmp, '🛶');
    E.cmpRaft.title = 'Your paddle raft';
    E.cmpIsle = el('div', 'cmp-marker cmp-yard', cmp, '🏝️');
    E.cmpIsle.title = 'Tempest Isle';
    el('div', 'cmp-needle', cmp);
    E.cmpDeg = el('div', 'cmp-deg', game);

    // clock
    const clk = el('div', 'hud-clock hud-glass', game);
    E.clkIcon = el('span', 'clk-icon', clk, '☀️');
    const clkText = el('div', '', clk);
    E.clkDay = el('div', 'clk-day', clkText, 'Day 1');
    E.clkTime = el('div', 'clk-time', clkText, '06:00');
    E.clkDiff = el('div', 'clk-diff', clkText, '');
    E.clkWeather = el('span', 'clk-weather', clk, '');
    E.journalBadge = el('div', 'hud-journal-badge', game, '📖 New journal entry · press J');

    // v2: boat objective tracker (top-left)
    E.obj = el('div', 'hud-obj hud-glass', game);
    const oh = el('div', 'obj-head', E.obj);
    el('span', 'obj-icon', oh, '⛵');
    E.objTitle = el('span', 'obj-title', oh, '');
    E.objStage = el('div', 'obj-stage', E.obj);
    E.objNeeds = el('div', 'obj-needs', E.obj);
    E.objHint = el('div', 'obj-hint', E.obj);
    E.objReady = el('div', 'obj-ready', E.obj, '🔨 Ready to build at the Boatyard!');

    // v2: search-party banner (top-centre, under the compass); v3: stacked with the storm banner
    E.banners = el('div', 'hud-banners', game);
    E.rescue = el('div', 'hud-rescue hud-glass', E.banners);
    E.rescueTitle = el('div', 'rs-title', E.rescue, '');
    const rsb = el('div', 'rs-bar', E.rescue);
    E.rescueFill = el('div', 'rs-fill', rsb);
    E.rescueTip = el('div', 'rs-tip', E.rescue, '');
    E.storm = el('div', 'hud-storm hud-glass', E.banners, '⛈️ Storm over Tempest Isle: rafts capsize and fires go out. Get indoors!');
    // v3: vehicle panel (above the hotbar while aboard)
    E.vehicle = el('div', 'hud-vehicle hud-glass', game);
    E.vehTitle = el('div', 'veh-title', E.vehicle, '');
    E.vehSub = el('div', 'veh-sub', E.vehicle, '');

    // stats
    const st = el('div', 'hud-stats hud-glass', game);
    E.bars = {};
    for (const [key, icon] of [
      ['health', '❤️'],
      ['thirst', '💧'],
      ['hunger', HUNGER_ICON],
      ['energy', '⚡'],
    ]) {
      const row = el('div', 'stat stat-' + key, st);
      row.title = key[0].toUpperCase() + key.slice(1);
      el('span', 'stat-icon', row, icon);
      const bar = el('div', 'bar', row);
      const ghost = el('div', 'ghost', bar);
      const fill = el('div', 'fill', bar);
      const val = el('span', 'stat-val', row, '100');
      E.bars[key] = { row, fill, ghost, val };
    }
    const heat = (E.heatRow = el('div', 'stat stat-heat', st));
    heat.title = 'Body heat (the framed band is comfortable)';
    el('span', 'stat-icon', heat, '🌡️');
    const gauge = el('div', 'gauge', heat);
    const band = el('div', 'gauge-band', gauge);
    const cmin = CONFIG.stats.heatComfortMin, cmax = CONFIG.stats.heatComfortMax;
    band.style.left = cmin + '%';
    band.style.width = cmax - cmin + '%';
    E.heatMarker = el('div', 'gauge-marker', gauge);
    E.heatVal = el('span', 'stat-val', heat, '');
    E.breath = el('div', 'hud-breath', st);
    E.bubbles = [];
    for (let i = 0; i < 10; i++) E.bubbles.push(el('span', '', E.breath, '🫧'));
    E.depth = el('span', 'hud-depth', E.breath, '');
    E.breath.style.display = 'none';
    E.chips = el('div', 'hud-chips', st);
    E.chipEls = {};

    // crosshair + prompt
    E.cross = el('div', 'hud-cross', game);
    E.prompt = el('div', 'hud-prompt', game);

    // hint card
    E.hint = el('div', 'hud-hint hud-glass', game);
    el('div', 'h-icon', E.hint, '💡');
    const hb = el('div', '', E.hint);
    el('div', 'h-title', hb, 'Tip');
    E.hintText = el('div', '', hb);

    // hotbar
    const hw = el('div', 'hud-hotbar-wrap', game);
    E.hotName = el('div', 'hot-name', hw);
    const hotbar = el('div', 'hud-hotbar hud-glass', hw);
    E.slots = [];
    for (let i = 0; i < 9; i++) {
      const s = el('div', 'slot empty', hotbar);
      el('span', 'slot-key', s, String(i + 1));
      const icon = el('span', 'slot-icon', s, '');
      const n = el('span', 'slot-n', s, '');
      E.slots.push({ s, icon, n, id: null, count: -1 });
    }
    E.feed = el('div', 'hud-feed', game);
    E.feedLines = new Map();

    // panels (crafting / journal / map)
    E.panels = el('div', 'hud-panels', game);

    // outside the gameplay layer: toasts, subtitles, end screens
    E.toasts = el('div', 'hud-toasts', root);
    E.subtitle = el('div', 'hud-subtitle', root);
    E.screen = el('div', 'hud-screen', root);
  }

  // ── Public API ─────────────────────────────────────────────────────────
  function setVisible(b) {
    visible = !!b;
    if (!root) return;
    root.classList.remove('hidden');
    root.classList.toggle('hud-off', !visible);
  }

  /** toast(text, { icon, kind: info|good|warn|bad|story, duration (s), key (replace same-key toast) }) */
  function toast(text, opts = {}) {
    if (!root) {
      console.log('[toast]', text);
      return null;
    }
    if (opts.icon === '🍃' && HUNGER_TEXT.test(text)) opts = { ...opts, icon: HUNGER_ICON };
    const kind = opts.kind || 'info';
    const duration = opts.duration ?? (kind === 'story' ? 7 : kind === 'bad' ? 5 : 4);
    const key = opts.key || null;
    let rec = key ? toasts.get(key) : null;
    if (rec && rec.el.isConnected && !rec.el.classList.contains('out')) {
      rec.text.textContent = text;
      if (opts.icon) rec.icon.textContent = opts.icon;
      rec.el.className = 'toast ' + kind;
      void rec.el.offsetWidth;
      rec.el.classList.add('bump');
      clearTimeout(rec.timer);
    } else {
      const t = el('div', 'toast ' + kind);
      const icon = el('span', 't-icon', t, opts.icon || defaultIcon(kind));
      const tx = el('span', 't-text', t, text);
      E.toasts.appendChild(t);
      rec = { el: t, text: tx, icon, timer: 0 };
      const k = key || Symbol('toast');
      rec.key = k;
      toasts.set(k, rec);
      // cap the stack
      while (E.toasts.children.length > MAX_TOASTS) {
        const first = E.toasts.firstElementChild;
        for (const [kk, r] of toasts) if (r.el === first) toasts.delete(kk);
        first.remove();
      }
    }
    const r = rec;
    r.timer = setTimeout(() => {
      r.el.classList.add('out');
      setTimeout(() => {
        r.el.remove();
        if (toasts.get(r.key) === r) toasts.delete(r.key);
      }, 480);
    }, duration * 1000);
    return r.el;
  }
  function defaultIcon(kind) {
    return { good: '✅', warn: '⚠️', bad: '❗', story: '📜' }[kind] || 'ℹ️';
  }

  /** lines = [{ key: 'E', label }] or null */
  function setPrompt(lines) {
    if (!root) return;
    E.prompt.textContent = '';
    const has = !!(lines && lines.length);
    E.cross.classList.toggle('active', has);
    if (!has) return;
    for (const l of lines) {
      const line = el('div', 'prompt-line', E.prompt);
      el('span', 'key', line, l.key);
      el('span', '', line, l.label);
    }
  }

  function subtitle(text, seconds = 4.5) {
    if (!root) {
      if (text) console.log('[subtitle]', text);
      return;
    }
    clearTimeout(subtitleTimer);
    if (!text) {
      E.subtitle.classList.remove('show');
      return;
    }
    E.subtitle.textContent = text;
    void E.subtitle.offsetWidth;
    E.subtitle.classList.add('show');
    subtitleTimer = setTimeout(() => E.subtitle.classList.remove('show'), seconds * 1000);
  }

  /** One-time tutorial tip. Returns true if it was queued (first time for this id). */
  function hint(id, text) {
    if (seenHints.has(id)) return false;
    seenHints.add(id);
    hintQueue.push({ id, text });
    return true;
  }

  function flash(color = '#ff2a1a', seconds = 0.5, strength = 0.5) {
    if (!root) return;
    const f = E.flash;
    f.style.transition = 'none';
    f.style.background = color;
    f.style.opacity = String(clamp(strength, 0.05, 0.9));
    void f.offsetWidth;
    f.style.transition = `opacity ${Math.max(0.05, seconds)}s ease-out`;
    f.style.opacity = '0';
  }

  function markJournal(entryId, data = {}) {
    if (!panels) return;
    const id = String(entryId);
    const J = panels.journal;
    if (id.startsWith('plant:') || ITEMS[id]?.category === 'food' || ITEMS[id]?.category === 'medicine') {
      const pid = id.startsWith('plant:') ? id.slice(6) : id;
      if (data.discovered !== false) J.plants.add(pid);
      if (data.poisonous) J.poisonous.add(pid);
    } else if (id.startsWith('egg:')) {
      const eid = id.slice(4);
      if (!J.eggs.has(eid)) J.eggs.set(eid, { name: data.name || eid, text: data.text || '' });
    } else {
      J.notes.set(id, { title: data.title || data.name || id, text: data.text || data.body || '', icon: data.icon || '📜' });
      journalUnread = true;
    }
    if (journalUnread && E.journalBadge) E.journalBadge.classList.add('show');
    if (panels.current === 'journal') panels.refresh();
  }

  function openPanel(name) {
    if (!panels || screenShown) return false;
    if (ctx.state !== 'playing' || ctx.flags.cinematic || ctx.stats?.dead) return false;
    const was = api.menuOpen;
    api.menuOpen = true; // set BEFORE unlocking so main doesn't pause the game
    panels.show(name);
    if (name === 'journal') {
      journalUnread = false;
      E.journalBadge.classList.remove('show');
    }
    if (!was) {
      setPrompt(null);
      ctx.input?.unlock?.();
      ctx.audio?.play?.('ui_open');
    } else ctx.audio?.play?.('ui_click');
    return true;
  }
  /**
   * Close the open panel. Call from a user gesture (keydown/click) so pointer lock can be re-acquired.
   * Browsers don't treat Escape as a user gesture (and Escape is the pointer-lock exit key), so a lock
   * requested from an Escape keydown always fails: skip it and let main show the pause overlay once.
   */
  function closePanel(viaEscape = false) {
    if (!panels || !api.menuOpen) return;
    panels.hide();
    api.menuOpen = false;
    if (ctx.state === 'playing' && !viaEscape) ctx.input?.lock?.();
    ctx.audio?.play?.('ui_click');
  }

  // ── Death / win screens ───────────────────────────────────────────────
  function survivedHours() {
    return startHours == null ? 0 : Math.max(0, ctx.time.hoursTotal - startHours);
  }
  function fmtDistance(m) {
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  }
  function statTiles(card, tiles) {
    const g = el('div', 'screen-stats', card);
    for (const [v, label] of tiles) {
      const t = el('div', 'screen-stat', g);
      el('b', '', t, String(v));
      el('span', '', t, label);
    }
  }
  function endScreen(kind) {
    screenShown = true;
    if (api.menuOpen) {
      panels?.hide();
      api.menuOpen = false;
    }
    setPrompt(null);
    subtitle(null);
    setVisible(false);
    resetCanvasFx();
    E.screen.textContent = '';
    E.screen.className = 'hud-screen show ' + kind;
    return el('div', 'screen-card', E.screen);
  }
  function showDeath(info = {}) {
    if (!root) return console.log('[death]', info);
    const d = DEATH[info.cause] || DEATH.unknown;
    const card = endScreen('dead');
    el('div', 'screen-icon', card, d.icon);
    el('div', 'screen-title', card, 'YOU DIED');
    const day = info.day ?? ctx.time.day;
    const hour = info.hour ?? ctx.time.hour;
    el('div', 'screen-lead', card, deathLead(d, day, fmtHour(hour)));
    const S = ctx.stats_summary || {};
    statTiles(card, [
      [fmtDuration(survivedHours()), 'survived'],
      [fmtDistance(S.distanceWalked || 0), 'walked'],
      [S.itemsCrafted || 0, 'crafted'],
      [S.plantsGathered || 0, 'plants'],
    ]);
    el('div', 'screen-tip', card, '💡 ' + d.tip);
    const b = el('button', 'btn', card, 'Try again');
    b.addEventListener('click', () => location.reload());
    panels?.log(d.icon, /[.!?]$/.test(d.text) ? d.text : `${d.text}.`);
  }
  function showWin(info = {}) {
    if (!root) return console.log('[win]', info);
    const card = endScreen('won');
    const sailed = info.method === 'raft';
    el('div', 'screen-icon', card, sailed ? (info.plan === 'motorboat_dock' ? '🚤' : '⛵') : info.kind === 'boat' ? '🚤' : '🚁');
    el('div', 'screen-title', card, sailed ? 'HOMEWARD BOUND!' : 'RESCUED!');
    const day = info.day ?? ctx.time.day;
    const hour = info.hour ?? ctx.time.hour;
    const how = sailed
      ? raftWinText(raftName(info))
      : RESCUE_METHOD[info.method] || (info.method ? `They spotted you (${info.method}).` : 'They spotted you.');
    el('div', 'screen-lead', card, `Day ${day}, ${fmtHour(hour)}. ${how}`);
    const S = ctx.stats_summary || {};
    const J = panels?.journal;
    statTiles(card, [
      [fmtDuration(survivedHours()), 'survived'],
      [fmtDistance(S.distanceWalked || 0), 'walked'],
      [S.itemsCrafted || 0, 'crafted'],
      [S.foodsEaten || 0, 'meals'],
      [S.plantsGathered || 0, 'plants'],
      [`${J ? J.eggs.size : 0}/${J ? J.eggsTotal : 7}`, 'secrets'],
    ]);
    const passes = !sailed && info.passes != null ? ` The search party came by ${info.passes} time${info.passes === 1 ? '' : 's'}.` : '';
    el('div', 'screen-tip', card, `You made it off Driftwood Isle.${passes} Thanks for playing!`);
    const b = el('button', 'btn', card, 'Play again');
    b.addEventListener('click', () => location.reload());
  }

  /** Boat name for the 'raft' win: payload.name, else the plan (id or object), else ctx.raft.plan. */
  function raftName(info) {
    if (info.name) return info.name;
    const pl = info.plan;
    if (typeof pl === 'string' && CONFIG.raft?.plans?.[pl]?.name) return CONFIG.raft.plans[pl].name;
    if (pl && typeof pl === 'object' && pl.name) return pl.name;
    return ctx.raft?.plan?.name || 'boat';
  }

  // ── init: listeners + helpers ──────────────────────────────────────────
  function init() {
    if (!root) return;
    map = createMap(ctx);
    panels = createPanels(ctx, api, E.panels, map);
    const ev = ctx.events;

    ctx.input?.onKeyDown?.((code) => {
      if (screenShown) return;
      let which = null;
      for (const name in PANEL_KEYS) if (PANEL_KEYS[name].includes(code)) which = name;
      if (api.menuOpen) {
        if (code === 'Escape' || (which && which === panels.current)) closePanel(code === 'Escape');
        else if (which) openPanel(which);
        return;
      }
      if (which) openPanel(which);
    });

    ev.on('game:start', () => {
      startHours = ctx.time.hoursTotal;
      playClock = 0;
      const t = 2.5;
      scheduled.push(
        { at: t, id: 'start_cold', text: "You're soaked and freezing. Get out into open sunlight, away from tree shade, to warm up and dry off." },
        { at: t + 14, id: 'start_drink', text: 'Thirsty? Spring Pond lies just inland to the north-east. Look at fresh water and press E to drink. Seawater makes it worse!' },
        { at: t + 30, id: 'start_fire', text: 'For fire you need Flint 🔹 (dark, glassy: beaches and riverbeds) and Pyrite 🪙 (brassy: rocky high ground). Keep an eye out.' },
        { at: t + 48, id: 'start_keys', text: 'Tab or C opens crafting, J your journal, M the map. Use items with F or right-click.' },
        { at: t + 70, id: 'start_boat', text: 'Your way home: rebuild a boat at the Boatyard on this beach (⛵ on the compass). The tracker at the top-left shows what the next stage needs, and the Journal (J) Boat tab lists every part and where to look.' }
      );
      diveHintArmed = true;
      objSig = null;
      objAcc = 1;
      panels.log('🏝️', 'Washed ashore on an unknown island.');
    });

    ev.on('item:added', (p) => {
      if (!p?.id) return;
      if (!p.silent) feed(p.id, p.n || 1);
      const first = !panels.journal.seenItems.has(p.id);
      panels.journal.seenItems.add(p.id);
      const cat = ITEMS[p.id]?.category;
      if (first && (cat === 'food' || cat === 'medicine' || p.id === 'bamboo')) {
        if (!panels.journal.plants.has(p.id)) {
          panels.journal.plants.add(p.id);
          panels.log(ITEMS[p.id].icon, `Found ${ITEMS[p.id].name}.`);
        }
      } else if (first && ITEMS[p.id] && cat !== 'part') panels.log(ITEMS[p.id].icon, `Picked up ${ITEMS[p.id].name}.`);
      if (first) firstItemHints(p.id);
      flashSlot(p.id);
    });
    ev.on('item:consumed', (p) => {
      const fx = ITEMS[p?.id]?.effects;
      if (!fx) return;
      if (fx.poison) localPoisonUntil = playClock + 22;
      if (fx.nausea) localNauseaUntil = Math.max(localNauseaUntil, playClock + fx.nausea);
    });
    ev.on('craft:done', (p) => panels.log('🛠️', `Crafted ${p?.name || p?.recipe || 'something'}.`));
    ev.on('structure:placed', (p) => panels.log(STRUCTURE_ICON[p?.type] || '🏗️', `Built a ${structName(p?.type)}.`));
    ev.on('fire:lit', (p) => panels.log('🔥', `Lit a ${p?.kind === 'signal_fire' ? 'signal fire' : 'campfire'}.`));
    ev.on('fire:out', (p) => panels.log('💨', `A ${p?.kind === 'signal_fire' ? 'signal fire' : 'campfire'} went out.`));
    ev.on('food:cooked', (p) => p?.to && ITEMS[p.to] && panels.log(ITEMS[p.to].icon, `Cooked ${ITEMS[p.to].name}.`));
    ev.on('stats:warning', onWarning);
    ev.on('stats:sleep', (p) => {
      const h = p?.hours ?? 0;
      toast(`You slept for ${fmtDuration(h)}.`, { icon: '😴', kind: 'good' });
      panels.log('😴', `Slept ${fmtDuration(h)}.`);
    });
    ev.on('player:hurt', (p) => {
      const amt = p?.amount ?? 5;
      // continuous damage (cold, heat, poison, drowning) gets its colour-coded flash from stats.js
      if (playClock - lastHurtFlash < 0.35 || amt < 0.5 || /^(hypothermia|heatstroke|poison|drowning|dehydration|starvation)$/.test(p?.cause || '')) return;
      lastHurtFlash = playClock;
      flash('#ff2a1a', 0.45 + Math.min(0.5, amt / 40), 0.18 + Math.min(0.5, amt / 35));
    });
    ev.on('easter:found', (p) => {
      if (!p) return;
      const J = panels.journal;
      if (p.total) J.eggsTotal = p.total;
      J.eggs.set(p.id ?? `egg${J.eggs.size}`, { name: p.name || 'A secret', text: p.text || '' });
      panels.log('✨', `Secret found: ${p.name || '???'} (${p.found ?? J.eggs.size}/${J.eggsTotal}).`);
      journalUnread = true;
      E.journalBadge.classList.add('show');
    });
    ev.on('rescue:passStart', (p) => {
      panels.log(p?.kind === 'boat' ? '🚤' : '🚁', `A search ${p?.kind === 'boat' ? 'boat' : 'helicopter'} passed near the island.`);
      hint('rescue', 'The search party! Get into the open (beach or summit), hold G to wave, and light a signal fire or fire a flare.');
    });
    ev.on('rescue:spotted', () => panels.log('👀', 'The search party spotted you!'));
    ev.on('weather:rainStart', () => {
      panels.log('🌧️', 'It started to rain.');
      hint('rain', 'Rain soaks and chills you and drains fires. A lean-to shelter keeps you (and a fire next to it) dry.');
    });
    ev.on('time:dusk', () => hint('night', 'Night is falling and the air turns cold. Stay by a campfire, light a torch (T), or sleep in a shelter (E) until morning.'));
    ev.on('time:dawn', (p) => {
      if (ctx.state !== 'playing') return;
      const day = p?.day ?? ctx.time.day;
      if (day > 1) {
        toast(`Day ${day} dawns over Driftwood Isle.`, { icon: '🌅', kind: 'story', duration: 5 });
        panels.log('🌅', `Day ${day} began.`);
      }
    });
    ev.on('tree:falling', () => hint('tree', 'CREAK! A tree is falling. Get out of the way: falling trees can kill.'));
    ev.on('drink', (p) => {
      if (p?.source === 'ocean') hint('seawater', 'Seawater dehydrates you. Find fresh water: the pond, the river or the lake.');
    });
    ev.on('player:submerged', () => hint('swim', 'Underwater! Watch your breath bubbles and press Space to swim up.'));
    // v2: diving + the boat-repair goal
    ev.on('player:swimStart', () => {
      // queued a few seconds after the basic swimming hint (the controller shows that one on the same event)
      if (!diveHintArmed || ctx.state !== 'playing') return;
      diveHintArmed = false;
      scheduled.push({ at: playClock + 6, id: 'dive', text: 'Hold X to dive. Breath runs out fast, and a diving mask helps.' });
    });
    const refreshObjective = () => {
      objSig = null;
      objAcc = 1;
    };
    ev.on('raft:part', (p) => {
      const it = ITEMS[p?.id];
      if (it) panels.log(it.icon, `Recovered a boat part: ${it.name}.`);
      refreshObjective();
    });
    ev.on('raft:stage', (p) => {
      const label = p?.stage?.label;
      panels.log('🔨', label ? `Boat stage done: ${label}.` : 'Finished a boat stage.');
      refreshObjective();
    });
    ev.on('raft:complete', () => {
      panels.log('⛵', 'The boat is finished!');
      refreshObjective();
    });
    ev.on('item:removed', refreshObjective);
    // v3: vehicles + Tempest Isle
    ev.on('vehicle:placed', () => panels.log('🛶', 'Built a paddle raft.'));
    ev.on('vehicle:capsized', (p) => panels.log('🌊', p?.type === 'boat' ? 'A storm flipped your boat at Tempest Isle.' : 'A storm capsized your raft.'));
    ev.on('raft:voyage', (p) => panels.log('⛵', p?.to === 'isle2' ? 'Sailed the boat to Tempest Isle.' : 'Sailed the boat back to the Boatyard.'));
    ev.on('isle2:stormStart', () => panels.log('⛈️', 'A storm rolled in over Tempest Isle.'));
  }

  function structName(t) {
    return { campfire: 'campfire', signal_fire: 'signal fire', sos: 'SOS sign', shelter: 'lean-to shelter' }[t] || t || 'structure';
  }

  function firstItemHints(id) {
    const inv = ctx.inventory;
    if (id === 'wood' || id === 'fiber' || id === 'stone') hint('craft', 'Materials go into crafting. Press Tab (or C) to see what you can make.');
    if ((id === 'flint' || id === 'pyrite') && inv?.has?.('flint') && inv?.has?.('pyrite'))
      hint('fire', 'Flint and pyrite: you can make fire! Craft a Campfire (wood 3 + stone 4) from the crafting menu (Tab).');
    if (ITEMS[id]?.cooksInto) hint('cook', 'Raw food is better cooked. Stand at a lit campfire and press R to cook everything you carry.');
    if (id === 'bottle_empty') hint('fill', 'Stand by the pond, river or lake and press R to fill your canteen.');
    if (id === 'torch') hint('torch', 'Press T to light or stow your torch. It burns for 4 hours and keeps a little warmth.');
    if (id === 'shovel') hint('shovel', 'Wooden Shovel: look for disturbed sand mounds on the beaches and press E to dig up what is buried there.');
    if (id === 'pickaxe') hint('pickaxe', 'Flint Pickaxe: look for cracked rocks with a glint inside and press E to break them open.');
    if (id === 'diving_mask') hint('mask', 'Diving Mask: keep it in your pack and your breath lasts much longer underwater. Hold X while swimming to dive.');
    if (ITEMS[id]?.category === 'part') hint('part', 'A boat part! Carry parts to the Boatyard on the beach where you washed ashore and press E there to build the next stage.');
    if (id === 'flare') hint('flare', 'Save the flare until the search party is close, then select it and press F.');
    if (ITEMS[id]?.category === 'food' && id !== 'toadstool') hint('eat', 'Select food in the hotbar (1-9 or the wheel) and press F or right-click to eat.');
  }

  function onWarning(p) {
    const w = WARNINGS[p?.type];
    if (!w) return;
    const crit = p.level === 'critical';
    // the flavoured warning toast comes from stats.js; the HUD only adds the one-time tutorial hint
    hint('warn_' + p.type, w.hint);
  }

  // ── Pickup feed (above-right of the hotbar) ────────────────────────────
  function feed(id, n) {
    const it = ITEMS[id];
    if (!it || !E.feed) return;
    let rec = E.feedLines.get(id);
    if (rec && rec.el.isConnected && !rec.el.classList.contains('out')) {
      rec.n += n;
      clearTimeout(rec.timer);
    } else {
      rec = { el: el('div', 'feed-line'), n };
      E.feed.appendChild(rec.el);
      E.feedLines.set(id, rec);
      while (E.feed.children.length > 5) E.feed.firstElementChild.remove();
    }
    rec.el.innerHTML = '';
    el('b', '', rec.el, `+${rec.n}`);
    rec.el.append(` ${it.icon} ${it.name}`);
    const r = rec;
    r.timer = setTimeout(() => {
      r.el.classList.add('out');
      setTimeout(() => r.el.remove(), 650);
    }, 2600);
  }
  function flashSlot(id) {
    for (const s of E.slots || []) {
      if (s.id === id) {
        s.s.classList.remove('bump');
        void s.s.offsetWidth;
        s.s.classList.add('bump');
      }
    }
  }

  // ── Per-frame update ───────────────────────────────────────────────────
  function update(dt) {
    if (!root) return;
    const playing = ctx.state === 'playing';
    if (playing && !api.menuOpen) playClock += dt;
    map?.bakeStep();

    root.classList.toggle('hud-cine', !!ctx.flags.cinematic);
    if (!visible) return;

    // scheduled + queued hints
    if (playing && !ctx.flags.cinematic) {
      for (let i = scheduled.length - 1; i >= 0; i--) {
        if (playClock >= scheduled[i].at) {
          hint(scheduled[i].id, scheduled[i].text);
          scheduled.splice(i, 1);
        }
      }
      updateHint();
    }

    updateCompass();
    updateVignettes(dt);

    fastAcc += dt;
    if (fastAcc >= 0.1) {
      fastAcc = 0;
      updateBars();
      updateHotbar();
      updateRescue();
      updateSpecialMarkers();
      updateVehicle();
      updateStorm();
    }
    objAcc += dt;
    if (objAcc >= 0.5) {
      objAcc = 0;
      updateObjective();
    }
    slowAcc += dt;
    if (slowAcc >= 0.25) {
      slowAcc = 0;
      updateClock();
      updateChips();
      updateCompassMarkers();
      if (playing && !isleSighted) checkIsleSighting();
    }
    if (playing && !api.menuOpen) {
      fogAcc += dt;
      if (fogAcc >= 1) {
        fogAcc = 0;
        const p = ctx.player?.position;
        if (p && map) {
          map.reveal(p.x, p.z);
          const found = map.checkLandmarks(p.x, p.z);
          for (const L of found) {
            if (L.key === 'spawn') continue;
            toast(`Discovered: ${L.name}`, { icon: '🗺️', kind: 'good' });
            panels.log(L.icon, `Discovered ${L.name}.`);
          }
        }
      }
    }
  }

  function updateHint() {
    const now = playClock;
    if (hintActive) {
      if (now >= hintActive.until) {
        E.hint.classList.remove('show');
        hintActive = null;
        hintGapUntil = now + 0.9;
      }
      return;
    }
    if (!hintQueue.length || now < hintGapUntil || api.menuOpen) return;
    const h = hintQueue.shift();
    E.hintText.textContent = h.text;
    E.hint.classList.add('show');
    const words = h.text.split(/\s+/).length;
    hintActive = { until: now + clamp(3.5 + words * 0.3, 6, 13) };
    ctx.audio?.play?.('ui_click', { volume: 0.4 });
  }

  function heading() {
    const yaw = ctx.player?.yaw ?? ctx.camera?.rotation?.y ?? 0;
    let h = (-yaw * RAD2DEG) % 360;
    if (h < 0) h += 360;
    return h;
  }

  let lastHeading = -999;
  function updateCompass() {
    const h = heading();
    if (Math.abs(h - lastHeading) < 0.05) return;
    lastHeading = h;
    const w = E.compass.clientWidth || 520;
    E.cmpStrip.style.transform = `translateX(${(w / 2 - (h + 180) * PX_PER_DEG).toFixed(1)}px)`;
    E.cmpDeg.textContent = `${compassLabel(h)} ${Math.round(h) % 360}°`;
  }

  function updateCompassMarkers() {
    const list = ctx.structures?.list;
    const p = ctx.player?.position;
    let used = 0;
    if (list && p) {
      const h = heading();
      const w = E.compass.clientWidth || 520;
      for (const s of list) {
        if (used >= E.cmpMarkers.length) break;
        if (s.removed) continue;
        const dx = s.position.x - p.x, dz = s.position.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d < 4 || d > 600) continue;
        const bearing = Math.atan2(dx, -dz) * RAD2DEG;
        const rel = angleDiff(h / RAD2DEG, bearing / RAD2DEG) * RAD2DEG;
        const x = w / 2 + rel * PX_PER_DEG;
        if (x < 20 || x > w - 20) continue;
        const m = E.cmpMarkers[used++];
        const icon = s.type === 'campfire' ? (s.lit ? '🔥' : '🪵') : s.type === 'signal_fire' ? (s.lit ? '💨' : '🪵') : STRUCTURE_ICON[s.type] || '•';
        if (m.textContent !== icon) m.textContent = icon;
        m.style.left = x.toFixed(0) + 'px';
        m.style.display = 'block';
        m.title = `${structName(s.type)} · ${Math.round(d)} m`;
      }
    }
    for (let i = used; i < E.cmpMarkers.length; i++) if (E.cmpMarkers[i].style.display !== 'none') E.cmpMarkers[i].style.display = 'none';
  }

  function updateClock() {
    const t = ctx.time;
    const hr = t.hour;
    const icon = hr >= 5 && hr < 7.5 ? '🌅' : hr >= 7.5 && hr < 18 ? '☀️' : hr >= 18 && hr < 20 ? '🌇' : '🌙';
    if (E.clkIcon.textContent !== icon) E.clkIcon.textContent = icon;
    const day = 'Day ' + t.day;
    if (E.clkDay.textContent !== day) E.clkDay.textContent = day;
    const time = fmtHour(hr);
    if (E.clkTime.textContent !== time) E.clkTime.textContent = time;
    const rain = ctx.weather?.rain ?? ctx.uniforms?.uRain?.value ?? 0;
    const cloud = ctx.weather?.cloudiness ?? 0;
    const w = rain > 0.55 ? '⛈️' : rain > 0.12 ? '🌧️' : cloud > 0.6 ? '☁️' : cloud > 0.3 ? '⛅' : '';
    if (E.clkWeather.textContent !== w) E.clkWeather.textContent = w;
    const dl = ctx.difficulty?.label || '';
    if (E.clkDiff.textContent !== dl) {
      E.clkDiff.textContent = dl;
      E.clkDiff.className = 'clk-diff ' + (ctx.difficulty?.id || '');
      E.clkDiff.title = dl ? `Difficulty: ${dl}` : '';
    }
  }

  // ── v2: boat objective tracker ─────────────────────────────────────────
  function updateObjective() {
    const hidden = !!ctx.flags.cinematic || ctx.state === 'dead' || ctx.state === 'rescued' || !!ctx.stats?.dead;
    let v = null;
    if (!hidden) {
      try {
        v = objectiveView(ctx.raft?.objective?.());
      } catch (e) {
        v = null;
      }
    }
    const sig = objectiveSig(v);
    if (sig === objSig) return;
    objSig = sig;
    E.obj.classList.toggle('show', !!v);
    if (!v) return;
    E.objTitle.textContent = v.title;
    E.objStage.textContent = v.stage;
    E.objNeeds.textContent = '';
    for (const n of v.needs) {
      const c = el('span', 'obj-need ' + (n.ok ? 'have' : 'miss'), E.objNeeds);
      c.textContent = `${n.icon} ${Math.min(n.have, n.need)}/${n.need}${n.ok ? ' ✓' : ''}`;
      c.title = n.name;
    }
    E.objHint.textContent = v.complete ? v.hint || 'Launch it from the Boatyard!' : v.hint;
    E.objHint.style.display = E.objHint.textContent ? '' : 'none';
    E.objReady.style.display = v.ready ? '' : 'none';
    E.obj.classList.toggle('ready', v.ready);
  }

  // ── v2: search-party banner + compass markers ──────────────────────────
  function updateRescue() {
    const pass = !ctx.flags.cinematic && ctx.state === 'playing' ? ctx.rescue?.activePass : null;
    const kind = pass ? (pass.kind === 'boat' ? 'boat' : 'helicopter') : null;
    if (kind !== rescueKind) {
      rescueKind = kind;
      E.rescue.classList.toggle('show', !!kind);
      E.rescueTitle.textContent = kind === 'boat' ? '🚤 Search boat offshore!' : kind ? '🚁 Search helicopter overhead!' : '';
      E.cmpRescue.textContent = kind === 'boat' ? '🚤' : '🚁';
      rescuePct = -1;
      rescueTipKey = '';
    }
    if (!kind) return;
    const a = clamp01(ctx.rescue?.attention ?? 0);
    const pct = Math.round(a * 100);
    if (pct !== rescuePct) {
      rescuePct = pct;
      E.rescueFill.style.width = pct + '%';
      E.rescue.classList.toggle('hot', a >= 0.5);
    }
    const tipKey = a >= 0.5 ? 'hot' : 'cold';
    if (tipKey !== rescueTipKey) {
      rescueTipKey = tipKey;
      E.rescueTip.textContent =
        tipKey === 'hot'
          ? "They're turning toward you! Keep waving (G) and keep your signals burning."
          : 'Get into the open, hold G to wave, light a signal fire';
    }
  }

  function placeCmpMarker(m, dx, dz, h, w, icon, clampEdges) {
    // clamped markers sit inside the strip's faded edges; free ones use the structure markers' range
    const pl = compassPlace(relBearing(h, dx, dz), w, PX_PER_DEG, clampEdges ? Math.max(30, w * 0.19) : 20);
    if (pl.edge && !clampEdges) {
      if (m.style.display !== 'none') m.style.display = 'none';
      return;
    }
    const text = pl.edge < 0 ? '◀' + icon : pl.edge > 0 ? icon + '▶' : icon;
    if (m.textContent !== text) m.textContent = text;
    m.style.left = pl.x.toFixed(0) + 'px';
    if (m.style.display !== 'block') m.style.display = 'block';
  }

  function updateSpecialMarkers() {
    const p = ctx.player?.position;
    const w = E.compass.clientWidth || 520;
    const h = heading();
    const pp = rescueKind ? ctx.rescue?.activePass?.position : null;
    if (p && pp) placeCmpMarker(E.cmpRescue, pp.x - p.x, pp.z - p.z, h, w, rescueKind === 'boat' ? '🚤' : '🚁', true);
    else if (E.cmpRescue.style.display !== 'none') E.cmpRescue.style.display = 'none';
    const site = ctx.raft?.site;
    const far = p && site ? Math.hypot(site.x - p.x, site.z - p.z) > 6 : false;
    if (far) placeCmpMarker(E.cmpYard, site.x - p.x, site.z - p.z, h, w, '⛵', false);
    else if (E.cmpYard.style.display !== 'none') E.cmpYard.style.display = 'none';
    // v3: your paddle raft (when you're not on it)
    const vr = ctx.vehicles?.raft;
    const rp = vr && ctx.vehicles.current !== vr ? vr.object?.position : null;
    if (p && rp && Math.hypot(rp.x - p.x, rp.z - p.z) > 6) placeCmpMarker(E.cmpRaft, rp.x - p.x, rp.z - p.z, h, w, '🛶', false);
    else if (E.cmpRaft.style.display !== 'none') E.cmpRaft.style.display = 'none';
    // v3: Tempest Isle, once you have seen it (hidden while you are on it)
    const isle = ctx.world?.isle2;
    const onIsle = p && isle ? Math.hypot(isle.x - p.x, isle.z - p.z) < (isle.R || 150) * 1.1 : false;
    if (p && isle && (isleSighted || map?.discovered?.has?.('isle2')) && !onIsle) placeCmpMarker(E.cmpIsle, isle.x - p.x, isle.z - p.z, h, w, '🏝️', false);
    else if (E.cmpIsle.style.display !== 'none') E.cmpIsle.style.display = 'none';
  }

  // ── v3: vehicle panel, storm banner, first sighting of Tempest Isle ────
  function updateVehicle() {
    const V = ctx.vehicles;
    const cur = !ctx.flags.cinematic && ctx.state === 'playing' ? V?.current : null;
    const view = vehiclePanel(cur, {
      canHeadHome: !!V?.canHeadHome,
      canDisembark: !!V?.canDisembark,
      hasPaddle: (ctx.inventory?.count?.('paddle') ?? 0) > 0,
      exhausted: !!ctx.stats?.exhausted,
    });
    const sig = view ? view.title + '|' + view.sub : '';
    if (sig === vehSig) return;
    vehSig = sig;
    E.vehicle.classList.toggle('show', !!view);
    if (!view) return;
    E.vehTitle.textContent = view.title;
    E.vehSub.textContent = view.sub;
  }
  function updateStorm() {
    const isle = ctx.world?.isle2;
    const p = ctx.player?.position;
    const d = isle && p ? Math.hypot(p.x - isle.x, p.z - isle.z) : Infinity;
    const on = !ctx.flags.cinematic && ctx.state === 'playing' && stormBannerOn(ctx.weather?.isle2Storm, d);
    if (on === stormShown) return;
    stormShown = on;
    E.storm.classList.toggle('show', on);
  }
  function checkIsleSighting() {
    const isle = ctx.world?.isle2;
    const p = ctx.player?.position;
    if (!isleSightingDue(p, isle)) return;
    isleSighted = true;
    hint(
      'isle2_sighting',
      "There's another island to the north-east… Tempest Isle. Too far to swim: craft a Wooden Paddle and a Paddle Raft, and cross from the north-east beach."
    );
    map?.glimpse?.(isle.x, isle.z, (isle.R || 150) * 1.1, 80);
    panels?.log('🏝️', 'Spotted another island to the north-east: Tempest Isle.');
  }

  function statMax(key) {
    const m = ctx.stats?.max;
    if (typeof m === 'number') return m;
    return m?.[key] ?? 100;
  }

  function updateBars() {
    const v = ctx.stats?.values;
    if (!v) return;
    for (const key in E.bars) {
      const val = v[key];
      if (val == null) continue;
      const frac = clamp01(val / statMax(key));
      const B = E.bars[key];
      if (Math.abs((barCache[key] ?? -1) - frac) < 0.002) continue;
      barCache[key] = frac;
      const sx = `scaleX(${frac.toFixed(3)})`;
      B.fill.style.transform = sx;
      B.ghost.style.transform = sx;
      B.val.textContent = String(Math.round(frac * 100));
      const lim = key === 'energy' ? 0.15 : 0.2;
      B.row.classList.toggle('crit', frac < lim);
      B.row.classList.toggle('low', frac >= lim && frac < 0.35);
    }
    const heat = v.heat;
    if (heat != null && Math.abs((barCache.heat ?? -1) - heat) > 0.1) {
      barCache.heat = heat;
      E.heatMarker.style.left = clamp(heat, 0, 100).toFixed(1) + '%';
      const cmin = CONFIG.stats.heatComfortMin, cmax = CONFIG.stats.heatComfortMax;
      const word = heatWord(heat, cmin, cmax);
      if (E.heatVal.textContent !== word) E.heatVal.textContent = word;
      E.heatRow.classList.toggle('cold', heat < cmin);
      E.heatRow.classList.toggle('hot', heat > cmax);
      E.heatRow.classList.toggle('crit', heat < 25 || heat > 86);
    }
    // breath bubbles
    const under = !!ctx.player?.headUnderwater;
    const breath = v.breath ?? 100;
    const showBreath = under || breath < 99;
    if (showBreath !== (barCache.showBreath ?? false)) {
      barCache.showBreath = showBreath;
      E.breath.style.display = showBreath ? 'flex' : 'none';
    }
    if (showBreath) {
      const n = Math.ceil(breath / 10 - 0.001);
      if (n !== barCache.bubbles) {
        barCache.bubbles = n;
        for (let i = 0; i < 10; i++) E.bubbles[i].classList.toggle('gone', i >= n);
      }
      // v2: depth while diving
      const depth = under ? ctx.player?.depth ?? 0 : 0;
      const dTxt = depth >= 0.5 ? `↓ ${depth.toFixed(1)} m` : '';
      if (dTxt !== barCache.depth) {
        barCache.depth = dTxt;
        E.depth.textContent = dTxt;
      }
    }
  }

  function chip(id, on, icon, text, kind = '') {
    let c = E.chipEls[id];
    if (!on) {
      if (c && c.isConnected) c.remove();
      return;
    }
    if (!c) {
      c = E.chipEls[id] = el('span', 'chip');
      c._t = '';
    }
    const full = icon + ' ' + text;
    if (c._t !== full) {
      c._t = full;
      c.textContent = full;
    }
    const cls = 'chip ' + kind;
    if (c.className !== cls) c.className = cls;
    if (!c.isConnected) E.chips.appendChild(c);
  }

  function poisonLevels() {
    const v = ctx.stats?.values || {};
    const sp = v.poison ?? ctx.stats?.poison ?? 0;
    const sn = v.nausea ?? ctx.stats?.nausea ?? 0;
    const lp = localPoisonUntil > playClock ? clamp01((localPoisonUntil - playClock) / 10) : 0;
    const ln = localNauseaUntil > playClock ? clamp01((localNauseaUntil - playClock) / 8) : 0;
    return { poison: Math.max(sp > 0 ? clamp01(sp / 15 + 0.3) : 0, lp), nausea: Math.max(sn > 0 ? clamp01(sn / 10 + 0.3) : 0, ln) };
  }

  function updateChips() {
    const f = ctx.flags;
    const v = ctx.stats?.values || {};
    const wet = v.wetness ?? 0;
    chip('wet', wet > 0.15, '💦', wet > 0.7 ? 'Soaked' : wet > 0.4 ? 'Wet' : 'Damp', 'cold');
    chip('sun', (ctx.stats?.env?.sun ?? 0) > 0.45 && (v.heat ?? 50) < CONFIG.stats.heatComfortMax, '☀️', 'In the sun', 'good');
    chip('fire', (f.nearFire || 0) > 0.12, '🔥', 'Warm by the fire', 'good');
    chip('shelter', !!f.sheltered, '🏕️', 'Sheltered', 'good');
    const rain = ctx.weather?.rain ?? ctx.uniforms?.uRain?.value ?? 0;
    chip('rain', rain > 0.15, '☔', 'Raining', f.sheltered ? '' : 'warn');
    chip('wave', !!f.waving, '👋', 'Waving', 'good');
    const torch = ctx.structures?.torch;
    chip('torch', !!f.torchLit, '🕯️', torch?.burnLeft != null ? `Torch · ${fmtBurn(torch.burnLeft)}` : 'Torch lit', 'good');
    const pl = poisonLevels();
    chip('poison', pl.poison > 0.05, '☠️', 'Poisoned', 'bad');
    chip('nausea', pl.nausea > 0.05 && pl.poison <= 0.05, '🤢', 'Nauseous', 'bad');
    chip('tired', !!ctx.stats?.exhausted, '😮‍💨', 'Exhausted', 'warn');
    chip('sleep', !!ctx.structures?.canSleepHere?.(), '🌙', 'You can sleep here', '');
  }
  function fmtBurn(h) {
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return hh > 0 ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
  }

  function setVig(key, elx, a) {
    a = Math.round(clamp01(a) * 100) / 100;
    if (vigCache[key] === a) return;
    vigCache[key] = a;
    elx.style.opacity = String(a);
  }

  function updateVignettes() {
    const v = ctx.stats?.values;
    const playingLike = ctx.state === 'playing' || ctx.state === 'paused';
    if (!v || !playingLike) {
      setVig('health', E.vigHealth, 0);
      setVig('cold', E.vigCold, 0);
      setVig('hot', E.vigHot, 0);
      setVig('poison', E.vigPoison, 0);
      setVig('water', E.vigWater, 0);
      resetCanvasFx();
      return;
    }
    const health = v.health ?? 100;
    setVig('health', E.vigHealth, health < 35 ? (35 - health) / 35 + 0.15 : 0);
    E.vigHealth.classList.toggle('pulse', health < 20);
    const heat = v.heat ?? 50;
    setVig('cold', E.vigCold, heat < 25 ? (25 - heat) / 22 + 0.1 : 0);
    setVig('hot', E.vigHot, heat > 85 ? (heat - 85) / 12 + 0.1 : 0);
    const pl = poisonLevels();
    const lvl = Math.max(pl.poison, pl.nausea);
    setVig('poison', E.vigPoison, lvl * 0.85);
    // underwater tint (Builder A may also tint: stay subtle if it exposes isCameraUnderwater)
    const cu = ctx.water?.isCameraUnderwater;
    const under = typeof cu === 'function' ? !!cu.call(ctx.water) : cu != null ? !!cu : !!ctx.player?.headUnderwater;
    setVig('water', E.vigWater, under ? (cu != null ? 0.2 : 0.65) : 0);
    // nausea wobble on the game canvas
    nauseaLevel += (lvl - nauseaLevel) * 0.05;
    const canvas = ctx.renderer?.domElement;
    if (canvas && nauseaLevel > 0.02 && ctx.state === 'playing') {
      const t = playClock;
      const rot = Math.sin(t * 1.1) * 1.2 * nauseaLevel;
      const sc = 1.03 + 0.02 * Math.sin(t * 0.7) * nauseaLevel;
      const sx = Math.sin(t * 0.83) * 8 * nauseaLevel;
      canvas.style.transform = `translateX(${sx.toFixed(1)}px) rotate(${rot.toFixed(2)}deg) scale(${sc.toFixed(3)})`;
      canvas.style.filter = `blur(${(nauseaLevel * 1.6).toFixed(2)}px) saturate(${(1 + nauseaLevel * 0.35).toFixed(2)}) hue-rotate(${(-18 * nauseaLevel).toFixed(1)}deg)`;
      canvasWobbling = true;
    } else if (canvasWobbling && nauseaLevel <= 0.02) resetCanvasFx();
  }
  function resetCanvasFx() {
    if (!canvasWobbling) return;
    canvasWobbling = false;
    nauseaLevel = 0;
    const canvas = ctx.renderer?.domElement;
    if (canvas) {
      canvas.style.transform = '';
      canvas.style.filter = '';
    }
  }

  function actionHint(id) {
    const it = ITEMS[id];
    if (!it) return '';
    if (id === 'torch') return ctx.flags.torchLit ? '[T] Stow torch' : '[T] Light torch';
    if (id === 'flare') return '[F] Fire flare';
    if (id === 'bottle_empty') return '[R] Fill at fresh water';
    if (it.category === 'food') return '[F] Eat';
    if (it.category === 'drink') return '[F] Drink';
    if (it.category === 'medicine') return '[F] Use';
    if (id === 'shovel' || id === 'pickaxe' || id === 'diving_mask') return '[F] How to use it';
    if (it.category === 'part') return 'Boat part: bring it to the Boatyard';
    return '[Tab] Craft with it';
  }

  function updateHotbar() {
    const inv = ctx.inventory;
    if (!inv?.hotbar) return;
    const sig = (inv.version ?? 0) + ':' + (inv.selectedIndex ?? 0) + ':' + (ctx.flags.torchLit ? 1 : 0);
    if (sig === hotbarSig) return;
    hotbarSig = sig;
    const sel = inv.selectedIndex ?? 0;
    for (let i = 0; i < 9; i++) {
      const S = E.slots[i];
      const id = inv.hotbar[i] || null;
      const n = id ? inv.count(id) : 0;
      if (S.id !== id) {
        S.id = id;
        S.icon.textContent = id ? ITEMS[id]?.icon || '❔' : '';
        S.s.title = id ? ITEMS[id]?.name || id : '';
      }
      if (S.count !== n) {
        S.count = n;
        S.n.textContent = id && n > 1 ? String(n) : '';
      }
      S.s.classList.toggle('empty', !id);
      S.s.classList.toggle('sel', i === sel);
      S.s.classList.toggle('lit', id === 'torch' && !!ctx.flags.torchLit);
    }
    const id = inv.hotbar[sel];
    E.hotName.textContent = '';
    if (id && ITEMS[id]) {
      el('b', '', E.hotName, ITEMS[id].name);
      el('span', 'hot-act', E.hotName, actionHint(id));
    }
  }

  return api;
}
