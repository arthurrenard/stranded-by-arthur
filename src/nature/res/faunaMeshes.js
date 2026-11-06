// Procedural low-poly fauna geometry (Builder C — fauna). No assets: every creature is built from
// a few triangles here, with vertex colors that carry the PATTERN (dark wing margins, belly/back,
// stripes) while the per-instance color carries the HUE (species / individual variation).
//
// Conventions: model space, meters, body along +Z (head at +Z), up = +Y, wings in the XZ plane.
// Attributes: position, normal (flat), color (rgb or rgba), and when relevant:
//   aWing  -1 = rigid vertex, 0..1 = wing vertex (root..tip), read by the flap patch (faunaShared.js)
//   aSac    1 = frog throat-sac vertex (inflates when croaking)
import * as THREE from 'three';

const _c = new THREE.Color();

/** Hex / CSS color -> linear [r, g, b] (vertex colors are linear). */
export function lin(hex) {
  _c.set(hex);
  return [_c.r, _c.g, _c.b];
}
const gray = (g) => [g, g, g];
const mulc = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

/** Triangle soup builder with per-vertex colors and tag attributes. */
class FMesh {
  constructor(rand = Math.random) {
    this.rand = rand;
    this.p = [];
    this.c = [];
    this.a = []; // alpha (only used when built with alpha)
    this.w = []; // aWing
    this.s = []; // aSac
  }

  /** One triangle. Colors are [r,g,b]; wings/alphas per vertex. */
  tri(p0, p1, p2, c0, c1 = c0, c2 = c1, { w = [-1, -1, -1], a = [1, 1, 1], sac = 0 } = {}) {
    for (const [p, c, i] of [[p0, c0, 0], [p1, c1, 1], [p2, c2, 2]]) {
      this.p.push(p[0], p[1], p[2]);
      this.c.push(c[0], c[1], c[2]);
      this.a.push(a[i]);
      this.w.push(w[i]);
      this.s.push(sac);
    }
  }

