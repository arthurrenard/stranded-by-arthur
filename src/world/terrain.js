// Builder A — Terrain. One mesh built from ctx.world.buildGeometry() (exactly the query grid),
// colored per vertex from ctx.world.biomeAt(), plus shader detail via onBeforeCompile:
// world-space noise (grass speckle, sand ripples, rock strata), a subtle low-poly facet look,
// an animated wet band at the sea shore, rain wetness, drifting cloud shadows and caustics
// on shallow water beds. v3: a second mesh for Tempest Isle (buildGeometry('isle2'), same material,
// wilder colors: dark wet rock, wind-swept grass). API: { mesh, mesh2, meshes, material }.
import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';
import { terrainColor, PAL as TPAL, srgbToLinear } from './fx/terrainColors.js';
import { worldShared } from './fx/shared.js';
import { NOISE_GLSL } from './fx/glsl.js';

export function create(ctx) {
  const W = ctx.world;
  const shared = worldShared(ctx);
  const U = shared.uniforms;

  const rng = ctx.rng.fork('terrain-colors');
  const nLow = createNoise2D(rng);
  const nMid = createNoise2D(rng);
  const nHigh = createNoise2D(rng);
  const rgb = [0, 0, 0];
  // fast path for the deep sea floor (most of the grid): skip biomeAt()
  const deep = { h: 0, slope: 0, rn: 2, water: { type: 'ocean', depth: 0 }, sand: 0, rock: 0, highland: 0, meadow: 0, wet: 0, forest: 0 };
  const lakes = W.lakes || [];
  // Tempest Isle palette (v3): darker rain-soaked rock on the cliffs, grey-olive wind-swept grass
  const WET_ROCK = [0.2, 0.215, 0.235]; // linear
  const SWEPT = [0.19, 0.25, 0.12]; // linear grey-olive
  const WIND = { x: 0.8, z: -0.6 }; // streak direction of the flattened grass (prevailing gale)
  // V4-D: extra shading inputs for terrainColor (broad noise, sun-facing aspect, concavity AO)
  const ext = { n0: 0, sun: 0, cav: 0 };
  const AO_D = 3; // m: finite-difference step for the slope aspect + concavity
  const DAMP = TPAL.damp.map(srgbToLinear); // under-canopy floor (linear)

  /** Per-vertex biome colors (color) + shader biome data (aBiome) for one terrain geometry. */
  function colorize(geo, wild) {
    const pos = geo.attributes.position.array;
    const count = pos.length / 3;
    const colors = new Float32Array(count * 3);
    const biome = new Float32Array(count * 4);
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
      if (h >= -3) {
        // slope aspect (+z faces the sun all day, see core/clock.js) and concavity (gullies > 0)
        const hx1 = W.heightAt(x + AO_D, z), hx0 = W.heightAt(x - AO_D, z);
        const hz1 = W.heightAt(x, z + AO_D), hz0 = W.heightAt(x, z - AO_D);
        const gx = (hx1 - hx0) / (2 * AO_D), gz = (hz1 - hz0) / (2 * AO_D);
        ext.sun = Math.max(-1, Math.min(1, (-gz / Math.sqrt(gx * gx + 1 + gz * gz)) / 0.35));
        ext.cav = (hx1 + hx0 + hz1 + hz0) * 0.25 - h;
      } else {
        ext.sun = 0;
        ext.cav = 0;
      }
      ext.n0 = nLow(x * 0.0032 + 71.3, z * 0.0032 - 19.7);
      terrainColor(b, n1, n2, n3, fresh, rgb, ext);
      if (wild && h >= -3) {
        // wet dark rock on cliffs and the peak, streaked by runoff
        const wr = Math.min(1, b.rock * 1.15) * (0.75 + 0.25 * n2);
        if (wr > 0) {
          const t = wr * 0.8;
          rgb[0] += (WET_ROCK[0] - rgb[0]) * t;
          rgb[1] += (WET_ROCK[1] - rgb[1]) * t;
          rgb[2] += (WET_ROCK[2] - rgb[2]) * t;
        }
        // grass flattened by the gale: grey-olive with long streaks along the wind
        const grass = (1 - b.sand) * (1 - b.rock) * (b.water ? 0 : 1);
        if (grass > 0) {
          const along = x * WIND.x + z * WIND.z, across = x * WIND.z - z * WIND.x;
          const streak = nMid(along * 0.015 + 40, across * 0.16 - 40) * 0.5 + 0.5;
          const t = grass * (0.32 + 0.3 * streak);
          rgb[0] += (SWEPT[0] - rgb[0]) * t;
          rgb[1] += (SWEPT[1] - rgb[1]) * t;
          rgb[2] += (SWEPT[2] - rgb[2]) * t;
          const v = 0.9 + 0.2 * streak;
          rgb[0] *= v;
          rgb[1] *= v;
          rgb[2] *= v;
        }
        // the whole isle sits under a darker sky: a touch less saturated sand too
        const sd = b.sand * 0.12;
        rgb[0] *= 1 - sd;
        rgb[1] *= 1 - sd;
        rgb[2] *= 1 - sd * 0.6;
      }
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
    return geo;
  }

  const geo = colorize(W.buildGeometry('main'), false);
  // Tempest Isle (v3): its own grid; same material, wilder colors
  const geo2 = W.isle2 && W.grids?.some?.((g) => g.id === 'isle2') ? colorize(W.buildGeometry('isle2'), true) : null;

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
// clump-scale warm/cool hue drift on grass (straw vs sage), no texture
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.07, 1.0, 0.84), (tN2 - 0.45) * 0.9 * tGrass);
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
  material.customProgramCacheKey = () => 'world-terrain-v2';

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false; // hills inside the 70 m shadow box would only add acne; Lambert slopes read fine
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  ctx.scene.add(mesh);

  let mesh2 = null;
  if (geo2) {
    mesh2 = new THREE.Mesh(geo2, material);
    mesh2.name = 'terrain-isle2';
    mesh2.receiveShadow = true;
    mesh2.castShadow = false;
    mesh2.matrixAutoUpdate = false;
    mesh2.updateMatrix();
    ctx.scene.add(mesh2);
  }

  let wet = 0;

  // V4-D: darker, damper floor under the tree crowns. Flora indexes its crowns at create() and is
  // added after terrain, so this runs at init (retried on the first few updates if flora is late).
  let canopyTries = 0;
  function shadeCanopy() {
    const canopyAt = ctx.flora?.canopyAt;
    if (typeof canopyAt !== 'function') return false;
    for (const g of mesh2 ? [geo, geo2] : [geo]) {
      const pos = g.attributes.position.array;
      const col = g.attributes.color.array;
      const bio = g.attributes.aBiome.array;
      for (let k = 0, n = pos.length / 3; k < n; k++) {
        const h = pos[k * 3 + 1];
        if (h < 0.15 || bio[k * 4 + 3] > 0) continue; // sea floor / under water
        const grass = (1 - bio[k * 4]) * (1 - bio[k * 4 + 1]);
        if (grass < 0.05) continue;
        const cv = Number(canopyAt.call(ctx.flora, pos[k * 3], pos[k * 3 + 2])) || 0;
        if (cv < 0.02) continue;
        const t = Math.min(1, cv) * 0.6 * grass;
        const i = k * 3;
        col[i] += (DAMP[0] - col[i]) * t;
        col[i + 1] += (DAMP[1] - col[i + 1]) * t;
        col[i + 2] += (DAMP[2] - col[i + 2]) * t;
      }
      g.attributes.color.needsUpdate = true;
    }
    return true;
  }

  return {
    mesh,
    /** Tempest Isle terrain (v3), or null. */
    mesh2,
    meshes: mesh2 ? [mesh, mesh2] : [mesh],
    material,
    init() {
      try {
        if (shadeCanopy()) canopyTries = -1;
      } catch (e) {
        canopyTries = -1;
        console.warn('[terrain] canopy shading skipped', e);
      }
    },
    update(dt) {
      if (canopyTries >= 0 && canopyTries++ < 5) {
        try {
          if (shadeCanopy()) canopyTries = -1;
        } catch (e) {
          canopyTries = -1;
        }
      }
      // ground wetness: soaks quickly in rain, dries slowly (faster in the sun)
      const rain = ctx.weather?.rain ?? 0;
      const day = ctx.time?.daylight ?? 1;
      if (rain > wet) wet += (rain - wet) * Math.min(1, dt * 0.35);
      else wet = Math.max(rain, wet - dt * (0.0015 + 0.006 * day) * Math.max(1, ctx.time?.timeScale ?? 1));
      U.uWet.value = wet;
    },
  };
}
