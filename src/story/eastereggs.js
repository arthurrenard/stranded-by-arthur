// The 7 easter eggs of Driftwood Isle (Builder F2, SPEC §7). Each secret counts once and gives a toast,
// the 'chime' one-shot, an 'easter:found' event { id, name, text, found, total } and a journal entry 'egg:<id>'.
//   1 bottle    message in a bottle bobbing at landmarks.bottleBeach (hints at the north-beach camp)
//   2 camp      the castaway's camp (lean-to ruin, "43 days" tally rock, volleyball friend: +2 rope, journal page)
//   3 circle    7 standing stones on the summit; stand in the middle 22:00–03:00 -> meteors + aurora, energy/health
//   4 butterfly golden butterfly in the meadow at dawn (05:30–08:00); it lands on your hand -> flags.blessed
//   5 konami    ↑↑↓↓←→←→BA -> moon gravity (flags.gravityScale = 0.3) for 60 s (repeatable, counts once)
//   6 carving   "A.R. ♥ this island" carved in the landmark oak, facing Mirror Lake
//   7 duck      rubber duck drifting on Mirror Lake; it quacks, and the lake quacks back 1.2 s later
// Pure helpers live in eggLogic.js (tests/eastereggs.test.mjs). All delays run on update(dt) timers (pause-safe).
import * as THREE from 'three';
import {
  createBottle,
  createVolleyball,
  createLeanToRuin,
  createTallyRock,
  createStoneCircle,
  createRubberDuck,
  createGoldenButterfly,
  createArm,
} from './models.js';
import { createMeteors, createAurora } from './fx.js';
import { createCarving } from './eggCarving.js';
import * as L from './eggLogic.js';

const PI = Math.PI;
const TAU = PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};

const SHOWER_S = 60;
const MOON_S = 60;
const MOON_SCALE = 0.3;
const CIRCLE_R = 8.5;
const CIRCLE_TRIGGER_R = 4;
const BFLY_REACH = 2.2;
const ECHO_DELAY = 1.2;

