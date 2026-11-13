// Tempest Isle flora placement (v3, Builder V3-B). Runs after the main-island pass with its own rng fork so the
// main island's seeded layout never shifts. Wind-bent pines (type 'pine', vk 'windPine', all leaning downwind
// toward the main island), a few storm-killed snags, palms in the sheltered cove, sparse trees on the cliff tops,
// boulders on the rocky slopes, and scrubby undergrowth. Keep-clear: the summit plateau (the hut), the climbing path
// from the cove up to the hut, the dock line, the beach landing spot and the Rain Pool rim (bananas grow there).
import { SpatialHash } from '../../core/spatial.js';
import { treeHabitatOk, vnoise, vfbm } from './placement.js';

const TAU = Math.PI * 2;

/** Distance from (px, pz) to the segment a-b. */
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Keep-clear test for Tempest Isle (kind 'tree' or 'under'). */
export function isle2Zones(world) {
  const L = world.landmarks || {};
  const hut = L.isle2Hut, dock = L.isle2Dock, cove = L.isle2Cove, pond = L.isle2Pond;
  return {
    blocked(x, z, kind = 'tree') {
      const pad = kind === 'tree' ? 1 : 0;
      if (hut && Math.hypot(x - hut.x, z - hut.z) < (hut.r ?? 9) + (kind === 'tree' ? 7 : 4)) return true;
      if (cove && Math.hypot(x - cove.x, z - cove.z) < 11 + pad * 3) return true;
      if (dock) {
        const ex = dock.x + dock.dirX * (dock.length ?? 18), ez = dock.z + dock.dirZ * (dock.length ?? 18);
        const bx = dock.x - dock.dirX * 22, bz = dock.z - dock.dirZ * 22;
        if (segDist(x, z, bx, bz, ex, ez) < 4.5 + pad * 1.5) return true;
      }
      if (cove && hut && segDist(x, z, cove.x, cove.z, hut.x, hut.z) < 3 + pad * 1.5) return true; // the climb
      if (pond && kind === 'tree' && Math.hypot(x - pond.x, z - pond.z) < (pond.r ?? 6) + 9) return true;
      return false;
    },
  };
}

/**
 * Place Tempest Isle trees + boulders. lib must have windPine, palm, snag, boulder.
 * startId: the id of the first new tree (ids continue the main array). Returns { trees, boulders }.
 */
