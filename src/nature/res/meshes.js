// Procedural low-poly meshes for every harvestable kind + beach decor (Builder C).
// Each function returns a BufferGeometry (or an object of geometries for multi-part kinds),
// origin at the ground contact point, +Y up, sizes in meters (slightly larger than life so they
// read well in first person). Colors follow the SPEC §9 palette.
import * as THREE from 'three';
import { GeoBuilder, xf, lumpy, bladeGeometry, leafGeometry, hash3 } from './geo.js';

const PI = Math.PI;
const TAU = PI * 2;

// Palette
const C = {
  bark: 0x6b4f36,
  barkLight: 0x86664a,
  drift: 0xa89a88,
  driftLight: 0xcfc4b0,
  rock: 0x8a847a,
  rockLight: 0xa7a197,
  darkRock: 0x5d5750,
  flint: 0x2b3442,
  flintTop: 0x46546a,
  cortex: 0xd8d2c2,
  pyrite: 0xc9a640,
  pyriteHi: 0xe2c45a,
  leaf: 0x4f8a35,
  leafDark: 0x3a6a2a,
  leafLight: 0x6fae45,
  meadow: 0x8fb84f,
  grass: 0x6a9a3e,
};

const rnd = (rand, a, b) => a + (b - a) * rand();

// ── Minerals & wood ──────────────────────────────────────────────────────
export function stickGeometry(rand) {
  const b = new GeoBuilder(rand);
  b.add(new THREE.CylinderGeometry(0.028, 0.042, 1.15, 5), { m: xf([0, 0.04, 0], [0, 0.15, PI / 2 + 0.03]), color: C.bark, jitter: 0.12 });
  b.add(new THREE.CylinderGeometry(0.022, 0.034, 0.85, 5), { m: xf([0.05, 0.075, 0.06], [0, -0.75, PI / 2 - 0.05]), color: C.barkLight, jitter: 0.12 });
  // forked twig
  b.add(new THREE.CylinderGeometry(0.01, 0.018, 0.4, 4), { m: xf([0.32, 0.05, 0.13], [0, 0.9, PI / 2]), color: C.bark });
  b.add(new THREE.CylinderGeometry(0.008, 0.014, 0.28, 4), { m: xf([-0.3, 0.06, -0.08], [0, -0.5, PI / 2 + 0.1]), color: C.barkLight });
  // two dry leaves still attached
  b.add(leafGeometry(0.09, 0.05, 4), { m: xf([0.45, 0.06, 0.22], [0, 0.6, 0]), color: 0x9a7a3a });
  b.add(leafGeometry(0.08, 0.045, 4), { m: xf([-0.4, 0.07, -0.13], [0.1, 2.4, 0]), color: 0x8a6a2c });
  return b.build();
}

export function stoneGeometry(rand) {
  const b = new GeoBuilder(rand);
  b.add(lumpy(new THREE.DodecahedronGeometry(0.17, 0), 0.2, 1), { m: xf([0, 0.07, 0], [0.2, 0.5, 0.1], [1.3, 0.62, 1.05]), color: C.rock, top: C.rockLight, jitter: 0.1 });
  b.add(lumpy(new THREE.IcosahedronGeometry(0.075, 0), 0.25, 2), { m: xf([0.22, 0.03, 0.1], [0.4, 1.1, 0], [1.2, 0.7, 1]), color: 0x968e84, jitter: 0.1 });
  return b.build();
}

/** Flint: a dark glassy knapped flake with a chalky cortex chunk and a loose sharp shard. */
export function flintGeometry(rand) {
  const b = new GeoBuilder(rand);
  const glass = [0.12, 0.14, 0.35];
  const cortex = [0, 0.95, 0];
  b.add(lumpy(new THREE.OctahedronGeometry(0.13, 0), 0.28, 3), { m: xf([0, 0.06, 0], [0.15, 0.4, 0.1], [1.5, 0.55, 1.0]), color: C.flint, top: C.flintTop, jitter: 0.16, pbr: glass });
  b.add(lumpy(new THREE.IcosahedronGeometry(0.075, 0), 0.25, 4), { m: xf([-0.16, 0.05, -0.03], [0.3, 0, 0.2], [1.1, 0.75, 1]), color: C.cortex, jitter: 0.06, pbr: cortex });
  b.add(lumpy(new THREE.TetrahedronGeometry(0.07, 0), 0.2, 5), { m: xf([0.2, 0.025, 0.12], [0.3, 0.9, 1.2], [1.4, 0.5, 0.9]), color: C.flint, top: C.flintTop, jitter: 0.18, pbr: glass });
  return b.build();
}

