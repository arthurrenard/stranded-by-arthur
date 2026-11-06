// Falling trees (SPEC §6 B). Every 2-5 in-game hours (sooner in strong wind) an old or dead tree 25-70 m
// from the player creaks for ~2 s ('tree_creak', 'tree:falling'), then topples like a rigid rod pivoting
// on its base (theta'' = 3g/2L sin theta, so it starts slowly and accelerates), slams down with a couple
// of small bounces, a dust + leaf puff, 'tree_crash' and 'tree:fell'. A player inside the fall zone at
// impact takes ctx.stats.damage(30, 'tree'). The log stays (log colliders + "Gather wood from fallen
// tree" -> wood x4), its leaves wilt away after a few hours and the log decays after ~1.5 in-game days.
import * as THREE from 'three';
import { variantGeometry } from './bake.js';

const FALL_WEIGHT = { snag: 4, oak: 1, chestnut: 0.9, birch: 0.6, pine: 0.6, willow: 0.4 };
const CREAK_S = 2.2; // real seconds of warning
const LOG_LIFE_H = 36; // in-game hours before the log is gone
const LEAF_WILT_H = [3, 9]; // leaves fade out between these in-game hours after the fall
const MIN_D = 25, MAX_D = 70;

// ── Dust/leaf puff particles (one shared Points pool) ────────────────────
class Puff {
  constructor(group, n = 160) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.base = new Float32Array(n * 3);
    this.kind = new Uint8Array(n); // 1 = leaf fleck
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({ size: 1.1, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true });
    this.points = new THREE.Points(g, mat);
    this.points.name = 'flora-fall-puff';
    this.points.frustumCulled = false;
    this.points.visible = false;
    group.add(this.points);
    this.alive = 0;
  }
  /** Emit k particles around (x, y, z); leaf=true for green flecks (heavier, fall down). */
  emit(x, y, z, k, spread, leaf, rnd) {
    for (let i = 0; i < k; i++) {
      const j = this.next;
      this.next = (this.next + 1) % this.n;
      this.pos[j * 3] = x + (rnd() - 0.5) * spread;
      this.pos[j * 3 + 1] = y + rnd() * 0.6;
      this.pos[j * 3 + 2] = z + (rnd() - 0.5) * spread;
      const a = rnd() * Math.PI * 2, sp = (leaf ? 1.2 : 2.2) * (0.4 + rnd());
      this.vel[j * 3] = Math.cos(a) * sp;
      this.vel[j * 3 + 1] = leaf ? 1.5 + rnd() * 2.5 : 0.6 + rnd() * 1.4;
      this.vel[j * 3 + 2] = Math.sin(a) * sp;
      this.max[j] = this.life[j] = leaf ? 2.2 + rnd() * 1.6 : 2.6 + rnd() * 1.8;
      const c = leaf ? [0.16 + rnd() * 0.12, 0.3 + rnd() * 0.15, 0.08] : [0.42 + rnd() * 0.1, 0.36 + rnd() * 0.08, 0.27];
      this.base[j * 3] = c[0];
      this.base[j * 3 + 1] = c[1];
      this.base[j * 3 + 2] = c[2];
      this.kind[j] = leaf ? 1 : 0;
    }
    this.alive = 5;
    this.points.visible = true;
  }
  update(dt) {
    if (this.alive <= 0) return;
    this.alive -= dt;
    if (this.alive <= 0) {
      this.points.visible = false;
      return;
    }
    const drag = Math.exp(-dt * 1.6);
    for (let j = 0; j < this.n; j++) {
      if (this.life[j] <= 0) {
        this.col[j * 4 + 3] = 0;
        continue;
      }
      this.life[j] -= dt;
      const leaf = this.kind[j] === 1;
      this.vel[j * 3] *= drag;
      this.vel[j * 3 + 2] *= drag;
      this.vel[j * 3 + 1] = this.vel[j * 3 + 1] * drag - (leaf ? 2.2 : -0.15) * dt;
      this.pos[j * 3] += this.vel[j * 3] * dt;
      this.pos[j * 3 + 1] += this.vel[j * 3 + 1] * dt;
      this.pos[j * 3 + 2] += this.vel[j * 3 + 2] * dt;
      const t = this.life[j] / this.max[j];
      this.col[j * 4] = this.base[j * 3];
      this.col[j * 4 + 1] = this.base[j * 3 + 1];
      this.col[j * 4 + 2] = this.base[j * 3 + 2];
      this.col[j * 4 + 3] = Math.max(0, Math.min(1, t * 1.6)) * (leaf ? 0.95 : 0.55);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

let _dot = null;
/** Soft round sprite (procedural canvas texture), shared. */
export function dotTexture() {
  if (_dot) return _dot;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  _dot = new THREE.CanvasTexture(c);
  _dot.colorSpace = THREE.SRGBColorSpace;
  return _dot;
}

// ── Falling tree manager ─────────────────────────────────────────────────
export class FallingTrees {
  /** o: { lib, trees, meta, retireTree, mats, group, canopy, onDecay?(x, z) } */
  constructor(ctx, o) {
    this.ctx = ctx;
    this.o = o;
    this.rng = ctx.rng.fork('flora-falling');
    this.active = []; // falling or lying trees
    this.pressure = 0; // accumulated in-game hours (wind-weighted) since the last fall
    this.threshold = this.rng.range(2, 5);
    this.puff = new Puff(o.group);
    this._p = new THREE.Vector3();
    this._near = [];
  }

  init() {
    const ev = this.ctx.events;
    const reset = () => {
      this.pressure = 0;
      this.threshold = this.rng.range(2, 5);
    };
    ev.on('game:start', reset);
    ev.on('time:skip', reset); // sleeping never triggers a burst of falls
    ev.on('time:set', reset);
  }

  windStrength() {
    const w = this.ctx.weather?.wind?.strength;
    return Number.isFinite(w) ? w : this.ctx.uniforms?.uWindStrength?.value ?? 0.35;
  }

  playerPos() {
    const p = this.ctx.player?.position;
    if (p) return this._p.copy(p);
    return this.ctx.camera.getWorldPosition(this._p);
  }

  /** A weighted random old/dead tree 25-70 m from the player (or null). */
  pick(minD = MIN_D, maxD = MAX_D) {
    const p = this.playerPos();
    const list = this._near;
    list.length = 0;
    this.o.canopy.treesNear(p.x, p.z, maxD, list);
    const shelters = [...(this.ctx.shelters || []), ...(this.ctx.heatSources || [])];
    let sum = 0;
    const cands = [];
    for (const t of list) {
      if (!t.standing || t.special || t._falling) continue;
      const w = FALL_WEIGHT[t.type] || 0;
      if (!w) continue;
      if ((t.type === 'oak' || t.type === 'chestnut') && t.s < 0.98) continue; // only the old, big ones
      const d = Math.hypot(t.x - p.x, t.z - p.z);
      if (d < minD || d > maxD) continue;
      if (shelters.some((s) => s.position && Math.hypot(s.position.x - t.x, s.position.z - t.z) < t.height + 3)) continue;
      cands.push([t, w]);
      sum += w;
    }
    if (!cands.length) return null;
    let r = this.rng() * sum;
    for (const [t, w] of cands) if ((r -= w) <= 0) return t;
    return cands[cands.length - 1][0];
  }

  /** Choose a fall direction (wind-biased) whose landing spot is dry land. Returns [dx, dz]. */
  direction(t) {
    const W = this.ctx.world;
    const u = this.ctx.uniforms?.uWind?.value;
    const wa = u ? Math.atan2(u.y, u.x) : this.rng() * Math.PI * 2;
    for (let i = 0; i < 6; i++) {
      const a = (i < 3 ? wa : this.rng() * Math.PI * 2) + (this.rng() - 0.5) * 1.6;
      const dx = Math.cos(a), dz = Math.sin(a);
      const ex = t.x + dx * t.height * 0.8, ez = t.z + dz * t.height * 0.8;
      if (!W.waterAt(ex, ez) && W.heightAt(ex, ez) > 0.3) return [dx, dz];
    }
    const a = this.rng() * Math.PI * 2;
    return [Math.cos(a), Math.sin(a)];
  }

  /** Begin the creak + fall of tree t. */
  start(t) {
    const { meta, mats, group, retireTree } = this.o;
    const m = meta[t.id];
    if (!m || !t.standing || !mats) return null;
    const ctx = this.ctx;
    const W = ctx.world;
    const [dx, dz] = this.direction(t);
    const L = Math.max(3, t.height);
    // ground contact angle: earlier when the ground rises in the fall direction (and for wide crowns)
    const ex = t.x + dx * L * 0.75, ez = t.z + dz * L * 0.75;
    const rise = W.heightAt(ex, ez) - t.y;
    let thetaMax = Math.PI / 2 - Math.atan2(rise, L * 0.75) - Math.atan2(Math.min(t.crownR, L * 0.4) * 0.3, L * 0.8);
    thetaMax = Math.max(1.05, Math.min(1.72, thetaMax));

    const geo = variantGeometry(m.V, { bendK: 0, phase: t.phase, barkTint: m.tint?.bark, leafTint: m.tint?.leaf });
    const barkMat = mats.makeFading();
    const leafMat = mats.makeFading();
    const mesh = new THREE.Mesh(geo, [barkMat, leafMat]);
    mesh.rotation.y = t.rot;
    mesh.scale.setScalar(t.s);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = mats.depth;
    const pivot = new THREE.Group();
    pivot.name = 'flora-falling-tree';
    pivot.position.set(t.x, t.y, t.z);
    pivot.add(mesh);
    group.add(pivot);
    t._falling = true;
    retireTree(t); // hide the baked instance, drop collider + canopy, alive = false

    const f = {
      t,
      pivot,
      mesh,
      geo,
      barkMat,
      leafMat,
      dx,
      dz,
      L,
      axis: new THREE.Vector3(dz, 0, -dx).normalize(),
      theta: 0,
      omega: 0,
      thetaMax,
      phase: 'creak',
      time: 0,
      bounces: 0,
      fellAt: 0,
      colliders: [],
      handle: null,
      gathered: false,
      fade: 1,
    };
    this.active.push(f);
    const pos = new THREE.Vector3(t.x, t.y + Math.min(4, L * 0.4), t.z);
    ctx.audio?.play?.('tree_creak', { position: pos, volume: 1 });
    ctx.events.emit('tree:falling', { position: pos.clone(), type: t.type });
    return f;
  }

  /** Impact: dust, sound, event, damage, then the log becomes a gatherable obstacle. */
  impact(f) {
    const ctx = this.ctx;
    const W = ctx.world;
    const { t, dx, dz, L } = f;
    const reach = L * Math.sin(f.thetaMax);
    const rnd = this.rng;
    for (let u = 0.25; u <= 1.0; u += 0.15) {
      const x = t.x + dx * reach * u, z = t.z + dz * reach * u;
      const y = W.heightAt(x, z);
      this.puff.emit(x, y, z, 7, 1.6 + u * 2, false, rnd);
      if (u > 0.5 && t.type !== 'snag') this.puff.emit(x, y + 0.6, z, 5, 2.5, true, rnd);
    }
    const mid = new THREE.Vector3(t.x + dx * reach * 0.55, 0, t.z + dz * reach * 0.55);
    mid.y = W.heightAt(mid.x, mid.z) + 0.5;
    ctx.audio?.play?.('tree_crash', { position: mid, volume: 1 });
    ctx.events.emit('tree:fell', { position: mid.clone(), type: t.type });

    // Damage if the player stands in the fall zone (trunk line + crown footprint).
    const p = this.playerPos();
    if (ctx.state === 'playing') {
      const px = p.x - t.x, pz = p.z - t.z;
      const along = px * dx + pz * dz;
      const side = Math.abs(-px * dz + pz * dx);
      const u = along / Math.max(1, reach);
      const halfW = u > 0.45 ? Math.max(1.4, t.crownR * 0.75) : t.trunkR + 0.9;
      const groundY = W.heightAt(p.x, p.z);
      if (u > 0.06 && u < 1.08 && side < halfW && p.y - groundY < 2.5) {
        ctx.stats?.damage?.(30, 'tree');
        ctx.ui?.toast?.('A falling tree struck you!', { icon: '🌲', kind: 'bad', duration: 3 });
      }
    }

    // Log colliders: a row of low circles along the trunk (jump over, crowns are walk-through).
    const trunkLen = Math.min(L * 0.62, reach);
    for (let u = 0.12; u <= 1.0; u += 0.22) {
      const x = t.x + dx * trunkLen * u, z = t.z + dz * trunkLen * u;
      const g = W.heightAt(x, z);
      const r = Math.max(0.18, t.trunkR * (1.1 - u * 0.4));
      f.colliders.push(ctx.colliders.add({ x, z, r, y0: g - 1, y1: g + r * 2.1, tag: 'log', data: t }));
    }

    // "Gather wood from fallen tree"
    const ip = new THREE.Vector3(t.x + dx * trunkLen * 0.4, 0, t.z + dz * trunkLen * 0.4);
    ip.y = W.heightAt(ip.x, ip.z) + 0.6;
    f.ip = ip;
    f.handle = ctx.interact?.register?.({
      position: ip,
      radius: 4.5,
      priority: 0.2,
      label: 'Gather wood from fallen tree',
      enabled: () => !f.gathered,
      onUse: () => this.gather(f),
      data: { kind: 'fallenTree', tree: t },
    });
  }

  gather(f) {
    if (f.gathered) return;
    const ctx = this.ctx;
    const r = ctx.inventory?.add?.('wood', 4);
    const added = typeof r === 'number' ? r : 4;
    if (added <= 0) {
      ctx.ui?.toast?.('No room for more wood', { icon: ctx.items?.wood?.icon, kind: 'warn', duration: 2.5 });
      return;
    }
    f.gathered = true;
    f.handle?.remove?.();
    f.handle = null;
    ctx.audio?.play?.('pickup', { position: f.pivot.position });
    ctx.ui?.toast?.(`+${added} ${ctx.items?.wood?.name || 'Wood'}`, { icon: ctx.items?.wood?.icon, kind: 'good', duration: 2 });
    ctx.events.emit('harvest', { id: 'wood', n: added, kind: 'fallenTree' });
    // chips fly; the log is broken up and fades away quickly
    const p = f.ip || f.pivot.position;
    this.puff.emit(p.x, p.y - 0.4, p.z, 14, 2.5, false, this.rng);
  }

  /** Remove a fallen tree for good. */
  dispose(f) {
    const ctx = this.ctx;
    for (const c of f.colliders) ctx.colliders.remove(c);
    f.colliders.length = 0;
    f.handle?.remove?.();
    f.pivot.parent?.remove(f.pivot);
    f.geo.dispose();
    f.barkMat.dispose();
    f.leafMat.dispose();
    this.o.onDecay?.(f.t.x, f.t.z);
  }

  /** Debug / scripted: fell a given tree (entry or id), or a suitable one near the player. */
  debugFell(tree) {
    let t = typeof tree === 'number' ? this.o.trees[tree] : tree;
    if (!t) t = this.pick(MIN_D, MAX_D) || this.pick(12, 120);
    if (!t || !t.standing || t.special) return null;
    this.start(t);
    return t;
  }

  update(dt) {
    const ctx = this.ctx;
    // Scheduling: gameplay only. Strong wind builds "pressure" faster.
    if (ctx.state === 'playing' && !ctx.flags?.cinematic) {
      const dh = ctx.time?.dtHours || 0;
      this.pressure += dh * (1 + this.windStrength() * 1.6);
      if (this.pressure >= this.threshold) {
        this.pressure = 0;
        this.threshold = this.rng.range(2, 5);
        const t = this.pick();
        if (t) this.start(t);
      }
    }
    this.puff.update(dt);
    const now = ctx.time?.hoursTotal ?? 0;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const f = this.active[i];
      if (f.phase === 'creak') {
        f.time += dt;
        // creaking: the trunk shivers and leans a hair in the fall direction
        const w = Math.min(1, f.time / CREAK_S);
        f.theta = 0.012 * w * w + 0.006 * Math.sin(f.time * 11) * w;
        if (f.time >= CREAK_S) {
          f.phase = 'fall';
          f.theta = 0.03;
          f.omega = 0.06;
        }
      } else if (f.phase === 'fall') {
        const k = ((3 * 9.81) / (2 * f.L)) * 0.85;
        const steps = 3;
        const h = Math.min(dt, 0.05) / steps;
        for (let s = 0; s < steps; s++) {
          f.omega += k * Math.sin(f.theta) * h;
          f.theta += f.omega * h;
          if (f.theta >= f.thetaMax) {
            f.theta = f.thetaMax;
            if (f.bounces === 0) {
              f.fellAt = now;
              this.impact(f);
            }
            f.omega = -f.omega * (f.bounces === 0 ? 0.2 : 0.12);
            f.bounces++;
            if (f.bounces >= 3 || Math.abs(f.omega) < 0.05) {
              f.phase = 'lying';
              f.omega = 0;
              break;
            }
          }
        }
      } else {
        // lying: leaves wilt, the log decays (or fades fast once gathered)
        const age = now - f.fellAt;
        const lw = (age - LEAF_WILT_H[0]) / (LEAF_WILT_H[1] - LEAF_WILT_H[0]);
        f.leafMat.opacity = Math.max(0, Math.min(1, 1 - lw));
        f.leafMat.visible = f.leafMat.opacity > 0.01;
        if (f.gathered) f.fade -= dt / 2.5;
        else f.fade = Math.min(1, (LOG_LIFE_H - age) / 3);
        f.barkMat.opacity = Math.max(0, f.fade);
        if (f.gathered) f.leafMat.opacity = Math.min(f.leafMat.opacity, Math.max(0, f.fade));
        if (f.fade <= 0) {
          this.dispose(f);
          this.active.splice(i, 1);
          continue;
        }
      }
      f.pivot.quaternion.setFromAxisAngle(f.axis, f.theta);
    }
  }
}