  /**
   * Add a three.js primitive transformed by pos/rot/scale. `color` is [r,g,b] or fn(x,y,z) -> [r,g,b]
   * (evaluated on the transformed vertex). Per-face brightness jitter for the faceted look.
   */
  prim(geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = gray(1), jitter = 0.08, wing = -1, sac = 0 } = {}) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'YXZ')),
      new THREE.Vector3(...(typeof scale === 'number' ? [scale, scale, scale] : scale))
    );
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.applyMatrix4(m);
    const arr = g.attributes.position.array;
    for (let f = 0; f < arr.length; f += 9) {
      const j = 1 + (this.rand() - 0.5) * 2 * jitter;
      const vs = [];
      for (let k = 0; k < 3; k++) {
        const x = arr[f + k * 3], y = arr[f + k * 3 + 1], z = arr[f + k * 3 + 2];
        const base = typeof color === 'function' ? color(x, y, z) : color;
        vs.push([[x, y, z], mulc(base, j)]);
      }
      this.tri(vs[0][0], vs[1][0], vs[2][0], vs[0][1], vs[1][1], vs[2][1], { w: [wing, wing, wing], sac });
    }
    geo.dispose();
    if (g !== geo) g.dispose();
    return this;
  }

  /**
   * A flat wing in the XZ plane from an outline (array of [x, z], ordered around the shape) with a
   * concentric gradient: root color -> inner color -> margin color at the outline.
   * Mirrored to the left side (x -> -x) when `mirror`. aWing = |x| / span.
   */
  wing(outline, root, { span, rootCol, innerCol, edgeCol, inner = 0.7, y = 0, mirror = true, alpha = null }) {
    for (const side of mirror ? [1, -1] : [1]) {
      const P = (x, z) => [x * side, y, z];
      const W = (x) => Math.min(1, Math.abs(x) / span);
      const n = outline.length;
      for (let i = 0; i < n; i++) {
        const o0 = outline[i], o1 = outline[(i + 1) % n];
        const i0 = [root[0] + (o0[0] - root[0]) * inner, root[1] + (o0[1] - root[1]) * inner];
        const i1 = [root[0] + (o1[0] - root[0]) * inner, root[1] + (o1[1] - root[1]) * inner];
        const aIn = alpha ? alpha[1] : 1, aEdge = alpha ? alpha[2] : 1, aRoot = alpha ? alpha[0] : 1;
        // root fan
        this.tri(P(root[0], root[1]), P(i0[0], i0[1]), P(i1[0], i1[1]), rootCol, innerCol, innerCol, {
          w: [W(root[0]), W(i0[0]), W(i1[0])],
          a: [aRoot, aIn, aIn],
        });
        // margin band
        this.tri(P(i0[0], i0[1]), P(o0[0], o0[1]), P(o1[0], o1[1]), innerCol, edgeCol, edgeCol, {
          w: [W(i0[0]), W(o0[0]), W(o1[0])],
          a: [aIn, aEdge, aEdge],
        });
        this.tri(P(i0[0], i0[1]), P(o1[0], o1[1]), P(i1[0], i1[1]), innerCol, edgeCol, innerCol, {
          w: [W(i0[0]), W(o1[0]), W(i1[0])],
          a: [aIn, aEdge, aIn],
        });
      }
    }
    return this;
  }

  build({ alpha = false, wing = false, sac = false } = {}) {
    const g = new THREE.BufferGeometry();
    const n = this.p.length / 3;
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    if (alpha) {
      const c4 = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        c4[i * 4] = this.c[i * 3];
        c4[i * 4 + 1] = this.c[i * 3 + 1];
        c4[i * 4 + 2] = this.c[i * 3 + 2];
        c4[i * 4 + 3] = this.a[i];
      }
      g.setAttribute('color', new THREE.BufferAttribute(c4, 4));
    } else g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    if (wing) g.setAttribute('aWing', new THREE.Float32BufferAttribute(this.w, 1));
    if (sac) g.setAttribute('aSac', new THREE.Float32BufferAttribute(this.s, 1));
    g.computeVertexNormals(); // non-indexed -> flat face normals
    g.computeBoundingSphere();
    return g;
  }
}

const octa = () => new THREE.OctahedronGeometry(1, 0);
const ico = () => new THREE.IcosahedronGeometry(1, 0);

// ── Butterfly (wingspan ~0.16 m) ─────────────────────────────────────────
/** Butterfly: dark slender body + antennae, fore/hind wings with dark margins. Also used for moths. */
export function butterflyGeometry(rand) {
  const b = new FMesh(rand);
  const dark = gray(0.09);
  b.prim(octa(), { pos: [0, 0, -0.016], scale: [0.0055, 0.0055, 0.024], color: dark }); // abdomen
  b.prim(octa(), { pos: [0, 0.001, 0.008], scale: [0.0075, 0.0075, 0.011], color: gray(0.14) }); // thorax
  b.prim(octa(), { pos: [0, 0.002, 0.021], scale: 0.0055, color: dark }); // head
  // antennae: thin slivers with a club at the tip
  for (const s of [1, -1]) {
    b.tri([0.001 * s, 0.003, 0.024], [0.0025 * s, 0.003, 0.024], [0.014 * s, 0.014, 0.05], dark);
    b.prim(octa(), { pos: [0.014 * s, 0.014, 0.05], scale: 0.0022, color: dark, jitter: 0 });
  }
  const span = 0.08;
  // forewing (points forward-outward), hindwing (rounded lobe behind)
  b.wing(
    [[0.004, 0.014], [0.026, 0.044], [0.058, 0.054], [0.079, 0.042], [0.073, 0.018], [0.05, 0.0], [0.006, -0.002]],
    [0.006, 0.006],
    { span, rootCol: gray(0.5), innerCol: gray(1.0), edgeCol: gray(0.1), inner: 0.72 }
  );
  b.wing(
    [[0.005, -0.001], [0.04, -0.004], [0.06, -0.022], [0.053, -0.046], [0.03, -0.06], [0.012, -0.042], [0.003, -0.016]],
    [0.005, -0.006],
    { span, rootCol: gray(0.42), innerCol: gray(0.86), edgeCol: gray(0.12), inner: 0.66, y: -0.0005 }
  );
  return b.build({ wing: true });
}

