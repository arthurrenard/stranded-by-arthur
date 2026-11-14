# V4-D aesthetics pass (in-game look, not the title screen)

Goal: make the island read hand-art-directed (muted, warm, moody; Firewatch / A Short Hike palettes) while keeping
the low-poly charm. Files: src/world/terrain.js, src/world/sky.js, src/world/fx/{terrainColors,skyPalette}.js,
src/nature/flora/{palette,materials}.js, src/ui/hud.css (skin only), src/player/avatar.js (look only),
NEW src/gfx/post.js, NEW tests/aesthetics.test.mjs.

## 1. Terrain color (done)
- terrainColors.js: new muted sRGB palette (all PAL keys kept, new: sandWorn, grassSage, damp, crevice), grass swatches
  HSV sat <= 0.45 (max over the grass blend space measured 0.43). New optional 7th arg `ext = { n0, sun, cav }`:
  broad ~300 m sage/olive regions (n0), straw-dry grass on sun-facing slopes (sun = +z aspect; the sun path always
  leans +z, core/clock.js), dusty worn-sand fringe at the beach edge, extra damp green within 4 m above fresh water,
  slope + concavity AO toward a cool crevice tone, ridges slightly bleached. `hsvSat()` exported for tests.
- terrain.js: computes ext per land vertex (4 extra heightAt finite differences, AO_D = 3 m). At init() (retried
  on the first 5 updates if ctx.flora is missing) it darkens grass vertices under the canopy toward PAL.damp via
  ctx.flora.canopyAt (flora indexes crowns in create()). Shader: clump-scale warm/cool hue drift on grass; cache key
  bumped to world-terrain-v2. Tempest Isle "wild" recolor untouched.

## 2. Lighting + sky (done)
- skyPalette.js key frames: orange-tinted key light at sunrise/golden hour (sun 0xff8c46 / 0xffb066 / 0xffdab0),
  cooler lavender-blue hemisphere sky colors, warmer olive-brown ground bounce, deeper day zenith (0x2b69c0 at
  noon), warm-grey horizon haze. Night frames untouched. Golden-hour boost: sunI *= 1 + 0.22 * golden (new
  `st.golden`). Clear-day hemiI lowered 1.10 -> 0.76 (night floor 0.86 kept, overcast adds 0.3 back) so
  shadows read. A little more morning/evening fog haze. Removed the per-frame array allocations (storm/cloud
  scratch arrays + the `.map()` calls) via scratch fields on the state object.
- sky.js dome shader: haze exponent 0.55 -> 0.72 (wider, softer horizon), a low warm haze toward the sun side.
  Tempest Isle local storm fog + fogChunks.js untouched.

## 3. Foliage (done)
- palette.js: per-species muted greens (olive oak, sage willow, deep spruce pine, yellow-green birch with an
  autumn-gold light variant), darker warmer bark, softer flower pigments; grass tufts match the new terrain swatches.
- materials.js (shader only): per-plant jitter keyed on aWind.z (value +-8 % leaves / +-5 % bark, hue +-3 % via a
  rotation about the grey axis; skipped when aWind.z == 0, i.e. props without wind data); warm sun-side rim/wrap
  sheen on leaves (view-space normal vs sun dir, fresnel^3) added to the existing back-light emissive. Grass tufts:
  per-tuft value + straw/sage hue jitter hashed from the instance base. Cache keys suffixed '+v4d'.

