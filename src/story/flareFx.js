// Distress flare effect (Builder F): a red rocket that climbs ~120 m with a glowing smoke trail,
// then hangs under its little parachute and drifts with the wind while it burns (~8.5 s), lighting
// the area red. rescue.js decides whether anybody saw it; this file is visuals + the ctx.signals entry.
//
// - The light is NOT created here: rescue.js passes the shared story PointLight (getStoryLights) so
//   firing never adds a light to the scene at runtime (that would recompile every lit material).
//   Its color / decay / distance are set on every fire (the intro leaves it as a 30 m warm lamp).
// - Pure timeline helpers (flareHeight, flareGlow) are exported for node tests.
// - DOM / WebGL access only happens inside functions (node-safe import).
import * as THREE from 'three';
import { createParticles } from './fx.js';
import { glowTexture } from './models.js';

export const FLARE = {
  rise: 120, // m above the launch point at the top of the climb
  riseTime: 3.0, // s to the top (ease-out)
  burn: 8.5, // s of burning in total (light + glowing head)
  fadeOut: 1.0, // s of dimming at the end of the burn
  sink: 2.0, // m/s parachute descent after the climb
  lean: 0.14, // horizontal drift per m of climb along the firing direction
  lux: 0.6, // target red illuminance right under the flare (the sun is ~3)
  color: 0xff2a18,
};

const easeOut = (u, p = 2.2) => 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), p);

/** Height (m) of the flare head above its launch point t seconds after firing. */
export function flareHeight(t, F = FLARE) {
  if (!(t > 0)) return 0;
  if (t <= F.riseTime) return F.rise * easeOut(t / F.riseTime);
  return Math.max(0, F.rise - F.sink * (t - F.riseTime));
}

/** Brightness envelope 0..1 of the burning head / light (quick ignition, fade at the end). */
export function flareGlow(t, F = FLARE) {
  if (!(t > 0) || t >= F.burn) return 0;
  const on = Math.min(1, t / 0.25);
  const off = Math.min(1, (F.burn - t) / F.fadeOut);
  return on * off;
}

/** Light intensity (cd, decay 2) that keeps ~F.lux under a head `h` m up, times the envelope. */
export function flareLightIntensity(h, glow, F = FLARE) {
  const d = Math.max(6, h + 1.7);
  return F.lux * d * d * glow;
}

/**
 * createFlareFx(ctx, { light }) -> { init(), fire(position, dir?) -> handle, update(dt), clear(), active }
 * handle: { position (Vector3, live head position), t, burning, done, height }
 */
