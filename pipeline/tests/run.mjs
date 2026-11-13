// Runs every *.test.mjs here in its own process. No framework.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  const ok = result.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${file.padEnd(28)} ${(result.stdout.trim().split('\n').pop() || '').trim()}`);
  if (!ok) console.log(result.stdout + result.stderr);
}
console.log(`\n${files.length - failed}/${files.length} pipeline test files passed`);
process.exit(failed ? 1 : 0);
