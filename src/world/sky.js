// Builder A — Sky. A custom gradient sky dome (sunrise/sunset glow, sun disc, fbm clouds whose
// cover follows ctx.weather.cloudiness, a faint Milky Way), a twinkling star field + a phased moon
// at night, scene fog matched exactly to the horizon color, and all the scene lighting:
// the single shadow-casting DirectionalLight (sun by day, moon by night, texel-snapped around
// the player), a HemisphereLight and a soft AmbientLight. Updates ctx.uniforms.uDaylight.
//
// Color note: fog is mixed by three AFTER tone mapping, so the dome is drawn untonemapped
// (toneMapped:false) with the same linear horizon Color as scene.fog → seamless horizon.
//
// API: { sun, hemi, ambient, fog, dome, colors:{zenith,horizon}, daylight,
//        setFogDensity(d|null), flash(strength), setUnderwater(amount, color?) }
import * as THREE from 'three';
import { worldShared } from './fx/shared.js';
import { NOISE_GLSL, CLOUD_GLSL } from './fx/glsl.js';
import { makeSkyState, skyState, snapToTexel, smooth } from './fx/skyPalette.js';

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w; // pin to the far plane
}
`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGlowColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uLightDir;
uniform vec3 uCloudLit;
uniform vec3 uCloudDark;
uniform vec3 uUnderwaterColor;
uniform float uSunsetAmt;
uniform float uSunVis;
uniform float uStarVis;
uniform float uMoonGlow;
uniform float uFlash;
uniform float uUnderwater;
varying vec3 vDir;
${NOISE_GLSL}
${CLOUD_GLSL}
void main() {
  vec3 dir = normalize(vDir);
  float y = dir.y;
  float yc = max(y, 0.0);
  // base gradient
  vec3 col = mix(uHorizon, uZenith, pow(yc, 0.55));
  float sd = dot(dir, uSunDir);
  float sdp = max(sd, 0.0);
  // sunrise / sunset glow hugging the horizon, strongest toward the sun
  float band = exp(-yc * 4.5);
  col = mix(col, uGlowColor, clamp(uSunsetAmt * band * (0.22 + 0.78 * pow(sdp, 3.0)), 0.0, 1.0));
  // sun halo + disc
  col += uSunColor * (pow(sdp, 10.0) * 0.16 + pow(sdp, 80.0) * 0.32) * uSunVis;
  col += uSunColor * smoothstep(0.99935, 0.99968, sd) * 3.0 * uSunVis;
  // night: moon halo + Milky Way
  float md = max(dot(dir, uMoonDir), 0.0);
  col += vec3(0.30, 0.36, 0.55) * pow(md, 24.0) * uMoonGlow;
  vec3 mwN = normalize(vec3(0.35, 0.42, 0.84));
  float mb = dot(dir, mwN);
  float mw = exp(-mb * mb * 26.0) * (0.3 + 0.7 * wFbm3(dir.xz * 5.0 + dir.y * 3.0));
  col += vec3(0.32, 0.36, 0.55) * mw * uStarVis * 0.05 * smoothstep(0.0, 0.25, y);
  // clouds
  if (y > 0.0) {
    vec2 cp = wCloudCoord(dir);
    float d = wFbm5(cp);
    float t = wCloudThreshold();
    float cov = smoothstep(t, t + 0.22, d) * smoothstep(0.0, 0.07, y);
    if (cov > 0.001) {
      float d2 = wFbm5(cp + normalize(uLightDir.xz + vec2(1e-4)) * 0.3);
      float lit = clamp(0.55 + (d - d2) * 3.5, 0.0, 1.0);
      vec3 cc = mix(uCloudDark, uCloudLit, lit);
      // silver lining toward the sun
      cc += uSunColor * pow(sdp, 7.0) * (1.0 - cov) * 0.7 * uSunVis;
      // sunset tint on the cloud undersides near the horizon
      cc = mix(cc, uGlowColor * (0.6 + 0.4 * lit), uSunsetAmt * band * 0.45);
      cc += vec3(0.75, 0.8, 1.0) * uFlash * (0.6 + lit);
      cc = mix(cc, uHorizon, smoothstep(0.22, 0.0, y) * 0.55);
      col = mix(col, cc, cov * 0.97);
    }
  }
  col += vec3(0.45, 0.5, 0.7) * uFlash * 0.35;
  // below the horizon: exactly the fog color, so the sea melts into the sky
  col = mix(col, uHorizon, smoothstep(0.0, -0.035, y));
  col = mix(col, uUnderwaterColor, uUnderwater);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const STAR_VERT = /* glsl */ `