export function create(ctx) {
  const found = new Set();
  const handles = [];
  const colliders = [];
  const timers = []; // { t, fn }
  const root = new THREE.Group();
  root.name = 'eastereggs';
  let clock = 0; // gameplay clock (advances only while playing)
  let vt = 0; // visual clock
  let offKey = null;
  let ready = false;

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();

  // ── Helpers ─────────────────────────────────────────────────────────
  const playing = () => ctx.state === 'playing' && !ctx.flags?.cinematic && !ctx.flags?.sleeping;
  const after = (s, fn) => timers.push({ t: clock + s, fn });
  const toast = (text, icon = '✨', kind = 'story') => ctx.ui?.toast?.(text, { icon, kind });
  function say(lines) {
    let t = 0;
    for (const [text, s] of lines) {
      after(t, () => ctx.ui?.subtitle?.(text, s));
      t += s + 0.25;
    }
  }
  function discover(id, { text = '', msg = '', icon = '✨' } = {}) {
    if (found.has(id)) return false;
    found.add(id);
    const name = L.eggName(id);
    if (msg) toast(msg, icon);
    ctx.audio?.play?.('chime');
    ctx.ui?.markJournal?.('egg:' + id, { name, text });
    ctx.events?.emit?.('easter:found', { id, name, text, found: found.size, total: L.EGG_TOTAL });
    return true;
  }
  function register(o) {
    const h = ctx.interact?.register?.(o);
    if (h) handles.push(h);
    return h;
  }
  function collider(o) {
    const c = ctx.colliders?.add?.(o);
    if (c) colliders.push(c);
    return c;
  }
  const H = (x, z) => ctx.world?.heightAt?.(x, z) ?? 0;
  const seaLevel = () => ctx.config?.world?.seaLevel ?? 0;

  // ── 1. Message in a bottle ──────────────────────────────────────────
  const BOTTLE_LINES = [
    ['“To whoever washes up next: you are not the first.”', 4.5],
    ['“I lived on the north beach, past the point. Find my camp, I left a few things there.”', 5.5],
    ['“Keep a fire going and stay where they can see you.” (a fellow castaway)', 5],
  ];
  const bottle = { outer: null, inner: null, base: 0, wet: false, read: false };
  function setupBottle(B) {
    const d = Math.hypot(B.x, B.z) || 1;
    const ox = B.x / d, oz = B.z / d; // coastPoint radiates from the island center: this is seaward
    // Float it in the first ~12 cm of surf (ankle-deep, ~13 m out on the gentle beach); else lie at the waterline.
    let m = -1;
    for (let k = 3; k <= 18; k += 0.5) {
      if (H(B.x + ox * k, B.z + oz * k) < seaLevel() - 0.12) {
        m = k;
        break;
      }
    }
    if (m < 0) {
      m = 6;
      for (let k = 3; k <= 14; k += 0.5) {
        if (H(B.x + ox * k, B.z + oz * k) < 0.08) {
          m = k;
          break;
        }
      }
    }
    const x = B.x + ox * m, z = B.z + oz * m;
    const ground = H(x, z), sea = seaLevel();
    bottle.wet = ground < sea - 0.03;
    bottle.base = bottle.wet ? sea + 0.01 : ground + 0.07;
    const { group } = createBottle();
    bottle.inner = group;
    bottle.outer = new THREE.Group();
    bottle.outer.position.set(x, bottle.base, z);
    bottle.outer.rotation.y = Math.atan2(ox, oz) + 1.2;
    group.rotation.z = 1.4;
    bottle.outer.add(group);
    root.add(bottle.outer);
    register({
      position: new THREE.Vector3(x, bottle.base + 0.05, z),
      radius: 3.2,
      label: () => (bottle.read ? 'Read the message again' : 'Read the message'),
      onUse: () => {
        say(BOTTLE_LINES);
        const text = BOTTLE_LINES.map((l) => l[0]).join(' ');
        if (!bottle.read) {
          bottle.read = true;
          ctx.ui?.markJournal?.('note:bottle', { title: 'Message in a bottle', text, icon: '🍾' });
        }
        discover('bottle', { text: 'A note from a previous castaway: their camp is on the north beach.', msg: 'A message in a bottle! It points to a camp on the north beach.', icon: '🍾' });
      },
    });
  }
  function updateBottle() {
    if (!bottle.outer) return;
    const a = bottle.wet ? 0.035 : 0.006;
    bottle.outer.position.y = bottle.base + Math.sin(vt * 1.7) * a + Math.sin(vt * 0.63 + 1) * a * 0.5;
    bottle.inner.rotation.z = 1.4 + Math.sin(vt * 1.3) * (bottle.wet ? 0.09 : 0.01);
    bottle.inner.rotation.x = Math.sin(vt * 0.9 + 0.4) * (bottle.wet ? 0.12 : 0.01);
  }

  // ── 2. The castaway's camp ──────────────────────────────────────────
  const CASTAWAY_LINES = [
    ['“Day 43. I built a signal fire on high ground and kept it smoking from dawn to dusk.”', 5.5],
    ['“A helicopter turned around for the smoke. I’m going home.”', 4.5],
    ['“Get high, get seen, keep that fire burning. The rope is yours. So is he. Look after him.”', 6],
  ];
  const CASTAWAY_TEXT = CASTAWAY_LINES.map((l) => l[0]).join(' ');
  const PAT_LINES = ['He seems happy to see you.', 'Still smiling, after all this time.', "He's a very good listener.", 'You tell him about your day. He takes it well.'];
  let patIdx = 0;
  function journalCastaway() {
    ctx.ui?.markJournal?.('note:castaway', { title: "The castaway's note", text: CASTAWAY_TEXT, icon: '📜' });
  }
  function setupCamp(C) {
    const d = Math.hypot(C.x, C.z) || 1;
    const ox = C.x / d, oz = C.z / d; // seaward
    const yaw = Math.atan2(ox, oz); // local +Z -> seaward, local +X -> (oz, -ox)
    const cx = C.x - ox * 4, cz = C.z - oz * 4; // a few meters up the beach
    const at = (lx, lz) => [cx + lx * oz + lz * ox, cz - lx * ox + lz * oz];

    const lean = createLeanToRuin();
    const gy = H(cx, cz);
    lean.group.position.set(cx, gy - 0.05, cz);
    lean.group.rotation.y = yaw;
    root.add(lean.group);
    lean.group.updateMatrixWorld(true);
    const notePos = lean.group.localToWorld(lean.notePos.clone());
    const [lcx, lcz] = at(0.2, 0);
    collider({ x: lcx, z: lcz, r: 1.45, y0: gy - 1, y1: gy + 1.0, tag: 'egg-leanto' });

    const rock = createTallyRock();
    const [rx, rz] = at(-3.2, 0.9);
    const ry = H(rx, rz);
    rock.group.position.set(rx, ry - 0.15, rz);
    rock.group.rotation.y = yaw + 0.5;
    root.add(rock.group);
    collider({ x: rx, z: rz, r: 1.0, y0: ry - 1, y1: ry + 1.1, tag: 'egg-tally' });

    const ball = createVolleyball();
    const [bx, bz] = at(1.2, 3.0);
    const by = H(bx, bz);
    ball.rotation.order = 'YXZ';
    ball.rotation.set(0.1, yaw - 2.3, 0.05); // his face looks at the old fire pit and the lean-to
    ball.position.set(bx, by + 0.17, bz);
    root.add(ball);
    collider({ x: bx, z: bz, r: 0.25, y0: by - 0.5, y1: by + 0.38, tag: 'egg-volleyball' });

    register({
      position: new THREE.Vector3(bx, by + 0.2, bz),
      radius: 2.6,
      label: () => (found.has('camp') ? 'Pat the volleyball' : 'Say hello to the volleyball'),
      onUse: () => {
        if (found.has('camp')) {
          toast(PAT_LINES[patIdx++ % PAT_LINES.length], '🏐', 'info');
          return;
        }
        ctx.inventory?.add?.('rope', 2);
        journalCastaway();
        ctx.ui?.subtitle?.('A volleyball with a painted handprint face. Two coils of rope are tucked beneath him.', 5);
        discover('camp', { text: 'A collapsed lean-to, 43 tally marks and a volleyball friend. They were rescued thanks to a signal fire.', msg: 'They left a friend behind… and two coils of rope.', icon: '🏐' });
      },
    });
    register({
      position: notePos,
      radius: 2.6,
      label: 'Read the pinned note',
      onUse: () => {
        say(CASTAWAY_LINES);
        journalCastaway();
      },
    });
    register({
      position: new THREE.Vector3(rx, ry + 0.6, rz),
      radius: 2.8,
      label: 'Count the marks',
      onUse: () => ctx.ui?.subtitle?.('Forty-three marks scratched into the stone. “43 days.”', 4),
    });
  }

  // ── 3. Stone circle on the summit ───────────────────────────────────
  const circle = { cx: 0, cz: 0, y: 0, runeMat: null, glowMat: null, lastNight: null, t: -1, tail: 0 };
  const RUNE_DAY = new THREE.Color(0x4a4640);
  const RUNE_NIGHT = new THREE.Color(0x7dfbe4);
  let meteors = null;
  let aurora = null;
  function setupCircle(S) {
    circle.cx = S.x;
    circle.cz = S.z;
    circle.y = H(S.x, S.z);
    const sc = createStoneCircle(H, S.x, S.z, CIRCLE_R);
    sc.group.position.set(S.x, circle.y, S.z);
    root.add(sc.group);
    circle.runeMat = sc.runeMat;
    circle.glowMat = sc.glowMat;
    for (const s of sc.stones) collider({ x: s.x, z: s.z, r: 0.62, y0: s.top - 6, y1: s.top, tag: 'egg-stone' });
    collider({ x: S.x, z: S.z, r: 1.2, y0: circle.y - 1, y1: circle.y + 0.27, tag: 'egg-altar' }); // step-up height
  }
  function startShower(countIt = true) {
    circle.t = 0;
    circle.tail = 3;
    if (!meteors) {
      meteors = createMeteors(32);
      root.add(meteors.lines);
    }
    if (!aurora) {
      aurora = createAurora();
      root.add(aurora.group);
    }
    meteors.lines.visible = true;
    aurora.group.visible = true;
    const v = ctx.stats?.values;
    ctx.stats?.applyEffects?.({ energy: Math.max(0, 100 - (v?.energy ?? 100)), health: 15 }, 'stoneCircle');
    const msg = 'The island seems to watch over you.';
    if (!countIt || !discover('circle', { text: 'At midnight in the stone circle, the sky caught fire with falling stars.', msg, icon: '🌠' })) {
      toast(msg, '🌠');
      ctx.audio?.play?.('chime');
    }
  }
  function updateCircle(dt) {
    if (!circle.runeMat) return;
    const night = 1 - clamp01(ctx.time?.daylight ?? 1);
    let ev = 0;
    if (circle.t >= 0) {
      if (ctx.state === 'playing') circle.t += dt;
      ev = L.envelope(circle.t, SHOWER_S, 3, 6);
      const cam = ctx.camera.position;
      if (circle.t < SHOWER_S) {
        meteors.update(dt, 3.2 * ev, cam.x, cam.y, cam.z);
      } else {
        meteors.update(dt, 0, cam.x, cam.y, cam.z);
        circle.tail -= dt;
        if (circle.tail <= 0) {
          circle.t = -1;
          meteors.lines.visible = false;
          aurora.group.visible = false;
        }
      }
      if (aurora) {
        aurora.group.position.set(cam.x, 0, cam.z);
        aurora.mat.uniforms.uTime.value = vt;
        aurora.mat.uniforms.uIntensity.value = L.envelope(circle.t, SHOWER_S, 6, 8);
      }
    }
    const glow = clamp01(night * 0.9 + ev * 0.5);
    const pulse = 1 + ev * (0.6 + 0.3 * Math.sin(vt * 3.1));
    circle.runeMat.color.copy(RUNE_DAY).lerp(RUNE_NIGHT, glow).multiplyScalar(1 + (pulse - 1) * glow);
    circle.runeMat.opacity = 0.7 + 0.3 * glow;
    circle.glowMat.opacity = night * 0.16 + ev * (0.42 + 0.12 * Math.sin(vt * 2.3));
  }
  function checkCircle(p) {
    if (circle.t >= 0 || !circle.runeMat) return;
    const dx = p.x - circle.cx, dz = p.z - circle.cz;
    const d2 = dx * dx + dz * dz;
    const key = L.nightKey(ctx.time?.day ?? 1, ctx.time?.hour ?? 12);
    if (key !== null && d2 < 30 * 30 && !found.has('circle')) ctx.ui?.hint?.('egg-stones', 'The standing stones hum faintly in the dark…');
    if (key === null || key === circle.lastNight) return;
    if (d2 > CIRCLE_TRIGGER_R * CIRCLE_TRIGGER_R || Math.abs(p.y - circle.y) > 3) return;
    circle.lastNight = key;
    startShower(true);
  }

  // ── 4. Golden butterfly ─────────────────────────────────────────────
  const bf = { m: null, phase: 'idle', t: 0, start: new THREE.Vector3(), last: new THREE.Vector3(), vel: new THREE.Vector3(), arm: null, armK: 0, meadow: null };
  const PERCH = new THREE.Vector3(0, 0.73, 0.022); // on the palm, in arm-local space
  function setupButterfly(Mdw) {
    bf.meadow = Mdw;
    bf.m = createGoldenButterfly();
    bf.m.group.name = 'golden-butterfly';
    bf.m.group.visible = false;
    root.add(bf.m.group);
  }
  function ensureArm() {
    if (bf.arm || !ctx.camera) return;
    bf.arm = createArm(1);
    bf.arm.position.set(0.28, -0.62, -0.3);
    bf.arm.visible = false;
    ctx.camera.add(bf.arm);
  }
  function setArm(k) {
    bf.armK = k;
    if (!bf.arm) return;
    bf.arm.visible = k > 0.001;
    bf.arm.rotation.set(-2.4 + 1.25 * smooth(k), 0, 0.25 * smooth(k));
  }
  function flap(speed, amp, base = 0.35) {
    const a = base + Math.sin(vt * speed) * amp;
    bf.m.right.rotation.z = a;
    bf.m.left.rotation.z = -a;
  }
  function handWorld(out) {
    bf.arm.updateWorldMatrix(true, false);
    return bf.arm.localToWorld(out.copy(PERCH));
  }
  function updateButterfly(dt, p) {
    if (!bf.m || bf.phase === 'done') return;
    const g = bf.m.group;
    const T = ctx.time;
    const live = ctx.state === 'playing';
    if (bf.phase === 'idle') {
      const active = !found.has('butterfly') && L.inDawnWindow(T?.hour ?? 12);
      g.visible = active;
      if (!active) return;
      const A = L.butterflyAnchor(T?.day ?? 1, bf.meadow.x, bf.meadow.z, 16);
      const x = A.x + Math.sin(vt * 0.31) * 3.2 + Math.sin(vt * 1.13) * 0.7;
      const z = A.z + Math.cos(vt * 0.27) * 3.0 + Math.cos(vt * 0.91) * 0.6;
      const y = H(x, z) + 1.15 + Math.sin(vt * 1.7) * 0.25 + Math.sin(vt * 4.1) * 0.06;
      bf.last.copy(g.position);
      g.position.set(x, y, z);
      const vx = x - bf.last.x, vz = z - bf.last.z;
      if (vx * vx + vz * vz > 1e-8) g.rotation.set(0, Math.atan2(-vx, -vz), 0);
      flap(17, 0.85);
      if (bf.m.glow) bf.m.glow.scale.setScalar(0.7);
      if (!p || !playing()) return;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < 40 * 40) ctx.ui?.hint?.('egg-butterfly', 'Something golden glints among the flowers…');
      if (dx * dx + dz * dz < BFLY_REACH * BFLY_REACH && Math.abs(p.y + 1 - y) < 2.5) {
        ensureArm();
        if (!bf.arm) return;
        bf.phase = 'fly';
        bf.t = 0;
        bf.start.copy(g.position);
      }
      return;
    }
    if (!live) return; // landing sequence freezes while paused
    bf.t += dt;
    if (bf.phase === 'fly') {
      setArm(Math.min(1, bf.t / 0.8));
      const u = smooth(bf.t / 1.5);
      handWorld(tmpV);
      g.position.lerpVectors(bf.start, tmpV, u);
      g.position.y += Math.sin(u * PI) * 0.35;
      const dx = tmpV.x - g.position.x, dz = tmpV.z - g.position.z;
      if (dx * dx + dz * dz > 1e-6) g.rotation.set(0, Math.atan2(-dx, -dz), 0);
      flap(20, 0.9);
      if (bf.m.glow) bf.m.glow.scale.setScalar(0.7 - 0.55 * u);
      if (bf.t >= 1.5) {
        bf.arm.attach(g);
        g.position.copy(PERCH);
        g.rotation.set(PI / 2, 0, 0); // butterfly up -> palm normal, head toward the fingers
        bf.phase = 'perch';
        bf.t = 0;
      }
    } else if (bf.phase === 'perch') {
      flap(2.2, 0.55, 0.65);
      if (bf.m.glow) bf.m.glow.scale.setScalar(0.15 + 0.03 * Math.sin(vt * 3));
      if (bf.t >= 3.8) {
        root.attach(g);
        ctx.camera.getWorldDirection(tmpV2);
        bf.vel.set(tmpV2.x * 1.2, 1.4, tmpV2.z * 1.2);
        if (ctx.flags) ctx.flags.blessed = true;
        discover('butterfly', { text: 'A golden butterfly rested on your hand at dawn. Rescuers will notice you a little more easily.', msg: 'You feel lucky.', icon: '🦋' });
        bf.phase = 'leave';
        bf.t = 0;
      }
    } else if (bf.phase === 'leave') {
      setArm(Math.max(0, 1 - bf.t / 0.9));
      g.position.addScaledVector(bf.vel, dt);
      bf.vel.y += dt * 0.4;
      flap(19, 0.9);
      const f = 1 - clamp01(bf.t / 2);
      bf.m.mat.opacity = 0.95 * f;
      if (bf.m.glow) {
        bf.m.glow.material.opacity = 0.8 * f;
        bf.m.glow.scale.setScalar(0.15 + 0.4 * (1 - f));
      }
      if (bf.t >= 2) {
        g.visible = false;
        setArm(0);
        bf.phase = 'done';
      }
    }
  }

  // ── 5. Konami code -> moon gravity ──────────────────────────────────
  const konami = L.createSequenceMatcher(L.KONAMI);
  let moonT = 0;
  function moonGravity() {
    if (ctx.flags) ctx.flags.gravityScale = MOON_SCALE;
    moonT = MOON_S;
    if (!discover('konami', { text: '↑ ↑ ↓ ↓ ← → ← → B A. Gravity is more of a suggestion here.', msg: 'Moon gravity!', icon: '🌙' })) {
      toast('Moon gravity!', '🌙');
      ctx.audio?.play?.('chime');
    }
  }
  function onKey(code) {
    if (!playing()) {
      konami.reset();
      return;
    }
    if (konami.push(code)) moonGravity();
  }
  function updateMoon(dt) {
    if (moonT <= 0 || ctx.state !== 'playing') return;
    moonT -= dt;
    if (moonT <= 0) {
      moonT = 0;
      if (ctx.flags) ctx.flags.gravityScale = 1;
      toast('Gravity returns to normal.', '🌍', 'info');
    }
  }

  // ── 6. Carved initials ──────────────────────────────────────────────
  function setupCarving(P) {
    const tree = ctx.flora?.trees?.find?.((t) => t.special === 'carvedTree');
    const x = tree?.x ?? P.x, z = tree?.z ?? P.z;
    const trunkR = tree?.trunkR ?? 0.6;
    const baseY = Number.isFinite(tree?.y) ? tree.y : H(x, z);
    const lake = ctx.world?.lakes?.[0] ?? ctx.world?.landmarks?.lake;
    const yaw = lake ? Math.atan2(lake.x - x, lake.z - z) : -PI / 2; // face Mirror Lake (west)
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const { mesh } = createCarving({ radius: trunkR + 0.015, height: 0.6, arc: Math.min(1.45, 1.15 / (trunkR + 0.015)) }); // ~1.15 m wide band
    mesh.position.set(x, baseY + 1.4, z);
    mesh.rotation.y = yaw;
    root.add(mesh);
    register({
      position: new THREE.Vector3(x + fx * (trunkR + 0.05), baseY + 1.4, z + fz * (trunkR + 0.05)),
      radius: 2.6,
      label: 'Read the carving',
      enabled: (c) => {
        const p = c?.player?.position;
        return !p || (p.x - x) * fx + (p.z - z) * fz > 0;
      },
      onUse: () => {
        ctx.ui?.subtitle?.('“A.R. ♥ this island”, carved deep into the bark. Your initials… but the cuts look years old.', 5.5);
        discover('carving', { text: '“A.R. ♥ this island”, carved into the old oak facing Mirror Lake.', msg: 'Someone loved this island long before you.', icon: '🌳' });
      },
    });
  }

  // ── 7. Rubber duck on Mirror Lake ───────────────────────────────────
  const duck = { m: null, cx: 0, cz: 0, level: 0, lx: 0, lz: 0, pos: new THREE.Vector3(), handle: null, cool: 0 };
  const DUCK_R = 1.6, DUCK_W = TAU / 80;
  function setupDuck(D, lake) {
    duck.cx = D.x;
    duck.cz = D.z;
    duck.level = lake?.level ?? D.y ?? 0;
    duck.lx = lake?.x ?? D.x;
    duck.lz = lake?.z ?? D.z;
    duck.m = createRubberDuck();
    duck.m.rotation.order = 'YXZ';
    root.add(duck.m);
    placeDuck();
    duck.handle = register({
      position: duck.pos,
      radius: 3,
      label: 'Squeeze the rubber duck',
      onUse: () => {
        if (duck.cool > 0) return;
        duck.cool = ECHO_DELAY + 0.6;
        ctx.audio?.play?.('quack', { position: duck.pos.clone() });
        const e = L.mirrorThrough(duck.pos.x, duck.pos.z, duck.lx, duck.lz);
        const echo = new THREE.Vector3(e.x, duck.level, e.z);
        after(ECHO_DELAY, () => {
          ctx.audio?.play?.('quack', { position: echo, volume: 0.5, rate: 0.93 });
          discover('duck', { text: 'A rubber duck on Mirror Lake. Something across the water quacks back.', msg: 'Quack! …and from across the lake, a quack answers.', icon: '🦆' });
        });
      },
    });
  }
  function placeDuck() {
    const a = vt * DUCK_W + 0.7;
    const x = duck.cx + Math.cos(a) * DUCK_R, z = duck.cz + Math.sin(a) * DUCK_R;
    duck.pos.set(x, duck.level + 0.15, z);
    duck.m.position.set(x, duck.level - 0.03 + Math.sin(vt * 1.9) * 0.012, z);
    duck.m.rotation.set(Math.sin(vt * 1.1) * 0.05, Math.atan2(Math.sin(a), -Math.cos(a)), Math.sin(vt * 1.3) * 0.06);
  }
  function updateDuck(dt) {
    if (!duck.m) return;
    if (duck.cool > 0 && ctx.state === 'playing') duck.cool -= dt;
    placeDuck();
    duck.handle?.moveTo?.(duck.pos.x, duck.pos.y, duck.pos.z);
  }

  // ── Module ──────────────────────────────────────────────────────────
  function safe(name, fn) {
    try {
      fn();
    } catch (e) {
      console.error(`[eastereggs] ${name} setup failed`, e);
    }
  }

  const api = {
    found,
    total: L.EGG_TOTAL,
    init() {
      if (ready) return;
      ready = true;
      const lm = ctx.world?.landmarks || {};
      ctx.scene?.add?.(root);
      if (lm.bottleBeach) safe('bottle', () => setupBottle(lm.bottleBeach));
      if (lm.castawayCamp) safe('camp', () => setupCamp(lm.castawayCamp));
      if (lm.summit) safe('circle', () => setupCircle(lm.summit));
      if (lm.meadow) safe('butterfly', () => setupButterfly(lm.meadow));
      if (lm.carvedTree) safe('carving', () => setupCarving(lm.carvedTree));
      if (lm.duck) safe('duck', () => setupDuck(lm.duck, ctx.world?.lakes?.[0]));
      offKey = ctx.input?.onKeyDown?.(onKey) || null;
    },
    update(dt) {
      if (!ready) return;
      dt = Math.min(dt || 0, 0.1);
      vt += dt;
      if (ctx.state === 'playing') {
        clock += dt;
        for (let i = timers.length - 1; i >= 0; i--) {
          if (timers[i].t <= clock) {
            const fn = timers[i].fn;
            timers.splice(i, 1);
            fn();
          }
        }
      }
      const p = ctx.player?.position;
      if (p && playing()) checkCircle(p);
      updateBottle();
      updateDuck(dt);
      updateCircle(dt);
      updateButterfly(dt, p);
      updateMoon(dt);
    },
    /** Debug: start the stone-circle meteor shower right now (doesn't count the egg). */
    debugShower() {
      startShower(false);
    },
    dispose() {
      for (const h of handles) h.remove?.();
      for (const c of colliders) ctx.colliders?.remove?.(c);
      handles.length = colliders.length = 0;
      if (typeof offKey === 'function') offKey();
      if (bf.arm) bf.arm.parent?.remove(bf.arm);
      root.parent?.remove(root);
      if (moonT > 0 && ctx.flags) ctx.flags.gravityScale = 1;
      ready = false;
    },
  };
  return api;
}
