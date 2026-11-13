// Builder V3-C — vehicles (SPEC §11): the player's paddle raft and the fisherman's motorboat.
//
// ctx.vehicles: { current (null | vehicle record), raft, motorboat, findRaftSpot(), placeRaft(spot), board(rec),
//                 disembark(), headHome(), debugRaft(), debugCapsize(), debugMotorboat(), init(), update(dt) }
// A vehicle record: { type: 'paddle_raft'|'motorboat', name, object (THREE.Object3D), seat, seatEye, heading (yaw
// convention: forward = (-sin h, -cos h)), speed, roll, pitch, capsized }. While aboard, ctx.player.aboard === record
// (controller.setSeat) and the controller skips walking/swimming physics; this module moves the vehicle and then calls
// ctx.player.syncSeat(dt) so the camera never lags a frame behind the deck.
//
// Paddle raft: crafted (recipes 'paddle_raft', crafting.js routes the placement here), W/S paddle (needs a 'paddle'),
// A/D turn, energy drain, wave bob/roll, soft splashes per stroke, runs aground, [E] disembark near land, capsizes in
// Tempest Isle storms (ctx.weather.stormAt > 0.5) and is righted with [E] when the storm eases (< 0.3).
// Motorboat (ctx.isle2.motorboat, built + moored by isle2.js): [E] start (boat_key + one fuel_can on the first start),
// never capsizes, [E] disembark near land or the dock, [R] "Head for home" far out at sea (or automatically beyond
// 1300 m) -> cinematic -> raft:sailed { plan: 'motorboat_dock', name: "the fisherman's motorboat", day }.
// Once started, this module owns the motorboat's transform (it sets motorboat.moored = false).
// Events out: vehicle:placed {type}, vehicle:board {type}, vehicle:leave {type}, vehicle:capsized {type}, raft:sailed.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import * as V from './vehicle-logic.js';
import { makePaddleRaft, makeHandPaddle } from './vehicle-meshes.js';
import { createSailAway } from './vehicle-cine.js';

const TAU = Math.PI * 2;
const RAFT_LIMIT_MAIN = 1150; // a paddle raft can't take the open swell beyond this from the main center…
const RAFT_LIMIT_ISLE = 430; // …unless it is this close to Tempest Isle
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const MB_NAME = "the fisherman's motorboat";

