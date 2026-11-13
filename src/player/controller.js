// First-person player controller: mouse look, walking / sprinting / jumping on the heightfield, colliders,
// slope sliding, swimming (float, bob, sink when exhausted), diving (hold X, v2), fall damage, world-boundary currents, head bob,
// footsteps and the death fall. See SPEC.md §6 D.
//
// Conventions: position = FEET (world space). camera.rotation.order === 'YXZ'; yaw = rotation.y
// (0 = looking north, -Z), pitch = rotation.x. Forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw).
// The camera is written only while ctx.state === 'playing' && !ctx.flags.cinematic (and during the death fall).
// Sounds: this module only emits player:* events; the audio module turns them into footsteps / splashes.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import * as M from '../survival/model.js';
import { currentsAt } from '../gameplay/vehicle-logic.js';

const DEG = Math.PI / 180;
const PITCH_LIMIT = 85 * DEG;
const STEP_UP = 0.45; // max ledge / rock height you walk up without jumping
const BODY_HEIGHT = 1.8; // vertical extent used for collider overlap
const COYOTE_TIME = 0.12; // s after leaving the ground when a jump still works
const JUMP_BUFFER = 0.15; // s a jump press is remembered before landing
const ACCEL_GROUND = 12; // exponential approach rates (1/s): snappy but smooth
const FRICTION_GROUND = 10;
const ACCEL_AIR = 2.5;
const DRAG_AIR = 0.3;
const ACCEL_SWIM = 3.2;
const DRAG_SWIM = 1.4;
const BACKPEDAL = 0.8; // speed factor walking backwards
const SLIDE_START = 0.48; // slopeAt where sliding begins (0 flat .. 1 vertical)
const SLIDE_FULL = 0.6;
const TERMINAL_FALL = 45;
const FLOAT_EYE = 0.25; // eyes this far above the water surface while swimming
const SINK_EYE = -0.45; // eyes this far below the surface when too exhausted to swim
const SWIM_EXIT_MARGIN = 0.12; // hysteresis on CONFIG.player.swimDepth
const SINK_PADDLE_SPEED = 0.9; // weak paddling while sinking
// Diving (v2, SPEC §10): hold CONFIG.keys.dive while swimming. Velocity targets, not the float spring,
// so letting go at depth doesn't fling you up.
const DIVE_SPEED = 1.5; // m/s down while X is held
const DIVE_RISE = 2.0; // m/s up while Space is held underwater
const DIVE_FLOAT = 0.8; // m/s gentle float back up when nothing is held
const DIVE_RESPONSE = 3.5; // how fast vertical speed reaches its target
const DIVE_HSPEED = 0.85; // horizontal swim speed factor while diving
const DIVE_FLOOR = 0.35; // feet stay this far above the seabed
const DIVE_HANDBACK = 0.3; // back to the float spring this close below the float level
const BOUNDARY_SOFT = 32; // currents start this far inside CONFIG.world.boundary
const CURRENT_ACCEL = 10;
const FOV_SPRINT_KICK = 5; // degrees

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

