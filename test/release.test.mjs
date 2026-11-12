import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedReleasePath, verifyEntries } from '../scripts/release-files.mjs';
import { sourceIssues } from '../scripts/source-policy.mjs';

test('release entry validation rejects profiles, traversal, links through path syntax and Windows path aliases', () => {
  for (const path of ['src/server.mjs', 'shared/locales/uk.mjs', 'runtime/node.exe', 'node_modules/mailparser/LICENSE', 'README.en.md']) assert.equal(allowedReleasePath(path), true, path);
  for (const path of ['.data/profile/accounts.vault', 'src/../profile', 'src//file', '/src/file', 'src\\file', 'src/file:stream', 'src/file.', 'src/file ', 'src/key.dpapi', 'node_modules/.env', 'src/accounts.vault', 'Posta Portable.data/a', 'Letterpane Portable.data/a', 'src/profile.lock', 'private.txt']) assert.equal(allowedReleasePath(path), false, path);
});

test('source preflight flags tracked private files and credentials without returning their values', () => {
  for (const path of ['.data/profile/accounts.vault', 'Posta Portable.data/ui-theme', 'Letterpane Portable.data/ui-theme', 'dist/Letterpane.exe', 'src/key.dpapi', '.env.local', 'private.key']) assert.ok(sourceIssues(path).length);
  assert.deepEqual(sourceIssues('.env.example', 'TOKEN=your-token-here'), []);
  const synthetic = 'M.' + 'x'.repeat(100);
  const issues = sourceIssues('src/example.mjs', 'first line\n' + synthetic);
  assert.equal(issues[0].rule, 'microsoft-refresh-token'); assert.equal(issues[0].line, 2);
  assert.equal(JSON.stringify(issues).includes(synthetic), false);
  assert.deepEqual(sourceIssues('test/example.mjs', "const token = 'private-refresh-token-for-local-tests-only';"), []);
});

test('release integrity detects altered, missing, extra and duplicate files', () => {
  const file = { path: 'src/server.mjs', size: 10, sha256: 'a'.repeat(64) };
  const manifest = { schema: 1, version: '1.3.1', files: [file] };
  const self = { path: 'release-manifest.json', size: 10, sha256: 'b'.repeat(64) };
  assert.doesNotThrow(() => verifyEntries(manifest, [file, self]));
  for (const entries of [[self], [file], [file, self, file], [{ ...file, sha256: 'b'.repeat(64) }, self], [{ ...file, size: 11 }, self], [file, self, { ...file, path: 'src/unexpected.mjs' }], [file, self, { ...file, path: '.data/key.dpapi' }]]) assert.throws(() => verifyEntries(manifest, entries));
});