/** Pyrite: brassy cubic crystals growing out of a dark rock matrix. */
export function pyriteGeometry(rand) {
  const b = new GeoBuilder(rand);
  b.add(lumpy(new THREE.DodecahedronGeometry(0.15, 0), 0.24, 6), { m: xf([0, 0.06, 0], [0.2, 0.3, 0], [1.35, 0.55, 1.1]), color: C.darkRock, top: 0x787168, jitter: 0.1, pbr: [0, 0.92, 0] });
  const cubes = [
    [0, 0.13, 0, 0.085],
    [0.08, 0.1, 0.05, 0.06],
    [-0.07, 0.11, -0.02, 0.07],
    [0.03, 0.17, -0.06, 0.05],
    [-0.12, 0.07, 0.07, 0.045],
    [0.13, 0.07, -0.06, 0.04],
    [-0.02, 0.09, 0.1, 0.05],
  ];
  for (const [x, y, z, s] of cubes) {
    b.add(new THREE.BoxGeometry(s, s, s), {
      m: xf([x, y, z], [rnd(rand, -0.5, 0.5), rnd(rand, 0, TAU), rnd(rand, -0.5, 0.5)]),
      color: rand() < 0.5 ? C.pyrite : C.pyriteHi,
      jitter: 0.12,
      pbr: [1, 0.3, 1],
    });
  }
  return b.build();
}

export function driftwoodPieceGeometry(rand) {
  const b = new GeoBuilder(rand);
  b.add(new THREE.CylinderGeometry(0.05, 0.075, 0.9, 6), { m: xf([0, 0.06, 0], [0, 0, PI / 2 + 0.06]), color: C.drift, top: C.driftLight, jitter: 0.1 });
  b.add(new THREE.CylinderGeometry(0.035, 0.05, 0.5, 5), { m: xf([0.55, 0.07, 0.16], [0, 0.65, PI / 2 - 0.05]), color: C.driftLight, jitter: 0.1 });
  b.add(new THREE.CylinderGeometry(0.012, 0.025, 0.22, 4), { m: xf([-0.2, 0.12, 0.05], [0.9, 0, 0.3]), color: C.drift });
  return b.build();
}

// ── Bushes & leafy plants ────────────────────────────────────────────────
/** Berry bush: { bush, berries } sharing the same clump layout (berries sway with the bush). */
export function berryBushGeometry(rand) {
  const clumps = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + rnd(rand, -0.3, 0.3);
    const d = i === 0 ? 0 : rnd(rand, 0.22, 0.38);
    const r = i === 0 ? 0.36 : rnd(rand, 0.22, 0.3);
    clumps.push([Math.cos(a) * d, i === 0 ? 0.55 : rnd(rand, 0.3, 0.55), Math.sin(a) * d, r]);
  }
  const H = 0.95;
  const bush = new GeoBuilder(rand);
  for (let i = 0; i < 4; i++) {
    const a = rand() * TAU;
    bush.add(new THREE.CylinderGeometry(0.012, 0.022, 0.4, 4), { m: xf([Math.cos(a) * 0.08, 0.18, Math.sin(a) * 0.08], [Math.sin(a) * 0.4, 0, -Math.cos(a) * 0.4]), color: C.bark });
  }
  for (const [x, y, z, r] of clumps) {
    bush.add(lumpy(new THREE.IcosahedronGeometry(r, 1), 0.16, x * 9 + z * 5), {
      m: xf([x, y, z], [0, rand() * TAU, 0], [1, 0.85, 1]),
      color: C.leafDark,
      top: C.leaf,
      jitter: 0.12,
      sway: 0.045,
    });
  }
  const berries = new GeoBuilder(rand);
  const v = new THREE.Vector3();
  let placed = 0;
  for (let tries = 0; tries < 200 && placed < 26; tries++) {
    const [x, y, z, r] = clumps[Math.floor(rand() * clumps.length)];
    v.set(rand() - 0.5, rand() * 0.9 - 0.2, rand() - 0.5).normalize();
    const px = x + v.x * r * 0.98, py = y + v.y * r * 0.85, pz = z + v.z * r * 0.98;
    if (py < 0.16) continue;
    const ripe = rand() < 0.78;
    // blackberry = little cluster of drupelets: approximate with a detail-0 icosahedron
    berries.add(new THREE.IcosahedronGeometry(ripe ? 0.034 : 0.028, 0), {
      m: xf([px, py, pz], [rand(), rand(), rand()], [1, 1.12, 1]),
      color: ripe ? (rand() < 0.5 ? 0x2a1636 : 0x3a1d4a) : 0x9a2432,
      jitter: 0.2,
      sway: 0.045,
    });
    placed++;
  }
  return { bush: bush.build({ swayHeight: H }), berries: berries.build({ swayHeight: H }) };
}

