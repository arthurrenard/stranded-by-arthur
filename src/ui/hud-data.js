// Static text for the HUD: survival tips, plant notes, death causes, rescue methods.
// Pure data + tiny formatting helpers (no DOM), so it can be unit-tested in node.
import { ITEMS } from '../core/items.js';

/** Journal "Survival tips" tab. */
export const TIPS = [
  { icon: '💧', title: 'Water first', text: 'Thirst kills fastest. Drink at Spring Pond, the river or Mirror Lake: look at the water and press E. Seawater only makes you thirstier.' },
  { icon: '🫙', title: 'Carry water', text: 'Cut bamboo (you need flint) and twist plant fiber to craft a Bamboo Canteen. Press R at fresh water to fill it.' },
  { icon: '☀️', title: 'Warm up in the sun', text: 'You start soaked and cold. Stand in open sunlight, away from tree shade, to dry off and warm up. Swimming and rain soak you again.' },
  { icon: '🔥', title: 'Fire', text: 'Strike flint 🔹 against pyrite 🪙. With both in your pack, build a campfire from 3 wood and 4 stones. Flint lies on beaches and riverbeds, pyrite on rocky high ground.' },
  { icon: '🍳', title: 'Cook your food', text: 'Stand at a lit campfire and press R to cook everything cookable you carry. Cooked food is two to three times more filling.' },
  { icon: '🍄', title: 'Mushrooms', text: 'Golden funnel-shaped chanterelles are good once cooked. Red caps with white spots are toadstools: poison, cooked or not.' },
  { icon: '🌙', title: 'Nights are cold', text: 'After 19:00 the air gets cold. Stay by a fire, light a torch (T), or build a lean-to. In a shelter or by a fire you can sleep until morning.' },
  { icon: '🌧️', title: 'Rain', text: 'Rain soaks you, eats fire fuel and can douse an open campfire. A lean-to keeps you and a fire beside you dry.' },
  { icon: '🚁', title: 'Get spotted', text: 'The search party passes by from time to time. Stand in the open, wave (G), and give them something to see.' },
  { icon: '💨', title: 'Signal fire', text: 'A signal fire on open ground makes a smoke column visible for miles. Light it when you hear the search party, and add leaves for thicker smoke.' },
  { icon: '🆘', title: 'SOS', text: 'Ten stones laid out on a sandy beach spell SOS, which can be read from the air by day.' },
  { icon: '🧨', title: 'Flare', text: 'A flare is a huge, instant signal. Save it until a helicopter or boat is close, then fire it (F).' },
  { icon: '⛵', title: 'Rebuild a boat', text: 'The surest way home: gather boat parts and materials, then build each stage at the Boatyard on the beach where you washed ashore (look at it and press E). Building takes game hours and only works by day. The Journal\'s Boat tab lists everything.' },
  { icon: '🪏', title: 'Hidden parts', text: 'Some parts are buried under disturbed sand mounds (dig with a Wooden Shovel) or wedged in cracked, glinting rocks (break them with a Flint Pickaxe).' },
  { icon: '🤿', title: 'Diving', text: 'While swimming, hold X to dive and Space to rise; let go to float up. Valuable parts lie on the seabed near the wreck. A Diving Mask makes your breath last twice as long.' },
  { icon: '🌿', title: 'Healing', text: 'Aloe, yarrow and chamomile restore health. Brew yarrow and chamomile with a full canteen at a fire to make a strong herbal tea.' },
  { icon: '🌴', title: 'Palm trees', text: 'Shaking a palm (E) can drop coconuts, but about one shake in twenty drops one on your head. Look for fallen coconuts on the sand first.' },
  { icon: '🛶', title: 'Paddle raft', text: "Craft a Wooden Paddle (wood 2, rope 1) and a Paddle Raft (wood 8, rope 3) at the water's edge. Board it with E, paddle with W/S, steer with A/D. It is slow and tiring, but it reaches Tempest Isle." },
  { icon: '⛈️', title: 'Tempest Isle storms', text: 'Violent storms sweep over Tempest Isle on many days and nights. They come in fast, hail hurts, fires outdoors go out, and rafts and sail boats can capsize. Get indoors until it passes.' },
];

