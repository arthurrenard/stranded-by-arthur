// Story visual effects (Builder F): pooled particles, flying planks (v4), a fake-volumetric light cone, meteors and
// aurora ribbons. All shaders are ShaderMaterials; world-space ones support scene fog (additive
// effects fade their alpha by the fog factor instead of mixing toward the fog color, which would
// brighten them). Sky effects (meteors, aurora) deliberately use fog:false: they live "at infinity".
import * as THREE from 'three';

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

// ── Pooled particles (THREE.Points) ──────────────────────────────────────
/**
 * createParticles({ count, additive }) -> { points, spawn(...), update(dt, opts), clear(), setViewport(h, fovDeg), alive }
 * spawn(x, y, z, vx, vy, vz, life, size, color(hex|Color), alpha = 1, grow = 0)
 * update(dt, { gravity = 0, drag = 0, lift = 0, floorY = -Infinity })
 */
export function createParticles({ count = 256, additive = false } = {}) {
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const alpha = new Float32Array(count);
  const size = new Float32Array(count);
  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const maxLife = new Float32Array(count);
  const baseAlpha = new Float32Array(count);
  const grow = new Float32Array(count);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  const aAlpha = new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage);
  const aSize = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('aColor', aCol);
  geo.setAttribute('aAlpha', aAlpha);
  geo.setAttribute('aSize', aSize);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 700 } }]),
    vertexShader: /* glsl */ `
      attribute vec3 aColor; attribute float aAlpha; attribute float aSize;
      uniform float uScale;
      varying vec3 vColor; varying float vAlpha;
      #include <fog_pars_vertex>
      void main() {
        vColor = aColor; vAlpha = aAlpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(0.2, -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor; varying float vAlpha;
      #include <fog_pars_fragment>
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.12, d) * vAlpha;
        ${additive ? FOG_FADE : ''}
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor, a);
        ${additive ? '' : '#include <fog_fragment>'}
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  const _c = new THREE.Color();
  let cursor = 0;
  const api = {
    points,
    alive: 0,
    setViewport(heightPx, fovDeg) {
      mat.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    },
    spawn(x, y, z, vx, vy, vz, lifeS, sz, color = 0xffffff, a = 1, g = 0) {
      const i = cursor;
      cursor = (cursor + 1) % count;
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      vel[i * 3] = vx;
      vel[i * 3 + 1] = vy;
      vel[i * 3 + 2] = vz;
      if (color.isColor) _c.copy(color);
      else _c.set(color);
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
      life[i] = lifeS;
      maxLife[i] = lifeS;
      size[i] = sz;
      baseAlpha[i] = a;
      alpha[i] = a;
      grow[i] = g;
    },
    update(dt, o = {}) {
      const gravity = o.gravity ?? 0, drag = o.drag ?? 0, lift = o.lift ?? 0, floorY = o.floorY ?? -Infinity;
      const k = Math.exp(-drag * dt);
      let n = 0;
      for (let i = 0; i < count; i++) {
        if (life[i] <= 0) {
          if (alpha[i] !== 0) alpha[i] = 0;
          continue;
        }
        n++;
        life[i] -= dt;
        const j = i * 3;
        vel[j] *= k;
        vel[j + 1] = vel[j + 1] * k + (lift - gravity) * dt;
        vel[j + 2] *= k;
        pos[j] += vel[j] * dt;
        pos[j + 1] += vel[j + 1] * dt;
        pos[j + 2] += vel[j + 2] * dt;
        if (pos[j + 1] < floorY) {
          pos[j + 1] = floorY;
          vel[j + 1] = 0;
        }
        size[i] += grow[i] * dt;
        const t = life[i] / maxLife[i]; // 1 -> 0
        alpha[i] = life[i] <= 0 ? 0 : baseAlpha[i] * Math.min(1, t * 3) * Math.min(1, (1 - t) * 12 + 0.2);
      }
      api.alive = n;
      if (n > 0 || o.force) {
        aPos.needsUpdate = true;
        aAlpha.needsUpdate = true;
        aSize.needsUpdate = true;
        aCol.needsUpdate = true;
      }
    },
    clear() {
      life.fill(0);
      alpha.fill(0);
      aAlpha.needsUpdate = true;
      api.alive = 0;
    },
  };
  return api;
}

// ── Flying planks (InstancedMesh pool, v4 intro crash) ───────────────────
/**
 * createPlanks(n) -> { mesh, spawn(x, y, z, vx, vy, vz, life, scale), update(dt, { gravity, floorY, drag }), clear(), alive }
 * Tumbling wooden boards. Below floorY (the sea) they stop falling and float, slowly settling flat.
 */
export function createPlanks(n = 28) {
  const geo = new THREE.BoxGeometry(1, 0.06, 0.2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a6a44, roughness: 0.92, metalness: 0, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), rot = new Float32Array(n * 3), rv = new Float32Array(n * 3);
  const life = new Float32Array(n), scl = new Float32Array(n), wet = new Uint8Array(n);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < n; i++) mesh.setMatrixAt(i, zero);
  mesh.instanceMatrix.needsUpdate = true;
  let cursor = 0;
  const api = {
    mesh,
    alive: 0,
    spawn(x, y, z, vx, vy, vz, lifeS = 6, scale = 1) {
      const i = cursor;
      cursor = (cursor + 1) % n;
      const j = i * 3;
      pos[j] = x;
      pos[j + 1] = y;
      pos[j + 2] = z;
      vel[j] = vx;
      vel[j + 1] = vy;
      vel[j + 2] = vz;
      rot[j] = Math.random() * 6.28;
      rot[j + 1] = Math.random() * 6.28;
      rot[j + 2] = Math.random() * 6.28;
      rv[j] = (Math.random() - 0.5) * 14;
      rv[j + 1] = (Math.random() - 0.5) * 10;
      rv[j + 2] = (Math.random() - 0.5) * 14;
      life[i] = lifeS;
      scl[i] = scale;
      wet[i] = 0;
    },
    update(dt, o = {}) {
      const gravity = o.gravity ?? 9.8, floorY = o.floorY ?? -Infinity, drag = o.drag ?? 0.15;
      const k = Math.exp(-drag * dt), kw = Math.exp(-2.2 * dt);
      let alive = 0;
      for (let i = 0; i < n; i++) {
        if (life[i] <= 0) continue;
        life[i] -= dt;
        const j = i * 3;
        if (life[i] <= 0) {
          mesh.setMatrixAt(i, zero);
          continue;
        }
        alive++;
        if (!wet[i]) {
          vel[j] *= k;
          vel[j + 1] = vel[j + 1] * k - gravity * dt;
          vel[j + 2] *= k;
          rot[j] += rv[j] * dt;
          rot[j + 1] += rv[j + 1] * dt;
          rot[j + 2] += rv[j + 2] * dt;
        } else {
          // floating: drift, settle flat, bob a little
          vel[j] *= kw;
          vel[j + 2] *= kw;
          vel[j + 1] = 0;
          rot[j] *= kw;
          rot[j + 2] *= kw;
          rot[j + 1] += rv[j + 1] * 0.15 * dt;
        }
        pos[j] += vel[j] * dt;
        pos[j + 1] += vel[j + 1] * dt;
        pos[j + 2] += vel[j + 2] * dt;
        if (pos[j + 1] < floorY) {
          pos[j + 1] = floorY;
          if (!wet[i]) {
            wet[i] = 1;
            rot[j] = Math.sin(rot[j]) * 0.4;
            rot[j + 2] = Math.sin(rot[j + 2]) * 0.4;
          }
        }
        const fade = Math.min(1, life[i] / 0.6);
        _e.set(rot[j], rot[j + 1], rot[j + 2]);
        _q.setFromEuler(_e);
        _p.set(pos[j], pos[j + 1] + (wet[i] ? 0.02 : 0), pos[j + 2]);
        _s.setScalar(scl[i] * fade);
        _m.compose(_p, _q, _s);
        mesh.setMatrixAt(i, _m);
      }
      api.alive = alive;
      mesh.instanceMatrix.needsUpdate = true;
    },
    clear() {
      life.fill(0);
      for (let i = 0; i < n; i++) mesh.setMatrixAt(i, zero);
      mesh.instanceMatrix.needsUpdate = true;
      api.alive = 0;
    },
    dispose() {
      mesh.parent?.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
  return api;
}

// ── Fake volumetric light cone (apex at origin, pointing down -Y, length 1) ──
let _coneGeo = null;
export function createLightCone(color = 0xeef2ff) {
  if (!_coneGeo) {
    _coneGeo = new THREE.ConeGeometry(1, 1, 28, 1, true);
    _coneGeo.translate(0, -0.5, 0);
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0 } }]),
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      #include <fog_pars_fragment>
      void main() {
        float rim = abs(dot(normalize(vN), normalize(vV)));
        float a = pow(vUv.y, 1.7) * pow(rim, 1.4) * uOpacity;
        ${FOG_FADE}
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  const m = new THREE.Mesh(_coneGeo, mat);
  m.frustumCulled = false;
  m.renderOrder = 6;
  return { mesh: m, mat };
}

// ── Meteor streaks (sky) ─────────────────────────────────────────────────
export function createMeteors(n = 24) {
  const pos = new Float32Array(n * 6);
  const col = new Float32Array(n * 6);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos);
  geo.setAttribute('color', aCol);
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 4;
  const m = Array.from({ length: n }, () => ({ t: 0, life: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, speed: 0, len: 0 }));
  let spawnAcc = 0;
  return {
    lines,
    /** rate = meteors per second (0 stops spawning); cx,cy,cz = camera position; rand = () => [0,1) */
    update(dt, rate, cx, cy, cz, rand = Math.random) {
      spawnAcc += dt * rate;
      while (spawnAcc >= 1) {
        spawnAcc -= 1;
        const s = m.find((k) => k.t >= k.life);
        if (!s) break;
        const az = rand() * Math.PI * 2, el = 0.45 + rand() * 0.6, R = 650;
        s.x = cx + Math.cos(az) * Math.cos(el) * R;
        s.y = cy + Math.sin(el) * R;
        s.z = cz + Math.sin(az) * Math.cos(el) * R;
        const ta = az + (rand() - 0.5) * 1.2 + Math.PI * 0.5;
        s.dx = Math.cos(ta);
        s.dz = Math.sin(ta);
        s.dy = -0.35 - rand() * 0.4;
        const l = Math.hypot(s.dx, s.dy, s.dz);
        s.dx /= l;
        s.dy /= l;
        s.dz /= l;
        s.speed = 180 + rand() * 160;
        s.len = 40 + rand() * 50;
        s.t = 0;
        s.life = 0.6 + rand() * 0.8;
      }
      for (let i = 0; i < n; i++) {
        const s = m[i];
        const o = i * 6;
        if (s.t >= s.life) {
          col.fill(0, o, o + 6);
          continue;
        }
        s.t += dt;
        const k = s.t / s.life;
        const fade = Math.sin(Math.min(1, k) * Math.PI);
        const hx = s.x + s.dx * s.speed * s.t, hy = s.y + s.dy * s.speed * s.t, hz = s.z + s.dz * s.speed * s.t;
        pos[o] = hx;
        pos[o + 1] = hy;
        pos[o + 2] = hz;
        pos[o + 3] = hx - s.dx * s.len;
        pos[o + 4] = hy - s.dy * s.len;
        pos[o + 5] = hz - s.dz * s.len;
        col[o] = 1.6 * fade;
        col[o + 1] = 1.5 * fade;
        col[o + 2] = 1.3 * fade;
        col[o + 3] = col[o + 4] = 0;
        col[o + 5] = 0.05 * fade;
      }
      aPos.needsUpdate = true;
      aCol.needsUpdate = true;
    },
  };
}

// ── Aurora ribbons (sky, fog:false on purpose) ───────────────────────────
export function createAurora() {
  const group = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv; varying float vSeed;
      attribute float aSeed;
      void main() {
        vUv = uv; vSeed = aSeed;
        vec3 p = position;
        p.z += sin(p.x * 0.006 + uTime * 0.15 + aSeed) * 60.0 + sin(p.x * 0.017 - uTime * 0.23) * 18.0;
        p.y += sin(p.x * 0.01 + uTime * 0.3 + aSeed * 2.0) * 10.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform float uIntensity; varying vec2 vUv; varying float vSeed;
      void main() {
        float x = vUv.x * 40.0 + vSeed * 7.0;
        float curtain = 0.55 + 0.45 * sin(x * 1.3 + uTime * 0.9) * sin(x * 0.37 - uTime * 0.4 + vSeed);
        curtain *= 0.6 + 0.4 * sin(x * 3.1 + uTime * 2.1);
        float v = vUv.y;
        float a = smoothstep(0.0, 0.18, v) * pow(1.0 - v, 1.6) * curtain;
        a *= smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
        vec3 col = mix(vec3(0.15, 1.0, 0.55), vec3(0.75, 0.25, 1.0), smoothstep(0.35, 0.95, v));
        a *= uIntensity;
        gl_FragColor = vec4(col * 1.4, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  for (let i = 0; i < 3; i++) {
    const g = new THREE.PlaneGeometry(1100, 170, 90, 1);
    const seeds = new Float32Array(g.attributes.position.count).fill(i * 2.3 + 0.7);
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    const ribbon = new THREE.Mesh(g, mat);
    ribbon.position.set((i - 1) * 140, 230 + i * 35, -620 - i * 60);
    ribbon.rotation.x = 0.35;
    ribbon.frustumCulled = false;
    ribbon.renderOrder = 3;
    group.add(ribbon);
  }
  group.visible = false;
  return { group, mat };
}
