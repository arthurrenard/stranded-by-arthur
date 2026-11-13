// Deterministic placement for the boat-repair goal (Builder V2-B): boat parts around the coast,
// the Boatyard site on the spawn beach and the launch route (around the wreck's reef).
// Pure: only uses the heightfield API (ctx.world) and a seeded rng, so it is unit-testable in node.

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const hyp = Math.hypot;

const bearingOf = (x, z) => ((Math.atan2(x, -z) / D2R) % 360 + 360) % 360;
const bearingDir = (deg) => ({ x: Math.sin(deg * D2R), z: -Math.cos(deg * D2R) });

/** Dry beach sand where a part can lie. */
export function isBeachSpot(world, x, z) {
  if (world.waterAt(x, z)) return false;
  const h = world.heightAt(x, z);
  if (h < 0.6 || h > 2.5) return false;
  if (world.slopeAt(x, z) > 0.35) return false;
  return world.biomeAt(x, z).sand > 0.6;
}

/**
 * placeParts(world, rng, list, opts) -> [{ id, where, x, y, z }]
 *   list: [{ id, where: 'beach'|'buried'|'rock'|'underwater'|'isle2hut' }] (raft-logic partList; 'isle2hut' entries are skipped)
 *   opts.avoid: [{ x, z, r }] keep-out circles (crates, camp, site...), opts.blocked(x, z, r) -> bool (colliders)
 */
export function placeParts(world, rng, list, opts = {}) {
  // v3: 'isle2hut' parts (the compass) are never placed in the world: Tempest Isle's fishing hut holds them (ctx.isle2).
  list = list.filter((p) => p.where !== 'isle2hut');
  const out = placePass(world, rng, list, opts, [], opts.blocked || null, true);
  let missing = missingFrom(list, out);
  if (missing.length) {
    // colliders (palms, camp props, reef) can crowd a spot out: retry without them, keeping the spacing
    const S = world.landmarks.spawn;
    const nearDone = out.some((p) => p.id === 'hull_plank' && hyp(p.x - S.x, p.z - S.z) <= 80);
    out.push(...placePass(world, rng, missing, opts, out, null, !nearDone));
    missing = missingFrom(list, out);
  }
  for (const m of missing) {
    const p = lastResort(world, rng, m, out);
    if (p) out.push(p);
    if (typeof console !== 'undefined') console.warn('[raft] last-resort placement for', m.id, p ? 'ok' : 'FAILED');
  }
  return out;
}

/** list entries that `placed` does not cover (multiset difference by id + where). */
function missingFrom(list, placed) {
  const have = new Map();
  for (const p of placed) have.set(p.id + '|' + p.where, (have.get(p.id + '|' + p.where) || 0) + 1);
  const miss = [];
  for (const e of list) {
    const k = e.id + '|' + e.where;
    const n = have.get(k) || 0;
    if (n > 0) have.set(k, n - 1);
    else miss.push(e);
  }
  return miss;
}

/** Ignore every soft rule but the 6 m spacing (and keep underwater parts in the sea near the wreck). */
function lastResort(world, rng, m, placed) {
  const W = world.landmarks.wreck;
  const spaced = (x, z) => placed.every((t) => hyp(t.x - x, t.z - z) >= 6);
  for (let t = 0; t < 600; t++) {
    let x, z;
    if (m.where === 'underwater') {
      const a = rng() * TAU, r = 8 + rng() * 52;
      x = W.x + Math.cos(a) * r;
      z = W.z + Math.sin(a) * r;
      const w = world.waterAt(x, z);
      if (!w || w.type !== 'ocean' || w.depth < 1 || w.depth > 16) continue;
    } else {
      const p = world.randomLandPoint(rng);
      if (!p) continue;
      x = p.x;
      z = p.z;
    }
    if (spaced(x, z)) return { id: m.id, where: m.where, x, y: world.heightAt(x, z), z };
  }
  return null;
}