/** v3: the hunger STAT icon (the leaves ITEM keeps 🍃). */
export const HUNGER_ICON = '🥩';

/** Plants shown in the journal, in display order, with safety notes. */
export const PLANTS = [
  { id: 'berries', safety: 'safe', note: 'Safe raw.' },
  { id: 'wild_apple', safety: 'safe', note: 'Safe raw, better baked.' },
  { id: 'chestnut', safety: 'safe', note: 'Safe. Roast them at a fire.' },
  { id: 'coconut', safety: 'safe', note: 'Safe. Quenches thirst too.' },
  { id: 'cattail', safety: 'safe', note: 'Safe. Better roasted.' },
  { id: 'chanterelle', safety: 'cook', note: 'Hurts your stomach raw. Cook it first.' },
  { id: 'wild_root', safety: 'cook', note: 'Bitter raw (nausea). Bake it.' },
  { id: 'nettle', safety: 'cook', note: 'Stings raw. Boil into nettle soup at a fire.' },
  { id: 'toadstool', safety: 'poison', note: 'Poisonous! Never eat it, cooked or raw.' },
  { id: 'aloe', safety: 'medicine', note: 'Medicine: restores health.' },
  { id: 'yarrow', safety: 'medicine', note: 'Medicine: heals wounds. Makes tea with chamomile.' },
  { id: 'chamomile', safety: 'medicine', note: 'Medicine: calming, restores a little energy.' },
  { id: 'bamboo', safety: 'material', note: 'Material: a hollow cane for a canteen.' },
];

export const SAFETY_BADGE = {
  safe: { icon: '✅', label: 'Safe' },
  cook: { icon: '🔥', label: 'Cook first' },
  poison: { icon: '☠️', label: 'Poisonous' },
  unknown: { icon: '❔', label: 'Unknown' },
  medicine: { icon: '💚', label: 'Medicine' },
  material: { icon: '🧰', label: 'Material' },
};

/** Death cause -> plain-words sentence start and a tip. */
export const DEATH = {
  dehydration: { text: 'You died of thirst', icon: '💧', tip: 'Drink often. Spring Pond is just inland from the beach, and a canteen lets you carry water.' },
  starvation: { text: 'You starved', icon: '🥩', tip: 'Gather berries, apples, chestnuts and coconuts, and cook them for two to three times the food.' },
  hypothermia: { text: 'You froze to death', icon: '🥶', tip: 'Dry off in the sun, stay by a campfire at night, and use a lean-to against the rain.' },
  heatstroke: { text: 'You collapsed from heatstroke', icon: '🥵', tip: 'Rest in tree shade during the hot afternoon and keep drinking.' },
  drowning: { text: 'You drowned', icon: '🌊', tip: 'Swimming drains energy. When you are exhausted, get back to shore before you sink.' },
  poison: { text: 'You were poisoned', icon: '☠️', tip: 'Red toadstools with white spots are deadly. Only eat golden chanterelles, and cook them.' },
  falling: { text: 'You fell to your death', icon: '🪨', tip: 'Watch your step on the cliffs near the summit.' },
  tree: { text: 'A falling tree crushed you', icon: '🌲', tip: 'When you hear a tree creak, run away from it.' },
  // v3 (sentence: the lead is "<text> Day N, hh:mm." instead of "<text> on day N, hh:mm.")
  coconut: { text: 'A coconut fell on your head. Bonk.', icon: '🥥', sentence: true, tip: 'Shaking palm trees is a gamble: about one shake in twenty drops a coconut on your head. Pick up fallen coconuts instead.' },
  hail: { text: 'Battered by hail on Tempest Isle', icon: '🧊', sentence: true, tip: "Tempest Isle's storms roll in fast. When the sky darkens, get indoors (the fisherman's hut) or under a shelter until it passes." },
  fire: { text: "You went down with the fisherman's hut", icon: '🔥', sentence: true, tip: 'Setting the hut on fire is fun. Standing inside it while it burns is not: get out of the door!' },
  unknown: { text: 'You died', icon: '💀', tip: 'Keep an eye on your bars. The island is beautiful but unforgiving.' },
};

