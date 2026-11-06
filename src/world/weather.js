// Builder A — Weather. An automatic, deterministic weather cycle (clear / cloudy / rain / storm, see
// fx/weatherModel.js) smoothed into live values, plus everything weather looks like:
// - rain streaks around the camera (one instanced quad per drop, animated + wrapped on the GPU),
// - thunderstorms: jagged lightning bolts in the sky, sky flash (ctx.sky.flash) and delayed thunder
//   (ctx.audio.play('thunder') + 'weather:thunder' when the sound arrives),
// - a primary + faint secondary rainbow opposite the sun when a daytime shower clears,
// - wind direction/strength with gusts, written to ctx.uniforms.uWind / uWindStrength / uRain.
//
// Time bases: the automatic schedule follows game time (ctx.time.hoursTotal), so sleeping, setHour and
// fast-forward stay consistent; set(..., transitionSec) blends in real seconds (the clock is paused
// during the intro). Thunder delays use an internal real-time clock that freezes on pause.
//
// API: { rain 0..1, cloudiness 0..1, storm 0..1 (eased; 0 when calm, truthy while stormy),
//        isStorm (bool), wind: {x, z, strength}, airTempOffset (°C), kind ('clear'|'cloudy'|'rain'|'storm'),
//        auto (bool), rainbow 0..1, set(opts, transitionSec = 3), lightning(opts?), forecast() }
// Events: weather:rainStart / weather:rainStop {intensity} (only while playing), weather:thunder {intensity, distance}.
import * as THREE from 'three';
import { worldShared } from './fx/shared.js';
import { createWeatherSchedule, makeWeatherTarget, airTempOffsetFor, weatherKind, WEATHER_PRESETS } from './fx/weatherModel.js';
import { smoothstep, clamp, clamp01, damp, angleDiff } from '../core/util.js';

