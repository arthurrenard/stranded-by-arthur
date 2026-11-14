// Summit survey cinematic (V4-A, SPEC §12). The first time the player stands on the summit plateau, the camera
// lifts out of their eyes, flies a slow 360° orbit of Driftwood Isle at ~150 m (Tempest Isle on the horizon for the
// south-western part of the arc), shows the title card ("DRIFTWOOD ISLE · day N") and swoops back into the eyes.
// Replay: [E] "Survey the island" at the center of the stone circle (registered by init(), radius 4, any hour).
//
// Owned and driven by eastereggs.js (not a main.js system): create(ctx, { x, z, y, r }) -> api, then
// api.init() (registers the interactable), api.check(playerPos) each frame (first-time trigger) and api.update(dt).
// api.survey({ first }) -> Promise (null when it cannot start). Sets ctx.flags.cinematic + ctx.letterbox, restores
// camera position / yaw / pitch / fov exactly, re-locks the pointer (from the skip keydown when possible) and emits
// 'summit:survey' { first }. Never runs while aboard a vehicle, dead, sleeping, in a menu or in another cinematic.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createOverlay } from './overlay.js';

const SKIP_KEYS = new Set(['Space', 'Enter', 'NumpadEnter', 'Escape']);

/** Timeline (seconds) and orbit geometry. Exported for tests. */
export const SURVEY = {
  lift: 2.8, // eye -> orbit start
  orbit: 9.0, // one full turn
  swoop: 2.4, // orbit end -> eye
  alt: 150, // orbit altitude (m)
  radius: 210, // orbit radius around (0, 0)
  lookY: 20, // the orbit looks at (0, lookY, 0): slightly down at the island
  fovMid: 60, // FOV in the middle (base -> mid -> base)
  titleAt: 3.6, // title card cue
  titleFor: 5.2,
};
export const SURVEY_TOTAL = SURVEY.lift + SURVEY.orbit + SURVEY.swoop;

