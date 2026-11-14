// The rune puzzle, pure part (V4-A, SPEC §12): the 7 glyphs carved on the standing stones, the seeded
// 4-stone solution, the clue texts and the "which stones are lit" evaluation. No three.js, no DOM, no ctx:
// tested by tests/story.test.mjs. The same glyph data draws the stones (models.js), the small clue glyphs on the
// carved tree (eggCarving.js), the tally rock and the hut note (models.js), so the clues always match the stones.

/** Night window in which the runes can be touched (hours, wraps midnight). */
export const RUNE_NIGHT_START = 22;
export const RUNE_NIGHT_END = 5;
/** A wrong set must stay lit this long before the stones reject it. */
export const WRONG_SET_SEC = 3;
export const SOLUTION_SIZE = 4;

/**
 * 7 distinct glyphs: polylines in a unit box (x right, y down). Stone i always carries glyph i.
 * Every glyph has a name so prompts and journal clues can speak about them ("the Storm rune").
 */
export const GLYPHS = [
  { name: 'Storm', strokes: [[[0.58, 0.02], [0.3, 0.5], [0.62, 0.5], [0.4, 0.98]]] },
  { name: 'Peak', strokes: [[[0.08, 0.98], [0.5, 0.06], [0.92, 0.98]], [[0.32, 0.55], [0.68, 0.55]]] },
  { name: 'Wave', strokes: [[[0.06, 0.4], [0.28, 0.16], [0.5, 0.4], [0.72, 0.16], [0.94, 0.4]], [[0.06, 0.82], [0.28, 0.58], [0.5, 0.82], [0.72, 0.58], [0.94, 0.82]]] },
  { name: 'Moon', strokes: [[[0.66, 0.05], [0.4, 0.26], [0.32, 0.52], [0.42, 0.78], [0.68, 0.96]], [[0.66, 0.05], [0.84, 0.3], [0.88, 0.55], [0.82, 0.78], [0.68, 0.96]]] },
  { name: 'Root', strokes: [[[0.5, 0.02], [0.5, 0.55]], [[0.5, 0.55], [0.18, 0.98]], [[0.5, 0.55], [0.82, 0.98]], [[0.3, 0.3], [0.5, 0.42], [0.7, 0.3]]] },
  { name: 'Star', strokes: [[[0.5, 0.04], [0.5, 0.96]], [[0.1, 0.28], [0.9, 0.72]], [[0.9, 0.28], [0.1, 0.72]]] },
  { name: 'Fish', strokes: [[[0.06, 0.5], [0.42, 0.14], [0.78, 0.5], [0.42, 0.86], [0.06, 0.5]], [[0.78, 0.5], [0.96, 0.28]], [[0.78, 0.5], [0.96, 0.72]]] },
];
export const GLYPH_COUNT = GLYPHS.length;
export const glyphName = (i) => GLYPHS[i]?.name ?? '?';

/**
 * Stroke glyph `idx` into the canvas context `g` inside the box (x, y, w, h). The caller sets strokeStyle,
 * lineWidth, lineCap/lineJoin (so the same glyph can be a glowing rune or a scratched clue).
 */
export function drawGlyph(g, idx, x, y, w, h) {
  const gl = GLYPHS[((idx % GLYPH_COUNT) + GLYPH_COUNT) % GLYPH_COUNT];
  for (const s of gl.strokes) {
    g.beginPath();
    for (let k = 0; k < s.length; k++) {
      const px = x + s[k][0] * w, py = y + s[k][1] * h;
      if (k === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  }
}

/**
 * Seeded choice of the 4 solution stones (distinct indices 0..6, ascending). `rand` is a 0..1 function
 * (ctx.rng.fork('runes') or Math.random); the same stream always gives the same set.
 */
export function pickSolution(rand = Math.random, size = SOLUTION_SIZE) {
  const pool = [];
  for (let i = 0; i < GLYPH_COUNT; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)));
    const t = pool[i];
    pool[i] = pool[j];
    pool[j] = t;
  }
  return pool.slice(0, size).sort((a, b) => a - b);
}

/** The glyph names of a solution, in a fixed order, joined for prose ("Storm, Moon, Root and Fish"). */
export function solutionNames(solution) {
  const n = solution.map(glyphName);
  return n.length <= 1 ? n.join('') : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
}

/**
 * Evaluate the lit set against the solution:
 *   'idle'    nothing lit
 *   'partial' fewer than 4 lit (keep going)
 *   'solved'  exactly the solution
 *   'wrong'   4 or more lit and not the solution (rejected after WRONG_SET_SEC)
 */
export function evaluate(lit, solution) {
  const n = lit.size ?? lit.length ?? 0;
  const has = (i) => (lit.has ? lit.has(i) : lit.includes(i));
  if (n === 0) return 'idle';
  if (n === solution.length && solution.every(has)) return 'solved';
  return n >= solution.length ? 'wrong' : 'partial';
}

/** Hour window test that wraps midnight: 22..5 means 22:00 → 05:00. */
export function inRuneNight(hour, start = RUNE_NIGHT_START, end = RUNE_NIGHT_END) {
  const h = ((hour % 24) + 24) % 24;
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

/** Clue texts (journal + subtitles), all built from the same solution so they can never disagree. */
export function clueTexts(solution) {
  const names = solutionNames(solution);
  return {
    carving: `Under the initials, four small marks are cut into the bark: ${names}. The same marks as on the standing stones.`,
    tally: `Below the forty-three marks, a row of four strange glyphs is scratched into the rock: ${names}.`,
    logbook: `A page torn from the fisherman's logbook, nailed to the post: “…the four that face the storm — ${names}. Light them while the island sleeps and the sea will give you a road.”`,
  };
}
