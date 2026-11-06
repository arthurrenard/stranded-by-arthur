// Builder A — Terrain. One mesh built from ctx.world.buildGeometry() (exactly the query grid),
// colored per vertex from ctx.world.biomeAt(), plus shader detail via onBeforeCompile:
// world-space noise (grass speckle, sand ripples, rock strata), a subtle low-poly facet look,
// an animated wet band at the sea shore, rain wetness, drifting cloud shadows and caustics
// on shallow water beds. API: { mesh, material }.
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { terrainColor } from './fx/terrainColors.js';
import { worldShared } from './fx/shared.js';
import { NOISE_GLSL } from './fx/glsl.js';

export function create(ctx) {
  const W = ctx.world;
  const shared = worldShared(ctx);
  const U = shared.uniforms;

  const geo = W.buildGeometry();
  const pos = geo.attributes.position.array;
  const count = pos.length / 3;
  const colors = new Float32Array(count * 3);
  const biome = new Float32Array(count * 4);

  const rng = ctx.rng.fork('terrain-colors');
  const nLow = createNoise2D(rng);
  const nMid = createNoise2D(rng);
  const nHigh = createNoise2D(rng);
  const rgb = [0, 0, 0];
  // fast path for the deep sea floor (most of the grid): skip biomeAt()
  const deep = { h: 0, slope: 0, rn: 2, water: { type: 'ocean', depth: 0 }, sand: 0, rock: 0, highland: 0, meadow: 0, wet: 0, forest: 0 };
  const lakes = W.lakes || [];

  for (let k = 0; k < count; k++) {
    const x = pos[k * 3], h = pos[k * 3 + 1], z = pos[k * 3 + 2];
    const n1 = nLow(x * 0.012, z * 0.012);
    const n2 = nMid(x * 0.05, z * 0.05);
    const n3 = nHigh(x * 0.21, z * 0.21);
    let b;
    if (h < -3) {
      deep.h = h;
      deep.water.depth = -h;
      b = deep;
    } else {
      b = W.biomeAt(x, z);
    }
    // height above the nearest fresh water surface (for mud banks + caustics)
    let fresh = Infinity;
    if (h >= -3) {
      for (const L of lakes) {
        const dl = Math.hypot(x - L.x, z - L.z);
        if (dl < L.waterRadius * 1.4) fresh = Math.min(fresh, h - L.level);
      }
      const rv = W.riverAt?.(x, z);
      if (rv && rv.d < rv.w * 2.5 && rv.surface > 0.05) fresh = Math.min(fresh, h - rv.surface);
    }
    terrainColor(b, n1, n2, n3, fresh, rgb);
    colors[k * 3] = rgb[0];
    colors[k * 3 + 1] = rgb[1];
    colors[k * 3 + 2] = rgb[2];

    // aBiome: x sand, y rock, z ocean-shore flag, w signed water depth (+ under water, - dry)
    const ocean = fresh === Infinity ? Math.min(1, Math.max(0, (b.rn - 0.7) / 0.15)) : 0;
    let wd;
    if (b.water) wd = b.water.depth;
    else if (fresh !== Infinity) wd = -Math.min(2, Math.max(0, fresh));
    else wd = -Math.min(2, Math.max(0, h));
    biome[k * 4] = b.sand;
    biome[k * 4 + 1] = b.rock;
    biome[k * 4 + 2] = ocean;
    biome[k * 4 + 3] = wd;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aBiome', new THREE.BufferAttribute(biome, 4));

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.name = 'world-terrain';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = ctx.uniforms.uTime;
    shader.uniforms.uTide = U.uTide;
    shader.uniforms.uWet = U.uWet;
    shader.uniforms.uCloudCover = U.uCloudCover;
    shader.uniforms.uCloudGround = U.uCloudGround;
    shader.uniforms.uCloudShadow = U.uCloudShadow;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aBiome;
varying vec4 vTBiome;
varying vec3 vTWorld;`
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
vTBiome = aBiome;
vTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform float uTide;
uniform float uWet;
uniform float uCloudCover;
uniform vec2 uCloudGround;
uniform float uCloudShadow;
varying vec4 vTBiome;
varying vec3 vTWorld;
${NOISE_GLSL}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float tDist = length(vTWorld - cameraPosition);
float tFade = 1.0 - smoothstep(30.0, 140.0, tDist);
float tGrass = (1.0 - vTBiome.x) * (1.0 - vTBiome.y);
float tN1 = wNoise(vTWorld.xz * 1.7);
float tN2 = wNoise(vTWorld.xz * 0.21 + 13.0);
float tN3 = wNoise(vTWorld.xz * 0.045 - 7.0);
float tVar = (tN1 - 0.5) * 0.22 * tGrass * tFade + (tN2 - 0.5) * 0.12 + (tN3 - 0.5) * 0.1;
// wind-blown sand ripples
float tRip = sin(dot(vTWorld.xz, vec2(1.9, 1.15)) + tN2 * 5.0);
tVar += tRip * 0.035 * vTBiome.x * (1.0 - vTBiome.y) * tFade;
// rock strata
tVar += sin(vTWorld.y * 1.7 + tN2 * 3.0) * 0.07 * vTBiome.y;
diffuseColor.rgb *= 1.0 + tVar;
// wet sand band that follows the tide + swash, and rain wetness
float tSwash = uTide + 0.32 + 0.12 * sin(uTime * 0.45 + tN3 * 6.2831);
float tWetBand = vTBiome.z * (1.0 - smoothstep(tSwash - 0.25, tSwash, vTWorld.y));
float tWet = max(tWetBand * 0.85, uWet * (1.0 - 0.5 * vTBiome.y));
diffuseColor.rgb *= 1.0 - 0.24 * tWet;`
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
{
  // blend a little of the face normal in near the camera: soft low-poly facets
  vec3 tFdx = dFdx(vViewPosition);
  vec3 tFdy = dFdy(vViewPosition);
  vec3 tFn = normalize(cross(tFdx, tFdy));
  float tFacet = 0.32 * (1.0 - smoothstep(25.0, 90.0, tDist));
  normal = normalize(mix(normal, tFn, tFacet));
}`
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
{
  // drifting cloud shadows (only dim the direct sun)
  float tCs = wFbm3(vTWorld.xz * 0.0045 + uCloudGround * 0.0045);
  float tCt = mix(0.75, 0.3, uCloudCover);
  reflectedLight.directDiffuse *= 1.0 - uCloudShadow * smoothstep(tCt, tCt + 0.2, tCs);
  // caustics on shallow sea / lake / river beds
  float tWd = vTBiome.w;
  if (tWd > 0.02) {
    vec2 cp = vTWorld.xz * 0.6;
    float c1 = wNoise(cp + vec2(uTime * 0.35, uTime * 0.21));
    float c2 = wNoise(cp * 1.31 - vec2(uTime * 0.27, -uTime * 0.31) + 5.0);
    float caus = pow(max(1.0 - abs(c1 - c2) * 3.0, 0.0), 5.0);
    float tK = smoothstep(0.03, 0.5, tWd) * (1.0 - smoothstep(2.5, 9.0, tWd)) * (1.0 - smoothstep(40.0, 120.0, tDist));
    reflectedLight.directDiffuse *= 1.0 + caus * tK * 2.2;
  }
}`
      );
  };
  material.customProgramCacheKey = () => 'world-terrain-v1';

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false; // hills inside the 70 m shadow box would only add acne; Lambert slopes read fine
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  ctx.scene.add(mesh);

  let wet = 0;

  return {
    mesh,
    material,
    init() {},
    update(dt) {
      // ground wetness: soaks quickly in rain, dries slowly (faster in the sun)
      const rain = ctx.weather?.rain ?? 0;
      const day = ctx.time?.daylight ?? 1;
      if (rain > wet) wet += (rain - wet) * Math.min(1, dt * 0.35);
      else wet = Math.max(rain, wet - dt * (0.0015 + 0.006 * day) * Math.max(1, ctx.time?.timeScale ?? 1));
      U.uWet.value = wet;
    },
  };
}