/** Rescue method -> how you were spotted. */
export const RESCUE_METHOD = {
  signal_fire: 'They spotted the smoke column of your signal fire.',
  smoke: 'They spotted the smoke column of your signal fire.',
  flare: 'Your flare lit up the sky and they turned straight for you.',
  sos: 'They read your SOS spelled in stones on the beach.',
  campfire: 'They saw the glow of your campfire in the dark.',
  torch: 'They saw your torch flickering on the shore.',
  waving: 'They saw you waving your arms from the open ground.',
  visible: 'They caught sight of you standing in the open.',
  player: 'They caught sight of you standing in the open.',
  raft: 'You sailed home on your own boat!',
};

/** Death-screen lead: "You starved on day 3, 14:00." or, for sentence causes, "A coconut fell on your head. Bonk. Day 3, 14:00." */
export function deathLead(d, day, time) {
  if (d?.sentence) return `${d.text}${/[.!?]$/.test(d.text) ? '' : '.'} Day ${day}, ${time}.`;
  return `${d?.text || 'You died'} on day ${day}, ${time}.`;
}

// ── v2: boat-repair goal (pure helpers for the objective tracker, journal Boat tab and compass) ──

/** Where a boat part hides (ctx.raft.parts()[i].where) -> icon, label and where-to-look hint. */
export const PART_WHERE = {
  beach: { icon: '🏖️', label: 'On a beach', hint: 'Lying on the sand along the shore. Walk the beaches and press E.' },
  buried: { icon: '🪏', label: 'Buried', hint: 'Under a disturbed sand mound. Dig it up with a Wooden Shovel (E).' },
  rock: { icon: '⛏️', label: 'In a rock', hint: 'Wedged in a cracked rock with a glint inside. Break it with a Flint Pickaxe (E).' },
  underwater: { icon: '🤿', label: 'Underwater', hint: 'On the seabed near the wreck, 3 to 8 m down. Hold X to dive; a Diving Mask helps.' },
  isle2hut: { icon: '🛖', label: "In the fisherman's hut", hint: 'On the summit of Tempest Isle, north-east across the sea. Build a paddle raft and cross from the north-east beach (~525 m), then climb.' },
};

/** Win-screen line for the 'raft' method. name = the boat's name (falls back to "boat"). */
export function raftWinText(name) {
  if (typeof name === 'string' && /^the /i.test(name)) return `You sailed home in ${name}!`; // v3: "the fisherman's motorboat"
  return `You sailed home on your own ${name || 'boat'}!`;
}

/**
 * v3: the aboard panel. v = ctx.vehicles.current, opts = { canHeadHome, canDisembark, hasPaddle, exhausted }.
 * Returns { title, sub } or null.
 */
export function vehiclePanel(v, opts = {}) {
  if (!v) return null;
  if (v.type === 'motorboat') {
    const title = `🚤 Motorboat · W/S throttle · A/D steer · E disembark${opts.canHeadHome ? ' · R head for home' : ''}`;
    const sub = opts.canHeadHome ? 'Open sea: press R to head for home.' : opts.canDisembark ? 'Land is close: E to step ashore.' : 'Head out to open sea (> 250 m from any coast) to go home.';
    return { title, sub };
  }
  const title = '🛶 Paddle raft · W/S paddle · A/D steer · E disembark';
  let sub = opts.canDisembark ? 'Land is close: E to step ashore.' : 'Tempest Isle lies ~525 m north-east of the north-east beach.';
  if (!opts.hasPaddle) sub = 'No paddle: you can only drift. Craft a Wooden Paddle (wood 2 + rope 1).';
  else if (opts.exhausted) sub = 'Too tired to paddle hard: rest, eat or drink.';
  return { title, sub };
}