export function placeIsle2Trees(world, rng, lib, startId = 0) {
  const I = world.isle2;
  const L = world.landmarks || {};
  if (!I || !lib.windPine) return { trees: [], boulders: [] };
  const zones = isle2Zones(world);
  const trees = [];
  const hash = new SpatialHash(10);
  const toMain = I.toMain || { x: -I.x / Math.hypot(I.x, I.z), z: -I.z / Math.hypot(I.x, I.z) };
  const leanRot = Math.atan2(-toMain.z, toMain.x); // local +X (the lean) points downwind, toward the main island
  const peakH = I.peak?.height ?? 100;

  function baseY(x, z, r) {
    return Math.min(world.heightAt(x, z), world.heightAt(x + r, z), world.heightAt(x - r, z), world.heightAt(x, z + r), world.heightAt(x, z - r));
  }
  function make(type, vk, x, z) {
    const variants = lib[vk];
    const v = Math.floor(rng() * variants.length);
    const V = variants[v];
    let s, rot;
    if (type === 'palm') {
      s = rng.range(0.82, 1.1);
      const dx = x - I.x, dz = z - I.z, l = Math.hypot(dx, dz) || 1;
      rot = Math.atan2(-dz / l, dx / l) + (rng() - 0.5) * 1.0; // lean out to sea
    } else if (vk === 'windPine') {
      s = rng.range(0.8, 1.15);
      rot = leanRot + (rng() - 0.5) * 0.6;
    } else {
      s = rng.range(0.75, 1.05);
      rot = rng() * TAU;
    }
    const c = Math.cos(rot), sn = Math.sin(rot);
    const trunkR = V.trunkR * s;
    const t = {
      id: -1,
      x,
      z,
      y: baseY(x, z, trunkR * 1.2),
      type,
      height: V.height * s,
      trunkR,
      crownR: V.crownR * s,
      alive: type !== 'snag',
      standing: true,
      v,
      rot,
      s,
      phase: rng(),
      ccx: x + (V.crownCX * c + V.crownCZ * sn) * s,
      ccz: z + (-V.crownCX * sn + V.crownCZ * c) * s,
      canopy: V.canopy ?? 0.7,
      island: 'isle2',
    };
    if (vk !== type) t.vk = vk;
    return t;
  }
  const near = [];
  function spaced(t, k) {
    near.length = 0;
    hash.query(t.x, t.z, t.crownR + 9, near);
    for (const o of near) {
      const d = Math.hypot(o.x - t.x, o.z - t.z);
      if (d < Math.max(1.6 + t.trunkR + o.trunkR, (t.crownR + o.crownR) * k)) return false;
    }
    return true;
  }
  function commit(t) {
    t.id = startId + trees.length;
    trees.push(t);
    hash.insert(t);
  }

  // Jittered grid over the isle's square.
  const CELL = 4.2;
  const ext = I.R * 1.12;
  const n = Math.ceil((ext * 2) / CELL);
  let palms = 0;
  for (let cj = 0; cj < n; cj++) {
    for (let ci = 0; ci < n; ci++) {
      const x = I.x - ext + (ci + rng()) * CELL, z = I.z - ext + (cj + rng()) * CELL;
      const r0 = rng(), r1 = rng();
      const h = world.heightAt(x, z);
      if (h < 0.75 || world.islandAt?.(x, z) !== 'isle2') continue;
      if (zones.blocked(x, z, 'tree')) continue;
      const b = world.biomeAt(x, z);
      const rn = world.isle2ness ? world.isle2ness(x, z) : b.rn;
      let type, vk, p;
      if (b.sand > 0.3) {
        // palms only in the cove (the cliff coasts have no beach)
        type = 'palm';
        vk = 'palm';
        p = palms < 34 ? 0.22 : 0;
      } else {
        const clump = vfbm(x * 0.03, z * 0.03, 113);
        const high = h > peakH * 0.7 ? 0.25 : 1; // the wind-blasted upper mountain is nearly bare
        const cliff = rn > 0.86 ? 0.35 : 1; // sparse on the cliff tops
        p = (0.03 + 0.2 * Math.max(0, clump)) * high * cliff;
        type = r1 < 0.09 ? 'snag' : 'pine';
        vk = type === 'snag' ? 'snag' : 'windPine';
      }
      if (r0 > p) continue;
      if (!treeHabitatOk(world, type, x, z, b)) continue;
      const t = make(type, vk, x, z);
      if (!spaced(t, type === 'palm' ? 0.75 : 0.6)) continue;
      commit(t);
      if (type === 'palm') palms++;
    }
  }

  // Boulders on the rocky slopes and cliff tops (flora gives them colliders).
  const boulders = [];
  const bHash = new SpatialHash(10);
  const BC = 9;
  const nb = Math.ceil((ext * 2) / BC);
  const pool = lib.boulder.length / 2;
  for (let cj = 0; cj < nb; cj++) {
    for (let ci = 0; ci < nb; ci++) {
      const x = I.x - ext + (ci + rng()) * BC, z = I.z - ext + (cj + rng()) * BC;
      const r0 = rng(), r1 = rng(), r2 = rng();
      const h = world.heightAt(x, z);
      if (h < 0.6 || world.islandAt?.(x, z) !== 'isle2') continue;
      if (zones.blocked(x, z, 'tree')) continue;
      const b = world.biomeAt(x, z);
      if (b.water || b.slope > 0.7) continue;
      const p = b.rock * 0.4 + b.highland * 0.1 + (b.slope > 0.35 ? 0.08 : 0);
      if (r0 > p) continue;
      const size = (0.6 + r2 * 1.5) * (rng() < 0.08 ? 1.5 : 1);
      near.length = 0;
      hash.query(x, z, size + 3, near);
      if (near.some((t) => Math.hypot(t.x - x, t.z - z) < t.trunkR + size + 0.6)) continue;
      near.length = 0;
      bHash.query(x, z, size + 4, near);
      if (near.some((o) => Math.hypot(o.x - x, o.z - z) < o.s + size + 0.8)) continue;
      const v = Math.floor(r1 * pool); // bare (not mossy) rock
      const V = lib.boulder[v];
      const y = baseY(x, z, size * 0.7) - size * 0.18;
      const o = { x, z, y, v, rot: rng() * TAU, s: size, r: size * Math.min(1, V.rz ?? 1) * 0.86, top: y + V.height * size, mossy: false, island: 'isle2' };
      boulders.push(o);
      bHash.insert(o);
    }
  }
  for (const t of trees) delete t.__cell;
  for (const o of boulders) delete o.__cell;
  return { trees, boulders };
}