export function create(ctx) {
  const P = CONFIG.player;
  const position = new THREE.Vector3(); // feet
  const velocity = new THREE.Vector3();
  const eye = new THREE.Vector3(); // last written camera position
  const _n = new THREE.Vector3();
  const statsProxy = { exhausted: false, energy: 100 }; // reused input for model.landSpeed()

  // Internal state
  let t = 0;
  let coyote = 0;
  let jumpBuffer = 0;
  let onCollider = false;
  let sliding = 0;
  let airTime = 0;
  let surfaceY = 0; // current water surface (valid while waterInfo)
  let effDepth = 0; // water depth above the walkable ground (terrain or rock top)
  let groundY = 0;
  let lastWaterType = null;
  // camera feel
  let bobPhase = 0; // advances PI per step
  let bobWeight = 0;
  let stepSmooth = 0;
  let dip = 0,
    dipVel = 0;
  let roll = 0;
  let swimRoll = 0;
  let fovCur = CONFIG.graphics.fov;
  let fovApplied = false;
  let boundaryWarned = false;
  let swimHinted = false;
  let wasSinking = false; // v2: exhausted-sinking last frame (gentle float-up after recovering at depth)
  let wasControlling = false;
  // v3: seated aboard a vehicle (vehicles.js provides the seat Object3D at eye height)
  let seat = null;
  let seatRoll = 0;
  const cur = {}; // currentsAt() output, reused
  // death fall
  let deathInit = false;
  let deathT = 0;
  const death = { y0: 0, yEnd: 0, rx0: 0, rz0: 0, side: 1, dur: 1.7 };

  const api = {
    position,
    velocity,
    yaw: 0,
    pitch: 0,
    onGround: true,
    inWater: false,
    waterInfo: null,
    swimming: false,
    headUnderwater: false,
    /** v2: in dive mode (holding X while swimming, or still floating back up from a dive). */
    diving: false,
    /** v2: eye depth below the water surface in m (0 when the eyes are above water or on land). */
    depth: 0,
    sprinting: false,
    moving: false,
    sliding: false,
    /** When false the controller ignores input (physics and camera still run). */
    enabled: true,
    /** v3: the vehicle record while seated aboard (ctx.vehicles.current), else null. */
    aboard: null,

    /**
     * v3: sit on a vehicle. `seatObj` is an Object3D placed at eye height on the deck (it carries the
     * vehicle's bob and roll); `vehicle` becomes api.aboard. setSeat(null) stands up again (the caller then
     * teleports the player onto land or into the water). While seated there is no walking/swimming
     * physics, gravity, currents or footsteps; the mouse still looks around.
     */
    setSeat(seatObj, vehicle = null) {
      if (seatObj) {
        seat = seatObj;
        api.aboard = vehicle || api.aboard || { type: 'vehicle' };
        if (api.swimming) {
          api.swimming = false;
          ctx.events.emit('player:swimEnd', { type: lastWaterType });
        }
        if (api.inWater) {
          api.inWater = false;
          ctx.events.emit('player:exitWater', { type: lastWaterType });
        }
        if (api.headUnderwater) {
          api.headUnderwater = false;
          ctx.events.emit('player:surfaced', { type: lastWaterType });
        }
        api.diving = false;
        api.depth = 0;
        api.waterInfo = null;
        api.moving = api.sprinting = api.sliding = false;
        api.onGround = true;
        velocity.set(0, 0, 0);
        wasSinking = false;
        stepSmooth = dip = dipVel = 0;
        bobWeight = 0;
        api.syncSeat(0);
      } else {
        seat = null;
        api.aboard = null;
        seatRoll = 0;
      }
    },
    /** v3: copy the seat transform into the feet position + camera (vehicles call it after moving). */
    syncSeat(dt = 0) {
      if (!seat || ctx.state !== 'playing' || ctx.flags.cinematic) return;
      seat.updateWorldMatrix(true, false);
      eye.setFromMatrixPosition(seat.matrixWorld);
      const eyeH = api.aboard?.seatEye ?? 1.05;
      position.set(eye.x, eye.y - eyeH, eye.z);
      const r = api.aboard?.roll ?? 0;
      seatRoll = dt > 0 ? damp(seatRoll, r, 10, dt) : r;
      const cam = ctx.camera;
      cam.position.copy(eye);
      const breathe = Math.sin(t * 1.5) * 0.0022;
      cam.rotation.set(clamp(api.pitch + breathe + (api.aboard?.pitch ?? 0), -PITCH_LIMIT, PITCH_LIMIT), api.yaw, seatRoll, 'YXZ');
    },

    init() {
      const L = ctx.world?.landmarks?.spawn;
      if (L) api.teleport(L.x, L.z, L.yaw);
    },

    /** Place the feet on the ground (or a rock top) at x,z. yaw optional (pitch resets when given). */
    teleport(x, z, yaw) {
      if (seat) api.setSeat(null); // v3: teleporting always stands you up (vehicles notice aboard === null)
      position.set(x, 0, z);
      const g = ctx.world.heightAt(x, z);
      position.y = g;
      const top = ctx.colliders?.resolve?.(position, P.radius, g + 2.5, g + BODY_HEIGHT) ?? -Infinity;
      position.y = Math.max(ctx.world.heightAt(position.x, position.z), top);
      velocity.set(0, 0, 0);
      api.onGround = true;
      api.diving = false;
      api.depth = 0;
      wasSinking = false;
      onCollider = top > -Infinity && top >= position.y - 1e-6;
      coyote = 0;
      jumpBuffer = 0;
      airTime = 0;
      stepSmooth = 0;
      dip = dipVel = 0;
      bobWeight = 0;
      if (typeof yaw === 'number' && Number.isFinite(yaw)) {
        api.yaw = yaw;
        api.pitch = 0;
      }
      // Deep water: start afloat rather than standing on the sea floor.
      const w = ctx.world.waterAt(position.x, position.z);
      if (w && w.depth > P.swimDepth) {
        position.y = Math.max(w.surface - (P.eyeHeight - FLOAT_EYE), position.y);
        api.onGround = false;
      }
      // Snap the camera right away when control is (about to be) handed to the player.
      if (!ctx.flags.cinematic && (ctx.state === 'playing' || ctx.state === 'intro')) writeCamera(0);
    },

    /** Current eye (camera) position. */
    eyePosition(out = new THREE.Vector3()) {
      if (eye.lengthSq() === 0) return out.set(position.x, position.y + P.eyeHeight, position.z);
      return out.copy(eye);
    },

    /** Unit view direction from yaw/pitch. */
    lookDir(out = new THREE.Vector3()) {
      const cp = Math.cos(api.pitch);
      return out.set(-Math.sin(api.yaw) * cp, Math.sin(api.pitch), -Math.cos(api.yaw) * cp);
    },

    update(dt) {
      if (ctx.state === 'dead') {
        api.diving = false;
        deathFall(dt);
        return;
      }
      deathInit = false;
      if (ctx.state !== 'playing' || ctx.flags.cinematic) {
        restoreFov();
        wasControlling = false;
        return;
      }
      t += dt;
      const controllable = api.enabled && !ctx.flags.sleeping && !ctx.stats?.dead;
      if (controllable) look();
      if (seat) {
        // aboard: the vehicle moves the seat; no physics, gravity, currents or footsteps here
        restoreFov();
        api.moving = api.sprinting = api.sliding = false;
        wasControlling = controllable;
        api.syncSeat(dt);
        return;
      }
      // Ignore a jump pressed in the same frame control was (re)gained (e.g. "Space to skip" the intro).
      step(dt, controllable && wasControlling);
      wasControlling = controllable;
      writeCamera(dt);
    },
  };

  // ── Input ────────────────────────────────────────────────────────────────
  function look() {
    const sens = CONFIG.player.mouseSensitivity;
    const dx = ctx.input?.mouseDX ?? 0;
    const dy = ctx.input?.mouseDY ?? 0;
    if (dx || dy) {
      api.yaw -= dx * sens;
      api.pitch -= dy * sens;
    }
    api.pitch = clamp(api.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    if (api.yaw > Math.PI) api.yaw -= Math.PI * 2;
    else if (api.yaw < -Math.PI) api.yaw += Math.PI * 2;
  }

  // ── Simulation ───────────────────────────────────────────────────────────
  function step(dt, controllable) {
    const world = ctx.world;
    const input = ctx.input;
    const flags = ctx.flags;
    const vals = ctx.stats?.values;
    statsProxy.exhausted = !!ctx.stats?.exhausted;
    statsProxy.energy = vals?.energy ?? 100;
    const canSprint = M.canSprint(statsProxy) || !!flags.godMode;
    const speedScale = flags.speedScale ?? 1;
    const g = P.gravity * (flags.gravityScale ?? 1);

    // 1) Wish direction (local: ix right, iz forward)
    let ix = 0,
      iz = 0;
    if (controllable) {
      if (input.isDown('forward')) iz += 1;
      if (input.isDown('back')) iz -= 1;
      if (input.isDown('right')) ix += 1;
      if (input.isDown('left')) ix -= 1;
    }
    const il = Math.hypot(ix, iz);
    const hasInput = il > 0;
    if (hasInput) {
      ix /= il;
      iz /= il;
    }
    const sinY = Math.sin(api.yaw),
      cosY = Math.cos(api.yaw);
    const wishX = -sinY * iz + cosY * ix;
    const wishZ = -cosY * iz - sinY * ix;
    const sprintHeld = controllable && hasInput && input.isDown('sprint') && iz > -0.2;
    if (controllable && input.wasPressed('jump')) jumpBuffer = JUMP_BUFFER;
    else jumpBuffer = Math.max(0, jumpBuffer - dt);

    const prevX = position.x,
      prevZ = position.z;
    const swimming = api.swimming;
    const sinking = swimming && statsProxy.exhausted && !flags.godMode;
    const diveHeld = controllable && swimming && !sinking && input.isDown('dive');
    let fast = false;

    // 2) Horizontal velocity
    let speed, accel;
    if (swimming) {
      fast = sprintHeld && canSprint && !sinking;
      speed = sinking ? SINK_PADDLE_SPEED : fast ? P.swimFastSpeed : P.swimSpeed;
      if (diveHeld || api.diving) speed *= DIVE_HSPEED;
      accel = hasInput ? ACCEL_SWIM : DRAG_SWIM;
    } else {
      speed = flags.godMode && sprintHeld ? P.sprintSpeed : M.landSpeed(sprintHeld, statsProxy);
      fast = sprintHeld && canSprint && speed >= P.sprintSpeed - 1e-6;
      speed *= 1 - (1 - BACKPEDAL) * Math.max(0, -iz);
      // wading slows you down
      if (api.waterInfo && effDepth > 0.15) speed *= lerp(1, 0.6, smoothstep(0.15, P.swimDepth, effDepth));
      accel = api.onGround ? (hasInput ? ACCEL_GROUND : FRICTION_GROUND) : hasInput ? ACCEL_AIR : DRAG_AIR;
    }
    speed *= speedScale;
    let tvx = wishX * speed,
      tvz = wishZ * speed;

    // Slope sliding: remove the uphill part of the wish, pull downhill, lower friction.
    sliding = 0;
    let slideX = 0,
      slideZ = 0;
    if (!swimming && api.onGround && !onCollider) {
      const n = world.normalAt(position.x, position.z, _n);
      const slope = 1 - n.y;
      if (slope > SLIDE_START) {
        sliding = smoothstep(SLIDE_START, SLIDE_FULL, slope);
        const hl = Math.hypot(n.x, n.z) || 1;
        slideX = n.x / hl;
        slideZ = n.z / hl; // downhill direction
        const uphill = -(tvx * slideX + tvz * slideZ);
        if (uphill > 0) {
          tvx += slideX * uphill * sliding;
          tvz += slideZ * uphill * sliding;
        }
        accel *= 1 - 0.85 * sliding;
      }
    }
    if (!api.onGround && !swimming && !hasInput) {
      // keep momentum in the air: only a little drag
      velocity.x = damp(velocity.x, 0, accel * 0.1, dt);
      velocity.z = damp(velocity.z, 0, accel * 0.1, dt);
    } else {
      velocity.x = damp(velocity.x, tvx, accel, dt);
      velocity.z = damp(velocity.z, tvz, accel, dt);
    }
    if (sliding > 0) {
      velocity.x += slideX * g * 0.8 * sliding * dt;
      velocity.z += slideZ * g * 0.8 * sliding * dt;
    }

    // 3) World boundary: currents push you back toward the island
    applyBoundary(dt);

    // 4) Horizontal move + colliders
    position.x += velocity.x * dt;
    position.z += velocity.z * dt;
    const feet = position.y;
    const top = ctx.colliders?.resolve?.(position, P.radius, feet + STEP_UP - 0.05, feet + BODY_HEIGHT) ?? -Infinity;
    let terrain = world.heightAt(position.x, position.z);
    // Cliff guard: terrain rising faster than you can walk this frame blocks the move.
    const hStep = Math.hypot(position.x - prevX, position.z - prevZ);
    if (!swimming && api.onGround && terrain - feet > Math.max(STEP_UP, hStep * 1.5) && top < terrain) {
      position.x = prevX;
      position.z = prevZ;
      terrain = world.heightAt(prevX, prevZ);
      velocity.x *= 0.2;
      velocity.z *= 0.2;
    }
    onCollider = top > terrain;
    groundY = onCollider ? top : terrain;

    // 5) Water at the new position
    const w = world.waterAt(position.x, position.z);
    api.waterInfo = w;
    if (w) {
      surfaceY = w.surface;
      effDepth = w.surface - groundY;
      lastWaterType = w.type;
    } else effDepth = 0;

    // 6) Swim state (with hysteresis so the shoreline doesn't flicker)
    if (!api.swimming && w && effDepth > P.swimDepth && position.y < surfaceY - 0.6) startSwim(w);
    else if (api.swimming && (!w || effDepth < P.swimDepth - SWIM_EXIT_MARGIN)) endSwim();

    // 7) Vertical
    if (api.swimming) swimVertical(dt, controllable, sinking, diveHeld);
    else landVertical(dt, g, hStep, controllable);

    // 8) Flags, events, feel
    updateWaterFlags();
    const moved = Math.hypot(position.x - prevX, position.z - prevZ);
    const hSpeed = dt > 0 ? moved / dt : 0;
    api.moving = hasInput && hSpeed > 0.4;
    // a straight vertical dive costs the swim rate, not the treading rate (stats reads `moving`)
    if (!api.moving && api.diving && Math.abs(velocity.y) > 0.4) api.moving = true;
    api.sprinting = api.moving && fast && (api.swimming || api.onGround || airTime < 0.4);
    api.sliding = sliding > 0.3;
    if (api.moving && moved < 2 && ctx.stats_summary) ctx.stats_summary.distanceWalked += moved;
    footsteps(moved, hSpeed, dt);
    // strafe tilt (local lateral velocity)
    const lateral = velocity.x * cosY - velocity.z * sinY;
    roll = damp(roll, -clamp(lateral / P.walkSpeed, -1.5, 1.5) * 0.012, 6, dt);
  }

  function landVertical(dt, g, hStep, controllable) {
    const feet = position.y;
    if (api.onGround) {
      const drop = feet - groundY;
      const snap = 0.12 + hStep * 1.25;
      if (drop <= snap && velocity.y <= 0.01) {
        const rise = groundY - feet;
        if (rise > 0.08) stepSmooth -= rise; // smooth the camera over step-ups (rocks)
        position.y = groundY;
        velocity.y = 0;
      } else api.onGround = false; // walked off a ledge
    }
    coyote = api.onGround && sliding < 0.6 ? COYOTE_TIME : Math.max(0, coyote - dt);

    // Jump (coyote time + buffering; not when exhausted, not from steep slides or deep wading)
    if (controllable && jumpBuffer > 0 && coyote > 0 && effDepth < 0.9) {
      const allowed = ctx.flags.godMode || M.canSprint(statsProxy);
      if (allowed) {
        jumpBuffer = 0;
        coyote = 0;
        velocity.y = P.jumpVelocity;
        api.onGround = false;
        airTime = 0;
        ctx.stats?.drainEnergy?.(CONFIG.stats.energyJump);
        ctx.events.emit('player:jump', { speed: Math.hypot(velocity.x, velocity.z) });
      }
    }

    if (!api.onGround) {
      airTime += dt;
      velocity.y = Math.max(-TERMINAL_FALL, velocity.y - g * dt);
      position.y += velocity.y * dt;
      if (position.y <= groundY) land();
    } else airTime = 0;
  }

  function land() {
    const impact = -velocity.y;
    position.y = groundY;
    velocity.y = 0;
    api.onGround = true;
    const wasAirborne = airTime;
    airTime = 0;
    if (impact > 1.5 || wasAirborne > 0.25) {
      ctx.events.emit('player:land', { speed: impact });
      dipVel -= Math.min(impact, 22) * 0.045;
    }
    // Water softens the fall: deep enough water cancels the damage.
    const cushion = api.waterInfo ? smoothstep(0.3, 1.1, effDepth) : 0;
    const dmg = M.fallDamage(impact) * (1 - cushion);
    if (dmg > 0.5) ctx.stats?.damage?.(dmg, 'falling');
  }

  function startSwim(w) {
    api.swimming = true;
    api.onGround = false;
    // the water breaks a fall
    if (velocity.y < -3) {
      const impact = -velocity.y;
      velocity.y *= 0.3;
      dipVel -= Math.min(impact, 20) * 0.02;
    }
    ctx.events.emit('player:swimStart', { type: w.type });
    if (!swimHinted) {
      swimHinted = true;
      ctx.ui?.hint?.(
        'swim',
        'Swimming: hold Space to keep your head high, Shift to swim faster. It drains energy ⚡ — if it runs out in deep water, you sink.'
      );
    }
  }

  function endSwim() {
    api.swimming = false;
    api.diving = false;
    wasSinking = false;
    if (position.y < groundY) {
      stepSmooth -= groundY - position.y; // stand up smoothly
      position.y = groundY;
    }
    api.onGround = position.y <= groundY + 0.05;
    if (api.onGround) velocity.y = 0;
    ctx.events.emit('player:swimEnd', { type: lastWaterType });
  }

  function swimVertical(dt, controllable, sinking, diveHeld) {
    const wind = ctx.weather?.wind?.strength ?? ctx.uniforms?.uWindStrength?.value ?? 0.35;
    const amp = lastWaterType === 'ocean' ? 0.05 + 0.09 * clamp(wind, 0, 1.2) : 0.018;
    const wave =
      (Math.sin(t * 1.3 + position.x * 0.21) * 0.6 + Math.sin(t * 0.83 + position.z * 0.17 + 1.7) * 0.4) * amp;
    const floatFeet = surfaceY - (P.eyeHeight - FLOAT_EYE) + wave;
    // Dive mode: entered by holding X; left when exhausted (sinking takes over) or back near the float level.
    // After an exhausted sink at depth, recovering energy floats you up gently instead of springing up.
    if (sinking) api.diving = false;
    else if (diveHeld || (wasSinking && position.y < floatFeet - DIVE_HANDBACK)) api.diving = true;
    wasSinking = sinking;
    if (api.diving) {
      diveVertical(dt, controllable, diveHeld, floatFeet - wave);
      coyote = 0;
      airTime = 0;
      return;
    }
    let target = floatFeet;
    let k = 14,
      c = 5.5;
    if (sinking) {
      // a slow, heavy sink; never lifts you from deeper down (e.g. exhausted mid-dive)
      target = Math.min(surfaceY - P.eyeHeight + SINK_EYE + wave * 0.3, position.y);
      k = 3;
      c = 3.2;
    } else if (controllable && ctx.input.isDown('jump')) target = floatFeet + 0.28; // kick up: head and shoulders out
    target = Math.max(target, groundY);
    velocity.y += ((target - position.y) * k - velocity.y * c) * dt;
    position.y += velocity.y * dt;
    if (position.y < groundY) {
      position.y = groundY;
      if (velocity.y < 0) velocity.y = 0;
    }
    coyote = 0;
    airTime = 0;
  }

  /** Underwater vertical motion: X descends, Space rises, neither floats you up; the seabed stops you. */
  function diveVertical(dt, controllable, diveHeld, floatFeet) {
    const rise = controllable && ctx.input.isDown('jump');
    const tv = rise ? DIVE_RISE : diveHeld ? -DIVE_SPEED : DIVE_FLOAT;
    velocity.y = damp(velocity.y, tv, DIVE_RESPONSE, dt);
    position.y += velocity.y * dt;
    const floorY = Math.max(groundY, Math.min(groundY + DIVE_FLOOR, floatFeet));
    if (position.y < floorY) {
      position.y = floorY;
      if (velocity.y < 0) velocity.y = 0;
    } else if (position.y > floatFeet) {
      position.y = floatFeet; // X + Space together: hold at the surface
      if (velocity.y > 0) velocity.y = 0;
    }
    // back near the surface and not diving: hand over to the float spring
    if (!diveHeld && position.y >= floatFeet - DIVE_HANDBACK) api.diving = false;
  }

  function updateWaterFlags() {
    const w = api.waterInfo;
    // in water: feet below the surface (hysteresis)
    const inNow = api.inWater
      ? !!w && effDepth > 0.04 && position.y < surfaceY + 0.06
      : !!w && effDepth > 0.12 && position.y < surfaceY - 0.04;
    if (inNow !== api.inWater) {
      api.inWater = inNow;
      ctx.events.emit(inNow ? 'player:enterWater' : 'player:exitWater', { type: lastWaterType });
    }
    const eyeY = position.y + P.eyeHeight + stepSmooth + dip;
    api.depth = w ? Math.max(0, surfaceY - eyeY) : 0;
    const underNow = api.headUnderwater ? !!w && eyeY < surfaceY + 0.03 : !!w && eyeY < surfaceY - 0.08;
    if (underNow !== api.headUnderwater) {
      api.headUnderwater = underNow;
      ctx.events.emit(underNow ? 'player:submerged' : 'player:surfaced', { type: lastWaterType });
    }
  }

  function applyBoundary(dt) {
    // v3: currents only far from both islands (vehicle-logic.currentsAt); between the islands they are
    // capped and never snap the swimmer back, so a capsized crossing doesn't teleport anyone.
    const isle = ctx.world?.isle2 || null;
    currentsAt(position.x, position.z, CONFIG.world.boundary, BOUNDARY_SOFT, isle, CONFIG.world.islandRadius ?? 320, cur);
    if (cur.active) {
      velocity.x += cur.dirX * CURRENT_ACCEL * cur.over * dt;
      velocity.z += cur.dirZ * CURRENT_ACCEL * cur.over * dt;
      const B = cur.clampR;
      const r = Math.hypot(position.x, position.z);
      if (B > 0 && r > B) {
        const nx = position.x / r,
          nz = position.z / r;
        position.x = nx * B;
        position.z = nz * B;
        const out = velocity.x * nx + velocity.z * nz;
        if (out > 0) {
          velocity.x -= nx * out;
          velocity.z -= nz * out;
        }
      }
      if (!boundaryWarned && cur.over > 0.12) {
        boundaryWarned = true;
        ctx.ui?.toast?.(
          B > 0 ? 'Strong currents push you back toward the island.' : 'The currents tug you toward the nearest island.',
          { icon: '🌊', kind: 'warn' }
        );
      }
    } else if (Math.hypot(position.x, position.z) < CONFIG.world.boundary - BOUNDARY_SOFT - 40) boundaryWarned = false;
  }

  // ── Footsteps + head bob phase ───────────────────────────────────────────
  function footsteps(moved, hSpeed, dt) {
    if (api.swimming) {
      // swim strokes: slower, softer rhythm
      bobWeight = damp(bobWeight, api.moving ? 0.6 : 0, 4, dt);
      if (api.moving) {
        const before = Math.floor(bobPhase / Math.PI);
        bobPhase += (moved / 1.7) * Math.PI;
        if (Math.floor(bobPhase / Math.PI) !== before && !api.headUnderwater) {
          ctx.events.emit('player:footstep', { surface: 'water', sprint: api.sprinting, swim: true });
        }
      }
      return;
    }
    const grounded = api.onGround && hSpeed > 0.3;
    bobWeight = damp(bobWeight, grounded && api.moving ? clamp(hSpeed / P.walkSpeed, 0, 1.5) : 0, 9, dt);
    if (!grounded) return;
    const stepLen = 1.2 + hSpeed * 0.18;
    const before = Math.floor(bobPhase / Math.PI);
    bobPhase += (moved / stepLen) * Math.PI;
    if (Math.floor(bobPhase / Math.PI) !== before) {
      ctx.events.emit('player:footstep', { surface: footSurface(), sprint: api.sprinting });
    }
  }

  function footSurface() {
    if (api.waterInfo && effDepth > 0.04) return 'water';
    if (onCollider) return 'rock';
    const b = ctx.world.biomeAt(position.x, position.z);
    if (b.sand > 0.5) return 'sand';
    if (b.rock > 0.45) return 'rock';
    return 'grass';
  }

  // ── Camera ───────────────────────────────────────────────────────────────
  function writeCamera(dt) {
    const cam = ctx.camera;
    const exhausted = !!ctx.stats?.exhausted;
    // landing dip spring
    if (dt > 0) {
      const acc = -dip * 90 - dipVel * 13;
      dipVel += acc * dt;
      dip = clamp(dip + dipVel * dt, -0.5, 0.2);
      stepSmooth = damp(stepSmooth, 0, 14, dt);
    }
    const sinY = Math.sin(api.yaw),
      cosY = Math.cos(api.yaw);
    let bobY = 0,
      swayX = 0,
      bobRoll = 0,
      bobPitch = 0;
    if (api.swimming) {
      // gentle stroke bob + a slow rocking roll from the waves
      bobY = Math.sin(bobPhase * 2) * 0.025 * bobWeight;
      swimRoll = damp(swimRoll, Math.sin(t * 0.9) * 0.018 + (api.headUnderwater ? Math.sin(t * 2.3) * 0.05 : 0), 3, dt);
      bobRoll = swimRoll;
      bobPitch = Math.sin(t * 1.1) * 0.006;
    } else {
      swimRoll = damp(swimRoll, 0, 3, dt);
      const sprintAmp = api.sprinting ? 1.45 : 1;
      bobY = -0.045 * sprintAmp * bobWeight * 0.5 * (1 + Math.cos(2 * bobPhase));
      swayX = Math.sin(bobPhase) * 0.028 * bobWeight;
      bobRoll = Math.sin(bobPhase) * 0.0055 * bobWeight * sprintAmp + swimRoll;
      bobPitch = Math.cos(2 * bobPhase) * 0.004 * bobWeight;
    }
    // breathing (heavier when exhausted)
    const breathRate = exhausted ? 3.4 : 1.5;
    const breathAmp = exhausted ? 0.009 : 0.0022;
    const breathe = Math.sin(t * breathRate) * breathAmp;

    eye.set(
      position.x + cosY * swayX,
      position.y + P.eyeHeight + stepSmooth + dip + bobY + (exhausted && !api.swimming ? breathe * 2 : 0),
      position.z - sinY * swayX
    );
    cam.position.copy(eye);
    cam.rotation.set(clamp(api.pitch + bobPitch + breathe, -PITCH_LIMIT, PITCH_LIMIT), api.yaw, roll + bobRoll, 'YXZ');

    // subtle FOV kick while sprinting
    const base = CONFIG.graphics.fov;
    const target = base + (api.sprinting && !api.swimming ? FOV_SPRINT_KICK : 0);
    fovCur = dt > 0 ? damp(fovCur, target, 6, dt) : target;
    if (Math.abs(fovCur - base) > 0.02) {
      if (Math.abs(cam.fov - fovCur) > 0.01) {
        cam.fov = fovCur;
        cam.updateProjectionMatrix();
      }
      fovApplied = true;
    } else restoreFov(); // exactly back to the configured FOV (no-op when we never changed it)
  }

  function restoreFov() {
    if (!fovApplied) return;
    fovApplied = false;
    fovCur = CONFIG.graphics.fov;
    ctx.camera.fov = fovCur;
    ctx.camera.updateProjectionMatrix();
  }

  // ── Death: a slow fall of the camera to the ground ───────────────────────
  function deathFall(dt) {
    const cam = ctx.camera;
    if (!deathInit) {
      deathInit = true;
      deathT = 0;
      restoreFov();
      death.y0 = cam.position.y;
      death.rx0 = cam.rotation.x;
      death.rz0 = cam.rotation.z;
      death.side = Math.sin(position.x * 12.9898 + position.z * 78.233) > 0 ? 1 : -1;
      const w = ctx.world.waterAt(position.x, position.z);
      if (w && w.depth > 0.9) {
        death.yEnd = Math.max(w.surface - 1.1, w.surface - w.depth + 0.3); // sink below the surface
        death.dur = 3.2;
      } else {
        death.yEnd = Math.max(groundY, ctx.world.heightAt(position.x, position.z)) + 0.32;
        death.dur = 1.7;
      }
      api.moving = api.sprinting = false;
      velocity.set(0, 0, 0);
    }
    deathT += dt;
    const k = clamp(deathT / death.dur, 0, 1);
    const fall = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // ease in-out cubic
    const tip = 1 - Math.pow(1 - k, 2.2); // roll leads the fall
    const settle = k >= 1 ? Math.sin((deathT - death.dur) * 0.6) * 0.004 : 0;
    cam.position.set(position.x, lerp(death.y0, death.yEnd, fall), position.z);
    cam.rotation.set(lerp(death.rx0, 0.18, fall), api.yaw, lerp(death.rz0, death.side * 1.25, tip) + settle, 'YXZ');
    eye.copy(cam.position);
  }

  return api;
}
