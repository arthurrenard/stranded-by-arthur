// Intro cutscene + the permanent wreck + the searchable beach crates (Builder F, SPEC §6 F; crash rework V4-A, §12).
//
// play() -> Promise (~26 s, skippable with Space / Enter / Escape, or by losing pointer lock):
//   1a  pre-dawn storm, on the deck of the fishing boat "Marguerite" rolling on big faceted waves
//       out beyond the reef (subtitles, lightning, the engine sputtering out)
//   1b  wide shot from the water: the boat pitching in the swell, lightning over the island
//   2   back on deck: a rogue crest builds behind the boat, lifts the stern then the bow, and throws the
//       hull onto the reef. Lightning on the impact, spray, planks, the deck lamp swings and dies, a 0.35 s
//       slow-motion beat, the camera (bolted to the boat's transform: it can never leave the deck or dip under
//       the sea) is thrown to the planks. Hard fade.
//   3   black. "…"
//   4   dawn on the beach at landmarks.spawn: lying on the sand looking at the sky, blinking awake,
//       sitting up facing the wreck on the reef, then standing up and turning to spawn.yaw
//       (ends at the exact pose the player controller takes over with).
// The timeline is driven by update(dt) (real seconds; the game clock is paused in 'intro').
//
// Rigid boat: hull, cabin, mast, lamp and name plate are children of ONE group; the sea drives the group's pose
// before the impact; at the impact the pose is captured and the group only shudders around it (no gravity, no
// drift). The camera is computed from boat.matrixWorld every frame and clamped to >= sea level + 0.4.
//
// Permanent world content (from create()/init(), visible in the game): the broken hull on the reef
// at landmarks.wreck (+ reef colliders), beach debris, and two crates at crate1 / crate2 that can be
// searched once each (rope 1 + cloth 2; flare 1).
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { clamp01, lerp, smoothstep, damp, angleDiff } from '../core/util.js';
import { createFishingBoat, createWreck, createCrate, createDebris, getStoryLights, materials, REEF_ROCKS } from './models.js';
import { createParticles, createPlanks } from './fx.js';
import { createOverlay } from './overlay.js';
import { createStormSea } from './introSea.js';

const WRECK_YAW = 0.35; // bow of the wreck points NNW (toward the island)
const SKIP_KEYS = new Set(['Space', 'Enter', 'NumpadEnter', 'Escape']);
const FOV_CINE = 60;

/** Timeline (seconds from play()). Exported for tests: the values must be strictly increasing. */
export const T = {
  wide: 6.6, // cut to the wide shot
  deck2: 10.6, // back on deck
  crest: 10.9, // the rogue crest starts to build behind the boat
  impact: 12.0, // the hull hits the reef (lightning, spray, planks, slow motion)
  fadeOut: 13.15, // fade to black
  swap: 13.9, // (black) storm -> dawn, boat -> wreck, camera -> beach
  wake: 17.4, // fade in on the beach
  sit: 21.4, // sit up
  rise: 23.8, // stand up + turn
  end: 26.4,
};
/** Slow-motion beat right after the impact: duration (s) and time rate. */
export const SLOWMO = { duration: 0.35, rate: 0.3 };
/** The rogue crest: height (m), half width (m), speed along the boat's heading (m/s). */
export const CREST = { amp: 1.7, halfWidth: 5.5, speed: 11 };

