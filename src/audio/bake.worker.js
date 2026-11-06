// Module worker that bakes sound recipes off the main thread (Builder F2), so first plays never hitch.
// audio.js posts { jobs: [[name, variant], ...] }; each finished buffer comes back as
// { name, v, sr, data: Float32Array } (transferred, not copied).
// Importing this file outside a worker (node smoke tests, main thread) does nothing.
import { RECIPES, renderSound } from './sounds.js';

const scope = typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function' ? self : null;

if (scope) {
  scope.onmessage = (e) => {
    const jobs = e.data?.jobs || [];
    for (const [name, v] of jobs) {
      try {
        const data = renderSound(name, v);
        if (data) scope.postMessage({ name, v, sr: RECIPES[name].sr, data }, [data.buffer]);
      } catch (err) {
        scope.postMessage({ name, v, error: String(err?.message || err) });
      }
    }
    scope.postMessage({ done: true });
  };
}
