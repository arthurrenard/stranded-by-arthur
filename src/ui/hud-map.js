// Island map for the HUD (Builder E). The colored relief is baked progressively (a few rows per
// frame from init, so boot stays fast) from ctx.world heights + biomes into an RGBA buffer, then
// turned into a canvas on first draw. Fog of war: a coarse grid revealed around the player.
// The baking/fog logic is DOM-free; only draw() touches canvases.
import { MAP_LANDMARKS } from './hud-data.js';
import { clamp, smoothstep } from '../core/util.js';

export const MAP_RANGE = 380; // the map shows x,z in [-RANGE, RANGE] (wreck at z~353 included)
const BASE = 256; // baked relief resolution
const FOG = 96; // fog-of-war grid resolution (~7.9 m cells)
const REVEAL_R = 46; // meters revealed around the player

const C = {
  deeper: [16, 56, 92],
  deep: [29, 95, 138],
  shallow: [63, 183, 196],
  lake: [56, 156, 200],
  lakeDeep: [32, 104, 158],
  grass: [106, 154, 62],
  meadow: [150, 190, 84],
  forest: [58, 92, 42],
  highland: [122, 134, 90],
  rock: [140, 134, 124],
  sand: [232, 214, 168],
  wet: [92, 112, 62],
};

function mix(out, c, t) {
  if (t <= 0) return;
  if (t > 1) t = 1;
  out[0] += (c[0] - out[0]) * t;
  out[1] += (c[1] - out[1]) * t;
  out[2] += (c[2] - out[2]) * t;
}

