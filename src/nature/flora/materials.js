// Flora materials: MeshLambertMaterial (vertex colors, flat low-poly shading, scene fog) patched with
// onBeforeCompile for
//   - wind sway from ctx.uniforms (uTime, uWind, uWindStrength): rolling gust fronts travel across the
//     island along the wind, each tree sways with its own phase, leaves flutter. Trunks are stiff
//     (bend weight 0 at the base, see species.js bendBy); palms carry larger weights so they bend more.
//   - leaf translucency: leaves glow warmly when you look toward the sun through them.
//   - V4-D: per-plant color jitter (value +-8 %, hue +-3 %, keyed on the per-plant phase aWind.z) and a soft
//     warm rim / wrap sheen on leaves facing the sun.
//   - flowers (aClose attribute): petals fold up at night, driven by ctx.uniforms.uDaylight.
//   - grass (instanced): fades out at the patch edge, sways in waves, bends away from the player.
// The same vertex patch runs in a shared MeshDepthMaterial so shadows sway with the trees.
// Wind displacement is computed in world space then mapped back into object space, so it works for
// merged chunks (identity matrix), InstancedMesh (saplings, grass) and rotated props (falling trees).
import * as THREE from 'three';
import { BEND_MAX, FLUTTER_MAX, CLOSE_MAX } from './bake.js';

const f = (v) => v.toFixed(4);

