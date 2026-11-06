// Fire effects for structures (Builder E): one draw call each for
//   - flames:  instanced billboards. mode 0 = a flame tongue (cylindrical billboard, procedural noise
//              teardrop, white-yellow core -> orange -> red edges, wind lean + flicker on the GPU),
//              mode 1 = a soft additive glow halo (spherical billboard), mode 2 = a glowing coal bed (ground disc).
//   - smoke:   instanced soft puffs (spherical billboards, fbm-eroded edges, fake sphere shading from the
//              sun, warm under-glow from the fire), CPU-simulated with wind drift. Signal-fire columns use it.
//   - embers:  additive THREE.Points sparks rising with turbulence.
// All world-space shaders support scene fog: additive effects fade their alpha by the fog factor (mixing
// toward the fog color would brighten them), the normal-blended smoke mixes toward the fog color.
// Shared uniforms (uTime, uWind, uWindStrength, uDaylight) are attached BY REFERENCE (UniformsUtils.merge
// clones values, so only the fog uniforms are merged).
import * as THREE from 'three';

// ── GLSL helpers ─────────────────────────────────────────────────────────
const NOISE = /* glsl */ `
float fxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fxNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), u.x), mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fxFbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * fxNoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}`;

// Fog factor -> alpha fade for additive effects (uses the uniforms declared by fog_pars_fragment).
const FOG_FADE = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogF = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogF = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  a *= 1.0 - fogF;
#endif`;

// Camera basis in world space, read from the view matrix rows (no roll in this game).
const CAM_BASIS = /* glsl */ `
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);`;

/** A unit quad as an InstancedBufferGeometry. anchorBottom: y in [0,1] (flames), else [-0.5,0.5]. */
function quadGeometry(capacity, anchorBottom) {
  const g = new THREE.InstancedBufferGeometry();
  const y0 = anchorBottom ? 0 : -0.5, y1 = anchorBottom ? 1 : 0.5;
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, y0, 0, 0.5, y0, 0, 0.5, y1, 0, -0.5, y1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = capacity;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}
function instAttr(g, name, capacity, size) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
  a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(name, a);
  return a;
}

// ── Flames + glows ───────────────────────────────────────────────────────
/**
 * createFlames(ctx, capacity) -> { mesh, alloc(n) -> first slot, set(i, x,y,z, width, height, seed, intensity, mode), hide(i), commit() }
 * mode: 0 flame tongue (x,y,z = base), 1 glow halo (center; width = diameter), 2 coal bed (horizontal disc).
 * Slots are owned by their structure for its whole life (structures are never removed).
 */
