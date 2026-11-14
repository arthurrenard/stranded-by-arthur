// Remote-player avatar (V4-B, SPEC §12): a low-poly procedural castaway used by src/net/net.js for every other
// player in the session. No assets: shared BoxGeometry/SphereGeometry parts (~330 triangles per avatar, well under
// the 700 budget), per-avatar colors (skin tone + hair from the id hash, shirt color passed in), procedural
// animation (idle breathing, walk/run cycle with arm swing, swim stroke, wave, seated paddle pose), a canvas-sprite
// name tag that fades beyond 120 m, shadows on. Network samples are buffered and rendered CONFIG.net.interpolationMs
// in the past so 15 Hz updates look smooth; a short extrapolation covers late packets.
//
//   createAvatar(ctx, { name, color, id }) →
//     { object, setTarget(pos, yaw, pitch, state), update(dt), setName(name), dispose() }
//   pos: Vector3 or [x,y,z] (feet position, like ctx.player.position) · yaw/pitch: radians (camera convention)
//   state: { moving, sprinting, swimming, aboard, waving, torch }
import { CONFIG } from '../config.js';
import { angleDelta, colorForId, hashString } from '../net/protocol.js';

const PROP = { hipY: 0.9, thigh: 0.4, shin: 0.38, torso: 0.55, upperArm: 0.3, foreArm: 0.28, headR: 0.13 };
const SKIN = ['#f1c9a5', '#e0ac7e', '#c68642', '#8d5524', '#5c3a1e', '#f6d9c0'];
const HAIR = ['#2b1b12', '#4a2c17', '#1a1a1a', '#8b5a2b', '#c9a060', '#5a3b2e'];
const TAG_FAR = 120; // m: name tag fully transparent beyond this
const TAG_BAND = 25; // m: fade width
const RING = 32; // buffered network samples
const EXTRAPOLATE_MS = 250;
const TAU = Math.PI * 2;

let THREE = null;
let S = null; // shared geometries + materials (built once per page)

