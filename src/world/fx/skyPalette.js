// Sky / lighting palette as a function of sun elevation and weather. Pure math (node-testable).
// All colors are returned as sRGB triplets (0..1); sky.js converts them to linear THREE.Colors.
// Key frames are indexed by e = sunDir.y (-1 below .. +1 zenith).

const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// zenith, horizon (= fog), sunset glow, sun light color, cloud lit side, cloud shadow side,
// hemisphere sky color, hemisphere ground color
// V4-D art pass: warmer key light at golden hour, cooler + dimmer hemisphere fill (shadows read), deeper zenith,
// softer warm-grey horizon haze. Night frames unchanged (navigable).
const KEYS = [
  { e: -1.0, zen: 0x040a1a, hor: 0x0e1a34, glow: 0x0e1a34, sun: 0xff7a40, cLit: 0x1c2436, cDark: 0x0c1220, hSky: 0x4a64b0, hGnd: 0x161e2e },
  { e: -0.3, zen: 0x060f28, hor: 0x13223f, glow: 0x172443, sun: 0xff7a40, cLit: 0x222c42, cDark: 0x0e1424, hSky: 0x4a64b0, hGnd: 0x161e2e },
  { e: -0.14, zen: 0x101a42, hor: 0x2c3260, glow: 0x4a3868, sun: 0xff6a3a, cLit: 0x3a385a, cDark: 0x1a1c34, hSky: 0x5264a6, hGnd: 0x1c2230 },
  { e: -0.05, zen: 0x22315f, hor: 0x7a5a78, glow: 0xc8705a, sun: 0xff6a3a, cLit: 0xa8727a, cDark: 0x463a58, hSky: 0x7c74a2, hGnd: 0x2a2830 },
  { e: 0.01, zen: 0x37528f, hor: 0xd99273, glow: 0xff9848, sun: 0xff8c46, cLit: 0xffbe92, cDark: 0x86667a, hSky: 0xa49eb6, hGnd: 0x4a4034 },
  { e: 0.08, zen: 0x4a77b8, hor: 0xe8bb94, glow: 0xffb868, sun: 0xffb066, cLit: 0xffe4c6, cDark: 0x9c8e9a, hSky: 0xaab9d0, hGnd: 0x5a4f38 },
  { e: 0.2, zen: 0x3e77c4, hor: 0xc4d0d8, glow: 0xffdaa8, sun: 0xffdab0, cLit: 0xfff5e8, cDark: 0xa2a8b6, hSky: 0xa6c0e0, hGnd: 0x5e583c },
  { e: 0.45, zen: 0x3170c6, hor: 0xb2c9d8, glow: 0xffead0, sun: 0xffead4, cLit: 0xffffff, cDark: 0xa8b2c2, hSky: 0xa4bee0, hGnd: 0x605c3e },
  { e: 1.0, zen: 0x2b69c0, hor: 0xaac3d8, glow: 0xfff2e2, sun: 0xfff1e0, cLit: 0xffffff, cDark: 0xaab4c4, hSky: 0xa2bce0, hGnd: 0x605c3e },
];
const FIELDS = ['zen', 'hor', 'glow', 'sun', 'cLit', 'cDark', 'hSky', 'hGnd'];
const KEYS_RGB = KEYS.map((k) => {
  const o = { e: k.e };
  for (const f of FIELDS) o[f] = hex(k[f]);
  return o;
});

// overcast (day / night) and storm tints
const OVC = {
  dayZen: hex(0x7a8490), dayHor: hex(0xa2aab2), nightZen: hex(0x0d1320), nightHor: hex(0x151c2a),
  stormZen: hex(0x3a424c), stormHor: hex(0x59626c), stormNightZen: hex(0x080b12), stormNightHor: hex(0x0d121b),
  cLitDay: hex(0xc8ced6), cDarkDay: hex(0x6a727e), cLitStorm: hex(0x5e6672), cDarkStorm: hex(0x262b33),
  cLitNight: hex(0x1c2232), cDarkNight: hex(0x0a0e16),
  hSkyDay: hex(0xb6c0ca),
};

function scale3(out, a, k) {
  out[0] = a[0] * k;
  out[1] = a[1] * k;
  out[2] = a[2] * k;
  return out;
}

