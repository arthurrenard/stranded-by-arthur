// Fireflies (Builder C — fauna): a few hundred glowing points recycled around the player at night.
//
// - ONE THREE.Points draw call with a custom additive ShaderMaterial. All motion (lazy drifting,
//   shyness around the player / a lit torch) and the blinking (quick flash, slow decay, long dark
//   pause, individual phases loosely synchronised per 10 m patch so whole glades pulse in waves)
//   happen in the vertex shader. The CPU only re-seeds a few points per frame when they fall
//   outside the player radius, so the per-frame cost is ~24 raster lookups.
// - Habitat: the baked firefly raster (water edges, wet ground, meadows, forest edges) via
//   accept/reject; over fresh water they hover just above the surface.
// - Fades in with darkness (smoothstep on ctx.time.daylight), dimmer in rain, fog-aware (additive:
//   fog fades them to nothing instead of mixing toward the fog color), soft procedural glow sprite.
import * as THREE from 'three';
import { smoothstep, hash2 } from '../../core/util.js';

const T = {
  count: 380, // points in the pool
  radius: 58, // recycled beyond this distance (m) from the player
  perFrame: 26, // points checked for recycling each frame
  tries: 10, // habitat accept/reject attempts per re-seed
  sizeMin: 0.26, // world size of the glow sprite (m)
  sizeMax: 0.5,
  fadeIn: 2.5, // seconds for a re-seeded firefly to fade in
};