// ── Rain streaks ─────────────────────────────────────────────────────────
const RAIN_N = 4200;
const RAIN_VERT = /* glsl */ `
attribute vec4 aSeed; // xyz: position in the box (0..1), w: drop id (visibility threshold + variation)
uniform vec3 uCenter;
uniform vec3 uBox;
uniform vec3 uVel;
uniform float uRainTime;
uniform float uAmount;
uniform float uLen;
uniform float uWidth;
varying float vAlong;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  float on = step(aSeed.w, uAmount);
  float var1 = fract(aSeed.w * 7.13);
  float var2 = fract(aSeed.w * 13.7 + 0.31);
  vec3 vel = uVel * (0.85 + 0.3 * var1);
  // world-space fall, wrapped into a box that follows the camera (drops stay put when you walk)
  vec3 boxMin = uCenter - uBox * vec3(0.5, 0.62, 0.5);
  vec3 p = boxMin + mod(aSeed.xyz * uBox + vel * uRainTime - boxMin, uBox);
  vec3 dir = normalize(vel);
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  vec3 c = cross(dir, toCam);
  float cl = length(c);
  vec3 side = cl > 1e-4 ? c / cl : vec3(1.0, 0.0, 0.0);
  float len = uLen * (0.7 + 0.6 * var2);
  // widen slightly with distance so far streaks don't vanish into sub-pixel aliasing
  vec3 wp = p + side * position.x * uWidth * (1.0 + dist * 0.05) - dir * position.y * len;
  vAlong = position.y;
  vAlpha = on * smoothstep(0.7, 2.6, dist) * (1.0 - smoothstep(uBox.x * 0.32, uBox.x * 0.5, dist));
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  if (on < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume: culled
  #include <fog_vertex>
}
`;
const RAIN_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlong;
varying float vAlpha;
#include <fog_pars_fragment>
void main() {
  // bright head, fading tail
  float a = vAlpha * uOpacity * pow(1.0 - vAlong, 1.4) * smoothstep(0.0, 0.08, vAlong + 0.02);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// ── Lightning bolt (sky layer: like the dome, it is drawn without fog) ───
const BOLT_MAX_SEG = 140;
const BOLT_VERT = /* glsl */ `
attribute float aGlow;
varying float vGlow;
void main() {
  vGlow = aGlow;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const BOLT_FRAG = /* glsl */ `
uniform float uI;
varying float vGlow;
void main() {
  float core = smoothstep(0.55, 1.0, vGlow);
  float a = clamp(uI * (vGlow * 0.75 + core * 0.6), 0.0, 1.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(vec3(0.62, 0.7, 1.0), vec3(1.0), core) * 1.6, a);
  #include <colorspace_fragment>
}
`;

// ── Rainbow (sky layer: untonemapped and fog-free, like the dome it is added onto) ──
const RAINBOW_VERT = /* glsl */ `
attribute vec2 aBand; // x: 0 inner edge .. 1 outer edge, y: 0 primary / 1 secondary bow
varying vec2 vBand;
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  vBand = aBand;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const RAINBOW_FRAG = /* glsl */ `
uniform float uAmount;
varying vec2 vBand;
varying vec3 vDir;
vec3 wHue(float h) {
  return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
}
void main() {
  vec3 d = normalize(vDir);
  float t = vBand.x;
  bool secondary = vBand.y > 0.5;
  // primary: red outside, violet inside; secondary: reversed and much fainter
  float s = secondary ? 1.0 - t : t;
  vec3 col = mix(wHue((1.0 - s) * 0.76), vec3(1.0), 0.12);
  float edge = smoothstep(0.0, 0.22, t) * (1.0 - smoothstep(0.78, 1.0, t));
  float a = edge * uAmount * (secondary ? 0.32 : 1.0);
  a *= smoothstep(-0.005, 0.06, d.y); // only above the horizon
  a *= 0.75 + 0.25 * smoothstep(0.05, 0.4, d.y); // a touch brighter high up, softer at the feet
  if (a < 0.002) discard;
  gl_FragColor = vec4(col * 0.3, a);
  #include <colorspace_fragment>
}
`;

function fogUniforms() {
  return THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
}

export function create(ctx) {
  const { scene, camera } = ctx;
  const U = worldShared(ctx).uniforms;
  const model = createWeatherSchedule(ctx.config?.seed ?? 1);
  const rng = ctx.rng.fork('weather-fx');

  // ── Weather state ────────────────────────────────────────────────────────
  // cur: the live values; auto: the schedule target; manual: the set() target.
  const auto = makeWeatherTarget();
  model.targetAt(ctx.time?.hoursTotal ?? 6, auto);
  const cur = { cloud: auto.cloud, rain: auto.rain, storm: auto.storm, wind: auto.wind, angle: auto.angle };
  const from = { cloud: 0, rain: 0, storm: 0, wind: 0, angle: 0 };
  const manual = { cloud: 0, rain: 0, storm: 0, wind: 0, angle: 0, hasAngle: false };
  let mode = 'auto';
  let trans = null; // { t, dur } real-second blend from `from` to the live target
  let fxClock = 0; // real seconds while updating (freezes on pause)
  let wetFlag = false; // rain hysteresis (events + rainbow)
  let peakRain = 0;
  let rainbowCharge = 0;
  let rainbowAmt = 0;
  let strikeTimer = 2.5;
  let canopy = 0, canopyTimer = 0;
  const pendingThunder = []; // [{ at, volume, intensity, distance, rate }]

  // ── Rain mesh ─────────────────────────────────────────────────────────────
  const rainGeo = new THREE.InstancedBufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0]), 3));
  rainGeo.setIndex([0, 2, 1, 2, 3, 1]);
  const seeds = new Float32Array(RAIN_N * 4);
  const rainRng = ctx.rng.fork('weather-rain');
  for (let i = 0; i < RAIN_N; i++) {
    seeds[i * 4] = rainRng();
    seeds[i * 4 + 1] = rainRng();
    seeds[i * 4 + 2] = rainRng();
    seeds[i * 4 + 3] = (i + rainRng()) / RAIN_N; // evenly spread thresholds: density scales smoothly with rain
  }
  rainGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  rainGeo.instanceCount = RAIN_N;
  const rainUniforms = {
    ...fogUniforms(),
    uCenter: { value: new THREE.Vector3() },
    uBox: { value: new THREE.Vector3(40, 26, 40) },
    uVel: { value: new THREE.Vector3(0, -9, 0) },
    uRainTime: { value: 0 },
    uAmount: { value: 0 },
    uLen: { value: 0.65 },
    uWidth: { value: 0.0085 },
    uColor: { value: new THREE.Color(0.5, 0.55, 0.6) },
    uOpacity: { value: 0.4 },
  };
  const rainMat = new THREE.ShaderMaterial({
    name: 'world-rain',
    uniforms: rainUniforms,
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    toneMapped: false,
  });
  const rainMesh = new THREE.Mesh(rainGeo, rainMat);
  rainMesh.name = 'weather-rain';
  rainMesh.frustumCulled = false; // positioned in the vertex shader
  rainMesh.renderOrder = 5;
  rainMesh.visible = false;
  scene.add(rainMesh);
  let rainTime = 0;

  // ── Lightning bolt mesh (rebuilt on each strike, reused) ─────────────────
  const boltPos = new Float32Array(BOLT_MAX_SEG * 6 * 3);
  const boltGlow = new Float32Array(BOLT_MAX_SEG * 6);
  const boltIdx = new Uint16Array(BOLT_MAX_SEG * 12);
  for (let s = 0; s < BOLT_MAX_SEG; s++) {
    const v = s * 6; // a-left, a-center, a-right, b-left, b-center, b-right
    boltIdx.set([v, v + 3, v + 1, v + 1, v + 3, v + 4, v + 1, v + 4, v + 2, v + 2, v + 4, v + 5], s * 12);
    for (let k = 0; k < 6; k++) boltGlow[v + k] = k % 3 === 1 ? 1 : 0;
  }
  const boltGeo = new THREE.BufferGeometry();
  boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPos, 3).setUsage(THREE.DynamicDrawUsage));
  boltGeo.setAttribute('aGlow', new THREE.BufferAttribute(boltGlow, 1).setUsage(THREE.DynamicDrawUsage));
  boltGeo.setIndex(new THREE.BufferAttribute(boltIdx, 1));
  boltGeo.setDrawRange(0, 0);
  const boltUniforms = { uI: { value: 0 } };
  const boltMesh = new THREE.Mesh(
    boltGeo,
    new THREE.ShaderMaterial({
      name: 'world-lightning',
      uniforms: boltUniforms,
      vertexShader: BOLT_VERT,
      fragmentShader: BOLT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    })
  );
  boltMesh.name = 'weather-lightning';
  boltMesh.frustumCulled = false;
  boltMesh.renderOrder = -25;
  boltMesh.visible = false;
  scene.add(boltMesh);
  let boltAge = 99;
  let boltSegs = 0;

  // ── Rainbow mesh (unit-direction bands around +Z, rotated onto the antisolar point) ──
  const rainbowGeo = (() => {
    const SEG = 160, R = 820;
    const bands = [
      [40.3, 42.6, 0],
      [50.2, 53.8, 1],
    ];
    const pos = [], band = [], idx = [];
    for (const [inner, outer, id] of bands) {
      const base = pos.length / 3;
      for (let i = 0; i <= SEG; i++) {
        const phi = (i / SEG) * Math.PI * 2;
        for (let j = 0; j < 2; j++) {
          const th = ((j ? outer : inner) * Math.PI) / 180;
          pos.push(Math.sin(th) * Math.cos(phi) * R, Math.sin(th) * Math.sin(phi) * R, Math.cos(th) * R);
          band.push(j, id);
        }
        if (i < SEG) {
          const a = base + i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aBand', new THREE.Float32BufferAttribute(band, 2));
    g.setIndex(idx);
    return g;
  })();
  const rainbowUniforms = { uAmount: { value: 0 } };
  const rainbow = new THREE.Mesh(
    rainbowGeo,
    new THREE.ShaderMaterial({
      name: 'world-rainbow',
      uniforms: rainbowUniforms,
      vertexShader: RAINBOW_VERT,
      fragmentShader: RAINBOW_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true, // hills in front hide it
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    })
  );
  rainbow.name = 'weather-rainbow';
  rainbow.frustumCulled = false;
  rainbow.renderOrder = -20;
  rainbow.visible = false;
  rainbow.onBeforeRender = (r, s, cam) => {
    rainbow.position.copy(cam.position);
    rainbow.updateMatrixWorld();
  };
  scene.add(rainbow);

  // ── Scratch objects (no per-frame allocations) ───────────────────────────
  const Z = new THREE.Vector3(0, 0, 1);
  const tmpV = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const pA = new THREE.Vector3(), pB = new THREE.Vector3(), side = new THREE.Vector3(), toCam = new THREE.Vector3();
  const tmpC = new THREE.Color();

  // ── Helpers ──────────────────────────────────────────────────────────────
  function snapshot(dst, src) {
    dst.cloud = src.cloud;
    dst.rain = src.rain;
    dst.storm = src.storm;
    dst.wind = src.wind;
    dst.angle = src.angle;
  }
  function liveTarget() {
    return mode === 'auto' ? auto : manual;
  }
  function targetAngle() {
    return mode === 'manual' && manual.hasAngle ? manual.angle : auto.angle;
  }
  function startTransition(sec) {
    snapshot(from, cur);
    trans = { t: 0, dur: Math.max(0, Number(sec) || 0) };
    if (trans.dur === 0) {
      applyTransition(1);
      trans = null;
    }
  }
  function applyTransition(k) {
    const T = liveTarget();
    cur.cloud = from.cloud + (T.cloud - from.cloud) * k;
    cur.rain = from.rain + (T.rain - from.rain) * k;
    cur.storm = from.storm + (T.storm - from.storm) * k;
    cur.wind = from.wind + (T.wind - from.wind) * k;
    cur.angle = from.angle + angleDiff(from.angle, targetAngle()) * k;
  }

  /** Add one camera-facing segment (a → b) of half-width w to the bolt geometry. */
  function boltSeg(a, b, w, glow) {
    if (boltSegs >= BOLT_MAX_SEG) return;
    toCam.copy(camera.position).sub(a);
    side.copy(b).sub(a).cross(toCam);
    const l = side.length();
    if (l < 1e-6) side.set(w, 0, 0);
    else side.multiplyScalar(w / l);
    const o = boltSegs * 18;
    const pts = [a, b];
    for (let e = 0; e < 2; e++) {
      const p = pts[e];
      const q = o + e * 9;
      boltPos[q] = p.x - side.x;
      boltPos[q + 1] = p.y - side.y;
      boltPos[q + 2] = p.z - side.z;
      boltPos[q + 3] = p.x;
      boltPos[q + 4] = p.y;
      boltPos[q + 5] = p.z;
      boltPos[q + 6] = p.x + side.x;
      boltPos[q + 7] = p.y + side.y;
      boltPos[q + 8] = p.z + side.z;
      const g = boltSegs * 6 + e * 3;
      boltGlow[g + 1] = glow;
    }
    boltSegs++;
  }

  /** Build a jagged, branching bolt from the cloud base down to (x, groundY, z). */
  function buildBolt(x, groundY, z) {
    boltSegs = 0;
    const top = 330 + rng() * 90;
    const steps = 30;
    const trunk = [];
    let px = x + rng.range(-60, 60), pz = z + rng.range(-60, 60);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // random walk that converges onto the strike point
      px += rng.range(-1, 1) * 15;
      pz += rng.range(-1, 1) * 15;
      const k = t * t * t;
      trunk.push(px + (x - px) * k, top + (groundY - top) * t, pz + (z - pz) * k);
    }
    for (let i = 0; i < steps; i++) {
      pA.fromArray(trunk, i * 3);
      pB.fromArray(trunk, i * 3 + 3);
      boltSeg(pA, pB, 2.6 - 1.0 * (i / steps), 1);
    }
    // forks
    const forks = 3 + Math.floor(rng() * 4);
    for (let f = 0; f < forks; f++) {
      const i0 = 3 + Math.floor(rng() * (steps - 10));
      pA.fromArray(trunk, i0 * 3);
      const ang = rng() * Math.PI * 2;
      let dx = Math.cos(ang), dz = Math.sin(ang);
      const n = 5 + Math.floor(rng() * 8);
      let w = 1.4;
      for (let s = 0; s < n; s++) {
        dx += rng.range(-0.5, 0.5);
        dz += rng.range(-0.5, 0.5);
        const len = rng.range(9, 17);
        const dl = Math.hypot(dx, dz) || 1;
        pB.set(pA.x + (dx / dl) * len, pA.y - rng.range(6, 15), pA.z + (dz / dl) * len);
        boltSeg(pA, pB, w, 0.55 - s * 0.03);
        pA.copy(pB);
        w *= 0.88;
      }
    }
    boltGeo.attributes.position.needsUpdate = true;
    boltGeo.attributes.aGlow.needsUpdate = true;
    boltGeo.setDrawRange(0, boltSegs * 12);
    boltAge = 0;
  }

  /** Bolt brightness envelope: stroke, dim, restrike, decay (~0.4 s). */
  function boltEnvelope(t) {
    if (t < 0.05) return 1;
    if (t < 0.09) return 0.25;
    if (t < 0.16) return 0.9;
    return 0.9 * Math.exp(-(t - 0.16) * 14);
  }

  // ── API ──────────────────────────────────────────────────────────────────
  const api = {
    rain: cur.rain,
    cloudiness: cur.cloud,
    storm: cur.storm,
    isStorm: false,
    wind: { x: Math.cos(cur.angle), z: Math.sin(cur.angle), strength: cur.wind },
    airTempOffset: airTempOffsetFor(cur.cloud, cur.rain, cur.storm),
    kind: weatherKind(cur.cloud, cur.rain, cur.storm),
    auto: true,
    rainbow: 0,
    rainMesh,
    rainbowMesh: rainbow,

    /**
     * Override the weather. Fields: rain 0..1, cloudiness 0..1, wind (strength number or {x, z, strength}),
     * storm (true = heavy thunderstorm preset, false = no storm), auto (true = back to the automatic cycle).
     * transitionSec: real seconds to blend (0 = instant).
     */
    set(opts = {}, transitionSec = 3) {
      const o = opts || {};
      if (o.auto === true) {
        mode = 'auto';
        manual.hasAngle = false;
      } else if (o.rain != null || o.cloudiness != null || o.wind != null || o.storm != null || o.auto === false) {
        if (mode !== 'manual') {
          snapshot(manual, cur);
          manual.hasAngle = false;
        }
        mode = 'manual';
        if (o.storm === true) Object.assign(manual, { cloud: 1, rain: 1, storm: 1, wind: WEATHER_PRESETS.storm.wind + 0.05 });
        else if (o.storm === false) manual.storm = 0;
        if (o.rain != null) manual.rain = clamp01(Number(o.rain) || 0);
        if (o.cloudiness != null) manual.cloud = clamp01(Number(o.cloudiness) || 0);
        if (o.rain != null && o.cloudiness == null) manual.cloud = Math.max(manual.cloud, 0.55 + 0.4 * manual.rain);
        if (typeof o.wind === 'number') manual.wind = clamp(o.wind, 0, 1.6);
        else if (o.wind && typeof o.wind === 'object') {
          if (o.wind.strength != null) manual.wind = clamp(Number(o.wind.strength) || 0, 0, 1.6);
          if (o.wind.x != null || o.wind.z != null) {
            manual.angle = Math.atan2(Number(o.wind.z) || 0, Number(o.wind.x) || 0);
            manual.hasAngle = true;
          }
        }
      }
      api.auto = mode === 'auto';
      model.targetAt(ctx.time?.hoursTotal ?? 6, auto);
      startTransition(transitionSec);
      publish(0);
      return api;
    },

    /**
     * A lightning strike now: bolt + sky flash, thunder after the sound delay.
     * opts: { distance (m), strength, silent }
     */
    lightning(opts = {}) {
      const dist = clamp(Number(opts.distance) || rng.range(260, 2300), 60, 2400);
      const strength = opts.strength ?? clamp(1.7 - dist / 1700, 0.35, 1.6);
      ctx.sky?.flash?.(strength);
      // strike direction: often within the view so the bolt is seen
      camera.getWorldDirection(fwd);
      let a = Math.atan2(fwd.z, fwd.x);
      a += rng() < 0.6 ? rng.range(-0.8, 0.8) : rng.range(-Math.PI, Math.PI);
      const x = camera.position.x + Math.cos(a) * dist;
      const z = camera.position.z + Math.sin(a) * dist;
      const g = ctx.world?.heightAt?.(x, z) ?? 0;
      buildBolt(x, Math.max(0, g), z);
      if (!opts.silent) {
        pendingThunder.push({
          at: fxClock + dist / 343,
          volume: clamp(1.25 - dist / 2600, 0.25, 1),
          rate: clamp(1.15 - dist / 4000, 0.6, 1.1),
          intensity: strength,
          distance: dist,
        });
      }
    },

    /** Hours until the next automatic shower (0 while it rains). */
    forecast() {
      return { kind: api.kind, nextShowerHours: model.nextShower(ctx.time?.hoursTotal ?? 0), auto: api.auto };
    },

    init() {
      const ev = ctx.events;
      const onJump = () => {
        model.targetAt(ctx.time.hoursTotal, auto);
        if (mode === 'auto') startTransition(1.5);
      };
      ev?.on?.('time:skip', () => {
        onJump();
        rainbowCharge = 0;
        pendingThunder.length = 0;
      });
      ev?.on?.('time:set', () => {
        onJump();
        pendingThunder.length = 0; // e.g. the intro cuts from the storm to a calm dawn
      });
    },

    update(dt) {
      fxClock += dt;
      const T = ctx.time;
      model.targetAt(T.hoursTotal, auto);

      // 1) advance the live values
      if (trans) {
        trans.t += dt;
        const k = trans.dur > 0 ? smoothstep(0, 1, trans.t / trans.dur) : 1;
        applyTransition(k);
        if (trans.t >= trans.dur) trans = null;
      } else if (mode === 'auto') {
        const dh = T.dtHours || 0;
        if (dh > 0) {
          const a = (rate) => 1 - Math.exp(-rate * dh);
          cur.rain += (auto.rain - cur.rain) * a(5);
          cur.cloud += (auto.cloud - cur.cloud) * a(2.6);
          cur.storm += (auto.storm - cur.storm) * a(3.5);
          cur.wind += (auto.wind - cur.wind) * a(2);
          cur.angle += angleDiff(cur.angle, auto.angle) * a(1.5);
        }
      } else {
        snapshot(cur, manual);
        if (!manual.hasAngle) cur.angle = auto.angle;
      }

      publish(dt);
      events();
      thunderstorm(dt);
      visuals(dt);
    },
  };

  /** Copy the live values into the API + shared uniforms (gusts, temperature, label). */
  function publish(dt) {
    const rain = cur.rain < 0.002 ? 0 : clamp01(cur.rain);
    const storm = cur.storm < 0.01 ? 0 : clamp01(cur.storm);
    const cloud = clamp01(cur.cloud);
    api.rain = rain;
    api.storm = storm;
    api.isStorm = storm > 0.5;
    api.cloudiness = cloud;
    api.airTempOffset = airTempOffsetFor(cloud, rain, storm);
    api.kind = weatherKind(cloud, rain, storm);
    // gusts: a few incommensurate sines in real time, stronger in storms
    const c = fxClock;
    const g = 0.5 * Math.sin(c * 0.37 + 1.1) + 0.3 * Math.sin(c * 0.93 + 0.3) + 0.2 * Math.sin(c * 2.1 + 2.2);
    const gust = Math.max(0, g) * (0.22 + 0.2 * storm);
    const turb = (0.05 + 0.22 * storm) * Math.sin(c * 0.53 + 0.7) + 0.08 * storm * Math.sin(c * 1.7);
    const ang = cur.angle + turb;
    api.wind.x = Math.cos(ang);
    api.wind.z = Math.sin(ang);
    api.wind.strength = Math.min(1.6, cur.wind * (1 + gust));
    const u = ctx.uniforms;
    if (u) {
      u.uWind?.value?.set?.(api.wind.x, api.wind.z);
      if (u.uWindStrength) u.uWindStrength.value = api.wind.strength;
      if (u.uRain) u.uRain.value = rain;
    }
  }

  /** Rain start/stop edges (hysteresis); events only while playing. Arms the rainbow. */
  function events() {
    const playing = ctx.state === 'playing';
    const r = api.rain;
    if (wetFlag) peakRain = Math.max(peakRain, r);
    if (!wetFlag && r > 0.15) {
      wetFlag = true;
      peakRain = r;
      if (playing) ctx.events?.emit?.('weather:rainStart', { intensity: r });
    } else if (wetFlag && r < 0.06) {
      wetFlag = false;
      if (peakRain > 0.25) rainbowCharge = 1;
      if (playing) ctx.events?.emit?.('weather:rainStop', { intensity: r });
    }
  }

  /** Automatic strikes during storms + delayed thunder. */
  function thunderstorm(dt) {
    if (api.storm > 0.55) {
      strikeTimer -= dt;
      if (strikeTimer <= 0) {
        api.lightning();
        strikeTimer = rng.range(4, 14) * (1.6 - 0.6 * api.storm);
      }
    } else strikeTimer = 2.5;
    for (let i = pendingThunder.length - 1; i >= 0; i--) {
      const p = pendingThunder[i];
      if (fxClock < p.at) continue;
      pendingThunder.splice(i, 1);
      ctx.audio?.play?.('thunder', { volume: p.volume, rate: p.rate });
      ctx.events?.emit?.('weather:thunder', { intensity: p.intensity, distance: p.distance });
    }
  }

  /** Rain streaks, lightning bolt and rainbow. */
  function visuals(dt) {
    const T = ctx.time;
    const under = !!ctx.water?.underwater;
    const cam = camera.position;

    // canopy above the camera intercepts part of the rain (sampled a few times per second)
    canopyTimer -= dt;
    if (canopyTimer <= 0) {
      canopyTimer = 0.3;
      canopy = clamp01(Number(ctx.flora?.canopyAt?.(cam.x, cam.z)) || 0);
    }

    // rain streaks
    const amount = under ? 0 : api.rain * (1 - 0.65 * canopy);
    rainMesh.visible = amount > 0.004;
    if (rainMesh.visible) {
      rainTime += dt;
      const ru = rainUniforms;
      ru.uCenter.value.copy(cam);
      const fall = 8.5 + 3.5 * api.storm;
      const hw = api.wind.strength * 4.2;
      ru.uVel.value.set(api.wind.x * hw, -fall, api.wind.z * hw);
      ru.uRainTime.value = rainTime;
      ru.uAmount.value = amount;
      ru.uLen.value = fall * 0.075;
      ru.uOpacity.value = 0.3 + 0.22 * api.rain;
      // lit by the sky: ambient + a little key light + lightning flashes (linear)
      ru.uColor.value.copy(U.uAmbientColor.value).multiplyScalar(0.42);
      tmpC.copy(U.uLightColor.value).multiplyScalar(0.035);
      ru.uColor.value.add(tmpC);
      const fl = U.uFlash.value * 0.6;
      ru.uColor.value.r += fl;
      ru.uColor.value.g += fl;
      ru.uColor.value.b += fl * 1.1;
    } else if (rainTime > 600) rainTime = 0; // keep the GPU clock small (invisible while dry)

    // lightning bolt
    if (boltAge < 1) {
      boltAge += dt;
      const e = boltEnvelope(boltAge);
      boltUniforms.uI.value = under ? e * 0.3 : e;
      boltMesh.visible = e > 0.01;
    } else boltMesh.visible = false;

    // rainbow: armed when a shower ends, needs a low sun behind you, sun through the clouds, no rain
    rainbowCharge = Math.max(0, rainbowCharge - (T.dtHours || 0) / 1.4);
    const sy = T.sunDir.y;
    const target =
      rainbowCharge *
      smoothstep(0.0, 0.07, sy) *
      smoothstep(0.62, 0.4, sy) *
      (1 - smoothstep(0.5, 0.9, api.cloudiness)) *
      (1 - smoothstep(0.04, 0.25, api.rain));
    rainbowAmt = damp(rainbowAmt, target, 0.5, dt);
    if (rainbowAmt < 0.002 && target === 0) rainbowAmt = 0;
    api.rainbow = rainbowAmt;
    rainbow.visible = rainbowAmt > 0.002 && !under;
    if (rainbow.visible) {
      tmpV.copy(T.sunDir).negate();
      rainbow.quaternion.setFromUnitVectors(Z, tmpV);
      rainbowUniforms.uAmount.value = rainbowAmt;
    }
  }

  publish(0);
  return api;
}
