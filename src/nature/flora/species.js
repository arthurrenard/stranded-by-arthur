// Procedural species generators. Every function takes a seeded rng (core/rng.js createRng instance)
// and returns a "variant": typed arrays from GeoBuilder.finish() plus metadata (height, trunkR,
// crownR, canopy density...). Variants are generated once at load in local space (base of the trunk
// at the origin, +Y up) and baked per instance into chunk meshes by bake.js.
//
// Trees: oak, pine, birch, palm, willow, apple, chestnut, snag, carvedOak (the landmark), windPine (v3, Tempest Isle;
// entries keep type 'pine' and set vk: 'windPine').
// Undergrowth: fern, bush, reeds, lily, boulder, rock, log, flower (with a closed pose), saplings.
import { GeoBuilder, tube, blob, cone, frond, strip, octa, disc, withLowDetail } from './builder.js';
import { PAL, jit, mix, mul } from './palette.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const TAU = Math.PI * 2;

/** Height-based bend weight: 0 below y0, amp * ((y-y0)/(H-y0))^pow above. */
function bendBy(amp, y0, H, pow = 1.6) {
  const span = Math.max(0.1, H - y0);
  return (x, y) => amp * Math.pow(clamp01((y - y0) / span), pow);
}

/** Crown blob color: darker underneath, sunlit on top, per-vertex jitter. */
function leafColorFn(rng, base, light, dark) {
  return (nx, ny) => {
    const t = ny * 0.5 + 0.5;
    let c = t > 0.55 ? mix(base, light, (t - 0.55) * 1.6) : mix(dark, base, t / 0.55);
    return jit(c, rng, 0.09, 0.72 + 0.42 * t);
  };
}

// ── Broadleaf (oak / apple / chestnut / carved oak) ──────────────────────
/**
 * Shared broadleaf generator. p: { H, tr, crownR, trunkTop, nBranch, blobs, leaf, leafLight, leafDark,
 * amp, ryK, fruit?, catkins?, twist?, carved? }
 */
function broadleaf(rng, p) {
  const b = new GeoBuilder();
  const { H, tr } = p;
  b.bendFn = bendBy(p.amp, H * 0.12, H, 1.7);
  const barkCol = (i, j, a) => {
    if (p.twist && (j + i) % 3 === 0) return jit(PAL.barkDark, rng, 0.08);
    const k = i === 0 ? 0.72 : 1;
    return rng() < 0.18 ? jit(PAL.barkDark, rng, 0.1, k) : jit(mix(PAL.bark, PAL.barkLight, rng() * 0.4), rng, 0.08, k);
  };
  // Trunk with a root flare. The carved oak keeps a clean cylinder of radius tr for y in [0.4, 2.6].
  const pts = [];
  const top = p.trunkTop;
  const wob = p.carved ? 0 : 0.12;
  if (p.carved) {
    pts.push({ x: 0, y: -0.6, z: 0, r: tr * 1.7 }, { x: 0, y: 0.05, z: 0, r: tr * 1.28 }, { x: 0, y: 0.4, z: 0, r: tr });
    pts.push({ x: 0, y: 1.5, z: 0, r: tr }, { x: 0, y: 2.6, z: 0, r: tr });
    pts.push({ x: 0.15, y: top * 0.7, z: -0.1, r: tr * 0.9 }, { x: 0.25, y: top, z: 0.05, r: tr * 0.78 });
  } else {
    const nR = 6;
    let ox = 0, oz = 0;
    for (let i = 0; i < nR; i++) {
      const t = i / (nR - 1);
      const y = -0.4 + (top + 0.4) * t;
      const flare = 1 + 0.55 * Math.exp(-Math.max(0, y + 0.3) * 2.4);
      if (i > 1) {
        ox += (rng() - 0.5) * wob * 2;
        oz += (rng() - 0.5) * wob * 2;
      }
      pts.push({ x: ox, y, z: oz, r: tr * (1 - 0.28 * t) * flare });
    }
  }
  tube(b, pts, p.carved ? 12 : 7, barkCol, { rng, jitter: p.carved ? 0 : 0.07, capTop: true });
  const topP = pts[pts.length - 1];

  // Roots for the carved oak: gnarled radial flares
  if (p.carved) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + rng() * 0.4;
      const ca = Math.cos(a), sa = Math.sin(a);
      tube(
        b,
        [
          { x: ca * tr * 0.6, y: 0.5, z: sa * tr * 0.6, r: tr * 0.42 },
          { x: ca * tr * 1.5, y: 0.08, z: sa * tr * 1.5, r: tr * 0.3 },
          { x: ca * tr * 2.6, y: -0.25, z: sa * tr * 2.6, r: 0.02 },
        ],
        5,
        barkCol,
        { rng }
      );
    }
  }

  // Main branches -> blob anchors
  const anchors = [];
  const nb = p.nBranch;
  const az0 = rng() * TAU;
  for (let k = 0; k < nb; k++) {
    const az = az0 + (k / nb) * TAU + (rng() - 0.5) * 0.8;
    const el = (35 + rng() * 25) * (Math.PI / 180); // angle from vertical
    const len = H * (0.26 + rng() * 0.1) * (p.branchK ?? 1);
    const y0 = top * (0.82 + rng() * 0.16);
    const s = { x: topP.x * 0.9, y: y0, z: topP.z * 0.9 };
    const dx = Math.cos(az) * Math.sin(el), dz = Math.sin(az) * Math.sin(el), dy = Math.cos(el);
    const m = { x: s.x + dx * len * 0.5, y: s.y + dy * len * 0.45, z: s.z + dz * len * 0.5 };
    const e = { x: s.x + dx * len, y: s.y + dy * len * 1.05 + 0.3, z: s.z + dz * len };
    tube(b, [{ ...s, r: tr * 0.5 }, { ...m, r: tr * 0.34 }, { ...e, r: tr * 0.14 }], 5, barkCol, { rng });
    anchors.push(e);
  }

  // Crown
  b.part('leaf');
  b.flutter = p.flutter ?? 0.05;
  const cr = p.crownR;
  const blobs = [];
  const addBlob = (x, y, z, r) => {
    const tint = rng();
    const base = mix(p.leaf, tint < 0.5 ? p.leafDark : p.leafLight, Math.abs(tint - 0.5) * 0.7);
    blob(b, x, y, z, r * (0.95 + rng() * 0.1), r * (p.ryK ?? 0.82), r * (0.95 + rng() * 0.1), {
      detail: r > 1.25 ? 1 : 0,
      jitter: 0.16,
      flatBottom: 0.4,
      rng,
      colorFn: leafColorFn(rng, base, p.leafLight, p.leafDark),
    });
    blobs.push({ x, y, z, r });
  };
  for (const a of anchors) addBlob(a.x, a.y + cr * 0.12, a.z, cr * (0.42 + rng() * 0.12));
  addBlob(topP.x, top + cr * 0.72, topP.z, cr * (0.5 + rng() * 0.1));
  for (let k = 0; k < p.fillers; k++) {
    const a = rng() * TAU, d = cr * (0.25 + rng() * 0.35);
    addBlob(topP.x + Math.cos(a) * d, top + cr * (0.35 + rng() * 0.55), topP.z + Math.sin(a) * d, cr * (0.32 + rng() * 0.12));
  }

  // Fruit / catkins baked as tiny colored octahedra on the crown surface
  const surf = (bl, nyMin, nyMax, out = 1.0) => {
    const a = rng() * TAU;
    const ny = nyMin + rng() * (nyMax - nyMin);
    const s = Math.sqrt(1 - ny * ny);
    return [bl.x + Math.cos(a) * s * bl.r * out, bl.y + ny * bl.r * (p.ryK ?? 0.82) * out, bl.z + Math.sin(a) * s * bl.r * out];
  };
  if (p.fruit) {
    for (let k = 0; k < p.fruit; k++) {
      const bl = blobs[Math.floor(rng() * blobs.length)];
      const q = surf(bl, -0.55, 0.45, 1.04);
      const col = rng() < 0.3 ? mix(PAL.apple, PAL.appleBlush, 0.55) : jit(PAL.apple, rng, 0.1);
      octa(b, q[0], q[1], q[2], 0.075 + rng() * 0.03, col, 1, 0.02);
    }
  }
  if (p.catkins) {
    for (let k = 0; k < p.catkins; k++) {
      const bl = blobs[Math.floor(rng() * blobs.length)];
      const q = surf(bl, -0.4, 0.75, 1.03);
      octa(b, q[0], q[1], q[2], 0.06, jit(PAL.catkin, rng, 0.08), 2.4, 0.03);
    }
  }
  b.flutter = 0;
  return b;
}

