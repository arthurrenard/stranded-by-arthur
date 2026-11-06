// Shared materials + shader patches for Builder C. Created ONCE and shared by every kind.
//
// - Wind sway: vertices move by aSway meters (baked into each geometry), in world space, along
//   ctx.uniforms.uWind, scaled by uWindStrength and by the instance's own scale (sprouts sway less).
// - Mineral: per-vertex metalness/roughness/sparkle from aPbr (flint = glossy core + chalky cortex,
//   pyrite = metallic brass cubes on a matte rock matrix), twinkling emissive glints, a brassy
//   emissive floor so metal never renders black, and a tiny procedural PMREM environment.
import * as THREE from 'three';

const SWAY_VERTEX_PARS = /* glsl */ `
attribute float aSway;
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
`;

// Replaces <project_vertex>: sway is applied after the instance transform (meshes sit at the origin,
// so instance space == world space).
const SWAY_PROJECT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 swIPos = instanceMatrix[3].xyz;
  float swScale = length( instanceMatrix[1].xyz );
#else
  vec3 swIPos = vec3( 0.0 );
  float swScale = 1.0;
#endif
{
  float sw = aSway * swScale;
  if ( sw > 0.0 ) {
    float ph = swIPos.x * 0.21 + swIPos.z * 0.17;
    float wave = sin( uTime * 1.9 + ph ) * 0.62 + sin( uTime * 3.4 + ph * 1.9 ) * 0.38;
    float gust = 0.7 + 0.3 * sin( uTime * 0.45 + ph * 0.05 );
    float str = ( 0.3 + uWindStrength * 1.3 ) * gust;
    vec2 wd = uWind;
    float lw = length( wd );
    wd = lw > 0.001 ? wd / lw : vec2( 1.0, 0.0 );
    float push = sw * str * ( 0.55 + 0.45 * wave );
    mvPosition.xz += wd * push + vec2( -wd.y, wd.x ) * sw * 0.22 * sin( uTime * 2.7 + ph * 2.3 );
    mvPosition.y -= push * 0.18;
  }
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

/** Patch any built-in material with world-space wind sway driven by the shared ctx.uniforms. */
export function patchSway(material, uniforms, extra = null) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SWAY_VERTEX_PARS)
      .replace('#include <project_vertex>', SWAY_PROJECT);
    extra?.(shader, renderer);
    prev?.call(material, shader, renderer);
  };
  const key = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => 'resSway|' + (key ? key() : '') + (extra ? '|x' : '');
  return material;
}

/** Mineral patch (requires aPbr attribute): per-vertex metal/rough + emissive glints. */
function mineralExtra(uniforms, matUniforms) {
  return (shader) => {
    shader.uniforms.uSparkle = matUniforms.uSparkle;
    shader.uniforms.uBrass = matUniforms.uBrass;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 aPbr;\nvarying vec3 vPbr;\nvarying vec3 vSparkPos;'
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vPbr = aPbr;
        #ifdef USE_INSTANCING
          vSparkPos = position + instanceMatrix[3].xyz * 3.17;
        #else
          vSparkPos = position;
        #endif`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vPbr;
        varying vec3 vSparkPos;
        uniform float uTime;
        uniform float uSparkle;
        uniform float uBrass;
        float resHash3( vec3 p ) {
          p = fract( p * 0.3183099 + 0.1 );
          p *= 17.0;
          return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
        }`
      )
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.x;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.y;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float cell = resHash3( floor( vSparkPos * 26.0 ) );
          float tw = 0.5 + 0.5 * sin( uTime * 2.3 + cell * 71.0 );
          tw = tw * tw; tw = tw * tw; tw = tw * tw; // ^8: short bright twinkles
          float facing = clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 );
          float glint = step( 0.84, cell ) * tw * vPbr.z * ( 0.35 + 0.65 * facing );
          totalEmissiveRadiance += vec3( 1.0, 0.86, 0.52 ) * glint * uSparkle;
          totalEmissiveRadiance += vec3( 0.30, 0.22, 0.06 ) * vPbr.z * uBrass;
        }`
      );
  };
}

/** A tiny procedural sky/ground gradient environment so metallic pyrite reflects something warm. */
function makeEnvMap(renderer) {
  if (!renderer || typeof renderer.getContext !== 'function') return null;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const scene = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 32, 16);
    const col = [];
    const top = new THREE.Color(0x8fbfe8), hor = new THREE.Color(0xffe6b8), gnd = new THREE.Color(0x5e5238);
    const c = new THREE.Color();
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / 10;
      if (y > 0) c.copy(hor).lerp(top, Math.pow(y, 0.6));
      else c.copy(hor).lerp(gnd, Math.min(1, -y * 3));
      col.push(c.r * 1.4, c.g * 1.4, c.b * 1.4);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const rt = pmrem.fromScene(scene, 0.04);
    pmrem.dispose();
    geo.dispose();
    return rt.texture;
  } catch (e) {
    console.warn('[resources] env map failed (pyrite will use emissive only)', e);
    return null;
  }
}

/**
 * Create the shared material set.
 * @returns {{ solid, foliage, glossy, mineral, decal, setDaylight(d) }}
 */
export function createResourceMaterials(ctx) {
  const U = ctx.uniforms;
  const solid = patchSway(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0, flatShading: true }),
    U
  );
  const foliage = patchSway(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0,
      flatShading: true,
      side: THREE.DoubleSide,
    }),
    U
  );
  const glossy = patchSway(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.05, flatShading: true }),
    U
  );
  const mineralU = { uSparkle: { value: 2.2 }, uBrass: { value: 0.22 } };
  const mineral = patchSway(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.3,
      metalness: 1,
      flatShading: true,
      envMapIntensity: 1,
    }),
    U,
    mineralExtra(U, mineralU)
  );
  mineral.customProgramCacheKey = () => 'resMineral';
  const env = makeEnvMap(ctx.renderer);
  if (env) mineral.envMap = env;

  return {
    solid,
    foliage,
    glossy,
    mineral,
    /** Called every frame-ish: dims reflections and glints at night. */
    setDaylight(d) {
      mineral.envMapIntensity = 0.12 + 0.95 * d;
      mineralU.uSparkle.value = 0.7 + 1.9 * d;
      mineralU.uBrass.value = 0.08 + 0.18 * d;
    },
  };
}

/** Soft round point sprite (DataTexture, no DOM) for harvest particle bursts. */
export function makeDotTexture(size = 32) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5, dy = (y + 0.5) / size - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = Math.max(0, Math.min(1, (1 - r) * 3));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