function lerp3(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** Fresh output object for skyState(). */
export function makeSkyState() {
  const o = { golden: 0, sunI: 0, moonI: 0, hemiI: 0, ambI: 0, fogDensity: 0, starVis: 0, sunsetAmt: 0, sunVis: 0, overcast: 0, dayAmt: 0, cloudShadow: 0 };
  for (const f of FIELDS) o[f] = [0, 0, 0];
  o.amb = [0, 0, 0];
  o._a = [0, 0, 0];
  o._b = [0, 0, 0];
  // scratch (no per-frame allocations)
  o._sz = [0, 0, 0];
  o._sh = [0, 0, 0];
  o._cl = [0, 0, 0];
  o._cd = [0, 0, 0];
  o._t = [0, 0, 0];
  return o;
}

/**
 * Compute the sky/lighting state.
 * @param e sun elevation (sunDir.y)
 * @param moonY moonDir.y
 * @param cloud 0..1 cloudiness
 * @param storm 0..1 storm amount (darker clouds/sky)
 * @param rain 0..1
 * @param moonIllum 0..1 lit fraction of the moon
 * @param out object from makeSkyState()
 */
export function skyState(e, moonY, cloud, storm, rain, moonIllum, out) {
  // interpolate the clear-sky key frames
  let i = 0;
  while (i < KEYS_RGB.length - 2 && e > KEYS_RGB[i + 1].e) i++;
  const A = KEYS_RGB[i], B = KEYS_RGB[i + 1];
  const t = clamp01((e - A.e) / (B.e - A.e));
  for (const f of FIELDS) lerp3(out[f], A[f], B[f], t);

  const dayAmt = smooth(-0.2, 0.25, e);
  const overcast = smooth(0.3, 1.0, cloud) * 0.92;
  out.dayAmt = dayAmt;
  out.overcast = overcast;

  // overcast / storm sky
  const oz = lerp3(out._a, OVC.nightZen, OVC.dayZen, dayAmt);
  const oh = lerp3(out._b, OVC.nightHor, OVC.dayHor, dayAmt);
  if (storm > 0) {
    const sz = out._sz, sh = out._sh;
    lerp3(sz, OVC.stormNightZen, OVC.stormZen, dayAmt);
    lerp3(sh, OVC.stormNightHor, OVC.stormHor, dayAmt);
    lerp3(oz, oz, sz, storm);
    lerp3(oh, oh, sh, storm);
  }
  lerp3(out.zen, out.zen, oz, overcast);
  lerp3(out.hor, out.hor, oh, overcast);
  lerp3(out.glow, out.glow, out.hor, overcast * 0.85);

  // clouds
  const cl = out._cl, cd = out._cd;
  lerp3(cl, OVC.cLitNight, OVC.cLitDay, dayAmt);
  lerp3(cd, OVC.cDarkNight, OVC.cDarkDay, dayAmt);
  const grey = smooth(0.45, 1.0, cloud) * 0.8;
  lerp3(out.cLit, out.cLit, cl, grey);
  lerp3(out.cDark, out.cDark, cd, grey);
  if (storm > 0) {
    const k = 0.25 + 0.75 * dayAmt;
    lerp3(out.cLit, out.cLit, scale3(out._t, OVC.cLitStorm, k), storm);
    lerp3(out.cDark, out.cDark, scale3(out._t, OVC.cDarkStorm, k), storm);
  }

  // hemisphere: greyer under overcast
  lerp3(out.hSky, out.hSky, scale3(out._t, OVC.hSkyDay, 0.3 + 0.7 * dayAmt), overcast * 0.7);

  // light intensities (physical units, three r155+)
  const sunUp = smooth(-0.04, 0.16, e);
  out.sunVis = smooth(-0.03, 0.03, e) * (1 - overcast * 0.95);
  // gentle golden-hour boost (low warm sun reads stronger against the cooler fill)
  const golden = smooth(-0.01, 0.05, e) * smooth(0.34, 0.1, e);
  out.golden = golden;
  out.sunI = 3.05 * sunUp * (1 + 0.22 * golden) * (1 - 0.8 * Math.pow(cloud, 1.3)) * (1 - 0.3 * storm);
  const night = smooth(0.02, -0.14, e);
  out.moonI = 0.8 * night * smooth(-0.05, 0.15, moonY) * (0.55 + 0.45 * moonIllum) * (1 - 0.6 * cloud);
  // fill: night floor ~0.86 kept (navigable); lower by clear day so shadows read, back up under overcast
  out.hemiI = (0.86 - 0.1 * dayAmt) * (1 - 0.25 * storm * dayAmt) + 0.3 * overcast * dayAmt;
  out.amb[0] = 0.23 + 0.77 * dayAmt;
  out.amb[1] = 0.31 + 0.69 * dayAmt;
  out.amb[2] = 0.54 + 0.46 * dayAmt;
  out.ambI = 0.22 - 0.14 * dayAmt;

  // sunset glow strength near the horizon
  out.sunsetAmt = smooth(-0.22, -0.02, e) * smooth(0.32, 0.04, e) * (1 - overcast * 0.85);
  // stars fade in through twilight; clouds occlude per star in the shader
  out.starVis = smooth(-0.02, -0.18, e) * (1 - storm);
  // fog: light by day, a little morning/evening haze, denser in rain/storm
  const haze = smooth(-0.05, 0.05, e) * smooth(0.28, 0.06, e);
  out.fogDensity = 0.00105 + 0.0011 * haze + 0.00025 * (1 - dayAmt) + 0.0004 * cloud + 0.0038 * rain + 0.0028 * storm;
  // moving cloud shadows on the ground when partly cloudy
  out.cloudShadow = 0.5 * smooth(0.1, 0.4, cloud) * (1 - smooth(0.75, 1.0, cloud)) * sunUp;
  return out;
}

/**
 * Snap a shadow-box center to whole shadow-map texels in the light's view basis, so the
 * shadow edges don't shimmer as the player moves.
 * @param c {x,y,z} center, @param d light direction (unit, toward the light), @param texel size (m)
 * @param out {x,y,z}
 */
export function snapToTexel(c, d, texel, out) {
  // basis matching Object3D.lookAt from light -> target with up = +Y
  let rx = d.z, rz = -d.x; // cross(up, d) = (d.z, 0, -d.x)
  let rl = Math.hypot(rx, rz);
  if (rl < 1e-4) {
    rx = 1;
    rz = 0;
    rl = 1;
  }
  rx /= rl;
  rz /= rl;
  // u = cross(d, r)  (orthonormal basis r, u, d)
  const uX = d.y * rz;
  const uY = d.z * rx - d.x * rz;
  const uZ = -d.y * rx;
  const pr = c.x * rx + c.z * rz;
  const pu = c.x * uX + c.y * uY + c.z * uZ;
  const pd = c.x * d.x + c.y * d.y + c.z * d.z;
  const sr = Math.round(pr / texel) * texel;
  const su = Math.round(pu / texel) * texel;
  out.x = rx * sr + uX * su + d.x * pd;
  out.y = uY * su + d.y * pd;
  out.z = rz * sr + uZ * su + d.z * pd;
  return out;
}
