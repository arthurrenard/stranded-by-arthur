// Ambient forest life around the player: leaves drifting down from the canopy (more in wind, golden
// in sunbeams) and pollen/dust motes floating over sunny meadows by day. Two small Points clouds
// recycled around the player, updated on the CPU without allocations. (Butterflies, fireflies and
// birds belong to Builder C's fauna.)
import * as THREE from 'three';
import { dotTexture } from './falling.js';

const NL = 150; // leaves
const NM = 110; // motes
const R_LEAF = 20;
const R_MOTE = 16;

let _leafTex = null;
/** Small procedural leaf sprite (white; tinted by vertex colors). */
function leafTexture() {
  if (_leafTex) return _leafTex;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.translate(16, 16);
  g.rotate(-0.6);
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(0, -13);
  g.quadraticCurveTo(10, -3, 0, 12);
  g.quadraticCurveTo(-10, -3, 0, -13);
  g.fill();
  g.strokeStyle = 'rgba(200,200,200,1)';
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(0, -11);
  g.lineTo(0, 15);
  g.stroke();
  _leafTex = new THREE.CanvasTexture(c);
  _leafTex.colorSpace = THREE.SRGBColorSpace;
  return _leafTex;
}

const LEAF_COLORS = [
  [0.22, 0.42, 0.1],
  [0.36, 0.5, 0.12],
  [0.62, 0.5, 0.12],
  [0.55, 0.3, 0.08],
  [0.3, 0.46, 0.12],
];

export class Ambient {
  /** o: { group, canopyAt } */
  constructor(ctx, o) {
    this.ctx = ctx;
    this.o = o;
    this.rng = ctx.rng.fork('flora-ambient');
    this._p = new THREE.Vector3();
    this.leaves = this.cloud(NL, { size: 0.24, map: leafTexture(), blending: THREE.NormalBlending, name: 'flora-leaves' });
    this.motes = this.cloud(NM, { size: 0.075, map: dotTexture(), blending: THREE.AdditiveBlending, name: 'flora-motes' });
    o.group.add(this.leaves.points, this.motes.points);
  }

