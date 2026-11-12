import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createManifest } from './release-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Release version must be x.y.z');
const [operation, output] = process.argv.slice(2);
if (operation === 'native') {
  await mkdir(join(root, '.build'), { recursive: true });
  await writeFile(join(root, '.build', 'AssemblyInfo.cs'), '\uFEFFusing System.Reflection;\n' +
    `[assembly: AssemblyTitle("Letterpane")]\n[assembly: AssemblyProduct("Letterpane")]\n[assembly: AssemblyVersion("${pkg.version}.0")]\n[assembly: AssemblyFileVersion("${pkg.version}.0")]\n[assembly: AssemblyInformationalVersion("${pkg.version}")]\n`);
} else if (operation === 'manifest' && output) {
  const directory = resolve(output);
  const commit = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const info = { schema: 1, product: 'Letterpane', version: pkg.version, platform: 'win32', architecture: 'x64', node: process.version,
    webviewSdk: '1.0.4191.47', sourceCommit: commit.status === 0 && /^[0-9a-f]{40}$/.test(commit.stdout.trim()) ? commit.stdout.trim() : null,
    sourceModified: status.status !== 0 || status.stdout.trim().length > 0, signed: false };
  await writeFile(join(directory, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  await writeFile(join(directory, 'release-manifest.json'), JSON.stringify(await createManifest(directory, pkg.version), null, 2) + '\n');
} else throw new Error('Usage: prepare-release.mjs native | manifest <output-directory>');