export function makeOak(rng) {
  const H = rng.range(9.5, 13);
  const b = broadleaf(rng, {
    H,
    tr: rng.range(0.34, 0.46),
    crownR: H * rng.range(0.34, 0.4),
    trunkTop: H * rng.range(0.38, 0.45),
    nBranch: 3 + Math.floor(rng() * 2),
    fillers: 1 + Math.floor(rng() * 2),
    leaf: PAL.oakLeaf,
    leafLight: PAL.oakLeafLight,
    leafDark: PAL.oakLeafDark,
    amp: 0.5,
  });
  return b.finish({ type: 'oak', trunkR: 0.4, canopy: 0.85 });
}

export function makeCarvedOak(rng) {
  const H = 16.5;
  const tr = 0.95;
  const b = broadleaf(rng, {
    H,
    tr,
    crownR: 6.8,
    trunkTop: 6.2,
    nBranch: 5,
    fillers: 3,
    branchK: 1.15,
    leaf: mul(PAL.oakLeaf, 0.95),
    leafLight: PAL.oakLeafLight,
    leafDark: PAL.oakLeafDark,
    amp: 0.35,
    carved: true,
  });
  return b.finish({ type: 'oak', trunkR: tr, canopy: 0.92 });
}

export function makeApple(rng) {
  const H = rng.range(5, 6.6);
  const b = broadleaf(rng, {
    H,
    tr: rng.range(0.17, 0.23),
    crownR: H * rng.range(0.44, 0.5),
    trunkTop: H * rng.range(0.3, 0.36),
    nBranch: 3 + Math.floor(rng() * 2),
    fillers: 1,
    leaf: PAL.appleLeaf,
    leafLight: PAL.oakLeafLight,
    leafDark: PAL.oakLeafDark,
    amp: 0.3,
    ryK: 0.86,
    fruit: 16 + Math.floor(rng() * 8),
  });
  return b.finish({ type: 'apple', trunkR: 0.2, canopy: 0.72 });
}

export function makeChestnut(rng) {
  const H = rng.range(12, 15.5);
  const b = broadleaf(rng, {
    H,
    tr: rng.range(0.44, 0.56),
    crownR: H * rng.range(0.32, 0.36),
    trunkTop: H * rng.range(0.34, 0.4),
    nBranch: 4,
    fillers: 2,
    leaf: PAL.chestnutLeaf,
    leafLight: PAL.oakLeaf,
    leafDark: mul(PAL.pine, 1.1),
    amp: 0.45,
    ryK: 1.02,
    twist: true,
    catkins: 22 + Math.floor(rng() * 8),
  });
  return b.finish({ type: 'chestnut', trunkR: 0.5, canopy: 0.88 });
}

