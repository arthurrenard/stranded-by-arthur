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
// Events out: vehicle:placed {type, vid, x, z, heading}, vehicle:board {type}, vehicle:leave {type}, vehicle:capsized {type},
//             raft:sailed; v5 (online only): vehicle:pose {vid, x, z, heading, roll, cap}; vehicle:seat {vid, seat, playerId}
//             and the join-time vehicle:placed re-announce go straight out through ctx.net.relay (not the bus).
// v5 (V5-B, SPEC §13) co-op: every paddle raft has 2 seats (seat 0 paddles, seat 1 rides along with free look). Rafts
// placed by other players are mirrored (remotes, keyed by vid "<netId>:raft") and boardable. The seat-0 occupant (else
// the raft's owner) simulates a raft and broadcasts vehicle:pose at ~10 Hz; everyone else interpolates it
// (CONFIG.net.interpolationMs behind). A capsize (simulator side) throws everyone off (cap flag in the pose).
// net.js calls applyRemote(name, payload, from). Offline everything is exactly as before (one raft, you paddle).
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import * as V from './vehicle-logic.js';
import * as CO from './vehicle-coop.js';
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
  // v5 co-op
  const remotes = new Map(); // vid -> raft record placed by another player
  const allRafts = []; // own raft (if any) + remotes, for the per-frame loops (no iterator allocation)
  let mySeat = -1; // our seat index on `current` (rafts), else -1
  const sample = { x: 0, z: 0, heading: 0, roll: 0, cap: 0 };
  const poseOut = { vid: '', x: 0, z: 0, heading: 0, roll: 0, cap: 0 };
  const online = () => !!ctx.net?.connected && !!ctx.net.id;
  const ownVid = () => `${ctx.net?.id || 'local'}:raft`;
  const wireVid = (r) => (r.own ? ownVid() : r.vid);
  const nowSec = () => ctx.net?.now?.() ?? (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000; // net.now: tests
  // ~2.5 pose intervals at 10 Hz, so ordinary network jitter never runs the sampler dry (the passenger's camera rides it)
  const interpSec = () => Math.max(CONFIG.net?.interpolationMs ?? 120, 250) / 1000;
  const toWire = (who) => (who === CO.ME ? ctx.net?.id ?? null : who);
  const fromWire = (id) => (id != null && id === ctx.net?.id ? CO.ME : id);
  const nameOfPlayer = (id) => ctx.net?.players?.get?.(id)?.name || 'Your friend';
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
  function makeRaft(own = true, vid = null, owner = CO.ME) {
    const m = makePaddleRaft(rand);
    ctx.scene.add(m.group);
    const r = {
      type: 'paddle_raft',
      name: 'Paddle raft',
      object: m.group,
      body: m.body,
      seat: m.seat,
      seat2: m.seat2,
      // v5 co-op
      own,
      vid,
      owner,
      seats: CO.makeSeats(),
      poses: CO.createPoseBuffer(6),
      simMe: true,
      sendAcc: 0,
      sent: { x: NaN, z: NaN, heading: NaN, cap: -1 },
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
    allRafts.push(r);
    return r;
  }
  function disposeRaft(r) {
    const i = allRafts.indexOf(r);
    if (i >= 0) allRafts.splice(i, 1);
    if (r.vid) remotes.delete(r.vid);
    ctx.scene?.remove?.(r.object);
    r.object.traverse?.((o) => o.isInstancedMesh && o.dispose?.());
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
    if (raft && raft.seats.some((x) => x != null && x !== CO.ME)) {
      toast('Someone is aboard your raft: wait until they get off.', { icon: '🪵', kind: 'warn', key: 'craft' });
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
    r.poses.clear();
    ev.emit('vehicle:placed', { type: 'paddle_raft', vid: ownVid(), x: r.object.position.x, z: r.object.position.z, heading: r.heading });
    return r;
  }

  function capsize(r) {
    if (!r || r.capsized) return;
    const o = r.object, x = o.position.x, z = o.position.z;
    r.capsized = true;
    r.speed = 0;
    const dir = rand() < 0.5 ? -1 : 1;
    r.flip = { t: 0, dur: 1.3, from: r.body.rotation.z, to: Math.PI * dir, y0: r.body.position.y, y1: 0.12 };
    r.sendAcc = 1e9; // co-op: tell the others at once (they are thrown off too)
    play('splash', { position: o.position, volume: 1.1 });
    if (current === r) {
      const rx = -V.fwdZ(r.heading), rz = V.fwdX(r.heading);
      leaveVehicle();
      ctx.player?.teleport?.(x + rx * dir * 2.3, z + rz * dir * 2.3);
      ctx.ui?.flash?.('#cfe9ff', 0.6, 0.45);
      toast(r.seats.some((x) => x != null) ? 'A huge wave flips the raft! You are both thrown into the sea.' : 'A huge wave flips the raft! You are thrown into the sea.', {
        icon: '🌊',
        kind: 'bad',
        key: 'raft-capsize',
        duration: 6,
      });
      ctx.ui?.hint?.('raft_right', 'Your raft is upside down. Swim next to it and press E to right it once the storm eases, or swim for the shore.');
    } else if (hdist(r) < 120) {
      toast('The storm flips your empty raft over!', { icon: '⛈️', kind: 'warn', key: 'raft-capsize' });
    }
    ev.emit('vehicle:capsized', { type: r.type });
  }

  function rightRaft(r = raft) {
    if (!r?.capsized || r.flip) return;
    if (!r.simMe) {
      toast(`${nameOfPlayer(r.owner)} has to right their raft.`, { icon: '🪵', kind: 'info', key: 'raft-right' });
      return;
    }
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

  function updateFlip(r, dt) {
    const f = r.flip;
    if (!f) return;
    f.t += dt;
    const k = clamp01(f.t / f.dur), e = k * k * (3 - 2 * k);
    r.body.rotation.z = f.from + (f.to - f.from) * e;
    r.body.position.y = f.y0 + (f.y1 - f.y0) * e + Math.sin(k * Math.PI) * 0.55;
    if (k >= 1) r.flip = null;
  }

  function updateRaft(dt, r = raft) {
    const o = r.object, W = ctx.world;
    const x = o.position.x, z = o.position.z;
    const storm = stormAt(x, z);
    const aboard = current === r;
    updateFlip(r, dt);
    const ctl = aboard && mySeat === 0 && controllable();
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
    const df = r.capsized ? 0.9 : aboard || r.seats[0] != null || r.seats[1] != null || storm > V.RIGHT_STORM ? 0.55 : 0;
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

  // ── v5 co-op: who simulates, interpolation, pose broadcast ─────────────
  function stepRaft(r, dt) {
    const sim = CO.simulatorOf(r.seats, r.own ? CO.ME : r.owner) === CO.ME;
    if (sim !== r.simMe) {
      r.simMe = sim;
      if (sim) r.speed = 0; // taking over from the interpolated pose
      else seedPoses(r);
    }
    if (sim) {
      updateRaft(dt, r);
      if (online()) sendPose(r, dt);
    } else updateRemote(r, dt);
  }
  /** Start a fresh interpolation from where the raft is now (a new simulator takes over). */
  function seedPoses(r) {
    r.poses.clear();
    r.poses.push(nowSec() - 1, r.object.position.x, r.object.position.z, r.heading, 0, r.capsized ? 1 : 0);
  }
  function sendPose(r, dt) {
    r.sendAcc += dt;
    const o = r.object.position, s = r.sent, cap = r.capsized ? 1 : 0;
    const moved = Math.abs(o.x - s.x) > 0.02 || Math.abs(o.z - s.z) > 0.02 || Math.abs(V.wrapAngle(r.heading - s.heading)) > 0.005 || cap !== s.cap || !(s.x === s.x);
    if (!CO.poseDue(r.sendAcc, moved, 10)) return;
    r.sendAcc = 0;
    s.x = o.x;
    s.z = o.z;
    s.heading = r.heading;
    s.cap = cap;
    poseOut.vid = wireVid(r);
    poseOut.x = Math.round(o.x * 100) / 100;
    poseOut.z = Math.round(o.z * 100) / 100;
    poseOut.heading = Math.round(V.wrapAngle(r.heading) * 1000) / 1000;
    poseOut.roll = Math.round((r.object.rotation.z || 0) * 1000) / 1000;
    poseOut.cap = cap;
    ev.emit('vehicle:pose', poseOut);
  }
  function updateRemote(r, dt) {
    updateFlip(r, dt);
    if (!r.poses.sample(nowSec() - interpSec(), sample)) return;
    const o = r.object;
    const dh = V.wrapAngle(sample.heading - r.heading);
    o.position.x = sample.x;
    o.position.z = sample.z;
    r.heading = sample.heading;
    if (current === r && dh && ctx.player) ctx.player.yaw += dh; // the view turns with the deck
    r.speed = 0;
    float(r, dt, 0, 1.4, 0.8);
    const cap = !!sample.cap;
    if (cap !== r.capsized) {
      r.capsized = cap;
      const dir = (sample.roll || 0) < 0 ? -1 : 1;
      r.flip = { t: 0, dur: cap ? 1.3 : 1.1, from: r.body.rotation.z, to: cap ? Math.PI * dir : 0, y0: r.body.position.y, y1: cap ? 0.12 : 0 };
      if (cap) {
        play('splash', { position: o.position, volume: 1.1 });
        if (current === r) throwOff(r, dir);
      }
    }
  }
  function throwOff(r, dir) {
    const x = r.object.position.x, z = r.object.position.z;
    const rx = -V.fwdZ(r.heading), rz = V.fwdX(r.heading);
    leaveVehicle();
    ctx.player?.teleport?.(x + rx * dir * 2.3, z + rz * dir * 2.3);
    ctx.ui?.flash?.('#cfe9ff', 0.6, 0.45);
    toast('A huge wave flips the raft! You are both thrown into the sea.', { icon: '🌊', kind: 'bad', key: 'raft-capsize', duration: 6 });
  }

  // ── v5 co-op: seats ────────────────────────────────────────────────────
  const seatObj = (rec, i) => (i === 1 && rec.seat2 ? rec.seat2 : rec.seat);
  function announceSeat(rec, seat, who) {
    if (!online() || !rec.seats) return;
    // straight to the relay: this also runs while net.js applies a remote seat claim (its loop guard would drop a bus emit)
    ctx.net?.relay?.('vehicle:seat', { vid: wireVid(rec), seat, playerId: who == null ? null : toWire(who) });
  }
  /** Move ourselves to another seat of the raft we are on. */
  function switchSeat(to) {
    const rec = current;
    if (!rec?.seats || mySeat < 0 || mySeat === to || rec.seats[to] != null) return false;
    rec.seats[mySeat] = null;
    rec.seats[to] = CO.ME;
    mySeat = to;
    ctx.player?.setSeat?.(seatObj(rec, to), rec);
    announceSeat(rec, to, CO.ME);
    if (to === 0 && !count('paddle')) toast('No paddle: you can only drift. Craft a Wooden Paddle (wood 2 + rope 1).', { icon: '🛶', kind: 'warn', key: 'raft-paddle' });
    return true;
  }
  /** A raft record by wire vid ('<netId>:raft'); `create` mirrors an unknown remote raft. */
  function raftByVid(vid, from, create) {
    if (typeof vid !== 'string') return null;
    if (vid === ownVid()) return raft;
    let r = remotes.get(vid);
    if (!r && create && ctx.scene) {
      r = makeRaft(false, vid, from ?? null);
      r.simMe = false;
      remotes.set(vid, r);
    }
    return r || null;
  }
  function placeRemote(r, x, z, heading) {
    if (r.own) return;
    r.capsized = false;
    r.flip = null;
    r.body.rotation.set(0, 0, 0);
    r.body.position.set(0, 0, 0);
    r.heading = heading;
    r.object.position.set(x, surface(x, z), z);
    r.object.visible = true;
    float(r, 0, 0, 1.4, 0.8);
    r.poses.clear();
    r.poses.push(nowSec() - 1, x, z, heading, 0, 0);
  }
  /** net.js: a relayed vehicle:* event from player `from`. */
  function applyRemote(name, p, from) {
    if (!p || typeof p !== 'object' || from == null) return false;
    if (name === 'vehicle:placed') {
      if ((p.type ?? 'paddle_raft') !== 'paddle_raft' || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
      const r = raftByVid(p.vid, from, true);
      if (!r || r.own) return false;
      if (current === r) return true; // re-announce while we ride it: keep the live pose
      placeRemote(r, p.x, p.z, Number.isFinite(p.heading) ? p.heading : 0);
      return true;
    }
    if (name === 'vehicle:pose') {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.heading)) return false;
      const r = raftByVid(p.vid, from, true);
      if (!r) return false;
      if (r.simMe) return false; // we are authoritative for it right now
      if (r.poses.length === 0) placeRemote(r, p.x, p.z, p.heading);
      r.poses.push(nowSec(), p.x, p.z, p.heading, Number.isFinite(p.roll) ? p.roll : 0, p.cap ? 1 : 0);
      return true;
    }
    if (name === 'vehicle:seat') {
      if (!(p.seat === 0 || p.seat === 1)) return false;
      // a seat can arrive before the owner's vehicle:placed (different senders): mirror it hidden until placed
      const known = typeof p.vid === 'string' && (p.vid === ownVid() || remotes.has(p.vid));
      const r = raftByVid(p.vid, String(p.vid).split(':')[0] || from, p.playerId != null);
      if (!r) return false;
      if (!known && !r.own) r.object.visible = false;
      const res = CO.applySeatClaim(r.seats, p.seat, from, p.playerId == null ? null : from, ctx.net?.id);
      if (res === 'kept') announceSeat(r, p.seat, CO.ME);
      else if (res === 'yield' && current === r) {
        mySeat = -1;
        const other = CO.freeSeat(r.seats);
        if (other >= 0) {
          r.seats[other] = CO.ME;
          mySeat = other;
          ctx.player?.setSeat?.(seatObj(r, other), r);
          announceSeat(r, other, CO.ME);
        } else {
          const spot = findLanding(r);
          leaveVehicle();
          if (spot) ctx.player?.teleport?.(spot.x, spot.z);
          toast('The raft is full.', { icon: '🛶', kind: 'warn', key: 'raft-full' });
        }
      }
      return true;
    }
    return false;
  }
  /** v5 (net.js): feet position of remote player `id` if they sit on one of our rafts (their avatar is drawn there,
   *  not at their own lagged copy). Writes `out` and returns true on a hit. */
  function seatFeet(id, out) {
    for (let i = 0; i < allRafts.length; i++) {
      const r = allRafts[i], k = r.seats.indexOf(id);
      if (k < 0 || !r.object.visible) continue;
      const so = seatObj(r, k);
      so.updateWorldMatrix(true, false);
      out.setFromMatrixPosition(so.matrixWorld);
      out.y -= r.seatEye ?? V.RAFT.seatEye;
      return true;
    }
    return false;
  }
  /** Tell (new) players about our raft and the seats we hold. */
  function announce() {
    if (!online()) return;
    const r = raft;
    if (r) {
      // straight to the relay (not the bus: the HUD would log "Built a paddle raft" again)
      ctx.net?.relay?.('vehicle:placed', { type: 'paddle_raft', vid: ownVid(), x: r.object.position.x, z: r.object.position.z, heading: r.heading });
      r.sendAcc = 1e9;
      r.sent.cap = -1;
    }
    if (current?.seats && mySeat >= 0) announceSeat(current, mySeat, CO.ME);
  }
  function onPlayerLeft(m) {
    const id = m?.id;
    if (id == null) return;
    for (let i = allRafts.length - 1; i >= 0; i--) {
      const r = allRafts[i];
      CO.releaseSeats(r.seats, id);
      if (r.own || r.owner !== id) continue;
      if (current === r) {
        r.owner = CO.ME; // we are riding it: it is ours now
        toast(`${m.name || nameOfPlayer(id)} left: the raft is yours now.`, { icon: '🛶', kind: 'info', key: 'raft-adopt' });
      } else disposeRaft(r);
    }
  }
  function onDisconnected() {
    for (let i = allRafts.length - 1; i >= 0; i--) {
      const r = allRafts[i];
      if (r.own) {
        CO.clearRemote(r.seats);
        continue;
      }
      if (current === r) {
        if (r.owner !== CO.ME) {
          // keep riding: it becomes a local raft until it is left
          r.owner = CO.ME;
        }
        CO.clearRemote(r.seats);
      } else disposeRaft(r);
    }
  }

  function updateHand(dt) {
    const show = !!current && current.type === 'paddle_raft' && mySeat === 0 && !current.capsized && count('paddle') > 0 && !ctx.flags.cinematic;
    if (!hand) {
      if (!show) return;
      hand = makeHandPaddle();
      ctx.camera.add(hand);
    }
    hand.visible = show;
    if (!show) return;
    const r = current;
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
    let seat = 0;
    if (rec.type === 'paddle_raft') {
      if (rec.capsized || rec.flip) return;
      seat = rec.seats ? CO.freeSeat(rec.seats) : 0;
      if (seat < 0) {
        toast('The raft is full.', { icon: '🛶', kind: 'warn', key: 'raft-full' });
        return;
      }
      if (seat === 0 && !count('paddle')) toast('No paddle: you can only drift. Craft a Wooden Paddle (wood 2 + rope 1).', { icon: '🛶', kind: 'warn', key: 'raft-paddle' });
      if (seat === 1) toast(`You climb aboard as a passenger: ${nameOfPlayer(rec.seats[0])} paddles. Look around freely, E to get off near land.`, { icon: '🛶', kind: 'info', key: 'raft-passenger' });
      play('splash', { position: rec.object.position, volume: 0.3 });
      if (rec.seats) rec.seats[seat] = CO.ME;
    }
    current = rec;
    mySeat = rec.seats ? seat : -1;
    pl.setSeat(seatObj(rec, seat), rec);
    pl.yaw = rec.heading;
    pl.pitch = -0.12;
    landing = null;
    landingAcc = 1;
    pl.syncSeat?.(0);
    if (rec.seats) announceSeat(rec, seat, CO.ME);
    ev.emit('vehicle:board', { type: rec.type });
  }

  function leaveVehicle() {
    const rec = current;
    if (!rec) return null;
    current = null;
    homeOk = false;
    landing = null;
    if (rec.seats && mySeat >= 0) {
      if (rec.seats[mySeat] === CO.ME) rec.seats[mySeat] = null;
      announceSeat(rec, mySeat, null);
    }
    mySeat = -1;
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
      let secondary = current === mb && homeOk ? { label: 'Head for home', onUse: () => headHome(false) } : null;
      if (!secondary && mySeat === 1 && current.seats?.[0] == null && !current.capsized) secondary = takePaddle;
      if (!label && !secondary) return null;
      return { label, onUse: disembark, secondary, score: 10 };
    }
    let best = null;
    for (let i = 0; i < allRafts.length; i++) {
      const r = allRafts[i];
      if (r.flip || !r.object.visible) continue;
      const d = Math.max(0, hdist(r) - 0.6);
      if (d > VC.boardRadius) continue;
      const score = 2.4 + facing(r) * 0.8 - d * 0.12;
      if (best && score <= best.score) continue;
      if (r.capsized) {
        const ok = V.canRight(stormAt(r.object.position.x, r.object.position.z));
        best = { label: ok ? 'Right the raft' : 'Right the raft (wait for the storm to ease)', onUse: () => rightRaft(r), score };
      } else if (CO.freeSeat(r.seats) < 0) best = { label: 'The raft is full', onUse: () => toast('The raft is full.', { icon: '🛶', kind: 'warn', key: 'raft-full' }), score };
      else best = { label: 'Board the raft', onUse: () => board(r), score };
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

  const takePaddle = { label: 'Take the paddle', onUse: () => switchSeat(0) };

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
    /** v5: rafts placed by other players (vid -> record). */
    remotes,
    /** v5: our seat on the current raft (0 paddler, 1 passenger), else -1. */
    get seat() {
      return mySeat;
    },
    applyRemote,
    switchSeat,
    seatFeet,
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
      ev.on?.('net:connected', announce);
      ev.on?.('net:playerJoined', announce);
      ev.on?.('net:playerLeft', onPlayerLeft);
      ev.on?.('net:disconnected', onDisconnected);
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
      for (let i = 0; i < allRafts.length; i++) stepRaft(allRafts[i], dt);
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