/** Leafy shrub (gives leaves): { twigs (static), foliage (regrows) }. */
export function shrubGeometry(rand) {
  const H = 0.95;
  const twigs = new GeoBuilder(rand);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + rand() * 0.5;
    const tilt = rnd(rand, 0.25, 0.6);
    twigs.add(new THREE.CylinderGeometry(0.01, 0.022, 0.7, 4), {
      m: xf([Math.cos(a) * 0.12, 0.32, Math.sin(a) * 0.12], [Math.sin(a) * tilt, 0, -Math.cos(a) * tilt]),
      color: 0x5a4630,
      sway: 0.03,
    });
  }
  const fol = new GeoBuilder(rand);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + rand() * 0.6;
    const d = i === 0 ? 0 : rnd(rand, 0.18, 0.32);
    const r = i === 0 ? 0.34 : rnd(rand, 0.2, 0.27);
    fol.add(lumpy(new THREE.IcosahedronGeometry(r, 1), 0.2, i * 3.3 + 1), {
      m: xf([Math.cos(a) * d, i === 0 ? 0.6 : rnd(rand, 0.4, 0.62), Math.sin(a) * d], [0, rand() * TAU, 0], [1, 0.9, 1]),
      color: 0x5f9a3a,
      top: 0x86bd52,
      jitter: 0.13,
      sway: 0.05,
    });
  }
  return { twigs: twigs.build({ swayHeight: H }), foliage: fol.build({ swayHeight: H }) };
}

export function tallGrassGeometry(rand) {
  const b = new GeoBuilder(rand);
  for (let i = 0; i < 16; i++) {
    const a = rand() * TAU;
    const h = rnd(rand, 0.65, 1.15);
    const d = rnd(rand, 0, 0.14);
    b.add(bladeGeometry(rnd(rand, 0.045, 0.065), h, rnd(rand, 0.15, 0.4), 3), {
      m: xf([Math.cos(a) * d, 0, Math.sin(a) * d], [rnd(rand, -0.15, 0.1), a, 0]),
      color: 0x7f9440,
      top: rand() < 0.5 ? 0xc9c274 : 0xb6bf66,
      jitter: 0.1,
      sway: 0.15,
    });
  }
  for (let i = 0; i < 4; i++) {
    const a = rand() * TAU;
    const h = rnd(rand, 0.95, 1.25);
    b.add(new THREE.CylinderGeometry(0.004, 0.006, h, 3), { m: xf([Math.cos(a) * 0.06, h / 2, Math.sin(a) * 0.06], [rnd(rand, -0.12, 0.12), 0, rnd(rand, -0.12, 0.12)]), color: 0x9aa050, sway: 0.15 });
    b.add(new THREE.CylinderGeometry(0.014, 0.008, 0.14, 4), { m: xf([Math.cos(a) * 0.06 + 0.02, h + 0.04, Math.sin(a) * 0.06], [0.1, 0, 0.1]), color: 0xc8b46a, sway: 0.15 });
  }
  return b.build({ swayHeight: 1.2 });
}

export function nettleGeometry(rand) {
  const b = new GeoBuilder(rand);
  for (let s = 0; s < 5; s++) {
    const a = (s / 5) * TAU + rand() * 0.7;
    const d = rnd(rand, 0.03, 0.14);
    const h = rnd(rand, 0.5, 0.8);
    const bx = Math.cos(a) * d, bz = Math.sin(a) * d;
    b.add(new THREE.CylinderGeometry(0.006, 0.01, h, 4), { m: xf([bx, h / 2, bz], [0, 0, 0]), color: 0x4a6a2a, sway: 0.07 });
    for (let k = 0; k < 4; k++) {
      const y = h * (0.3 + k * 0.2);
      const yaw = k * (PI / 2) + rand() * 0.3;
      const len = 0.13 - k * 0.018;
      for (const side of [0, PI]) {
        b.add(leafGeometry(len, len * 0.62, 6, 'serrated'), {
          m: xf([bx, y, bz], [-0.35, yaw + side, 0]),
          color: 0x34602a,
          top: 0x4f7d34,
          jitter: 0.1,
          sway: 0.07,
        });
      }
    }
    // drooping flower tassel
    b.add(bladeGeometry(0.012, 0.12, -0.6, 2), { m: xf([bx, h * 0.82, bz], [0.3, a, 0]), color: 0x7a8a4a, sway: 0.07 });
  }
  return b.build({ swayHeight: 0.85 });
}

export function yamGeometry(rand) {
  const b = new GeoBuilder(rand);
  // soil mound + a tuber peeking out
  b.add(new THREE.SphereGeometry(0.22, 7, 3, 0, TAU, 0, PI / 2), { m: xf([0, 0, 0], [0, 0, 0], [1, 0.32, 1]), color: 0x5a4430, jitter: 0.14 });
  b.add(lumpy(new THREE.IcosahedronGeometry(0.07, 0), 0.25, 9), { m: xf([0.09, 0.06, 0.05], [0.4, 0, 0.9], [1.5, 0.8, 0.9]), color: 0x8a6a4a, jitter: 0.12 });
  // a dead stake the vine climbs
  b.add(new THREE.CylinderGeometry(0.012, 0.02, 0.75, 4), { m: xf([-0.02, 0.36, 0], [0.08, 0, -0.06]), color: C.bark });
  // helical vine with heart-shaped leaves
  let px = 0, py = 0.04, pz = 0;
  for (let i = 1; i <= 9; i++) {
    const t = i / 9;
    const a = t * TAU * 1.6;
    const x = Math.cos(a) * 0.05, y = 0.04 + t * 0.66, z = Math.sin(a) * 0.05;
    const dx = x - px, dy = y - py, dz = z - pz;
    const len = Math.hypot(dx, dy, dz);
    const seg = new THREE.CylinderGeometry(0.005, 0.006, len, 3);
    const mid = new THREE.Vector3((x + px) / 2, (y + py) / 2, (z + pz) / 2);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dz).normalize());
    seg.applyQuaternion(q).translate(mid.x, mid.y, mid.z);
    b.add(seg, { color: 0x4f7a2c, sway: 0.04 });
    if (i % 1 === 0 && i > 1) {
      const lsz = rnd(rand, 0.09, 0.13);
      b.add(leafGeometry(lsz, lsz * 0.9, 6, 'heart'), {
        m: xf([x, y, z], [rnd(rand, -0.5, -0.1), a + PI / 2 + rnd(rand, -0.4, 0.4), 0]),
        color: 0x4f8030,
        top: 0x6f9e40,
        jitter: 0.1,
        sway: 0.04,
      });
    }
    (px = x), (py = y), (pz = z);
  }
  // a couple of trailing ground leaves
  for (let i = 0; i < 3; i++) {
    const a = rand() * TAU;
    b.add(leafGeometry(0.11, 0.1, 6, 'heart'), { m: xf([Math.cos(a) * 0.2, 0.05, Math.sin(a) * 0.2], [0.05, a, 0]), color: 0x4a7a2c, sway: 0.02 });
  }
  return b.build({ swayHeight: 0.75 });
}

