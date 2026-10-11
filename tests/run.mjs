/**
 * `npm test`: every unit test in tests/ — the files beside this one, except the
 * browser test (app.mjs) — one after another, each in its own Node process.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skip = new Set(['run.mjs', 'app.mjs', 'app-finance.mjs', 'perf.mjs']);
let failed = 0;
for (const name of readdirSync(here).filter((n) => n.endsWith('.mjs') && !skip.has(n)).sort()) {
  const r = spawnSync(process.execPath, [join(here, name)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}
if (failed) {
  console.error(`${failed} test file(s) failed`);
  process.exit(1);
}