export function createFlareFx(ctx, opts = {}) {
  const light = opts.light || null;
  const flares = [];
  let built = false, viewportSet = false;
  let smoke = null, glow = null, root = null;
  const _c = new THREE.Color(), _day = new THREE.Color(0xcfbcb5), _night = new THREE.Color(0x6a2c26), _prev = new THREE.Vector3();

  function build() {
    if (built) return;
    built = true;
    smoke = createParticles({ count: 900 });
    glow = createParticles({ count: 520, additive: true });
    ctx.scene.add(smoke.points, glow.points);
    root = new THREE.Group();
    root.name = 'flares';
    ctx.scene.add(root);
  }

  function makeHead() {
    const g = new THREE.Group();
    const tex = glowTexture();
    if (tex) {
      const outer = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: FLARE.color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
      outer.scale.setScalar(10);
      const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffd6c8, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
      core.scale.setScalar(2.2);
      outer.renderOrder = core.renderOrder = 6;
      g.add(outer, core);
      g.userData.sprites = [outer, core];
    } else {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), new THREE.MeshBasicMaterial({ color: FLARE.color, fog: false }));
      g.add(m);
      g.userData.sprites = [];
    }
    return g;
  }

  function release(f) {
    if (f.head) {
      root?.remove(f.head);
      for (const s of f.head.userData.sprites) s.material.dispose();
      f.head = null;
    }
    ctx.signals?.delete?.(f.signal);
    if (light && light.userData.flareOwner === f) {
      light.intensity = 0;
      light.position.set(0, -500, 0);
      light.userData.flareOwner = null;
    }
  }

  const api = {
    init() {
      build();
    },
    /** Launch a flare from `position` (Vector3, ~eye height). dir: optional aim (Vector3) for a slight lean. */
    fire(position, dir = null) {
      build();
      const origin = new THREE.Vector3().copy(position || ctx.camera.position);
      const lean = new THREE.Vector3();
      if (dir) lean.set(dir.x, 0, dir.z);
      if (lean.lengthSq() < 1e-6) lean.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      lean.normalize().multiplyScalar(FLARE.lean);
      const f = {
        position: origin.clone(),
        origin,
        lean,
        drift: new THREE.Vector3(),
        t: 0,
        height: 0,
        burning: true,
        done: false,
        head: makeHead(),
        trailAcc: 0,
        seed: Math.random() * 100,
        signal: null,
      };
      f.head.position.copy(origin);
      root.add(f.head);
      f.signal = { kind: 'flare', position: f.position, strength: 700, isActive: () => f.burning, flare: f };
      ctx.signals?.add?.(f.signal);
      if (light) {
        light.color.setHex(FLARE.color);
        light.decay = 2;
        light.distance = 0;
        light.castShadow = false;
        light.userData.flareOwner = f; // the newest flare owns the shared light
      }
      flares.push(f);
      return f;
    },
    update(dt) {
      if (!built) return;
      if (!viewportSet && typeof window !== 'undefined') {
        smoke.setViewport(window.innerHeight, ctx.camera.fov);
        glow.setViewport(window.innerHeight, ctx.camera.fov);
        viewportSet = true;
      }
      const daylight = ctx.time?.daylight ?? 1;
      const wind = ctx.weather?.wind;
      for (let i = flares.length - 1; i >= 0; i--) {
        const f = flares[i];
        _prev.copy(f.position);
        f.t += dt;
        const t = f.t;
        f.height = flareHeight(t);
        // after the climb the parachute drifts downwind
        if (t > FLARE.riseTime && wind) {
          const ws = 1.5 + 4 * (wind.strength ?? 0.3);
          const wl = Math.hypot(wind.x || 0, wind.z || 0) || 1;
          f.drift.x += ((wind.x || 0) / wl) * ws * dt;
          f.drift.z += ((wind.z || 0) / wl) * ws * dt;
        }
        const climb = Math.min(f.height, FLARE.rise);
        f.position.set(f.origin.x + f.lean.x * climb + f.drift.x, f.origin.y + f.height, f.origin.z + f.lean.z * climb + f.drift.z);
        const g = flareGlow(t);
        const flick = 0.84 + 0.1 * Math.sin(t * 37 + f.seed) * Math.sin(t * 23.3) + 0.06 * Math.random();
        if (f.head) {
          f.head.position.copy(f.position);
          const sp = f.head.userData.sprites;
          if (sp[0]) {
            sp[0].material.opacity = g * flick;
            sp[0].scale.setScalar(9 + 2.5 * flick);
          }
          if (sp[1]) sp[1].material.opacity = Math.min(1, g * 1.3);
          f.head.visible = g > 0.01;
        }
        if (light && light.userData.flareOwner === f) {
          light.position.copy(f.position);
          light.intensity = flareLightIntensity(f.height, g * flick);
        }
        // smoke trail + glow along the segment travelled this frame
        if (f.burning) {
          const seg = _prev.distanceTo(f.position);
          const rising = t <= FLARE.riseTime;
          f.trailAcc += rising ? seg / 0.45 : dt * 14;
          let n = Math.min(60, Math.floor(f.trailAcc));
          f.trailAcc -= n;
          _c.copy(_night).lerp(_day, Math.min(1, daylight * 1.1));
          for (let k = 0; k < n; k++) {
            const u = n > 1 ? k / (n - 1) : 1;
            const x = _prev.x + (f.position.x - _prev.x) * u, y = _prev.y + (f.position.y - _prev.y) * u, z = _prev.z + (f.position.z - _prev.z) * u;
            const j = 0.25;
            smoke.spawn(x + (Math.random() - 0.5) * j, y - 0.4, z + (Math.random() - 0.5) * j, (Math.random() - 0.5) * 0.5, -0.2 - Math.random() * 0.3, (Math.random() - 0.5) * 0.5, 6 + Math.random() * 4, 1.1 + Math.random() * 0.8, _c, 0.5, 1.3);
            if (k % 2 === 0) glow.spawn(x, y - 0.3, z, (Math.random() - 0.5) * 0.6, -0.4, (Math.random() - 0.5) * 0.6, 0.9 + Math.random() * 0.8, 1.8 + Math.random() * 1.2, 0xff4a26, 0.55 * g, 0.9);
          }
          // sparks falling off the burning head
          if (g > 0.05 && Math.random() < dt * 40) glow.spawn(f.position.x, f.position.y - 0.4, f.position.z, (Math.random() - 0.5) * 3, -1 - Math.random() * 2, (Math.random() - 0.5) * 3, 0.6 + Math.random() * 0.6, 0.35 + Math.random() * 0.3, 0xffb070, 0.9 * g, -0.2);
        }
        if (t >= FLARE.burn && f.burning) {
          f.burning = false;
          f.done = true;
          release(f);
          flares.splice(i, 1);
        }
      }
      smoke.update(dt, { drag: 0.35, lift: 0.25 });
      glow.update(dt, { drag: 0.8, gravity: 1.5 });
    },
    /** Remove every flare immediately (particles fade on their own). */
    clear() {
      for (const f of flares) {
        f.burning = false;
        f.done = true;
        release(f);
      }
      flares.length = 0;
    },
    get active() {
      return flares.length;
    },
  };
  return api;
}
