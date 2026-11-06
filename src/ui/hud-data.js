// Static text for the HUD: survival tips, plant notes, death causes, rescue methods.
// Pure data + tiny formatting helpers (no DOM), so it can be unit-tested in node.

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
  { icon: '🌿', title: 'Healing', text: 'Aloe, yarrow and chamomile restore health. Brew yarrow and chamomile with a full canteen at a fire to make a strong herbal tea.' },
];

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
  starvation: { text: 'You starved', icon: '🍃', tip: 'Gather berries, apples, chestnuts and coconuts, and cook them for two to three times the food.' },
  hypothermia: { text: 'You froze to death', icon: '🥶', tip: 'Dry off in the sun, stay by a campfire at night, and use a lean-to against the rain.' },
  heatstroke: { text: 'You collapsed from heatstroke', icon: '🥵', tip: 'Rest in tree shade during the hot afternoon and keep drinking.' },
  drowning: { text: 'You drowned', icon: '🌊', tip: 'Swimming drains energy. When you are exhausted, get back to shore before you sink.' },
  poison: { text: 'You were poisoned', icon: '☠️', tip: 'Red toadstools with white spots are deadly. Only eat golden chanterelles, and cook them.' },
  falling: { text: 'You fell to your death', icon: '🪨', tip: 'Watch your step on the cliffs near the summit.' },
  tree: { text: 'A falling tree crushed you', icon: '🌲', tip: 'When you hear a tree creak, run away from it.' },
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
};

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

/** Compact effect summary for toasts: { hunger: 22, thirst: 2 } -> "+22 🍃 +2 💧". */
const EFFECT_ICON = { health: '❤️', thirst: '💧', hunger: '🍃', energy: '⚡', heat: '🌡️', wetness: '💦', poison: '☠️', nausea: '🤢' };
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
];

export const STRUCTURE_ICON = { campfire: '🔥', signal_fire: '💨', sos: '🆘', shelter: '🏕️' };