// ── Bird (length ~0.36 m, wingspan ~0.9 m in model units; scaled per species) ──
/** Generic bird: diamond body (lighter belly), head, beak, fan tail, two-panel wings with dark tips. */
export function birdGeometry(rand) {
  const b = new FMesh(rand);
  const bodyCol = (x, y) => (y < 0 ? gray(1.08) : gray(0.86));
  b.prim(octa(), { pos: [0, 0, 0], scale: [0.045, 0.042, 0.13], color: bodyCol }); // body
  b.prim(octa(), { pos: [0, 0.022, 0.115], scale: [0.034, 0.034, 0.042], color: gray(0.95) }); // head
  b.prim(new THREE.ConeGeometry(1, 1, 4), { pos: [0, 0.016, 0.172], rot: [Math.PI / 2, 0, 0], scale: [0.011, 0.045, 0.011], color: lin(0xe7b43a), jitter: 0 }); // beak
  // eyes (tiny dark)
  for (const s of [1, -1]) b.prim(octa(), { pos: [0.026 * s, 0.032, 0.13], scale: 0.006, color: gray(0.03), jitter: 0 });
  // tail fan
  const tc = gray(0.72);
  b.tri([0, 0.004, -0.09], [0.05, 0.0, -0.22], [0, 0.002, -0.2], tc, gray(0.5), tc);
  b.tri([0, 0.004, -0.09], [0, 0.002, -0.2], [-0.05, 0.0, -0.22], tc, tc, gray(0.5));
  // wings: root -> elbow -> hand -> tip (swept back), dark tips
  const span = 0.45;
  const root = [0.03, 0.0];
  b.wing(
    [[0.03, 0.055], [0.2, 0.05], [0.33, 0.006], [0.45, -0.075], [0.31, -0.07], [0.2, -0.065], [0.03, -0.05]],
    root,
    { span, rootCol: gray(0.95), innerCol: gray(0.82), edgeCol: gray(0.28), inner: 0.55 }
  );
  // extra dark primaries at the tip
  for (const s of [1, -1]) {
    b.tri([0.33 * s, 0.0005, 0.004], [0.45 * s, 0.0005, -0.075], [0.31 * s, 0.0005, -0.068], gray(0.14), gray(0.08), gray(0.14), {
      w: [0.33 / span, 1, 0.31 / span],
    });
  }
  return b.build({ wing: true });
}

// ── Dragonfly (length ~0.095 m) ──────────────────────────────────────────
/** Dragonfly body: big glossy eyes, thorax, long striped abdomen (hue from the instance color). */
export function dragonflyBodyGeometry(rand) {
  const b = new FMesh(rand);
  b.prim(octa(), { pos: [0, 0, 0.012], scale: [0.0075, 0.008, 0.012], color: gray(0.9) }); // thorax
  for (const s of [1, -1]) b.prim(ico(), { pos: [0.0055 * s, 0.002, 0.027], scale: 0.0058, color: gray(1.25), jitter: 0.02 }); // eyes
  for (let i = 0; i < 5; i++) {
    const z = -0.006 - i * 0.0125;
    b.prim(octa(), { pos: [0, 0.0005, z], scale: [0.0034, 0.0034, 0.0075], color: gray(i % 2 ? 0.45 : 1.0) });
  }
  b.prim(octa(), { pos: [0, 0.0005, -0.07], scale: [0.0022, 0.0022, 0.006], color: gray(0.3) }); // tail tip
  return b.build();
}

