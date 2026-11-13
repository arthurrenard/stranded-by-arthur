// Pure boat-repair logic (Builder V2-B). No THREE, no DOM: unit-tested by tests/raft.test.mjs.
// A plan (CONFIG.raft.plans[id]) is an ordered list of stages; each stage `needs` { itemId: n } and takes
// `hours` of game time at the Boatyard. Parts are scattered in the world (CONFIG.raft.parts).

/** Which plan a difficulty uses ('raft' fallback). */
export function planIdFor(difficulty, raftCfg) {
  const id = difficulty?.plan;
  return raftCfg?.plans?.[id] ? id : 'raft';
}

const planCache = new Map();
/** CONFIG.raft.plans[id] with its id attached (memoized per config object + id). */
export function resolvePlan(raftCfg, planId) {
  const id = raftCfg?.plans?.[planId] ? planId : 'raft';
  const src = raftCfg?.plans?.[id];
  if (!src) return { id, name: 'Boat', stages: [] };
  let hit = planCache.get(src);
  if (!hit) {
    hit = { ...src, id, stages: src.stages || [] };
    planCache.set(src, hit);
  }
  return hit;
}

/** [{ id, need }] for a stage, in declaration order. */
export function stageNeeds(stage) {
  const out = [];
  if (!stage?.needs) return out;
  for (const id in stage.needs) out.push({ id, need: stage.needs[id] });
  return out;
}

/** [{ id, have, need }] using countFn(id) -> number. `out` (optional) is reused. */
export function needsStatus(stage, countFn, out = []) {
  out.length = 0;
  if (!stage?.needs) return out;
  for (const id in stage.needs) {
    const need = stage.needs[id];
    const have = Math.max(0, Math.floor(+countFn(id) || 0));
    out.push({ id, have, need });
  }
  return out;
}

export const isReady = (status) => status.every((s) => s.have >= s.need);
export const missingOf = (status) => status.filter((s) => s.have < s.need);

/** Remove a stage's needs through removeFn(id, n) -> bool. Returns false (and removes nothing) if short. */
export function consumeStage(stage, countFn, removeFn) {
  const status = needsStatus(stage, countFn);
  if (!isReady(status)) return false;
  for (const s of status) removeFn(s.id, s.need);
  return true;
}

/** Sum of every stage's needs from `fromStage` on: { id: n }. */
export function remainingNeeds(plan, fromStage = 0) {
  const out = {};
  const st = plan?.stages || [];
  for (let i = Math.max(0, fromStage); i < st.length; i++) {
    for (const id in st[i].needs || {}) out[id] = (out[id] || 0) + st[i].needs[id];
  }
  return out;
}

/** v3: parts that are not scattered on the main island but kept in Tempest Isle's fishing hut (ctx.isle2 gives them). */
export const isHutPart = (p) => p?.where === 'isle2hut';

/** The parts placed in the world for a plan: [{ id, where }] (sailcloth bundles included, as 'beach').
 *  v3: 'isle2hut' parts are listed too (they count toward the supply) but raft.js does not place them. */
export function partList(raftCfg, planId) {
  const out = [];
  const parts = raftCfg?.parts || {};
  for (const id in parts) {
    const n = parts[id].count?.[planId] || 0;
    for (let k = 0; k < n; k++) out.push({ id, where: parts[id].where });
  }
  const cloth = raftCfg?.extraSailcloth?.[planId] || 0;
  for (let k = 0; k < cloth; k++) out.push({ id: 'cloth', where: 'beach' });
  return out;
}

/** { id: count } of placed world parts for a plan. */
export function partCounts(raftCfg, planId) {
  const out = {};
  for (const p of partList(raftCfg, planId)) out[p.id] = (out[p.id] || 0) + 1;
  return out;
}

/** Game hours when building and launching are allowed (05:00–20:00). */
export const isWorkHour = (hour) => hour >= 5 && hour < 20;

/** "1.5 h" / "45 min" */
export function fmtHours(h) {
  if (!(h > 0)) return '0 min';
  if (h < 1) return `${Math.round(h * 60)} min`;
  return `${Math.round(h * 100) / 100} h`;
}

/** Need drains for `hours` of hard work (×1.5 the idle rate), as stats.applyEffects deltas. */
export function buildDrain(hours, statsCfg, difficulty) {
  const th = (statsCfg?.thirstPerHour ?? 4) * (difficulty?.thirstMul || 1);
  const hu = (statsCfg?.hungerPerHour ?? 4) * (difficulty?.hungerMul || 1);
  return {
    thirst: -hours * th * 1.5,
    hunger: -hours * hu * 1.5,
    energy: -hours * 12,
  };
}

/** Where to look for an item (shown in the objective tracker). info: { hasShovel, hasPickaxe, hasMask, hasFlint, where } */
export function hintFor(id, info = {}) {
  const where = info.where;
  if (id === 'hull_plank') return 'Planks wash up on beaches all around the island';
  if (id === 'mast_pole') return 'A long spar washed up on a beach somewhere along the coast';
  if (id === 'rope') return 'Rope: craft from 4 plant fiber';
  if (id === 'cloth') return 'Sailcloth: search the crates and the beaches';
  if (id === 'bottle_water') return 'Water: fill a canteen at a lake or river';
  if (id === 'wood') return 'Wood: pick up sticks and fallen branches, or gather a fallen tree (a creaking tree may fall nearby)';
  if (id === 'bamboo') return info.hasFlint
    ? 'Bamboo: cut canes in the grove by the river'
    : 'Bamboo: the grove by the river (you need flint to cut it)';
  if (where === 'buried') {
    if (!info.hasShovel) return 'Something is buried in the sand: craft a shovel';
    if (id === 'compass') return 'Dig at the sand mound with a cross of sticks near the castaway camp (north beach)';
    return 'Dig at the sand mounds marked with a cross of sticks on the far beaches';
  }
  if (where === 'rock') {
    if (!info.hasPickaxe) return 'Something glints inside a cracked rock: craft a pickaxe';
    return 'Break open the glinting cracked rock on the rocky high ground';
  }
  if (where === 'isle2hut') {
    return "The fisherman's hut on Tempest Isle may have one: build a paddle raft and cross from the north-east beach";
  }
  if (where === 'underwater') {
    return info.hasMask
      ? 'It sank near the wreck: swim out and dive with X'
      : 'It sank near the wreck: swim out and dive with X (a diving mask helps)';
  }
  return 'Search the island';
}

/** One-line story text for the first find of a part. */
export const FIRST_FIND = {
  hull_plank: 'A curved plank from the Marguerite. The boat will need several of these.',
  mast_pole: 'A long, straight spar: this will make a mast.',
  cloth: 'A bundle of sailcloth, washed ashore. Enough of it and you can rig a sail.',
  rudder: 'The Marguerite’s rudder blade! You can steer with this.',
  compass: 'A brass compass, still pointing north. Now you can find your way home.',
  fuel_can: 'A sealed jerrycan of petrol, heavy and sloshing.',
  spark_plug: 'A tin of spare spark plugs, dry inside. The outboard will need them.',
  engine_block: 'The tender’s outboard motor, dragged up from the seabed.',
  propeller: 'A bronze propeller, a little bent but whole.',
};

/** "Wood 4/10 · Rope 0/2" for the missing needs. nameFn(id) -> display name. */
export function missingText(status, nameFn = (id) => id) {
  return missingOf(status)
    .map((s) => `${nameFn(s.id)} ${s.have}/${s.need}`)
    .join(' · ');
}