// ── Pine ─────────────────────────────────────────────────────────────────
export function makePine(rng) {
  const b = new GeoBuilder();
  const H = rng.range(11, 16.5);
  const tr = rng.range(0.26, 0.34);
  b.bendFn = bendBy(0.45, H * 0.1, H, 1.5);
  const barkC = mix(PAL.bark, [0.3, 0.12, 0.06], 0.25);
  const barkCol = (i) => jit(barkC, rng, 0.1, i === 0 ? 0.7 : 1);
  tube(
    b,
    [
      { x: 0, y: -0.4, z: 0, r: tr * 1.35 },
      { x: 0, y: H * 0.3, z: 0, r: tr * 0.85 },
      { x: 0, y: H * 0.7, z: 0, r: tr * 0.45 },
      { x: 0, y: H, z: 0, r: 0 },
    ],
    6,
    barkCol,
    { rng, jitter: 0.05 }
  );
  b.part('leaf');
  b.flutter = 0.025;
  const n = 5 + Math.floor(rng() * 3);
  const y0 = H * rng.range(0.16, 0.24);
  const R0 = H * rng.range(0.2, 0.24);
  const shade = rng.range(0.9, 1.1);
  for (let k = 0; k < n; k++) {
    const f = k / (n - 1);
    const yb = y0 + (H * 0.86 - y0) * Math.pow(f, 0.92);
    const r = R0 * (1 - f * 0.8) * rng.range(0.92, 1.08);
    const h = Math.max(1.4, r * 1.35);
    cone(b, (rng() - 0.5) * 0.15, yb, (rng() - 0.5) * 0.15, r, h, {
      sides: 7,
      droop: r * 0.22,
      jitter: 0.14,
      rng,
      colRim: () => jit(PAL.pineLight, rng, 0.1, shade),
      colApex: () => jit(PAL.pine, rng, 0.08, 1.12 * shade),
      colUnder: () => jit(PAL.pineDark, rng, 0.06, 0.55),
    });
  }
  cone(b, 0, H * 0.9, 0, R0 * 0.16, H * 0.14, {
    sides: 5,
    droop: 0.05,
    rng,
    colRim: () => jit(PAL.pineLight, rng, 0.08),
    colApex: () => jit(PAL.pineLight, rng, 0.08, 1.15),
    colUnder: () => PAL.pineDark,
  });
  b.flutter = 0;
  return b.finish({ type: 'pine', trunkR: tr, canopy: 0.8 });
}

// ── Wind-bent pine (Tempest Isle) ────────────────────────────────────────
/** A stunted pine shaped by the gales: the trunk leans along local +X and the flat crown tiers stream downwind. */
export function makeWindPine(rng) {
  const b = new GeoBuilder();
  const H = rng.range(6.5, 11);
  const tr = rng.range(0.2, 0.28);
  const lean = rng.range(0.18, 0.3);
  const lx = (t) => lean * H * t * t;
  b.bendFn = bendBy(0.32, H * 0.15, H, 1.5);
  const barkC = mix(PAL.bark, [0.3, 0.12, 0.06], 0.35);
  const barkCol = (i) => jit(barkC, rng, 0.1, i === 0 ? 0.7 : 0.95);
  tube(
    b,
    [
      { x: 0, y: -0.4, z: 0, r: tr * 1.4 },
      { x: lx(0.3), y: H * 0.3, z: (rng() - 0.5) * 0.2, r: tr * 0.85 },
      { x: lx(0.65), y: H * 0.65, z: (rng() - 0.5) * 0.25, r: tr * 0.5 },
      { x: lx(1), y: H, z: 0, r: 0 },
    ],
    6,
    barkCol,
    { rng, jitter: 0.06 }
  );
  b.part('leaf');
  b.flutter = 0.02;
  const n = 4 + Math.floor(rng() * 2);
  const y0 = H * rng.range(0.34, 0.44);
  const R0 = H * rng.range(0.21, 0.27);
  const shade = rng.range(0.82, 0.98); // darker, wind-burnt needles
  for (let k = 0; k < n; k++) {
    const f = k / (n - 1);
    const yb = y0 + (H * 0.86 - y0) * f;
    const r = R0 * (1 - f * 0.65) * rng.range(0.9, 1.1);
    const h = Math.max(0.8, r * 0.7);
    cone(b, lx(yb / H) + r * rng.range(0.3, 0.55), yb, (rng() - 0.5) * 0.3, r, h, {
      sides: 7,
      droop: r * 0.12,
      jitter: 0.22,
      rng,
      colRim: () => jit(PAL.pineLight, rng, 0.1, shade * 0.92),
      colApex: () => jit(PAL.pine, rng, 0.08, 1.05 * shade),
      colUnder: () => jit(PAL.pineDark, rng, 0.06, 0.5),
    });
  }
  b.flutter = 0;
  return b.finish({ type: 'pine', trunkR: tr, canopy: 0.6 });
}

