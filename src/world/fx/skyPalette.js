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
const KEYS = [
  { e: -1.0, zen: 0x040a1a, hor: 0x0e1a34, glow: 0x0e1a34, sun: 0xff7a40, cLit: 0x1c2436, cDark: 0x0c1220, hSky: 0x4a64b0, hGnd: 0x161e2e },
  { e: -0.3, zen: 0x060f28, hor: 0x13223f, glow: 0x172443, sun: 0xff7a40, cLit: 0x222c42, cDark: 0x0e1424, hSky: 0x4a64b0, hGnd: 0x161e2e },
  { e: -0.14, zen: 0x111b44, hor: 0x2c3462, glow: 0x4a3a6a, sun: 0xff6a3a, cLit: 0x3a3a5c, cDark: 0x1a1d34, hSky: 0x5466a8, hGnd: 0x1c2230 },
  { e: -0.05, zen: 0x24346a, hor: 0x7a5c7c, glow: 0xd07a60, sun: 0xff6a3a, cLit: 0xb07a7c, cDark: 0x4a3e5a, hSky: 0x8a7aa8, hGnd: 0x2a2a30 },
  { e: 0.01, zen: 0x3d5a98, hor: 0xd7967c, glow: 0xffa050, sun: 0xff9a50, cLit: 0xffc49a, cDark: 0x8a6a7a, hSky: 0xc8a8a0, hGnd: 0x4a4436 },
  { e: 0.08, zen: 0x5584c2, hor: 0xeec39c, glow: 0xffc070, sun: 0xffc080, cLit: 0xfff0dc, cDark: 0xa89aa0, hSky: 0xd6d0c8, hGnd: 0x5e5a40 },
  { e: 0.2, zen: 0x4f88cf, hor: 0xc6d9e4, glow: 0xffe2b4, sun: 0xffe6c4, cLit: 0xfffaf4, cDark: 0xa8b0bc, hSky: 0xc4d8ee, hGnd: 0x68663f },
  { e: 0.45, zen: 0x3f80d4, hor: 0xadcde8, glow: 0xfff0d8, sun: 0xfff4e4, cLit: 0xffffff, cDark: 0xaeb8c6, hSky: 0xbcd4f0, hGnd: 0x6a6a44 },
  { e: 1.0, zen: 0x3577cf, hor: 0xa4c7e8, glow: 0xfff6e8, sun: 0xfffaf2, cLit: 0xffffff, cDark: 0xb0bac8, hSky: 0xb8d2f0, hGnd: 0x6a6a44 },
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

function lerp3(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** Fresh output object for skyState(). */
export function makeSkyState() {
  const o = { sunI: 0, moonI: 0, hemiI: 0, ambI: 0, fogDensity: 0, starVis: 0, sunsetAmt: 0, sunVis: 0, overcast: 0, dayAmt: 0, cloudShadow: 0 };
  for (const f of FIELDS) o[f] = [0, 0, 0];
  o.amb = [0, 0, 0];
  o._a = [0, 0, 0];
  o._b = [0, 0, 0];
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
    const sz = [0, 0, 0], sh = [0, 0, 0];
    lerp3(sz, OVC.stormNightZen, OVC.stormZen, dayAmt);
    lerp3(sh, OVC.stormNightHor, OVC.stormHor, dayAmt);
    lerp3(oz, oz, sz, storm);
    lerp3(oh, oh, sh, storm);
  }
  lerp3(out.zen, out.zen, oz, overcast);
  lerp3(out.hor, out.hor, oh, overcast);
  lerp3(out.glow, out.glow, out.hor, overcast * 0.85);

  // clouds
  const cl = [0, 0, 0], cd = [0, 0, 0];
  lerp3(cl, OVC.cLitNight, OVC.cLitDay, dayAmt);
  lerp3(cd, OVC.cDarkNight, OVC.cDarkDay, dayAmt);
  const grey = smooth(0.45, 1.0, cloud) * 0.8;
  lerp3(out.cLit, out.cLit, cl, grey);
  lerp3(out.cDark, out.cDark, cd, grey);
  if (storm > 0) {
    lerp3(out.cLit, out.cLit, OVC.cLitStorm.map((v) => v * (0.25 + 0.75 * dayAmt)), storm);
    lerp3(out.cDark, out.cDark, OVC.cDarkStorm.map((v) => v * (0.25 + 0.75 * dayAmt)), storm);
  }

  // hemisphere: greyer under overcast
  lerp3(out.hSky, out.hSky, OVC.hSkyDay.map((v) => v * (0.3 + 0.7 * dayAmt)), overcast * 0.7);

  // light intensities (physical units, three r155+)
  const sunUp = smooth(-0.04, 0.16, e);
  out.sunVis = smooth(-0.03, 0.03, e) * (1 - overcast * 0.95);
  out.sunI = 3.0 * sunUp * (1 - 0.8 * Math.pow(cloud, 1.3)) * (1 - 0.3 * storm);
  const night = smooth(0.02, -0.14, e);
  out.moonI = 0.8 * night * smooth(-0.05, 0.15, moonY) * (0.55 + 0.45 * moonIllum) * (1 - 0.6 * cloud);
  out.hemiI = (0.85 + 0.25 * dayAmt) * (1 - 0.25 * storm * dayAmt) + 0.15 * overcast * dayAmt;
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
  out.fogDensity = 0.00105 + 0.0009 * haze + 0.00025 * (1 - dayAmt) + 0.0004 * cloud + 0.0038 * rain + 0.0028 * storm;
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