const VERT = /* glsl */ `
uniform float uTime;
uniform float uNight;
uniform float uPixelScale;
uniform float uRadius;
uniform vec3 uFocus;
uniform float uRepel;
attribute vec4 aSeed;   // phase 0..1, flash period (s), sprite size (m), hue 0..1
attribute float aBirth; // uTime when this firefly was (re)seeded
varying float vAlpha;
varying float vGlow;
varying float vHue;
#include <common>
#include <fog_pars_vertex>
void main() {
  vec3 p = position;
  float t = uTime;
  float ph = aSeed.x * 6.2831853;
  // lazy wandering drift: layered sines, wider horizontally than vertically
  p.x += sin( t * 0.23 + ph ) * 1.3 + sin( t * 0.71 + ph * 2.3 ) * 0.42;
  p.z += cos( t * 0.19 + ph * 1.7 ) * 1.3 + sin( t * 0.63 + ph * 0.6 ) * 0.42;
  p.y += sin( t * 0.37 + ph * 1.3 ) * 0.42 + sin( t * 1.9 + ph * 3.1 ) * 0.06;
  // shy of the player, more so of a lit torch
  vec3 away = p - uFocus;
  away.y *= 0.6;
  float dl = length( away ) + 1e-3;
  p += ( away / dl ) * uRepel * ( 1.0 - smoothstep( 0.0, uRepel * 2.2, dl ) );
  vec4 mvPosition = modelViewMatrix * vec4( p, 1.0 );

  // flash: quick rise, slower decay, long dark pause; a faint ember between flashes
  float cyc = fract( t / aSeed.y + aSeed.x );
  float flash = smoothstep( 0.0, 0.05, cyc ) * ( 1.0 - smoothstep( 0.07, 0.3, cyc ) );
  float glow = 0.08 + 0.92 * flash;
  float age = clamp( ( t - aBirth ) / ${T.fadeIn.toFixed(2)}, 0.0, 1.0 );
  float edge = 1.0 - smoothstep( uRadius * 0.72, uRadius, length( position.xz - uFocus.xz ) );

  float px = aSeed.z * ( 0.5 + 0.5 * glow ) * uPixelScale / max( 0.1, -mvPosition.z );
  float sz = clamp( px, 2.0, 96.0 );
  float energy = min( 1.0, ( px * px ) / ( sz * sz ) ); // sub-2px sprites dim instead of vanishing
  vAlpha = uNight * age * edge * energy;
  vGlow = glow;
  vHue = aSeed.w;
  gl_PointSize = sz;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uCore;
varying float vAlpha;
varying float vGlow;
varying float vHue;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot( c, c ) * 4.0;
  if ( r2 >= 1.0 || vAlpha <= 0.002 ) discard;
  float core = exp( -r2 * 48.0 );
  float halo = exp( -r2 * 5.5 ) * ( 1.0 - r2 );
  vec3 tint = mix( uColorA, uColorB, vHue );
  vec3 col = tint * halo * ( 0.16 + 1.15 * vGlow ) + uCore * core * ( 0.3 + 2.3 * vGlow );
  col *= vAlpha;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    #else
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    #endif
    col *= 1.0 - fogFactor; // additive: fade out with distance, never toward the fog color
  #endif
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Fireflies system. `shared` = fauna shared state (habitat, focus, rand, time…). */
export function createFireflies(ctx, shared) {
  const N = T.count;
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N * 4);
  const birth = new Float32Array(N);
  const parked = new Uint8Array(N); // 1 = no habitat found yet (hidden far below), retried later
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aSeed = new THREE.BufferAttribute(seed, 4).setUsage(THREE.DynamicDrawUsage);
  const aBirth = new THREE.BufferAttribute(birth, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aSeed', aSeed);
  geo.setAttribute('aBirth', aBirth);
  for (let i = 0; i < N; i++) {
    pos[i * 3 + 1] = -1000;
    parked[i] = 1;
  }

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uNight: { value: 0 },
      uPixelScale: { value: 740 },
      uRadius: { value: T.radius },
      uFocus: { value: new THREE.Vector3() },
      uRepel: { value: 0.9 },
      uColorA: { value: new THREE.Color(0xb6ff4e) },
      uColorB: { value: new THREE.Color(0xffd04a) },
      uCore: { value: new THREE.Color(0xfffbe2) },
    },
  ]);
  uniforms.uTime = ctx.uniforms.uTime; // shared clock (frozen while paused)
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  const points = new THREE.Points(geo, material);
  points.name = 'fireflies';
  points.frustumCulled = false; // positions are re-seeded around the player
  points.renderOrder = 3;
  points.visible = false;
  points.raycast = () => {};

  const tmp = { x: 0, z: 0, w: 0 };
  const _buf = new THREE.Vector2();
  let cursor = 0;
  let dirty = false;

  /** (Re)seed firefly i somewhere in the annulus [rMin, rMax] around the focus. */
  function seedOne(i, rMin, rMax) {
    const H = shared.habitat;
    const W = ctx.world;
    const f = shared.focus;
    const rand = shared.rand;
    if (!H.pick(H.firefly, rand, f.x, f.z, rMin, rMax, T.tries, tmp)) {
      parked[i] = 1;
      pos[i * 3 + 1] = -1000;
      dirty = true;
      return;
    }
    const x = tmp.x, z = tmp.z;
    const w = W.waterAt(x, z);
    let y;
    if (w) {
      if (!w.fresh) {
        parked[i] = 1;
        pos[i * 3 + 1] = -1000;
        dirty = true;
        return;
      }
      y = w.surface + 0.25 + rand() * 1.2;
    } else y = W.heightAt(x, z) + 0.3 + Math.pow(rand(), 1.6) * 2.8; // mostly low, a few up in the bushes
    parked[i] = 0;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    // loosely synchronised per 10 m patch: neighbours share part of their phase and period
    const cell = hash2(Math.floor(x / 10), Math.floor(z / 10), 77);
    seed[i * 4] = (cell * 0.6 + rand() * 0.4) % 1;
    seed[i * 4 + 1] = 2.4 + cell * 2.2 + rand() * 1.4; // flash period (s)
    seed[i * 4 + 2] = T.sizeMin + rand() * (T.sizeMax - T.sizeMin);
    seed[i * 4 + 3] = rand() < 0.22 ? 0.6 + rand() * 0.4 : rand() * 0.25; // mostly lime, some amber
    birth[i] = ctx.uniforms.uTime.value;
    dirty = true;
  }

  function reseedAll() {
    for (let i = 0; i < N; i++) seedOne(i, 0, T.radius * 0.97);
  }

  return {
    object: points,
    init() {
      reseedAll();
    },
    /** frame = shared per-frame state from fauna.js */
    update(dt, frame) {
      const f = shared.focus;
      if (frame.jumped) reseedAll();
      else {
        // recycle a few per frame: those left behind (outside the radius) or still parked
        const R2 = T.radius * T.radius;
        for (let k = 0; k < T.perFrame; k++) {
          const i = cursor;
          cursor = (cursor + 1) % N;
          if (parked[i]) {
            seedOne(i, T.radius * 0.35, T.radius * 0.97);
            continue;
          }
          const dx = pos[i * 3] - f.x, dz = pos[i * 3 + 2] - f.z;
          if (dx * dx + dz * dz > R2) seedOne(i, T.radius * 0.62, T.radius * 0.97);
        }
      }
      if (dirty) {
        aPos.needsUpdate = true;
        aSeed.needsUpdate = true;
        aBirth.needsUpdate = true;
        dirty = false;
      }
      // darkness fade (dusk -> night), fewer in the rain
      const night = smoothstep(0.62, 0.1, frame.daylight) * (1 - 0.7 * frame.rain);
      uniforms.uNight.value = night;
      points.visible = night > 0.003;
      if (!points.visible) return;
      uniforms.uFocus.value.set(f.x, f.y + 1.0, f.z);
      uniforms.uRepel.value = ctx.flags?.torchLit ? 2.8 : 0.9;
      // pixels per meter at 1 m: drawing-buffer height / (2 tan(fov/2))
      const r = ctx.renderer;
      const h = r?.getDrawingBufferSize ? r.getDrawingBufferSize(_buf).y : 900;
      const fov = ((ctx.camera?.fov ?? 72) * Math.PI) / 180;
      uniforms.uPixelScale.value = (h || 900) / (2 * Math.tan(fov / 2));
    },
    count: () => N - parked.reduce((a, b) => a + b, 0),
  };
}