// ── Birch ────────────────────────────────────────────────────────────────
export function makeBirch(rng) {
  const b = new GeoBuilder();
  const H = rng.range(9, 13);
  const tr = rng.range(0.15, 0.2);
  b.bendFn = bendBy(0.6, H * 0.1, H, 1.5);
  const bend = rng.range(-0.35, 0.35);
  const pts = [];
  const nR = 9;
  for (let i = 0; i < nR; i++) {
    const t = i / (nR - 1);
    pts.push({ x: Math.sin(t * Math.PI) * bend, y: -0.3 + (H * 0.92 + 0.3) * t, z: Math.sin(t * Math.PI * 2) * 0.12, r: tr * (1 - 0.78 * t) + 0.02 });
  }
  const barkCol = (i) => {
    if (i <= 1) return jit(mix(PAL.birchBark, PAL.birchMark, 0.5), rng, 0.1);
    return rng() < 0.24 ? jit(PAL.birchMark, rng, 0.2, 1.3) : jit(PAL.birchBark, rng, 0.05);
  };
  tube(b, pts, 6, barkCol, { rng });
  // thin branches
  const nb = 5 + Math.floor(rng() * 3);
  const anchors = [];
  for (let k = 0; k < nb; k++) {
    const t = 0.45 + (k / nb) * 0.45;
    const i = Math.min(nR - 2, Math.floor(t * (nR - 1)));
    const s = pts[i];
    const az = rng() * TAU;
    const el = (28 + rng() * 22) * (Math.PI / 180);
    const len = rng.range(1.3, 2.4) * (1.1 - t * 0.5);
    const e = { x: s.x + Math.cos(az) * Math.sin(el) * len, y: s.y + Math.cos(el) * len, z: s.z + Math.sin(az) * Math.sin(el) * len };
    tube(b, [{ ...s, r: 0.05 }, { ...e, r: 0.01 }], 4, () => jit(mix(PAL.birchMark, PAL.barkGrey, 0.6), rng, 0.1), { rng });
    anchors.push(e);
  }
  b.part('leaf');
  b.flutter = 0.08;
  const lc = leafColorFn(rng, PAL.birchLeaf, PAL.birchLeafLight, mul(PAL.birchLeaf, 0.62));
  for (const a of anchors) {
    const r = rng.range(0.85, 1.35);
    blob(b, a.x, a.y + 0.2, a.z, r, r * 0.85, r, { detail: r > 1.15 ? 1 : 0, jitter: 0.18, flatBottom: 0.3, rng, colorFn: lc });
  }
  const tp = pts[nR - 1];
  blob(b, tp.x, tp.y + 0.3, tp.z, 1.2, 1.3, 1.2, { detail: 1, jitter: 0.18, rng, colorFn: lc });
  b.flutter = 0;
  return b.finish({ type: 'birch', trunkR: tr, canopy: 0.58 });
}

// ── Palm ─────────────────────────────────────────────────────────────────
export function makePalm(rng) {
  const b = new GeoBuilder();
  const H = rng.range(7, 11);
  const tr = rng.range(0.2, 0.26);
  const lean = rng.range(0.16, 0.32);
  b.bendFn = (x, y) => 1.35 * Math.pow(clamp01(y / H), 2);
  const nR = 10;
  const pts = [];
  for (let i = 0; i < nR; i++) {
    const t = i / (nR - 1);
    const bulge = i % 2 === 0 ? 1.07 : 0.95;
    pts.push({ x: lean * H * t * t, y: -0.3 + (H + 0.3) * t, z: Math.sin(t * 3) * 0.08, r: tr * (1.3 - 0.45 * t) * bulge * (i === 0 ? 1.25 : 1) });
  }
  tube(b, pts, 6, (i) => jit(i % 2 === 0 ? PAL.palmTrunk : PAL.palmTrunkDark, rng, 0.06), { rng });
  const T = pts[nR - 1];
  // crown knob + coconuts
  blob(b, T.x, T.y - 0.05, T.z, 0.32, 0.3, 0.32, { detail: 0, jitter: 0.15, rng, colorFn: () => jit(PAL.palmTrunkDark, rng, 0.1) });
  const nc = 3 + Math.floor(rng() * 3);
  for (let k = 0; k < nc; k++) {
    const a = rng() * TAU;
    octa(b, T.x + Math.cos(a) * 0.26, T.y - 0.32 - rng() * 0.12, T.z + Math.sin(a) * 0.26, 0.14, jit(PAL.coconut, rng, 0.12));
  }
  b.part('leaf');
  const nf = 8 + Math.floor(rng() * 2);
  const az0 = rng() * TAU;
  for (let k = 0; k < nf; k++) {
    const az = az0 + (k / nf) * TAU + (rng() - 0.5) * 0.35;
    frond(b, T.x, T.y + 0.05, T.z, [Math.cos(az), Math.sin(az)], {
      len: rng.range(3.4, 4.6),
      width: rng.range(0.55, 0.72),
      lift: rng.range(0.35, 0.6),
      droop: rng.range(1.0, 1.3),
      segs: 6,
      colBase: mul(PAL.palmDark, 0.85),
      colTip: PAL.palm,
      flutter: 0.12,
      sideDrop: 0.4,
      rng,
    });
  }
  for (let k = 0; k < 3; k++) {
    const az = rng() * TAU;
    frond(b, T.x, T.y + 0.1, T.z, [Math.cos(az), Math.sin(az)], {
      len: rng.range(1.8, 2.4),
      width: 0.42,
      lift: 1.4,
      droop: 1.0,
      segs: 4,
      colBase: PAL.palmDark,
      colTip: mul(PAL.palm, 1.1),
      flutter: 0.1,
      rng,
    });
  }
  return b.finish({ type: 'palm', trunkR: tr, canopy: 0.5 });
}

