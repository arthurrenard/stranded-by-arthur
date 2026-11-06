// Builder A — Water. All the island's water, drawn with custom fog-aware shaders that share the sky's
// light/sky uniforms (fx/shared.js) so reflections, glints and colors always match the sky:
// - the ocean: a camera-centered polar mesh with Gerstner waves (fx/waterWaves.js) that are small near
//   the shore and grow offshore and with the weather (uWave); shallow teal → deep blue → navy from the
//   baked height texture (depth + distance to shore), translucent shallows (the terrain's caustics show
//   through), waterline lace + foam rollers that travel up the beaches, whitecaps in strong wind,
//   sun/moon glints, sky reflection with Fresnel, rain rings; seen from below it shows Snell's window.
// - Mirror Lake + Spring Pond: flat discs at their level, calmer and greener, wind cat's-paws.
// - the river ribbon from the lake outlet to the sea, its ripples flowing along s, white water on rapids.
// - underwater: when the camera is below a surface, a DOM tint overlay + dense blue/green fog (overriding
//   the fog sky.js wrote this frame; sky rewrites it next frame) + the sky dome turned murky.
// Also writes the shared uTide (slow sea breathing, read by the terrain's wet band) and uWave.
//
// API: { ocean, lakes, river, underwater (bool), underwaterAmount 0..1, cameraWater ('ocean'|'lake'|'river'|null),
//        isCameraUnderwater(), waveHeightAt(x, z), surfaceAt(x, z), init(), update(dt) }
import * as THREE from 'three';
import { worldShared, heightXform, HEIGHT_GLSL } from './fx/shared.js';
import { NOISE_GLSL } from './fx/glsl.js';
import { wavesGLSL, waveHeight, oceanAmp, buildPolarGrid, OCEAN_AMP_SUM } from './fx/waterWaves.js';
import { sampleHeightData } from './fx/shared.js';
import { smoothstep, clamp01, damp } from '../core/util.js';

const WAVES = wavesGLSL();

// ── Shared fragment library: lighting, sky reflection, rain rings, underwater view ──
const WATER_LIB = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
uniform float uWave;
uniform float uRain;
uniform float uDaylight;
uniform float uSea;
uniform float uTide;
uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform vec3 uAmbientColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uCloudCover;
uniform float uFlash;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uUnder;

// sky color along a reflected ray (same gradient as the dome; greyer under overcast)
vec3 wSkyReflect(vec3 r) {
  float y = clamp(r.y, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(y, 0.55));
  sky = mix(sky, uHorizon, uCloudCover * 0.55);
  return sky + vec3(0.45, 0.5, 0.7) * uFlash * 0.3;
}

// expanding rain rings: a normal perturbation in xz (two cell layers)
vec2 wRainRipples(vec2 p, float t, float rain) {
  vec2 g = vec2(0.0);
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    vec2 q = p * (1.3 + fl * 0.7) + fl * 17.3;
    vec2 cell = floor(q);
    vec2 fr = fract(q) - 0.5;
    float h = wHash12(cell + fl * 3.1);
    vec2 off = vec2(wHash12(cell + 7.7), wHash12(cell + 3.3)) - 0.5;
    vec2 d = fr - off * 0.4;
    float r = length(d);
    float age = fract(t * (0.8 + 0.4 * h) + h * 7.0);
    float x = (r - age * 0.45) * 28.0;
    float ring = sin(x * 3.14159) * exp(-x * x * 0.5) * (1.0 - age) * step(h, rain);
    g += d / max(r, 1e-3) * ring;
  }
  return g;
}

