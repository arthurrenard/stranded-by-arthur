// Builder V3-C — the "sail away" cinematic shared by the fisherman's motorboat ([R] Head for home) and the
// Boatyard boat leaving Tempest Isle ([E] Sail home): letterbox, the camera behind the boat as it speeds
// toward the horizon, subtitles, then a fade and onDone(). Skippable with Space / Escape.
//
// createSailAway(ctx, {
//   object,          // THREE.Object3D to move (world space)
//   heading,         // start heading, yaw convention (forward = (-sin h, -cos h))
//   target,          // heading to turn toward (yaw convention); defaults to heading
//   yawOffset = 0,   // object.rotation.y = heading + yawOffset (the Boatyard boat's bow is local +Z: -PI)
//   y,               // float height of the object origin (sea level based)
//   vmax = 12, engine = false, duration = 10.5,
//   subtitles = [[t, text, seconds]], onDone,
// }) -> { update(dt), skip(), done }
import * as THREE from 'three';
import { wrapAngle } from './vehicle-logic.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createSailAway(ctx, o) {
  const obj = o.object;
  const cam = ctx.camera;
  const yawOffset = o.yawOffset || 0;
  const vmax = o.vmax || 12;
  const duration = o.duration || 10.5;
  const subs = (o.subtitles || []).map((s) => ({ t: s[0], text: s[1], dur: s[2] || 4, shown: false }));
  const camPos = new THREE.Vector3();
  const look = new THREE.Vector3();
  let t = 0, speed = Math.max(0, o.speed0 || 0), heading = o.heading || 0;
  const target = o.target ?? heading;
  let fading = false, finished = false;
  const prevCine = ctx.flags.cinematic;
  ctx.flags.cinematic = true;
  ctx.letterbox?.(true);
  cam.rotation.order = 'YXZ';

  function fade(sec) {
    if (fading) return;
    fading = true;
    let p = null;
    try {
      p = ctx.fade?.(1, sec);
    } catch (e) {
      p = null;
    }
    const done = () => finish();
    if (p && typeof p.then === 'function') p.then(done, done);
    else setTimeout(done, sec * 1000);
  }
  function finish() {
    if (finished) return;
    finished = true;
    api.done = true;
    if (o.engine) ctx.audio?.setLoop?.('engine', 0);
    ctx.letterbox?.(false);
    o.onDone?.();
    // normally the game ends here (raft:sailed -> win screen, cinematic stays on like raft.js); else hand back
    if (ctx.state === 'playing') ctx.flags.cinematic = prevCine;
  }

  const api = {
    done: false,
    skip() {
      if (t > 0.3) fade(0.8);
    },
    update(dt) {
      if (finished) return;
      t += dt;
      if (t > 0.4 && (ctx.input?.wasPressed?.('Space') || ctx.input?.wasPressed?.('Escape'))) fade(0.8);
      speed = Math.min(vmax, speed + (vmax / 4) * dt);
      heading = wrapAngle(heading + wrapAngle(target - heading) * clamp01(0.6 * dt));
      const fx = -Math.sin(heading), fz = -Math.cos(heading);
      obj.position.x += fx * speed * dt;
      obj.position.z += fz * speed * dt;
      const bob = Math.sin(t * 1.9) * 0.06;
      obj.position.y = (o.y ?? obj.position.y) + bob;
      obj.rotation.set(-0.04 * (speed / vmax) + Math.sin(t * 1.3) * 0.02, heading + yawOffset, Math.sin(t * 1.1) * 0.035, 'YXZ');
      if (o.engine) ctx.audio?.setLoop?.('engine', 0.9, obj.position);
      // camera: close behind for ~4 s, then it stays put and the boat shrinks toward the horizon
      if (t < 4.2) {
        const back = 9 + t * 0.6;
        camPos.set(obj.position.x - fx * back, obj.position.y + 3.2, obj.position.z - fz * back);
      }
      look.set(obj.position.x + fx * 6, obj.position.y + 0.6, obj.position.z + fz * 6);
      const dx = look.x - camPos.x, dy = look.y - camPos.y, dz = look.z - camPos.z;
      cam.position.copy(camPos);
      cam.rotation.set(Math.atan2(dy, Math.hypot(dx, dz) || 1e-6), Math.atan2(-dx, -dz), 0, 'YXZ');
      for (const s of subs) {
        if (!s.shown && t >= s.t) {
          s.shown = true;
          ctx.ui?.subtitle?.(s.text, s.dur);
        }
      }
      if (t > duration) fade(1.5);
    },
  };
  ctx.events?.once?.('input:unlock', () => api.skip());
  return api;
}