// ── Willow ───────────────────────────────────────────────────────────────
export function makeWillow(rng) {
  const b = new GeoBuilder();
  const H = rng.range(7.5, 9.5);
  const tr = rng.range(0.42, 0.55);
  b.bendFn = bendBy(0.55, 1.5, H, 1.4);
  const barkCol = (i) => jit(rng() < 0.25 ? PAL.barkDark : mix(PAL.bark, PAL.barkGrey, 0.4), rng, 0.08, i === 0 ? 0.75 : 1);
  const lx = rng.range(-0.4, 0.4), lz = rng.range(-0.4, 0.4);
  const fork = { x: lx, y: 2.4, z: lz };
  tube(b, [{ x: 0, y: -0.4, z: 0, r: tr * 1.5 }, { x: lx * 0.4, y: 1.2, z: lz * 0.4, r: tr }, { ...fork, r: tr * 0.85 }], 7, barkCol, { rng, jitter: 0.08 });
  const crownY = H * 0.72;
  const crownR = rng.range(3.4, 4.2);
  const limbs = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + rng() * 0.8;
    const e = { x: fork.x + Math.cos(a) * crownR * 0.45, y: crownY - 0.4, z: fork.z + Math.sin(a) * crownR * 0.45 };
    tube(b, [{ ...fork, r: tr * 0.55 }, { ...e, r: tr * 0.2 }], 5, barkCol, { rng });
    limbs.push(e);
  }
  b.part('leaf');
  b.flutter = 0.05;
  const lc = leafColorFn(rng, PAL.willow, mul(PAL.willow, 1.2), PAL.willowDark);
  const cx = fork.x, cz = fork.z;
  for (const e of limbs) blob(b, e.x, e.y + 0.6, e.z, crownR * 0.55, crownR * 0.36, crownR * 0.55, { detail: 1, jitter: 0.14, rng, colorFn: lc });
  blob(b, cx, crownY + 0.5, cz, crownR * 0.62, crownR * 0.42, crownR * 0.62, { detail: 1, jitter: 0.14, rng, colorFn: lc });
  // Hanging strands around the dome
  const ns = 30 + Math.floor(rng() * 8);
  for (let k = 0; k < ns; k++) {
    const a = rng() * TAU;
    const rr = crownR * (0.6 + rng() * 0.45);
    const ca = Math.cos(a), sa = Math.sin(a);
    const y1 = crownY + 0.7 - Math.pow(rr / crownR, 2) * 1.6;
    const y2 = rng.range(0.9, 2.4);
    const sx = cx + ca * rr, sz = cz + sa * rr;
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const out = 0.25 * Math.sin(t * Math.PI * 0.8);
      pts.push([sx + ca * out, y1 + (y2 - y1) * t, sz + sa * out]);
    }
    const bend0 = b.bendFn(0, y1);
    const span = y1 - y2;
    const save = b.bendFn;
    b.bendFn = (x, y) => bend0 + 0.45 * clamp01((y1 - y) / span);
    const light = rng.range(0.9, 1.2);
    strip(b, pts, [0.32, 0.26, 0.18, 0.05], [-sa, 0, ca], (t) => jit(mix(PAL.willowDark, PAL.willow, 0.4 + t * 0.6), rng, 0.06, light), (t) => 0.05 + t * 0.12);
    b.bendFn = save;
  }
  b.flutter = 0;
  return b.finish({ type: 'willow', trunkR: tr, canopy: 0.8 });
}

// ── Dead snag ────────────────────────────────────────────────────────────
export function makeSnag(rng) {
  const b = new GeoBuilder();
  const H = rng.range(6, 11);
  const tr = rng.range(0.24, 0.36);
  b.bendFn = bendBy(0.18, 1, H, 1.5);
  const col = () => jit(rng() < 0.3 ? PAL.snagDark : PAL.snag, rng, 0.1);
  const pts = [];
  const nR = 6;
  let ox = 0, oz = 0;
  const lx = rng.range(-0.08, 0.08), lz = rng.range(-0.08, 0.08);
  for (let i = 0; i < nR; i++) {
    const t = i / (nR - 1);
    ox += (rng() - 0.5) * 0.12;
    oz += (rng() - 0.5) * 0.12;
    pts.push({ x: ox + lx * H * t, y: -0.4 + (H + 0.4) * t, z: oz + lz * H * t, r: tr * (1.35 - 0.85 * t) * (i === 0 ? 1.2 : 1) });
  }
  tube(b, pts, 6, col, { rng, jitter: 0.12, capTop: true, capLift: -0.15, capColor: PAL.heartwood });
  let reach = 0;
  const nb = 4 + Math.floor(rng() * 3);
  for (let k = 0; k < nb; k++) {
    const t = 0.35 + rng() * 0.55;
    const i = Math.min(nR - 2, Math.floor(t * (nR - 1)));
    const s = pts[i];
    const az = rng() * TAU;
    const el = (40 + rng() * 35) * (Math.PI / 180);
    const len = rng.range(1.2, 3.4) * (rng() < 0.3 ? 0.45 : 1);
    const dx = Math.cos(az) * Math.sin(el), dz = Math.sin(az) * Math.sin(el), dy = Math.cos(el);
    const m = { x: s.x + dx * len * 0.5, y: s.y + dy * len * 0.5, z: s.z + dz * len * 0.5 };
    const e = { x: s.x + dx * len, y: s.y + dy * len + 0.2, z: s.z + dz * len };
    tube(b, [{ ...s, r: s.r * 0.45 }, { ...m, r: s.r * 0.25 }, { ...e, r: 0.015 }], 4, col, { rng });
    if (len > 1.5) {
      const az2 = az + (rng() < 0.5 ? 0.7 : -0.7);
      const e2 = { x: m.x + Math.cos(az2) * 0.9, y: m.y + 0.6, z: m.z + Math.sin(az2) * 0.9 };
      tube(b, [{ ...m, r: 0.05 }, { ...e2, r: 0.01 }], 3, col, { rng });
    }
    reach = Math.max(reach, Math.hypot(e.x, e.z));
  }
  // bracket fungi
  const nf = 1 + Math.floor(rng() * 3);
  for (let k = 0; k < nf; k++) {
    const a = rng() * TAU, y = rng.range(0.6, 2.4);
    const r = tr * 1.1;
    const c = rng() < 0.5 ? PAL.fungus : PAL.fungusOrange;
    blob(b, Math.cos(a) * r, y, Math.sin(a) * r, 0.2, 0.05, 0.2, { detail: 0, jitter: 0.1, flatBottom: 0, rng, colorFn: (nx, ny) => jit(c, rng, 0.08, ny > 0 ? 1.1 : 0.75) });
  }
  return b.finish({ type: 'snag', trunkR: tr, canopy: 0.12, crownROverride: Math.max(1.5, reach) });
}