/** Shared wind function + attribute declarations (vertex shader). */
export const WIND_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
attribute vec4 aWind;
// Wind displacement (world space, meters) for a vertex at world position wp.
// bend: sway amplitude (m) at wind strength 1; flutter: leaf jitter (m); ph: per-plant phase 0..1.
vec3 floraWind(vec3 wp, float bend, float flutter, float ph) {
  float s = clamp(uWindStrength, 0.0, 1.6);
  vec2 wd = uWind / max(length(uWind), 1e-4);
  vec2 perp = vec2(-wd.y, wd.x);
  float along = dot(wp.xz, wd);
  // gust fronts rolling across the island in the wind direction
  float g = sin(along * 0.035 - uTime * (0.8 + 0.9 * s)) * 0.5 + 0.5;
  g = g * g * (0.65 + 0.35 * sin(along * 0.011 + dot(wp.xz, perp) * 0.02 - uTime * 0.37));
  float t = uTime * (1.15 + ph * 0.55) + ph * 6.2831;
  float sw = sin(t) * 0.65 + sin(t * 2.13 + 1.7) * 0.35;
  float lean = bend * (s * (0.12 + 0.6 * g) * (0.4 + 0.6 * s) + (0.05 + s) * 0.2 * sw);
  float side = bend * (0.04 + s) * 0.11 * sin(t * 0.77 + 2.1);
  vec3 d = vec3(wd.x * lean + perp.x * side, 0.0, wd.y * lean + perp.y * side);
  d.y = -0.1 * (lean * lean + side * side);
  float fl = flutter * (0.35 + 1.25 * s) * (0.65 + 0.5 * g);
  vec3 q = wp * 1.7 + ph * 13.0;
  d += fl * vec3(sin(uTime * 6.3 + q.x + q.y), 0.6 * sin(uTime * 7.7 + q.z + q.y), sin(uTime * 5.9 + q.x - q.z));
  return d;
}
`;

/** Applies the wind (and the flower close pose) to \`transformed\`; insert after <begin_vertex>. */
const WIND_APPLY = /* glsl */ `
{
  mat4 fM = modelMatrix;
  #ifdef USE_INSTANCING
    fM = modelMatrix * instanceMatrix;
  #endif
  mat3 fR = mat3(fM);
  float fS2 = max(dot(fR[0], fR[0]), 1e-6);
  float fS = sqrt(fS2);
  #ifdef FLORA_CLOSE
    // petals fold up at night (daylight -> open); each head has its own small phase offset
    float fOpen = smoothstep(0.08, 0.5, uDaylight + aClose.w * 0.09);
    transformed += aClose.xyz * ${f(CLOSE_MAX)} * (1.0 - fOpen) / fS;
  #endif
  vec3 fwp = (fM * vec4(transformed, 1.0)).xyz;
  vec3 fD = floraWind(fwp, aWind.x * ${f(BEND_MAX)} * fS, aWind.y * ${f(FLUTTER_MAX)} * fS, aWind.z);
  transformed += transpose(fR) * fD / fS2;
}
`;

const LEAF_VARYINGS = /* glsl */ `
varying vec3 vFloraWP;
varying float vFloraLeaf;
varying float vFloraPh;
`;

const LEAF_VARY_SET = /* glsl */ `
{
  #ifdef USE_INSTANCING
    vFloraWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
    vFloraWP = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif
  vFloraLeaf = aWind.w;
  vFloraPh = aWind.z;
}
`;

/** Per-plant color jitter (aWind.z = per-plant random phase; 0 = props without wind data: untouched). */
const JITTER_FRAG = /* glsl */ `
{
  float fOn = step(1e-5, vFloraPh);
  float fH1 = fract(sin(vFloraPh * 91.37 + 1.3) * 43758.55);
  float fH2 = fract(sin(vFloraPh * 57.11 + 4.7) * 24634.63);
  float fLeafK = clamp(vFloraLeaf * 4.0, 0.0, 1.0);
  // hue +-3 % of the wheel (~ +-0.19 rad) on leaves, rotation about the grey axis
  float fA = (fH2 - 0.5) * 0.38 * fLeafK * fOn;
  vec3 fK = vec3(0.57735);
  vec3 fC = diffuseColor.rgb;
  float fCa = cos(fA), fSa = sin(fA);
  fC = fC * fCa + cross(fK, fC) * fSa + fK * dot(fK, fC) * (1.0 - fCa);
  // value +-8 % (leaves), +-5 % (bark)
  diffuseColor.rgb = max(fC, 0.0) * (1.0 + (fH1 - 0.5) * mix(0.1, 0.16, fLeafK) * fOn);
}
`;

/** Back-lit leaves: warm glow when looking toward the sun through foliage, plus a soft sun-side rim. */
const LEAF_FRAG = /* glsl */ `
{
  vec3 fV = normalize(vFloraWP - cameraPosition);
  vec3 fL = normalize(uSunDir);
  float fDot = max(dot(fV, fL), 0.0);
  float fBack = pow(fDot, 7.0) * 0.9 + pow(fDot, 2.0) * 0.18;
  // fake translucency/rim: grazing edges of sun-facing leaves pick up a warm sheen (view space)
  vec3 fLv = normalize((viewMatrix * vec4(fL, 0.0)).xyz);
  float fFace = max(dot(normal, fLv), 0.0);
  float fRim = pow(1.0 - max(dot(normal, normalize(vViewPosition)), 0.0), 3.0);
  float fSheen = fFace * (0.55 * fRim + 0.1) * clamp(fL.y * 6.0, 0.0, 1.0); // none once the sun has set
  totalEmissiveRadiance += diffuseColor.rgb * uSunColor * vec3(1.06, 1.0, 0.72) * (vFloraLeaf * (fBack + fSheen));
}
`;

export function createFloraMaterials(ctx) {
  const U = ctx.uniforms;
  // Flora-only uniforms (updated by flora.update)
  const FU = {
    uSunDir: { value: ctx.time?.sunDir || new THREE.Vector3(0.3, 0.8, 0.3) },
    uSunColor: { value: new THREE.Color(0, 0, 0) },
    uGrassCenter: { value: new THREE.Vector3(0, -1000, 0) },
    uGrassRadius: { value: 40 },
    uPlayer: { value: new THREE.Vector3(0, -1000, 0) },
  };

  function bindWind(shader) {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.uniforms.uWindStrength = U.uWindStrength;
    shader.uniforms.uDaylight = U.uDaylight;
  }

  /** Trees, boulders, saplings, props (and undergrowth with close=true). */
  function makeFoliage({ close = false, key = 'flora-tree', transparent = false } = {}) {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent });
    m.name = key;
    if (close) m.defines = { FLORA_CLOSE: '' };
    m.onBeforeCompile = (shader) => {
      bindWind(shader);
      shader.uniforms.uSunDir = FU.uSunDir;
      shader.uniforms.uSunColor = FU.uSunColor;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
${WIND_PARS}
${LEAF_VARYINGS}
#ifdef FLORA_CLOSE
attribute vec4 aClose;
uniform float uDaylight;
#endif`
        )
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_APPLY}`)
        .replace('#include <project_vertex>', `#include <project_vertex>\n${LEAF_VARY_SET}`);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
