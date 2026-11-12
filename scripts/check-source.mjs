import { execFileSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceIssues } from './source-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const paths = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean))];
let failures = 0;
for (const path of paths) {
  const stat = await lstat(join(root, path));
  let issues = sourceIssues(path);
  if (stat.isSymbolicLink() || !stat.isFile()) issues.push({ rule: 'source-link-or-special-file', line: 1 });
  else if (/\.(?:mjs|js|ts|py|cs|ps1|md|txt|csv|toml|json|ya?ml|html|css|cmd|svg)$|(?:^|\/)(?:LICENSE|\.gitignore|\.gitattributes|\.node-version)$/.test(path)) {
    if (stat.size > 2 * 1024 * 1024) issues.push({ rule: 'source-file-too-large-to-scan', line: 1 });
    else issues.push(...sourceIssues('', await readFile(join(root, path), 'utf8')));
  }
  for (const issue of issues) {
    // Never print matching content, which could itself be a credential.
    console.error(`${JSON.stringify(path)}:${issue.line}: ${issue.rule}`); failures++;
  }
}
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version || JSON.stringify(pkg.dependencies) !== JSON.stringify(lock.packages[''].dependencies)) { console.error('package.json and package-lock.json do not agree'); failures++; }
if (failures) process.exitCode = 1;
else console.log(`Source preflight OK: ${paths.length} files; no profile paths or recognized credential patterns. This is not an exhaustive secret scan.`);