export function cattailGeometry(rand) {
  const b = new GeoBuilder(rand);
  for (let i = 0; i < 6; i++) {
    const a = rand() * TAU;
    const d = rnd(rand, 0, 0.18);
    const h = rnd(rand, 1.1, 1.65);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const lean = rnd(rand, -0.06, 0.06);
    b.add(new THREE.CylinderGeometry(0.006, 0.01, h, 4), { m: xf([x, h / 2, z], [lean, 0, lean]), color: 0x6f8f3a, sway: 0.13 });
    b.add(new THREE.CylinderGeometry(0.024, 0.024, 0.17, 6), { m: xf([x - lean * h * 0.84, h * 0.84, z + lean * h * 0.84], [lean, 0, lean]), color: 0x5a3820, jitter: 0.08, sway: 0.13 });
    b.add(new THREE.CylinderGeometry(0.002, 0.004, 0.14, 3), { m: xf([x - lean * h, h + 0.02, z + lean * h], [lean, 0, lean]), color: 0x8a7a50, sway: 0.13 });
  }
  for (let i = 0; i < 9; i++) {
    const a = rand() * TAU;
    b.add(bladeGeometry(rnd(rand, 0.03, 0.045), rnd(rand, 0.8, 1.35), rnd(rand, 0.2, 0.45), 3), {
      m: xf([Math.cos(a) * 0.08, 0, Math.sin(a) * 0.08], [rnd(rand, -0.1, 0.05), a, 0]),
      color: 0x5f8236,
      top: 0x93ad52,
      jitter: 0.08,
      sway: 0.13,
    });
  }
  return b.build({ swayHeight: 1.6 });
}

export function aloeGeometry(rand) {
  const b = new GeoBuilder(rand);
  const n = 12;
  for (let i = 0; i < n; i++) {
    const inner = i >= 8;
    const a = (i / (inner ? 4 : 8)) * TAU + (inner ? 0.4 : 0) + rnd(rand, -0.15, 0.15);
    const len = inner ? rnd(rand, 0.26, 0.32) : rnd(rand, 0.34, 0.46);
    const tilt = inner ? rnd(rand, 0.2, 0.4) : rnd(rand, 0.7, 1.05);
    const g = new THREE.ConeGeometry(0.045, len, 4);
    g.translate(0, len / 2, 0);
    g.scale(1, 1, 0.42);
    b.add(g, { m: xf([0, 0.02, 0], [0, a, tilt], 1), color: 0x5f8f68, top: 0x9ab48a, jitter: 0.12, sway: 0.02 });
  }
  return b.build({ swayHeight: 0.4 });
}

export function yarrowGeometry(rand) {
  const b = new GeoBuilder(rand);
  for (let s = 0; s < 4; s++) {
    const a = rand() * TAU;
    const d = rnd(rand, 0.02, 0.12);
    const h = rnd(rand, 0.42, 0.65);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    b.add(new THREE.CylinderGeometry(0.005, 0.008, h, 3), { m: xf([x, h / 2, z]), color: 0x6a8a3a, sway: 0.08 });
    // feathery leaves
    for (let k = 0; k < 4; k++) {
      const y = h * (0.15 + k * 0.16);
      b.add(bladeGeometry(0.03, rnd(rand, 0.12, 0.18), 0.5, 2), { m: xf([x, y, z], [0.9, rand() * TAU, 0]), color: 0x5f8a3a, top: 0x7aa04a, sway: 0.08 });
    }
    // flat-topped white umbel
    b.add(new THREE.CylinderGeometry(0.07, 0.035, 0.03, 8), { m: xf([x, h, z]), color: 0xe9e6d6, jitter: 0.05, sway: 0.08 });
    for (let k = 0; k < 7; k++) {
      const fa = (k / 7) * TAU;
      b.add(new THREE.IcosahedronGeometry(0.016, 0), { m: xf([x + Math.cos(fa) * 0.045, h + 0.018, z + Math.sin(fa) * 0.045]), color: k % 3 ? 0xf6f3e8 : 0xf0e4ea, sway: 0.08 });
    }
  }
  return b.build({ swayHeight: 0.65 });
}

