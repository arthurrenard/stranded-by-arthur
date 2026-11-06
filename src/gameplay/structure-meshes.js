// Procedural low-poly meshes for player-built structures (Builder E): campfire, signal-fire pyre,
// lean-to shelter, SOS stones and the held torch. Every part is merged into a few BufferGeometries with
// per-face vertex colors (flat-shaded low-poly look) and a `sway` attribute (leaves flutter in the wind).
// Two shared materials for everything: `solid` (wood, stone) and `leaf` (double-sided foliage with a
// wind flutter patched in via onBeforeCompile). No textures, no per-object materials.
import * as THREE from 'three';

// Palette (SPEC §9)
export const PAL = {
  rock: 0x8a847a,
  darkRock: 0x5d5750,
  bark: 0x6b4f36,
  darkBark: 0x4e3a28,
  char: 0x241a14,
  ash: 0x6a645d,
  soot: 0x2e2a27,
  leaf: 0x4f8a35,
  leafLight: 0x6fa33c,
  leafDark: 0x3a6e2a,
  leafDry: 0x93a04c,
  leafBrown: 0x7d6a3a,
  fiber: 0xb89a62,
  rope: 0x8a7350,
};

// ── Shared materials ─────────────────────────────────────────────────────
export function createStructureMaterials(ctx) {
  const U = ctx.uniforms;
  const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0, flatShading: true });
  solid.name = 'structure-solid';
  const leaf = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  leaf.name = 'structure-leaf';
  leaf.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uWind = U.uWind;
    sh.uniforms.uWindStrength = U.uWindStrength;
    sh.vertexShader =
      'attribute float sway;\nuniform float uTime;\nuniform vec2 uWind;\nuniform float uWindStrength;\n' +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec4 swW = modelMatrix * vec4(transformed, 1.0);
          float ph = uTime * 2.3 + swW.x * 0.9 + swW.z * 0.7;
          float amp = sway * (0.018 + uWindStrength * 0.05);
          transformed += vec3(uWind.x * sin(ph) + 0.3 * sin(ph * 2.9), 0.7 * sin(ph * 1.7), uWind.y * cos(ph * 1.3)) * amp;
        }`,
      );
  };
  leaf.customProgramCacheKey = () => 'structure-leaf-sway';
  return { solid, leaf };
}

// ── Geometry builder ─────────────────────────────────────────────────────
const _v = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const CHAR = new THREE.Color(PAL.char);

/** Merges primitives (non-indexed) with per-triangle color jitter and a sway weight per vertex. */
class GeoBuilder {
  constructor(rng) {
    this.rng = rng || Math.random;
    this.pos = [];
    this.col = [];
    this.sway = [];
  }
  /**
   * @param geo   source geometry (disposed after use)
   * @param m     Matrix4 placing it
   * @param color hex | THREE.Color
   * @param o     { jitter (per-face brightness), sway (0..1), shade(worldVec, color) -> mutate color }
   */
  add(geo, m, color, o = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position;
    const jitter = o.jitter ?? 0.08;
    const base = _c2.set(color);
    for (let i = 0; i < p.count; i += 3) {
      const f = 1 + (this.rng() - 0.5) * 2 * jitter;
      for (let k = 0; k < 3; k++) {
        _v.fromBufferAttribute(p, i + k).applyMatrix4(m);
        this.pos.push(_v.x, _v.y, _v.z);
        _c.copy(base).multiplyScalar(f);
        if (o.shade) o.shade(_v, _c);
        this.col.push(_c.r, _c.g, _c.b);
        this.sway.push(typeof o.sway === 'function' ? o.sway(_v) : o.sway || 0);
      }
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('sway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Matrix for a cylinder (axis Y, centered) spanning from a to b. */
function spanMatrix(a, b, out = _m) {
  _p.subVectors(b, a);
  const len = _p.length();
  _q.setFromUnitVectors(UP, _p.normalize());
  _s.set(1, len, 1);
  _v.addVectors(a, b).multiplyScalar(0.5);
  return out.compose(_v.clone(), _q, _s);
}
function trs(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _q.setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q.clone(), new THREE.Vector3(sx, sy, sz));
}

/** A lumpy low-poly rock: icosahedron with position-hashed jitter (crack-free on non-indexed faces). */
export function rockGeometry(seed = 1, detail = 0, amount = 0.22) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    _v.fromBufferAttribute(p, i);
    const h = Math.sin(_v.x * 12.9898 + _v.y * 78.233 + _v.z * 37.719 + seed * 3.17) * 43758.5453;
    const r = 1 + ((h - Math.floor(h)) - 0.5) * 2 * amount;
    _v.multiplyScalar(r);
    _v.y *= _v.y < 0 ? 0.55 : 1; // flatter bottom so rocks sit on the ground
    p.setXYZ(i, _v.x, _v.y, _v.z);
  }
  return g;
}

/** A pointed-oval leaf card in the XZ plane (length along +Z), 6 triangles. */
function leafCard(len, wid) {
  const h = len / 2, w = wid / 2;
  const v = [
    [0, 0, -h], [w * 0.8, 0.02, -h * 0.35], [w, 0.03, h * 0.2], [0, 0, h], [-w, 0.03, h * 0.2], [-w * 0.8, 0.02, -h * 0.35],
  ];
  const c = [0, 0.03, 0];
  const pos = [];
  for (let i = 0; i < 6; i++) {
    const a = v[i], b = v[(i + 1) % 6];
    pos.push(...c, ...b, ...a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

const rr = (rng, a, b) => a + (b - a) * rng();
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/** Bark with a charred, darker upper part (for fire logs). */
function charShade(yFrom, yTo) {
  const char = new THREE.Color(PAL.char);
  return (v, c) => {
    const t = Math.min(1, Math.max(0, (v.y - yFrom) / (yTo - yFrom)));
    c.lerp(char, t * 0.85);
  };
}

// ── Campfire ─────────────────────────────────────────────────────────────
/** -> { base (stones, ash, spare logs), logs (the burning teepee) }: both for the `solid` material. */
export function buildCampfire(rng = Math.random) {
  const base = new GeoBuilder(rng);
  const soot = new THREE.Color(PAL.soot);
  // stone ring, soot-blackened on the inner faces
  const N = 10;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rr(rng, -0.12, 0.12);
    const r = 0.62 + rr(rng, -0.04, 0.05);
    const s = rr(rng, 0.17, 0.24);
    base.add(
      rockGeometry(i * 7 + rng() * 100, 0, 0.25),
      trs(Math.cos(a) * r, 0.05, Math.sin(a) * r, rr(rng, -0.3, 0.3), rr(rng, 0, 6.3), rr(rng, -0.3, 0.3), s * 1.2, s * 0.8, s),
      pick(rng, [PAL.rock, PAL.darkRock, 0x77716a]),
      {
        jitter: 0.12,
        shade: (v, c) => {
          const d = Math.hypot(v.x, v.z);
          if (d < 0.6) c.lerp(soot, Math.min(1, (0.6 - d) / 0.12) * 0.7);
        },
      },
    );
  }
  // ash + charcoal bed
  base.add(new THREE.CylinderGeometry(0.5, 0.56, 0.05, 11), trs(0, 0.0, 0), PAL.ash, {
    jitter: 0.2,
    shade: (v, c) => c.lerp(soot, Math.max(0, 1 - Math.hypot(v.x, v.z) / 0.45) * 0.8),
  });
  for (let i = 0; i < 7; i++) {
    const a = rng() * 6.283, r = rr(rng, 0.05, 0.36), s = rr(rng, 0.04, 0.07);
    base.add(rockGeometry(rng() * 50, 0, 0.3), trs(Math.cos(a) * r, 0.04, Math.sin(a) * r, 0, rng() * 6, 0, s * 1.4, s * 0.7, s), PAL.char, { jitter: 0.25 });
  }
  // a couple of spare logs beside the ring
  for (let i = 0; i < 2; i++) {
    const a = 0.9 + i * 0.22;
    base.add(
      new THREE.CylinderGeometry(0.055, 0.06, 0.7, 6),
      trs(Math.cos(a) * 1.0, 0.06 + i * 0.1, Math.sin(a) * 1.0, 0, -a + Math.PI / 2, Math.PI / 2),
      i ? PAL.bark : PAL.darkBark,
      { jitter: 0.1 },
    );
  }

  const logs = new GeoBuilder(rng);
  const top = new THREE.Vector3(0, 0.62, 0);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rr(rng, -0.2, 0.2);
    const b = new THREE.Vector3(Math.cos(a) * 0.36, 0.02, Math.sin(a) * 0.36);
    const t = top.clone().add(new THREE.Vector3(rr(rng, -0.05, 0.05), rr(rng, -0.06, 0.04), rr(rng, -0.05, 0.05)));
    logs.add(new THREE.CylinderGeometry(0.04, 0.055, 1, 6), spanMatrix(b, t), pick(rng, [PAL.bark, PAL.darkBark]), {
      jitter: 0.1,
      shade: charShade(0.15, 0.55),
    });
  }
  // two logs lying across the coals
  for (let i = 0; i < 2; i++) {
    logs.add(new THREE.CylinderGeometry(0.05, 0.055, 0.8, 6), trs(0, 0.07 + i * 0.05, 0, 0, i * 1.7 + 0.4, Math.PI / 2), PAL.darkBark, {
      jitter: 0.1,
      shade: (v, c) => c.lerp(CHAR, 0.55),
    });
  }
  return { base: base.build(), logs: logs.build() };
}

// ── Signal fire (big pyre) ───────────────────────────────────────────────
/** -> { base (big stone ring), logs (teepee + lashed rings), leaves (green brush stuffed inside) } */
export function buildPyre(rng = Math.random) {
  const base = new GeoBuilder(rng);
  const N = 15;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + rr(rng, -0.08, 0.08);
    const r = 1.38 + rr(rng, -0.06, 0.06);
    const s = rr(rng, 0.25, 0.36);
    base.add(
      rockGeometry(i * 13 + rng() * 100, 0, 0.25),
      trs(Math.cos(a) * r, 0.08, Math.sin(a) * r, rr(rng, -0.3, 0.3), rng() * 6.3, rr(rng, -0.3, 0.3), s * 1.2, s * 0.85, s),
      pick(rng, [PAL.rock, PAL.darkRock, 0x77716a]),
      { jitter: 0.12 },
    );
  }
  base.add(new THREE.CylinderGeometry(1.15, 1.25, 0.05, 14), trs(0, 0, 0), PAL.ash, { jitter: 0.2 });

  const logs = new GeoBuilder(rng);
  const apex = new THREE.Vector3(0, 2.75, 0);
  const P = 12;
  for (let i = 0; i < P; i++) {
    const a = (i / P) * Math.PI * 2 + rr(rng, -0.1, 0.1);
    const r = rr(rng, 0.95, 1.1);
    const b = new THREE.Vector3(Math.cos(a) * r, -0.05, Math.sin(a) * r);
    // poles overshoot the apex a little (crossed tips) for a classic teepee silhouette
    const dir = apex.clone().sub(b);
    const t = b.clone().addScaledVector(dir, rr(rng, 1.06, 1.16));
    t.x += rr(rng, -0.08, 0.08);
    t.z += rr(rng, -0.08, 0.08);
    logs.add(new THREE.CylinderGeometry(0.045, 0.075, 1, 6), spanMatrix(b, t), pick(rng, [PAL.bark, PAL.darkBark, 0x7a5c40]), { jitter: 0.1 });
  }
  // lashed horizontal rings of sticks
  for (const [y, r] of [[0.7, 0.76], [1.5, 0.47]]) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      logs.add(
        new THREE.CylinderGeometry(0.03, 0.03, 1, 5),
        spanMatrix(new THREE.Vector3(Math.cos(a0) * r, y, Math.sin(a0) * r), new THREE.Vector3(Math.cos(a1) * r, y + rr(rng, -0.05, 0.05), Math.sin(a1) * r)),
        PAL.darkBark,
        { jitter: 0.1 },
      );
    }
  }
  // kindling stack at the bottom
  for (let i = 0; i < 6; i++) {
    const a = rng() * 6.283;
    logs.add(new THREE.CylinderGeometry(0.04, 0.045, 0.9, 5), trs(Math.cos(a) * 0.25, 0.1 + i * 0.05, Math.sin(a) * 0.25, 0, a, Math.PI / 2 + rr(rng, -0.2, 0.2)), PAL.bark, { jitter: 0.12 });
  }

  // green brush (the smoke maker): lumpy leafy blobs inside and around the teepee
  const leaves = new GeoBuilder(rng);
  for (let i = 0; i < 16; i++) {
    const y = rr(rng, 0.25, 1.9);
    const maxR = 0.95 * (1 - y / 2.9);
    const a = rng() * 6.283, r = rr(rng, 0.2, maxR);
    const s = rr(rng, 0.28, 0.42) * (1 - y / 4);
    leaves.add(
      rockGeometry(rng() * 100, 1, 0.35),
      trs(Math.cos(a) * r, y, Math.sin(a) * r, rng(), rng() * 6, rng(), s * 1.3, s, s * 1.2),
      pick(rng, [PAL.leaf, PAL.leafLight, PAL.leafDark, PAL.leafDry]),
      { jitter: 0.18, sway: 0.6 },
    );
  }
  return { base: base.build(), logs: logs.build(), leaves: leaves.build() };
}

// ── Lean-to shelter ──────────────────────────────────────────────────────
// Local frame: open side toward +Z (the builder stands there), ridge at the front, roof slopes down to -Z.
export const LEANTO = { halfW: 1.5, frontZ: 0.95, backZ: -1.4, ridgeY: 2.0, posts: [[-1.38, 0.95], [1.38, 0.95]] };

/** -> { frame (solid), roof (leaf) } */
export function buildLeanTo(rng = Math.random) {
  const L = LEANTO;
  const frame = new GeoBuilder(rng);
  const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
  // forked front posts (they reach 0.6 m below ground level so slopes never show a gap)
  for (const [x, z] of L.posts) {
    const lean = Math.sign(x) * 0.04;
    frame.add(new THREE.CylinderGeometry(0.055, 0.07, 1, 6), spanMatrix(v3(x + lean, -0.6, z), v3(x, L.ridgeY + 0.12, z)), PAL.bark, { jitter: 0.08 });
    frame.add(new THREE.CylinderGeometry(0.03, 0.04, 1, 5), spanMatrix(v3(x, L.ridgeY - 0.12, z), v3(x + Math.sign(x) * 0.16, L.ridgeY + 0.22, z + 0.05)), PAL.bark, { jitter: 0.08 });
    // rope lashing at the joint
    frame.add(new THREE.CylinderGeometry(0.075, 0.075, 0.1, 7), trs(x, L.ridgeY - 0.02, z), PAL.rope, { jitter: 0.1 });
  }
  // ridge pole
  frame.add(new THREE.CylinderGeometry(0.06, 0.065, 1, 6), spanMatrix(v3(-L.halfW - 0.25, L.ridgeY + 0.03, L.frontZ), v3(L.halfW + 0.25, L.ridgeY - 0.02, L.frontZ)), PAL.darkBark, { jitter: 0.08 });
  // roof plane: from just in front of / above the ridge down to the ground behind the back edge
  const slopeA = v3(0, L.ridgeY + 0.16, L.frontZ + 0.2);
  const slopeB = v3(0, 0.0, L.backZ - 0.1);
  const dirS = slopeB.clone().sub(slopeA);
  const onSlope = (x, t, lift) => v3(x, slopeA.y + dirS.y * t + lift, slopeA.z + dirS.z * t);
  // rafters lie just under the thatch and dig into the ground at the back
  const R = 5;
  for (let i = 0; i < R; i++) {
    const x = -1.3 + (2.6 * i) / (R - 1) + rr(rng, -0.05, 0.05);
    frame.add(new THREE.CylinderGeometry(0.04, 0.05, 1, 5), spanMatrix(onSlope(x, 0.02, -0.02), onSlope(x, 1.12, -0.04)), pick(rng, [PAL.bark, PAL.darkBark]), { jitter: 0.1 });
  }
  // cross battens along the slope
  for (const t of [0.33, 0.66]) {
    frame.add(new THREE.CylinderGeometry(0.028, 0.028, 1, 5), spanMatrix(onSlope(-L.halfW, t, 0.03), onSlope(L.halfW, t + rr(rng, -0.02, 0.02), 0.03)), PAL.darkBark, { jitter: 0.1 });
  }
  // a log pillow at the back
  frame.add(new THREE.CylinderGeometry(0.09, 0.1, 1.3, 7), trs(0, 0.08, L.backZ + 0.75, 0, 0, Math.PI / 2), PAL.darkBark, { jitter: 0.08 });

  const roof = new GeoBuilder(rng);
  // thatch: overlapping rows of leaf cards laid on the slope, bottom rows first, two layers
  const pitch = Math.atan2(-dirS.y, -dirS.z); // tilt of the roof plane around X
  const greens = [PAL.leaf, PAL.leafLight, PAL.leafDark, PAL.leaf, PAL.leafDry];
  for (let layer = 0; layer < 2; layer++) {
    const rows = 7, cols = 9;
    for (let r = rows - 1; r >= 0; r--) {
      const t = (r + 0.5 + layer * 0.5) / rows;
      const c0 = slopeA.clone().addScaledVector(dirS, Math.min(1, t));
      for (let c = 0; c < cols; c++) {
        const x = -L.halfW - 0.15 + ((2 * L.halfW + 0.3) * (c + 0.5 + (r % 2) * 0.35 - 0.175)) / cols + rr(rng, -0.05, 0.05);
        const len = rr(rng, 0.62, 0.78), wid = rr(rng, 0.36, 0.46);
        // the card's length runs down the slope; small random twist + droop
        const m = trs(x, c0.y + 0.07 + layer * 0.05, c0.z, -pitch + rr(rng, -0.12, 0.12), rr(rng, -0.25, 0.25), rr(rng, -0.12, 0.12));
        const tip = r === rows - 1 ? 1 : 0.55; // the lowest edge flutters most
        roof.add(leafCard(len, wid), m, pick(rng, greens), { jitter: 0.14, sway: tip * (0.6 + rng() * 0.4) });
      }
    }
  }
  // a few loose leaves hanging over the front edge
  for (let i = 0; i < 7; i++) {
    const x = rr(rng, -L.halfW, L.halfW);
    roof.add(leafCard(rr(rng, 0.45, 0.6), 0.3), trs(x, L.ridgeY + 0.05, L.frontZ + 0.3, -1.25 + rr(rng, -0.2, 0.2), rr(rng, -0.4, 0.4), 0), pick(rng, greens), { jitter: 0.12, sway: 1 });
  }
  // leaf bedding on the floor
  const browns = [PAL.leafBrown, PAL.leafDry, 0x8c7a45, PAL.leafDark];
  for (let i = 0; i < 26; i++) {
    roof.add(leafCard(rr(rng, 0.45, 0.65), rr(rng, 0.28, 0.38)), trs(rr(rng, -0.85, 0.85), 0.04 + rng() * 0.03, rr(rng, L.backZ + 0.45, L.frontZ - 0.35), rr(rng, -0.08, 0.08), rng() * 6.3, rr(rng, -0.08, 0.08)), pick(rng, browns), { jitter: 0.15, sway: 0 });
  }
  return { frame: frame.build(), roof: roof.build() };
}

// ── SOS stone (instanced) ────────────────────────────────────────────────
/** One base rock for the SOS InstancedMesh (gray vertex colors; per-instance color tints it). */
export function buildSosStone(rng = Math.random) {
  const b = new GeoBuilder(rng);
  b.add(rockGeometry(5.5, 0, 0.28), new THREE.Matrix4(), 0xffffff, { jitter: 0.14 });
  return b.build();
}

// ── Held torch ───────────────────────────────────────────────────────────
/** -> { geometry (solid), tip: Vector3 (local flame base) }. Origin = the grip; axis +Y. */
export function buildTorch(rng = Math.random) {
  const b = new GeoBuilder(rng);
  b.add(new THREE.CylinderGeometry(0.017, 0.022, 0.46, 6), trs(0, 0.03, 0), PAL.bark, { jitter: 0.1 });
  // fiber / cloth wrap with a charred top
  b.add(new THREE.CylinderGeometry(0.036, 0.03, 0.11, 7), trs(0, 0.27, 0), PAL.fiber, { jitter: 0.14, shade: charShade(0.25, 0.33) });
  for (let i = 0; i < 3; i++) {
    b.add(new THREE.CylinderGeometry(0.039, 0.039, 0.016, 7), trs(0, 0.235 + i * 0.03, 0, rr(rng, -0.15, 0.15), 0, rr(rng, -0.15, 0.15)), PAL.rope, { jitter: 0.1 });
  }
  return { geometry: b.build(), tip: new THREE.Vector3(0, 0.31, 0) };
}
