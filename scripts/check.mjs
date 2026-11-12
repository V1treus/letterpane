import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
let failed = false;
for (const dir of ['src', 'public', 'shared', 'shared/locales', 'test', 'scripts', 'qa', 'qa/tests']) {
  for (const file of readdirSync(dir).filter(f => /\.(mjs|js)$/.test(f))) {
    const result = spawnSync(process.execPath, ['--check', join(dir, file)], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(result.stderr); failed = true; }
  }
}
if (failed) process.exit(1);
console.log('Syntax OK');
