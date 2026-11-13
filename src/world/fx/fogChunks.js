// v3 sea haze: patches three's fog shader chunks once (before any program compiles) so the exp² fog
// - thins as the camera climbs (base density x 0.75 above ~55 m), and
// - gains a far "gloomy distance" haze around Tempest Isle (its own murky microclimate), only for fragments
//   > ~280 m from the camera, > ~400 m from the main island center and within ~420-760 m of the isle, and
//   only for a low camera. The rest of the seascape keeps the old exp² look.
// Result: Tempest Isle is a faint grey outline from the main beaches (~80-87 % fogged at 550-750 m), clearly
// visible from the main summit (<= ~50 % at 800 m), while everything on the main island looks exactly as
// before from the ground. Rain/storm density (sky.js) still wipes it out. Needs the fragment-prefix
// `cameraPosition` uniform that three declares for every non-raw material; the world xz of the fragment
// travels in a new varying (vFogXZ) written next to vFogDepth.
//
// Custom shaders that compute their own fog fade from vFogDepth (fx.js, fireflies) keep working: the
// extra varying is declared + written by fog_pars_vertex / fog_vertex and simply unused there.

export const SEA_HAZE = {
  altLow: 6, // m: camera y below this = full sea haze, unchanged base density
  altHigh: 55, // m: camera y above this = no sea haze, base density x (1 - altThin)
  altThin: 0.25,
  far: 1.3, // extra optical depth of the sea haze (exponent)
  near0: 280, // m from the camera: haze starts
  near1: 600, // m: full haze
  main0: 400, // m from the main island center: no haze over the main island
  main1: 580,
  isle0: 420, // m from the Tempest Isle center: full haze inside, none beyond isle1
  isle1: 760,
  isleX: 660, // default isle center (heightfield ISLE2); installSeaHaze(THREE, ctx.world.isle2) overrides
  isleZ: -640,
};

const H = SEA_HAZE;
const f1 = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

const PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec2 vFogXZ;
#endif
`;
const VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogXZ = cameraPosition.xz + ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xz;
#endif
`;
const PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec2 vFogXZ;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;
const fragment = (ix, iz) => /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float wfAlt = smoothstep( ${f1(H.altLow)}, ${f1(H.altHigh)}, cameraPosition.y );
		float wfD = fogDensity * vFogDepth * ( 1.0 - ${f1(H.altThin)} * wfAlt );
		float wfZone = smoothstep( ${f1(H.main0)}, ${f1(H.main1)}, length( vFogXZ ) ) * ( 1.0 - smoothstep( ${f1(H.isle0)}, ${f1(H.isle1)}, length( vFogXZ - vec2( ${f1(ix)}, ${f1(iz)} ) ) ) );
		float wfFar = ${f1(H.far)} * ( 1.0 - wfAlt ) * smoothstep( ${f1(H.near0)}, ${f1(H.near1)}, vFogDepth ) * wfZone;
		float fogFactor = 1.0 - exp( - wfD * wfD - wfFar );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;

/**
 * Patch THREE.ShaderChunk (idempotent per isle center). Call before the first render; isle = { x, z }
 * (ctx.world.isle2), default the heightfield's Tempest Isle center.
 */
export function installSeaHaze(THREE, isle = null) {
  const C = THREE?.ShaderChunk;
  if (!C) return false;
  const ix = Math.round(Number.isFinite(isle?.x) ? isle.x : H.isleX);
  const iz = Math.round(Number.isFinite(isle?.z) ? isle.z : H.isleZ);
  const key = ix + ',' + iz;
  if (C.__seaHaze === key) return false;
  H.isleX = ix;
  H.isleZ = iz;
  C.fog_pars_vertex = PARS_VERTEX;
  C.fog_vertex = VERTEX;
  C.fog_pars_fragment = PARS_FRAGMENT;
  C.fog_fragment = fragment(ix, iz);
  C.__seaHaze = key;
  return true;
}

const sstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * CPU mirror of the patched fog factor (for tests / gameplay checks).
 * density: scene.fog.density; depth: view depth (m); camY: camera y; fx, fz: the fragment's world xz.
 */
export function seaHazeFog(density, depth, camY, fx, fz) {
  const alt = sstep(H.altLow, H.altHigh, camY);
  const d = density * depth * (1 - H.altThin * alt);
  const zone = sstep(H.main0, H.main1, Math.hypot(fx, fz)) * (1 - sstep(H.isle0, H.isle1, Math.hypot(fx - H.isleX, fz - H.isleZ)));
  const far = H.far * (1 - alt) * sstep(H.near0, H.near1, depth) * zone;
  return 1 - Math.exp(-d * d - far);
}