export function create(ctx) {
  const VC = ctx.config?.vehicles || CONFIG.vehicles;
  const IC = ctx.config?.isle2 || CONFIG.isle2;
  const ev = ctx.events;
  const toast = (text, opts) => ctx.ui?.toast?.(text, opts);
  const play = (name, opts) => ctx.audio?.play?.(name, opts);
  const count = (id) => ctx.inventory?.count?.(id) ?? 0;
  const rand = typeof ctx.rng?.fork === 'function' ? ctx.rng.fork('vehicles') : Math.random;

  let raft = null; // the paddle raft record (one at a time)
  let mb = null; // the motorboat record (wraps ctx.isle2.motorboat)
  let mbFueled = false;
  let current = null;
  let cine = null;
  let hand = null;
  let landing = null;
  let landingAcc = 0;
  let homeOk = false;
  let engineOn = false;
  let limitWarned = false;
  let t = 0;
  const landSpot = {};
  const drift = {};
  const toastAt = {}; // key -> next allowed time (s)
  const box = new THREE.Box3();
  const boxTmp = new THREE.Box3();
  const mInv = new THREE.Matrix4();
  const mTmp = new THREE.Matrix4();

  const seaY = () => ctx.world?.SEA_LEVEL ?? 0;
  const stormAt = (x, z) => {
    const s = ctx.weather?.stormAt?.(x, z);
    return Number.isFinite(s) ? s : 0;
  };
  const controllable = () =>
    ctx.state === 'playing' && !ctx.flags.cinematic && !ctx.ui?.menuOpen && !ctx.flags.sleeping && !ctx.stats?.dead;
  function once(key, cooldown, text, opts) {
    if ((toastAt[key] ?? -1) > t) return;
    toastAt[key] = t + cooldown;
    toast(text, { key, ...opts });
  }
  function wave(x, z) {
    const w = ctx.water?.waveHeightAt;
    if (w) {
      try {
        const v = w.call(ctx.water, x, z);
        if (Number.isFinite(v)) return v;
      } catch (e) {
        /* fall back */
      }
    }
    return Math.sin(t * 1.3 + x * 0.15) * 0.05 + Math.sin(t * 0.9 + z * 0.11) * 0.04;
  }
  function surface(x, z) {
    const s = ctx.water?.surfaceAt?.(x, z);
    return Number.isFinite(s) ? s : seaY() + wave(x, z);
  }
  const hdist = (rec) => {
    const p = ctx.player?.position;
    return p ? Math.hypot(rec.object.position.x - p.x, rec.object.position.z - p.z) : Infinity;
  };
  function facing(rec) {
    const p = ctx.player?.position;
    if (!p) return 0;
    const yaw = ctx.player.yaw ?? 0;
    const dx = rec.object.position.x - p.x, dz = rec.object.position.z - p.z, d = Math.hypot(dx, dz) || 1;
    return (-Math.sin(yaw) * dx - Math.cos(yaw) * dz) / d;
  }

  // ── Floating pose (shared): bob + pitch/roll from the waves under bow/stern/port/starboard ──
  function float(rec, dt, baseY, len, width, extraPitch = 0, extraRoll = 0) {
    const o = rec.object, x = o.position.x, z = o.position.z, h = rec.heading;
    const fx = V.fwdX(h), fz = V.fwdZ(h), rx = -fz, rz = fx;
    const bow = wave(x + fx * len, z + fz * len), stern = wave(x - fx * len, z - fz * len);
    const right = wave(x + rx * width, z + rz * width), left = wave(x - rx * width, z - rz * width);
    const centre = surface(x, z);
    const y = centre + (bow + stern + right + left) * 0.125 - wave(x, z) * 0.5 + baseY;
    o.position.y = dt > 0 ? damp(o.position.y, y, 7, dt) : y;
    const pitch = Math.atan2(bow - stern, 2 * len) + extraPitch;
    const roll = Math.atan2(right - left, 2 * width) + extraRoll;
    const px = dt > 0 ? damp(o.rotation.x, pitch, 5, dt) : pitch;
    const rz2 = dt > 0 ? damp(o.rotation.z, roll, 5, dt) : roll;
    o.rotation.set(px, h, rz2, 'YXZ');
    rec.pitch = px * 0.5;
    rec.roll = rz2 * 0.7;
  }

  // ── Paddle raft ─────────────────────────────────────────────────────────
  function makeRaft() {
    const m = makePaddleRaft(rand);
    ctx.scene.add(m.group);
    return {
      type: 'paddle_raft',
      name: 'Paddle raft',
      object: m.group,
      body: m.body,
      seat: m.seat,
      seatEye: V.RAFT.seatEye,
      halfLen: V.RAFT.length / 2,
      heading: 0,
      speed: 0,
      roll: 0,
      pitch: 0,
      capsized: false,
      flip: null,
      stroke: 0,
      strokeSide: 1,
      paddling: false,
      handW: 0,
      aground: false,
    };
  }

  function findRaftSpot() {
    if (current) return { ok: false, reason: 'Not while you are on a boat.' };
    const p = ctx.player?.position;
    if (!p || !ctx.world) return { ok: false, reason: 'Building is not available right now.' };
    return V.findLaunchSpot(ctx.world, p.x, p.z, ctx.player.yaw ?? 0);
  }

  /** Put the (new) raft at a launch spot. Returns the raft record or null. */
  function placeRaft(spot) {
    if (!spot?.ok) spot = findRaftSpot();
    if (!spot?.ok) {
      toast(spot?.reason || "Build it at the water's edge.", { icon: '🪵', kind: 'warn', key: 'craft' });
      return null;
    }
    const replaced = !!raft;
    raft ??= makeRaft();
    const r = raft;
    r.capsized = false;
    r.flip = null;
    r.body.rotation.set(0, 0, 0);
    r.body.position.set(0, 0, 0);
    r.speed = 0;
    r.heading = spot.heading;
    r.object.position.set(spot.x, surface(spot.x, spot.z), spot.z);
    float(r, 0, 0, 1.4, 0.8);
    play('place', { position: r.object.position, volume: 0.9 });
    play('splash', { position: r.object.position, volume: 0.35 });
    toast(
      `${replaced ? 'You lash together a new raft (the old one is gone). ' : 'Paddle raft built! '}Board it with E.${
        count('paddle') ? '' : ' You will need a Wooden Paddle (wood 2 + rope 1) to move it.'
      }`,
      { icon: '🪵', kind: 'good', key: 'craft', duration: 6 }
    );
    ctx.ui?.hint?.(
      'paddle_raft',
      'Paddle raft: W/S paddle, A/D steer, E to get off near land. Paddling tires you. Tempest Isle is ~525 m off the north-east beach: storms out there can flip a raft!'
    );
    ev.emit('vehicle:placed', { type: 'paddle_raft' });
    return r;
  }

  function capsize(r) {
    if (!r || r.capsized) return;
    const o = r.object, x = o.position.x, z = o.position.z;
    r.capsized = true;
    r.speed = 0;
    const dir = rand() < 0.5 ? -1 : 1;
    r.flip = { t: 0, dur: 1.3, from: r.body.rotation.z, to: Math.PI * dir, y0: r.body.position.y, y1: 0.12 };
    play('splash', { position: o.position, volume: 1.1 });
    if (current === r) {
      const rx = -V.fwdZ(r.heading), rz = V.fwdX(r.heading);
      leaveVehicle();
      ctx.player?.teleport?.(x + rx * dir * 2.3, z + rz * dir * 2.3);
      ctx.ui?.flash?.('#cfe9ff', 0.6, 0.45);
      toast('A huge wave flips the raft! You are thrown into the sea.', { icon: '🌊', kind: 'bad', key: 'raft-capsize', duration: 6 });
      ctx.ui?.hint?.('raft_right', 'Your raft is upside down. Swim next to it and press E to right it once the storm eases, or swim for the shore.');
    } else if (hdist(r) < 120) {
      toast('The storm flips your empty raft over!', { icon: '⛈️', kind: 'warn', key: 'raft-capsize' });
    }
    ev.emit('vehicle:capsized', { type: r.type });
  }

  function rightRaft() {
    const r = raft;
    if (!r?.capsized || r.flip) return;
    if (!V.canRight(stormAt(r.object.position.x, r.object.position.z))) {
      toast('The waves are too wild to right it. Wait for the storm to ease.', { icon: '⛈️', kind: 'warn', key: 'raft-right' });
      return;
    }
    if (ctx.stats?.exhausted) {
      toast("You're too exhausted to heave it over. Rest a moment.", { icon: '😮‍💨', kind: 'warn', key: 'raft-right' });
      return;
    }
    ctx.stats?.drainEnergy?.(8);
    r.flip = { t: 0, dur: 1.1, from: r.body.rotation.z, to: 0, y0: r.body.position.y, y1: 0 };
    r.capsized = false;
    play('splash', { position: r.object.position, volume: 0.6 });
    toast('You heave the raft back over. Climb aboard with E.', { icon: '🪵', kind: 'good', key: 'raft-right' });
  }

  function updateRaft(dt) {
    const r = raft, o = r.object, W = ctx.world;
    const x = o.position.x, z = o.position.z;
    const storm = stormAt(x, z);
    const aboard = current === r;
    if (r.flip) {
      const f = r.flip;
      f.t += dt;
      const k = clamp01(f.t / f.dur), e = k * k * (3 - 2 * k);
      r.body.rotation.z = f.from + (f.to - f.from) * e;
      r.body.position.y = f.y0 + (f.y1 - f.y0) * e + Math.sin(k * Math.PI) * 0.55;
      if (k >= 1) r.flip = null;
    }
    const ctl = aboard && controllable();
    const inp = ctx.input;
    let thr = 0, turn = 0;
    if (ctl) {
      thr = (inp.isDown('forward') ? 1 : 0) - (inp.isDown('back') ? 1 : 0);
      turn = (inp.isDown('left') ? 1 : 0) - (inp.isDown('right') ? 1 : 0);
    }
    const C = VC.paddleRaft;
    const hasPaddle = count('paddle') > 0;
    const exhausted = !!ctx.stats?.exhausted;
    if (ctl && (thr || turn) && !hasPaddle) {
      once('raft-paddle', 6, "You need a Wooden Paddle to paddle (craft: wood 2 + rope 1). For now you just drift.", { icon: '🛶', kind: 'warn' });
    }
    if (ctl && thr && hasPaddle && exhausted) once('raft-tired', 10, 'Too tired to paddle hard: you drift slowly. Rest, eat or drink.', { icon: '😮‍💨', kind: 'warn' });
    const target = r.capsized ? 0 : V.paddleTarget(thr, C, { hasPaddle, exhausted });
    r.speed = V.approach(r.speed, target, target !== 0 ? 1.1 : 0.45, dt);
    const steer = !r.capsized && hasPaddle ? (exhausted ? 0.3 : 1) : 0.12;
    const dh = turn * C.turnRate * steer * (0.55 + 0.45 * Math.min(1, Math.abs(r.speed) / C.speed)) * dt;
    if (dh) {
      r.heading = V.wrapAngle(r.heading + dh);
      if (aboard && ctx.player) ctx.player.yaw += dh;
    }
    const paddling = ctl && hasPaddle && !r.capsized && (thr !== 0 || turn !== 0);
    if (paddling) {
      // exhausted: a weak crawl that costs nothing, so energy slowly comes back while you keep going
      if (!exhausted) ctx.stats?.drainEnergy?.(C.energyPerSec * dt * (thr ? 1 : 0.5));
      const before = Math.floor(r.stroke);
      r.stroke += dt * (exhausted ? 0.55 : 0.95);
      if (Math.floor(r.stroke) !== before) {
        r.strokeSide = -r.strokeSide;
        play('splash', { volume: 0.2, position: o.position });
      }
    }
    r.paddling = paddling;

    // motion: paddling + wind drift (much stronger in a storm)
    V.windDrift(ctx.weather?.wind, storm, drift);
    // a raft left empty in the shallows stays put unless a storm or a capsize sets it adrift
    const df = r.capsized ? 0.9 : aboard || storm > V.RIGHT_STORM ? 0.55 : 0;
    let vx = V.fwdX(r.heading) * r.speed + drift.x * df;
    let vz = V.fwdZ(r.heading) * r.speed + drift.z * df;
    // too far out on the open sea: the swell turns a little raft back
    const isle = W.isle2;
    const dMain = Math.hypot(x, z);
    const dIsle = isle ? Math.hypot(x - isle.x, z - isle.z) : Infinity;
    if (dMain > RAFT_LIMIT_MAIN && dIsle > RAFT_LIMIT_ISLE) {
      const toIsle = isle && dIsle - isle.R < dMain - (CONFIG.world.islandRadius ?? 320);
      const tx = toIsle ? isle.x - x : -x, tz = toIsle ? isle.z - z : -z, tl = Math.hypot(tx, tz) || 1;
      vx += (tx / tl) * 1.6;
      vz += (tz / tl) * 1.6;
      r.speed *= 1 - Math.min(1, dt * 0.8);
      if (aboard && !limitWarned) {
        limitWarned = true;
        toast('The swell out here is far too big for a paddle raft. Turn back toward land.', { icon: '🌊', kind: 'warn', key: 'raft-limit' });
      }
    } else if (dMain < RAFT_LIMIT_MAIN - 60 || dIsle < RAFT_LIMIT_ISLE - 60) limitWarned = false;
    // run aground: the ground ahead (in the direction of motion) rises above the water
    r.aground = false;
    const mv = Math.hypot(vx, vz);
    if (mv > 0.02) {
      const look = r.halfLen + 0.35;
      const ax = x + (vx / mv) * look, az = z + (vz / mv) * look;
      if (V.isAground(W.heightAt(ax, az), seaY())) {
        r.aground = true;
        if (V.fwdX(r.heading) * vx + V.fwdZ(r.heading) * vz > 0 === r.speed > 0) r.speed *= 0.2;
        vx = vz = 0;
        if (ctl && thr) once('raft-aground', 4, 'You run aground. Back off (S) or get off here (E).', { icon: '🪨', kind: 'info' });
      }
    }
    o.position.x += vx * dt;
    o.position.z += vz * dt;
    float(r, dt, 0, 1.4, 0.8);
    if (!r.capsized && !r.flip && storm > V.CAPSIZE_STORM && rand() < V.capsizeChance(storm, dt, IC.capsizePerSec)) capsize(r);
  }

  function updateHand(dt) {
    const show = !!raft && current === raft && !raft.capsized && count('paddle') > 0 && !ctx.flags.cinematic;
    if (!hand) {
      if (!show) return;
      hand = makeHandPaddle();
      ctx.camera.add(hand);
    }
    hand.visible = show;
    if (!show) return;
    const r = raft;
    r.handW = damp(r.handW, r.paddling ? 1 : 0, 4, dt);
    const ph = (r.stroke % 1) * TAU, side = r.strokeSide, w = r.handW;
    const sw = Math.sin(ph) * w;
    hand.position.set(0.3 * side, -0.66 + Math.max(0, -Math.cos(ph)) * 0.05 * w, -0.78 + sw * 0.12);
    hand.rotation.set(-0.55 + sw * 0.45, 0, (0.38 + sw * 0.1) * side, 'XYZ');
  }

  // ── Motorboat (ctx.isle2.motorboat) ────────────────────────────────────
  function syncMotorboat() {
    const src = ctx.isle2?.motorboat;
    if (!src || !src.object) {
      if (mb && current === mb) leaveVehicle();
      mb = null;
      return null;
    }
    if (!mb || mb.src !== src) {
      mb = {
        type: 'motorboat',
        name: MB_NAME,
        src,
        object: src.object,
        seat: src.seat || null,
        seatEye: 1.05,
        halfLen: 2.6,
        beam: 1.8,
        heading: Number.isFinite(src.heading) ? src.heading : src.object.rotation.y,
        speed: 0,
        roll: 0,
        pitch: 0,
        capsized: false,
        controlled: false,
        baseY: 0,
        sized: false,
      };
    }
    return mb;
  }

  /** Local bounding box -> boat size and (unless isle2 gave one) a seat Object3D aft of amidships. */
  function sizeBoat(rec) {
    if (rec.sized) return;
    rec.sized = true;
    const o = rec.object;
    o.updateWorldMatrix(true, true);
    mInv.copy(o.matrixWorld).invert();
    box.makeEmpty();
    o.traverse((c) => {
      if (!c.isMesh || !c.geometry || c.isInstancedMesh) return;
      if (!c.geometry.boundingBox) c.geometry.computeBoundingBox();
      boxTmp.copy(c.geometry.boundingBox).applyMatrix4(mTmp.multiplyMatrices(mInv, c.matrixWorld));
      box.union(boxTmp);
    });
    if (box.isEmpty()) box.set(new THREE.Vector3(-0.9, -0.4, -2.6), new THREE.Vector3(0.9, 0.9, 2.6));
    rec.halfLen = Math.max(1.4, (box.max.z - box.min.z) / 2);
    rec.beam = Math.max(1, box.max.x - box.min.x);
    if (!rec.seat) {
      const seat = new THREE.Object3D();
      if (o.name === 'isle2-motorboat') {
        seat.position.set(0.32, 1.12, 0.78); // isle2-models.js: at the helm, just behind the console + windscreen
      } else {
        const deck = Math.min(box.max.y, box.min.y + Math.max(0.35, (box.max.y - box.min.y) * 0.4));
        seat.position.set((box.min.x + box.max.x) / 2, deck + 0.95, box.min.z + (box.max.z - box.min.z) * 0.68);
      }
      o.add(seat);
      rec.seat = seat;
    }
  }

  function startMotorboat() {
    const m = syncMotorboat();
    if (!m || current || cine) return;
    if (count('boat_key') < 1) {
      toast("It needs a key… maybe in the fisherman's hut?", { icon: '🔑', kind: 'warn', key: 'mb-key' });
      return;
    }
    if (!mbFueled) {
      if (count('fuel_can') < 1) {
        toast('The key turns but the tank is bone dry. It needs a fuel can.', { icon: '⛽', kind: 'warn', key: 'mb-key', duration: 5 });
        return;
      }
      ctx.inventory?.remove?.('fuel_can', 1);
      mbFueled = true;
      toast('You pour the jerrycan into the tank. The engine coughs… then roars!', { icon: '⛽', kind: 'good', key: 'mb-key', duration: 5 });
    }
    sizeBoat(m);
    if (!m.controlled) {
      m.controlled = true;
      const o = m.object;
      o.rotation.order = 'YXZ';
      m.heading = Number.isFinite(m.src.heading) ? m.src.heading : o.rotation.y;
      const off = o.position.y - surface(o.position.x, o.position.z);
      m.baseY = Math.max(-0.6, Math.min(0.4, Number.isFinite(off) ? off : 0));
    }
    m.src.moored = false;
    board(m);
    play('ui_click', { volume: 0.5 });
    ctx.ui?.hint?.(
      'motorboat',
      "The fisherman's motorboat: W/S throttle, A/D steer, E to get off near land or the dock. Far out at sea, press R to head for home."
    );
  }

  function updateMotorboat(dt) {
    const m = mb, o = m.object, W = ctx.world;
    const aboard = current === m;
    if (!aboard && !m.controlled) return; // still moored: isle2.js animates it
    const x = o.position.x, z = o.position.z;
    const ctl = aboard && controllable();
    const inp = ctx.input;
    let thr = 0, turn = 0;
    if (ctl) {
      thr = (inp.isDown('forward') ? 1 : 0) - (inp.isDown('back') ? 1 : 0);
      turn = (inp.isDown('left') ? 1 : 0) - (inp.isDown('right') ? 1 : 0);
    }
    const C = VC.motorboat;
    const target = thr > 0 ? C.speed : thr < 0 ? -C.reverse : 0;
    m.speed = V.approach(m.speed, target, thr ? 0.7 : 0.45, dt);
    const sf = Math.min(1, Math.abs(m.speed) / 3);
    const dh = turn * C.turnRate * (0.25 + 0.75 * sf) * dt;
    if (dh) {
      m.heading = V.wrapAngle(m.heading + dh);
      if (aboard && ctx.player) ctx.player.yaw += dh;
    }
    let vx = V.fwdX(m.heading) * m.speed, vz = V.fwdZ(m.heading) * m.speed;
    const mv = Math.hypot(vx, vz);
    if (mv > 0.02) {
      const look = m.halfLen + 0.6;
      const ax = x + (vx / mv) * look, az = z + (vz / mv) * look;
      const dock = W.landmarks?.isle2Dock;
      const dA = V.dockDistance(dock, ax, az);
      const hitDock = dA < 1.3 && dA < V.dockDistance(dock, x, z);
      if (hitDock || V.isAground(W.heightAt(ax, az), seaY())) {
        if (ctl && thr) {
          once('mb-aground', 4, hitDock ? 'You bump into the dock.' : 'You run aground. Back off (S) or get off here (E).', { icon: '🪨', kind: 'info' });
        }
        if (Math.abs(m.speed) > 3) play('place', { position: o.position, volume: 0.7 });
        m.speed = 0;
        vx = vz = 0;
      }
    }
    o.position.x += vx * dt;
    o.position.z += vz * dt;
    float(m, dt, m.baseY, m.halfLen * 0.7, Math.max(0.6, m.beam * 0.45), 0.06 * (m.speed / C.speed), -turn * 0.05 * sf);
    if (m.src.position && m.src.position !== o.position) m.src.position.copy(o.position);
    m.src.heading = m.heading;
    if (aboard) {
      const v = 0.35 + 0.65 * Math.min(1, Math.abs(m.speed) / C.speed);
      ctx.audio?.setLoop?.('engine', v, o.position);
      engineOn = true;
      homeOk = V.canHeadHome(W.coastDistance?.(o.position.x, o.position.z));
      if (V.openSeaReached(o.position.x, o.position.z, W.isle2)) headHome(true);
    } else if (engineOn) {
      ctx.audio?.setLoop?.('engine', 0);
      engineOn = false;
    }
  }

  function headHome(auto = false) {
    if (cine || !mb || current !== mb) return;
    const m = mb, o = m.object, isle = ctx.world.isle2;
    const x = o.position.x, z = o.position.z;
    let dx = 0, dz = 0;
    const dm = Math.hypot(x, z) || 1;
    dx += x / dm;
    dz += z / dm;
    if (isle) {
      const di = Math.hypot(x - isle.x, z - isle.z) || 1;
      dx += (x - isle.x) / di;
      dz += (z - isle.z) / di;
    }
    const target = Math.atan2(-dx, -dz);
    if (hand) hand.visible = false;
    ctx.ui?.setPrompt?.(null);
    cine = createSailAway(ctx, {
      object: o,
      heading: m.heading,
      target,
      y: o.position.y,
      vmax: 16,
      speed0: Math.max(2, m.speed),
      engine: true,
      duration: 10,
      subtitles: [
        [0.8, auto ? 'Open sea on every side. Time to go home.' : 'You open the throttle and point the bow at the horizon.', 4],
        [5, 'Tempest Isle fades into the haze behind you…', 3.8],
        [8.4, 'Home is that way.', 3],
      ],
      onDone: () => ev.emit('raft:sailed', { plan: 'motorboat_dock', name: MB_NAME, day: ctx.time?.day ?? 1 }),
    });
  }

  // ── Boarding / leaving ─────────────────────────────────────────────────
  function board(rec) {
    if (!rec || current || cine) return;
    const pl = ctx.player;
    if (!pl?.setSeat) return;
    if (rec.type === 'paddle_raft') {
      if (rec.capsized || rec.flip) return;
      if (!count('paddle')) toast('No paddle: you can only drift. Craft a Wooden Paddle (wood 2 + rope 1).', { icon: '🛶', kind: 'warn', key: 'raft-paddle' });
      play('splash', { position: rec.object.position, volume: 0.3 });
    }
    current = rec;
    pl.setSeat(rec.seat, rec);
    pl.yaw = rec.heading;
    pl.pitch = -0.12;
    landing = null;
    landingAcc = 1;
    pl.syncSeat?.(0);
    ev.emit('vehicle:board', { type: rec.type });
  }

  function leaveVehicle() {
    const rec = current;
    if (!rec) return null;
    current = null;
    homeOk = false;
    landing = null;
    if (ctx.player?.aboard) ctx.player.setSeat(null);
    if (rec.type === 'motorboat' && engineOn) {
      ctx.audio?.setLoop?.('engine', 0);
      engineOn = false;
    }
    if (hand) hand.visible = false;
    ev.emit('vehicle:leave', { type: rec.type });
    return rec;
  }

  function findLanding(rec) {
    const o = rec.object, x = o.position.x, z = o.position.z;
    if (rec.type === 'motorboat') {
      const dock = ctx.world.landmarks?.isle2Dock;
      if (dock && V.dockDistance(dock, x, z) < rec.beam / 2 + 4) return V.dockLanding(dock);
    }
    // dry land within ~3 m of the hull; in shallows (< 1 m deep, e.g. aground on a flat beach) you wade ashore
    const near = V.findDisembarkSpot(ctx.world, x, z, rec.halfLen + 3, landSpot);
    if (near || ctx.world.heightAt(x, z) < seaY() - 1) return near;
    return V.findDisembarkSpot(ctx.world, x, z, 12, landSpot);
  }

  function disembark() {
    const rec = current;
    if (!rec) return;
    const spot = findLanding(rec);
    if (!spot) {
      toast('Get closer to the shore to climb off.', { icon: '🏝️', kind: 'info', key: 'disembark' });
      return;
    }
    const sx = spot.x, sz = spot.z;
    leaveVehicle();
    rec.speed = 0;
    ctx.player?.teleport?.(sx, sz);
  }

  // ── Interaction provider (one for every vehicle action) ────────────────
  function provider() {
    if (cine || ctx.state !== 'playing') return null;
    if (current) {
      const label = landing ? 'Disembark' : '';
      const secondary = current === mb && homeOk ? { label: 'Head for home', onUse: () => headHome(false) } : null;
      if (!label && !secondary) return null;
      return { label, onUse: disembark, secondary, score: 10 };
    }
    let best = null;
    if (raft && !raft.flip) {
      const d = Math.max(0, hdist(raft) - 0.6);
      if (d <= VC.boardRadius) {
        const score = 2.4 + facing(raft) * 0.8 - d * 0.12;
        if (raft.capsized) {
          const ok = V.canRight(stormAt(raft.object.position.x, raft.object.position.z));
          best = { label: ok ? 'Right the raft' : 'Right the raft (wait for the storm to ease)', onUse: rightRaft, score };
        } else best = { label: 'Board the raft', onUse: () => board(raft), score };
      }
    }
    const m = mb;
    if (m) {
      const d = Math.max(0, hdist(m) - Math.max(0, m.halfLen - 1));
      if (d <= VC.boardRadius) {
        const score = 2.4 + facing(m) * 0.8 - d * 0.12;
        if (!best || score > best.score) best = { label: m.controlled ? 'Board the motorboat' : 'Start the motorboat', onUse: startMotorboat, score };
      }
    }
    return best;
  }

  // ── Debug ──────────────────────────────────────────────────────────────
  function debugRaft() {
    const W = ctx.world, LB = W.landmarks?.launchBeach, isle = W.isle2;
    if (!LB || !isle || !ctx.player) return null;
    const yaw = V.headingTo(LB.x, LB.z, isle.x, isle.z);
    let px = LB.x, pz = LB.z;
    for (let s = 0; s < 80; s += 0.5) {
      const x = LB.x + V.fwdX(yaw) * s, z = LB.z + V.fwdZ(yaw) * s;
      if (W.waterAt(x, z)) break;
      px = x;
      pz = z;
    }
    if (current) leaveVehicle();
    ctx.player.teleport(px, pz, yaw);
    if (!count('paddle')) ctx.inventory?.add?.('paddle', 1, { silent: true });
    return placeRaft(findRaftSpot());
  }
  function debugMotorboat() {
    const m = syncMotorboat();
    if (!m || !ctx.player) return null;
    if (!count('boat_key')) ctx.inventory?.add?.('boat_key', 1, { silent: true });
    if (!mbFueled && !count('fuel_can')) ctx.inventory?.add?.('fuel_can', 1, { silent: true });
    const L = ctx.world.landmarks?.isle2Dock ? V.dockLanding(ctx.world.landmarks.isle2Dock) : null;
    if (L) ctx.player.teleport(L.x, L.z);
    return m;
  }

  const api = {
    get current() {
      return current;
    },
    get raft() {
      return raft;
    },
    get motorboat() {
      return mb;
    },
    get fueled() {
      return mbFueled;
    },
    /** True while [R] "Head for home" is offered (HUD vehicle panel). */
    get canHeadHome() {
      return homeOk;
    },
    /** True while [E] "Disembark" is offered. */
    get canDisembark() {
      return !!landing;
    },
    findRaftSpot,
    placeRaft,
    board,
    disembark,
    headHome: () => headHome(false),
    debugRaft,
    debugMotorboat,
    debugCapsize: () => capsize(raft),
    init() {
      ctx.interact?.addProvider?.(provider);
    },
    update(dt) {
      if (ctx.state !== 'playing') {
        if (engineOn && !cine) {
          ctx.audio?.setLoop?.('engine', 0);
          engineOn = false;
        }
        return;
      }
      t += dt;
      if (cine) {
        cine.update(dt);
        if (cine.done) cine = null;
        return;
      }
      // stood up by something else (teleport, death fall…)
      if (current && ctx.player && ctx.player.aboard !== current) leaveVehicle();
      syncMotorboat();
      if (raft) updateRaft(dt);
      if (mb) updateMotorboat(dt);
      if (cine) return; // headHome() just started
      if (current) {
        landingAcc += dt;
        if (landingAcc >= 0.25) {
          landingAcc = 0;
          landing = findLanding(current);
        }
        ctx.player?.syncSeat?.(dt);
      }
      updateHand(dt);
    },
  };
  return api;
}
