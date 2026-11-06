// "A.R. ♥ this island" carved into the bark of the landmark oak (Builder F2, easter egg 6).
// A canvas texture (cut-through-bark letters showing pale inner wood, with a dark upper groove wall and a
// lit lower lip) on a partial open cylinder that hugs the trunk. Node-safe: without a DOM the texture is
// null and the mesh is invisible (geometry still builds, so it can be smoke-tested).
import * as THREE from 'three';
import { canvasTexture, prng } from './models.js';

const PI = Math.PI;

function heartPath(g, cx, cy, s) {
  g.beginPath();
  g.moveTo(cx, cy + s * 0.42);
  g.bezierCurveTo(cx - s * 0.62, cy - s * 0.02, cx - s * 0.5, cy - s * 0.62, cx, cy - s * 0.26);
  g.bezierCurveTo(cx + s * 0.5, cy - s * 0.62, cx + s * 0.62, cy - s * 0.02, cx, cy + s * 0.42);
  g.closePath();
}

/** Draw one layer of the inscription with fillStyle/offset; `shapes` = [{ text, x, y, font } | { heart, x, y, s }]. */
function drawLayer(g, shapes, dx, dy, style) {
  g.fillStyle = style;
  for (const s of shapes) {
    if (s.heart) {
      heartPath(g, s.x + dx, s.y + dy, s.s);
      g.fill();
    } else {
      g.font = s.font;
      g.fillText(s.text, s.x + dx, s.y + dy);
    }
  }
}

export function drawCarving(g, w, h) {
  const r = prng(4242);
  g.clearRect(0, 0, w, h);
  // 1. A smoothed, slightly paler patch of bark where the knife worked (soft edges blend into the trunk).
  const patch = g.createRadialGradient(w / 2, h / 2, h * 0.12, w / 2, h / 2, w * 0.5);
  patch.addColorStop(0, 'rgba(118,92,64,0.42)');
  patch.addColorStop(0.7, 'rgba(98,76,52,0.22)');
  patch.addColorStop(1, 'rgba(80,62,44,0)');
  g.fillStyle = patch;
  g.fillRect(0, 0, w, h);

  // 2. Layout: "A.R. ♥" on top, "this island" below, scaled to fit.
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const f1 = 'bold 96px Georgia, "Times New Roman", serif';
  g.font = f1;
  const wAR = g.measureText('A.R.').width;
  const hs = 82, gap = 26;
  const line1W = wAR + gap + hs;
  const x1 = (w - line1W) / 2, y1 = h * 0.43;
  let size2 = 80;
  g.font = `bold ${size2}px Georgia, "Times New Roman", serif`;
  const tw = g.measureText('this island').width;
  if (tw > w * 0.88) size2 = Math.floor((size2 * w * 0.88) / tw);
  const f2 = `bold ${size2}px Georgia, "Times New Roman", serif`;
  g.font = f2;
  const w2 = g.measureText('this island').width;
  const shapes = [
    { text: 'A.R.', x: x1, y: y1, font: f1 },
    { heart: true, x: x1 + wAR + gap + hs / 2, y: y1 - 34, s: hs },
    { text: 'this island', x: (w - w2) / 2, y: h * 0.8, font: f2 },
  ];

  // 3. Inset look: pale lower lip, dark upper groove wall, then the exposed inner wood on top.
  drawLayer(g, shapes, 2, 4, 'rgba(214,186,140,0.55)');
  drawLayer(g, shapes, -1, -3, 'rgba(26,16,9,0.92)');
  drawLayer(g, shapes, 0, 0, '#b48a5a');

  // 4. Grain + knife chatter, only inside the letters (source-atop keeps strokes on existing alpha).
  g.save();
  g.globalCompositeOperation = 'source-atop';
  const shade = g.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, 'rgba(60,36,18,0.35)');
  shade.addColorStop(0.5, 'rgba(60,36,18,0)');
  shade.addColorStop(1, 'rgba(60,36,18,0.3)');
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 70; i++) {
    const x = r() * w;
    g.strokeStyle = r() < 0.5 ? 'rgba(110,72,40,0.45)' : 'rgba(225,196,150,0.3)';
    g.lineWidth = 1 + r() * 1.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.bezierCurveTo(x + (r() - 0.5) * 12, h * 0.33, x + (r() - 0.5) * 12, h * 0.66, x + (r() - 0.5) * 8, h);
    g.stroke();
  }
  g.restore();

  // 5. A few stray knife scratches around the inscription (weathered, half-healed).
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const x = w * (0.1 + r() * 0.8), y = h * (0.08 + r() * 0.86), l = 14 + r() * 26, a = (r() - 0.5) * 1.4 + PI / 2 * (r() < 0.3 ? 1 : 0);
    const ex = x + Math.cos(a) * l, ey = y + Math.sin(a) * l;
    g.strokeStyle = 'rgba(24,14,8,0.6)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x, y - 1);
    g.lineTo(ex, ey - 1);
    g.stroke();
    g.strokeStyle = 'rgba(176,138,96,0.55)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x, y + 1);
    g.lineTo(ex, ey + 1);
    g.stroke();
  }
}

/**
 * createCarving({ radius, height, arc }) -> { mesh, texture }
 * The mesh is a partial open cylinder of `radius` (pass trunkR + a hair) centered on local +Z, spanning `arc`
 * radians and `height` m, centered at local y = 0. Rotate it with rotation.y = atan2(dx, dz) to face (dx, dz).
 * u grows toward the viewer's right (x = r·sinθ, θ increasing), v = 1 at the top: the text reads correctly.
 */
export function createCarving({ radius = 0.6, height = 0.6, arc = 1.45 } = {}) {
  const tex = canvasTexture(512, Math.round((512 * height) / (radius * arc)), drawCarving);
  const geo = new THREE.CylinderGeometry(radius, radius, height, 24, 1, true, -arc / 2, arc);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: tex,
    transparent: true,
    opacity: tex ? 1 : 0,
    alphaTest: 0.02,
    roughness: 0.95,
    metalness: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'carved-initials';
  mesh.renderOrder = 2;
  mesh.visible = !!tex;
  return { mesh, texture: tex };
}
