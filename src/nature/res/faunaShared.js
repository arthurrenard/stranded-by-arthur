// Shared fauna infrastructure (Builder C — fauna).
//
// - Habitat rasters: world.biomeAt costs ~8 µs, so it is NEVER called per creature per frame. At init
//   the island is baked once into coarse 8 m Float32 rasters (firefly / butterfly / open ground / beach
//   weights, distance to fresh water). Spawning is then an O(1) bilinear lookup + accept/reject.
// - Coast ring: one coastline point every 5° (gull soaring paths, gull beach landing spots).
// - Water edges: dry points right at the fresh-water edge (dragonflies, frogs, lily pads).
// - Wing-flap shader patch for instanced Lambert materials (butterflies, birds, dragonfly wings).
//
// Pure logic except patchFlap (which only edits shader strings), so everything here runs in node tests.
import { smoothstep, clamp01 } from '../../core/util.js';
import { waterEdgePoints } from './placement.js';

export const TAU = Math.PI * 2;

// ── Habitat rasters ─────────────────────────────────────────────────────
const CELL = 8; // raster resolution (m)
const EXTENT = 344; // covers the island (radius 320) plus a margin

/**
 * Bake the habitat rasters. ~7.4k biomeAt calls (~60 ms). Returns an object with sampling helpers.
 * Channels (all 0..1 unless stated):
 *   firefly  — water edges, wet ground, meadows, forest edges (and a little forest); low over open water
 *   butterfly— meadows (strong), grassland, forest edges; never sand/rock/steep
 *   open     — open dry ground for foraging songbirds (meadow/grass, flat, no forest)
 *   beach    — dry sand above the waterline (gulls standing)
 *   dFresh   — distance (m) to the nearest fresh water cell
 */
export function buildHabitat(world) {
  const N = Math.ceil((EXTENT * 2) / CELL) + 1;
  const x0 = -EXTENT;
  const size = N * N;
  const fresh = new Uint8Array(size);
  const land = new Uint8Array(size);
  const meadow = new Float32Array(size);
  const forest = new Float32Array(size);
  const sand = new Float32Array(size);
  const rock = new Float32Array(size);
  const wet = new Float32Array(size);
  const slope = new Float32Array(size);
  const height = new Float32Array(size);

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = x0 + i * CELL, z = x0 + j * CELL;
      const k = j * N + i;
      const h = world.heightAt(x, z);
      height[k] = h;
      if (h < -6 || Math.hypot(x, z) > EXTENT) continue; // deep sea: everything 0
      const w = world.waterAt(x, z);
      if (w) {
        if (w.fresh) fresh[k] = 1;
        continue;
      }
      if (h < 0.15) continue;
      land[k] = 1;
      const b = world.biomeAt(x, z);
      meadow[k] = b.meadow;
      forest[k] = b.forest;
      sand[k] = b.sand;
      rock[k] = b.rock;
      wet[k] = b.wet;
      slope[k] = b.slope;
    }
  }

  const dFresh = distanceTransform(fresh, N, CELL); // land -> nearest fresh water
  const dLand = distanceTransform(land, N, CELL); // water -> nearest land

  const firefly = new Float32Array(size);
  const butterfly = new Float32Array(size);
  const open = new Float32Array(size);
  const beach = new Float32Array(size);
  for (let k = 0; k < size; k++) {
    if (fresh[k]) {
      // over fresh water: near the banks only (they drift out a little over the surface)
      firefly[k] = 0.75 * smoothstep(16, 3, dLand[k]);
      continue;
    }
    if (!land[k]) continue;
    const edge = tri(forest[k], 0.15, 0.42, 0.7); // forest edge peak
    const nearWater = smoothstep(34, 4, dFresh[k]);
    const dry = (1 - sand[k] * 0.92) * (1 - rock[k] * 0.85) * (1 - smoothstep(0.35, 0.7, slope[k]));
    firefly[k] = clamp01(Math.max(nearWater, meadow[k] * 0.7, edge * 0.55, wet[k] * 0.8, forest[k] * 0.12) * dry);
    const grass = forest[k] < 0.45 && sand[k] < 0.15 && rock[k] < 0.25 ? 1 - forest[k] : 0;
    butterfly[k] =
      clamp01(meadow[k] * 1.1 + grass * 0.22 + edge * 0.18) * (1 - sand[k]) * (1 - rock[k]) * (1 - smoothstep(0.25, 0.45, slope[k]));
    open[k] =
      forest[k] < 0.35 && sand[k] < 0.3 && rock[k] < 0.3 && slope[k] < 0.25 ? clamp01((1 - forest[k] * 2.2) * (0.6 + meadow[k] * 0.6)) : 0;
    beach[k] = sand[k] > 0.6 && height[k] > 0.3 && height[k] < 2.6 && slope[k] < 0.25 ? 1 : 0;
  }

  /** Bilinear sample of a raster at world (x, z). */
  function sample(arr, x, z) {
    const fx = (x - x0) / CELL, fz = (z - x0) / CELL;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return 0;
    const tx = fx - i, tz = fz - j;
    const k = j * N + i;
    const a = arr[k] + (arr[k + 1] - arr[k]) * tx;
    const b = arr[k + N] + (arr[k + N + 1] - arr[k + N]) * tx;
    return a + (b - a) * tz;
  }

  /**
   * Pick a point within [rMin, rMax] of (cx, cz) where `arr` accepts it (rand < weight^power).
   * Writes into `out` {x, z, w} and returns true on success. No allocations.
   */
  function pick(arr, rand, cx, cz, rMin, rMax, tries, out, power = 1) {
    for (let t = 0; t < tries; t++) {
      const a = rand() * TAU;
      const r = Math.sqrt(rMin * rMin + rand() * (rMax * rMax - rMin * rMin)); // uniform in the annulus
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const w = sample(arr, x, z);
      if (w <= 0.02) continue;
      if (rand() < (power === 1 ? w : Math.pow(w, power))) {
        out.x = x;
        out.z = z;
        out.w = w;
        return true;
      }
    }
    return false;
  }

  return { N, CELL, x0, firefly, butterfly, open, beach, dFresh, fresh, land, sample, pick };
}

