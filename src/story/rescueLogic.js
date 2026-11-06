// Pure rescue math (Builder F): search schedule, vehicle routes, the attention model and the
// "you were missed" hints. No THREE, no DOM, no ctx: everything is plain numbers so it can be
// unit-tested with node (tests/rescue.test.mjs) and reused by rescue.js every frame without
// allocations (routes are built once per pass; per-frame calls only return numbers).
//
// Coordinates: x/z on the ground plane (north = -Z, east = +X). Math angles below are
// atan2(z, x) around the island center; compass bearings (bearingName) use 0 = north.
import { clamp, clamp01, lerp } from '../core/util.js';

const TAU = Math.PI * 2;

// ── Tunables of the attention model (CONFIG.rescue only holds the schedule + threshold) ──
export const K = {
  player: 3.5, // attention points / s for a visible player at close range (before multipliers)
  strongRange: 150, // m: inside this the player is clearly visible
  weakRange: 350, // m: visibility fades to zero here
  signal: 7, // scale on (1 - d/strength) * weight for ctx.signals entries
  waveMul: 3, // holding G
  exposedMul: 1.5, // standing on a beach or the summit plateau
  blessMul: 1.1, // golden butterfly blessing (ctx.flags.blessed)
  nightSeeing: 0.25, // how well a dark, unlit figure is seen at night (x daylight lerp)
  spotlightSeeing: 1.25, // caught in the helicopter's searchlight at night
  shelterMul: 0.5, // under a lean-to roof
  boatVantage: 0.7, // a boat crew sees people on shore less well (low vantage point, spray)
  decay: 0.8, // attention lost per second while nothing is visible
  flareRange: 700, // m: a burning flare within this distance of the vehicle = instant spot
};

/** Visibility weights of signal kinds (SPEC §6 F). Flares are handled separately (instant spot). */
export const SIGNAL_WEIGHT = { signal_fire: 3, sos: 2, campfire: 1.2, torch: 0.8 };

/** Per-method keys used for the win screen (ui/hud-data.js RESCUE_METHOD). */
export const METHODS = ['waving', 'visible', 'signal_fire', 'sos', 'campfire', 'torch', 'flare'];

// ── Schedule ─────────────────────────────────────────────────────────────
/**
 * The i-th pass of the search: scripted entries of CONFIG.rescue.passes first, then a pass every
 * repeatEveryHours with closeness 1, alternating helicopter / boat.
 * Returns { index, kind, at (absolute game hours), closeness, scripted }.
 */
export function passDef(i, R) {
  const list = R.passes || [];
  if (i < list.length) {
    const p = list[i];
    return { index: i, kind: p.kind === 'boat' ? 'boat' : 'helicopter', at: p.at, closeness: clamp01(p.closeness ?? 0.5), scripted: true };
  }
  const rep = Math.max(0.5, R.repeatEveryHours || 7);
  const last = list.length ? list[list.length - 1] : { kind: 'boat', at: 0 };
  const k = i - list.length + 1; // 1, 2, 3...
  const other = last.kind === 'boat' ? 'helicopter' : 'boat';
  return { index: i, kind: k % 2 === 1 ? other : last.kind === 'boat' ? 'boat' : 'helicopter', at: last.at + k * rep, closeness: 1, scripted: false };
}

/** Index of the first pass that starts strictly after `hours`. */
export function firstPassIndexAfter(hours, R) {
  const list = R.passes || [];
  let i = 0;
  while (i < list.length && list[i].at <= hours) i++;
  if (i < list.length) return i;
  const rep = Math.max(0.5, R.repeatEveryHours || 7);
  const lastAt = list.length ? list[list.length - 1].at : 0;
  // jump straight into the repeat section, then fix rounding
  i = list.length + Math.max(0, Math.floor((hours - lastAt) / rep) - 1);
  while (passDef(i, R).at <= hours) i++;
  return i;
}

/** All passes whose start lies in (from, to]: the ones a sleeper misses. */
export function passesBetween(from, to, R) {
  const out = [];
  for (let i = firstPassIndexAfter(from, R); out.length < 64; i++) {
    const p = passDef(i, R);
    if (p.at > to) break;
    out.push(p);
  }
  return out;
}

