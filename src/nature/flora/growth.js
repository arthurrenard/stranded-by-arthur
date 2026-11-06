// Plant growth (SPEC §6 B): saplings in clearings that visibly grow over in-game days into small trees,
// plus new sprouts appearing over time (and where a fallen log decayed). Two InstancedMeshes
// (broadleaf + conifer sapling variants from species.js) share the swaying tree material; instance
// scales are recomputed from ctx.time.hoursTotal a few times per second (not every frame), so sleeping
// or skipping time makes them jump ahead naturally.
import * as THREE from 'three';
import { variantGeometry } from './bake.js';
import { findClearings } from './placement.js';

const CAP = 140; // instances per kind
const TICK = 0.3; // seconds between scale updates
const SPROUT_EVERY_H = [6, 11]; // in-game hours between new sprouts

export class Saplings {
  /** o: { lib, mats, group, canopyAt } */
  constructor(ctx, o) {
    this.ctx = ctx;
    this.o = o;
    this.rng = ctx.rng.fork('flora-growth');
    this.list = [];
    this.timer = 0;
    this.sproutIn = this.rng.range(...SPROUT_EVERY_H);
    this.meshes = [];
    for (const [i, V] of [o.lib.saplingBroad, o.lib.saplingConifer].entries()) {
      const g = variantGeometry(V, { phase: 0.5 });
      g.clearGroups();
      const m = new THREE.InstancedMesh(g, o.mats.tree, CAP);
      m.name = i ? 'flora-saplings-conifer' : 'flora-saplings-broad';
      m.castShadow = true;
      m.receiveShadow = true;
      m.customDepthMaterial = o.mats.depth;
      m.frustumCulled = false; // a handful of small instances: not worth the bounds upkeep
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      o.group.add(m);
      this.meshes.push(m);
    }
    this.free = [[], []];
    this.used = [0, 0];
  }

  /** Add a sapling. stage 0 = fresh sprout, 1 = fully grown. Returns the record or null. */
  plant(x, z, conifer = false, stage = 0) {
    const k = conifer ? 1 : 0;
    let slot = this.free[k].pop();
    if (slot === undefined) {
      if (this.used[k] >= CAP) return null;
      slot = this.used[k]++;
    }
    const W = this.ctx.world;
    const growH = this.rng.range(48, 120); // 2-5 in-game days to full size
    const now = this.ctx.time?.hoursTotal ?? 0;
    const s = {
      x,
      z,
      y: W.heightAt(x, z) - 0.05,
      rot: this.rng() * Math.PI * 2,
      k,
      slot,
      growH,
      born: now - growH * stage,
      maxS: this.rng.range(1.25, 1.7),
      lean: (this.rng() - 0.5) * 0.08,
      collider: null,
      lastS: -1,
    };
    this.list.push(s);
    this.write(s, now);
    this.meshes[k].count = Math.max(this.meshes[k].count, slot + 1);
    this.meshes[k].instanceMatrix.needsUpdate = true;
    return s;
  }

  init() {
    // Initial saplings: scattered clearings + a few within easy reach of the spawn.
    const W = this.ctx.world;
    const canopyAt = this.o.canopyAt;
    const S = W.landmarks?.spawn || { x: 0, z: 0 };
    const spots = [
      ...findClearings(W, this.rng, canopyAt, 10, { x: S.x, z: S.z, r0: 25, r1: 150 }),
      ...findClearings(W, this.rng, canopyAt, 46),
    ];
    for (const p of spots) this.plant(p.x, p.z, p.conifer, this.rng.range(0.05, 0.75));
    this.ctx.events.on('time:skip', (e) => {
      // a night's sleep lets a few new sprouts come up
      const n = Math.min(4, Math.floor((e?.hours || 0) / 7));
      for (let i = 0; i < n; i++) this.sprout(this.rng.range(0.02, 0.15));
    });
  }

  /** A new sprout in a clearing 25-130 m from the player. */
  sprout(stage = 0) {
    const p = this.ctx.player?.position || this.ctx.camera.position;
    const [spot] = findClearings(this.ctx.world, this.rng, this.o.canopyAt, 1, { x: p.x, z: p.z, r0: 25, r1: 130 });
    if (spot) return this.plant(spot.x, spot.z, spot.conifer, stage);
    return null;
  }

  /** Where a fallen log decayed, a young tree takes its place. */
  sproutAt(x, z) {
    const b = this.ctx.world.biomeAt(x, z);
    if (b.water || b.sand > 0.3) return null;
    return this.plant(x + (this.rng() - 0.5) * 2, z + (this.rng() - 0.5) * 2, b.highland > 0.45, 0);
  }

  /** Scale for a growth fraction g (fast start, slows as it matures). */
  scaleOf(s, g) {
    const e = 1 - Math.pow(1 - g, 1.6);
    return 0.1 + (s.maxS - 0.1) * e;
  }

  write(s, now) {
    const g = Math.max(0, Math.min(1, (now - s.born) / s.growH));
    const sc = this.scaleOf(s, g);
    if (Math.abs(sc - s.lastS) < 0.002) return false;
    s.lastS = sc;
    const M = this.meshes[s.k].instanceMatrix.array;
    const o = s.slot * 16;
    const c = Math.cos(s.rot) * sc, sn = Math.sin(s.rot) * sc;
    M[o] = c;
    M[o + 1] = 0;
    M[o + 2] = -sn;
    M[o + 3] = 0;
    M[o + 4] = s.lean * sc;
    M[o + 5] = sc;
    M[o + 6] = 0;
    M[o + 7] = 0;
    M[o + 8] = sn;
    M[o + 9] = 0;
    M[o + 10] = c;
    M[o + 11] = 0;
    M[o + 12] = s.x;
    M[o + 13] = s.y;
    M[o + 14] = s.z;
    M[o + 15] = 1;
    // grown-up saplings (> ~2.4 m) get a thin trunk collider
    if (!s.collider && sc > 0.8 && this.ctx.colliders) {
      s.collider = this.ctx.colliders.add({ x: s.x, z: s.z, r: 0.14, y0: s.y - 1, y1: s.y + 3 * sc, tag: 'sapling', data: s });
    }
    return true;
  }

  get count() {
    return this.list.length;
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.state === 'playing') {
      this.sproutIn -= ctx.time?.dtHours || 0;
      if (this.sproutIn <= 0) {
        this.sproutIn = this.rng.range(...SPROUT_EVERY_H);
        this.sprout(0);
      }
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = TICK;
    const now = ctx.time?.hoursTotal ?? 0;
    let d0 = false, d1 = false;
    for (const s of this.list) {
      if (this.write(s, now)) {
        if (s.k) d1 = true;
        else d0 = true;
      }
    }
    if (d0) this.meshes[0].instanceMatrix.needsUpdate = true;
    if (d1) this.meshes[1].instanceMatrix.needsUpdate = true;
  }
}
