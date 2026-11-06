// npm run check: syntax-check every source file, import every module in node, and run unit tests.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url).pathname;
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(f)) out.push(p);
  }
  return out;
}

let failed = 0;
const srcFiles = walk(join(root, 'src'));
for (const f of srcFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✗ syntax: ${relative(root, f)}\n${e.stderr}`);
  }
}
console.log(`syntax: ${srcFiles.length - failed}/${srcFiles.length} ok`);

// Import smoke test (modules must not touch the DOM at top level). CSS imports are skipped by node,
// so modules importing .css are only syntax-checked.
let importFails = 0;
for (const f of srcFiles) {
  if (f.endsWith('main.js')) continue;
  try {
    await import(pathToFileURL(f).href);
  } catch (e) {
    if (/Unknown file extension "\.css"/.test(String(e))) continue;
    importFails++;
    console.error(`✗ import: ${relative(root, f)}: ${e.message}`);
  }
}
console.log(`imports: ${importFails ? importFails + ' failed' : 'ok'}`);

let testFails = 0;
let tests = [];
try {
  tests = walk(join(root, 'tests')).filter((f) => f.endsWith('.test.mjs'));
} catch (_) {}
for (const t of tests) {
  try {
    execFileSync(process.execPath, [t], { stdio: 'pipe', cwd: root });
    console.log(`✓ test ${relative(root, t)}`);
  } catch (e) {
    testFails++;
    console.error(`✗ test ${relative(root, t)}\n${e.stdout}${e.stderr}`);
  }
}
process.exit(failed || importFails || testFails ? 1 : 0);