attribute vec4 aStar; // size px, phase, brightness, twinkle speed
attribute vec3 aColor;
uniform float uStarVis;
uniform float uTime;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
${NOISE_GLSL}
${CLOUD_GLSL}
void main() {
  vec3 dir = normalize(position);
  vec3 wp = cameraPosition + dir * 1500.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  float tw = 0.72 + 0.28 * sin(uTime * aStar.w + aStar.y * 40.0);
  vAlpha = uStarVis * aStar.z * tw * (1.0 - wCloudDensity(dir)) * smoothstep(0.0, 0.14, dir.y);
  vColor = aColor;
  gl_PointSize = aStar.x * uPixelRatio;
  if (vAlpha < 0.004) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;
const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c) * 4.0;
  float a = exp(-r * 3.5) * (1.0 - step(1.0, r));
  gl_FragColor = vec4(vColor, a * vAlpha);
  #include <colorspace_fragment>
}
`;

const MOON_VERT = /* glsl */ `
uniform vec3 uMoonDir;
uniform float uMoonSize;
varying vec2 vUv;
varying float vCloud;
${NOISE_GLSL}
${CLOUD_GLSL}
void main() {
  vec3 center = cameraPosition + uMoonDir * 1400.0;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = center + (right * position.x + up * position.y) * uMoonSize;
  vUv = position.xy;
  vCloud = wCloudDensity(uMoonDir);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const MOON_FRAG = /* glsl */ `
uniform float uMoonVis;
uniform float uPhase;
varying vec2 vUv;
varying float vCloud;
${NOISE_GLSL}
void main() {
  vec2 p = vUv * 3.0; // disc radius 1 inside a 3x quad (room for the glow)
  float r = length(p);
  float disc = 1.0 - smoothstep(0.95, 1.0, r);
  vec3 n = vec3(p, sqrt(max(0.0, 1.0 - r * r)));
  vec3 L = normalize(vec3(sin(uPhase), 0.12, cos(uPhase)));
  float lit = smoothstep(-0.06, 0.14, dot(n, L));
  float maria = smoothstep(0.45, 0.7, wFbm3(p * 1.4 + 2.0));
  float crater = wNoise(p * 7.0);
  vec3 albedo = vec3(0.93, 0.94, 0.98) * (1.0 - 0.28 * maria) * (0.88 + 0.12 * crater);
  vec3 col = albedo * (lit + 0.05) * disc;
  float glow = exp(-max(r - 1.0, 0.0) * 2.4) * (1.0 - disc) * 0.22;
  col += vec3(0.55, 0.65, 1.0) * glow;
  float vis = uMoonVis * (1.0 - vCloud * 0.88);
  gl_FragColor = vec4(col * vis, 1.0);
  #include <colorspace_fragment>
}
`;

export function create(ctx) {
  const { scene, camera, config } = ctx;
  const shared = worldShared(ctx);
  const U = shared.uniforms;
  const G = config.graphics;

  // ── Fog (one FogExp2 for the whole game; only color/density mutate) ───────
  const fog = new THREE.FogExp2(0xa8cbe8, 0.0011);
  scene.fog = fog;
  if (!(scene.background instanceof THREE.Color)) scene.background = new THREE.Color();

  // ── Dome ─────────────────────────────────────────────────────────────────
  const domeUniforms = {
    uZenith: U.uZenith,
    uHorizon: U.uHorizon,
    uGlowColor: U.uGlowColor,
    uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
    uSunDir: U.uSunDir,
    uMoonDir: U.uMoonDir,
    uLightDir: U.uLightDir,
    uCloudLit: { value: new THREE.Color(1, 1, 1) },
    uCloudDark: { value: new THREE.Color(0.6, 0.65, 0.7) },
    uUnderwaterColor: { value: new THREE.Color(0x0d4a58) },
    uSunsetAmt: U.uSunsetAmt,
    uSunVis: { value: 1 },
    uStarVis: { value: 0 },
    uMoonGlow: { value: 0 },
    uFlash: U.uFlash,
    uUnderwater: { value: 0 },
    uCloudOffset: U.uCloudOffset,
    uCloudCover: U.uCloudCover,
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1000, 48, 24),
    new THREE.ShaderMaterial({
      name: 'world-sky-dome',
      uniforms: domeUniforms,
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    })
  );
  dome.name = 'sky-dome';
  dome.renderOrder = -1000;
  dome.frustumCulled = false;
  dome.onBeforeRender = (r, s, cam) => {
    dome.position.copy(cam.position);
    dome.updateMatrixWorld();
  };
  scene.add(dome);

  // ── Stars ────────────────────────────────────────────────────────────────
  const starRng = ctx.rng.fork('sky-stars');
  const STAR_N = 2200;
  const sp = new Float32Array(STAR_N * 3);
  const sa = new Float32Array(STAR_N * 4);
  const sc = new Float32Array(STAR_N * 3);
  for (let i = 0; i < STAR_N; i++) {
    // uniform on the upper hemisphere (+ a little below for the horizon)
    const y = starRng.range(-0.05, 1);
    const a = starRng() * Math.PI * 2;
    const rr = Math.sqrt(1 - y * y);
    sp[i * 3] = Math.cos(a) * rr;
    sp[i * 3 + 1] = y;
    sp[i * 3 + 2] = Math.sin(a) * rr;
    const big = starRng() < 0.06;
    sa[i * 4] = big ? starRng.range(2.6, 3.6) : starRng.range(1.2, 2.3);
    sa[i * 4 + 1] = starRng();
    sa[i * 4 + 2] = big ? starRng.range(0.85, 1) : starRng.range(0.25, 0.8);
    sa[i * 4 + 3] = starRng.range(1.2, 4.5);
    const tint = starRng();
    const col = tint < 0.2 ? [0.75, 0.85, 1.0] : tint > 0.85 ? [1.0, 0.88, 0.7] : [1, 1, 1];
    sc[i * 3] = col[0];
    sc[i * 3 + 1] = col[1];
    sc[i * 3 + 2] = col[2];
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  starGeo.setAttribute('aStar', new THREE.BufferAttribute(sa, 4));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(sc, 3));
  const starUniforms = {
    uStarVis: domeUniforms.uStarVis,
    uTime: ctx.uniforms.uTime,
    uPixelRatio: { value: Math.min(globalThis.devicePixelRatio || 1, G.maxPixelRatio) },
    uCloudOffset: U.uCloudOffset,
    uCloudCover: U.uCloudCover,
  };
  const stars = new THREE.Points(
    starGeo,
    new THREE.ShaderMaterial({
      name: 'world-stars',
      uniforms: starUniforms,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    })
  );
  stars.name = 'sky-stars';
  stars.frustumCulled = false;
  stars.renderOrder = -30;
  scene.add(stars);

  // ── Moon ─────────────────────────────────────────────────────────────────
  const moonUniforms = {
    uMoonDir: U.uMoonDir,
    uMoonSize: { value: 1400 * Math.tan((1.7 * Math.PI) / 180) * 3 },
    uMoonVis: { value: 0 },
    uPhase: { value: 0.5 },
    uCloudOffset: U.uCloudOffset,
    uCloudCover: U.uCloudCover,
  };
  const moon = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      name: 'world-moon',
      uniforms: moonUniforms,
      vertexShader: MOON_VERT,
      fragmentShader: MOON_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    })
  );
  moon.name = 'sky-moon';
  moon.frustumCulled = false;
  moon.renderOrder = -29;
  scene.add(moon);

  // ── Lights ───────────────────────────────────────────────────────────────
  const R = G.shadowRange;
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.name = 'sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(G.shadowMapSize, G.shadowMapSize);
  const sc2 = sun.shadow.camera;
  sc2.left = -R;
  sc2.right = R;
  sc2.top = R;
  sc2.bottom = -R;
  sc2.near = 1;
  sc2.far = 700;
  sc2.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 2;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0xbcd4f0, 0x6a6a44, 1.0);
  hemi.name = 'sky-hemi';
  const ambient = new THREE.AmbientLight(0x3a5088, 0.1);
  ambient.name = 'sky-ambient';
  scene.add(hemi, ambient);

  // ── State ────────────────────────────────────────────────────────────────
  const st = makeSkyState();
  const tmpC = new THREE.Color();
  const center = new THREE.Vector3();
  const snapped = { x: 0, y: 0, z: 0 };
  const fwd = new THREE.Vector3();
  const texel = (2 * R) / G.shadowMapSize;
  let fogOverride = null;
  let underwater = 0;
  // lightning flicker: a few decaying pulses
  const pulses = []; // [startTime, strength]
  let clock = 0;
  let flashLevel = 0;

  function setSRGB(color, rgb, scale = 1) {
    color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    if (scale !== 1) color.multiplyScalar(scale);
    return color;
  }

  const api = {
    sun,
    hemi,
    ambient,
    fog,
    dome,
    stars,
    moon,
    colors: { zenith: U.uZenith.value, horizon: U.uHorizon.value },
    daylight: 1,
    /** Override the base fog density (null = automatic). Weather still adds rain haze on top. */
    setFogDensity(d) {
      fogOverride = d == null ? null : Math.max(0, Number(d) || 0);
    },
    /** Lightning flash (sky, clouds and hemisphere light). */
    flash(strength = 1) {
      const s = Math.max(0.1, Math.min(2, strength));
      pulses.push([clock, s], [clock + 0.08 + Math.random() * 0.05, s * 0.45], [clock + 0.19 + Math.random() * 0.1, s * 0.8]);
      if (pulses.length > 12) pulses.splice(0, pulses.length - 12);
    },
    /** Called by water when the camera is below a surface: the dome turns into murky water. */
    setUnderwater(amount, color) {
      underwater = amount;
      domeUniforms.uUnderwater.value = amount;
      if (color) domeUniforms.uUnderwaterColor.value.copy(color);
    },
    init() {},
    update(dt) {
      clock += dt;
      const T = ctx.time;
      const sunDir = T.sunDir;
      const moonDir = T.moonDir;
      U.uSunDir.value.copy(sunDir);
      U.uMoonDir.value.copy(moonDir);

      const W = ctx.weather;
      const cloud = W?.cloudiness ?? 0.2;
      const rain = W?.rain ?? 0;
      const storm = W?.storm ?? 0;
      const day = T.day || 1;
      const phase = 0.55 + (day - 1) * 0.785; // ~8-day lunar cycle
      const illum = 0.5 + 0.5 * Math.cos(phase);
      moonUniforms.uPhase.value = phase;

      skyState(sunDir.y, moonDir.y, cloud, storm, rain, illum, st);

      // sky gradient + fog (fog === horizon, linear colors)
      setSRGB(U.uZenith.value, st.zen);
      setSRGB(U.uHorizon.value, st.hor);
      setSRGB(U.uGlowColor.value, st.glow);
      setSRGB(domeUniforms.uSunColor.value, st.sun);
      setSRGB(domeUniforms.uCloudLit.value, st.cLit);
      setSRGB(domeUniforms.uCloudDark.value, st.cDark);
      U.uSunsetAmt.value = st.sunsetAmt;
      U.uCloudCover.value = cloud;
      domeUniforms.uSunVis.value = st.sunVis;
      domeUniforms.uStarVis.value = st.starVis * (underwater > 0.5 ? 0 : 1);
      domeUniforms.uMoonGlow.value = smooth(0.05, -0.15, sunDir.y) * (0.4 + 0.6 * illum) * (1 - cloud * 0.7);
      moonUniforms.uMoonVis.value = (underwater > 0.5 ? 0 : 1) * smooth(-0.04, 0.06, moonDir.y) * (1 - 0.65 * T.daylight);
      fog.color.copy(U.uHorizon.value);
      if (scene.background?.isColor) scene.background.copy(U.uHorizon.value);
      fog.density = (fogOverride ?? st.fogDensity - (0.0038 * rain + 0.0028 * storm)) + 0.0038 * rain + 0.0028 * storm;

      // clouds drift with the wind
      const wx = ctx.uniforms.uWind.value.x, wz = ctx.uniforms.uWind.value.y;
      const ws = ctx.uniforms.uWindStrength.value;
      U.uCloudOffset.value.x += wx * (0.004 + 0.014 * ws) * dt;
      U.uCloudOffset.value.y += wz * (0.004 + 0.014 * ws) * dt;
      U.uCloudGround.value.x -= wx * (3 + 10 * ws) * dt;
      U.uCloudGround.value.y -= wz * (3 + 10 * ws) * dt;
      U.uCloudShadow.value = st.cloudShadow;

      // lightning pulses
      flashLevel = 0;
      for (let i = pulses.length - 1; i >= 0; i--) {
        const age = clock - pulses[i][0];
        if (age < 0) continue;
        const v = pulses[i][1] * Math.exp(-age * 16);
        if (v < 0.005) pulses.splice(i, 1);
        else flashLevel += v;
      }
      U.uFlash.value = flashLevel;

      // ── key light: sun by day, moon at night (crossfade through ~0) ──
      const useSun = st.sunI >= st.moonI;
      const dir = useSun ? sunDir : moonDir;
      U.uLightDir.value.copy(dir);
      if (useSun) {
        setSRGB(sun.color, st.sun);
        sun.intensity = st.sunI;
      } else {
        sun.color.setRGB(0.62, 0.72, 1.0, THREE.SRGBColorSpace);
        sun.intensity = st.moonI;
      }
      sun.visible = sun.intensity > 0.002;
      // fade shadows near the horizon (long streaks) and under thick clouds
      sun.shadow.intensity = smooth(0.03, 0.14, dir.y) * (1 - 0.6 * smooth(0.6, 1.0, cloud));
      U.uLightColor.value.copy(sun.color).multiplyScalar(sun.intensity);

      // hemisphere + ambient
      setSRGB(hemi.color, st.hSky);
      setSRGB(hemi.groundColor, st.hGnd);
      hemi.intensity = st.hemiI + flashLevel * 3.5;
      ambient.color.setRGB(st.amb[0], st.amb[1], st.amb[2], THREE.SRGBColorSpace);
      ambient.intensity = st.ambI;
      U.uAmbientColor.value.copy(hemi.color).multiplyScalar(hemi.intensity);
      tmpC.copy(ambient.color).multiplyScalar(ambient.intensity);
      U.uAmbientColor.value.add(tmpC);

      // shared daylight (dimmer under heavy overcast)
      const dl = T.daylight * (1 - 0.35 * st.overcast);
      ctx.uniforms.uDaylight.value = dl;
      api.daylight = dl;

      // ── shadow box follows the player (or what the camera looks at) ──
      const p = ctx.player?.position;
      if (p && (ctx.state === 'playing' || ctx.state === 'dead' || ctx.state === 'paused') && Number.isFinite(p.x)) {
        center.copy(p);
        // shift the box a bit toward where the player looks: more useful shadow texels
        camera.getWorldDirection(fwd);
        fwd.y = 0;
        if (fwd.lengthSq() > 1e-6) center.addScaledVector(fwd.normalize(), R * 0.3);
      } else {
        camera.getWorldDirection(fwd);
        center.copy(camera.position).addScaledVector(fwd, R * 0.6);
        const g = ctx.world.heightAt(center.x, center.z);
        center.y = Math.max(g, 0);
      }
      snapToTexel(center, dir, texel, snapped);
      sun.target.position.set(snapped.x, snapped.y, snapped.z);
      sun.position.set(snapped.x + dir.x * 300, snapped.y + dir.y * 300, snapped.z + dir.z * 300);
      sun.target.updateMatrixWorld();
    },
  };
  return api;
}