function placePass(world, rng, list, opts, prior, blocked, nearPlank) {
  const L = world.landmarks;
  const S = L.spawn;
  const spawnB = bearingOf(S.x, S.z);
  const taken = prior.slice();
  const avoid = (opts.avoid || []).slice();
  const out = [];
  const R = () => rng();
  const range = (a, b) => a + (b - a) * R();

  const free = (x, z, minD = 6, skipAvoidTag = null) => {
    for (const t of taken) if (hyp(t.x - x, t.z - z) < minD) return false;
    for (const a of avoid) if (a.tag !== skipAvoidTag && hyp(a.x - x, a.z - z) < a.r) return false;
    if (blocked && blocked(x, z, 0.9)) return false;
    return true;
  };
  const put = (p, id, where) => {
    const e = { id, where, x: p.x, y: p.y, z: p.z };
    taken.push(e);
    out.push(e);
    return e;
  };

  /** A dry sand point 2–6 m inland of the coast along a bearing, or null. */
  function beachAt(bearing, minInland = 2, maxInland = 6) {
    const c = world.coastPoint(((bearing % 360) + 360) % 360, 1.3);
    const d = bearingDir(c.bearing);
    const start = range(minInland, maxInland);
    for (let k = 0; k < 6; k++) {
      const inl = minInland + ((start - minInland + k * 1.3) % (maxInland - minInland + 0.001));
      const x = c.x - d.x * inl, z = c.z - d.z * inl;
      if (isBeachSpot(world, x, z) && free(x, z)) return { x, y: world.heightAt(x, z), z };
    }
    return null;
  }
  function beachAround(bearing, spread, tries = 24, minIn = 2, maxIn = 6, accept = null) {
    for (let t = 0; t < tries; t++) {
      const b = bearing + (t === 0 ? 0 : range(-spread, spread) * Math.min(1, 0.35 + t / tries));
      const p = beachAt(b, minIn, maxIn);
      if (p && (!accept || accept(p))) return p;
    }
    return null;
  }
  function anySand(accept) {
    const p = world.randomLandPoint(R, (x, z, b) => b.sand > 0.5 && !b.water && b.h > 0.4 && b.h < 3 && free(x, z) && (!accept || accept({ x, z })));
    return p ? { x: p.x, y: world.heightAt(p.x, p.z), z: p.z } : null;
  }
  const fromSpawn = (p) => hyp(p.x - S.x, p.z - S.z);

  // ── beach parts: one hull plank close to the spawn, the rest spread around the whole coast ──
  const beach = list.filter((p) => p.where === 'beach');
  const nearIdx = nearPlank ? beach.findIndex((p) => p.id === 'hull_plank') : -1;
  if (nearIdx >= 0) {
    const [first] = beach.splice(nearIdx, 1);
    let p = null;
    for (let t = 0; t < 30 && !p; t++) {
      const b = spawnB + (R() < 0.5 ? -1 : 1) * range(3, 12);
      const q = beachAt(b, 2, 6);
      if (q && fromSpawn(q) <= 80 && fromSpawn(q) >= 12) p = q;
    }
    p ??= anySand((q) => fromSpawn(q) <= 80 && fromSpawn(q) >= 10);
    if (p) put(p, first.id, 'beach');
  }
  // deterministic shuffle so planks / mast / cloth mix around the coast
  for (let i = beach.length - 1; i > 0; i--) {
    const j = Math.floor(R() * (i + 1));
    [beach[i], beach[j]] = [beach[j], beach[i]];
  }
  const GAP = 25; // keep the rest out of the spawn beach so the player explores
  const arc = 360 - 2 * GAP;
  const step = beach.length ? arc / beach.length : arc;
  beach.forEach((part, i) => {
    const b = spawnB + GAP + step * (i + 0.5) + range(-0.25, 0.25) * step;
    const far = (q) => fromSpawn(q) > 90;
    const p = beachAround(b, step * 0.45, 24, 2, 6, far) || anySand(far);
    if (p) put(p, part.id, 'beach');
  });

  // ── buried: the compass near the castaway camp, the rest on far beaches ──
  const buried = list.filter((p) => p.where === 'buried');
  const camp = L.castawayCamp;
  const ci = buried.findIndex((p) => p.id === 'compass');
  if (ci >= 0 && camp) {
    const [comp] = buried.splice(ci, 1);
    let p = null;
    for (let t = 0; t < 80 && !p; t++) {
      const a = R() * TAU, r = range(3.5, 8);
      const x = camp.x + Math.cos(a) * r, z = camp.z + Math.sin(a) * r;
      if (world.waterAt(x, z) || world.slopeAt(x, z) > 0.35 || world.heightAt(x, z) < 0.4) continue;
      if (world.biomeAt(x, z).sand < 0.4) continue;
      if (free(x, z, 6, 'camp')) p = { x, y: world.heightAt(x, z), z };
    }
    p ??= beachAround(bearingOf(camp.x, camp.z), 10, 24, 3, 8);
    if (p) put(p, comp.id, 'buried');
  }
  buried.forEach((part) => {
    let p = null;
    for (let t = 0; t < 12 && !p; t++) p = beachAround(spawnB + range(70, 290), 15, 6, 3, 8, (q) => fromSpawn(q) > 150);
    p ??= anySand((q) => fromSpawn(q) > 120);
    if (p) put(p, part.id, 'buried');
  });

  // ── rock: a cracked boulder on rocky / highland ground, away from the spawn ──
  list.filter((p) => p.where === 'rock').forEach((part) => {
    const filters = [
      (x, z, b) => b.rock > 0.45 && b.slope < 0.5 && !b.water && b.h > 2.5 && hyp(x - S.x, z - S.z) > 100 && free(x, z),
      (x, z, b) => (b.rock > 0.25 || b.highland > 0.4) && b.slope < 0.55 && !b.water && b.h > 1.5 && hyp(x - S.x, z - S.z) > 80 && free(x, z),
      (x, z, b) => !b.water && b.h > 1 && b.slope < 0.5 && hyp(x - S.x, z - S.z) > 60 && free(x, z),
    ];
    let p = null;
    for (const f of filters) {
      for (let t = 0; t < 6 && !p; t++) p = world.randomLandPoint(R, f);
      if (p) break;
    }
    if (p) put({ x: p.x, y: world.heightAt(p.x, p.z), z: p.z }, part.id, 'rock');
  });

  // ── underwater: seabed 3–8 m deep within ~45 m of the wreck (clear of the hull and reef) ──
  const W = L.wreck;
  list.filter((p) => p.where === 'underwater').forEach((part) => {
    const bands = [[4.5, 8.5, 12], [3.5, 10, 10], [2.5, 14, 8]]; // deep enough that you must dive (X) to reach them
    let p = null;
    for (const [d0, d1, rMin] of bands) {
      for (let t = 0; t < 300 && !p; t++) {
        const a = R() * TAU, r = range(rMin, 45);
        const x = W.x + Math.cos(a) * r, z = W.z + Math.sin(a) * r;
        const w = world.waterAt(x, z);
        if (!w || w.type !== 'ocean' || w.depth < d0 || w.depth > d1) continue;
        if (!free(x, z, 8)) continue;
        p = { x, y: world.heightAt(x, z), z };
      }
      if (p) break;
    }
    if (p) put(p, part.id, 'underwater');
  });

  return out;
}

