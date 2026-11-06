// Search-party vehicle rigs (Builder F): visuals only. rescue.js decides where the vehicles go and
// writes group.position / rotation; the rigs animate everything else: spinning rotors, blinking
// beacons, the searchlight (shared story SpotLight + a fake volumetric cone), rotor-wash dust,
// the rope ladder, the boat's radar, flashing blue light bar and foamy wake.
//
// Both rigs share the single story SpotLight (only one vehicle is ever active). Particle pools and
// meshes are created once; nothing is allocated per frame.
import * as THREE from 'three';
import { createHelicopter, createSearchBoat, createRopeLadder } from './models.js';
import { createLightCone, createParticles } from './fx.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);
const SPOT_ANGLE = 0.2;
const SPOT_LUX = 3.6; // target illuminance at the lit spot (physical units, like the sun ~3)

/** Point the shared SpotLight + cone from `from` to `to` with strength 0..1. */
function aimSpot(lights, cone, from, to, on, rain) {
  const spot = lights.spot;
  if (on < 0.01) {
    spot.intensity = 0;
    cone.mesh.visible = false;
    return;
  }
  _a.subVectors(to, from);
  const d = Math.max(1, _a.length());
  spot.position.copy(from);
  spot.target.position.copy(to);
  spot.target.updateMatrixWorld();
  spot.angle = SPOT_ANGLE;
  spot.penumbra = 0.5;
  spot.distance = 460;
  spot.decay = 1.6;
  spot.color.set(0xf4f1ff);
  // compensate the physical falloff so the pool on the ground stays readable at any range
  const win = Math.max(0.05, Math.pow(1 - Math.pow(Math.min(d, 440) / 460, 4), 2));
  spot.intensity = (on * SPOT_LUX * Math.pow(d, 1.6)) / win;
  // volumetric cone (apex at the lamp, pointing down -Y in its own space)
  const len = Math.min(d, 170);
  cone.mesh.visible = true;
  cone.mesh.position.copy(from);
  _q.setFromUnitVectors(DOWN, _a.multiplyScalar(1 / d));
  cone.mesh.quaternion.copy(_q);
  const r = len * Math.tan(SPOT_ANGLE) * 1.05;
  cone.mesh.scale.set(r, len, r);
  cone.mat.uniforms.uOpacity.value = on * (0.17 + 0.3 * rain);
}

// ── Helicopter ───────────────────────────────────────────────────────────
export function createHeliRig(ctx, lights) {
  const scene = ctx.scene;
  const world = ctx.world;
  const h = createHelicopter();
  const group = h.group;
  group.rotation.order = 'YXZ';
  group.visible = false;
  scene.add(group);
  const cone = createLightCone(0xf2f0ff);
  cone.mesh.visible = false;
  scene.add(cone.mesh);
  const dust = createParticles({ count: 480 });
  scene.add(dust.points);
  const ladder = createRopeLadder(23);
  ladder.visible = false;
  ladder.scale.y = 0.001;
  h.ladderAnchor.add(ladder);
  const spotFrom = new THREE.Vector3();
  let t = 0, washAcc = 0, viewportSet = false;

  return {
    group,
    get visible() {
      return group.visible;
    },
    show(on) {
      group.visible = !!on;
      if (!on) {
        cone.mesh.visible = false;
        ladder.visible = false;
        ladder.scale.y = 0.001;
      }
    },
    /** Rope ladder unroll 0..1 (hangs straight down in world space with a little sway). */
    setLadder(u) {
      ladder.visible = u > 0.001 && group.visible;
      ladder.scale.y = Math.max(0.001, u);
    },
    /** World position of the searchlight lens. */
    spotOrigin(out) {
      return h.spotAnchor.getWorldPosition(out);
    },
    /**
     * opts: { spot (0..1), spotTarget (Vector3), rain (0..1), wash (0..1 extra rotor-wash), rotor (0..1 rpm) }
     */
    update(dt, opts) {
      if (!viewportSet && typeof window !== 'undefined') {
        dust.setViewport(window.innerHeight, ctx.camera.fov);
        viewportSet = true;
      }
      dust.update(dt, { gravity: 1.2, drag: 1.4 });
      if (!group.visible) return;
      t += dt;
      const rpm = opts.rotor ?? 1;
      h.mainRotor.rotation.y += dt * 34 * rpm;
      h.tailRotor.rotation.x += dt * 61 * rpm;
      // anti-collision beacon (red, slow) + white tail strobe (double flash)
      h.beacon.material.emissiveIntensity = Math.sin(t * 6.2) > 0.55 ? 4 : 0.15;
      const st = t % 1.3;
      h.strobe.material.emissiveIntensity = st < 0.05 || (st > 0.16 && st < 0.21) ? 9 : 0;
      group.updateMatrixWorld(true);
      // ladder hangs straight down whatever the attitude
      if (ladder.visible) {
        group.getWorldQuaternion(_q).invert();
        ladder.quaternion.copy(_q);
        ladder.rotateX(Math.sin(t * 1.3) * 0.04);
        ladder.rotateZ(Math.sin(t * 0.9 + 1) * 0.05);
      }
      // searchlight
      h.spotAnchor.getWorldPosition(spotFrom);
      aimSpot(lights, cone, spotFrom, opts.spotTarget, opts.spot ?? 0, opts.rain ?? 0);
      // rotor wash: dust (or sea spray) blown outward on the ground under the helicopter
      const gx = group.position.x, gz = group.position.z;
      const groundY = Math.max(world.heightAt(gx, gz), world.SEA_LEVEL);
      const hag = group.position.y - groundY;
      const wash = Math.max(opts.wash ?? 0, Math.max(0, 1 - hag / 42));
      if (wash > 0.02) {
        const w = world.waterAt(gx, gz);
        const color = w ? 0xe3edf1 : 0xd8c69c;
        washAcc += dt * 160 * wash;
        while (washAcc >= 1) {
          washAcc -= 1;
          const a = Math.random() * Math.PI * 2;
          const r = 2 + Math.random() * 7;
          const x = gx + Math.cos(a) * r, z = gz + Math.sin(a) * r;
          const y = Math.max(world.heightAt(x, z), world.SEA_LEVEL) + 0.3;
          const s = 7 + Math.random() * 9;
          dust.spawn(x, y, z, Math.cos(a) * s, 0.8 + Math.random() * 2.2, Math.sin(a) * s, 1.4 + Math.random() * 1.4, 1.2 + Math.random() * 1.6, color, 0.5 * Math.min(1, wash * 1.5), 2.2);
        }
      }
    },
    /** Hide lights/cone (pass over). */
    off() {
      lights.spot.intensity = 0;
      cone.mesh.visible = false;
    },
  };
}