/** Torn shirt hem: 8 ragged triangles hanging from the torso's bottom edge (front + back). */
function makeHem() {
  const pos = [];
  for (const side of [-1, 1]) {
    const z = side * 0.105;
    for (let i = 0; i < 4; i++) {
      const x0 = -0.18 + i * 0.09, x1 = x0 + 0.09, xm = (x0 + x1) / 2;
      const tip = -(0.05 + ((i * 7 + (side > 0 ? 1 : 0)) % 3) * 0.025);
      if (side > 0) pos.push(x0, 0, z, x1, 0, z, xm, tip, z);
      else pos.push(x1, 0, z, x0, 0, z, xm, tip, z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function shared(ctx) {
  if (S) return S;
  THREE = ctx.THREE;
  const box = (w, h, d, oy = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (oy) g.translate(0, oy, 0);
    return g;
  };
  S = {
    head: new THREE.SphereGeometry(PROP.headR, 7, 5),
    hair: new THREE.SphereGeometry(PROP.headR * 1.09, 7, 4, 0, TAU, 0, Math.PI * 0.55),
    torso: box(0.36, PROP.torso, 0.2),
    hem: makeHem(),
    hips: box(0.34, 0.24, 0.21),
    upperArm: box(0.1, PROP.upperArm, 0.1, -PROP.upperArm / 2),
    foreArm: box(0.09, PROP.foreArm, 0.09, -PROP.foreArm / 2),
    hand: box(0.09, 0.09, 0.05, -PROP.foreArm - 0.04),
    thigh: box(0.14, PROP.thigh, 0.14, -PROP.thigh / 2),
    shin: box(0.12, PROP.shin, 0.12, -PROP.shin / 2),
    foot: box(0.12, 0.07, 0.22),
    stick: new THREE.CylinderGeometry(0.015, 0.022, 0.42, 5),
    flame: new THREE.ConeGeometry(0.06, 0.16, 6),
    flameMat: new THREE.MeshBasicMaterial({ color: 0xffa432 }),
    stickMat: new THREE.MeshLambertMaterial({ color: 0x5a3b22 }),
  };
  return S;
}

function makeTag(name, color) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 0.4, 1);
  sprite.position.y = 2.08;
  sprite.renderOrder = 10;
  const tag = { sprite, material, texture, canvas, draw: null };
  tag.draw = (text, col) => {
    const c = canvas.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.font = '700 30px "Avenir Next", "Segoe UI", system-ui, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = 7;
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.strokeText(text, 128, 34, 240);
    c.fillStyle = col;
    c.fillText(text, 128, 34, 240);
    texture.needsUpdate = true;
  };
  tag.draw(name, color);
  return tag;
}

export function createAvatar(ctx, { name = 'Castaway', color, id = name } = {}) {
  const G = shared(ctx);
  const h = hashString(id);
  color = color || colorForId(id);
  const skinMat = new THREE.MeshLambertMaterial({ color: SKIN[h % SKIN.length] });
  const shirtMat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  const shortsMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.45) });
  const hairMat = new THREE.MeshLambertMaterial({ color: HAIR[(h >>> 8) % HAIR.length] });
  const mats = [skinMat, shirtMat, shortsMat, hairMat];

  const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.matrixAutoUpdate = true;
    parent.add(m);
    return m;
  };
  const group = (parent, x = 0, y = 0, z = 0) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };

  const object = new THREE.Group();
  object.name = 'avatar:' + id;
  object.visible = false;
  const hips = group(object, 0, PROP.hipY, 0);
  mesh(G.hips, shortsMat, hips, 0, -0.02, 0);
  const torso = mesh(G.torso, shirtMat, hips, 0, 0.1 + PROP.torso / 2, 0);
  mesh(G.hem, shirtMat, torso, 0, -PROP.torso / 2, 0);
  const neckY = 0.1 + PROP.torso;
  const head = group(hips, 0, neckY + 0.03, 0);
  mesh(G.head, skinMat, head, 0, PROP.headR + 0.02, 0);
  const hair = mesh(G.hair, hairMat, head, 0, PROP.headR + 0.03, 0);
  hair.rotation.x = 0.3;

  const arm = (side) => {
    const shoulder = group(hips, side * 0.23, neckY - 0.04, 0);
    mesh(G.upperArm, shirtMat, shoulder);
    const elbow = group(shoulder, 0, -PROP.upperArm, 0);
    mesh(G.foreArm, skinMat, elbow);
    mesh(G.hand, skinMat, elbow);
    return { shoulder, elbow };
  };
  const leg = (side) => {
    const hip = group(hips, side * 0.1, 0, 0);
    mesh(G.thigh, skinMat, hip);
    const knee = group(hip, 0, -PROP.thigh, 0);
    mesh(G.shin, skinMat, knee);
    mesh(G.foot, skinMat, knee, 0, -PROP.shin - 0.035, -0.04);
    return { hip, knee };
  };
  const armL = arm(-1), armR = arm(1), legL = leg(-1), legR = leg(1);

  // Torch in the left hand (shown while state.torch).
  const torch = group(armL.elbow, 0, -PROP.foreArm - 0.04, -0.03);
  torch.rotation.x = -0.35;
  mesh(G.stick, G.stickMat, torch, 0, 0.14, 0);
  const flame = mesh(G.flame, G.flameMat, torch, 0, 0.4, 0);
  flame.castShadow = false;
  torch.visible = false;

  const tag = makeTag(name, color);
  if (tag) object.add(tag.sprite);

  // ── Network sample ring ────────────────────────────────────────────────
  const ring = [];
  for (let i = 0; i < RING; i++) ring.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  let head_ = 0, count = 0;
  const st = { moving: false, sprinting: false, swimming: false, aboard: false, waving: false, torch: false };
  const interpMs = CONFIG.net?.interpolationMs ?? 120;
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function setTarget(pos, yaw, pitch, state) {
    const s = ring[head_];
    s.t = nowMs();
    if (Array.isArray(pos)) {
      s.x = +pos[0] || 0;
      s.y = +pos[1] || 0;
      s.z = +pos[2] || 0;
    } else if (pos) {
      s.x = pos.x || 0;
      s.y = pos.y || 0;
      s.z = pos.z || 0;
    }
    s.yaw = +yaw || 0;
    s.pitch = +pitch || 0;
    head_ = (head_ + 1) % RING;
    if (count < RING) count++;
    if (state) {
      st.moving = !!state.moving;
      st.sprinting = !!state.sprinting;
      st.swimming = !!state.swimming;
      st.aboard = !!state.aboard;
      st.waving = !!state.waving;
      st.torch = !!state.torch;
    }
  }

  // ── Animation state ────────────────────────────────────────────────────
  let t = 0, phase = 0, speed = 0, yawCur = 0, first = true;
  let px = 0, py = 0, pz = 0; // last rendered position (for the speed estimate)
  const lerp = (a, b, k) => a + (b - a) * k;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const swimLift = (CONFIG.player?.eyeHeight ?? 1.7) - 0.4;

  function sample(i) {
    // i = 0 → newest
    return ring[(head_ - 1 - i + RING * 2) % RING];
  }

  function resetPose() {
    hips.position.y = PROP.hipY;
    hips.rotation.set(0, 0, 0);
    torso.scale.set(1, 1, 1);
    torso.rotation.set(0, 0, 0);
    for (const a of [armL, armR]) {
      a.shoulder.rotation.set(0, 0, 0);
      a.elbow.rotation.set(0, 0, 0);
    }
    for (const l of [legL, legR]) {
      l.hip.rotation.set(0, 0, 0);
      l.knee.rotation.set(0, 0, 0);
    }
  }

  function animate(dt) {
    t += dt;
    resetPose();
    const breathe = Math.sin(t * 1.7);
    torso.scale.y = 1 + 0.015 * breathe;
    const moving = st.moving || speed > 0.35;
    const running = st.sprinting && speed > 3.2;

    if (st.aboard) {
      // Seated, paddling: low hips, legs forward, arms reaching forward in a slow stroke.
      hips.position.y = 0.44;
      hips.rotation.x = -0.12;
      for (const l of [legL, legR]) {
        l.hip.rotation.x = 1.35;
        l.knee.rotation.x = -1.05;
      }
      const stroke = Math.sin(t * 2.4);
      for (const a of [armL, armR]) {
        a.shoulder.rotation.x = 0.85 + stroke * 0.35;
        a.elbow.rotation.x = 0.55 + stroke * 0.2;
      }
      armL.shoulder.rotation.z = 0.15;
      armR.shoulder.rotation.z = -0.15;
    } else if (st.swimming) {
      // Prone at the surface, alternating overhead strokes, small leg kicks.
      phase += dt * 4.2;
      hips.position.y = swimLift;
      hips.rotation.x = -1.35;
      const sw = Math.sin(phase), cw = Math.sin(phase + Math.PI);
      armL.shoulder.rotation.x = 1.2 + sw * 1.5;
      armR.shoulder.rotation.x = 1.2 + cw * 1.5;
      armL.elbow.rotation.x = 0.4;
      armR.elbow.rotation.x = 0.4;
      legL.hip.rotation.x = Math.sin(phase * 2) * 0.3;
      legR.hip.rotation.x = -Math.sin(phase * 2) * 0.3;
      head.rotation.x = 0.9;
    } else if (moving) {
      const amp = clamp(speed / (running ? 6.5 : 3.6), 0.25, running ? 1.25 : 1);
      phase += dt * (running ? 11 : 7.5) * clamp(speed / (running ? 6 : 3), 0.5, 1.4);
      const s1 = Math.sin(phase), s2 = Math.sin(phase + Math.PI);
      legL.hip.rotation.x = s1 * 0.7 * amp;
      legR.hip.rotation.x = s2 * 0.7 * amp;
      legL.knee.rotation.x = -(0.15 + Math.max(0, -s1) * 0.9) * amp;
      legR.knee.rotation.x = -(0.15 + Math.max(0, -s2) * 0.9) * amp;
      armL.shoulder.rotation.x = s2 * 0.55 * amp;
      armR.shoulder.rotation.x = s1 * 0.55 * amp;
      armL.elbow.rotation.x = armR.elbow.rotation.x = 0.25 + 0.35 * amp;
      hips.position.y = PROP.hipY + Math.abs(Math.sin(phase)) * 0.045 * amp;
      hips.rotation.x = running ? -0.18 : -0.05;
      hips.rotation.y = Math.sin(phase) * 0.06 * amp;
    } else {
      // Idle: faint sway.
      armL.shoulder.rotation.x = Math.sin(t * 0.9) * 0.04;
      armR.shoulder.rotation.x = Math.sin(t * 0.9 + 1.3) * 0.04;
      armL.elbow.rotation.x = armR.elbow.rotation.x = 0.12;
      hips.rotation.y = Math.sin(t * 0.5) * 0.03;
    }
    if (st.waving && !st.swimming) {
      armR.shoulder.rotation.x = 2.75;
      armR.shoulder.rotation.z = -0.35;
      armR.elbow.rotation.x = -0.35 + Math.sin(t * 9) * 0.45;
    }
    torch.visible = st.torch;
    if (st.torch) {
      flame.scale.y = 0.85 + 0.3 * Math.sin(t * 23) * Math.sin(t * 7.3);
      flame.scale.x = flame.scale.z = 0.9 + 0.15 * Math.sin(t * 17);
      if (!st.swimming && !st.aboard) {
        armL.shoulder.rotation.x = 0.55;
        armL.elbow.rotation.x = 1.1;
      }
    }
  }

  function update(dt) {
    if (!count) {
      object.visible = false;
      return;
    }
    dt = clamp(dt || 0, 0, 0.1);
    const rt = nowMs() - interpMs;
    let x, y, z, yaw, pitch;
    let a = null, ai = -1;
    for (let i = 0; i < count; i++) {
      const s = sample(i);
      if (s.t <= rt) {
        a = s;
        ai = i;
        break;
      }
    }
    if (!a) {
      // Every sample is newer than the render time (just appeared): show the oldest.
      const s = sample(count - 1);
      x = s.x; y = s.y; z = s.z; yaw = s.yaw; pitch = s.pitch;
    } else if (ai > 0) {
      const b = sample(ai - 1);
      const k = b.t > a.t ? clamp((rt - a.t) / (b.t - a.t), 0, 1) : 1;
      x = lerp(a.x, b.x, k); y = lerp(a.y, b.y, k); z = lerp(a.z, b.z, k);
      yaw = a.yaw + angleDelta(a.yaw, b.yaw) * k;
      pitch = lerp(a.pitch, b.pitch, k);
    } else {
      // a is the newest sample: extrapolate briefly along the last velocity, then hold.
      x = a.x; y = a.y; z = a.z; yaw = a.yaw; pitch = a.pitch;
      if (count > 1) {
        const p = sample(1);
        const span = a.t - p.t;
        if (span > 0 && span < 1000) {
          const ex = Math.min(rt - a.t, EXTRAPOLATE_MS) / span;
          if (ex > 0) {
            x += (a.x - p.x) * ex;
            y += (a.y - p.y) * ex;
            z += (a.z - p.z) * ex;
          }
        }
      }
    }
    if (first) {
      px = x; py = y; pz = z; yawCur = yaw;
      first = false;
    }
    if (dt > 0) {
      const d = Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
      const inst = Math.min(12, d / dt);
      speed = lerp(speed, inst, 1 - Math.exp(-dt * 8));
    }
    px = x; py = y; pz = z;
    object.position.set(x, y, z);
    yawCur += angleDelta(yawCur, yaw) * (dt > 0 ? 1 - Math.exp(-dt * 14) : 1);
    object.rotation.y = yawCur;
    head.rotation.x = clamp(pitch, -1.2, 1.2) * 0.8;
    object.visible = true;
    animate(dt);

    if (tag) {
      const cam = ctx.camera;
      const dist = cam ? cam.position.distanceTo(object.position) : 0;
      const op = clamp((TAG_FAR - dist) / TAG_BAND, 0, 1);
      tag.material.opacity = op;
      tag.sprite.visible = op > 0.01;
      const f = 1 + dist / 30;
      tag.sprite.scale.set(1.6 * f, 0.4 * f, 1);
      tag.sprite.position.y = (st.swimming ? swimLift + 0.5 : st.aboard ? 1.55 : 2.08);
    }
  }

  function setName(n) {
    name = n || name;
    object.name = 'avatar:' + id;
    tag?.draw(name, color);
  }

  function dispose() {
    object.parent?.remove(object);
    for (const m of mats) m.dispose();
    if (tag) {
      tag.material.dispose();
      tag.texture.dispose();
    }
    count = 0;
  }

  return { object, setTarget, update, setName, dispose, get name() { return name; }, get color() { return color; }, state: st };
}