/** Triangular bump: 0 at a, 1 at b, 0 at c. */
function tri(v, a, b, c) {
  if (v <= a || v >= c) return 0;
  return v < b ? (v - a) / (b - a) : (c - v) / (c - b);
}

/** Two-pass chamfer distance (m) from every cell to the nearest cell where mask = 1. */
function distanceTransform(mask, N, cell) {
  const INF = 1e9;
  const d = new Float32Array(N * N);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? 0 : INF;
  const a = cell, b = cell * Math.SQRT2;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + a);
      if (j > 0) {
        v = Math.min(v, d[k - N] + a);
        if (i > 0) v = Math.min(v, d[k - N - 1] + b);
        if (i < N - 1) v = Math.min(v, d[k - N + 1] + b);
      }
      d[k] = v;
    }
  }
  for (let j = N - 1; j >= 0; j--) {
    for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i;
      let v = d[k];
      if (i < N - 1) v = Math.min(v, d[k + 1] + a);
      if (j < N - 1) {
        v = Math.min(v, d[k + N] + a);
        if (i < N - 1) v = Math.min(v, d[k + N + 1] + b);
        if (i > 0) v = Math.min(v, d[k + N - 1] + b);
      }
      d[k] = v;
    }
  }
  return d;
}

// ── Coastline ring ──────────────────────────────────────────────────────
/**
 * One coast point every `stepDeg` degrees (marching inward from the sea until dry land).
 * Each: { x, z, ox, oz (unit vector pointing out to sea), bearing, landX, landZ, landOk }
 * landX/landZ is a dry beach spot a few meters inland (gulls standing), landOk if it is sand-ish height.
 */
export function buildCoastRing(world, stepDeg = 5) {
  const out = [];
  for (let deg = 0; deg < 360; deg += stepDeg) {
    const b = (deg * Math.PI) / 180;
    const dx = Math.sin(b), dz = -Math.cos(b); // compass bearing: 0 = north (-Z)
    let x = dx * 370, z = dz * 370;
    for (let d = 370; d > 40; d -= 2) {
      x = dx * d;
      z = dz * d;
      if (world.heightAt(x, z) > 0.25 && world.waterAt(x, z)?.type !== 'ocean') break;
    }
    // a beach spot 4–9 m inland
    let landX = x, landZ = z, landOk = false;
    for (let s = 4; s <= 9; s += 1) {
      const lx = x - dx * s, lz = z - dz * s;
      const h = world.heightAt(lx, lz);
      if (h > 0.35 && h < 2.8 && !world.waterAt(lx, lz) && world.slopeAt(lx, lz) < 0.3) {
        landX = lx;
        landZ = lz;
        landOk = true;
        break;
      }
    }
    out.push({ x, z, ox: dx, oz: dz, bearing: deg, landX, landZ, landOk });
  }
  return out;
}