export const easeInOutCubic = (x) => {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Pure camera pose at timeline time t for a shot that started from eye (ex, ey, ez) looking along (fx, fy, fz)
 * with base FOV `fov0`. Writes { x, y, z, tx, ty, tz, fov, phase } into `out` (position, look target, fov).
 * The orbit starts above the player's bearing around the island center, so the lift-off goes straight up and out.
 */
export function surveyPose(t, start, out = {}) {
  const { ex, ey, ez, fx, fy, fz, fov0 = CONFIG.graphics?.fov ?? 72 } = start;
  const a0 = Math.atan2(ez, ex);
  const px = Math.cos(a0) * SURVEY.radius, pz = Math.sin(a0) * SURVEY.radius;
  const lx = ex + fx * 30, ly = ey + fy * 30, lz = ez + fz * 30; // where the player was looking
  if (t < SURVEY.lift) {
    const e = easeInOutCubic(t / SURVEY.lift);
    out.x = lerp(ex, px, e);
    out.y = lerp(ey, SURVEY.alt, e);
    out.z = lerp(ez, pz, e);
    out.tx = lerp(lx, 0, e);
    out.ty = lerp(ly, SURVEY.lookY, e);
    out.tz = lerp(lz, 0, e);
    out.fov = lerp(fov0, SURVEY.fovMid, e);
    out.phase = 'lift';
  } else if (t < SURVEY.lift + SURVEY.orbit) {
    const u = (t - SURVEY.lift) / SURVEY.orbit;
    // gentle start and stop around the full turn (ease-in-out sine keeps the middle speed even)
    const a = a0 + Math.PI * 2 * (0.5 - 0.5 * Math.cos(Math.PI * u));
    out.x = Math.cos(a) * SURVEY.radius;
    out.y = SURVEY.alt + Math.sin(u * Math.PI * 2) * 4;
    out.z = Math.sin(a) * SURVEY.radius;
    out.tx = 0;
    out.ty = SURVEY.lookY;
    out.tz = 0;
    out.fov = SURVEY.fovMid;
    out.phase = 'orbit';
  } else {
    const e = easeInOutCubic((t - SURVEY.lift - SURVEY.orbit) / SURVEY.swoop);
    out.x = lerp(px, ex, e);
    out.y = lerp(SURVEY.alt, ey, e);
    out.z = lerp(pz, ez, e);
    out.tx = lerp(0, lx, e);
    out.ty = lerp(SURVEY.lookY, ly, e);
    out.tz = lerp(0, lz, e);
    out.fov = lerp(SURVEY.fovMid, fov0, e);
    out.phase = 'swoop';
  }
  return out;
}

export function create(ctx, center = { x: 0, z: 0, y: 0, r: 25 }) {
  const cam = ctx.camera;
  const overlay = createOverlay();
  const pose = {};
  const start = { ex: 0, ey: 0, ez: 0, fx: 0, fy: 0, fz: -1, fov0: CONFIG.graphics?.fov ?? 72 };
  const saved = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, fov: 72, cine: false };
  const _t = new THREE.Vector3();
  let active = false, surveyed = false, elapsed = 0, titleShown = false, skipShown = false, first = false;
  let resolveFn = null, offKey = null, handle = null, lockOnFinish = false;

  const busy = () => ctx.flags?.cinematic || ctx.flags?.sleeping || ctx.ui?.menuOpen || ctx.stats?.dead || ctx.player?.aboard || ctx.vehicles?.current;
  const canStart = () => ctx.state === 'playing' && !active && !busy();

  function setFov(f) {
    if (Math.abs(cam.fov - f) < 0.01) return;
    cam.fov = f;
    cam.updateProjectionMatrix();
  }
  function apply(t) {
    surveyPose(t, start, pose);
    cam.position.set(pose.x, pose.y, pose.z);
    _t.set(pose.tx, pose.ty, pose.tz);
    cam.up.set(0, 1, 0);
    cam.lookAt(_t);
    setFov(pose.fov);
  }

  function finish() {
    if (!active) return;
    active = false;
    offKey?.();
    offKey = null;
    overlay.hideTitle();
    overlay.showSkip(false);
    // restore the eyes exactly
    cam.position.copy(saved.pos);
    cam.rotation.set(saved.pitch, saved.yaw, 0, 'YXZ');
    setFov(saved.fov);
    if (ctx.player) {
      if ('yaw' in ctx.player) ctx.player.yaw = saved.yaw;
      if ('pitch' in ctx.player) ctx.player.pitch = saved.pitch;
    }
    if (ctx.flags) ctx.flags.cinematic = saved.cine;
    ctx.letterbox?.(false);
    if (lockOnFinish && ctx.input?.lock && !ctx.input.locked) {
      try {
        ctx.input.lock();
      } catch (_) {}
    }
    lockOnFinish = false;
    const r = resolveFn;
    resolveFn = null;
    r?.();
  }

  function survey({ first: isFirst = false } = {}) {
    if (!canStart()) return null;
    active = true;
    first = isFirst;
    elapsed = 0;
    titleShown = skipShown = false;
    // capture the eyes
    saved.pos.copy(cam.position);
    saved.yaw = ctx.player?.yaw ?? cam.rotation.y;
    saved.pitch = ctx.player?.pitch ?? cam.rotation.x;
    saved.fov = cam.fov;
    saved.cine = !!ctx.flags?.cinematic;
    start.ex = cam.position.x;
    start.ey = cam.position.y;
    start.ez = cam.position.z;
    const cp = Math.cos(saved.pitch);
    start.fx = -Math.sin(saved.yaw) * cp;
    start.fy = Math.sin(saved.pitch);
    start.fz = -Math.cos(saved.yaw) * cp;
    start.fov0 = CONFIG.graphics?.fov ?? saved.fov;
    if (ctx.flags) ctx.flags.cinematic = true;
    ctx.letterbox?.(true);
    ctx.ui?.setPrompt?.(null);
    ctx.audio?.play?.('whoosh', { volume: 0.5 });
    offKey = ctx.input?.onKeyDown?.((code) => {
      if (active && elapsed > 0.4 && SKIP_KEYS.has(code)) {
        // a keydown is a user gesture: re-lock the pointer right here when it was lost
        lockOnFinish = true;
        finish();
      }
    }) || null;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    apply(0);
    ctx.events?.emit?.('summit:survey', { first });
    return promise;
  }

  function update(dt) {
    if (!active) return;
    overlay.update(dt);
    if (ctx.state !== 'playing' && ctx.state !== 'paused') {
      finish(); // dead / rescued mid-shot: give the camera back
      return;
    }
    if (ctx.state !== 'playing') return; // the pause menu froze the world: hold the frame
    elapsed += Math.min(dt, 0.1);
    if (!skipShown && elapsed > 0.6) {
      skipShown = true;
      overlay.showSkip(true);
    }
    if (!titleShown && elapsed >= SURVEY.titleAt) {
      titleShown = true;
      overlay.titleCard('DRIFTWOOD ISLE', `day ${ctx.time?.day ?? 1}`, SURVEY.titleFor);
      ctx.audio?.play?.('shimmer', { volume: 0.6 });
    }
    if (elapsed >= SURVEY_TOTAL - 0.6) overlay.showSkip(false);
    if (elapsed >= SURVEY_TOTAL) {
      lockOnFinish = true;
      finish();
      return;
    }
    apply(elapsed);
  }

  /** First-time trigger: standing on the plateau (within r of the summit center, near its height). */
  function check(p) {
    if (surveyed || !p || !canStart()) return;
    const dx = p.x - center.x, dz = p.z - center.z, r = center.r ?? 25;
    if (dx * dx + dz * dz > r * r || Math.abs(p.y - center.y) > 8) return;
    surveyed = true;
    survey({ first: true });
  }

  return {
    survey(opts) {
      const p = survey(opts);
      if (p) surveyed = true;
      return p;
    },
    get surveyed() {
      return surveyed;
    },
    get active() {
      return active;
    },
    check,
    update,
    init() {
      if (handle || !ctx.interact?.register) return;
      handle = ctx.interact.register({
        position: new THREE.Vector3(center.x, center.y + 0.6, center.z),
        radius: 4,
        label: 'Survey the island',
        priority: 0.3,
        enabled: () => canStart(),
        onUse: () => {
          const p = survey({ first: !surveyed });
          if (p) surveyed = true;
        },
      });
    },
    dispose() {
      if (active) finish();
      handle?.remove?.();
      handle = null;
    },
  };
}
