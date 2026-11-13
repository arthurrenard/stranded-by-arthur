// Rockfall on Tempest Isle's steep upper slopes (V3-B). While the player is on the isle above ROCKFALL.minHeight,
// a timer runs (20–60 s, halved at full storm); when it expires and they stand on a slope > 0.3, 2–4 boulders break
// loose ~25–45 m upslope with a rumble and tumble down the fall line (simple rolling physics on ctx.world).
// A direct hit: ctx.stats.damage(15–25, 'falling'). One InstancedMesh, no per-frame allocations.
import * as THREE from 'three';
import { ROCKFALL, nextRockfallDelay, rockDamage, clamp01 } from './isle2-logic.js';
import { buildBoulder } from './isle2-models.js';

const MAX = 8;
const G = 9.8;

export function createRockfall(ctx, { group, rand, fx, isIndoors }) {
  const W = ctx.world;
  const mesh = new THREE.InstancedMesh(buildBoulder(rand), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), MAX);
  mesh.name = 'isle2-rockfall';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(mesh);
  const rocks = [];
  for (let i = 0; i < MAX; i++) rocks.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0.6, life: 0, hit: false, fade: 1, rest: 0, q: new THREE.Quaternion() });
  const _m = new THREE.Matrix4();
  const _v = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _ax = new THREE.Vector3();
  const _dq = new THREE.Quaternion();
  const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < MAX; i++) mesh.setMatrixAt(i, _zero);
  let timer = nextRockfallDelay(rand(), 0);
  let warned = false;
  let anyOn = false;
  const puff = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rise: 0.8, size0: 1, size1: 4, life: 4, r: 0.62, g: 0.57, b: 0.5, alpha: 0.35, glow: 0, wind: 0.6 };
  const rumblePos = new THREE.Vector3();

  function zoneOk(p) {
    if ((W.islandAt?.(p.x, p.z) ?? null) !== 'isle2') return false;
    return p.y > ROCKFALL.minHeight;
  }

  /** Break 2–4 boulders loose upslope of (px, pz). Returns how many started. */
  function trigger(px, pz, py) {
    // follow the fall line uphill
    let x = px, z = pz;
    const want = ROCKFALL.spawnDist[0] + rand() * (ROCKFALL.spawnDist[1] - ROCKFALL.spawnDist[0]);
    for (let d = 0; d < want; d += 3) {
      W.normalAt(x, z, _n);
      const l = Math.hypot(_n.x, _n.z);
      if (l < 0.05) break;
      x -= (_n.x / l) * 3;
      z -= (_n.z / l) * 3;
    }
    const top = W.heightAt(x, z);
    if (top < py + 5 || W.waterAt(x, z)) return 0;
    const dl = Math.hypot(px - x, pz - z) || 1;
    const dx = (px - x) / dl, dz = (pz - z) / dl;
    const n = ROCKFALL.rocks[0] + Math.floor(rand() * (ROCKFALL.rocks[1] - ROCKFALL.rocks[0] + 1));
    let started = 0;
    for (const r of rocks) {
      if (started >= n) break;
      if (r.on) continue;
      const side = (rand() - 0.5) * 9;
      r.x = x - dz * side + (rand() - 0.5) * 2;
      r.z = z + dx * side + (rand() - 0.5) * 2;
      r.r = 0.45 + rand() * 0.45;
      r.y = W.heightAt(r.x, r.z) + r.r + rand() * 1.5;
      const sp = 3 + rand() * 3;
      r.vx = dx * sp;
      r.vz = dz * sp;
      r.vy = rand() * 2;
      r.life = ROCKFALL.life;
      r.hit = false;
      r.fade = 1;
      r.rest = 0;
      r.q.identity();
      r.on = true;
      started++;
    }
    if (started) {
      rumblePos.set(x, top, z);
      ctx.audio?.play?.('tree_crash', { volume: 0.6, position: rumblePos });
      if (fx?.smoke) for (let k = 0; k < 6; k++) dust(x + (rand() - 0.5) * 6, top + 0.5, z + (rand() - 0.5) * 6);
      if (!warned) {
        warned = true;
        ctx.ui?.toast?.('Loose rocks above… watch the slope!', { icon: '🪨', kind: 'warn', duration: 3.5 });
      }
      anyOn = true;
    }
    return started;
  }
  function dust(x, y, z) {
    puff.x = x;
    puff.y = y;
    puff.z = z;
    puff.vx = (rand() - 0.5);
    puff.vz = (rand() - 0.5);
    puff.size0 = 0.8 + rand();
    puff.size1 = 3 + rand() * 3;
    fx.smoke.emit(puff);
  }

  function step(r, dt, p) {
    const g = W.heightAt(r.x, r.z);
    if (r.y - r.r <= g + 0.05) {
      W.normalAt(r.x, r.z, _n);
      r.vx += _n.x * G * 1.15 * dt;
      r.vz += _n.z * G * 1.15 * dt;
      const fr = 1 - Math.min(0.9, (0.25 + (1 - _n.y) * 0.1) * dt);
      r.vx *= fr;
      r.vz *= fr;
      if (r.vy < -2.5) {
        r.vy = -r.vy * 0.32; // bounce
        if (fx?.smoke && rand() < 0.5) dust(r.x, g + 0.2, r.z);
      } else r.vy = 0;
      if (_n.y < 0.85 && rand() < dt * 1.5) r.vy = 1 + rand() * 2.5; // hop over a ledge
      r.y = Math.max(r.y, g + r.r);
    } else r.vy -= G * dt;
    r.x += r.vx * dt;
    r.y += r.vy * dt;
    r.z += r.vz * dt;
    const sp = Math.hypot(r.vx, r.vz);
    // roll: rotate about the axis perpendicular to the motion
    if (sp > 0.05) {
      _ax.set(r.vz, 0, -r.vx).normalize();
      _dq.setFromAxisAngle(_ax, (sp / r.r) * dt);
      r.q.premultiply(_dq);
    }
    // hit the player
    if (!r.hit && p && sp > 2.2) {
      const dx = r.x - p.x, dz = r.z - p.z;
      if (dx * dx + dz * dz < (r.r + 0.45) ** 2 && r.y - r.r < p.y + 1.8 && r.y + r.r > p.y) {
        r.hit = true;
        if (!isIndoors?.(p)) {
          ctx.stats?.damage?.(rockDamage(rand()), 'falling');
          ctx.ui?.flash?.('#ff3b2b', 0.3, 0.45);
          ctx.ui?.toast?.('A falling rock slams into you!', { icon: '🪨', kind: 'bad', duration: 2.5, key: 'rockhit' });
        }
      }
    }
    r.life -= dt;
    const w = W.waterAt(r.x, r.z);
    if (w && r.y < w.surface) r.life = Math.min(r.life, 0.4); // sinks
    if (sp < 0.5 && Math.abs(r.vy) < 0.5) r.rest += dt;
    if (r.life <= 0 || r.rest > 3) {
      r.fade -= dt * 1.2; // settle into the scree
      if (r.fade <= 0) r.on = false;
    }
  }

  function update(dt) {
    if (ctx.state !== 'playing') return;
    const p = ctx.player?.position;
    if (p && zoneOk(p) && !ctx.player?.aboard) {
      const storm = clamp01(ctx.weather?.stormAt?.(p.x, p.z) ?? 0);
      timer -= dt;
      if (timer <= 0 && W.slopeAt(p.x, p.z) > ROCKFALL.minSlope && !isIndoors?.(p)) {
        trigger(p.x, p.z, p.y);
        timer = nextRockfallDelay(rand(), storm);
      }
    }
    if (!anyOn) return;
    let on = false;
    for (let i = 0; i < MAX; i++) {
      const r = rocks[i];
      if (!r.on) {
        mesh.setMatrixAt(i, _zero);
        continue;
      }
      on = true;
      step(r, dt, p);
      const s = r.r * clamp01(r.fade);
      _m.compose(_v.set(r.x, r.y - (1 - clamp01(r.fade)) * r.r, r.z), r.q, _s.set(s, s, s));
      mesh.setMatrixAt(i, r.on ? _m : _zero);
    }
    mesh.instanceMatrix.needsUpdate = true;
    anyOn = on;
  }

  return {
    mesh,
    update,
    get timer() {
      return timer;
    },
    get active() {
      return rocks.filter((r) => r.on).length;
    },
    /** Debug: trigger a rockfall above the player now (if the slope allows). */
    debugTrigger() {
      const p = ctx.player?.position;
      return p ? trigger(p.x, p.z, p.y) : 0;
    },
  };
}