/** v3: show the storm banner while a Tempest Isle storm is active and the player is within `range` m of the isle. */
export function stormBannerOn(storm, distToIsle, range = 750) {
  return !!storm?.active && Number.isFinite(distToIsle) && distToIsle < range;
}

/** v3: the one-time "another island" hint: within `range` m of the isle and above `minAlt` m. */
export function isleSightingDue(pos, isle, range = 900, minAlt = 30) {
  if (!pos || !isle) return false;
  return pos.y > minAlt && Math.hypot(pos.x - isle.x, pos.z - isle.z) < range;
}

const int0 = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/**
 * ctx.raft.objective() -> tracker view model, or null when there is nothing to show.
 * { title, stage, needs: [{ id, icon, name, have, need, ok }], hint, ready, complete }
 */
export function objectiveView(o) {
  if (!o || typeof o !== 'object') return null;
  const count = int0(o.stageCount);
  const idx = int0(o.stageIndex);
  const complete = !!o.complete || (count > 0 && idx >= count);
  const needs = [];
  if (!complete && Array.isArray(o.needs)) {
    for (const n of o.needs) {
      if (!n || n.id == null) continue;
      const it = ITEMS[n.id];
      const have = int0(n.have),
        need = int0(n.need);
      needs.push({ id: n.id, icon: it?.icon ?? '❔', name: it?.name ?? String(n.id), have, need, ok: have >= need });
    }
  }
  const label = typeof o.stageLabel === 'string' ? o.stageLabel : '';
  const stage = complete ? 'Boat complete!' : count ? `Stage ${Math.min(idx + 1, count)}/${count}: ${label}`.replace(/: $/, '') : label;
  // trust raft's own `ready` (it may add rules, e.g. daylight); fall back to the needs when it is missing
  const ready = !complete && (typeof o.ready === 'boolean' ? o.ready : needs.length > 0 && needs.every((n) => n.ok));
  return { title: o.title || 'Rebuild the boat', stage, needs, hint: typeof o.hint === 'string' ? o.hint : '', ready, complete };
}

/** Cheap change signature of an objectiveView (the tracker only touches the DOM when it changes). */
export function objectiveSig(v) {
  if (!v) return '';
  let s = `${v.title}|${v.stage}|${v.hint}|${v.ready ? 1 : 0}${v.complete ? 1 : 0}`;
  for (const n of v.needs) s += `|${n.id}:${n.have}/${n.need}`;
  return s;
}

/**
 * ctx.raft.parts() -> one row per part id (first-seen order):
 * [{ id, icon, name, where, found, total, hint }]
 */
export function partsSummary(list) {
  const rows = [];
  const by = new Map();
  if (!Array.isArray(list)) return rows;
  for (const p of list) {
    if (!p || p.id == null) continue;
    let r = by.get(p.id);
    if (!r) {
      const it = ITEMS[p.id];
      const w = PART_WHERE[p.where];
      r = { id: p.id, icon: it?.icon ?? '❔', name: it?.name ?? String(p.id), where: p.where || 'beach', found: 0, total: 0, hint: w?.hint ?? '' };
      by.set(p.id, r);
      rows.push(r);
    }
    r.total++;
    if (p.found) r.found++;
  }
  return rows;
}

/** Bearing of (dx, dz) relative to a heading (deg, 0 = N, clockwise), in -180..180 deg. */
export function relBearing(headingDeg, dx, dz) {
  const b = (Math.atan2(dx, -dz) * 180) / Math.PI;
  let r = (b - headingDeg) % 360;
  if (r > 180) r -= 360;
  if (r < -180) r += 360;
  return r;
}