/** Scrubby undergrowth on Tempest Isle: bushes, ferns in the pine clumps, small rocks. Returns [{ kind, v, x, y, z, rot, s }]. */
export function placeIsle2Undergrowth(world, rng, lib, trees, boulders) {
  const I = world.isle2;
  if (!I) return [];
  const zones = isle2Zones(world);
  const out = [];
  const trunks = new SpatialHash(8);
  for (const t of trees) trunks.insert({ x: t.x, z: t.z, r: 0, tr: t.trunkR });
  for (const o of boulders || []) trunks.insert({ x: o.x, z: o.z, r: 0, tr: o.r + 0.3 });
  const near = [];
  const clear = (x, z, pad) => {
    near.length = 0;
    trunks.query(x, z, pad + 4, near);
    for (const o of near) if (Math.hypot(o.x - x, o.z - z) < o.tr + pad) return false;
    return true;
  };
  const nb = lib.bush.length;
  const CELL = 3.4;
  const ext = I.R * 1.1;
  const n = Math.ceil((ext * 2) / CELL);
  for (let cj = 0; cj < n; cj++) {
    for (let ci = 0; ci < n; ci++) {
      const x = I.x - ext + (ci + rng()) * CELL, z = I.z - ext + (cj + rng()) * CELL;
      const r0 = rng(), r1 = rng(), r2 = rng();
      const h = world.heightAt(x, z);
      if (h < 0.6 || world.islandAt?.(x, z) !== 'isle2') continue;
      if (zones.blocked(x, z, 'under')) continue;
      const b = world.biomeAt(x, z);
      if (b.water || b.slope > 0.55) continue;
      const scrub = vnoise(x * 0.06, z * 0.06, 131);
      if (b.sand < 0.25 && r0 < 0.045 + 0.07 * scrub && clear(x, z, 1)) {
        // low, wind-flattened scrub (non-flowering bushes)
        out.push({ kind: 'bush', v: Math.floor(rng() * Math.max(1, nb - 2)), x, y: h - 0.08, z, rot: rng() * TAU, s: 0.6 + r2 * 0.5 });
        continue;
      }
      if (b.sand < 0.2 && b.slope < 0.35 && r1 < 0.05 * scrub && clear(x, z, 0.7)) {
        out.push({ kind: 'fern', v: Math.floor(rng() * lib.fern.length), x, y: h, z, rot: rng() * TAU, s: 0.6 + r2 * 0.4 });
        continue;
      }
      const pr = b.rock * 0.1 + b.slope * 0.05 + (b.sand > 0.5 ? 0.01 : 0);
      if (r2 < pr && clear(x, z, 0.5)) out.push({ kind: 'rock', v: Math.floor(rng() * lib.rock.length), x, y: h - 0.06, z, rot: rng() * TAU, s: 0.25 + rng() * 0.5 });
    }
  }
  return out;
}