/** Real-time duration (s) of a pass: 70..110, closer passes linger a bit longer. */
export function passDuration(closeness, rand = 0.5) {
  return clamp(72 + 34 * clamp01(closeness) + (rand - 0.5) * 8, 70, 110);
}
/** Target closest distance (m) between the route and the player at pass start. */
export function closestApproach(closeness, rand = 0.5) {
  return lerp(450, 30, clamp01(closeness)) * (0.85 + 0.3 * rand);
}
/** Cruise altitude above the ground (m) of the helicopter. */
export function heliAltitude(closeness) {
  return lerp(90, 60, clamp01(closeness));
}
/** Offshore distance (m) of the search boat's coastal sweep. */
export function boatOffshore(closeness, rand = 0.5) {
  return lerp(250, 120, clamp01(closeness)) * (0.9 + 0.2 * rand);
}

// ── Paths (Catmull-Rom through waypoints, sampled by arc length) ─────────
/** pts: [{x, z}] -> { x, z, cum (Float64Arrays), n, length }. */
export function makePath(pts, samplesPerSeg = 10) {
  const m = pts.length;
  if (m < 2) {
    const p = pts[0] || { x: 0, z: 0 };
    return { x: Float64Array.of(p.x, p.x), z: Float64Array.of(p.z, p.z), cum: Float64Array.of(0, 0), n: 2, length: 0 };
  }
  const n = (m - 1) * samplesPerSeg + 1;
  const x = new Float64Array(n), z = new Float64Array(n), cum = new Float64Array(n);
  let k = 0;
  for (let s = 0; s < m - 1; s++) {
    const p0 = pts[Math.max(0, s - 1)], p1 = pts[s], p2 = pts[s + 1], p3 = pts[Math.min(m - 1, s + 2)];
    for (let j = 0; j < samplesPerSeg; j++) {
      const t = j / samplesPerSeg;
      x[k] = catmull(p0.x, p1.x, p2.x, p3.x, t);
      z[k] = catmull(p0.z, p1.z, p2.z, p3.z, t);
      k++;
    }
  }
  x[k] = pts[m - 1].x;
  z[k] = pts[m - 1].z;
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  return { x, z, cum, n, length: cum[n - 1] };
}
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Position + unit tangent at fraction u (0..1) of the path's length. Writes into out {x, z, dx, dz}. */
export function samplePath(path, u, out) {
  const L = path.length;
  const s = clamp(u, 0, 1) * L;
  const cum = path.cum;
  let lo = 0, hi = path.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const t = seg > 1e-9 ? (s - cum[lo]) / seg : 0;
  const dx = path.x[hi] - path.x[lo], dz = path.z[hi] - path.z[lo];
  out.x = path.x[lo] + dx * t;
  out.z = path.z[lo] + dz * t;
  const l = Math.hypot(dx, dz) || 1;
  out.dx = dx / l;
  out.dz = dz / l;
  return out;
}

/** Minimum horizontal distance from (px, pz) to the path (used by tests and the miss hint). */
export function pathClosest(path, px, pz) {
  let best = Infinity;
  for (let i = 0; i < path.n; i++) best = Math.min(best, Math.hypot(path.x[i] - px, path.z[i] - pz));
  return best;
}

// ── Routes ───────────────────────────────────────────────────────────────
/**
 * Helicopter route for a pass. Low closeness: a straight-ish crossing whose closest approach to
 * the player is closestApproach(c). High closeness (>= 0.6): it comes in on a tangent, circles the
 * island through the player's bearing at that same distance, then leaves.
 * Returns { pts: [{x,z}], alt, circling, closest }.
 */
