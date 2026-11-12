import { readdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const releaseDirectories = ['src', 'public', 'shared', 'runtime', 'node_modules', 'docs'];
export const releaseDocuments = ['package.json', 'package-lock.json', 'README.md', 'README.en.md', 'README.uk.md', 'LICENSE', 'PORTABLE.md', 'DESIGN.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'RELEASE_CHECKLIST.md', 'SUPPORT.md', 'SECURITY.md', 'THIRD-PARTY-NOTICES.md', 'Letterpane Demo.cmd', 'WEBVIEW2-LICENSE.txt', 'WEBVIEW2-NOTICE.txt', 'build-info.json'];
export const releaseBinaries = ['Letterpane.exe', 'Letterpane.exe.config', 'Letterpane Demo.exe', 'Letterpane Demo.exe.config', 'Letterpane.ico', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'];
export function allowedReleasePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes(':') || /[\x00-\x1f\x7f]/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) return false;
  if (parts.some(part => /^(?:\.data|Letterpane Portable\.data|Posta Portable\.data|webview-profile|webview-demo|key\.dpapi|accounts\.vault(?:\.tmp)?|profile\.lock|\.env(?:\..*)?)$/i.test(part))) return false;
  return releaseDocuments.includes(path) || releaseBinaries.includes(path) || path === 'release-manifest.json' || (parts.length > 1 && releaseDirectories.includes(parts[0]));
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function listFiles(root, directory = '') {
  const result = [];
  for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = directory ? directory + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Links are not allowed in release files: ${path}`);
    if (entry.isDirectory()) result.push(...await listFiles(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unsupported release file: ${path}`);
  }
  return result;
}
export async function releaseFiles(root) {
  const names = [...releaseDocuments, ...releaseBinaries];
  for (const directory of releaseDirectories) {
    if ((await lstat(join(root, directory))).isSymbolicLink()) throw new Error(`Links are not allowed: ${directory}`);
    const paths = await listFiles(root, directory);
    names.push(...(directory === 'node_modules' ? paths.filter(path => !/\.(?:d\.(?:ts|mts|cts)|map)$/i.test(path)) : paths));
  }
  return names.sort();
}
export async function createManifest(root, version) {
  const files = [];
  for (const path of await releaseFiles(root)) {
    if (!allowedReleasePath(path)) throw new Error(`Private or unsafe release path: ${path}`);
    if (!(await lstat(join(root, path))).isFile() || (await lstat(join(root, path))).isSymbolicLink()) throw new Error(`Not a regular release file: ${path}`);
    const bytes = await readFile(join(root, path));
    files.push({ path, size: bytes.length, sha256: sha256(bytes) });
  }
  return { schema: 1, version, files };
}
export function verifyEntries(manifest, entries) {
  if (manifest?.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid release manifest');
  const expected = new Map();
  for (const file of manifest.files) {
    if (!allowedReleasePath(file.path) || file.path === 'release-manifest.json' || expected.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid file record in release manifest');
    expected.set(file.path.toLowerCase(), file);
  }
  const seen = new Set();
  for (const entry of entries) {
    const name = entry.path.toLowerCase();
    if (!allowedReleasePath(entry.path) || seen.has(name)) throw new Error(`Unexpected or duplicate release entry: ${entry.path}`);
    seen.add(name);
    if (entry.path === 'release-manifest.json') continue;
    const file = expected.get(name);
    if (!file || file.path !== entry.path || file.size !== entry.size || file.sha256 !== entry.sha256) throw new Error(`Release integrity mismatch: ${entry.path}`);
  }
  if (seen.size !== expected.size + 1 || !seen.has('release-manifest.json')) throw new Error('Release files are missing');
}