/**
 * Compass-strip placement for a marker: x in px within a strip of width w (PX_PER_DEG px per degree),
 * clamped to the edges with an arrow when the target is outside the visible range.
 * Returns { x, edge: -1 | 0 | 1 }.
 */
export function compassPlace(rel, w, pxPerDeg, margin = 22) {
  const x = w / 2 + rel * pxPerDeg;
  if (x < margin) return { x: margin, edge: -1 };
  if (x > w - margin) return { x: w - margin, edge: 1 };
  return { x, edge: 0 };
}

/** "1 day, 5 hours" / "7 hours 20 min". */
export function fmtDuration(hours) {
  const h = Math.max(0, hours);
  const d = Math.floor(h / 24);
  const hh = Math.floor(h % 24);
  const mm = Math.floor((h * 60) % 60);
  if (d > 0) return `${d} day${d > 1 ? 's' : ''}, ${hh} hour${hh === 1 ? '' : 's'}`;
  if (hh > 0) return `${hh} hour${hh === 1 ? '' : 's'} ${mm} min`;
  return `${mm} min`;
}

/** Compact effect summary for toasts: { hunger: 22, thirst: 2 } -> "+22 🥩 +2 💧". */
const EFFECT_ICON = { health: '❤️', thirst: '💧', hunger: HUNGER_ICON, energy: '⚡', heat: '🌡️', wetness: '💦', poison: '☠️', nausea: '🤢' };
export function effectSummary(effects) {
  if (!effects) return '';
  const parts = [];
  for (const k of ['health', 'thirst', 'hunger', 'energy', 'heat']) {
    const v = effects[k];
    if (!v) continue;
    parts.push(`${v > 0 ? '+' : '−'}${Math.abs(Math.round(v))} ${EFFECT_ICON[k]}`);
  }
  if (effects.poison) parts.push('☠️');
  if (effects.nausea) parts.push('🤢');
  return parts.join('  ');
}

/** Compass label for a bearing in degrees (0 = N, clockwise). */
export function compassLabel(deg) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Heat (0..100) -> word. */
export function heatWord(heat, min = 40, max = 75) {
  if (heat < 15) return 'Freezing';
  if (heat < 28) return 'Cold';
  if (heat < min) return 'Chilly';
  if (heat <= max) return 'Comfy';
  if (heat < 86) return 'Warm';
  if (heat < 92) return 'Hot';
  return 'Overheating';
}

/** Landmarks the map can discover: key in ctx.world.landmarks, display name, icon, discover range (m). */
export const MAP_LANDMARKS = [
  { key: 'spawn', name: 'Where you washed ashore', icon: '👣', range: 1e9 },
  { key: 'wreck', name: 'The wreck', icon: '⚓', range: 110 },
  { key: 'pond', name: 'Spring Pond', icon: '💧', range: 60 },
  { key: 'lake', name: 'Mirror Lake', icon: '🏞️', range: 60 },
  { key: 'summit', name: 'The summit', icon: '⛰️', range: 60 },
  { key: 'castawayCamp', name: "Castaway's camp", icon: '⛺', range: 60 },
  { key: 'bambooGrove', name: 'Bamboo grove', icon: '🎋', range: 50 },
  { key: 'meadow', name: 'Flower meadow', icon: '🌼', range: 60 },
  { key: 'riverMouth', name: 'River mouth', icon: '🌊', range: 50 },
  // v3: Tempest Isle (range is added to the landmark's r: the isle itself is found ~250 m off its coast)
  { key: 'isle2', name: 'Tempest Isle', icon: '🏝️', range: 250 },
  { key: 'isle2Dock', name: "The fisherman's dock", icon: '🛥️', range: 70 },
  { key: 'isle2Hut', name: "The fisherman's hut", icon: '🛖', range: 45 },
  { key: 'isle2Pond', name: 'Rain Pool', icon: '💧', range: 50 },
];

export const STRUCTURE_ICON = { campfire: '🔥', signal_fire: '💨', sos: '🆘', shelter: '🏕️', paddle_raft: '🛶' };