/** Dragonfly wings: four long glassy wings (separate transparent mesh sharing the body's matrices). */
export function dragonflyWingGeometry(rand) {
  const b = new FMesh(rand);
  const span = 0.062;
  const shape = (zc, len, w) => [
    [0.004, zc + w * 0.4], [len * 0.35, zc + w * 0.55], [len * 0.8, zc + w * 0.45], [len, zc + w * 0.05],
    [len * 0.82, zc - w * 0.4], [len * 0.4, zc - w * 0.45], [0.004, zc - w * 0.3],
  ];
  const opts = { span, rootCol: gray(0.75), innerCol: gray(1.0), edgeCol: gray(0.55), inner: 0.8, alpha: [0.55, 0.35, 0.8] };
  b.wing(shape(0.016, 0.062, 0.012), [0.004, 0.016], opts);
  b.wing(shape(0.003, 0.058, 0.014), [0.004, 0.003], { ...opts, y: -0.0006 });
  return b.build({ wing: true, alpha: true });
}

// ── Fish shadow (length ~0.5 m) ──────────────────────────────────────────
/** Soft-edged flat fish silhouette (rgba: alpha 1 at the spine -> 0 at the outline). Tail at -Z. */
export function fishShadowGeometry() {
  const b = new FMesh(() => 0.5);
  const half = [[0, 0.25], [0.05, 0.2], [0.075, 0.08], [0.068, -0.04], [0.04, -0.15], [0.014, -0.21], [0.075, -0.3], [0.0, -0.255]];
  const outline = [...half, ...half.slice(1, -1).reverse().map(([x, z]) => [-x, z])];
  const center = [0, 0.02];
  const n = outline.length;
  const W = gray(1);
  for (let i = 0; i < n; i++) {
    const o0 = outline[i], o1 = outline[(i + 1) % n];
    const k = 0.55;
    const i0 = [center[0] + (o0[0] - center[0]) * k, center[1] + (o0[1] - center[1]) * k];
    const i1 = [center[0] + (o1[0] - center[0]) * k, center[1] + (o1[1] - center[1]) * k];
    b.tri([center[0], 0, center[1]], [i1[0], 0, i1[1]], [i0[0], 0, i0[1]], W, W, W, { a: [1, 0.85, 0.85] });
    b.tri([i0[0], 0, i0[1]], [i1[0], 0, i1[1]], [o1[0], 0, o1[1]], W, W, W, { a: [0.85, 0.85, 0] });
    b.tri([i0[0], 0, i0[1]], [o1[0], 0, o1[1]], [o0[0], 0, o0[1]], W, W, W, { a: [0.85, 0, 0] });
  }
  return b.build({ alpha: true });
}

// ── Frog (length ~0.12 m) ────────────────────────────────────────────────
export const FROG_SAC_CENTER = [0, 0.017, 0.068];
/** Sitting frog: green back, cream belly, golden eyes, folded legs, inflatable throat sac (aSac). */
export function frogGeometry(rand) {
  const b = new FMesh(rand);
  const back = lin(0x4f8f2c), belly = lin(0xd9d39a), leg = lin(0x3f7a22);
  const skin = (x, y) => (y < 0.022 ? belly : back);
  b.prim(octa(), { pos: [0, 0.03, -0.005], rot: [-0.25, 0, 0], scale: [0.045, 0.026, 0.056], color: skin }); // body
  b.prim(octa(), { pos: [0, 0.04, 0.045], scale: [0.034, 0.02, 0.032], color: skin }); // head
  for (const s of [1, -1]) {
    b.prim(ico(), { pos: [0.021 * s, 0.056, 0.05], scale: 0.0105, color: lin(0xe0b030), jitter: 0.02 }); // eye
    b.prim(octa(), { pos: [0.026 * s, 0.059, 0.055], scale: 0.0045, color: gray(0.02), jitter: 0 }); // pupil
    b.prim(octa(), { pos: [0.046 * s, 0.014, -0.025], rot: [0, 0.5 * s, 0], scale: [0.017, 0.013, 0.042], color: leg }); // thigh
    b.prim(octa(), { pos: [0.05 * s, 0.005, 0.0], rot: [0, -0.3 * s, 0], scale: [0.012, 0.006, 0.03], color: leg }); // foot
    b.prim(octa(), { pos: [0.026 * s, 0.009, 0.052], rot: [0, 0.2 * s, 0], scale: [0.008, 0.01, 0.016], color: leg }); // front leg
  }
  b.prim(ico(), { pos: FROG_SAC_CENTER, scale: [0.014, 0.011, 0.012], color: lin(0xe6e2a6), jitter: 0, sac: 1 }); // throat sac
  return b.build({ sac: true });
}

