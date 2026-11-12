import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, mkdtemp, rm, access, realpath } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const distribution = resolve(process.argv[2] || join(root, 'dist', `Letterpane ${pkg.version}`));
const verification = join(root, '.build', 'verification');
await mkdir(verification, { recursive: true });
const directory = await mkdtemp(join(verification, 'smoke-'));
const ownedDirectory = await realpath(directory);
const realProfile = join(directory, 'profile-run'), demoProfile = join(directory, 'demo-run');
const children = new Set();

async function launch(profile, demo = false) {
  const child = spawn(join(distribution, 'runtime', 'node.exe'), [join(distribution, 'src', 'server.mjs'), '--native', ...(demo ? ['--demo'] : [])], {
    cwd: distribution, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, POSTA_DATA_DIR: profile, POSTA_LANG: 'en', POSTA_PORTABLE_MODE: '1' }
  });
  children.add(child); child.stderr.resume(); child.stdin.on('error', () => {});
  const exited = new Promise(resolve => child.once('close', code => { children.delete(child); resolve(code); }));
  const lines = createInterface({ input: child.stdout });
  let timer;
  const ready = await new Promise((accept, reject) => {
    timer = setTimeout(() => reject(new Error('Packaged service startup timed out')), 25000);
    child.once('error', () => reject(new Error('Could not start packaged Node.js')));
    exited.then(() => reject(new Error('Packaged service exited before becoming ready')));
    lines.on('line', line => {
      if (line.startsWith('POSTA_READY:')) {
        try { accept(JSON.parse(line.slice(12))); } catch { reject(new Error('Invalid packaged service handshake')); }
      }
    });
  }).finally(() => clearTimeout(timer));
  // The handshake contains an ephemeral bearer token; never print it or the URL.
  const url = new URL(ready.url), origin = new URL(ready.origin);
  assert.equal(origin.hostname, '127.0.0.1'); assert.equal(origin.protocol, 'http:');
  assert.equal(url.origin, origin.origin); assert.match(url.hash, /^#[a-f0-9]{64}$/);
  const token = url.hash.slice(1);
  return {
    origin: origin.origin,
    theme: ready.theme,
    async request(path, data, language = 'en') {
      const response = await fetch(origin.origin + path, { method: data === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${token}`, 'Accept-Language': language, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      assert.equal(response.status, 200, `Packaged endpoint failed: ${path}`);
      return response.json();
    },
    async close() {
      child.stdin.end();
      let closeTimer;
      try { await Promise.race([exited, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Packaged service did not shut down')), 10000); })]); }
      finally { clearTimeout(closeTimer); lines.close(); }
      assert.equal(child.exitCode, 0);
    }
  };
}

try {
  let app = await launch(realProfile);
  let state = await app.request('/api/state');
  assert.equal(state.version, pkg.version); assert.equal(state.settings.language, 'en');
  assert.equal(state.accounts.length, 0); assert.equal(state.settings.auto, false);
  assert.equal((await fetch(app.origin + '/api/state')).status, 401);
  for (const path of ['/', '/startup.js', '/app.js', '/i18n.js', '/interaction.js', '/style.css', '/themes.css', '/shared/locales/uk.mjs']) assert.equal((await fetch(app.origin + path)).status, 200, path);
  const syntheticToken = 'private-refresh-token-for-release-smoke-only';
  await app.request('/api/import', { text: `smoke@example.com|unused-password|${syntheticToken}|12345678-1234-1234-1234-123456789abc|recovery@example.net` });
  state = await app.request('/api/state');
  const account = state.accounts[0];
  await app.request(`/api/accounts/${account.id}/meta`, { label: 'Тестова скринька', group: 'Перевірка', note: 'Synthetic release smoke only' });
  await app.request('/api/settings', { language: 'uk', theme: 'paper' });
  assert.equal((await app.request('/api/state')).queue.length, 0);
  await app.close();
  const encrypted = await readFile(join(realProfile, 'profile', 'accounts.vault'), 'utf8');
  assert.equal(encrypted.includes(syntheticToken), false); assert.equal(encrypted.includes('smoke@example.com'), false);
  assert.equal(encrypted.includes('unused-password'), false); assert.equal(encrypted.includes('recovery@example.net'), false);
  assert.equal(await readFile(join(realProfile, 'ui-language'), 'utf8'), 'uk');
  assert.equal(await readFile(join(realProfile, 'ui-theme'), 'utf8'), 'paper');
  app = await launch(realProfile);
  assert.equal(app.theme, 'paper');
  assert.match(await (await fetch(app.origin + '/')).text(), /data-theme="paper"/);
  state = await app.request('/api/state');
  assert.equal(state.settings.language, 'uk'); assert.equal(state.settings.theme, 'paper');
  assert.equal(state.accounts[0].label, 'Тестова скринька'); assert.equal(state.accounts[0].group, 'Перевірка');
  assert.equal(state.settings.requestGap, 5); assert.equal(state.settings.accountGap, 60);
  assert.equal(state.queue.length, 0); assert.equal(state.active, null); assert.equal(JSON.stringify(state).includes(syntheticToken), false);
  await app.close();
  await assert.rejects(access(join(realProfile, 'profile', 'profile.lock')));
  console.log('Packaged service: encrypted profile, language, startup theme, restart, version and API checks passed. No mailbox sync was requested.');

  app = await launch(demoProfile, true);
  await app.request('/api/demo/size', { count: 500 });
  state = await app.request('/api/state');
  assert.equal(state.demo, true); assert.equal(state.accounts.length, 500);
  const path = `/api/accounts/${state.accounts[0].id}/messages?folder=inbox`;
  const original = await app.request(path);
  for (const language of ['ru', 'en', 'uk']) {
    await app.request('/api/settings', { language });
    assert.deepEqual(await app.request(path), original, 'Language must never change message content');
    assert.equal((await app.request('/api/state')).settings.language, language);
  }
  assert.ok((await app.request('/api/codes')).rows.length > 0);
  await app.close();
  console.log('Packaged demo: 500 accounts, cached codes and unchanged mail content across all three interface languages passed.');
  const occupiedPath = join(directory, 'occupied-profile');
  await writeFile(occupiedPath, 'keep this synthetic file');
  for (const [language, expected] of [['en', 'profile path'], ['uk', 'Шлях профілю'], ['ru', 'Путь профиля']]) {
    const output = await new Promise((accept, reject) => {
      const child = spawn(join(distribution, 'runtime', 'node.exe'), [join(distribution, 'src', 'server.mjs'), '--native'], { cwd: distribution, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, POSTA_DATA_DIR: occupiedPath, POSTA_LANG: language } });
      children.add(child); let error = '', standard = '';
      child.stdout.on('data', data => { standard += data; }); child.stderr.on('data', data => { error += data; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('Startup failure check timed out')); }, 10000);
      child.on('error', () => { clearTimeout(timer); reject(new Error('Could not launch startup failure check')); });
      child.on('close', code => { clearTimeout(timer); children.delete(child); accept({ code, error, standard }); });
      child.stdin.end();
    });
    assert.equal(output.code, 1); assert.equal(output.standard, '');
    assert.ok(output.error.includes(expected)); assert.equal(output.error.includes(occupiedPath), false);
  }
  assert.equal(await readFile(occupiedPath, 'utf8'), 'keep this synthetic file');
  console.log('Packaged startup failures: occupied profile path fails safely in RU/EN/UK without changing the blocking file.');
} finally {
  for (const child of children) { child.stdin.end(); child.kill(); }
  if (children.size) await Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve))));
  assert.equal(dirname(ownedDirectory), await realpath(verification));
  assert.ok(basename(ownedDirectory).startsWith('smoke-'));
  assert.equal(await realpath(directory), ownedDirectory);
  await rm(ownedDirectory, { recursive: true, force: true });
}
