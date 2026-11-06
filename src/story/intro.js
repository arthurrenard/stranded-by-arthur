// Intro cutscene + the permanent wreck + the searchable beach crates (Builder F, SPEC §6 F).
//
// play() -> Promise (~26 s, skippable with Space / Enter / Escape, or by losing pointer lock):
//   1a  pre-dawn storm, on the deck of the fishing boat "Marguerite" rolling on big faceted waves
//       out beyond the reef (subtitles, lightning, the engine sputtering out)
//   1b  wide shot from the water: the boat pitching in the swell, lightning over the island
//   2   back on deck: a wave throws the boat onto the reef. Violent shake, crash, spray, you fall
//   3   black. "…"
//   4   dawn on the beach at landmarks.spawn: lying on the sand looking at the sky, blinking awake,
//       sitting up facing the wreck on the reef, then standing up and turning to spawn.yaw
//       (ends at the exact pose the player controller takes over with).
// The timeline is driven by update(dt) (real seconds; the game clock is paused in 'intro').
//
// Permanent world content (from create()/init(), visible in the game): the broken hull on the reef
// at landmarks.wreck (+ reef colliders), beach debris, and two crates at crate1 / crate2 that can be
// searched once each (rope 1 + cloth 2; flare 1).
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp01, lerp, smoothstep, damp, angleDiff } from '../core/util.js';
import { createFishingBoat, createWreck, createCrate, createDebris, getStoryLights, materials, REEF_ROCKS } from './models.js';
import { createParticles } from './fx.js';
import { createOverlay } from './overlay.js';
import { createStormSea } from './introSea.js';

const WRECK_YAW = 0.35; // bow of the wreck points NNW (toward the island)
const SKIP_KEYS = new Set(['Space', 'Enter', 'NumpadEnter', 'Escape']);
const FOV_CINE = 60;

// Timeline (seconds from play()).
const T = {
  wide: 6.6, // cut to the wide shot
  deck2: 10.6, // back on deck
  impact: 12.0, // the hull hits the reef
  fadeOut: 13.0, // fade to black
  swap: 13.7, // (black) storm -> dawn, boat -> wreck, camera -> beach
  wake: 17.2, // fade in on the beach
  sit: 21.2, // sit up
  rise: 23.6, // stand up + turn
  end: 26.2,
};

// ── Boat motion: speed profile + heading drift, precomputed into a table ──
function boatSpeed(t) {
  if (t >= T.impact) return 0;
  let v = lerp(4.6, 2.4, smoothstep(5.6, 8.4, t)); // the engine dies
  v += 4.2 * smoothstep(10.2, 11.5, t); // a big wave throws the boat at the reef
  return v;
}
function boatYawAt(t) {
  const tt = Math.min(t, T.impact);
  return WRECK_YAW + 0.24 * (1 - smoothstep(0, T.impact, tt)) + 0.05 * Math.sin(tt * 0.8);
}
const PATH_DT = 0.02;
const PATH_N = Math.ceil(T.impact / PATH_DT) + 1;

// shake noise: deterministic sum of sines (no allocations)
const shakeN = (t, f, s) => Math.sin(t * f + s) * 0.6 + Math.sin(t * f * 2.31 + s * 1.7) * 0.4;
const ease = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