// lit water: body (scattering) + Fresnel sky reflection + key-light glint + foam
vec3 wShade(vec3 body, vec3 N, vec3 V, float foam, float fresBase, float specMul, out float fres) {
  vec3 L = uLightDir;
  float up = max(L.y, 0.0);
  vec3 lit = uAmbientColor * 0.5 + uLightColor * (0.05 + 0.1 * up);
  vec3 col = body * lit * (0.7 + 0.3 * uDaylight);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  fres = fresBase + (1.0 - fresBase) * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  vec3 sky = wSkyReflect(vec3(R.x, abs(R.y), R.z));
  col = mix(col, sky, fres * (1.0 - foam));
  float rl = max(dot(R, L), 0.0);
  float spec = pow(rl, 700.0) * 8.0 + pow(rl, 80.0) * 0.22;
  col += uLightColor * (spec * specMul * (1.0 - foam) * smoothstep(-0.03, 0.05, L.y) * 0.3333);
  vec3 foamCol = vec3(0.93, 0.96, 0.97) * (uAmbientColor * 0.55 + uLightColor * (0.05 + 0.12 * up) + 0.01);
  return mix(col, foamCol, foam);
}

// the surface seen from below: total internal reflection, Snell's window toward the sky
vec3 wShadeUnder(vec3 N, vec3 V) {
  float up = clamp(-V.y, 0.0, 1.0);
  float win = smoothstep(0.62, 0.8, up + N.x * 0.06 + N.z * 0.06);
  vec3 lit = uAmbientColor * 0.6 + uLightColor * 0.12;
  vec3 tir = uUnder * lit * 1.5;
  vec3 skyIn = wSkyReflect(vec3(0.0, 1.0, 0.0)) * 0.85 + uLightColor * pow(max(dot(-V, uLightDir), 0.0), 40.0) * 0.4;
  return mix(tir, skyIn, win);
}
`;

// ── Ocean ────────────────────────────────────────────────────────────────
const OCEAN_VERT = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uWave;
uniform float uTide;
uniform float uSea;
uniform vec3 uCamCalm; // camera x, z, calm amount (flattens the crests right around a swimming camera)
varying vec3 vWorld;
varying vec2 vBase;
varying float vAmp;
#include <fog_pars_vertex>
${HEIGHT_GLSL}
${WAVES}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 base = wp.xz;
  vec4 hs = wHeightSample(base);
  float amp = wOceanAmp(hs.b, uSea + uTide - hs.r) * uWave;
  amp *= mix(1.0, smoothstep(2.5, 11.0, length(base - uCamCalm.xy)), uCamCalm.z);
  float camD = length(base - cameraPosition.xz);
  vec3 d = wWaveDisp(base, uTime, amp, normalize(uWind + vec2(1e-4, 0.0)), camD);
  wp.xz += d.xz;
  wp.y = uSea + uTide + d.y;
  vWorld = wp.xyz;
  vBase = base;
  vAmp = amp;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;
const OCEAN_FRAG = /* glsl */ `
uniform vec3 uAbyss;
varying vec3 vWorld;
varying vec2 vBase;
varying float vAmp;
#include <fog_pars_fragment>
${NOISE_GLSL}
${HEIGHT_GLSL}
${WAVES}
${WATER_LIB}
void main() {
  vec4 hs = wHeightSample(vBase);
  float waterY = uSea + uTide;
  float depth = max(waterY - hs.r, 0.0);
  float shore = hs.b;
  float camD = length(vWorld - cameraPosition);
  vec2 wd = normalize(uWind + vec2(1e-4, 0.0));
  vec3 N = wWaveNormal(vBase, uTime, vAmp, 0.6 + 0.5 * uWave, wd, camD);
  if (uRain > 0.01 && camD < 35.0) {
    vec2 rr = wRainRipples(vWorld.xz, uTime, uRain) * (1.0 - smoothstep(15.0, 35.0, camD));
    N = normalize(N + vec3(rr.x, 0.0, rr.y) * 0.4);
  }
  vec3 V = normalize(cameraPosition - vWorld);
  if (!gl_FrontFacing) {
    gl_FragColor = vec4(wShadeUnder(-N, V), 0.93);
  } else {
    float fN = wFbm3(vBase * 0.28 + vec2(uTime * 0.03, -uTime * 0.021));
    float crest = (vWorld.y - waterY) / max(vAmp * ${OCEAN_AMP_SUM.toFixed(4)}, 0.03);
    // foam: lace at the waterline, rollers running up the beach, whitecaps in strong wind
    float lace = (1.0 - smoothstep(0.03, 0.3 + 0.12 * sin(uTime * 0.9 + fN * 6.0), depth)) * smoothstep(0.2, 0.5, fN + 0.25);
    float near = (1.0 - smoothstep(4.0, 30.0, shore)) * smoothstep(0.5, 2.0, shore);
    float band = sin(shore * 0.72 + uTime * 1.25 + fN * 3.0);
    float roller = smoothstep(0.8, 0.98, band) * near * smoothstep(0.38, 0.62, fN + 0.12);
    float caps = smoothstep(1.3, 2.4, uWave) * smoothstep(0.5, 0.95, crest) * smoothstep(0.45, 0.7, fN);
    float foam = clamp(max(max(lace * 0.9, roller * 0.7), caps * 0.85), 0.0, 1.0);
    foam *= 1.0 - 0.7 * smoothstep(250.0, 700.0, camD);
    // body color: shallow teal -> deep blue -> navy far offshore
    vec3 body = mix(uShallow, uDeep, 1.0 - exp(-depth * 0.2));
    body = mix(body, uAbyss, smoothstep(40.0, 240.0, shore) * smoothstep(6.0, 25.0, depth));
    // sunlight glowing through the wave crests when looking toward a low sun
    vec2 vh = normalize(-V.xz + vec2(1e-4));
    vec2 lh = normalize(uLightDir.xz + vec2(1e-4));
    float sss = pow(max(dot(vh, lh), 0.0), 3.0) * (1.0 - max(uLightDir.y, 0.0)) * clamp(crest, 0.0, 1.0);
    body += uShallow * sss * 0.7;
    float fres;
    vec3 col = wShade(body, N, V, foam, 0.02, 1.0, fres);
    // opacity from the optical path through the water (Beer-Lambert), not just the local depth:
    // grazing views through shallow water must not reveal far-away submerged geometry (the wreck's reef pedestal)
    float path = depth / max(V.y, 0.06);
    float alpha = mix(0.38, 0.97, 1.0 - exp(-path * 0.45));
    alpha = max(max(alpha, fres), foam);
    alpha *= smoothstep(0.0, 0.05, depth + 0.015);
    gl_FragColor = vec4(col, alpha);
  }
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// ── Lakes / pond ─────────────────────────────────────────────────────────
const FLAT_VERT = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;
const LAKE_FRAG = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_fragment>
${NOISE_GLSL}
${HEIGHT_GLSL}
${WAVES}
${WATER_LIB}
void main() {
  vec4 hs = wHeightSample(vWorld.xz);
  float depth = max(vWorld.y - hs.r, 0.0);
  float camD = length(vWorld - cameraPosition);
  vec2 wd = normalize(uWind + vec2(1e-4, 0.0));
  // cat's-paws: gust patches that roughen the mirror
  float paw = wFbm3(vWorld.xz * 0.05 - uWind * uTime * 0.05);
  float ripple = (0.12 + 0.5 * clamp(uWindStrength, 0.0, 1.5)) * (0.45 + 1.1 * smoothstep(0.35, 0.75, paw));
  vec3 N = wDetailNormal(vWorld.xz * 1.35, uTime * 0.75, ripple, wd, camD);
  if (uRain > 0.01 && camD < 35.0) {
    vec2 rr = wRainRipples(vWorld.xz, uTime, uRain) * (1.0 - smoothstep(15.0, 35.0, camD));
    N = normalize(N + vec3(rr.x, 0.0, rr.y) * 0.5);
  }
  vec3 V = normalize(cameraPosition - vWorld);
  if (!gl_FrontFacing) {
    gl_FragColor = vec4(wShadeUnder(-N, V), 0.93);
  } else {
    float fN = wFbm3(vWorld.xz * 0.4 + uTime * 0.02);
    float foam = (1.0 - smoothstep(0.02, 0.2, depth)) * 0.4 * smoothstep(0.35, 0.65, fN);
    vec3 body = mix(uShallow, uDeep, 1.0 - exp(-depth * 0.4));
    float fres;
    vec3 col = wShade(body, N, V, foam, 0.03, 0.9, fres);
    float path = depth / max(V.y, 0.06); // optical path (see the ocean shader)
    float alpha = mix(0.3, 0.95, 1.0 - exp(-path * 0.6));
    alpha = max(max(alpha, fres), foam);
    gl_FragColor = vec4(col, alpha);
  }
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// ── River ribbon ─────────────────────────────────────────────────────────
const RIVER_VERT = /* glsl */ `
attribute vec4 aFlow; // s (m along), v (-1.15..1.15 across, 1 = nominal half width), rapids 0..1, half width (m)
attribute vec2 aDir; // flow direction (x, z)
varying vec3 vWorld;
varying vec4 vFlow;
varying vec2 vDir;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vFlow = aFlow;
  vDir = aDir;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;
const RIVER_FRAG = /* glsl */ `
varying vec3 vWorld;
varying vec4 vFlow;
varying vec2 vDir;
#include <fog_pars_fragment>
${NOISE_GLSL}
${WATER_LIB}
void main() {
  float speed = 0.9 + 3.2 * vFlow.z;
  float across = vFlow.y * vFlow.w;
  // ripples in flow space, scrolling downstream
  vec2 q = vec2(across, vFlow.x - uTime * speed);
  vec2 sc = vec2(0.9, 0.42);
  float e = 0.2;
  float h0 = wFbm3(q * sc);
  float hx = wFbm3((q + vec2(e, 0.0)) * sc);
  float hy = wFbm3((q + vec2(0.0, e)) * sc);
  vec2 gq = vec2(hx - h0, hy - h0) / e;
  float k = 0.45 + 0.9 * vFlow.z;
  vec2 dir = normalize(vDir + vec2(1e-4));
  vec2 side = vec2(-dir.y, dir.x);
  vec2 gw = side * gq.x + dir * gq.y;
  vec3 N = normalize(vec3(-gw.x * k, 1.0, -gw.y * k));
  float camD = length(vWorld - cameraPosition);
  if (uRain > 0.01 && camD < 35.0) {
    vec2 rr = wRainRipples(vWorld.xz, uTime, uRain) * (1.0 - smoothstep(15.0, 35.0, camD));
    N = normalize(N + vec3(rr.x, 0.0, rr.y) * 0.4);
  }
  vec3 V = normalize(cameraPosition - vWorld);
  if (!gl_FrontFacing) {
    gl_FragColor = vec4(wShadeUnder(-N, V), 0.9);
  } else {
    // channel depth from the carve profile (heightfield applyRiver)
    float depth = max(1.75 * (1.0 - vFlow.y * vFlow.y) - 0.35, 0.0);
    // white water: streaks that race down the rapids, a little foam along the banks
    float streak = wFbm3(vec2(across * 1.2, (vFlow.x - uTime * speed * 1.15) * 0.3));
    float white = vFlow.z * smoothstep(0.36, 0.6, streak);
    float bank = smoothstep(0.8, 1.05, abs(vFlow.y)) * 0.3 * smoothstep(0.45, 0.7, h0);
    float foam = clamp(white * 0.95 + bank, 0.0, 1.0);
    vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 1.4, depth));
    float fres;
    vec3 col = wShade(body, N, V, foam, 0.025, 0.8, fres);
    float alpha = mix(0.35, 0.92, smoothstep(0.0, 1.2, depth));
    alpha = max(max(alpha, fres * 0.9), foam);
    alpha *= 1.0 - smoothstep(1.05, 1.15, abs(vFlow.y));
    alpha *= smoothstep(-0.05, 0.5, vWorld.y - uSea); // melt into the sea at the mouth
    gl_FragColor = vec4(col, alpha);
  }
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// ── Underwater overlay (DOM) ─────────────────────────────────────────────
const OVERLAY_CSS = `
#water-underwater{position:fixed;inset:0;pointer-events:none;z-index:5;opacity:0;display:none;overflow:hidden}
#water-underwater>div{position:absolute;inset:0}
#water-underwater .uw-tint{background:radial-gradient(ellipse at 50% 32%,var(--uw-a) 0%,var(--uw-b) 55%,var(--uw-c) 100%)}
#water-underwater .uw-rays{inset:-20% -30%;background:repeating-linear-gradient(100deg,rgba(190,240,255,0) 0px,rgba(190,240,255,.08) 38px,rgba(190,240,255,0) 92px,rgba(190,240,255,0) 150px);
  -webkit-mask-image:linear-gradient(to bottom,#000 0%,transparent 75%);mask-image:linear-gradient(to bottom,#000 0%,transparent 75%);
  mix-blend-mode:screen;animation:uw-rays 9s ease-in-out infinite alternate}
#water-underwater .uw-dark{background:#02060c;opacity:0}
@keyframes uw-rays{from{transform:translateX(-4%) skewX(-4deg)}to{transform:translateX(4%) skewX(5deg)}}
`;
const OVERLAY_TINTS = {
  ocean: ['rgba(70,185,195,0.10)', 'rgba(14,92,112,0.34)', 'rgba(3,30,46,0.72)'],
  fresh: ['rgba(95,175,125,0.12)', 'rgba(26,86,62,0.38)', 'rgba(5,30,20,0.76)'],
};

function createOverlay() {
  if (typeof document === 'undefined' || !document.body) return null;
  if (!document.getElementById('water-underwater-css')) {
    const st = document.createElement('style');
    st.id = 'water-underwater-css';
    st.textContent = OVERLAY_CSS;
    document.head.appendChild(st);
  }
  const root = document.createElement('div');
  root.id = 'water-underwater';
  const tint = document.createElement('div');
  tint.className = 'uw-tint';
  const rays = document.createElement('div');
  rays.className = 'uw-rays';
  const dark = document.createElement('div');
  dark.className = 'uw-dark';
  root.append(tint, rays, dark);
  document.body.appendChild(root);
  return { root, tint, rays, dark, kind: '', shown: false, op: -1, rayOp: -1, darkOp: -1 };
}

export function create(ctx) {
  const { scene, camera, world } = ctx;
  const shared = worldShared(ctx);
  const U = shared.uniforms;
  const SEA = world.SEA_LEVEL ?? 0;
  const heightTex = shared.heightTexture();
  const hData = shared.heightData();
  const xform = heightXform(world);

  const col = (hex) => new THREE.Color(hex); // sRGB hex -> linear working color
  const COLORS = {
    oceanShallow: col(0x3fb7c4),
    oceanDeep: col(0x1d5f8a),
    oceanAbyss: col(0x123f66),
    oceanUnder: col(0x0d4a58),
    lakeShallow: col(0x4fae9a),
    lakeDeep: col(0x1f5a5a),
    riverShallow: col(0x63bcaa),
    riverDeep: col(0x2a6e72),
    freshUnder: col(0x1f4a3c),
  };

  function uniforms(extra) {
    const u = ctx.uniforms;
    return {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: u.uTime,
      uWind: u.uWind,
      uWindStrength: u.uWindStrength,
      uRain: u.uRain,
      uDaylight: u.uDaylight,
      uWave: U.uWave,
      uTide: U.uTide,
      uLightDir: U.uLightDir,
      uLightColor: U.uLightColor,
      uAmbientColor: U.uAmbientColor,
      uZenith: U.uZenith,
      uHorizon: U.uHorizon,
      uCloudCover: U.uCloudCover,
      uFlash: U.uFlash,
      uHeightTex: { value: heightTex },
      uHeightXform: { value: xform },
      uSea: { value: SEA },
      ...extra,
    };
  }
  function material(name, vert, frag, uni) {
    return new THREE.ShaderMaterial({
      name,
      uniforms: uni,
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: true,
      toneMapped: false, // display-referred like the sky dome, so the far sea melts into the horizon
    });
  }

  // ── Ocean ────────────────────────────────────────────────────────────────
  const grid = buildPolarGrid(2450, 192);
  const oceanGeo = new THREE.BufferGeometry();
  oceanGeo.setAttribute('position', new THREE.BufferAttribute(grid.positions, 3));
  oceanGeo.setIndex(new THREE.BufferAttribute(grid.indices, 1));
  const camCalm = new THREE.Vector3();
  const oceanUniforms = uniforms({
    uShallow: { value: COLORS.oceanShallow },
    uDeep: { value: COLORS.oceanDeep },
    uAbyss: { value: COLORS.oceanAbyss },
    uUnder: { value: COLORS.oceanUnder },
    uCamCalm: { value: camCalm },
  });
  const ocean = new THREE.Mesh(oceanGeo, material('world-ocean', OCEAN_VERT, OCEAN_FRAG, oceanUniforms));
  ocean.name = 'ocean';
  ocean.frustumCulled = false; // follows the camera, displaced in the shader
  ocean.renderOrder = -10; // first transparent pass: later particles depth-test against the sea
  ocean.onBeforeRender = (r, s, cam) => {
    ocean.position.set(cam.position.x, 0, cam.position.z);
    ocean.updateMatrixWorld();
  };
  scene.add(ocean);

  // ── Lakes + pond ─────────────────────────────────────────────────────────
  const lakeUniforms = uniforms({
    uShallow: { value: COLORS.lakeShallow },
    uDeep: { value: COLORS.lakeDeep },
    uUnder: { value: COLORS.freshUnder },
  });
  const lakeMat = material('world-lake', FLAT_VERT, LAKE_FRAG, lakeUniforms);
  const lakes = [];
  for (const L of world.lakes || []) {
    const g = new THREE.CircleGeometry(L.waterRadius, 96);
    g.rotateX(-Math.PI / 2); // faces +Y
    const m = new THREE.Mesh(g, lakeMat);
    m.name = 'water-' + L.id;
    m.position.set(L.x, L.level, L.z);
    m.renderOrder = -9;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    scene.add(m);
    lakes.push(m);
  }

  // ── River ribbon ─────────────────────────────────────────────────────────
  const river = buildRiver();
  if (river) scene.add(river);

  function buildRiver() {
    const R = world.river;
    if (!R?.points?.length) return null;
    const pts = R.points;
    const lake = R.lake || world.lakes?.[0];
    let start = pts.findIndex((p) => !lake || Math.hypot(p.x - lake.x, p.z - lake.z) > R.startRadius);
    if (start < 0) return null;
    start = Math.max(0, start - 1); // one point inside the lake disc: no gap at the outlet
    let end = pts.findIndex((p, i) => i > start && p.surface < SEA);
    if (end < 0) end = pts.length - 1;
    const n = end - start + 1;
    if (n < 2) return null;
    const pos = new Float32Array(n * 2 * 3);
    const flow = new Float32Array(n * 2 * 4);
    const dirs = new Float32Array(n * 2 * 2);
    const WIDEN = 1.15; // the edges tuck under the banks
    for (let k = 0; k < n; k++) {
      const i = start + k;
      const p = pts[i];
      // drop rate (m per m) over ±2 points → rapids
      const a = pts[Math.max(0, i - 2)], b = pts[Math.min(pts.length - 1, i + 2)];
      const drop = (a.surface - b.surface) / Math.max(0.5, b.s - a.s);
      const rapids = smoothstep(0.035, 0.12, drop);
      const sx = -p.dirZ, sz = p.dirX; // across (left of the flow)
      const W = p.w * WIDEN;
      // the overlap point sits just under the lake surface so the lake disc wins there
      const y = k === 0 && lake ? lake.level - 0.02 : p.surface;
      for (let e = 0; e < 2; e++) {
        const sgn = e === 0 ? -1 : 1; // 0: right bank, 1: left bank
        const v = k * 2 + e;
        pos[v * 3] = p.x + sx * W * sgn;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = p.z + sz * W * sgn;
        flow[v * 4] = p.s;
        flow[v * 4 + 1] = WIDEN * sgn;
        flow[v * 4 + 2] = rapids;
        flow[v * 4 + 3] = p.w;
        dirs[v * 2] = p.dirX;
        dirs[v * 2 + 1] = p.dirZ;
      }
    }
    // smooth the rapids attribute a little along the river
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 1; k < n - 1; k++) {
        const r = (flow[(k - 1) * 8 + 2] + 2 * flow[k * 8 + 2] + flow[(k + 1) * 8 + 2]) / 4;
        flow[k * 8 + 2] = flow[k * 8 + 6] = r;
      }
    }
    const idx = [];
    for (let k = 0; k < n - 1; k++) {
      const r0 = k * 2, l0 = k * 2 + 1, r1 = k * 2 + 2, l1 = k * 2 + 3;
      idx.push(r0, l0, r1, l0, l1, r1); // both face +Y
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aFlow', new THREE.BufferAttribute(flow, 4));
    g.setAttribute('aDir', new THREE.BufferAttribute(dirs, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const riverUniforms = uniforms({
      uShallow: { value: COLORS.riverShallow },
      uDeep: { value: COLORS.riverDeep },
      uUnder: { value: COLORS.freshUnder },
    });
    const m = new THREE.Mesh(g, material('world-river', RIVER_VERT, RIVER_FRAG, riverUniforms));
    m.name = 'water-river';
    m.renderOrder = -8;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    return m;
  }

  // ── CPU wave mirror ──────────────────────────────────────────────────────
  const tmpD = { x: 0, y: 0, z: 0 };
  let calm = 0;
  function ampAt(x, z) {
    const shore = sampleHeightData(hData, world, x, z, 2);
    const ground = sampleHeightData(hData, world, x, z, 0);
    let a = oceanAmp(shore, SEA + U.uTide.value - ground) * U.uWave.value;
    if (calm > 0) {
      const dc = Math.hypot(x - camCalm.x, z - camCalm.y);
      a *= 1 + (smoothstep(2.5, 11, dc) - 1) * calm;
    }
    return a;
  }
  /** Ocean wave height offset (m, relative to sea level + tide) at world (x, z), as rendered. */
  function waveHeightAt(x, z) {
    const w = ctx.uniforms.uWind.value;
    const l = Math.hypot(w.x, w.y) || 1;
    const dist = Math.hypot(x - camera.position.x, z - camera.position.z);
    return waveHeight(x, z, ctx.uniforms.uTime.value, ampAt, w.x / l, w.y / l, dist, tmpD);
  }
  /** Rendered water surface y at (x, z) or null on dry ground. */
  function surfaceAt(x, z) {
    const w = world.waterAt(x, z);
    if (!w) return null;
    if (w.type === 'ocean') return SEA + U.uTide.value + waveHeightAt(x, z);
    return w.surface;
  }

  // ── Underwater state ─────────────────────────────────────────────────────
  const overlay = createOverlay();
  const uwColor = new THREE.Color();
  const fogTmp = new THREE.Color();
  let uwAmt = 0;
  let skyUnder = false;
  let waveTarget = U.uWave.value;

  function setOverlay(amount, fresh, daylight) {
    const o = overlay;
    if (!o) return;
    const show = amount > 0.004;
    if (show !== o.shown) {
      o.root.style.display = show ? 'block' : 'none';
      o.shown = show;
    }
    if (!show) return;
    const kind = fresh ? 'fresh' : 'ocean';
    if (kind !== o.kind) {
      const t = OVERLAY_TINTS[kind];
      o.tint.style.setProperty('--uw-a', t[0]);
      o.tint.style.setProperty('--uw-b', t[1]);
      o.tint.style.setProperty('--uw-c', t[2]);
      o.kind = kind;
    }
    const op = Math.round(amount * 100) / 100;
    if (op !== o.op) {
      o.root.style.opacity = String(op);
      o.op = op;
    }
    const ray = Math.round(daylight * 20) / 20;
    if (ray !== o.rayOp) {
      o.rays.style.opacity = String(ray);
      o.rayOp = ray;
    }
    const dk = Math.round((1 - daylight) * 0.55 * 20) / 20;
    if (dk !== o.darkOp) {
      o.dark.style.opacity = String(dk);
      o.darkOp = dk;
    }
  }

  const api = {
    ocean,
    lakes,
    river,
    underwater: false,
    underwaterAmount: 0,
    cameraWater: null,
    isCameraUnderwater: () => api.underwater,
    waveHeightAt,
    surfaceAt,
    init() {},
    update(dt) {
      const T = ctx.time;
      const W = ctx.weather;
      // sea breathing (semi-diurnal tide, game time) + wave height from the weather
      U.uTide.value = 0.12 * Math.sin((T.hoursTotal / 12.42) * Math.PI * 2 + 0.8);
      const ws = W?.wind?.strength ?? ctx.uniforms.uWindStrength.value ?? 0.35;
      const storm = Number(W?.storm) || 0;
      waveTarget = 0.55 + 0.9 * Math.min(1.6, ws) + 1.25 * storm;
      U.uWave.value = damp(U.uWave.value, waveTarget, 0.35, dt);

      // camera calm: flatten the crests right around a camera floating at the surface
      const cam = camera.position;
      const seaY = SEA + U.uTide.value;
      calm = 1 - smoothstep(0.8, 2.2, Math.abs(cam.y - seaY));
      camCalm.set(cam.x, cam.z, calm);

      // underwater test at the camera (hysteresis), with the rendered surface
      const w = world.waterAt(cam.x, cam.z);
      let surf = null;
      if (w) surf = w.type === 'ocean' ? seaY + waveHeightAt(cam.x, cam.z) : w.surface;
      const under = surf != null && (api.underwater ? cam.y < surf + 0.04 : cam.y < surf - 0.04);
      api.underwater = under;
      api.cameraWater = under ? w.type : null;
      const fresh = !!w?.fresh;
      uwAmt = under ? Math.min(1, uwAmt + dt * 9) : Math.max(0, uwAmt - dt * 6);
      api.underwaterAmount = uwAmt;

      const daylight = clamp01(ctx.uniforms.uDaylight.value);
      if (uwAmt > 0) {
        // dense colored fog (sky.update already wrote this frame's fog; it rewrites it next frame)
        uwColor.copy(fresh ? COLORS.freshUnder : COLORS.oceanUnder).multiplyScalar(0.16 + 0.84 * daylight);
        const fog = scene.fog;
        if (fog) {
          fogTmp.copy(fog.color).lerp(uwColor, uwAmt);
          fog.color.copy(fogTmp);
          if (fog.density != null) fog.density += ((fresh ? 0.075 : 0.05) - fog.density) * uwAmt;
          if (scene.background?.isColor) scene.background.copy(fog.color);
        }
        ctx.sky?.setUnderwater?.(uwAmt, uwColor);
        skyUnder = true;
      } else if (skyUnder) {
        ctx.sky?.setUnderwater?.(0);
        skyUnder = false;
      }
      setOverlay(uwAmt, fresh, daylight);
    },
  };
  return api;
}