export function chamomileGeometry(rand) {
  const b = new GeoBuilder(rand);
  for (let i = 0; i < 7; i++) {
    const a = rand() * TAU;
    b.add(bladeGeometry(0.02, rnd(rand, 0.1, 0.16), 0.6, 2), { m: xf([Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05], [0.4, a, 0]), color: 0x6a9a3e, top: 0x8ab858, sway: 0.03 });
  }
  for (let i = 0; i < 11; i++) {
    const a = rand() * TAU;
    const d = rnd(rand, 0, 0.15);
    const h = rnd(rand, 0.16, 0.3);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const tx = rnd(rand, -0.25, 0.25), tz = rnd(rand, -0.25, 0.25);
    b.add(new THREE.CylinderGeometry(0.003, 0.004, h, 3), { m: xf([x, h / 2, z]), color: 0x6a9a3e, sway: 0.05 });
    const petals = new THREE.CircleGeometry(0.026, 10);
    // notch every other rim vertex inward -> petal look
    const p = petals.attributes.position;
    for (let k = 1; k < p.count; k++) if (k % 2 === 0) p.setXYZ(k, p.getX(k) * 0.55, p.getY(k) * 0.55, 0);
    b.add(petals, { m: xf([x, h, z], [-PI / 2 + tx, 0, tz]), color: 0xf8f6ee, jitter: 0.03, sway: 0.05 });
    b.add(new THREE.SphereGeometry(0.01, 5, 3), { m: xf([x, h + 0.006, z], [0, 0, 0], [1, 0.7, 1]), color: 0xf2c11e, sway: 0.05 });
  }
  return b.build({ swayHeight: 0.3 });
}

// ── Fruit, nuts & fungi ──────────────────────────────────────────────────
export function applePileGeometry(rand) {
  const b = new GeoBuilder(rand);
  const spots = [[0, 0], [0.11, 0.05], [-0.06, 0.1]];
  for (const [x, z] of spots) {
    const r = rnd(rand, 0.042, 0.052);
    b.add(new THREE.SphereGeometry(r, 7, 5), { m: xf([x, r * 0.9, z], [rand(), rand(), rand()], [1, 0.9, 1]), color: 0xa6bf3c, top: rand() < 0.6 ? 0xc8402a : 0xb8b040, jitter: 0.08 });
    b.add(new THREE.CylinderGeometry(0.003, 0.004, 0.025, 3), { m: xf([x, r * 1.8, z], [0.3, 0, 0.2]), color: 0x5a3a1e });
  }
  b.add(leafGeometry(0.07, 0.035, 4), { m: xf([0.02, 0.012, -0.08], [0, 0.7, 0]), color: 0x8a7a30 });
  b.add(leafGeometry(0.06, 0.03, 4), { m: xf([0.15, 0.01, 0.12], [0, 2.4, 0]), color: C.leaf });
  return b.build();
}

export function chestnutPileGeometry(rand) {
  const b = new GeoBuilder(rand);
  // spiky burrs
  for (const [x, z, green] of [[0, 0, true], [0.13, 0.06, false]]) {
    const g = new THREE.IcosahedronGeometry(0.06, 1);
    lumpy(g, 0.5, x * 10 + 1);
    b.add(g, { m: xf([x, 0.05, z], [rand(), rand(), 0]), color: green ? 0x8a9a3a : 0x8a6a3a, top: green ? 0xa8b04a : 0x9a7a48, jitter: 0.14 });
  }
  // glossy nuts
  for (const [x, z] of [[0.07, -0.07], [-0.08, 0.07], [0.04, 0.12]]) {
    b.add(new THREE.SphereGeometry(0.03, 6, 4), { m: xf([x, 0.022, z], [0.3, rand() * TAU, 0], [1.05, 0.78, 1.15]), color: 0x6b3a1e, top: 0x8a5230, jitter: 0.1 });
  }
  return b.build();
}

export function coconutPileGeometry(rand) {
  const b = new GeoBuilder(rand);
  b.add(lumpy(new THREE.SphereGeometry(0.13, 8, 6), 0.06, 11), { m: xf([0, 0.12, 0], [0.4, 0.3, 0], [1, 0.95, 1.18]), color: 0x6b4a2a, top: 0x86603a, jitter: 0.12 });
  b.add(lumpy(new THREE.SphereGeometry(0.12, 8, 6), 0.05, 12), { m: xf([0.24, 0.11, 0.08], [1.2, 0.8, 0], [1, 0.95, 1.18]), color: 0x6f7a2a, top: 0x8a9038, jitter: 0.1 });
  // a dry husk fiber tuft
  b.add(bladeGeometry(0.04, 0.12, 0.3, 2), { m: xf([0.1, 0.0, -0.1], [1.2, 0.5, 0]), color: 0x9a7a4a });
  return b.build();
}