// ── Lily pad (radius 1, scaled per instance) + water lily flower ────────
/** Lily pad: notched disc, slightly cupped, darker center veins (vertex colors). */
export function lilyPadGeometry(rand) {
  const b = new FMesh(rand);
  const seg = 16;
  const notch = 0.32;
  const inner = lin(0x3e6d22), rim = lin(0x5e9a33), mid = lin(0x4d8a2c);
  for (let i = 0; i < seg; i++) {
    const a0 = notch + (i / seg) * (Math.PI * 2 - notch * 2);
    const a1 = notch + ((i + 1) / seg) * (Math.PI * 2 - notch * 2);
    const j = 1 + (rand() - 0.5) * 0.1;
    const p = (a, r, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
    b.tri([0, 0, 0], p(a1, 0.55, 0.004), p(a0, 0.55, 0.004), mulc(inner, j), mulc(mid, j), mulc(mid, j));
    b.tri(p(a0, 0.55, 0.004), p(a1, 0.55, 0.004), p(a1, 1, 0.02), mulc(mid, j), mulc(mid, j), mulc(rim, j));
    b.tri(p(a0, 0.55, 0.004), p(a1, 1, 0.02), p(a0, 1, 0.02), mulc(mid, j), mulc(rim, j), mulc(rim, j));
  }
  return b.build();
}

/** Water lily: two rings of pointed petals around a golden center (opens by day via instance scale). */
export function lilyFlowerGeometry(rand) {
  const b = new FMesh(rand);
  const petal = lin(0xf6e6ee), tip = lin(0xf08cb4), core = lin(0xf2c230);
  for (const [n, r, tilt, y0, off] of [[8, 0.11, 0.9, 0.012, 0], [7, 0.075, 0.45, 0.02, 0.4]]) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + off;
      const ca = Math.cos(a), sa = Math.sin(a);
      const w = 0.028;
      const tx = ca * r * Math.sin(tilt + 0.5), tz = sa * r * Math.sin(tilt + 0.5), ty = y0 + r * Math.cos(tilt + 0.5);
      const l = [ca * 0.012 - sa * w, y0, sa * 0.012 + ca * w], rr = [ca * 0.012 + sa * w, y0, sa * 0.012 - ca * w];
      b.tri(l, rr, [tx, ty, tz], petal, petal, tip);
      b.tri(rr, l, [tx * 0.5, ty * 0.5 + y0 * 0.5 - 0.004, tz * 0.5], petal, petal, petal);
    }
  }
  b.prim(ico(), { pos: [0, 0.03, 0], scale: [0.022, 0.014, 0.022], color: core, jitter: 0.05 });
  return b.build();
}

// ── Ripple ring (radius 1) ───────────────────────────────────────────────
/** Soft thin ring for additive blending: color 0 at both edges, 1 in the middle. */
export function rippleGeometry() {
  const b = new FMesh(() => 0.5);
  const seg = 40;
  const r0 = 0.78, r1 = 0.9, r2 = 1.0;
  const K = gray(0), Wc = gray(1);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const p = (a, r) => [Math.cos(a) * r, 0, Math.sin(a) * r];
    b.tri(p(a0, r0), p(a1, r1), p(a0, r1), K, Wc, Wc);
    b.tri(p(a0, r0), p(a1, r0), p(a1, r1), K, K, Wc);
    b.tri(p(a0, r1), p(a1, r1), p(a1, r2), Wc, Wc, K);
    b.tri(p(a0, r1), p(a1, r2), p(a0, r2), Wc, K, K);
  }
  return b.build();
}

