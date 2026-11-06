// Shared GLSL snippets for the world shaders (terrain, water, sky, weather).
// Every function is prefixed with `w` so it never collides with three.js chunk names
// (common.glsl defines rand, saturate, pow2…). Pure strings: safe to import in node.

/** Hash, value noise and small fbm helpers (2D). */
export const NOISE_GLSL = /* glsl */ `
float wHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float wNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = wHash12(i);
  float b = wHash12(i + vec2(1.0, 0.0));
  float c = wHash12(i + vec2(0.0, 1.0));
  float d = wHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float wFbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * wNoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(3.7, 1.3);
    a *= 0.5;
  }
  return s / 0.875;
}
float wFbm5(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * wNoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(3.7, 1.3);
    a *= 0.5;
  }
  return s / 0.96875;
}
`;

/**
 * Sky cloud layer, shared by the dome (drawn clouds), the stars and the moon (occlusion),
 * so a star disappears exactly where a cloud is drawn. Needs NOISE_GLSL first.
 * Uniforms: uCloudOffset (vec2, scrolls with the wind), uCloudCover (0..1).
 */
export const CLOUD_GLSL = /* glsl */ `
uniform vec2 uCloudOffset;
uniform float uCloudCover;
vec2 wCloudCoord(vec3 dir) {
  // project the view ray onto a virtual cloud plane: perspective squeeze toward the horizon
  return dir.xz / (max(dir.y, 0.0) + 0.1) * 2.6 + uCloudOffset;
}
float wCloudThreshold() {
  return mix(0.72, 0.2, uCloudCover);
}
/** 0 clear .. 1 opaque cloud along a view direction. */
float wCloudDensity(vec3 dir) {
  if (dir.y <= 0.0) return 0.0;
  float d = wFbm5(wCloudCoord(dir));
  float t = wCloudThreshold();
  return smoothstep(t, t + 0.22, d) * smoothstep(0.0, 0.07, dir.y);
}
`;