function chanterelleCap(rand, scale) {
  const pts = [
    [0.012, 0],
    [0.015, 0.035],
    [0.022, 0.058],
    [0.04, 0.078],
    [0.062, 0.09],
    [0.066, 0.086],
    [0.045, 0.08],
    [0.02, 0.074],
    [0.0, 0.07],
  ].map(([x, y]) => new THREE.Vector2(x * scale, y * scale));
  const g = new THREE.LatheGeometry(pts, 9);
  // wavy rim
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = Math.hypot(v.x, v.z);
    if (r > 0.035 * scale) {
      const a = Math.atan2(v.z, v.x);
      const w = 1 + 0.12 * Math.sin(a * 5 + scale * 7);
      v.x *= w;
      v.z *= w;
      v.y += 0.008 * scale * Math.sin(a * 5 + 1.3);
      p.setXYZ(i, v.x, v.y, v.z);
    }
  }
  return g;
}

export function chanterelleGeometry(rand) {
  const b = new GeoBuilder(rand);
  for (const [x, z, s] of [[0, 0, 1.25], [0.09, 0.05, 1.0], [-0.06, 0.08, 0.85], [0.03, -0.09, 0.75], [-0.1, -0.04, 0.6]]) {
    b.add(chanterelleCap(rand, s * 1.3), { m: xf([x, 0, z], [rnd(rand, -0.15, 0.15), rand() * TAU, rnd(rand, -0.15, 0.15)]), color: 0xd8902a, top: 0xf4c24a, jitter: 0.08 });
  }
  b.add(leafGeometry(0.08, 0.04, 4), { m: xf([0.12, 0.008, -0.04], [0, 1.4, 0]), color: 0x7a5a2a });
  return b.build();
}

export function toadstoolGeometry(rand) {
  const b = new GeoBuilder(rand);
  for (const [x, z, s] of [[0, 0, 1.25], [0.11, 0.07, 0.8]]) {
    const h = 0.13 * s;
    const r = 0.08 * s;
    b.add(new THREE.CylinderGeometry(0.018 * s, 0.028 * s, h, 7), { m: xf([x, h / 2, z]), color: 0xf0ece0, jitter: 0.04 });
    // little ring (annulus) on the stem
    b.add(new THREE.CylinderGeometry(0.03 * s, 0.022 * s, 0.012 * s, 7), { m: xf([x, h * 0.72, z]), color: 0xe8e2d2, jitter: 0.04 });
    b.add(new THREE.SphereGeometry(r, 10, 5, 0, TAU, 0, PI / 2), { m: xf([x, h * 0.92, z], [0, 0, 0], [1, 0.66, 1]), color: 0xb8221a, top: 0xdc3a24, jitter: 0.06 });
    b.add(new THREE.CircleGeometry(r * 0.98, 10), { m: xf([x, h * 0.92, z], [PI / 2, 0, 0]), color: 0xf0e6cc, jitter: 0.03 });
    // white warts on the cap (on the hemisphere surface)
    const nSpots = s > 1 ? 9 : 5;
    for (let k = 0; k < nSpots; k++) {
      const theta = rand() * TAU;
      const phi = rnd(rand, 0.15, 1.2);
      const sx = Math.sin(phi) * Math.sin(theta) * r, sy = Math.cos(phi) * r * 0.66, sz = Math.sin(phi) * Math.cos(theta) * r;
      b.add(new THREE.IcosahedronGeometry(0.012 * s, 0), { m: xf([x + sx, h * 0.92 + sy, z + sz], [phi, theta, 0], [1, 0.45, 1]), color: 0xf8f4ea, jitter: 0.03 });
    }
  }
  return b.build();
}