export function createMap(ctx) {
  const world = ctx.world;
  const pixels = new Uint8ClampedArray(BASE * BASE * 4);
  const heights = new Float32Array(BASE * BASE);
  const kind = new Uint8Array(BASE * BASE); // 0 ocean, 1 fresh water, 2 land
  const fog = new Uint8Array(FOG * FOG); // 0 unexplored .. 255 explored
  const landFog = new Uint8Array(FOG * FOG); // 1 where the fog cell is land
  const discovered = new Set();
  let row = 0;
  let baked = false;
  let baseCanvas = null;
  let fogCanvas = null;
  let fogImg = null;
  const col = [0, 0, 0];
  const LX = -0.55, LY = 0.72, LZ = -0.42; // light from the north-west for hillshade

  const toWorld = (i, n) => -MAP_RANGE + ((i + 0.5) * 2 * MAP_RANGE) / n;

  function shadePixel(x, z, k) {
    const h = world.heightAt(x, z);
    heights[k] = h;
    const w = world.waterAt(x, z);
    if (w && w.type === 'ocean') {
      kind[k] = 0;
      const d = Math.max(0, -h);
      col[0] = C.shallow[0];
      col[1] = C.shallow[1];
      col[2] = C.shallow[2];
      mix(col, C.deep, smoothstep(0.3, 10, d));
      mix(col, C.deeper, smoothstep(12, 30, d));
    } else if (w) {
      kind[k] = 1;
      col[0] = C.lake[0];
      col[1] = C.lake[1];
      col[2] = C.lake[2];
      mix(col, C.lakeDeep, smoothstep(0.5, 5, w.depth));
    } else {
      kind[k] = 2;
      const b = world.biomeAt(x, z);
      col[0] = C.grass[0];
      col[1] = C.grass[1];
      col[2] = C.grass[2];
      mix(col, C.meadow, b.meadow);
      mix(col, C.forest, b.forest * 0.85);
      mix(col, C.highland, b.highland * 0.7);
      mix(col, C.wet, b.wet * 0.35);
      mix(col, C.rock, b.rock);
      mix(col, C.sand, b.sand);
      const n = world.normalAt(x, z);
      const s = clamp(0.62 + 0.55 * (n.x * LX + n.y * LY + n.z * LZ), 0.62, 1.22);
      col[0] *= s;
      col[1] *= s;
      col[2] *= s;
    }
    const p = k * 4;
    pixels[p] = col[0];
    pixels[p + 1] = col[1];
    pixels[p + 2] = col[2];
    pixels[p + 3] = 255;
  }

  function finishBake() {
    // contour lines every 8 m + light surf line along the coast
    for (let j = 0; j < BASE - 1; j++) {
      for (let i = 0; i < BASE - 1; i++) {
        const k = j * BASE + i;
        const p = k * 4;
        if (kind[k] === 2) {
          const a = Math.floor(heights[k] / 8), r = Math.floor(heights[k + 1] / 8), d = Math.floor(heights[k + BASE] / 8);
          if ((a !== r || a !== d) && heights[k] > 3) {
            pixels[p] *= 0.84;
            pixels[p + 1] *= 0.84;
            pixels[p + 2] *= 0.84;
          }
        } else if (kind[k] === 0 && (kind[k + 1] === 2 || kind[k + BASE] === 2 || (i > 0 && kind[k - 1] === 2) || (j > 0 && kind[k - BASE] === 2))) {
          pixels[p] = (pixels[p] + 235) / 2;
          pixels[p + 1] = (pixels[p + 1] + 248) / 2;
          pixels[p + 2] = (pixels[p + 2] + 245) / 2;
        }
      }
    }
    for (let j = 0; j < FOG; j++) {
      for (let i = 0; i < FOG; i++) {
        const bi = Math.min(BASE - 1, Math.floor(((i + 0.5) * BASE) / FOG));
        const bj = Math.min(BASE - 1, Math.floor(((j + 0.5) * BASE) / FOG));
        landFog[j * FOG + i] = kind[bj * BASE + bi] === 2 ? 1 : 0;
      }
    }
    baked = true;
  }

  /** Bake a few rows (call every frame until it returns true). */
  function bakeStep(rows = 6) {
    if (baked || !world) return baked;
    const end = Math.min(BASE, row + rows);
    for (; row < end; row++) {
      const z = toWorld(row, BASE);
      for (let i = 0; i < BASE; i++) shadePixel(toWorld(i, BASE), z, row * BASE + i);
    }
    if (row >= BASE) finishBake();
    return baked;
  }

  /** Reveal the fog of war around a world point. */
  function reveal(x, z, r = REVEAL_R) {
    const cell = (2 * MAP_RANGE) / FOG;
    const ci = Math.floor((x + MAP_RANGE) / cell), cj = Math.floor((z + MAP_RANGE) / cell);
    const n = Math.ceil(r / cell) + 1;
    for (let j = cj - n; j <= cj + n; j++) {
      if (j < 0 || j >= FOG) continue;
      for (let i = ci - n; i <= ci + n; i++) {
        if (i < 0 || i >= FOG) continue;
        const wx = toWorld(i, FOG), wz = toWorld(j, FOG);
        const d = Math.hypot(wx - x, wz - z);
        const v = Math.round(255 * smoothstep(r, r * 0.55, d));
        const k = j * FOG + i;
        if (v > fog[k]) fog[k] = v;
      }
    }
  }

  /** Newly discovered landmarks near (x, z). */
  function checkLandmarks(x, z) {
    const out = [];
    const lm = world?.landmarks;
    if (!lm) return out;
    for (const L of MAP_LANDMARKS) {
      if (discovered.has(L.key)) continue;
      const P = lm[L.key];
      if (!P) continue;
      if (Math.hypot(P.x - x, P.z - z) < L.range + (P.r || 0)) {
        discovered.add(L.key);
        out.push(L);
      }
    }
    return out;
  }

  function exploredFraction() {
    if (!baked) return 0;
    let land = 0, seen = 0;
    for (let k = 0; k < FOG * FOG; k++) {
      if (!landFog[k]) continue;
      land++;
      if (fog[k] > 128) seen++;
    }
    return land ? seen / land : 0;
  }

  const toPercent = (x, z) => [((x + MAP_RANGE) / (2 * MAP_RANGE)) * 100, ((z + MAP_RANGE) / (2 * MAP_RANGE)) * 100];

  /** Render the map into a canvas (browser only). */
  function draw(canvas) {
    if (!baked) while (!bakeStep(BASE));
    if (!baseCanvas) {
      baseCanvas = document.createElement('canvas');
      baseCanvas.width = baseCanvas.height = BASE;
      baseCanvas.getContext('2d').putImageData(new ImageData(pixels, BASE, BASE), 0, 0);
      fogCanvas = document.createElement('canvas');
      fogCanvas.width = fogCanvas.height = FOG;
      fogImg = fogCanvas.getContext('2d').createImageData(FOG, FOG);
    }
    for (let k = 0; k < FOG * FOG; k++) {
      const p = k * 4;
      fogImg.data[p] = 22;
      fogImg.data[p + 1] = 30;
      fogImg.data[p + 2] = 30;
      fogImg.data[p + 3] = Math.round((255 - fog[k]) * 0.9);
    }
    fogCanvas.getContext('2d').putImageData(fogImg, 0, 0);

    const W = canvas.width;
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.clearRect(0, 0, W, W);
    g.drawImage(baseCanvas, 0, 0, W, W);
    g.drawImage(fogCanvas, 0, 0, W, W);
    // 100 m grid
    const m2px = W / (2 * MAP_RANGE);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    for (let m = -300; m <= 300; m += 100) {
      const q = (m + MAP_RANGE) * m2px;
      g.beginPath();
      g.moveTo(q, 0);
      g.lineTo(q, W);
      g.moveTo(0, q);
      g.lineTo(W, q);
      g.stroke();
    }
    // north arrow
    g.fillStyle = 'rgba(255,246,226,0.92)';
    g.font = 'bold 18px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText('N', 34, 30);
    g.beginPath();
    g.moveTo(34, 36);
    g.lineTo(27, 56);
    g.lineTo(34, 51);
    g.lineTo(41, 56);
    g.closePath();
    g.fill();
    // scale bar (100 m)
    const sb = 100 * m2px;
    g.fillRect(24, W - 30, sb, 4);
    g.font = '12px system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText('100 m', 24, W - 38);
    // soft vignette
    const vg = g.createRadialGradient(W / 2, W / 2, W * 0.35, W / 2, W / 2, W * 0.72);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, W);
  }

  return {
    bakeStep,
    reveal,
    checkLandmarks,
    exploredFraction,
    toPercent,
    draw,
    discovered,
    get baked() {
      return baked;
    },
    fog,
  };
}
