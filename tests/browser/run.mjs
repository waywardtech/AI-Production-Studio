// Runs the browser tests, each in its own Chrome.
//
// Separate from `npm test` on purpose: these need a real browser and
// playwright-core, and `npm test` stays dependency-free and instant.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));

try {
  await import('playwright-core');
} catch {
  console.log(
    'Browser tests need playwright-core:\n' +
      '  npm install --no-save playwright-core\n' +
      'and a Chrome. Set CHROME_PATH if it is somewhere unusual.'
  );
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.browser.mjs')).sort();
let failed = 0;

for (const file of files) {
  console.log(`\n${file}`);
  const result = spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8' });
  process.stdout.write(result.stdout);
  if (result.status !== 0) {
    failed += 1;
    process.stdout.write(result.stderr);
  }
}

console.log(`\n${files.length - failed}/${files.length} browser test files passed`);
process.exit(failed ? 1 : 0);