// ── Bamboo ───────────────────────────────────────────────────────────────
/** Bamboo cane: { stump (static), stalk (regrows as a shoot) }. ~6.7 m tall. */
export function bambooGeometry(rand) {
  const stump = new GeoBuilder(rand);
  stump.add(new THREE.CylinderGeometry(0.06, 0.068, 0.3, 7), { m: xf([0, 0.15, 0]), color: 0x8aa040, jitter: 0.08 });
  stump.add(new THREE.CircleGeometry(0.06, 7), { m: xf([0, 0.301, 0], [-PI / 2, 0, 0]), color: 0xd8d4a0 });
  const st = new GeoBuilder(rand);
  const segs = 9;
  const segH = 0.75;
  let y = 0;
  for (let i = 0; i < segs; i++) {
    const r0 = 0.055 - i * 0.003, r1 = 0.052 - i * 0.003;
    st.add(new THREE.CylinderGeometry(r1, r0, segH - 0.03, 7), { m: xf([0, y + segH / 2, 0]), color: i % 2 ? 0x7a9a3a : 0x86a644, top: 0x93b04c, jitter: 0.05, sway: 0.4 });
    st.add(new THREE.CylinderGeometry(r0 + 0.008, r0 + 0.008, 0.035, 7), { m: xf([0, y + segH - 0.015, 0]), color: 0xaab860, sway: 0.4 });
    if (i >= 4) {
      // side twig + a cluster of lance leaves
      const a = rand() * TAU;
      const ty = y + segH - 0.02;
      st.add(new THREE.CylinderGeometry(0.006, 0.01, 0.45, 3), { m: xf([Math.cos(a) * 0.2, ty + 0.12, Math.sin(a) * 0.2], [Math.sin(a) * 1.0, 0, -Math.cos(a) * 1.0]), color: 0x8aa040, sway: 0.4 });
      for (let k = 0; k < 4; k++) {
        st.add(leafGeometry(rnd(rand, 0.2, 0.28), 0.045, 4, 'lance'), {
          m: xf([Math.cos(a) * 0.38, ty + 0.2 + k * 0.03, Math.sin(a) * 0.38], [rnd(rand, 0.3, 0.8), -a + PI / 2 + rnd(rand, -0.9, 0.9), 0]),
          color: 0x5f9a38,
          top: 0x8fbc50,
          jitter: 0.1,
          sway: 0.4,
        });
      }
    }
    y += segH;
  }
  // top leaf crown
  for (let k = 0; k < 7; k++) {
    st.add(leafGeometry(rnd(rand, 0.22, 0.3), 0.05, 4, 'lance'), { m: xf([0, y, 0], [rnd(rand, -1.1, -0.4), (k / 7) * TAU, 0]), color: 0x6aa23e, top: 0x9ac65a, sway: 0.4 });
  }
  return { stump: stump.build(), stalk: st.build({ swayHeight: y }) };
}

