import { defineConfig } from 'vite';
export default defineConfig({
  // Relative asset URLs: the same build works at the domain root and under a subpath
  // such as https://<user>.github.io/stranded-by-arthur/ (GitHub Pages).
  base: './',
  server: {
    port: 5173,
    open: false,
    // Tooling output must not reload the running game (code graph rebuilds, notes, tests).
    watch: { ignored: ['**/graphify-out/**', '**/docs/**', '**/tests/**', '**/*.md'] },
  },
  build: { chunkSizeWarningLimit: 2000, target: 'es2022' },
});