// ── Search boat ──────────────────────────────────────────────────────────
export function createBoatRig(ctx, lights) {
  const scene = ctx.scene;
  const b = createSearchBoat();
  const group = b.group;
  group.rotation.order = 'YXZ';
  group.visible = false;
  scene.add(group);
  const cone = createLightCone(0xf2f0ff);
  cone.mesh.visible = false;
  scene.add(cone.mesh);
  const wake = createParticles({ count: 520 });
  scene.add(wake.points);
  const spotFrom = new THREE.Vector3();
  let t = 0, wakeAcc = 0, viewportSet = false;

  return {
    group,
    get visible() {
      return group.visible;
    },
    show(on) {
      group.visible = !!on;
      if (!on) cone.mesh.visible = false;
    },
    spotOrigin(out) {
      return b.spotAnchor.getWorldPosition(out);
    },
    /** opts: { speed (m/s), spot (0..1), spotTarget (Vector3), rain } */
    update(dt, opts) {
      if (!viewportSet && typeof window !== 'undefined') {
        wake.setViewport(window.innerHeight, ctx.camera.fov);
        viewportSet = true;
      }
      wake.update(dt, { drag: 0.9 });
      if (!group.visible) return;
      t += dt;
      b.radar.rotation.y += dt * 2.6;
      // blue light bar: alternating double flash
      const ph = t % 0.9;
      b.lightBar.material.emissiveIntensity = ph < 0.08 || (ph > 0.18 && ph < 0.26) ? 6 : 0.2;
      group.updateMatrixWorld(true);
      // foamy wake: two streams off the stern quarters + a bow wave, more with speed
      const speed = opts.speed ?? 0;
      const yaw = group.rotation.y;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      wakeAcc += dt * Math.min(90, 6 + speed * 4.5);
      while (wakeAcc >= 1) {
        wakeAcc -= 1;
        const bow = Math.random() < 0.3;
        const side = Math.random() < 0.5 ? -1 : 1;
        _b.set(side * (bow ? 1.6 : 1.1 + Math.random() * 0.6), 0.15, bow ? -5.2 : 7.4).applyMatrix4(group.matrixWorld);
        const out = (bow ? 2.2 : 1.2) + Math.random() * 1.5;
        const back = bow ? -0.2 * speed : -0.35 * speed;
        wake.spawn(_b.x, 0.12, _b.z, rx * side * out + fx * back, 0.05, rz * side * out + fz * back, bow ? 1.5 + Math.random() : 3.5 + Math.random() * 2.5, bow ? 0.7 : 1.1 + Math.random() * 0.8, 0xf2f6f7, bow ? 0.6 : 0.5, bow ? 0.8 : 1.8);
      }
      b.spotAnchor.getWorldPosition(spotFrom);
      aimSpot(lights, cone, spotFrom, opts.spotTarget, opts.spot ?? 0, opts.rain ?? 0);
    },
    off() {
      lights.spot.intensity = 0;
      cone.mesh.visible = false;
    },
  };
}