export function create(ctx) {
  const world = ctx.world;
  const L = world.landmarks;
  const scene = ctx.scene;
  const cam = ctx.camera;
  const SEA = world.SEA_LEVEL ?? 0;
  const lights = getStoryLights(scene);

  // ── Permanent wreck on the reef (y = sea level: the reef rocks + hull are modeled around it) ──
  const wreck = createWreck();
  wreck.group.position.set(L.wreck.x, SEA, L.wreck.z);
  wreck.group.rotation.y = WRECK_YAW;
  scene.add(wreck.group);
  // The reef pedestal reaches down to the seabed (~-11 m). Everything below -2.5 m is invisible in deep water anyway,
  // but grazing views through the shallows near the beach could see it as a pale slab: clip it (world-space plane).
  {
    const clip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 2.5)];
    wreck.group.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      o.material = o.material.clone();
      o.material.clippingPlanes = clip;
    });
  }
  const cW = Math.cos(WRECK_YAW), sW = Math.sin(WRECK_YAW);
  /** Wreck-local (x, z) -> world {x, z}. */
  const wreckToWorld = (lx, lz) => ({ x: L.wreck.x + lx * cW + lz * sW, z: L.wreck.z - lx * sW + lz * cW });

  // ── Beach crates + debris ──────────────────────────────────────────────
  const ground = (x, z) => Math.max(world.heightAt(x, z), SEA - 0.15);
  const crateDefs = [
    { at: L.crate1, seed: 3, yaw: 0.7, loot: [['rope', 1], ['cloth', 2]], text: 'Inside: a coil of rope and two strips of sailcloth from the Marguerite.', icon: '📦', kind: 'good' },
    { at: L.crate2, seed: 7, yaw: -0.5, loot: [['flare', 1]], text: 'An emergency flare! Save it for when the search party is close.', icon: '🧨', kind: 'story' },
  ];
  const crates = crateDefs.map((d) => {
    const c = createCrate(d.seed);
    const y = ground(d.at.x, d.at.z);
    c.group.position.set(d.at.x, y - 0.07, d.at.z); // settled into the sand
    c.group.rotation.y = d.yaw;
    scene.add(c.group);
    return { ...d, ...c, y, opened: false, lidT: 0, handle: null, collider: null };
  });
  const toSea = { x: L.wreck.x - L.spawn.x, z: L.wreck.z - L.spawn.z };
  const toSeaLen = Math.hypot(toSea.x, toSea.z) || 1;
  toSea.x /= toSeaLen;
  toSea.z /= toSeaLen;
  const debris = createDebris(
    world,
    [
      { x: L.crate1.x, z: L.crate1.z, r: 5, n: 6 },
      { x: L.crate2.x, z: L.crate2.z, r: 4, n: 5 },
      { x: L.spawn.x + toSea.x * 8 - 3, z: L.spawn.z + toSea.z * 8, r: 4, n: 4 },
      { x: L.spawn.x + toSea.x * 18 + 9, z: L.spawn.z + toSea.z * 18, r: 6, n: 4 },
    ],
    11
  );
  scene.add(debris);

  // ── Intro-only state (built lazily in play(), disposed at the end) ─────
  const overlay = createOverlay();
  let boat = null, boatWindows = null, sea = null, spray = null;
  let playing = false, skipping = false, done = false;
  let elapsed = 0, cueIndex = 0;
  let resolveFn = null, promise = null;
  let offKey = null, offUnlock = null, safety = 0;
  let lightning = 0, lightningT = 0, lampOn = true;
  let bowPrevY = 0, camY = 0, firstBoatFrame = true;
  let boatPitch = 0, boatRoll = 0, boatY = 0;
  const pathX = new Float64Array(PATH_N), pathZ = new Float64Array(PATH_N);
  let startX = 0, startZ = 0;
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
  const spawnG = world.heightAt(L.spawn.x, L.spawn.z);
  const yawSea = Math.atan2(-(L.wreck.x - L.spawn.x), -(L.wreck.z - L.spawn.z));

  // Final resting point of the boat: just behind the wreck center along its axis.
  const finalPos = wreckToWorld(0.4, 7.6);

  function buildPath() {
    let x = 0, z = 0;
    for (let i = 0; i < PATH_N; i++) {
      const t = i * PATH_DT;
      pathX[i] = x;
      pathZ[i] = z;
      const v = boatSpeed(t), yw = boatYawAt(t);
      x += -Math.sin(yw) * v * PATH_DT;
      z += -Math.cos(yw) * v * PATH_DT;
    }
    startX = finalPos.x - pathX[PATH_N - 1];
    startZ = finalPos.z - pathZ[PATH_N - 1];
  }
  function boatXZ(t, out) {
    const f = Math.min(Math.max(t, 0), T.impact) / PATH_DT;
    const i = Math.min(PATH_N - 2, Math.floor(f));
    const u = Math.min(1, f - i);
    out.x = startX + lerp(pathX[i], pathX[i + 1], u);
    out.z = startZ + lerp(pathZ[i], pathZ[i + 1], u);
    return out;
  }

  function buildIntroScene() {
    const b = createFishingBoat();
    boat = b.group;
    boat.rotation.order = 'YXZ';
    boat.userData.lamp = b.lamp;
    boatWindows = boat.children.find((m) => m.material === materials().windowLit) || null;
    scene.add(boat);
    sea = createStormSea();
    const mid = boatXZ(T.impact * 0.5, { x: 0, z: 0 });
    sea.setCenter(mid.x, mid.z + 25, 230);
    sea.setLandZ(L.wreck.z - 30);
    sea.setReef(L.wreck.x, L.wreck.z, 24);
    scene.add(sea.mesh);
    spray = createParticles({ count: 420 });
    scene.add(spray.points);
    spray.setViewport(window.innerHeight, FOV_CINE);
    wreck.hull.visible = false;
  }
  function disposeIntroScene() {
    if (boat) scene.remove(boat);
    boat = null;
    boatWindows = null;
    sea?.dispose();
    sea = null;
    if (spray) {
      scene.remove(spray.points);
      spray.points.geometry.dispose();
      spray.points.material.dispose();
    }
    spray = null;
    wreck.hull.visible = true;
    lights.spot.intensity = 0;
    lights.spot.angle = 0.24;
    lights.point.intensity = 0;
    lights.point.distance = 30;
    lights.point.color.set(0xffc27a);
  }

  // ── Effects helpers ────────────────────────────────────────────────────
  function strike(strength = 1) {
    if (ctx.weather?.lightning) ctx.weather.lightning({ strength, distance: 250 + (1 - Math.min(1, strength)) * 900 });
    else {
      ctx.sky?.flash?.(strength);
      ctx.audio?.play?.('thunder', { volume: 0.6 + 0.4 * strength });
    }
    overlay.flash(0.22 * strength, 0.4);
    lightning = strength;
    lightningT = 0;
  }
  function setCam(x, y, z, yaw, pitch, roll) {
    cam.position.set(x, y, z);
    cam.rotation.set(pitch, yaw, roll, 'YXZ');
  }
  function setFov(f) {
    if (Math.abs(cam.fov - f) < 0.01) return;
    cam.fov = f;
    cam.updateProjectionMatrix();
  }
  function setBlur(px) {
    const el = ctx.renderer?.domElement;
    if (el) el.style.filter = px > 0.05 ? `blur(${px.toFixed(2)}px)` : '';
  }
  function engine(vol) {
    if (boat) ctx.audio?.setLoop?.('engine', vol, boat.position);
    else ctx.audio?.setLoop?.('engine', 0);
  }

  // ── Cues (fire once when the timeline passes them) ────────────────────
  const CUES = [
    [0.0, () => ctx.fade?.(0, 2.2)],
    [0.9, () => overlay.showSkip(true)],
    [1.2, () => strike(0.6)],
    [1.6, () => overlay.subtitle("Day 9 at sea. The radio's been dead since midnight…", 4.4)],
    [4.3, () => strike(1)],
    [T.wide, () => strike(0.9)],
    [7.2, () => overlay.subtitle("…something's wrong with the engine.", 3.8)],
    [8.9, () => strike(0.7)],
    [11.35, () => strike(1)],
    [T.impact, impact],
    [12.45, () => ctx.audio?.play?.('crash', { volume: 0.6, position: boat?.position })],
    [T.fadeOut, () => ctx.fade?.(1, 0.6)],
    [13.3, () => ctx.audio?.play?.('splash', { volume: 1 })],
    [T.swap, swapToBeach],
    [14.3, () => overlay.subtitle('…', 2.6)],
    [T.wake, () => ctx.fade?.(0, 1.8)],
    [17.6, () => ctx.audio?.play?.('gasp', { volume: 0.8 })],
    [18.9, () => ctx.fade?.(0.92, 0.16)],
    [19.12, () => ctx.fade?.(0.12, 0.6)],
    [20.0, () => ctx.fade?.(0.95, 0.14)],
    [20.2, () => ctx.fade?.(0, 0.9)],
    [22.3, () => overlay.subtitle('The Marguerite… she’s gone.', 3.2)],
    [T.rise - 0.4, () => overlay.showSkip(false)],
  ];

  function impact() {
    ctx.audio?.play?.('crash', { volume: 1, position: boat?.position });
    overlay.flash(0.5, 0.6);
    strike(0.8);
    lampOn = false;
    if (boatWindows) boatWindows.material = materials().windowDark;
    if (boat?.userData.lamp) boat.userData.lamp.visible = false;
    engine(0);
    // spray burst over the bow
    if (boat && spray) {
      boat.updateMatrixWorld(true);
      for (let i = 0; i < 170; i++) {
        _v.set((Math.random() - 0.5) * 3.4, 0.4 + Math.random() * 0.8, -4.6 - Math.random() * 1.6);
        boat.localToWorld(_v);
        const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 7;
        spray.spawn(_v.x, _v.y, _v.z, Math.cos(a) * s, 4 + Math.random() * 9, Math.sin(a) * s, 1.1 + Math.random() * 1.3, 0.5 + Math.random() * 0.9, 0xdfe9ee, 0.75, 1.2);
      }
    }
  }

  function swapToBeach() {
    ctx.weather?.set?.({ storm: false, auto: true }, 0);
    ctx.time?.setHour?.(CONFIG.time.startHour);
    engine(0);
    disposeIntroScene();
    setBlur(7);
    beachCamera(T.swap);
  }

  // ── Shots ──────────────────────────────────────────────────────────────
  const _xz = { x: 0, z: 0 };
  function updateBoat(t, dt) {
    if (!boat) return;
    sea.setTime(t);
    boatXZ(t, _xz);
    const yaw = boatYawAt(t);
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const s = (lx, lz) => sea.surfaceAt(_xz.x + lx * cy + lz * sy, _xz.z - lx * sy + lz * cy);
    const hc = s(0, 0), hb = s(0, -4.5), hs = s(0, 4.5), hp = s(-1.8, 0), hsb = s(1.8, 0);
    const tp = Math.atan2(hb - hs, 9), tr = Math.atan2(hsb - hp, 3.6);
    const ty = (hc * 2 + hb + hs + hp + hsb) / 6 - 0.15;
    if (firstBoatFrame) {
      boatPitch = tp;
      boatRoll = tr;
      boatY = ty;
      firstBoatFrame = false;
    } else {
      boatPitch = damp(boatPitch, tp, 3.5, dt);
      boatRoll = damp(boatRoll, tr, 2.6, dt);
      boatY = damp(boatY, ty, 5, dt);
    }
    let pitch = boatPitch, roll = boatRoll, y = boatY;
    if (t >= T.impact) {
      // riding up onto the rock: bow up, heavy list, then a shudder
      const k = t - T.impact;
      const e = 1 - Math.exp(-k * 7);
      pitch = lerp(pitch, 0.2, e) + 0.12 * Math.exp(-k * 4) * Math.sin(k * 22);
      roll = lerp(roll, 0.32, e) + 0.06 * Math.exp(-k * 3) * Math.sin(k * 17 + 1);
      y = lerp(y, Math.max(y, SEA) + 0.55, e);
    }
    boat.position.set(_xz.x, y, _xz.z);
    boat.rotation.set(pitch, yaw, roll, 'YXZ');
    boat.updateMatrixWorld(true);
    sea.setBoat(_xz.x, _xz.z, yaw, y);

    // bow spray when the bow slams down into a wave
    _v.set(0, 0.5, -5.0);
    boat.localToWorld(_v);
    const bowVy = dt > 0 ? (_v.y - bowPrevY) / dt : 0;
    bowPrevY = _v.y;
    if (t < T.impact && bowVy < -1.0 && spray) {
      const n = Math.min(6, Math.floor(-bowVy * 2));
      for (let i = 0; i < n; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        _v2.set(side * (0.6 + Math.random() * 1.0), 0.2, -4.2 - Math.random() * 1.2);
        boat.localToWorld(_v2);
        spray.spawn(_v2.x, _v2.y, _v2.z, side * cy * (2 + Math.random() * 3) - sy * 2, 2.5 + Math.random() * 3.5, -side * sy * (2 + Math.random() * 3) - cy * 2, 0.9 + Math.random() * 0.6, 0.35 + Math.random() * 0.5, 0xd5e2e8, 0.6, 0.9);
      }
    }

    // deck lamp: warm swinging light (dies at impact)
    const lamp = boat.userData.lamp;
    if (lamp && lampOn) {
      lamp.getWorldPosition(lights.point.position);
      lights.point.color.set(0xffc27a);
      lights.point.distance = 28;
      lights.point.intensity = 24 * (0.92 + 0.08 * Math.sin(t * 23) * Math.sin(t * 7.3));
    } else lights.point.intensity = damp(lights.point.intensity, 0, 14, dt);

    // engine: steady, then sputtering, then dead
    if (t < T.impact) {
      const sput = t < 5.6 ? 1 : t < 8.2 ? clamp01(0.55 + 0.45 * Math.sin(t * 19) * Math.sin(t * 5.3)) * (1 - smoothstep(5.6, 8.2, t)) : 0;
      engine(0.55 * sput);
    }
  }

  function updateLightning(dt) {
    lightningT += dt;
    // two quick pulses per strike, from high above the boat
    const pulse = lightning * (Math.exp(-lightningT * 9) + 0.7 * Math.exp(-Math.max(0, lightningT - 0.13) * 11) * (lightningT > 0.13 ? 1 : 0));
    if (boat && pulse > 0.002) {
      lights.spot.position.set(boat.position.x - 60, 170, boat.position.z - 90);
      lights.spot.target.position.copy(boat.position);
      lights.spot.target.updateMatrixWorld();
      lights.spot.angle = 0.7;
      lights.spot.color.set(0xdfe6ff);
      lights.spot.intensity = pulse * 26000;
    } else lights.spot.intensity = 0;
  }

  function deckCamera(t, lx, ly, lz, yawOff, pitchOff, dt) {
    _v.set(lx, ly, lz);
    boat.localToWorld(_v);
    // a person on deck keeps their head a bit steadier than the hull
    let yaw = boat.rotation.y + yawOff + 0.025 * Math.sin(t * 0.7);
    let pitch = boat.rotation.x * 0.75 + pitchOff + 0.02 * Math.sin(t * 1.3);
    let roll = boat.rotation.z * 0.55;
    if (t >= T.impact) {
      const k = t - T.impact;
      const A = 0.11 * Math.exp(-k * 2.2) + 0.02;
      yaw += A * shakeN(t, 31, 1);
      pitch += A * shakeN(t, 37, 2) + 1.05 * ease((t - 12.45) / 0.95);
      roll += A * 1.4 * shakeN(t, 29, 3) + 0.55 * ease((t - 12.5) / 0.9);
      // thrown forward, then overboard
      const lurch = ease(k / 0.25);
      _v.x += -Math.sin(boat.rotation.y) * 0.8 * lurch + A * shakeN(t, 41, 4) * 0.5;
      _v.z += -Math.cos(boat.rotation.y) * 0.8 * lurch;
      const fall = ease((t - 12.5) / 1.0);
      _v.y += -0.4 * lurch + A * shakeN(t, 43, 5) * 0.4 - 2.4 * fall * fall;
      _v.x += boat.matrixWorld.elements[0] * 1.2 * fall; // over the starboard rail
      _v.z += boat.matrixWorld.elements[2] * 1.2 * fall;
    }
    setCam(_v.x, _v.y, _v.z, yaw, pitch, roll);
    void dt;
  }

  function wideCamera(t, dt) {
    const yaw = boat.rotation.y;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const u = (t - T.wide) / (T.deck2 - T.wide);
    const bx = boat.position.x, bz = boat.position.z;
    const cx = bx + rx * 17 + fx * (-10 + 11 * u), cz = bz + rz * 17 + fz * (-10 + 11 * u);
    const target = sea.surfaceAt(cx, cz) * 0.7 + 2.3;
    camY = t - T.wide < 0.05 ? target : damp(camY, target, 3, dt);
    cam.position.set(cx, camY, cz);
    cam.lookAt(bx + fx * 2, boat.position.y + 1.9, bz + fz * 2);
    cam.rotateZ(Math.sin(t * 0.9) * 0.035);
  }

  function beachCamera(t) {
    const g = spawnG;
    let x = L.spawn.x, z = L.spawn.z, y, yaw = yawSea, pitch, roll;
    if (t < T.sit) {
      // lying on the back, looking up into the dawn sky, breathing
      const br = Math.sin(t * 1.25);
      y = g + 0.24 + br * 0.008;
      pitch = 1.32 + br * 0.014;
      roll = 0.12;
      yaw += 0.03 * Math.sin(t * 0.4);
    } else if (t < T.rise) {
      const e = ease((t - T.sit) / (T.rise - T.sit));
      y = g + lerp(0.24, 0.95, e);
      pitch = lerp(1.32, -0.07, e);
      roll = lerp(0.12, 0, e);
      x += toSea.x * 0.35 * e;
      z += toSea.z * 0.35 * e;
    } else {
      const u = clamp01((t - T.rise) / (T.end - T.rise));
      const e = ease(u);
      const turn = ease((u - 0.2) / 0.8);
      y = g + lerp(0.95, CONFIG.player.eyeHeight, e) + Math.sin(e * Math.PI) * 0.05;
      pitch = lerp(-0.07, 0, e);
      roll = Math.sin(turn * Math.PI) * 0.03;
      yaw = yawSea + angleDiff(yawSea, L.spawn.yaw) * turn;
      x += toSea.x * 0.35 * (1 - e);
      z += toSea.z * 0.35 * (1 - e);
    }
    setCam(x, y, z, yaw, pitch, roll);
    // blurry eyes clear up after waking
    if (t >= T.wake - 0.5 && t < T.sit + 0.5) setBlur(lerp(7, 0, clamp01((t - T.wake) / 3.6)));
  }

  function finalPose() {
    setCam(L.spawn.x, spawnG + CONFIG.player.eyeHeight, L.spawn.z, L.spawn.yaw, 0, 0);
  }

  // ── Play / skip / finish ───────────────────────────────────────────────
  function skip() {
    if (!playing || skipping || done) return;
    skipping = true;
    overlay.showSkip(false);
    overlay.hideSubtitle();
    const p = ctx.fade ? ctx.fade(1, 0.35) : Promise.resolve();
    p.then(() => finish());
  }

  function finish() {
    if (done) return;
    done = true;
    playing = false;
    clearTimeout(safety);
    offKey?.();
    offUnlock?.();
    offKey = offUnlock = null;
    overlay.hideSubtitle();
    overlay.showSkip(false);
    // world back to the gameplay state (idempotent if the timeline already did it)
    ctx.weather?.set?.({ storm: false, auto: true }, 0);
    ctx.time?.setHour?.(CONFIG.time.startHour);
    ctx.audio?.setLoop?.('engine', 0);
    disposeIntroScene();
    setBlur(0);
    setFov(CONFIG.graphics.fov);
    finalPose();
    ctx.letterbox?.(false);
    ctx.events.emit('intro:done', {});
    const r = resolveFn;
    resolveFn = null;
    r?.();
  }

  function play() {
    if (promise) return promise;
    promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    try {
      playing = true;
      elapsed = 0;
      cueIndex = 0;
      ctx.flags.cinematic = true;
      ctx.letterbox?.(true);
      ctx.fade?.(1, 0); // start from black; the first cue fades in
      ctx.weather?.set?.({ storm: true }, 0);
      ctx.time?.setHour?.(CONFIG.time.introHour);
      buildPath();
      buildIntroScene();
      setFov(FOV_CINE);
      firstBoatFrame = true;
      updateBoat(0, 0);
      deckCamera(0, -0.55, 2.75, -0.6, 0.12, -0.08, 0);
      offKey = ctx.input?.onKeyDown?.((code) => {
        if (playing && elapsed > 0.4 && SKIP_KEYS.has(code)) skip();
      });
      offUnlock = ctx.events.on('input:unlock', () => {
        if (playing && elapsed > 0.5) skip();
      });
      // never leave the game stuck in the intro
      safety = setTimeout(() => {
        if (!done) {
          console.warn('[intro] safety timeout');
          finish();
        }
      }, (T.end + 15) * 1000);
    } catch (e) {
      console.error('[intro] play() failed', e);
      finish();
    }
    return promise;
  }

  function update(dt) {
    // crate lids swing open after searching (world animation: any state)
    for (const c of crates) {
      if (c.opened && c.lidT < 1) {
        c.lidT = Math.min(1, c.lidT + dt * 1.8);
        const e = 1 - Math.pow(1 - c.lidT, 3);
        c.lid.rotation.x = -1.95 * e + Math.sin(c.lidT * Math.PI) * 0.12;
      }
    }
    if (!playing) return;
    try {
      elapsed += dt;
      const t = elapsed;
      overlay.update(dt);
      if (!skipping) {
        while (cueIndex < CUES.length && CUES[cueIndex][0] <= t) {
          const fn = CUES[cueIndex][1];
          cueIndex++;
          fn();
        }
      }
      if (boat) {
        updateBoat(t, dt);
        updateLightning(dt);
        if (t < T.wide) deckCamera(t, -0.55, 2.75, -0.6, 0.12, -0.08, dt);
        else if (t < T.deck2) wideCamera(t, dt);
        else deckCamera(t, 0.5, 2.95, -1.9, -0.06, -0.12, dt);
        spray?.update(dt, { gravity: 9.8, drag: 0.5 });
      } else if (t >= T.swap) beachCamera(t);
      if (t >= T.end && !skipping) finish();
    } catch (e) {
      console.error('[intro] update failed, skipping the intro', e);
      skipping = true;
      finish();
    }
  }

  function init() {
    // crates: interactables + small colliders
    for (const c of crates) {
      c.handle = ctx.interact?.register?.({
        position: new THREE.Vector3(c.at.x, c.y + 0.45, c.at.z),
        radius: CONFIG.player.reach + 0.3,
        label: 'Search the crate',
        enabled: () => !c.opened,
        priority: 0.4,
        onUse: () => openCrate(c),
      });
      c.collider = ctx.colliders?.add?.({ x: c.at.x, z: c.at.z, r: 0.5, y0: c.y - 0.4, y1: c.y + 0.58, tag: 'crate' });
    }
    // reef rocks you can bump into / climb onto when swimming out to the wreck
    for (const k of REEF_ROCKS) {
      const p = wreckToWorld(k.x, k.z);
      ctx.colliders?.add?.({ x: p.x, z: p.z, r: k.r * 0.85, y0: -30, y1: SEA + k.top, tag: 'reef' });
    }
  }

  function openCrate(c) {
    if (c.opened || ctx.state !== 'playing' || ctx.flags.cinematic) return;
    c.opened = true;
    c.lidT = 0;
    for (const [id, n] of c.loot) ctx.inventory?.add?.(id, n);
    ctx.audio?.play?.('pickup', { position: c.group.position });
    ctx.ui?.toast?.(c.text, { icon: c.icon, kind: c.kind, duration: c.kind === 'story' ? 7 : 5 });
    c.handle?.remove?.();
    c.handle = null;
  }

  return {
    play,
    init,
    update,
    /** True while the cutscene runs. */
    get playing() {
      return playing;
    },
    wreck: wreck.group,
    crates: crates.map((c) => ({ id: c.loot[0][0] === 'flare' ? 'crate2' : 'crate1', group: c.group, get opened() {
      return c.opened;
    } })),
    skip,
  };
}