  cloud(n, opts) {
    const pos = new Float32Array(n * 3).fill(-1000);
    const col = new Float32Array(n * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.PointsMaterial({
      size: opts.size,
      map: opts.map,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: opts.blending,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(g, m);
    points.name = opts.name;
    points.frustumCulled = false;
    return {
      n,
      pos,
      col,
      points,
      vel: new Float32Array(n * 3),
      life: new Float32Array(n), // remaining seconds (<= 0 -> respawn)
      max: new Float32Array(n).fill(1),
      ph: Float32Array.from({ length: n }, () => this.rng() * 6.283),
      base: new Float32Array(n * 3),
      wait: Float32Array.from({ length: n }, () => this.rng() * 3),
    };
  }

  spawnLeaf(c, i, p) {
    const W = this.ctx.world;
    for (let k = 0; k < 2; k++) {
      const a = this.rng() * 6.283, d = Math.sqrt(this.rng()) * R_LEAF;
      const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
      const shade = this.o.canopyAt(x, z);
      if (shade < 0.3) continue;
      const g = W.heightAt(x, z);
      c.pos[i * 3] = x;
      c.pos[i * 3 + 1] = g + 3.5 + this.rng() * 6;
      c.pos[i * 3 + 2] = z;
      c.vel[i * 3 + 1] = -(0.45 + this.rng() * 0.45);
      c.max[i] = c.life[i] = 7 + this.rng() * 8;
      const lc = LEAF_COLORS[Math.floor(this.rng() * LEAF_COLORS.length)];
      c.base[i * 3] = lc[0];
      c.base[i * 3 + 1] = lc[1];
      c.base[i * 3 + 2] = lc[2];
      return true;
    }
    return false;
  }

  spawnMote(c, i, p) {
    const W = this.ctx.world;
    const a = this.rng() * 6.283, d = Math.sqrt(this.rng()) * R_MOTE;
    const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
    const b = W.biomeAt(x, z);
    if (b.water || b.sand > 0.5 || b.rock > 0.5) return false;
    if (this.o.canopyAt(x, z) > 0.45 && this.rng() < 0.7) return false;
    c.pos[i * 3] = x;
    c.pos[i * 3 + 1] = W.heightAt(x, z) + 0.3 + this.rng() * 2.4;
    c.pos[i * 3 + 2] = z;
    c.vel[i * 3] = (this.rng() - 0.5) * 0.2;
    c.vel[i * 3 + 1] = (this.rng() - 0.5) * 0.08;
    c.vel[i * 3 + 2] = (this.rng() - 0.5) * 0.2;
    c.max[i] = c.life[i] = 5 + this.rng() * 7;
    const warm = 0.75 + this.rng() * 0.25;
    c.base[i * 3] = 1.0 * warm;
    c.base[i * 3 + 1] = 0.9 * warm;
    c.base[i * 3 + 2] = 0.62 * warm;
    return true;
  }

  update(dt) {
    const ctx = this.ctx;
    const active = ctx.state === 'playing' || ctx.state === 'paused' || ctx.state === 'dead' || ctx.state === 'rescued';
    this.leaves.points.visible = this.motes.points.visible = active;
    if (!active) return;
    const p = ctx.player?.position ? this._p.copy(ctx.player.position) : ctx.camera.getWorldPosition(this._p);
    const W = ctx.world;
    const t = ctx.uniforms.uTime.value;
    const wv = ctx.uniforms.uWind.value;
    const ws = ctx.uniforms.uWindStrength.value;
    const rain = ctx.uniforms.uRain?.value ?? 0;
    const day = ctx.uniforms.uDaylight?.value ?? 1;
    const wl = Math.max(1e-4, Math.hypot(wv.x, wv.y));
    const wx = wv.x / wl, wz = wv.y / wl;

    // Leaves: more drop in wind; they flutter and drift downwind.
    const L = this.leaves;
    const leafRate = 0.25 + ws * 1.6; // fraction of slots allowed to be active
    for (let i = 0; i < L.n; i++) {
      const i3 = i * 3, i4 = i * 4;
      if (L.life[i] <= 0) {
        L.wait[i] -= dt;
        L.col[i4 + 3] = 0;
        if (L.wait[i] > 0) continue;
        L.wait[i] = 0.4 + this.rng() * 2.5;
        if (i / L.n > leafRate || !this.spawnLeaf(L, i, p)) {
          L.pos[i3 + 1] = -1000;
          continue;
        }
      }
      L.life[i] -= dt;
      const ph = L.ph[i];
      const sway = Math.sin(t * 2.1 + ph) * 0.9;
      L.pos[i3] += (wx * (0.25 + ws * 1.6) + Math.cos(t * 1.7 + ph) * 0.35 + -wz * sway * 0.3) * dt;
      L.pos[i3 + 1] += (L.vel[i3 + 1] * (1 + rain) + Math.sin(t * 3.3 + ph * 2) * 0.25) * dt;
      L.pos[i3 + 2] += (wz * (0.25 + ws * 1.6) + Math.sin(t * 1.3 + ph) * 0.35 + wx * sway * 0.3) * dt;
      const g = W.heightAt(L.pos[i3], L.pos[i3 + 2]);
      if (L.pos[i3 + 1] < g + 0.04) {
        L.pos[i3 + 1] = g + 0.04; // settle in the leaf litter and fade
        L.life[i] = Math.min(L.life[i], 1.2);
      }
      const dx = L.pos[i3] - p.x, dz = L.pos[i3 + 2] - p.z;
      if (dx * dx + dz * dz > (R_LEAF + 6) * (R_LEAF + 6)) L.life[i] = 0;
      const k = Math.min(1, L.life[i] / 1.2, (L.max[i] - L.life[i]) / 0.6);
      const lit = 0.35 + 0.65 * day;
      L.col[i4] = L.base[i3] * lit;
      L.col[i4 + 1] = L.base[i3 + 1] * lit;
      L.col[i4 + 2] = L.base[i3 + 2] * lit;
      L.col[i4 + 3] = Math.max(0, k);
    }
    L.points.geometry.attributes.position.needsUpdate = true;
    L.points.geometry.attributes.color.needsUpdate = true;

    // Motes: sunlit pollen by day, gone at night and in rain.
    const M = this.motes;
    const moteK = day * (1 - rain) * (1 - Math.min(1, ws * 0.6));
    for (let i = 0; i < M.n; i++) {
      const i3 = i * 3, i4 = i * 4;
      if (M.life[i] <= 0) {
        M.col[i4 + 3] = 0;
        M.wait[i] -= dt;
        if (M.wait[i] > 0) continue;
        M.wait[i] = 0.3 + this.rng() * 1.5;
        if (moteK < 0.05 || !this.spawnMote(M, i, p)) {
          M.pos[i3 + 1] = -1000;
          continue;
        }
      }
      M.life[i] -= dt;
      const ph = M.ph[i];
      M.pos[i3] += (M.vel[i3] + wx * ws * 0.5 + Math.sin(t * 0.7 + ph) * 0.12) * dt;
      M.pos[i3 + 1] += (M.vel[i3 + 1] + Math.sin(t * 0.9 + ph * 1.7) * 0.1) * dt;
      M.pos[i3 + 2] += (M.vel[i3 + 2] + wz * ws * 0.5 + Math.cos(t * 0.6 + ph) * 0.12) * dt;
      const k = Math.min(1, M.life[i] / 1.5, (M.max[i] - M.life[i]) / 1.5);
      const tw = 0.7 + 0.3 * Math.sin(t * 5 + ph * 3);
      M.col[i4] = M.base[i3] * tw;
      M.col[i4 + 1] = M.base[i3 + 1] * tw;
      M.col[i4 + 2] = M.base[i3 + 2] * tw;
      M.col[i4 + 3] = Math.max(0, k) * moteK * 0.8;
    }
    M.points.geometry.attributes.position.needsUpdate = true;
    M.points.geometry.attributes.color.needsUpdate = true;
  }
}