// ── Decor ────────────────────────────────────────────────────────────────
export function driftLogGeometry(rand) {
  const b = new GeoBuilder(rand);
  b.add(new THREE.CylinderGeometry(0.15, 0.21, 3.2, 7), { m: xf([0, 0.17, 0], [0, 0, PI / 2 + 0.03]), color: 0x9c8e7c, top: 0xc0b5a2, jitter: 0.1 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * TAU + 0.3;
    const g = new THREE.ConeGeometry(0.07, 0.75, 4);
    g.translate(0, 0.37, 0);
    b.add(g, { m: xf([-1.55, 0.18, 0], [Math.cos(a) * 0.9, 0, PI / 2 + Math.sin(a) * 0.9]), color: 0xa89a86, jitter: 0.1 });
  }
  b.add(new THREE.CylinderGeometry(0.03, 0.06, 0.7, 5), { m: xf([0.6, 0.38, 0.1], [0.5, 0, -0.5]), color: 0xb0a490 });
  b.add(new THREE.CylinderGeometry(0.02, 0.045, 0.5, 5), { m: xf([1.0, 0.2, -0.3], [-1.0, 0, 0.2]), color: 0xb0a490 });
  return b.build();
}

export function shellGeometry(rand) {
  const b = new GeoBuilder(rand);
  // scallop: half-fan with radial ridges
  const g = new THREE.CircleGeometry(0.045, 9, 0, PI);
  const p = g.attributes.position;
  for (let i = 1; i < p.count; i++) p.setZ(i, i % 2 ? 0.006 : 0);
  b.add(g, { m: xf([0, 0.012, 0], [-PI / 2 + 0.25, 0, 0]), color: 0xffffff, jitter: 0.08 });
  b.add(new THREE.BoxGeometry(0.03, 0.008, 0.012), { m: xf([0, 0.006, 0.004]), color: 0xeeeeee });
  // a little cowrie next to it
  b.add(new THREE.SphereGeometry(0.018, 6, 4), { m: xf([0.07, 0.008, 0.03], [0, 0.6, 0], [1.4, 0.6, 1]), color: 0xf2e8d8, jitter: 0.06 });
  return b.build();
}

export function boulderGeometry(rand) {
  const b = new GeoBuilder(rand);
  b.add(lumpy(new THREE.DodecahedronGeometry(1, 1), 0.2, 21), { m: xf([0, 0.35, 0], [0.2, 0.4, 0.1], [1, 0.75, 0.9]), color: 0x6a645c, top: 0x8f897f, jitter: 0.09 });
  return b.build();
}

/** Generic dropped bundle (cloth-wrapped) for items without a dedicated mesh. */
export function bundleGeometry(rand) {
  const b = new GeoBuilder(rand);
  b.add(new THREE.SphereGeometry(0.13, 7, 5), { m: xf([0, 0.09, 0], [0, 0, 0], [1, 0.7, 0.9]), color: 0xd2bf94, top: 0xe4d4ae, jitter: 0.08 });
  b.add(new THREE.ConeGeometry(0.05, 0.1, 5), { m: xf([0, 0.2, 0]), color: 0xc8b48a });
  b.add(new THREE.TorusGeometry(0.035, 0.009, 4, 8), { m: xf([0, 0.165, 0], [PI / 2, 0, 0]), color: 0x8a6a3a });
  return b.build();
}

/** Fallback palm (used only if flora has no palm near the spawn). ~6 m. */
export function palmGeometry(rand) {
  const b = new GeoBuilder(rand);
  let x = 0, z = 0, y = 0;
  const segs = 8;
  const lean = 0.09;
  for (let i = 0; i < segs; i++) {
    const h = 0.72;
    const r = 0.17 - i * 0.009;
    b.add(new THREE.CylinderGeometry(r * 0.92, r, h, 7), { m: xf([x, y + h / 2, z], [0, 0, -lean * (i / segs)]), color: i % 2 ? 0x7a5e40 : 0x8a6c4a, jitter: 0.06, sway: 0.25 });
    x += Math.sin(lean * (i / segs)) * h;
    y += h * 0.99;
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU + rand() * 0.3;
    const len = rnd(rand, 2.0, 2.6);
    const f = bladeGeometry(0.42, len, 0.35, 5);
    b.add(f, { m: xf([x, y, z], [PI / 2 - 0.35, a, 0]), color: 0x5c9235, top: 0x7fb04a, jitter: 0.08, sway: 0.25 });
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * TAU;
    b.add(new THREE.SphereGeometry(0.11, 6, 5), { m: xf([x + Math.cos(a) * 0.16, y - 0.12, z + Math.sin(a) * 0.16]), color: 0x6f7a2a, sway: 0.25 });
  }
  return b.build({ swayHeight: y + 0.3 });
}

/** Leafy pile / bundle used for dropped fiber/leaves. */
export function leafPileGeometry(rand) {
  const b = new GeoBuilder(rand);
  for (let i = 0; i < 9; i++) {
    const a = rand() * TAU;
    b.add(leafGeometry(rnd(rand, 0.12, 0.18), 0.07, 5), { m: xf([Math.cos(a) * 0.05, 0.02 + i * 0.008, Math.sin(a) * 0.05], [0.1, a, 0]), color: i % 2 ? 0x5f9a3a : 0x7fae4a });
  }
  return b.build();
}

/** v3 (Tempest Isle): wild banana plant: { plant (pseudostem + big paddle leaves, static), bunch (hanging fruit, regrows) }. */
export function bananaPlantGeometry(rand) {
  const plant = new GeoBuilder(rand);
  const H = 1.95;
  plant.add(new THREE.CylinderGeometry(0.075, 0.13, H, 7), { m: xf([0, H / 2, 0]), color: 0x6f7a3a, top: 0x8a9a44, jitter: 0.08, sway: 0.08 });
  // old sheaths at the base
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU + rand();
    plant.add(new THREE.CylinderGeometry(0.02, 0.16, 0.45, 5, 1, true), { m: xf([Math.cos(a) * 0.03, 0.22, Math.sin(a) * 0.03], [0, a, 0]), color: 0x7a6a3a, jitter: 0.1 });
  }
  const nLeaf = 7;
  for (let k = 0; k < nLeaf; k++) {
    const a = (k / nLeaf) * TAU + rnd(rand, -0.25, 0.25);
    const len = rnd(rand, 1.35, 1.8);
    const torn = rand() < 0.3;
    const g = bladeGeometry(torn ? 0.34 : 0.5, len, rnd(rand, 0.3, 0.5), 6, torn ? 0.1 : 0.26);
    plant.add(g, {
      m: xf([0, H - 0.05 - k * 0.04, 0], [rnd(rand, 0.65, 1.05), a, rnd(rand, -0.15, 0.15)]),
      color: torn ? 0x8a8a3a : 0x3f7f2a,
      top: torn ? 0xa89a48 : 0x78b44a,
      jitter: 0.08,
      sway: 0.3,
    });
  }
  const bunch = new GeoBuilder(rand);
  const bx = 0.16, by = 1.45;
  bunch.add(new THREE.CylinderGeometry(0.018, 0.022, 0.55, 5), { m: xf([bx * 0.7, by + 0.2, 0], [0, 0, 0.35]), color: 0x6a7a34, sway: 0.08 });
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * TAU + r * 0.6;
      const yy = by - r * 0.1;
      const ripe = rand() < 0.75;
      bunch.add(new THREE.CylinderGeometry(0.022, 0.016, 0.17, 5), {
        m: xf([bx + Math.cos(a) * 0.07, yy, Math.sin(a) * 0.07], [Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9]),
        color: ripe ? 0xd9c43a : 0x9fb23a,
        top: ripe ? 0xe8d860 : 0xb8c650,
        jitter: 0.06,
        sway: 0.08,
      });
    }
  }
  // the purple flower bud dangling under the bunch
  bunch.add(new THREE.ConeGeometry(0.05, 0.16, 6), { m: xf([bx, by - 0.5, 0], [Math.PI, 0, 0]), color: 0x5a2440, jitter: 0.08, sway: 0.08 });
  bunch.add(new THREE.CylinderGeometry(0.01, 0.01, 0.12, 4), { m: xf([bx, by - 0.38, 0]), color: 0x6a7a34, sway: 0.08 });
  return { plant: plant.build({ swayHeight: H + 0.8 }), bunch: bunch.build({ swayHeight: H + 0.8 }) };
}

export { hash3 };
