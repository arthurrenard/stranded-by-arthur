// Storm swell for the intro (Builder F). A local, flat-shaded sea patch with big faceted waves that
// rides on top of the regular ocean around the fishing boat, plus the IDENTICAL wave function in
// JS so the boat can float on the very waves you see. The patch fades out (alpha + height) toward
// its rim and toward the island (north of `landZ`), so it blends into the normal ocean.
//
// The surface never dips below sea level (heights are lifted by the max amplitude), so the regular
// ocean underneath can't poke through the troughs. Inside the hull footprint the water is pushed
// under the deck (no sea sloshing through the boat).
//
// MeshStandardMaterial + onBeforeCompile: fog, lights and tone mapping keep working.
import * as THREE from 'three';

// [amplitude m, wavelength m, dirX, dirZ, phase]: a long swell rolling north toward the island,
// with two cross seas and a short chop on top.
const WAVES_SRC = [
  [0.95, 44, 0.22, -1, 0.0],
  [0.5, 26, -0.55, -0.85, 1.7],
  [0.26, 13, 0.85, -0.5, 4.1],
  [0.12, 7.5, -0.15, -1, 2.3],
];
const G = 9.81;
const WAVES = WAVES_SRC.map(([a, len, dx, dz, p]) => {
  const l = Math.hypot(dx, dz);
  const k = (2 * Math.PI) / len;
  return { a, k, dx: dx / l, dz: dz / l, w: Math.sqrt(G * k) * 0.92, p };
});
/** Sum of the wave amplitudes (the surface is lifted by this so troughs stay above sea level). */
export const SWELL_MAX = WAVES.reduce((s, w) => s + w.a, 0);
const BASE = SWELL_MAX + 0.35;

/** Raw wave height (-SWELL_MAX..SWELL_MAX) at world x,z and time t (s). Pure, node-safe. */
export function swellHeight(x, z, t, amp = 1) {
  let h = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    h += w.a * Math.sin(w.k * (w.dx * x + w.dz * z) - w.w * t + w.p);
  }
  return h * amp;
}

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const GLSL_WAVES = WAVES.map(
  (w) => `h += ${w.a.toFixed(4)} * sin(${w.k.toFixed(5)} * dot(vec2(${w.dx.toFixed(5)}, ${w.dz.toFixed(5)}), p) - ${w.w.toFixed(5)} * t + ${w.p.toFixed(4)});`
).join('\n    ');

const VERT_PARS = /* glsl */ `
uniform float uSwTime;
uniform float uSwAmp;
uniform vec3 uSwCenter;   // x, z, radius
uniform float uSwLandZ;
uniform vec3 uSwReef;     // x, z, radius: the swell breaks and flattens over the reef
uniform vec4 uSwBoat;     // x, z, yaw, waterline y
varying float vSwFade;
varying float vSwFoam;
float swWaves(vec2 p, float t) {
  float h = 0.0;
  ${GLSL_WAVES}
  return h * uSwAmp;
}
float swReef(vec2 p) {
  return smoothstep(uSwReef.z * 0.45, uSwReef.z, length(p - uSwReef.xy));
}
float swFade(vec2 p) {
  float r = length(p - uSwCenter.xy);
  return smoothstep(uSwCenter.z, uSwCenter.z * 0.55, r) * smoothstep(uSwLandZ, uSwLandZ + 28.0, p.y);
}
`;

