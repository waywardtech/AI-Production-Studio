// Runs every *.test.mjs in this folder in its own process and reports
// a combined result. No framework: each test file prints PASS/FAIL lines
// and exits non-zero on failure.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
let failed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8' });
  const summary = (result.stdout.trim().split('\n').pop() || '').trim();
  const ok = result.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${file.padEnd(32)} ${summary}`);
  if (!ok) console.log(result.stdout + result.stderr);
}

console.log(`\n${files.length - failed}/${files.length} test files passed`);
process.exit(failed ? 1 : 0);