## 5. HUD skin (done, hud.css only, no layout property touched: diffed width/height/padding/margin/font/gap/insets)
- Tokens on #hud: --hud-glass / --hud-glass-strong are now warm umber gradients, --hud-line a parchment-gold
  hairline, new --hud-inner (top bevel + dark inner keyline + bottom shade) and --hud-drop; muted --hud-good/warn/
  bad/cold; HUD-scoped --ink / --ink-dim / --accent (#dcaa5e). A faint text-shadow on #hud for legibility.
- Frosted glass removed everywhere (no backdrop-filter): .hud-glass, .toast, .panel (radius 18 -> 12 plus a 1px
  offset gold outline for a framed look), .screen-card. Rescue / storm pulse keyframes updated to the new base
  shadow. Compass, prompt pills, feed lines, chips, slots, keycaps, buttons and progress fills re-skinned; stat
  bars muted with a gold keyline. Remaining white-alpha fills/lines warmed. Border widths unchanged (1px / 1.5px).
- Emoji (inserted by JS): saturate(0.82), merged into the existing drop-shadow filters on .clk-icon / .slot-icon.

## 6. Avatars (done, look only; API, rig node names and animation untouched)
- Shared parts rebuilt: egg head on a neck, hair cap (tilted back) + 6 cone tufts, lathe torso (waist -> chest ->
  shoulders -> collar, squashed front-to-back) with a ragged hem ring, closed sleeves, lathe shorts + leg tubes,
  capsule limbs, hands / bare feet merged into forearm / shin. Same-bone same-material parts merged (local merge()
  helper, no extra import). 648 tris (680 with torch), 16 meshes (+2 torch). Measured in node.
- Softer colors: skin + hair palettes slightly muted; shirt = original color lerped 30 % toward warm grey, shorts =
  khaki/denim blend; name tag + `color` getter keep the original color. Shoulders 0.23 -> 0.215 (look only).

## 4. Post pass (done, src/gfx/post.js; NOT wired: main.js belongs to the orchestrator)
- `createPost(ctx, { enabled?, strength? }) -> { render(), setSize(w, h), enabled, strength, dispose() }`.
- Deliberately NOT a WebGLRenderTarget: three only tone-maps / sRGB-encodes when drawing to the screen, and the
  sky dome, clouds, rain and water are ShaderMaterials with toneMapped:false (sky.js, weather.js, water.js), so an
  RT + ACES-in-quad pass would tone-map them a second time and shift their colors (and lose canvas MSAA, and
  recompile every material when toggled). Instead: after the normal render, two blended full-screen triangles on
  the display-space framebuffer: multiply (warm gain 1/.985/.95 x vignette 0.2 x multiplicative grain 3.5 %) then
  add (cool lift ~(.004,.008,.017), weaker at night). No texture fetch, no allocations, autoClear/info.autoReset
  saved + restored. Only drawn in game (ctx.state intro/playing/paused/dead/rescued), never on the title screen.
  enabled=false or ?nopost / ?post=0 -> plain renderer.render. No S-curve (blending cannot read the destination).
- Wiring: main.js:354 `renderer.render(scene, camera)` -> `post.render()`; call `post.setSize(w, h)` on resize.

## Tests
- tests/aesthetics.test.mjs: terrain + flora PAL keys kept; grass swatches + blend sweep HSV sat <= 0.45 (0.426);
  flora greens <= 0.55; concavity AO ordering; skyState sweep finite/in range (storm + cloud), night hemiI >= 0.8,
  clear day lower, golden-hour key light warmer than noon; post overlay skip/restore/nopost logic.

## Known issues / tuning knobs (nothing checked in a browser yet)
- Overall image may read darker (clear-day hemiI 1.10 -> 0.76 + post multiply + ACES). Knobs: hemiI day term
  (skyPalette.js), crevice AO weight 0.42 + AO_D 3 m (terrainColors.js / terrain.js), grass hue drift 0.9 (terrain
  shader), leaf sheen 0.55 (materials.js), post uVig 0.2 / grain 0.035 / LIFT (post.js).
- Grass sat <= 0.45 is measured on baked vertex colors; the shader hue drift + warm key light can push the seen
  color slightly above it.
- Canopy damp floor is baked once at init: felled trees leave their damp patch.
- HUD: the type scale (font-size / line-height / letter-spacing) was deliberately left alone (it would move the
  zones). Only emoji inside icon-class elements are muted; emoji typed inline in JS text (storm banner, toasts,
  prompts) are not.
- Post grain uses interleaved gradient noise (no sin precision issues); leaf sheen is gated off below the horizon.