const VERT_MAIN = /* glsl */ `
#include <begin_vertex>
{
  vec4 swW = modelMatrix * vec4(transformed, 1.0);
  float swOuter = swFade(swW.xz);
  float swR = swReef(swW.xz);
  float swF = swOuter * swR;
  float swH = swWaves(swW.xz, uSwTime);
  float swY = swF * (${BASE.toFixed(4)} * uSwAmp + 0.0001 + swH);
  // push the water under the hull (ellipse ~ boat footprint, in boat-local coordinates)
  vec2 bl = swW.xz - uSwBoat.xy;
  float cy = cos(uSwBoat.z), sy = sin(uSwBoat.z);
  vec2 loc = vec2(cy * bl.x - sy * bl.y, sy * bl.x + cy * bl.y);
  float inHull = 1.0 - smoothstep(0.7, 1.0, length(vec2(loc.x / 2.7, loc.y / 6.9)));
  swY = mix(swY, min(swY, uSwBoat.w - 0.4), inHull);
  transformed.y += swY;
  vSwFade = swF;
  vSwFoam = max(smoothstep(0.5, 1.0, swH / (${SWELL_MAX.toFixed(4)} * max(uSwAmp, 0.001))) * swF, (1.0 - swR) * swOuter * 0.9);
}
`;

const FRAG_PARS = /* glsl */ `
varying float vSwFade;
varying float vSwFoam;
`;
const FRAG_MAIN = /* glsl */ `
#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.70, 0.72), vSwFoam * 0.75);
diffuseColor.a *= smoothstep(0.0, 0.4, vSwFade);
`;

/**
 * createStormSea({ size, segments }) -> { mesh, setCenter(x, z, r), setLandZ(z), setReef(x, z, r), setTime(t), setAmp(a),
 *   setBoat(x, z, yaw, waterlineY), surfaceAt(x, z) (world y, matching the GPU), dispose() }
 */
export function createStormSea({ size = 460, segments = 150 } = {}) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  geo.computeBoundingSphere();
  geo.boundingSphere.radius += 4;
  const uniforms = {
    uSwTime: { value: 0 },
    uSwAmp: { value: 1 },
    uSwCenter: { value: new THREE.Vector3(0, 0, size * 0.5) },
    uSwLandZ: { value: -1e5 },
    uSwReef: { value: new THREE.Vector3(0, 0, 0.001) },
    uSwBoat: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  const mat = new THREE.MeshStandardMaterial({
    color: 0x173a4c,
    roughness: 0.3,
    metalness: 0.05,
    flatShading: true,
    transparent: true,
    depthWrite: true,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', FRAG_MAIN);
  };
  mat.customProgramCacheKey = () => 'stranded-storm-sea';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'intro-storm-sea';
  mesh.renderOrder = 2; // after the regular ocean
  mesh.receiveShadow = false;
  mesh.castShadow = false;

  const api = {
    mesh,
    uniforms,
    setCenter(x, z, r = size * 0.5) {
      mesh.position.set(x, 0, z);
      uniforms.uSwCenter.value.set(x, z, r);
    },
    setLandZ(z) {
      uniforms.uSwLandZ.value = z;
    },
    /** Waves flatten (and foam) within `r` of the reef center. */
    setReef(x, z, r) {
      uniforms.uSwReef.value.set(x, z, r);
    },
    setTime(t) {
      uniforms.uSwTime.value = t;
    },
    setAmp(a) {
      uniforms.uSwAmp.value = a;
    },
    setBoat(x, z, yaw, waterY) {
      uniforms.uSwBoat.value.set(x, z, yaw, waterY);
    },
    /** World-space fade 0..1 of the swell at x,z (rim + island side). */
    fadeAt(x, z) {
      const c = uniforms.uSwCenter.value;
      const rf = uniforms.uSwReef.value;
      const r = Math.hypot(x - c.x, z - c.y);
      const reef = smooth(rf.z * 0.45, rf.z, Math.hypot(x - rf.x, z - rf.y));
      return smooth(c.z, c.z * 0.55, r) * smooth(uniforms.uSwLandZ.value, uniforms.uSwLandZ.value + 28, z) * reef;
    },
    /** World y of the visible surface at x,z (ignores the hull push-down). Matches the shader. */
    surfaceAt(x, z) {
      const f = api.fadeAt(x, z);
      const a = uniforms.uSwAmp.value;
      return f * (BASE * a + 0.0001 + swellHeight(x, z, uniforms.uSwTime.value, a));
    },
    dispose() {
      mesh.parent?.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
  return api;
}