export function heliRoute(rand, c, px, pz) {
  const d = closestApproach(c, rand());
  const alt = heliAltitude(c);
  const pts = [];
  if (c < 0.6) {
    const th = rand() * TAU;
    const ux = Math.cos(th), uz = Math.sin(th);
    const s = rand() < 0.5 ? -1 : 1;
    const nx = -uz * s, nz = ux * s; // unit normal pointing from the player toward the line
    const qx = px + nx * d, qz = pz + nz * d;
    const L = 1300;
    const bend = 80 + rand() * 180; // the line curves away from the player toward both ends
    for (let k = -3; k <= 3; k++) {
      const t = (k / 3) * L;
      const off = bend * (k / 3) * (k / 3);
      pts.push({ x: qx + ux * t + nx * off, z: qz + uz * t + nz * off });
    }
    return { pts, alt, circling: false, closest: d };
  }
  const p = Math.hypot(px, pz);
  const r = p + d <= 560 ? p + d : Math.max(140, p - d);
  const phi = Math.atan2(pz, px);
  const S = lerp(3.6, 5.2, clamp01((c - 0.6) / 0.4)); // swept angle (206..298 deg)
  const dir = rand() < 0.5 ? 1 : -1;
  const a0 = phi - dir * S * (0.3 + 0.4 * rand());
  const N = Math.max(8, Math.ceil(S / 0.25));
  const tan0x = -Math.sin(a0) * dir, tan0z = Math.cos(a0) * dir;
  const sx = Math.cos(a0) * r, sz = Math.sin(a0) * r;
  pts.push({ x: sx - tan0x * 700, z: sz - tan0z * 700 }, { x: sx - tan0x * 320, z: sz - tan0z * 320 });
  for (let k = 0; k <= N; k++) {
    const a = a0 + (dir * S * k) / N;
    pts.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  const a1 = a0 + dir * S;
  const tan1x = -Math.sin(a1) * dir, tan1z = Math.cos(a1) * dir;
  const ex = Math.cos(a1) * r, ez = Math.sin(a1) * r;
  pts.push({ x: ex + tan1x * 320, z: ez + tan1z * 320 }, { x: ex + tan1x * 700, z: ez + tan1z * 700 });
  return { pts, alt, circling: true, closest: Math.abs(r - p), radius: r };
}

/**
 * Search boat route: a sweep 120..250 m off the coast along part of the shore (a wider arc and a
 * tighter line for higher closeness, centered closer to the player's side of the island).
 * coastR(angle) = coastline radius along that math angle (see buildCoastTable).
 */
export function boatRoute(rand, c, px, pz, coastR) {
  const off = boatOffshore(c, rand());
  const phi = Math.atan2(pz, px);
  const center = phi + (rand() - 0.5) * 2.2 * (1 - clamp01(c));
  const S = lerp(1.9, 2.8, clamp01(c));
  const dir = rand() < 0.5 ? 1 : -1;
  const a0 = center - (dir * S) / 2;
  const N = Math.max(10, Math.ceil(S / 0.1));
  const arc = [];
  for (let k = 0; k <= N; k++) {
    const a = a0 + (dir * S * k) / N;
    const r = coastR(a) + off;
    arc.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  const t0 = unit(arc[1].x - arc[0].x, arc[1].z - arc[0].z);
  const t1 = unit(arc[N].x - arc[N - 1].x, arc[N].z - arc[N - 1].z);
  const pts = [
    { x: arc[0].x - t0.x * 350, z: arc[0].z - t0.z * 350 },
    { x: arc[0].x - t0.x * 160, z: arc[0].z - t0.z * 160 },
    ...arc,
    { x: arc[N].x + t1.x * 160, z: arc[N].z + t1.z * 160 },
    { x: arc[N].x + t1.x * 350, z: arc[N].z + t1.z * 350 },
  ];
  return { pts, offshore: off };
}
function unit(x, z) {
  const l = Math.hypot(x, z) || 1;
  return { x: x / l, z: z / l };
}

/**
 * Coastline radius table: sample(angle) -> radius where the sea starts along that direction.
 * A max-filter over +-`spread` samples keeps boat routes clear of headlands and bays.
 */
export function buildCoastTable(sample, n = 72, spread = 3) {
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = sample((i / n) * TAU);
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = -spread; k <= spread; k++) m = Math.max(m, raw[(i + k + n) % n]);
    t[i] = m;
  }
  return t;
}
/** Interpolated lookup into a buildCoastTable() result. */
export function coastRadiusAt(table, angle) {
  const n = table.length;
  const f = ((((angle / TAU) % 1) + 1) % 1) * n;
  const i = Math.floor(f) % n, j = (i + 1) % n;
  return lerp(table[i], table[j], f - Math.floor(f));
}

// ── Attention ────────────────────────────────────────────────────────────
/** 0..1 how well a person in the open is seen at distance d (strong < 150 m, weak to 350 m). */
export function visibilityFalloff(d) {
  if (!(d >= 0)) return 0;
  if (d <= K.strongRange) return 1 - 0.4 * (d / K.strongRange);
  if (d >= K.weakRange) return 0;
  const t = (K.weakRange - d) / (K.weakRange - K.strongRange);
  return 0.6 * t * t;
}

/**
 * Attention points / s from the player's own figure.
 * p: { d (m, 3D to the vehicle), open, exposed (beach/summit), waving, underwater, daylight 0..1,
 *      inSpotlight, sheltered, fromBoat, vis (0..1 weather visibility, default 1) }
 */
export function playerContribution(p) {
  if (p.underwater || !p.open) return 0;
  const f = visibilityFalloff(p.d);
  if (f <= 0) return 0;
  let r = K.player * f;
  if (p.waving) r *= K.waveMul;
  if (p.exposed) r *= K.exposedMul;
  const seeing = Math.max(lerp(K.nightSeeing, 1, clamp01(p.daylight ?? 1)), p.inSpotlight ? K.spotlightSeeing : 0);
  r *= seeing;
  if (p.sheltered) r *= K.shelterMul;
  if (p.fromBoat) r *= K.boatVantage;
  if (p.vis !== undefined) r *= clamp01(p.vis);
  return r;
}