// ── Saplings (instanced; unit size ~3 m when fully grown) ───────────────
export function makeSaplingBroad(rng) {
  const b = new GeoBuilder();
  b.bendFn = bendBy(0.28, 0.2, 3, 1.5);
  const col = () => jit(PAL.barkLight, rng, 0.08);
  tube(b, [{ x: 0, y: -0.1, z: 0, r: 0.07 }, { x: 0.05, y: 1.5, z: 0.02, r: 0.045 }, { x: -0.02, y: 2.7, z: 0, r: 0.01 }], 4, col, { rng });
  b.part('leaf');
  b.flutter = 0.05;
  const lc = leafColorFn(rng, PAL.sapling, PAL.birchLeafLight, PAL.oakLeafDark);
  blob(b, 0.05, 2.45, 0, 0.62, 0.55, 0.62, { detail: 1, jitter: 0.16, rng, colorFn: lc });
  blob(b, 0.4, 1.9, 0.15, 0.45, 0.4, 0.45, { detail: 0, jitter: 0.16, rng, colorFn: lc });
  blob(b, -0.35, 2.05, -0.2, 0.42, 0.38, 0.42, { detail: 0, jitter: 0.16, rng, colorFn: lc });
  return b.finish({ type: 'sapling', trunkR: 0.07, canopy: 0 });
}

export function makeSaplingConifer(rng) {
  const b = new GeoBuilder();
  b.bendFn = bendBy(0.22, 0.2, 3, 1.5);
  tube(b, [{ x: 0, y: -0.1, z: 0, r: 0.07 }, { x: 0, y: 3, z: 0, r: 0 }], 4, () => jit(PAL.bark, rng, 0.08), { rng });
  b.part('leaf');
  b.flutter = 0.02;
  for (let k = 0; k < 3; k++) {
    const r = 0.95 - k * 0.27;
    cone(b, 0, 0.5 + k * 0.75, 0, r, r * 1.5, {
      sides: 6,
      droop: 0.12,
      rng,
      colRim: () => jit(PAL.pineLight, rng, 0.1, 1.1),
      colApex: () => jit(PAL.pineLight, rng, 0.08, 1.2),
      colUnder: () => PAL.pineDark,
    });
  }
  return b.finish({ type: 'sapling', trunkR: 0.07, canopy: 0 });
}

// ── Undergrowth ──────────────────────────────────────────────────────────
export function makeFern(rng) {
  const b = new GeoBuilder();
  b.part('leaf');
  b.bendFn = (x, y) => 0.12 * clamp01(y / 0.6) + 0.04;
  const n = 6 + Math.floor(rng() * 3);
  const az0 = rng() * TAU;
  const shade = rng.range(0.85, 1.12);
  for (let k = 0; k < n; k++) {
    const az = az0 + (k / n) * TAU + (rng() - 0.5) * 0.5;
    const len = rng.range(0.7, 1.15);
    frond(b, Math.cos(az) * 0.05, 0.02, Math.sin(az) * 0.05, [Math.cos(az), Math.sin(az)], {
      len,
      width: len * 0.17,
      lift: rng.range(1.4, 1.8),
      droop: rng.range(1.35, 1.6),
      segs: 4,
      colBase: mul(PAL.fern, 0.6 * shade),
      colTip: mul(PAL.fernLight, shade),
      flutter: 0.05,
      sideDrop: 0.25,
      rng,
    });
  }
  return b.finish({ type: 'fern' });
}

export function makeBush(rng, flowering = false) {
  const b = new GeoBuilder();
  b.part('leaf');
  b.bendFn = (x, y) => 0.1 * clamp01(y / 1.2);
  b.flutter = 0.03;
  const r = rng.range(0.6, 0.95);
  const lc = leafColorFn(rng, PAL.bush, PAL.bushLight, mul(PAL.bush, 0.6));
  const blobs = [{ x: 0, y: r * 0.5, z: 0, r }];
  blob(b, 0, r * 0.5, 0, r, r * 0.78, r * 1.05, { detail: 1, jitter: 0.17, flatBottom: 0.5, rng, colorFn: lc });
  const extra = 1 + Math.floor(rng() * 3);
  for (let k = 0; k < extra; k++) {
    const a = rng() * TAU, d = r * rng.range(0.55, 0.9), rr = r * rng.range(0.5, 0.75);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    blob(b, x, rr * 0.45, z, rr, rr * 0.8, rr, { detail: 0, jitter: 0.18, flatBottom: 0.5, rng, colorFn: lc });
    blobs.push({ x, y: rr * 0.45, z, r: rr });
  }
  if (flowering) {
    const c = rng() < 0.5 ? PAL.blossomWhite : PAL.blossomPink;
    const nbl = 10 + Math.floor(rng() * 8);
    for (let k = 0; k < nbl; k++) {
      const bl = blobs[Math.floor(rng() * blobs.length)];
      const a = rng() * TAU, ny = rng.range(-0.1, 0.9), s = Math.sqrt(1 - ny * ny);
      octa(b, bl.x + Math.cos(a) * s * bl.r * 1.02, bl.y + ny * bl.r * 0.8, bl.z + Math.sin(a) * s * bl.r * 1.02, 0.045, jit(c, rng, 0.05), 0.8, 0.02);
    }
  }
  b.flutter = 0;
  return b.finish({ type: 'bush' });
}