// ── Boat motion: speed profile + heading drift, precomputed into a table ──
export function boatSpeed(t) {
  if (t >= T.impact) return 0;
  let v = lerp(4.6, 2.4, smoothstep(5.6, 8.4, t)); // the engine dies
  v += 4.2 * smoothstep(10.2, 11.5, t); // the crest throws the boat at the reef
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
/** Crest amplitude envelope: builds from T.crest, peaks at the impact, gone ~1.3 s later. */
export function crestAmpAt(t) {
  return CREST.amp * smoothstep(T.crest, T.impact - 0.35, t) * (1 - smoothstep(T.impact + 0.2, T.impact + 1.3, t));
}
/** Time rate of the boat / sea / particles at timeline time t (slow motion right after the impact). */
export function timeRateAt(t) {
  return t >= T.impact && t < T.impact + SLOWMO.duration ? SLOWMO.rate : 1;
}

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
  let boat = null, boatWindows = null, sea = null, spray = null, planks = null, lamp = null, lampLocal = null;
  let playing = false, skipping = false, done = false;
  let elapsed = 0, cueIndex = 0;
  let resolveFn = null, promise = null;
  let offKey = null, offUnlock = null, safety = 0;
  let lightning = 0, lightningT = 0, lampOn = true, lampFlicker = 1;
  let bowPrevY = 0, camY = 0, firstBoatFrame = true;
  let boatPitch = 0, boatRoll = 0, boatY = 0;
  let seaT = 0, impactK = -1; // sea clock (slow-motion aware) and time since the impact (-1 before)
  const rest = { x: 0, z: 0, y: 0, yaw: 0, pitch: 0, roll: 0 }; // the pose captured at the impact
  const crestDir = { x: 0, z: -1, bowS: 0 }; // heading at the impact; bowS = dot(bow at impact, dir)
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
    lamp = b.lamp;
    lampLocal = b.lampLocal;
    lamp.material = materials().lamp;
    lamp.visible = true;
    boatWindows = boat.children.find((m) => m.material === materials().windowLit) || null;
    scene.add(boat);
    sea = createStormSea();
    const mid = boatXZ(T.impact * 0.5, { x: 0, z: 0 });
    sea.setCenter(mid.x, mid.z + 25, 230);
    sea.setLandZ(L.wreck.z - 30);
    sea.setReef(L.wreck.x, L.wreck.z, 24);
    sea.setCrest(0, -1, -1e5, CREST.halfWidth, 0);
    scene.add(sea.mesh);
    spray = createParticles({ count: 520 });
    scene.add(spray.points);
    spray.setViewport(window.innerHeight, FOV_CINE);
    planks = createPlanks(26);
    scene.add(planks.mesh);
    wreck.hull.visible = false;
    // the crest rolls along the heading at the impact and reaches the bow exactly then
    const yawI = boatYawAt(T.impact);
    crestDir.x = -Math.sin(yawI);
    crestDir.z = -Math.cos(yawI);
    const bowX = finalPos.x + crestDir.x * 5.2, bowZ = finalPos.z + crestDir.z * 5.2;
    crestDir.bowS = bowX * crestDir.x + bowZ * crestDir.z;
  }
  function disposeIntroScene() {
    if (boat) scene.remove(boat);
    boat = null;
    boatWindows = null;
    lamp = null;
    sea?.dispose();
    sea = null;
    if (spray) {
      scene.remove(spray.points);
      spray.points.geometry.dispose();
      spray.points.material.dispose();
    }
    spray = null;
    planks?.dispose();
    planks = null;
    wreck.hull.visible = true;
    lights.spot.intensity = 0;
    lights.spot.angle = 0.24;
    lights.point.intensity = 0;
    lights.point.distance = 30;
    lights.point.color.set(0xffc27a);
  }

  // ── Effects helpers ────────────────────────────────────────────────────
  function strike(strength = 1, distance = null) {
    const dist = distance ?? 250 + (1 - Math.min(1, strength)) * 900;
    if (ctx.weather?.lightning) ctx.weather.lightning({ strength, distance: dist });
    else {
      ctx.sky?.flash?.(strength);
      ctx.audio?.play?.('thunder', { volume: 0.6 + 0.4 * Math.min(1, strength) });
    }
    overlay.flash(0.22 * Math.min(1.4, strength), 0.4);
    lightning = strength;
    lightningT = 0;
  }
  function setCam(x, y, z, yaw, pitch, roll) {
    cam.position.set(x, Math.max(y, SEA + 0.4), z);
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
    [T.crest + 0.5, () => overlay.subtitle('Oh no. No no no—', 1.6)],
    [T.impact, impact],
    [T.impact + 0.45, () => ctx.audio?.play?.('crash', { volume: 0.6, position: boat?.position })],
    [T.impact + 0.7, () => ctx.audio?.play?.('tree_crash', { volume: 0.7, position: boat?.position })],
    [T.fadeOut, () => ctx.fade?.(1, 0.6)],
    [T.fadeOut + 0.3, () => ctx.audio?.play?.('splash', { volume: 1 })],
    [T.swap, swapToBeach],
    [T.swap + 0.5, () => overlay.subtitle('…', 2.6)],
    [T.wake, () => ctx.fade?.(0, 1.8)],
    [T.wake + 0.4, () => ctx.audio?.play?.('gasp', { volume: 0.8 })],
    [T.wake + 1.7, () => ctx.fade?.(0.92, 0.16)],
    [T.wake + 1.92, () => ctx.fade?.(0.12, 0.6)],
    [T.wake + 2.8, () => ctx.fade?.(0.95, 0.14)],
    [T.wake + 3.0, () => ctx.fade?.(0, 0.9)],
    [T.sit + 0.9, () => overlay.subtitle('The Marguerite… she’s gone.', 3.2)],
    [T.rise - 0.4, () => overlay.showSkip(false)],
  ];

  function impact() {
    // capture the pose: from here on the group only shudders around it (no gravity, no drift)
    if (boat) {
      rest.x = boat.position.x;
      rest.z = boat.position.z;
      rest.y = boat.position.y;
      rest.yaw = boat.rotation.y;
      rest.pitch = boat.rotation.x;
      rest.roll = boat.rotation.z;
    }
    impactK = 0;
    ctx.audio?.play?.('crash', { volume: 1, position: boat?.position });
    ctx.audio?.play?.('thunder', { volume: 1 });
    overlay.flash(0.6, 0.55);
    strike(1.3, 300); // lightning synced with the impact
    if (boatWindows) boatWindows.material = materials().windowDark;
    engine(0);
    if (!boat) return;
    boat.updateMatrixWorld(true);
    const yaw = boat.rotation.y, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // spray burst over the bow
    if (spray) {
      for (let i = 0; i < 260; i++) {
        _v.set((Math.random() - 0.5) * 3.6, 0.3 + Math.random() * 0.9, -4.8 - Math.random() * 1.8);
        boat.localToWorld(_v);
        const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 8;
        spray.spawn(_v.x, _v.y, _v.z, Math.cos(a) * s + fx * 3, 4 + Math.random() * 10, Math.sin(a) * s + fz * 3, 1.2 + Math.random() * 1.4, 0.5 + Math.random() * 1.0, 0xdfe9ee, 0.8, 1.4);
      }
    }
    // flying planks from the bow and the port rail
    if (planks) {
      for (let i = 0; i < 22; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        _v.set(side * (0.6 + Math.random() * 1.2), 0.9 + Math.random() * 0.8, -3.6 - Math.random() * 2.2);
        boat.localToWorld(_v);
        const up = 3.5 + Math.random() * 6.5, fwd = 2 + Math.random() * 6, out = (1 + Math.random() * 4) * side;
        planks.spawn(_v.x, _v.y, _v.z, fx * fwd + rx * out + (Math.random() - 0.5) * 2, up, fz * fwd + rz * out + (Math.random() - 0.5) * 2, 6 + Math.random() * 3, 0.6 + Math.random() * 0.8);
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
  /** Drive the rigid boat group. dtw = slow-motion aware dt. */
  function updateBoat(t, dt, dtw) {
    if (!boat) return;
    seaT += dtw;
    sea.setTime(seaT);
    // the rogue crest: rolls along the heading, reaching the bow exactly at the impact
    sea.setCrest(crestDir.x, crestDir.z, crestDir.bowS + CREST.speed * (Math.min(t, T.impact + 1.3) - T.impact), CREST.halfWidth, crestAmpAt(t));
    let pitch, roll, y, yaw;
    if (impactK < 0) {
      boatXZ(t, _xz);
      yaw = boatYawAt(t);
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
      pitch = boatPitch;
      roll = boatRoll;
      y = boatY;
    } else {
      // frozen on the rock: bow up, heavy list, a decaying shudder around the captured pose
      const k = impactK;
      const e = 1 - Math.exp(-k * 7);
      _xz.x = rest.x;
      _xz.z = rest.z;
      yaw = rest.yaw + 0.03 * e;
      pitch = lerp(rest.pitch, 0.2, e) + 0.12 * Math.exp(-k * 4) * Math.sin(k * 22);
      roll = lerp(rest.roll, 0.32, e) + 0.06 * Math.exp(-k * 3) * Math.sin(k * 17 + 1);
      y = lerp(rest.y, Math.max(rest.y, SEA) + 0.55, e) + 0.03 * Math.exp(-k * 5) * Math.sin(k * 31);
    }
    boat.position.set(_xz.x, y, _xz.z);
    boat.rotation.set(pitch, yaw, roll, 'YXZ');
    boat.updateMatrixWorld(true);
    sea.setBoat(_xz.x, _xz.z, yaw, y);

    // bow spray when the bow slams down into a wave
    _v.set(0, 0.5, -5.0);
    boat.localToWorld(_v);
    const bowVy = dtw > 0 ? (_v.y - bowPrevY) / dtw : 0;
    bowPrevY = _v.y;
    if (impactK < 0 && bowVy < -1.0 && spray) {
      const sy = Math.sin(yaw), cy = Math.cos(yaw);
      const n = Math.min(6, Math.floor(-bowVy * 2));
      for (let i = 0; i < n; i++) {
        const side = Math.random() < 0.5 ? -1 : 1;
        _v2.set(side * (0.6 + Math.random() * 1.0), 0.2, -4.2 - Math.random() * 1.2);
        boat.localToWorld(_v2);
        spray.spawn(_v2.x, _v2.y, _v2.z, side * cy * (2 + Math.random() * 3) - sy * 2, 2.5 + Math.random() * 3.5, -side * sy * (2 + Math.random() * 3) - cy * 2, 0.9 + Math.random() * 0.6, 0.35 + Math.random() * 0.5, 0xd5e2e8, 0.6, 0.9);
      }
    }
    // the crest breaking over the stern just before the impact
    if (impactK < 0 && t > T.impact - 0.7 && spray) {
      for (let i = 0; i < 3; i++) {
        _v2.set((Math.random() - 0.5) * 3, 0.6, 4.2 + Math.random() * 1.5);
        boat.localToWorld(_v2);
        spray.spawn(_v2.x, _v2.y, _v2.z, (Math.random() - 0.5) * 3, 3 + Math.random() * 4, (Math.random() - 0.5) * 3, 0.8 + Math.random() * 0.5, 0.5 + Math.random() * 0.6, 0xd5e2e8, 0.7, 1.0);
      }
    }

    // deck lamp: a pendulum under the mast top; it swings hard on the impact, sputters and dies
    if (lamp) {
      const swingT = impactK < 0 ? seaT : seaT;
      let ax = -pitch * 1.6 + 0.12 * Math.sin(swingT * 2.3), az = roll * 1.5 + 0.08 * Math.sin(swingT * 1.9 + 1);
      if (impactK >= 0) {
        const k = impactK;
        ax += 0.9 * Math.exp(-k * 1.1) * Math.sin(k * 9 + 0.4);
        az += 0.6 * Math.exp(-k * 1.3) * Math.sin(k * 7.5);
        // sputter: the bulb flickers for ~0.8 s, then dark
        lampFlicker = k < 0.8 ? (Math.sin(k * 61) * Math.sin(k * 23 + 1) > -0.2 ? 1 : 0.15) * (1 - k / 0.8) : 0;
        if (lampOn && k >= 0.8) {
          lampOn = false;
          lamp.material = materials().windowDark;
        }
      }
      const arm = 0.42;
      lamp.position.set(lampLocal.x + Math.sin(az) * arm, lampLocal.y + arm - Math.cos(ax) * Math.cos(az) * arm, lampLocal.z + Math.sin(ax) * arm);
    }
    if (lamp && lampOn) {
      lamp.getWorldPosition(lights.point.position);
      lights.point.color.set(0xffc27a);
      lights.point.distance = 28;
      lights.point.intensity = 24 * lampFlicker * (0.92 + 0.08 * Math.sin(seaT * 23) * Math.sin(seaT * 7.3));
    } else lights.point.intensity = damp(lights.point.intensity, 0, 14, dt);

    // engine: steady, then sputtering, then dead
    if (impactK < 0) {
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

  /**
   * First-person camera standing on the deck: the eye is a boat-LOCAL point (lx, ly, lz) pushed through
   * boat.matrixWorld, so it rides the hull exactly. After the impact the eye lurches forward and is thrown down
   * to the planks (still inside the hull: ly never drops under the deck), with a hard shake, roll and a pitch
   * toward the deck. World y is clamped to >= sea level + 0.4 in setCam.
   */
  function deckCamera(t, lx, ly, lz, yawOff, pitchOff) {
    let ox = 0, oy = 0, oz = 0;
    let yaw = boat.rotation.y + yawOff + 0.025 * Math.sin(t * 0.7);
    let pitch = boat.rotation.x * 0.75 + pitchOff + 0.02 * Math.sin(t * 1.3);
    let roll = boat.rotation.z * 0.55;
    if (impactK < 0 && t > T.crest) {
      // bracing: the eye dips a little as the crest lifts the stern
      const b = smoothstep(T.crest, T.impact, t);
      oy -= 0.12 * b;
      pitch -= 0.08 * b;
    }
    if (impactK >= 0) {
      const k = impactK;
      const A = 0.11 * Math.exp(-k * 2.2) + 0.015;
      yaw += A * shakeN(k, 31, 1);
      const fall = ease((k - 0.42) / 0.75); // thrown to the deck
      const lurch = ease(k / 0.25); // thrown forward first
      pitch += A * shakeN(k, 37, 2) + 0.85 * fall - 0.12 * lurch;
      roll += A * 1.4 * shakeN(k, 29, 3) + 0.55 * fall;
      ox += A * shakeN(k, 41, 4) * 0.4 + 0.45 * fall; // slides toward the starboard rail
      oz += -0.8 * lurch;
      oy += -0.3 * lurch + A * shakeN(k, 43, 5) * 0.3 - 1.0 * fall; // knees, then the planks (eye ~0.9 m above the deck)
    }
    _v.set(lx + ox, Math.max(ly + oy, 1.9), lz + oz);
    boat.localToWorld(_v);
    setCam(_v.x, _v.y, _v.z, yaw, pitch, roll);
  }

  function wideCamera(t, dt) {
    const yaw = boat.rotation.y;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const u = (t - T.wide) / (T.deck2 - T.wide);
    const bx = boat.position.x, bz = boat.position.z;
    const cx = bx + rx * 17 + fx * (-10 + 11 * u), cz = bz + rz * 17 + fz * (-10 + 11 * u);
    const target = sea.surfaceAt(cx, cz) * 0.7 + 2.3;
    camY = t - T.wide < 0.05 ? target : damp(camY, target, 3, dt);
    cam.position.set(cx, Math.max(camY, SEA + 0.4), cz);
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
      seaT = 0;
      impactK = -1;
      lampOn = true;
      lampFlicker = 1;
      ctx.flags.cinematic = true;
      ctx.letterbox?.(true);
      ctx.fade?.(1, 0); // start from black; the first cue fades in
      ctx.weather?.set?.({ storm: true }, 0);
      ctx.time?.setHour?.(CONFIG.time.introHour);
      buildPath();
      buildIntroScene();
      setFov(FOV_CINE);
      firstBoatFrame = true;
      updateBoat(0, 0, 0);
      deckCamera(0, -0.55, 2.75, -0.6, 0.12, -0.08);
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
      dt = Math.min(dt, 0.1);
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
        const dtw = dt * timeRateAt(t); // the slow-motion beat right after the impact
        if (impactK >= 0) impactK += dtw;
        updateBoat(t, dt, dtw);
        updateLightning(dt);
        if (t < T.wide) deckCamera(t, -0.55, 2.75, -0.6, 0.12, -0.08);
        else if (t < T.deck2) wideCamera(t, dt);
        else deckCamera(t, 0.5, 2.95, -1.9, -0.06, -0.12);
        spray?.update(dtw, { gravity: 9.8, drag: 0.5 });
        planks?.update(dtw, { gravity: 9.8, drag: 0.15, floorY: SEA + 0.12 });
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
