// HUD panels (Builder E): crafting + backpack, journal (boat / tips / plants / secrets / log), island map.
// Built into the .hud-panels container by hud.js. Rendering is on demand (open, tab switch, after a
// craft or item use), never per frame, because the game is frozen while a panel is open.
import { ITEMS, isConsumable } from '../core/items.js';
import { fmtHour } from '../core/util.js';
import { TIPS, PLANTS, SAFETY_BADGE, effectSummary, compassLabel, MAP_LANDMARKS, STRUCTURE_ICON, PART_WHERE, partsSummary } from './hud-data.js';

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

const NAV = [
  ['craft', '🛠️ Crafting', 'Tab'],
  ['journal', '📖 Journal', 'J'],
  ['map', '🗺️ Map', 'M'],
];

export function createPanels(ctx, ui, host, map) {
  const journal = {
    plants: new Set(), // plant ids discovered (gathered at least once)
    poisonous: new Set(), // plant ids known to be poisonous (eaten, or marked by a note)
    eggs: new Map(), // id -> { name, text }
    eggsTotal: 7,
    notes: new Map(), // entryId -> { title, text, icon }
    log: [], // { t (hoursTotal), icon, text }
    seenItems: new Set(),
  };
  let current = null;
  let journalTab = 'boat'; // v2: the boat is the main goal, so the journal opens on it
  let mapCanvas = null;

  const panel = el('div', 'panel', host);
  // Clicking the dark backdrop closes the panel (a click is a user gesture, so pointer lock works).
  host.addEventListener('mousedown', (e) => {
    if (e.target === host) ui.closePanel();
  });
  // Keep wheel scrolling inside the panel lists.
  panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

  function log(icon, text) {
    journal.log.push({ t: ctx.time?.hoursTotal ?? 0, icon, text });
    if (journal.log.length > 200) journal.log.shift();
    if (current === 'journal' && journalTab === 'log') render();
  }

  function show(name) {
    current = name;
    host.classList.add('open');
    render();
  }
  function hide() {
    current = null;
    host.classList.remove('open');
  }

  function render() {
    panel.textContent = '';
    const head = el('div', 'panel-head', panel);
    const titleBox = el('div', '', head);
    const nav = el('div', 'panel-tabs', head);
    nav.style.padding = '0';
    for (const [id, label, key] of NAV) {
      const b = el('button', 'panel-tab' + (id === current ? ' on' : ''), nav, label);
      b.title = `${key} to open/close`;
      b.addEventListener('click', () => ui.openPanel(id));
    }
    const close = el('div', 'panel-close', head);
    el('span', 'key', close, 'Esc');
    close.append(' close');
    if (current === 'craft') renderCraft(titleBox);
    else if (current === 'journal') renderJournal(titleBox);
    else if (current === 'map') renderMap(titleBox);
  }

  // ── Crafting ───────────────────────────────────────────────────────────
  function reqChip(parent, r) {
    const c = el('span', 'req-chip ' + (r.ok ? 'have' : 'miss') + (r.tool ? ' tool' : ''), parent);
    c.textContent = r.tool ? `${r.icon} ${r.name}${r.ok ? ' ✓' : ''}` : `${r.icon} ${r.have}/${r.need}`;
    c.title = r.tool ? `${r.name} (tool, not used up)` : r.name;
  }

  function renderCraft(titleBox) {
    el('div', 'panel-title', titleBox, 'Crafting');
    el('div', 'panel-sub', titleBox, 'Combine what you gathered. Placeables are built in front of you.');
    const cols = el('div', 'panel-body panel-cols', panel);
    const left = el('div', '', cols);
    const right = el('div', '', cols);

    const list = ctx.crafting?.available?.() || [];
    const sections = [
      ['item', 'Craft'],
      ['place', 'Build'],
      ['fire', 'At the fire'],
    ];
    for (const [sec, label] of sections) {
      const items = list.filter((r) => r.section === sec);
      if (!items.length) continue;
      el('div', 'sec-title', left, label);
      for (const r of items) {
        const row = el('div', 'recipe ' + (r.ok ? 'ok' : 'no'), left);
        el('div', 'r-icon', row, r.icon);
        const mid = el('div', '', row);
        el('div', 'r-name', mid, r.name);
        if (r.desc) el('div', 'r-desc', mid, r.desc);
        const req = el('div', 'req', mid);
        for (const q of r.reqs) reqChip(req, q);
        if (!r.ok && r.reason) el('div', 'r-reason', mid, r.reason);
        const b = el('button', 'btn', row, r.verb || 'Craft');
        b.disabled = !r.ok;
        b.addEventListener('click', () => {
          const res = ctx.crafting?.craft?.(r.id);
          if (res?.placed) ui.closePanel();
          else render();
        });
      }
    }
    if (!list.some((r) => r.section === 'fire')) el('div', 'muted-note', left, '🔥 More recipes (herbal tea, nettle soup) appear while you stand at a lit fire.');
    if (!list.length) el('div', 'muted-note', left, 'Crafting is not available right now.');

    // backpack
    el('div', 'sec-title', right, 'Backpack');
    const items = ctx.inventory?.list?.() || [];
    const info = el('div', 'pack-info');
    if (!items.length) el('div', 'muted-note', right, 'Empty. Look around: sticks, stones, plants…');
    const grid = el('div', 'pack', right);
    const showInfo = (id) => {
      const it = ITEMS[id];
      info.textContent = '';
      if (!it) return;
      el('b', '', info, `${it.icon} ${it.name}`);
      info.append(' · ' + it.desc);
      const fx = effectSummary(it.effects);
      if (fx && (it.category !== 'food' || journal.plants.has(id) || !PLANTS.some((p) => p.id === id))) {
        el('div', '', info, fx).style.marginTop = '4px';
      }
      if (isConsumable(id) || id === 'torch' || id === 'flare') el('div', '', info, 'Click to use.').style.color = 'var(--accent)';
    };
    for (const { id, n } of items) {
      const it = ITEMS[id];
      const usable = isConsumable(id) || id === 'torch' || id === 'flare';
      const c = el('div', 'pack-item' + (usable ? ' usable' : ''), grid, it?.icon || '❔');
      if (n > 1) el('span', 'slot-n', c, String(n));
      c.addEventListener('mouseenter', () => showInfo(id));
      if (usable)
        c.addEventListener('click', () => {
          ctx.inventory?.useItem?.(id);
          render();
        });
    }
    right.appendChild(info);
    info.textContent = 'Hover an item to read about it.';
  }

  // ── Journal ────────────────────────────────────────────────────────────
  function renderJournal(titleBox) {
    el('div', 'panel-title', titleBox, 'Journal');
    el('div', 'panel-sub', titleBox, `Day ${ctx.time.day} · ${fmtHour(ctx.time.hour)}`);
    const tabs = el('div', 'panel-tabs', panel);
    const T = [
      ['boat', '⛵ Boat'],
      ['tips', '🧭 Survival tips'],
      ['plants', `🌿 Plants ${journal.plants.size}/${PLANTS.length}`],
      ['secrets', `✨ Secrets ${journal.eggs.size}/${journal.eggsTotal}`],
      ['log', '📜 Log'],
    ];
    for (const [id, label] of T) {
      const b = el('button', 'panel-tab' + (id === journalTab ? ' on' : ''), tabs, label);
      b.addEventListener('click', () => {
        journalTab = id;
        render();
      });
    }
    const body = el('div', 'panel-body', panel);
    if (journalTab === 'boat') {
      renderBoat(body);
    } else if (journalTab === 'tips') {
      const g = el('div', 'tip-grid', body);
      for (const t of TIPS) {
        const d = el('div', 'tip', g);
        el('div', 'tip-icon', d, t.icon);
        const tx = el('div', '', d);
        el('b', '', tx, t.title);
        tx.append(t.text);
      }
    } else if (journalTab === 'plants') {
      const pr = el('div', 'progress', body);
      el('div', '', pr).style.width = (100 * journal.plants.size) / PLANTS.length + '%';
      for (const p of PLANTS) {
        const it = ITEMS[p.id];
        const known = journal.plants.has(p.id);
        const row = el('div', 'plant' + (known ? '' : ' unknown'), body);
        el('div', 'p-icon', row, it.icon);
        const mid = el('div', '', row);
        el('div', 'p-name', mid, known ? it.name : '???');
        let safety = p.safety;
        if (p.id === 'toadstool' && !journal.poisonous.has('toadstool')) safety = 'unknown';
        if (journal.poisonous.has(p.id)) safety = 'poison';
        const note = !known ? 'Not found yet.' : safety === 'unknown' ? `${it.desc.split('.')[0]}. Is it safe? You don't know yet.` : `${it.desc} ${p.note}`;
        el('div', 'p-desc', mid, note);
        if (known) {
          const b = SAFETY_BADGE[safety];
          el('span', 'badge ' + safety, row, `${b.icon} ${b.label}`);
        }
      }
    } else if (journalTab === 'secrets') {
      const pr = el('div', 'progress', body);
      el('div', '', pr).style.width = (100 * journal.eggs.size) / Math.max(1, journal.eggsTotal) + '%';
      el('div', 'sec-title', body, `Easter eggs found ${journal.eggs.size}/${journal.eggsTotal}`);
      for (const [, e] of journal.eggs) {
        const row = el('div', 'egg found', body);
        el('span', 'e-icon', row, '✨');
        const tx = el('div', '', row);
        el('b', '', tx, e.name);
        if (e.text) el('div', 'p-desc', tx, e.text);
      }
      for (let i = journal.eggs.size; i < journal.eggsTotal; i++) {
        const row = el('div', 'egg', body);
        el('span', 'e-icon', row, '❔');
        el('span', 'muted', row, '??? The island still hides something.');
      }
      if (journal.notes.size) {
        el('div', 'sec-title', body, 'Notes & pages');
        for (const [, n] of journal.notes) {
          const d = el('div', 'note', body);
          el('b', '', d, `${n.icon} ${n.title}`);
          if (n.text) el('div', '', d, n.text).style.whiteSpace = 'pre-line';
        }
      }
    } else {
      if (!journal.log.length) el('div', 'muted-note', body, 'Nothing yet.');
      for (let i = journal.log.length - 1; i >= 0; i--) {
        const L = journal.log[i];
        const row = el('div', 'log-line', body);
        const day = Math.floor(L.t / 24) + 1;
        el('span', 'l-time', row, `Day ${day} · ${fmtHour(L.t % 24)}`);
        el('span', '', row, L.icon);
        el('span', '', row, L.text);
      }
    }
  }

  // ── Journal: Boat tab (v2, SPEC §10: ctx.raft owned by V2-B) ───────────
  const HOW_TO = [
    ['🪏', 'Buried parts', 'Craft a Wooden Shovel (wood 2, stone 1, rope 1), then press E on a disturbed sand mound to dig.'],
    ['⛏️', 'Parts in rocks', 'Craft a Flint Pickaxe (wood 2, flint 1, rope 1), then press E on a cracked rock that glints. Keep a spare flint for fire!'],
    ['🤿', 'Underwater parts', 'Swim out near the wreck and hold X to dive (Space rises, let go to float up). A Diving Mask (bamboo 1, cloth 1, rope 1) means a longer breath.'],
    ['🔨', 'Building', 'Bring everything to the Boatyard and press E there. You can only build by day, and each stage takes a few hours of work.'],
  ];

  function renderBoat(body) {
    const R = ctx.raft;
    const plan = R?.plan;
    const stages = Array.isArray(plan?.stages) ? plan.stages : null;
    if (!stages) {
      el('div', 'muted-note', body, 'No boat plans yet. Look around the beach where you washed ashore.');
    } else {
      const n = stages.length;
      const idx = Math.max(0, Math.min(n, Number.isFinite(R.stageIndex) ? R.stageIndex : 0));
      const done = !!R.complete || idx >= n;
      const pr = el('div', 'progress', body);
      el('div', '', pr).style.width = (100 * (done ? n : idx)) / Math.max(1, n) + '%';
      el('div', 'sec-title', body, `${plan.name || 'Your boat'} · ${done ? n : idx}/${n} stages built`);
      if (done) {
        el('div', 'muted-note', body, R.away ? '⛵ The boat is moored off the cove on Tempest Isle: sail home from there.' : '⛵ The boat is finished. Launch it from the Boatyard, or press R there to sail it to Tempest Isle!');
      }
      const count = (id) => ctx.inventory?.count?.(id) ?? 0;
      for (let i = 0; i < n; i++) {
        const st = stages[i] || {};
        const state = i < idx || done ? 'done' : i === idx ? 'current' : 'todo';
        const row = el('div', 'boat-stage ' + state, body);
        el('span', 'bs-mark', row, state === 'done' ? '✓' : state === 'current' ? '▶' : String(i + 1));
        const mid = el('div', '', row);
        el('div', 'bs-name', mid, st.label || st.id || `Stage ${i + 1}`);
        const req = el('div', 'req', mid);
        for (const id in st.needs || {}) {
          const need = st.needs[id];
          const it = ITEMS[id];
          const have = state === 'done' ? need : Math.min(count(id), need);
          const ok = have >= need;
          const c = el('span', 'req-chip ' + (ok ? 'have' : 'miss'), req, `${it?.icon || '❔'} ${have}/${need}`);
          c.title = it?.name || id;
        }
        if (Number.isFinite(st.hours)) el('span', 'bs-hours', row, `${st.hours} h`);
      }
    }

    const rows = partsSummary(R?.parts?.());
    el('div', 'sec-title', body, 'Boat parts');
    if (!rows.length) el('div', 'muted-note', body, stages ? 'This boat needs no salvaged parts beyond materials.' : 'Nothing found yet.');
    for (const r of rows) {
      const all = r.found >= r.total;
      const row = el('div', 'plant' + (r.found ? '' : ' unknown'), body);
      el('div', 'p-icon', row, r.icon);
      const mid = el('div', '', row);
      el('div', 'p-name', mid, r.name);
      const w = PART_WHERE[r.where];
      el('div', 'p-desc', mid, w ? `${w.icon} ${w.label}. ${w.hint}` : r.hint);
      el('span', 'badge' + (all ? ' safe' : ''), row, `${all ? '✅ ' : ''}${r.found}/${r.total} found`);
    }

    el('div', 'sec-title', body, 'How to');
    tipGrid(body, HOW_TO);

    // v3: Tempest Isle
    el('div', 'sec-title', body, '🏝️ Tempest Isle');
    const lab = ctx.difficulty?.label || ctx.difficulty?.id || 'Easy';
    const known = map?.discovered?.has?.('isle2');
    el('div', 'muted-note', body, known ? 'You have set foot near Tempest Isle.' : "There's another island to the north-east: from the summit you can see it clearly.");
    tipGrid(body, [
      ['🛶', 'Getting there', "It lies ~525 m off the north-east beach: too far to swim. Craft a Wooden Paddle (wood 2, rope 1) and a Paddle Raft (wood 8, rope 3) at the water's edge, board it (E) and paddle across (W/S paddle, A/D steer). Slow and tiring, but it gets there. Your finished boat can sail there too (R at the Boatyard)."],
      ['🚤', 'The motorboat', "A fisherman's motorboat is tied up at the dock in the cove. Its key and a can of fuel are in the fishing hut on the summit. Drive it far out to sea (over 250 m from any coast) and press R to head for home."],
      ['⛈️', 'Dangers', "Violent storms hit the isle on many days and nights, and they roll in fast. Hail batters you outdoors, the wind puts out every fire that isn't indoors, and rafts and sail boats can capsize (right a raft with E once the storm eases). The mountain path is steep and rocks fall."],
      ['🎯', 'Difficulty', `Easy: the search party spots you readily. Medium: you are hard to spot, so a boat is the surer way home. Hard: the search party can't see you at all, so your only way home is a boat. You are playing ${lab}.`],
    ]);
  }

  function tipGrid(body, rows) {
    const g = el('div', 'tip-grid', body);
    for (const [icon, title, text] of rows) {
      const d = el('div', 'tip', g);
      el('div', 'tip-icon', d, icon);
      const tx = el('div', '', d);
      el('b', '', tx, title);
      tx.append(text);
    }
  }

  // ── Map ────────────────────────────────────────────────────────────────
  function renderMap(titleBox) {
    el('div', 'panel-title', titleBox, 'Map of the islands');
    el('div', 'panel-sub', titleBox, 'Drawn from what you have seen. Explore to reveal more.');
    const body = el('div', 'panel-body map-wrap', panel);
    const stage = el('div', 'map-stage', body);
    if (!mapCanvas) {
      mapCanvas = document.createElement('canvas');
      mapCanvas.width = mapCanvas.height = 640;
    }
    stage.appendChild(mapCanvas);
    const legend = el('div', 'map-legend', body);
    if (!map) {
      el('div', 'muted-note', legend, 'The map is not available.');
      return;
    }
    map.draw(mapCanvas);

    const pct = (x, z) => map.toPercent(x, z);
    const discovered = map.discovered;
    const lm = ctx.world?.landmarks || {};
    for (const L of MAP_LANDMARKS) {
      const P = lm[L.key];
      if (!P || !discovered.has(L.key)) continue;
      const [px, pz] = pct(P.x, P.z);
      const pin = el('div', 'map-pin', stage, L.icon);
      pin.style.left = px + '%';
      pin.style.top = pz + '%';
      pin.title = L.name;
    }
    for (const s of ctx.structures?.list || []) {
      if (s.removed) continue;
      const [px, pz] = pct(s.position.x, s.position.z);
      const pin = el('div', 'map-pin small', stage, STRUCTURE_ICON[s.type] || '•');
      pin.style.left = px + '%';
      pin.style.top = pz + '%';
    }
    // v2: the Boatyard (always shown: it is on the beach where you washed ashore)
    const yard = ctx.raft?.site;
    if (yard) {
      const [px, pz] = pct(yard.x, yard.z);
      const pin = el('div', 'map-pin yard', stage, '⛵');
      pin.style.left = px + '%';
      pin.style.top = pz + '%';
      pin.title = 'Boatyard';
    }
    // v3: your paddle raft and the boat when it is moored at Tempest Isle
    const vr = ctx.vehicles?.raft;
    if (vr && ctx.vehicles?.current !== vr) {
      const [px, pz] = pct(vr.object.position.x, vr.object.position.z);
      const pin = el('div', 'map-pin small', stage, vr.capsized ? '🙃' : '🛶');
      pin.style.left = px + '%';
      pin.style.top = pz + '%';
      pin.title = vr.capsized ? 'Your raft (capsized)' : 'Your paddle raft';
    }
    if (ctx.raft?.away && ctx.raft.voyage?.position) {
      const bp = ctx.raft.voyage.position;
      const [px, pz] = pct(bp.x, bp.z);
      const pin = el('div', 'map-pin small', stage, '⛵');
      pin.style.left = px + '%';
      pin.style.top = pz + '%';
      pin.title = 'Your boat (moored)';
    }
    const p = ctx.player?.position;
    if (p) {
      const [px, pz] = pct(p.x, p.z);
      const me = el('div', 'map-player', stage);
      me.style.left = px + '%';
      me.style.top = pz + '%';
      const yaw = ctx.player?.yaw ?? ctx.camera.rotation.y;
      me.style.transform = `rotate(${((-yaw * 180) / Math.PI).toFixed(1)}deg)`;
    }

    el('div', 'sec-title', legend, 'Places');
    if (yard) {
      const row = el('div', 'lg', legend);
      el('span', '', row, '⛵');
      el('span', '', row, `Boatyard${ctx.raft?.plan?.name ? ': ' + ctx.raft.plan.name : ''}`);
    }
    for (const L of MAP_LANDMARKS) {
      const known = discovered.has(L.key);
      const row = el('div', 'lg' + (known ? '' : ' unknown'), legend);
      el('span', '', row, known ? L.icon : '❔');
      el('span', '', row, known ? L.name : 'Undiscovered');
    }
    const counts = {};
    for (const s of ctx.structures?.list || []) if (!s.removed) counts[s.type] = (counts[s.type] || 0) + 1;
    if (Object.keys(counts).length) {
      el('div', 'sec-title', legend, 'Your camp').style.marginTop = '12px';
      for (const t in counts) {
        const row = el('div', 'lg', legend);
        el('span', '', row, STRUCTURE_ICON[t] || '•');
        el('span', '', row, `${{ campfire: 'Campfire', signal_fire: 'Signal fire', sos: 'SOS sign', shelter: 'Lean-to' }[t] || t}${counts[t] > 1 ? ' ×' + counts[t] : ''}`);
      }
    }
    const info = el('div', 'map-coords', legend);
    info.textContent = `Explored ${Math.round(map.exploredFraction() * 100)}% of the islands`;
    if (p) {
      const yaw = ctx.player?.yaw ?? 0;
      let h = ((-yaw * 180) / Math.PI) % 360;
      if (h < 0) h += 360;
      el('div', '', info, `Facing ${compassLabel(h)} · ${Math.round(p.y)} m above the sea`);
    }
  }

  return {
    journal,
    log,
    show,
    hide,
    refresh: () => current && render(),
    get current() {
      return current;
    },
  };
}