/** Index of the coast ring point nearest to (x, z). */
export function nearestCoastIndex(ring, x, z) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const d = (ring[i].x - x) ** 2 + (ring[i].z - z) ** 2;
    if (d < bd) (bd = d), (best = i);
  }
  return best;
}

// ── Fresh-water edges ───────────────────────────────────────────────────
/**
 * Dry points at the edge of lakes / pond / river, each with the water surface height next to it:
 * [{ x, z, y (ground), nx, nz (toward the water), waterId, surface }].
 */
export function buildWaterEdges(world, rand) {
  const pts = waterEdgePoints(world, rand, { lakeStep: 3, riverStep: 6 });
  const lakeById = {};
  for (const L of world.lakes) lakeById[L.id] = L;
  const out = [];
  for (const p of pts) {
    let surface;
    if (lakeById[p.waterId]) surface = lakeById[p.waterId].level;
    else {
      const w = world.waterAt(p.x + p.nx * 2, p.z + p.nz * 2);
      if (!w || !w.fresh) continue;
      surface = w.surface;
    }
    out.push({ x: p.x, z: p.z, y: p.y, nx: p.nx, nz: p.nz, waterId: p.waterId, surface });
  }
  return out;
}

/**
 * Pick a random water edge within `r` of (x, z) (uniform over the qualifying edges).
 * Reservoir sampling: one pass, no allocation. Returns the edge object or null.
 */
export function pickEdgeNear(edges, rand, x, z, r, filter = null) {
  let chosen = null, n = 0;
  const r2 = r * r;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const d2 = (e.x - x) ** 2 + (e.z - z) ** 2;
    if (d2 > r2) continue;
    if (filter && !filter(e)) continue;
    n++;
    if (rand() * n < 1) chosen = e;
  }
  return chosen;
}

// ── Wing-flap shader patch ──────────────────────────────────────────────
// Geometry attribute aWing: -1 = rigid body vertex, 0..1 = wing vertex (0 at the root, 1 at the tip).
// Instanced attribute aFlap (vec3): x = flap angle (rad, + = wings up), y = span (1 open .. 0.3 folded),
// z = tip bend (extra angle at the tip, weighted by aWing²; gives the bird-wing "M" / lag curve).
// Wings lie in the model's XZ plane (body along Z); each side rotates about the body axis (Z).
const FLAP_PARS = /* glsl */ `
attribute float aWing;
attribute vec3 aFlap;
float fwAngle() {
  float s = position.x >= 0.0 ? 1.0 : -1.0;
  return s * ( aFlap.x + aFlap.z * aWing * aWing );
}
`;
const FLAP_NORMAL = /* glsl */ `
// fauna-flap: rotate wing normals with the wing
if ( aWing >= 0.0 ) {
  float fwa = fwAngle();
  float fwc = cos( fwa ), fws = sin( fwa );
  objectNormal = vec3( objectNormal.x * fwc - objectNormal.y * fws, objectNormal.x * fws + objectNormal.y * fwc, objectNormal.z );
}
`;
const FLAP_POS = /* glsl */ `
// fauna-flap: fold (span) then rotate the wing about the body axis
if ( aWing >= 0.0 ) {
  float fwa = fwAngle();
  float fwc = cos( fwa ), fws = sin( fwa );
  float fpx = transformed.x * aFlap.y;
  transformed = vec3( fpx * fwc - transformed.y * fws, fpx * fws + transformed.y * fwc, transformed.z );
}
`;

/**
 * Patch a built-in lit material (Lambert/Standard) with the wing flap + an optional vertex-color
 * emissive glow (keeps small wings vivid in shade). `key` must be unique per material: three's
 * default program cache key is onBeforeCompile.toString(), identical for every material patched here.
 */
export function patchFlap(material, key, { glow = 0 } = {}) {
  const uGlow = { value: glow };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = uGlow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + FLAP_PARS)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + FLAP_NORMAL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + FLAP_POS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_COLOR\n  totalEmissiveRadiance += vColor.rgb * uGlow; // fauna-glow\n#endif'
      );
  };
  material.customProgramCacheKey = () => 'fauna-flap-' + key;
  material.userData.uGlow = uGlow;
  return material;
}

// ── Small helpers ───────────────────────────────────────────────────────
/** Wrap an angle to [-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Exponential approach factor for frame-rate independent smoothing. */
export const approach = (lambda, dt) => 1 - Math.exp(-lambda * dt);

/** Safe audio one-shot: audio is optional and may not know every sound name. */
export function playSound(ctx, name, opts) {
  try {
    ctx.audio?.play?.(name, opts);
  } catch (_) {
    /* audio is decorative: never let it break the fauna update */
  }
}