export function createFlames(ctx, capacity = 160) {
  const g = quadGeometry(capacity, true);
  const aPos = instAttr(g, 'iPos', capacity, 4); // xyz base, w = width
  const aData = instAttr(g, 'iData', capacity, 4); // height, seed, intensity, mode
  const U = ctx.uniforms;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  uniforms.uTime = U.uTime;
  uniforms.uWind = U.uWind;
  uniforms.uWindStrength = U.uWindStrength;
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec4 iPos;
      attribute vec4 iData;
      uniform float uTime;
      uniform vec2 uWind;
      uniform float uWindStrength;
      varying vec2 vUv;
      varying vec3 vInfo; // seed, intensity, mode
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vInfo = iData.yzw;
        ${CAM_BASIS}
        vec3 wp;
        if (iData.w < 0.5) {
          // flame tongue: cylindrical billboard (stays upright), flicker + wind lean grow toward the tip
          vec3 r = normalize(vec3(camRight.x, 0.0, camRight.z) + vec3(1e-5, 0.0, 0.0));
          float t = uTime * 6.3 + iData.y * 31.0;
          float h = iData.x * (0.86 + 0.1 * sin(t) + 0.06 * sin(t * 2.71 + 1.3) + 0.04 * sin(t * 5.3));
          float y = position.y;
          vec3 lean = vec3(uWind.x, 0.0, uWind.y) * (0.12 + uWindStrength * 0.55) * y * y * h;
          lean += vec3(sin(t * 0.83 + y * 3.1), 0.0, cos(t * 0.71 + y * 2.3)) * 0.06 * y * h;
          wp = iPos.xyz + r * position.x * iPos.w * (1.0 - 0.15 * y) + vec3(0.0, y * h, 0.0) + lean;
        } else if (iData.w < 1.5) {
          // glow halo: camera-facing disc centered on iPos
          wp = iPos.xyz + (camRight * position.x + camUp * (position.y - 0.5)) * iPos.w;
        } else {
          // glowing coal bed: a horizontal disc lying on the ashes (facing up)
          wp = iPos.xyz + vec3(position.x, 0.0, 0.5 - position.y) * iPos.w;
        }
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vInfo;
      #include <fog_pars_fragment>
      ${NOISE}
      void main() {
        float a;
        vec3 col;
        float seed = vInfo.x;
        if (vInfo.z < 0.5) {
          float y = vUv.y;
          float n = fxFbm(vec2(vUv.x * 2.6 + seed * 17.0, y * 2.1 - uTime * 2.5 + seed * 5.0));
          float n2 = fxNoise(vec2(vUv.x * 7.0 - seed * 3.0, y * 6.0 - uTime * 4.8));
          float x = (vUv.x - 0.5) * 2.0 + (n - 0.5) * 0.6 * y;
          // teardrop silhouette: round base, licking tip
          float w = pow(max(0.0, 1.0 - y), 0.7) * (0.6 + 0.4 * smoothstep(0.0, 0.22, y));
          float shape = 1.0 - abs(x) / max(w, 0.001);
          shape += (n - 0.5) * 0.75 + (n2 - 0.5) * 0.3 * y - y * y * 0.3;
          a = smoothstep(0.0, 0.42, shape) * smoothstep(0.0, 0.07, y);
          float heat = clamp(shape * 1.35 - y * 0.45, 0.0, 1.0);
          col = mix(vec3(0.78, 0.1, 0.02), vec3(1.0, 0.42, 0.05), smoothstep(0.04, 0.42, heat));
          col = mix(col, vec3(1.0, 0.8, 0.38), smoothstep(0.42, 0.82, heat));
          col = mix(col, vec3(1.0, 0.96, 0.82), smoothstep(0.8, 1.0, heat) * (1.0 - y));
          col *= 1.7;
        } else if (vInfo.z > 1.5) {
          // coals: cellular-ish hot spots that breathe slowly
          float d = length(vUv - 0.5) * 2.0;
          float coals = fxNoise(vUv * 9.0 + seed * 7.0) * 0.6 + fxNoise(vUv * 23.0 - seed * 3.0) * 0.4;
          float pulse = 0.7 + 0.3 * sin(uTime * 2.1 + coals * 9.0 + seed * 4.0);
          a = smoothstep(1.0, 0.3, d) * smoothstep(0.32, 0.72, coals) * pulse;
          col = mix(vec3(0.75, 0.07, 0.0), vec3(1.0, 0.55, 0.12), smoothstep(0.55, 0.9, coals)) * 1.8;
        } else {
          float d = length(vUv - 0.5) * 2.0;
          float flick = 0.88 + 0.12 * sin(uTime * 9.0 + seed * 20.0) * sin(uTime * 3.3 + seed);
          a = pow(max(0.0, 1.0 - d), 2.4) * 0.5 * flick;
          col = vec3(1.0, 0.46, 0.14);
        }
        a *= vInfo.y;
        ${FOG_FADE}
        if (a < 0.003) discard;
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.name = 'structure-flames';
  ctx.scene.add(mesh);
  let next = 0;
  let dirty = true; // the first commits keep the (empty) mesh visible so its shader compiles at load
  let frames = 0;
  const P = aPos.array, D = aData.array;

  return {
    mesh,
    capacity,
    /** Reserve n consecutive slots; returns the first index or -1 when full. */
    alloc(n) {
      if (next + n > capacity) return -1;
      const i = next;
      next += n;
      return i;
    },
    set(i, x, y, z, width, height, seed, intensity, mode = 0) {
      if (i < 0 || i >= capacity) return;
      const o = i * 4;
      P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = width;
      D[o] = height; D[o + 1] = seed; D[o + 2] = intensity; D[o + 3] = mode;
      dirty = true;
    },
    hide(i) {
      if (i < 0 || i >= capacity) return;
      if (D[i * 4 + 2] !== 0) {
        D[i * 4 + 2] = 0;
        P[i * 4 + 3] = 0;
        dirty = true;
      }
    },
    commit() {
      if (frames < 4) {
        frames++;
        return;
      }
      if (!dirty) return;
      dirty = false;
      aPos.needsUpdate = true;
      aData.needsUpdate = true;
      let active = false;
      for (let i = 0; i < next && !active; i++) if (D[i * 4 + 2] > 0) active = true;
      mesh.visible = active; // no draw call while nothing burns
    },
  };
}

// ── Smoke puffs ──────────────────────────────────────────────────────────
/**
 * createSmoke(ctx, capacity) -> { mesh, emit(o), update(dt), alive }
 * emit({ x, y, z, vx?, vy?, vz?, rise, size0, size1, life, r, g, b, alpha, glow?, wind? })
 *   rise  target vertical speed (m/s), slowly decaying with age
 *   wind  multiplier of the drift along ctx.uniforms.uWind (grows with height above the emitter)
 */
export function createSmoke(ctx, capacity = 720) {
  const g = quadGeometry(capacity, false);
  const aPos = instAttr(g, 'iPos', capacity, 4); // xyz, size
  const aCol = instAttr(g, 'iCol', capacity, 4); // rgb, alpha
  const aMisc = instAttr(g, 'iMisc', capacity, 4); // rotation, seed, glow, -
  const U = ctx.uniforms;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  uniforms.uDaylight = U.uDaylight;
  uniforms.uSunDir = { value: ctx.time?.sunDir || new THREE.Vector3(0.3, 0.8, 0.3) };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec4 iPos;
      attribute vec4 iCol;
      attribute vec4 iMisc;
      uniform vec3 uSunDir;
      varying vec2 vUv;
      varying vec4 vCol;
      varying vec2 vMisc;
      varying vec3 vSunV;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vCol = iCol;
        vMisc = iMisc.yz;
        vSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
        ${CAM_BASIS}
        float c = cos(iMisc.x), s = sin(iMisc.x);
        vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iPos.w;
        vec3 wp = iPos.xyz + camRight * q.x + camUp * q.y;
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uDaylight;
      varying vec2 vUv;
      varying vec4 vCol;
      varying vec2 vMisc;
      varying vec3 vSunV;
      #include <fog_pars_fragment>
      ${NOISE}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0 || vCol.a < 0.002) discard;
        float n = fxFbm(vUv * 2.3 + vMisc.x * 13.7);
        float a = smoothstep(1.0, 0.2, sqrt(r2) + (n - 0.5) * 0.6) * vCol.a;
        if (a < 0.003) discard;
        // fake sphere normal (view space): soft sunlit side, darker core
        vec3 nrm = normalize(vec3(p, sqrt(max(0.0, 1.0 - r2))));
        float lit = 0.6 + 0.4 * max(0.0, dot(nrm, vSunV));
        float amb = mix(0.08, 1.0, uDaylight);
        vec3 col = vCol.rgb * lit * amb * (0.86 + 0.28 * n);
        col += vec3(1.0, 0.4, 0.12) * vMisc.y * (0.7 + 0.3 * n); // fire light from below
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  mesh.name = 'structure-smoke';
  ctx.scene.add(mesh);

  // particle state (struct of arrays)
  const px = new Float32Array(capacity), py = new Float32Array(capacity), pz = new Float32Array(capacity);
  const vx = new Float32Array(capacity), vy = new Float32Array(capacity), vz = new Float32Array(capacity);
  const y0 = new Float32Array(capacity), age = new Float32Array(capacity), life = new Float32Array(capacity);
  const s0 = new Float32Array(capacity), s1 = new Float32Array(capacity), a0 = new Float32Array(capacity);
  const rise = new Float32Array(capacity), wind = new Float32Array(capacity), glow = new Float32Array(capacity);
  const rot = new Float32Array(capacity), spin = new Float32Array(capacity), seed = new Float32Array(capacity);
  const cr = new Float32Array(capacity), cg = new Float32Array(capacity), cb = new Float32Array(capacity);
  let cursor = 0;
  let alive = 0;
  let warm = 0;
  const P = aPos.array, C = aCol.array, M = aMisc.array;

  const api = {
    mesh,
    get alive() {
      return alive;
    },
    emit(o) {
      const i = cursor;
      cursor = (cursor + 1) % capacity; // ring buffer: the oldest puff is recycled when full
      px[i] = o.x; py[i] = o.y; pz[i] = o.z; y0[i] = o.y;
      vx[i] = o.vx || 0; vy[i] = o.vy ?? o.rise; vz[i] = o.vz || 0;
      age[i] = 0; life[i] = o.life;
      s0[i] = o.size0; s1[i] = o.size1; a0[i] = o.alpha;
      rise[i] = o.rise; wind[i] = o.wind ?? 1; glow[i] = o.glow || 0;
      rot[i] = Math.random() * 6.283; spin[i] = (Math.random() - 0.5) * 0.35; seed[i] = Math.random() * 10;
      cr[i] = o.r; cg[i] = o.g; cb[i] = o.b;
    },
    update(dt) {
      const W = ctx.uniforms.uWind.value;
      const ws = ctx.uniforms.uWindStrength.value;
      const wx = W.x * ws, wz = W.y * ws;
      const t = ctx.uniforms.uTime.value;
      const kv = Math.min(1, dt * 1.4), kh = Math.min(1, dt * 0.55);
      let n = 0;
      for (let i = 0; i < capacity; i++) {
        const o = i * 4;
        if (age[i] >= life[i]) {
          if (P[o + 3] !== 0) {
            P[o + 3] = 0;
            C[o + 3] = 0;
          }
          continue;
        }
        n++;
        age[i] += dt;
        const k = Math.min(1, age[i] / life[i]);
        // buoyancy fades with age; drift follows the wind, stronger higher up (wind shear)
        const tv = rise[i] * (1 - 0.6 * k);
        vy[i] += (tv - vy[i]) * kv;
        const hgt = Math.max(0, py[i] - y0[i]);
        const shear = wind[i] * (1.2 + hgt * 0.09);
        const turb = 0.35 + hgt * 0.01;
        vx[i] += (wx * shear + Math.sin(t * 0.7 + seed[i] * 3.1 + hgt * 0.15) * turb - vx[i]) * kh;
        vz[i] += (wz * shear + Math.cos(t * 0.6 + seed[i] * 2.3 + hgt * 0.12) * turb - vz[i]) * kh;
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
        pz[i] += vz[i] * dt;
        rot[i] += spin[i] * dt;
        const grow = 1 - (1 - k) * (1 - k);
        const fade = Math.min(1, k / 0.07) * (1 - smooth(0.55, 1, k));
        P[o] = px[i]; P[o + 1] = py[i]; P[o + 2] = pz[i];
        P[o + 3] = s0[i] + (s1[i] - s0[i]) * grow;
        C[o] = cr[i]; C[o + 1] = cg[i]; C[o + 2] = cb[i];
        C[o + 3] = a0[i] * fade;
        M[o] = rot[i]; M[o + 1] = seed[i];
        const gk = 1 - k;
        M[o + 2] = glow[i] * gk * gk * gk;
      }
      const upload = n > 0 || alive > 0; // one last upload clears the final puffs
      alive = n;
      if (warm < 4) warm++;
      else mesh.visible = n > 0; // no draw call without smoke (after the shader compiled at load)
      if (!upload) return;
      aPos.needsUpdate = true;
      aCol.needsUpdate = true;
      aMisc.needsUpdate = true;
    },
  };
  return api;
}

