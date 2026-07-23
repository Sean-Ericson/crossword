/*
 * run_tests.mjs — zero-dependency test runner.
 * Discovers and imports every tests/test_*.mjs module; each registers cases
 * via the global `test(name, fn)`. Usage: node tests/run_tests.mjs
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];

globalThis.test = (name, fn) => {
  try {
    fn();
    results.push({ name, error: null });
  } catch (error) {
    results.push({ name, error });
  }
};

const files = readdirSync(here)
  .filter((f) => /^test_.*\.mjs$/.test(f))
  .sort();

for (const f of files) {
  await import(pathToFileURL(path.join(here, f)).href);
}

let failed = 0;
for (const { name, error } of results) {
  if (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(String(error.message || error).split('\n').map((l) => '      ' + l).join('\n'));
  } else {
    console.log(`ok    ${name}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
