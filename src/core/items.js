// Item registry: the single source of truth for item ids, names, icons and effects.
// The player is vegetarian: every food is a plant, nut, fruit, fungus or root.
//
// effects (applied by ctx.stats.applyEffects): { health, thirst, hunger, energy, heat, wetness,
//   poison (total damage dealt over ~20 s), nausea (seconds of queasy vision + small thirst loss) }
// cooksInto: item id produced by cooking at a fire (cooked food is ~2-3x more nourishing).
// returns: item id given back after consuming (e.g. the empty canteen after drinking).

export const ITEMS = {
  // ── Resources ───────────────────────────────────────────────────────────
  wood: { name: 'Wood', icon: '🪵', category: 'resource', desc: 'Dry branches and sticks. Fuel and building material.' },
  stone: { name: 'Stone', icon: '🪨', category: 'resource', desc: 'A fist-sized stone. Good for fire rings and SOS signs.' },
  flint: {
    name: 'Flint',
    icon: '🔹',
    category: 'tool',
    desc: 'Glassy dark stone with a sharp edge. Strike it against pyrite to make sparks. Also cuts bamboo.',
  },
  pyrite: {
    name: 'Pyrite',
    icon: '🪙',
    category: 'tool',
    desc: '"Fool\'s gold". Brassy, heavy, and it throws sparks when struck with flint.',
  },
  fiber: { name: 'Plant Fiber', icon: '🧵', category: 'resource', desc: 'Stripped from tall grass. Twist it into cord.' },
  leaves: { name: 'Green Leaves', icon: '🍃', category: 'resource', desc: 'Fresh leaves. Thatch for shelters, and thick white smoke on a fire.' },
  bamboo: { name: 'Bamboo', icon: '🎋', category: 'resource', desc: 'A hollow bamboo cane. A natural water container.' },
  rope: { name: 'Rope', icon: '🪢', category: 'resource', desc: 'Strong cord. Lashes structures together.' },
  cloth: { name: 'Sailcloth', icon: '🏳️', category: 'resource', desc: 'A torn strip of sail from the wreck. Burns well on a torch.' },

  // ── Water ───────────────────────────────────────────────────────────────
  bottle_empty: {
    name: 'Bamboo Canteen (empty)',
    icon: '🫙',
    category: 'tool',
    desc: 'Fill it at a river or lake (stand by the water and press R).',
  },
  bottle_water: {
    name: 'Bamboo Canteen (water)',
    icon: '🫗',
    category: 'drink',
    desc: 'Fresh water for the road.',
    effects: { thirst: 32 },
    returns: 'bottle_empty',
  },

  // ── Food (raw) ──────────────────────────────────────────────────────────
  berries: { name: 'Wild Blackberries', icon: '🫐', category: 'food', desc: 'Sweet and juicy.', effects: { hunger: 8, thirst: 3 } },
  wild_apple: {
    name: 'Wild Apple',
    icon: '🍏',
    category: 'food',
    desc: 'Tart crab apple. Better baked.',
    effects: { hunger: 10, thirst: 5 },
    cooksInto: 'baked_apple',
  },
  chanterelle: {
    name: 'Chanterelle',
    icon: '🍄‍🟫',
    category: 'food',
    desc: 'Golden, funnel-shaped, smells of apricot. Edible, but raw it upsets the stomach. Cook it!',
    effects: { hunger: 5, health: -3 },
    cooksInto: 'grilled_mushroom',
  },
  toadstool: {
    name: 'Red Toadstool',
    icon: '🍄',
    category: 'food',
    desc: 'Red cap with white spots. Poisonous! Cooking will not make it safe.',
    effects: { hunger: 2, poison: 30, nausea: 25 },
  },
  wild_root: {
    name: 'Wild Yam Root',
    icon: '🥔',
    category: 'food',
    desc: 'Starchy and bitter raw. Bakes into a filling meal.',
    effects: { hunger: 6, nausea: 6 },
    cooksInto: 'baked_root',
  },
  chestnut: {
    name: 'Sweet Chestnut',
    icon: '🌰',
    category: 'food',
    desc: 'Found under chestnut trees. Roast them!',
    effects: { hunger: 5 },
    cooksInto: 'roasted_chestnut',
  },
  coconut: {
    name: 'Coconut',
    icon: '🥥',
    category: 'food',
    desc: 'Fallen from a palm. Coconut water and flesh.',
    effects: { hunger: 10, thirst: 22 },
  },
  cattail: {
    name: 'Cattail Root',
    icon: '🌾',
    category: 'food',
    desc: 'Grows at the water\'s edge. The root is edible, better roasted.',
    effects: { hunger: 5, thirst: 2 },
    cooksInto: 'roasted_cattail',
  },
  nettle: {
    name: 'Stinging Nettle',
    icon: '🌿',
    category: 'food',
    desc: 'Stings raw. Boiled into soup (with a full canteen at a fire) it is nourishing.',
    effects: { hunger: 3, health: -2 },
  },

  // ── Food (cooked) ───────────────────────────────────────────────────────
  baked_apple: { name: 'Baked Apple', icon: '🍎', category: 'food', desc: 'Soft, sweet, warm.', effects: { hunger: 22, thirst: 2, heat: 4 } },
  grilled_mushroom: {
    name: 'Grilled Chanterelles',
    icon: '🍢',
    category: 'food',
    desc: 'Smoky and delicious.',
    effects: { hunger: 20, health: 3 },
  },
  baked_root: { name: 'Baked Yam', icon: '🍠', category: 'food', desc: 'Hearty and filling.', effects: { hunger: 32, energy: 12 } },
  roasted_chestnut: {
    name: 'Roasted Chestnuts',
    icon: '🥜',
    category: 'food',
    desc: 'Warm and nutty.',
    effects: { hunger: 15, heat: 3 },
  },
  roasted_cattail: { name: 'Roasted Cattail', icon: '🌽', category: 'food', desc: 'Like a woody potato.', effects: { hunger: 16 } },
  nettle_soup: {
    name: 'Nettle Soup',
    icon: '🍲',
    category: 'food',
    desc: 'Green, warm, surprisingly good.',
    effects: { hunger: 22, thirst: 15, health: 6, heat: 10 },
    returns: 'bottle_empty',
  },

  // ── Medicine ────────────────────────────────────────────────────────────
  aloe: { name: 'Aloe Leaf', icon: '🪴', category: 'medicine', desc: 'Soothing gel. Restores health.', effects: { health: 12 } },
  yarrow: {
    name: 'Yarrow',
    icon: '🌼',
    category: 'medicine',
    desc: 'Feathery leaves, white flower clusters. Old wound herb.',
    effects: { health: 18 },
  },
  chamomile: {
    name: 'Chamomile',
    icon: '🌸',
    category: 'medicine',
    desc: 'Little daisy-like flowers. Calming.',
    effects: { health: 5, energy: 10 },
  },
  herbal_tea: {
    name: 'Herbal Tea',
    icon: '🍵',
    category: 'medicine',
    desc: 'Yarrow and chamomile steeped in hot water. Heals and warms.',
    effects: { health: 40, thirst: 20, heat: 12 },
    returns: 'bottle_empty',
  },

  // ── Tools / special ─────────────────────────────────────────────────────
  torch: { name: 'Torch', icon: '🔥', category: 'tool', desc: 'Light in the dark, a little warmth. Press T to light/stow.' },
  flare: {
    name: 'Emergency Flare',
    icon: '🧨',
    category: 'tool',
    desc: 'From the boat\'s emergency kit. Fire it (F) when the search party is near!',
  },
  shovel: {
    name: 'Wooden Shovel',
    icon: '🪏',
    category: 'tool',
    desc: 'A flat blade lashed to a pole. Digs up things buried in the sand (look for disturbed mounds).',
  },
  pickaxe: {
    name: 'Flint Pickaxe',
    icon: '⛏️',
    category: 'tool',
    desc: 'A flint head lashed to a handle. Breaks open cracked rocks where something glints inside.',
  },
  paddle: {
    name: 'Wooden Paddle',
    icon: '🛶',
    category: 'tool',
    desc: 'A carved paddle. You need one to paddle a raft (W/S to paddle, A/D to steer).',
  },
  fishing_rod: {
    name: 'Fishing Rod',
    icon: '🎣',
    category: 'tool',
    desc: 'From the fishing hut. You won\'t eat fish, but the sea gives up all kinds of lost things. Use it (F) at the water.',
  },
  boat_key: {
    name: 'Motorboat Key',
    icon: '🔑',
    category: 'tool',
    desc: 'A brass key on a cork float. It starts the fisherman\'s motorboat at the Tempest Isle dock.',
  },
  banana: { name: 'Wild Banana', icon: '🍌', category: 'food', desc: 'Sweet and filling. Grows on Tempest Isle.', effects: { hunger: 14, thirst: 4, energy: 6 } },
  old_boot: { name: 'Old Boot', icon: '🥾', category: 'resource', desc: 'Soggy, smelly and completely useless. Classic fishing catch.' },
  diving_mask: {
    name: 'Diving Mask',
    icon: '🤿',
    category: 'tool',
    desc: 'A bamboo-framed mask sealed with sailcloth. Hold your breath much longer underwater (X to dive).',
  },

  // ── Boat parts (the main goal: rebuild a vessel at the build site on the spawn beach) ──
  hull_plank: { name: 'Hull Plank', icon: '🟫', category: 'part', desc: 'A curved plank from the Marguerite\'s hull, washed up on a beach.' },
  mast_pole: { name: 'Mast Pole', icon: '🎏', category: 'part', desc: 'A long, straight spar. Perfect for a mast.' },
  rudder: { name: 'Rudder', icon: '🛞', category: 'part', desc: 'The Marguerite\'s rudder blade. It was buried by the tide.' },
  compass: { name: 'Brass Compass', icon: '🧭', category: 'part', desc: 'Still points north. You will need it to steer home.' },
  fuel_can: { name: 'Fuel Jerrycan', icon: '⛽', category: 'part', desc: 'A sealed can of petrol, half buried in the sand.' },
  spark_plug: { name: 'Spark Plugs', icon: '🔌', category: 'part', desc: 'A tin of spare spark plugs, wedged into a rock crevice.' },
  engine_block: { name: 'Outboard Engine', icon: '⚙️', category: 'part', desc: 'The tender\'s outboard motor. It sank next to the wreck.' },
  propeller: { name: 'Propeller', icon: '🌀', category: 'part', desc: 'A bronze propeller, lost on the seabed by the reef.' },
};

/** Raft/boat part ids (category 'part'). */
export const PARTS = Object.keys(ITEMS).filter((id) => ITEMS[id].category === 'part');

/** Ids of raw foods that can be cooked at a fire. */
export const COOKABLE = Object.keys(ITEMS).filter((id) => ITEMS[id].cooksInto);

export function itemName(id) {
  return ITEMS[id]?.name ?? id;
}
export function itemIcon(id) {
  return ITEMS[id]?.icon ?? '❔';
}
export function isConsumable(id) {
  const c = ITEMS[id]?.category;
  return c === 'food' || c === 'drink' || c === 'medicine';
}