/**
 * The Boatyard: dry, flat sand 6–10 m seaward of the spawn.
 * -> { x, y, z, dirX, dirZ (unit, seaward), yaw (rotation.y so local +Z points seaward) }
 */
export function findSite(world) {
  const S = world.landmarks.spawn;
  const len = hyp(S.x, S.z) || 1;
  const dx = S.x / len, dz = S.z / len;
  const lx = -dz, lz = dx;
  const make = (x, z) => ({ x, y: world.heightAt(x, z), z, dirX: dx, dirZ: dz, yaw: Math.atan2(dx, dz) });
  for (const d of [8, 7, 9, 6, 10]) {
    for (const lat of [0, 2.5, -2.5, 5, -5]) {
      const x = S.x + dx * d + lx * lat, z = S.z + dz * d + lz * lat;
      if (world.waterAt(x, z) || world.heightAt(x, z) < 0.25 || world.slopeAt(x, z) > 0.15) continue;
      // the stern (inland) and bow (seaward) ends should be dry as well
      const bx = x + dx * 3.2, bz = z + dz * 3.2, sx = x - dx * 3.2, sz = z - dz * 3.2;
      if ((world.waterAt(bx, bz)?.depth ?? 0) > 0.3 || world.waterAt(sx, sz)) continue;
      return make(x, z);
    }
  }
  return make(S.x + dx * 6, S.z + dz * 6);
}

/** Fill `out` (Float32Array, stride 3: x, z, heading) with the launch route at `step` m intervals. */
export function buildPath(site, turn, out, step = 0.5, runOut = 10, turnLen = 16) {
  const n = Math.floor(out.length / 3);
  const h0 = Math.atan2(site.dirX, site.dirZ); // heading as rotation.y (+Z forward)
  let x = site.x, z = site.z;
  for (let i = 0; i < n; i++) {
    const s = i * step;
    const u = Math.min(1, Math.max(0, (s - runOut) / turnLen));
    const h = h0 + turn * u * u * (3 - 2 * u);
    out[i * 3] = x;
    out[i * 3 + 1] = z;
    out[i * 3 + 2] = h;
    x += Math.sin(h) * step;
    z += Math.cos(h) * step;
  }
  return out;
}

/** Interpolated point at distance s along a buildPath route -> writes { x, z, heading } into o. */
export function pathAt(path, s, o, step = 0.5) {
  const n = Math.floor(path.length / 3);
  const f = Math.max(0, Math.min(n - 1.001, s / step));
  const i = Math.floor(f), u = f - i;
  const a = i * 3, b = a + 3;
  o.x = path[a] + (path[b] - path[a]) * u;
  o.z = path[a + 1] + (path[b + 1] - path[a + 1]) * u;
  o.heading = path[a + 2] + (path[b + 2] - path[a + 2]) * u;
  return o;
}

/** A turn (radians, relative to straight out to sea) whose route clears land, reef and the wreck. */
export function findLaunchTurn(world, site, wreck, clearance = 24) {
  const tmp = new Float32Array(3 * 360);
  const cands = [40, -40, 55, -55, 30, -30, 70, -70, 85, -85, 0];
  let best = null, bestBad = Infinity;
  for (const deg of cands) {
    const turn = deg * D2R;
    buildPath(site, turn, tmp);
    let bad = 0;
    for (let i = 0; i < 360; i += 4) {
      const x = tmp[i * 3], z = tmp[i * 3 + 1], s = i * 0.5;
      if (s > 26 && world.heightAt(x, z) > -0.5) bad++;
      if (wreck && hyp(x - wreck.x, z - wreck.z) < clearance) bad += 2;
    }
    if (bad === 0) return turn;
    if (bad < bestBad) {
      bestBad = bad;
      best = turn;
    }
  }
  return best ?? 40 * D2R;
}

export const _internal = { bearingOf, bearingDir };