/** Attention points / s from one active ctx.signals entry at distance d from the vehicle. */
export function signalContribution(kind, d, strength) {
  const w = SIGNAL_WEIGHT[kind];
  if (!w || !(strength > 0) || !(d < strength)) return 0;
  return (1 - d / strength) * w * K.signal;
}

/**
 * Total attention rate. signals: [{ kind, d, strength }] (active ones only). parts (optional, reused
 * object) receives the per-method rates so the caller can tell what got the player noticed.
 */
export function attentionRate(player, signals, blessed = false, parts = null) {
  if (parts) for (const k of METHODS) parts[k] = 0;
  let total = 0;
  const pr = playerContribution(player);
  total += pr;
  if (parts && pr > 0) parts[player.waving ? 'waving' : 'visible'] += pr;
  if (signals) {
    for (let i = 0; i < signals.length; i++) {
      const s = signals[i];
      const r = signalContribution(s.kind, s.d, s.strength);
      if (r <= 0) continue;
      total += r;
      if (parts) parts[s.kind] += r;
    }
  }
  if (blessed) {
    total *= K.blessMul;
    if (parts) for (const k of METHODS) parts[k] *= K.blessMul;
  }
  return total;
}

/** Integrate attention over dt: grows with the rate, slowly fades when nothing is seen. */
export function stepAttention(att, rate, dt) {
  return rate > 0 ? att + rate * dt : Math.max(0, att - K.decay * dt);
}

/**
 * Search behaviour: once the crew half-notices something they slow down to look closer
 * (1 = cruise, down to 0.45 when attention nears the threshold). Applied to the route speed.
 */
export function speedFactor(att, threshold = 100) {
  const a = clamp01(att / threshold);
  const t = clamp01((a - 0.25) / 0.45);
  return 1 - 0.55 * t * t * (3 - 2 * t);
}

/** A burning flare spots the player when the vehicle is within K.flareRange. */
export function flareSpots(dVehicle) {
  return dVehicle <= K.flareRange;
}

/** Method key with the largest accumulated contribution (default 'visible'). */
export function dominantMethod(totals) {
  let best = 'visible', bv = 0;
  for (const k of METHODS) {
    const v = totals?.[k] || 0;
    if (v > bv) {
      bv = v;
      best = k;
    }
  }
  return best;
}

// ── Messages ─────────────────────────────────────────────────────────────
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** Compass name of the direction (dx, dz) (north = -Z, east = +X). */
export function bearingName(dx, dz) {
  const a = Math.atan2(dx, -dz); // 0 = north, +PI/2 = east
  const i = Math.round(((a / TAU) * 8 + 8) % 8) % 8;
  return COMPASS[i];
}

/**
 * The toast shown when a pass leaves without seeing the player: the most useful next step.
 * s: { kind, night, wasOpen, waved, hadSignalFire, hadNightLight, hasFlare, maxAttention, threshold, closest }
 */
export function missHint(s) {
  const who = s.kind === 'boat' ? 'The boat sailed away' : 'The helicopter flew off';
  const thr = s.threshold || 100;
  if (s.maxAttention >= thr * 0.5) return `${who}… So close! They almost saw you. Keep signaling: the next pass will come closer.`;
  if (s.hasFlare && s.closest < K.flareRange) return `${who}… They were within flare range! Select your flare and press F when they're close.`;
  if (!s.wasOpen) return `${who}… They couldn't see you under the trees. Get into the open: beaches and the summit are best.`;
  if (s.night && !s.hadNightLight) return `${who}… At night they only see light: a campfire, a torch, or better, a signal fire.`;
  if (!s.hadSignalFire) return `${who}… They didn't see you. A signal fire's smoke is visible for miles.`;
  if (!s.waved) return `${who}… Hold G to wave your arms when they pass: it triples your chances.`;
  return `${who}… They passed too far away. Keep your signal fire burning for the next pass.`;
}

/** Toast on waking when passes were slept through. */
export function sleptThroughText(kinds) {
  const heli = kinds.includes('helicopter'), boat = kinds.includes('boat');
  if (heli && boat) return 'You slept through the sound of a helicopter… and a boat engine. Stay awake when they might come.';
  if (boat) return 'You slept through the drone of a boat engine… They were searching for you.';
  return 'You slept through the sound of a helicopter… They were searching for you.';
}