export function makeReeds(rng) {
  const b = new GeoBuilder();
  b.part('leaf');
  const n = 9 + Math.floor(rng() * 6);
  for (let k = 0; k < n; k++) {
    const a = rng() * TAU, d = rng() * 0.35;
    const bx = Math.cos(a) * d, bz = Math.sin(a) * d;
    const h = rng.range(1.1, 1.9);
    const la = a + (rng() - 0.5) * 0.8, lean = rng.range(0.1, 0.4);
    const pts = [];
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      const off = lean * h * t * t;
      pts.push([bx + Math.cos(la) * off, h * t, bz + Math.sin(la) * off]);
    }
    b.bendFn = (x, y) => 0.28 * Math.pow(clamp01(y / 1.6), 1.5);
    strip(b, pts, [0.075, 0.06, 0.035, 0], [-Math.sin(la), 0, Math.cos(la)], (t) => jit(mix(mul(PAL.reed, 0.75), PAL.reedDry, t * t), rng, 0.06), (t) => 0.02 + t * 0.06);
  }
  // cattail-looking heads (decor only; Builder C does the harvestable ones)
  const nh = 2 + Math.floor(rng() * 3);
  for (let k = 0; k < nh; k++) {
    const a = rng() * TAU, d = rng() * 0.25;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const h = rng.range(1.35, 1.85);
    b.bendFn = (xx, y) => 0.22 * Math.pow(clamp01(y / 1.6), 1.5);
    strip(b, [[x, 0, z], [x, h * 0.5, z], [x, h + 0.25, z]], [0.03, 0.025, 0], [1, 0, 0], () => jit(PAL.reed, rng, 0.05), () => 0.01);
    octa(b, x, h - 0.05, z, 0.05, jit(PAL.cattail, rng, 0.1), 3.2, 0.015);
  }
  return b.finish({ type: 'reeds' });
}

export function makeLily(rng) {
  const b = new GeoBuilder();
  b.part('leaf');
  const n = 2 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const a = rng() * TAU, d = k === 0 ? 0 : rng.range(0.4, 0.95);
    const r = rng.range(0.28, 0.52);
    disc(b, Math.cos(a) * d, 0, Math.sin(a) * d, r, 9, jit(mul(PAL.lily, 1.15), rng, 0.06), jit(PAL.lilyDark, rng, 0.08), {
      notch: 0.55,
      rot: rng() * TAU,
      cup: 0.025,
      flutter: 0.012,
    });
  }
  if (rng() < 0.4) {
    // a small water-lily flower
    const c = rng() < 0.5 ? PAL.lotusPink : PAL.lotusWhite;
    const cx = 0.1, cz = 0.05;
    const center = b.v(cx, 0.05, cz, PAL.catkin, 0.012);
    const np = 7;
    for (let k = 0; k < np; k++) {
      const a = (k / np) * TAU;
      const l = b.v(cx + Math.cos(a - 0.3) * 0.06, 0.06, cz + Math.sin(a - 0.3) * 0.06, mul(c, 0.9), 0.012);
      const t = b.v(cx + Math.cos(a) * 0.16, 0.15, cz + Math.sin(a) * 0.16, c, 0.012);
      const r = b.v(cx + Math.cos(a + 0.3) * 0.06, 0.06, cz + Math.sin(a + 0.3) * 0.06, mul(c, 0.9), 0.012);
      b.tri2(center, l, t);
      b.tri2(center, t, r);
    }
  }
  return b.finish({ type: 'lily' });
}

/** Boulder of unit radius (scaled per instance). mossy: 0..1 */
export function makeBoulder(rng, mossy = 0, detail = 1) {
  const b = new GeoBuilder();
  const ry = rng.range(0.55, 0.85), rz = rng.range(0.75, 1.1);
  const tone = rng.range(0, 1);
  blob(b, 0, ry * 0.3, 0, 1, ry, rz, {
    detail,
    jitter: 0.22,
    flatBottom: 0.6,
    rng,
    colorFn: (nx, ny) => {
      const t = ny * 0.5 + 0.5;
      let c = mix(PAL.rockDark, tone < 0.5 ? PAL.rock : PAL.rockLight, 0.25 + 0.6 * t);
      if (mossy > 0 && ny > 0.35) c = mix(c, PAL.moss, Math.min(1, (ny - 0.35) * 2.2) * mossy);
      return jit(c, rng, 0.12);
    },
  });
  return b.finish({ type: 'boulder', rz });
}

export function makeLog(rng) {
  const b = new GeoBuilder();
  const L = rng.range(3.5, 6), r = rng.range(0.24, 0.38);
  const col = (i, j, a) => {
    const up = Math.cos(a);
    let c = jit(rng() < 0.25 ? PAL.barkDark : PAL.bark, rng, 0.1);
    if (up > 0.25) c = mix(c, PAL.moss, Math.min(1, (up - 0.25) * 1.8));
    return c;
  };
  const pts = [];
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    pts.push({ x: -L / 2 + L * t, y: r * 0.75 + (rng() - 0.5) * 0.05, z: (rng() - 0.5) * 0.15, r: r * (1 - 0.15 * t) });
  }
  // start cap (rings face -X)
  const tr = tube(b, pts, 7, col, { rng, jitter: 0.06, capTop: true, capColor: PAL.heartwood });
  const R0 = tr.rings[0];
  const c0 = b.v(pts[0].x, pts[0].y, pts[0].z, PAL.heartwood);
  for (let j = 0; j < R0.length; j++) b.tri(c0, R0[(j + 1) % R0.length], R0[j]);
  return b.finish({ type: 'log', length: L, radius: r });
}

