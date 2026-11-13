// Builder V3-C — procedural meshes for the vehicles: the paddle raft (a few InstancedMeshes, ~4 draw
// calls) and the paddle held in front of the camera while paddling. Materials + geometries are shared.
import * as THREE from 'three';
import { RAFT } from './vehicle-logic.js';

let shared = null;
function res() {
  if (shared) return shared;
  const log = new THREE.CylinderGeometry(0.17, 0.18, 1, 8, 1);
  log.rotateX(Math.PI / 2); // along Z
  shared = {
    mats: {
      log: new THREE.MeshStandardMaterial({ color: 0x76522f, roughness: 0.95 }),
      beam: new THREE.MeshStandardMaterial({ color: 0x5f4226, roughness: 0.95 }),
      plank: new THREE.MeshStandardMaterial({ color: 0xa27b4d, roughness: 0.9 }),
      rope: new THREE.MeshStandardMaterial({ color: 0xcdb27a, roughness: 1 }),
      paddle: new THREE.MeshStandardMaterial({ color: 0xa8804f, roughness: 0.85 }),
    },
    geo: {
      log,
      beam: new THREE.BoxGeometry(1, 0.08, 0.15),
      plank: new THREE.BoxGeometry(1, 0.045, 0.21),
      rope: new THREE.TorusGeometry(0.19, 0.026, 4, 10),
      shaft: new THREE.CylinderGeometry(0.022, 0.026, 1.45, 6),
      blade: new THREE.BoxGeometry(0.17, 0.44, 0.022),
    },
  };
  return shared;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

function instanced(geo, mat, list) {
  const m = new THREE.InstancedMesh(geo, mat, list.length);
  list.forEach((t, i) => {
    _e.set(t.rx || 0, t.ry || 0, t.rz || 0);
    _q.setFromEuler(_e);
    _p.set(t.x, t.y, t.z);
    _s.set(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
    m.setMatrixAt(i, _m.compose(_p, _q, _s));
  });
  m.instanceMatrix.needsUpdate = true;
  m.castShadow = true;
  m.receiveShadow = true;
  m.computeBoundingSphere?.();
  return m;
}

/**
 * The paddle raft: six lashed logs (bow toward local -Z), two cross beams, a small plank deck and rope
 * lashings. Origin at the waterline. Returns { group, body, seat } where `body` is what flips when it
 * capsizes and `seat` is an Object3D at eye height for the player (controller.setSeat).
 */
export function makePaddleRaft(rand = Math.random) {
  const { mats, geo } = res();
  const group = new THREE.Group();
  group.name = 'paddle-raft';
  group.rotation.order = 'YXZ';
  const body = new THREE.Group();
  group.add(body);
  const L = RAFT.length, n = 6;
  const logs = [];
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 0.33;
    const len = L * (0.9 + rand() * 0.12);
    logs.push({ x, y: 0.04 + rand() * 0.02, z: (rand() - 0.5) * 0.18, sz: len, rz: rand() * 3 });
  }
  body.add(instanced(geo.log, mats.log, logs));
  const beams = [-L * 0.36, L * 0.36].map((z) => ({ x: 0, y: 0.25, z, sx: 2.05 }));
  body.add(instanced(geo.beam, mats.beam, beams));
  const planks = [];
  for (let k = 0; k < 5; k++) planks.push({ x: 0, y: RAFT.deck - 0.02, z: 0.05 + k * 0.23, sx: 1.55 + rand() * 0.15, ry: (rand() - 0.5) * 0.05 });
  body.add(instanced(geo.plank, mats.plank, planks));
  const ropes = [];
  for (const z of [-L * 0.36, L * 0.36]) for (const x of [-0.66, 0.66]) ropes.push({ x, y: 0.17, z, ry: Math.PI / 2 });
  body.add(instanced(geo.rope, mats.rope, ropes));
  const seat = new THREE.Object3D();
  seat.position.set(0, RAFT.deck + RAFT.seatEye, 0.45);
  body.add(seat);
  return { group, body, seat };
}

/** The paddle you hold while aboard the raft (child of the camera; animate rotation for strokes). */
export function makeHandPaddle() {
  const { mats, geo } = res();
  const g = new THREE.Group();
  g.name = 'hand-paddle';
  const shaft = new THREE.Mesh(geo.shaft, mats.paddle);
  const blade = new THREE.Mesh(geo.blade, mats.paddle);
  blade.position.y = -0.86;
  g.add(shaft, blade);
  g.traverse((o) => {
    o.castShadow = false;
    o.frustumCulled = false;
  });
  g.visible = false;
  return g;
}
