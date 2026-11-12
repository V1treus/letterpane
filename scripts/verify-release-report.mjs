import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, verifyEntries } from './release-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const report = JSON.parse((await readFile(process.argv[2], 'utf8')).replace(/^\uFEFF/, ''));
const required = ['Letterpane.exe', 'Letterpane Demo.exe', 'runtime/node.exe', 'runtime/NODE-LICENSE.txt', 'src/server.mjs', 'public/index.html', 'public/i18n.js', 'public/interaction.js', 'shared/locales/ru.mjs', 'shared/locales/en.mjs', 'shared/locales/uk.mjs', 'README.md', 'README.en.md', 'README.uk.md', 'LICENSE', 'build-info.json', 'THIRD-PARTY-NOTICES.md'];
for (const distribution of report.distributions) {
  verifyEntries(distribution.manifest, distribution.entries);
  if (distribution.manifest.version !== pkg.version || distribution.info.version !== pkg.version) throw new Error('Release version mismatch');
  if (distribution.info.product !== 'Letterpane') throw new Error('Release product name mismatch');
  if (distribution.info.node !== 'v' + (await readFile(join(root, '.node-version'), 'utf8')).trim()) throw new Error('Unexpected bundled Node.js version');
  const entries = new Map(distribution.entries.map(entry => [entry.path, entry]));
  for (const path of required) if (!entries.has(path)) throw new Error(`Missing required release file: ${path}`);
  if (entries.get('runtime/node.exe').sha256 !== 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32') throw new Error('Bundled Node.js does not match the official pinned binary');
  for (const entry of distribution.entries) {
    if (/^(?:src|public|shared|docs)\//.test(entry.path) || /^(?:package(?:-lock)?\.json|README(?:\.(?:en|uk))?\.md|LICENSE|PORTABLE\.md|DESIGN\.md|CHANGELOG\.md|CONTRIBUTING\.md|RELEASE_CHECKLIST\.md|SUPPORT\.md|SECURITY\.md|THIRD-PARTY-NOTICES\.md|Letterpane Demo\.cmd)$/.test(entry.path)) {
      if (entry.sha256 !== sha256(await readFile(join(root, entry.path)))) throw new Error(`Release contains stale source: ${entry.path}`);
    }
  }
  console.log(`${distribution.name}: ${entries.size} verified files`);
}
if (report.distributions.length !== 2 || report.nativeVersion !== pkg.version || report.portableVersion !== pkg.version) throw new Error('Native version information mismatch');
console.log('Release integrity OK. No profile entries; source and package contents match.');