/**
 * Meadow flower object (1-3 heads) with a CLOSED pose stored per vertex (aClose) so the
 * shader can fold the petals up at night. colorIdx indexes PAL.flowers.
 */
export function makeFlower(rng, colorIdx) {
  const b = new GeoBuilder();
  b.cl = [];
  b.part('leaf');
  const [petal, center] = PAL.flowers[colorIdx % PAL.flowers.length];
  const heads = 1 + Math.floor(rng() * 3);
  for (let h = 0; h < heads; h++) {
    const phase = rng();
    const hx = h === 0 ? 0 : (rng() - 0.5) * 0.26, hz = h === 0 ? 0 : (rng() - 0.5) * 0.26;
    const hs = rng.range(0.22, 0.5);
    const lx = (rng() - 0.5) * 0.08, lz = (rng() - 0.5) * 0.08;
    const top = [hx + lx, hs, hz + lz];
    b.bendFn = (x, y) => 0.09 * Math.pow(clamp01(y / 0.45), 2);
    b.closeCur = [0, 0, 0, phase];
    // stem
    strip(b, [[hx, -0.02, hz], [hx + lx * 0.5, hs * 0.55, hz + lz * 0.5], top], [0.025, 0.018, 0.012], [1, 0, 0], (t) => jit(mul(PAL.grass, 0.8 + t * 0.2), rng, 0.05));
    // head
    const pl = rng.range(0.07, 0.12) * (colorIdx === 4 ? 1.25 : 1);
    const np = colorIdx === 5 ? 7 : 5;
    const rot = rng() * TAU;
    b.closeCur = [0, pl * 0.12, 0, phase];
    const C = b.v(top[0], top[1] + 0.01, top[2], center, 0.012);
    const step = TAU / np;
    for (let k = 0; k < np; k++) {
      const a = rot + k * step;
      const ca = Math.cos(a), sa = Math.sin(a);
      const sh = (s) => {
        const aa = a + s * step * 0.42;
        const ox = Math.cos(aa) * pl * 0.6, oz = Math.sin(aa) * pl * 0.6;
        // closed: pulled up and in toward the stem axis
        b.closeCur = [-ox * 0.75, pl * 0.55, -oz * 0.75, phase];
        return b.v(top[0] + ox, top[1] + pl * 0.06, top[2] + oz, mul(petal, 0.92), 0.012);
      };
      const L = sh(-1);
      b.closeCur = [-ca * pl * 0.82, pl * 0.95, -sa * pl * 0.82, phase];
      const T = b.v(top[0] + ca * pl, top[1] + pl * 0.18, top[2] + sa * pl, petal, 0.015);
      const R = sh(1);
      b.tri(C, T, L);
      b.tri(C, R, T);
    }
    b.closeCur = [0, 0, 0, phase];
  }
  return b.finish({ type: 'flower', colorIdx });
}

// ── Library ──────────────────────────────────────────────────────────────
/** Build every variant once. rng: a forked core rng. */
/**
 * The variants baked into the tree chunks (trees + boulders). Every variant has its own named rng fork,
 * so buildLowLibrary() can rebuild exactly the same shapes in low-detail mode.
 */
function chunkVariants(rng) {
  const many = (n, fn) => Array.from({ length: n }, (_, i) => fn(rng.fork('v' + i)));
  return {
    oak: many(7, makeOak),
    pine: many(6, makePine),
    birch: many(6, makeBirch),
    palm: many(6, makePalm),
    willow: many(4, makeWillow),
    apple: many(5, makeApple),
    chestnut: many(5, makeChestnut),
    snag: many(5, makeSnag),
    windPine: Array.from({ length: 4 }, (_, i) => makeWindPine(rng.fork('wp' + i))), // v3: Tempest Isle
    boulder: [...many(4, (r) => makeBoulder(r, 0)), ...many(4, (r) => makeBoulder(r, 0.85))],
  };
}

/**
 * V4-E tree LOD: the same tree/boulder variants as buildLibrary(rng) (same rng!) with ≈¼ of the
 * triangles (see builder.js, low-detail mode). Same keys and indices as the full library.
 */
export function buildLowLibrary(rng) {
  return withLowDetail(() => chunkVariants(rng));
}

export function buildLibrary(rng) {
  const many = (n, fn) => Array.from({ length: n }, (_, i) => fn(rng.fork('v' + i)));
  const lib = {
    ...chunkVariants(rng),
    carvedOak: makeCarvedOak(rng.fork('carved')),
    saplingBroad: makeSaplingBroad(rng.fork('sapB')),
    saplingConifer: makeSaplingConifer(rng.fork('sapC')),
    fern: many(5, makeFern),
    bush: [...many(4, (r) => makeBush(r, false)), ...many(2, (r) => makeBush(r, true))],
    reeds: many(4, makeReeds),
    lily: many(4, makeLily),
    rock: many(5, (r) => makeBoulder(r, 0.3, 0)),
    log: many(3, makeLog),
    flower: [],
  };
  for (let c = 0; c < PAL.flowers.length; c++) for (let k = 0; k < 3; k++) lib.flower.push(makeFlower(rng.fork(`f${c}_${k}`), c));
  // Effective crown radius (snags use branch reach)
  for (const key of ['oak', 'pine', 'birch', 'palm', 'willow', 'apple', 'chestnut', 'snag']) {
    for (const v of lib[key]) if (v.crownROverride) v.crownR = v.crownROverride;
  }
  return lib;
}