// ── Embers / sparks ──────────────────────────────────────────────────────
/** createEmbers(ctx, capacity) -> { points, emit(x,y,z, vx,vy,vz, life, size), update(dt) } */
export function createEmbers(ctx, capacity = 360) {
  const pos = new Float32Array(capacity * 3);
  const data = new Float32Array(capacity * 3); // size, heat, alpha
  const g = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aData = new THREE.BufferAttribute(data, 3).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', aPos);
  g.setAttribute('aData', aData);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 740 } }]);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec3 aData;
      uniform float uScale;
      varying vec2 vHA;
      #include <fog_pars_vertex>
      void main() {
        vHA = aData.yz;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aData.z > 0.0 ? clamp(aData.x * uScale / max(0.1, -mvPosition.z), 1.5, 14.0) : 0.0;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vHA;
      #include <fog_pars_fragment>
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.05, d) * vHA.y;
        ${FOG_FADE}
        if (a < 0.004) discard;
        vec3 col = mix(vec3(0.9, 0.12, 0.0), vec3(1.0, 0.78, 0.35), vHA.x) * 2.2;
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false;
  points.renderOrder = 8;
  points.name = 'structure-embers';
  ctx.scene.add(points);

  const vel = new Float32Array(capacity * 3);
  const age = new Float32Array(capacity);
  const life = new Float32Array(capacity);
  const size = new Float32Array(capacity);
  const seed = new Float32Array(capacity);
  let cursor = 0;
  let alive = 0;
  let warm = 0;

  return {
    points,
    emit(x, y, z, vx, vy, vz, lifeS, sz) {
      const i = cursor;
      cursor = (cursor + 1) % capacity;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz;
      age[i] = 0; life[i] = lifeS; size[i] = sz; seed[i] = Math.random() * 100;
    },
    update(dt) {
      const W = ctx.uniforms.uWind.value;
      const ws = ctx.uniforms.uWindStrength.value;
      const t = ctx.uniforms.uTime.value;
      const cam = ctx.camera;
      // pixels per meter at distance 1, from the drawing buffer height and the vertical fov
      const h = ctx.renderer?.domElement?.height || 900;
      uniforms.uScale.value = h / (2 * Math.tan(((cam?.fov || 72) * Math.PI) / 360));
      let n = 0;
      for (let i = 0; i < capacity; i++) {
        const o = i * 3;
        if (age[i] >= life[i]) {
          data[o + 2] = 0;
          continue;
        }
        n++;
        age[i] += dt;
        const k = Math.min(1, age[i] / life[i]);
        // swirl + buoyancy that fades as the spark cools, wind carries it
        vel[o] += (Math.sin(t * 5 + seed[i]) * 1.6 + W.x * ws * 2.5 - vel[o]) * Math.min(1, dt * 2);
        vel[o + 2] += (Math.cos(t * 4.3 + seed[i] * 1.7) * 1.6 + W.y * ws * 2.5 - vel[o + 2]) * Math.min(1, dt * 2);
        vel[o + 1] += (0.6 - 1.4 * k) * dt;
        pos[o] += vel[o] * dt;
        pos[o + 1] += vel[o + 1] * dt;
        pos[o + 2] += vel[o + 2] * dt;
        data[o] = size[i] * (1 - 0.5 * k);
        data[o + 1] = 1 - k; // heat: white-orange -> red
        data[o + 2] = (1 - k * k) * (0.75 + 0.25 * Math.sin(t * 23 + seed[i]));
      }
      const upload = n > 0 || alive > 0;
      alive = n;
      if (warm < 4) warm++;
      else points.visible = n > 0;
      if (!upload) return;
      aPos.needsUpdate = true;
      aData.needsUpdate = true;
    },
  };
}

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