${LEAF_VARYINGS}`
        )
        .replace('#include <color_fragment>', `#include <color_fragment>\n${JITTER_FRAG}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${LEAF_FRAG}`);
    };
    m.customProgramCacheKey = () => key + (close ? '+close' : '') + '+v4d';
    return m;
  }

  /** Shadow depth with the same sway (shared by every swaying caster). */
  function makeDepth() {
    const m = new THREE.MeshDepthMaterial();
    m.name = 'flora-depth';
    m.onBeforeCompile = (shader) => {
      bindWind(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${WIND_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_APPLY}`);
    };
    m.customProgramCacheKey = () => 'flora-depth';
    return m;
  }

  /** Instanced grass tufts: soft (non-flat) up-facing normals, double-sided, edge fade, player push. */
  function makeGrass() {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    m.name = 'flora-grass';
    m.onBeforeCompile = (shader) => {
      bindWind(shader);
      shader.uniforms.uGrassCenter = FU.uGrassCenter;
      shader.uniforms.uGrassRadius = FU.uGrassRadius;
      shader.uniforms.uPlayer = FU.uPlayer;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
${WIND_PARS}
uniform vec3 uGrassCenter;
uniform float uGrassRadius;
uniform vec3 uPlayer;
varying vec2 vGrassJ;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
{
  mat4 fM = modelMatrix;
  #ifdef USE_INSTANCING
    fM = modelMatrix * instanceMatrix;
  #endif
  vec3 fBase = (fM * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float fDc = length(fBase.xz - uGrassCenter.xz);
  float fFade = 1.0 - smoothstep(uGrassRadius * 0.7, uGrassRadius, fDc);
  transformed.y *= fFade;
  transformed.xz *= 0.35 + 0.65 * fFade;
  mat3 fR = mat3(fM);
  float fS2 = max(dot(fR[0], fR[0]), 1e-6);
  float fS = sqrt(fS2);
  vec3 fwp = (fM * vec4(transformed, 1.0)).xyz;
  float fw = aWind.x;
  vec3 fD = floraWind(fwp, fw * ${f(BEND_MAX)} * fS, aWind.y * ${f(FLUTTER_MAX)} * fS, aWind.z);
  // bend away from the player's legs
  vec2 fAway = fwp.xz - uPlayer.xz;
  float fDp = length(fAway);
  float fPush = (1.0 - smoothstep(0.25, 1.25, fDp)) * (1.0 - smoothstep(1.2, 2.2, abs(fBase.y - uPlayer.y)));
  float fH = transformed.y * fS;
  fD.xz += fAway / max(fDp, 1e-3) * fPush * fH * 0.75;
  fD.y -= fPush * fH * 0.45;
  transformed += transpose(fR) * fD / fS2;
  // per-tuft jitter seeds (V4-D)
  vGrassJ = fract(sin(vec2(dot(fBase.xz, vec2(12.9898, 78.233)), dot(fBase.xz, vec2(39.346, 11.135)))) * 43758.55);
}`
        );
      // keep the up-facing normal on both sides (no dark back faces); per-tuft value/hue jitter
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vGrassJ;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
diffuseColor.rgb *= 1.0 + (vGrassJ.x - 0.5) * 0.16;
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 1.0, 0.8), (vGrassJ.y - 0.5) * 0.7);`
        )
        .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
#ifndef FLAT_SHADED
  normal = normalize(vNormal);
#endif`
      );
    };
    m.customProgramCacheKey = () => 'flora-grass+v4d';
    return m;
  }

  const tree = makeFoliage({ key: 'flora-tree' });
  const under = makeFoliage({ key: 'flora-under', close: true });
  const depth = makeDepth();
  const grass = makeGrass();

  const _c = new THREE.Color();
  return {
    tree,
    under,
    depth,
    grass,
    uniforms: FU,
    /** A fading copy of the tree material (fallen logs). Same program as `tree`. */
    makeFading() {
      const m = makeFoliage({ key: 'flora-tree', transparent: true });
      m.opacity = 1;
      return m;
    },
    /** Per-frame: sun color for leaf translucency (from Builder A's DirectionalLight if present). */
    update() {
      const sun = ctx.sky?.sun;
      const dl = U.uDaylight?.value ?? 1;
      if (sun && sun.color) {
        _c.copy(sun.color).multiplyScalar(Math.min(4, sun.intensity ?? 2) * 0.16);
      } else {
        _c.setRGB(1.0, 0.86, 0.62).multiplyScalar(0.4 * dl);
      }
      // a touch less glow when the sky is overcast
      const cloud = ctx.weather?.cloudiness ?? 0;
      FU.uSunColor.value.copy(_c).multiplyScalar(1 - 0.6 * cloud);
    },
  };
}
