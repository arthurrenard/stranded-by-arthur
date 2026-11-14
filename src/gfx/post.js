// Cheap in-game "post" grade (V4-D): vignette, lift/gain split-tone (cool shadows, warm highlights) and a
// faint film grain, drawn as two blended full-screen triangles ON TOP of the already rendered frame.
//
// Why not a WebGLRenderTarget + quad: three only tone-maps / sRGB-encodes when rendering to the screen, so an
// RT pass would need ACES in the quad shader, and the sky dome, clouds, rain and water (ShaderMaterials with
// toneMapped:false in sky.js / weather.js / water.js) would then be tone-mapped too and change color. The overlay
// keeps the frame bit-identical when disabled, keeps the canvas MSAA, triggers no material recompiles, and costs
// two blended full-screen draws with no texture fetch (well under 1 ms at 1080p; unmeasured).
//
//   createPost(ctx) -> { render(), setSize(w, h), enabled, strength }
//     render(): renderer.render(scene, camera), then the overlay (only in game: not on the title screen)
//     enabled=false (or ?nopost) falls back to a plain renderer.render(scene, camera)
//   Blending works on the display-space framebuffer values, so no tone mapping / colorspace chunks are used.
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// pass 1 (multiply): dst *= gain * vignette * (1 - grain)   (output must stay <= 1: it is clamped before blending)
const FRAG_MUL = /* glsl */ `
uniform vec3 uGain;
uniform float uVig;
uniform float uAspect;
uniform float uGrain;
uniform float uSeed;
varying vec2 vUv;
void main() {
  vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(d) / length(vec2(uAspect, 1.0) * 0.5);
  float vig = 1.0 - uVig * smoothstep(0.42, 1.05, r) * (0.75 + 0.25 * r);
  // interleaved gradient noise (no sin: stable precision on every GPU), re-seeded per frame
  vec2 p = gl_FragCoord.xy + 5.588238 * uSeed;
  float n = fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  gl_FragColor = vec4(clamp(uGain * vig * (1.0 - uGrain * n), 0.0, 1.0), 1.0);
}
`;

// pass 2 (add): dst += lift (cool, slightly stronger toward the frame edges, like a lens wash)
const FRAG_ADD = /* glsl */ `
uniform vec3 uLift;
varying vec2 vUv;
void main() {
  float e = length(vUv - 0.5) * 1.4142;
  gl_FragColor = vec4(uLift * (0.8 + 0.4 * e), 1.0);
}
`;

const IN_GAME = new Set(['intro', 'playing', 'paused', 'dead', 'rescued']);

export function createPost(ctx, opts = {}) {
  const renderer = ctx.renderer;
  const scene = ctx.scene;
  const camera = ctx.camera;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));

  const base = {
    vertexShader: VERT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  };
  const mulU = {
    uGain: { value: new THREE.Vector3(1.0, 0.985, 0.95) },
    uVig: { value: 0.2 },
    uAspect: { value: 16 / 9 },
    uGrain: { value: 0.035 },
    uSeed: { value: 0 },
  };
  const addU = { uLift: { value: new THREE.Vector3() } };
  const mulMat = new THREE.ShaderMaterial({ ...base, name: 'post-mul', uniforms: mulU, fragmentShader: FRAG_MUL, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor });
  const addMat = new THREE.ShaderMaterial({ ...base, name: 'post-add', uniforms: addU, fragmentShader: FRAG_ADD, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });

  const pScene = new THREE.Scene();
  pScene.matrixWorldAutoUpdate = false;
  const pCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mulMesh = new THREE.Mesh(geo, mulMat);
  const addMesh = new THREE.Mesh(geo, addMat);
  for (const [m, o] of [[mulMesh, 0], [addMesh, 1]]) {
    m.frustumCulled = false;
    m.renderOrder = o;
    m.matrixAutoUpdate = false;
    pScene.add(m);
  }

  const LIFT = [0.004, 0.008, 0.017]; // display-space cool lift at full daylight
  let frame = 0;
  const off = ctx.params?.has?.('nopost') || ctx.params?.get?.('post') === '0';

  const api = {
    enabled: opts.enabled ?? !off,
    /** 0..1 overall strength of the grade (vignette, gain, lift, grain). */
    strength: opts.strength ?? 1,
    render() {
      renderer.render(scene, camera);
      if (!api.enabled || !IN_GAME.has(ctx.state)) return;
      const k = Math.max(0, Math.min(1, api.strength));
      if (k <= 0) return;
      const day = ctx.uniforms?.uDaylight?.value ?? 1;
      // lift: weaker at night so darks stay deep (and navigable), not grey
      const lk = k * (0.35 + 0.65 * day);
      addU.uLift.value.set(LIFT[0] * lk, LIFT[1] * lk, LIFT[2] * lk);
      mulU.uGain.value.set(1, 1 - 0.015 * k, 1 - 0.05 * k); // warm highlights (blue pulled down most)
      mulU.uVig.value = 0.2 * k;
      mulU.uGrain.value = 0.035 * k;
      frame = (frame + 1) % 64;
      mulU.uSeed.value = frame;
      const autoClear = renderer.autoClear;
      const autoReset = renderer.info.autoReset;
      renderer.autoClear = false;
      renderer.info.autoReset = false;
      renderer.render(pScene, pCam);
      renderer.autoClear = autoClear;
      renderer.info.autoReset = autoReset;
    },
    setSize(w, h) {
      if (w > 0 && h > 0) mulU.uAspect.value = w / h;
    },
    dispose() {
      geo.dispose();
      mulMat.dispose();
      addMat.dispose();
    },
  };
  const el = renderer.domElement;
  if (el && el.clientWidth > 0) api.setSize(el.clientWidth, el.clientHeight);
  return api;
}
