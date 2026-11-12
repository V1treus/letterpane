import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.mjs';
import { createServer } from '../src/server.mjs';
import { startupPalette } from '../scripts/generate-native-theme.mjs';
import { themeSurfaces, contrast } from '../public/customize.js';

test('native startup uses the same readable colors as every interface theme', async () => {
  const palette = startupPalette(await readFile(new URL('../public/themes.css', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(palette), Object.keys(themeSurfaces));
  for (const [theme, colors] of Object.entries(palette)) {
    assert.equal(colors.background, themeSurfaces[theme]);
    assert.ok(contrast(colors.foreground, colors.background) >= 4.5);
  }
  assert.throws(() => startupPalette(':root { --surface:#fff; }'), /Missing startup color/);
});

test('saved themes reach the first HTML response and invalid settings leave startup hints intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'posta-startup-'));
  const themeFile = join(directory, 'ui-theme');
  const engine = new Engine({ snapshot: { settings: { theme: 'midnight' } } });
  await writeFile(themeFile, 'stale value');
  const app = await createServer(engine, { themeFile });
  const update = theme => fetch(app.origin + '/api/settings', { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }) });
  try {
    assert.equal(await readFile(themeFile, 'utf8'), 'midnight');
    const initial = await (await fetch(app.origin + '/')).text();
    assert.match(initial, /<html[^>]*data-theme="midnight"/);
    assert.ok(initial.indexOf('/startup.js') < initial.indexOf('/themes.css'));
    assert.equal((await fetch(app.origin + '/startup.js')).status, 200);
    for (const theme of ['dark', 'paper', 'graphite', 'light', 'system']) {
      assert.equal((await update(theme)).status, 200);
      assert.equal(await readFile(themeFile, 'utf8'), theme);
      assert.ok((await (await fetch(app.origin + '/')).text()).includes(`data-theme="${theme}"`));
    }
    assert.equal((await update('"><script>bad</script>')).status, 400);
    assert.equal(await readFile(themeFile, 'utf8'), 'system');
    // Rejected encrypted saves must not change the next launch's appearance.
    engine.vault = { save: async () => { throw new Error('synthetic write failure'); } };
    assert.equal((await update('dark')).status, 500);
    assert.equal(await readFile(themeFile, 'utf8'), 'system');
    assert.equal(engine.settings.theme, 'system');
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('unwritable startup hint does not prevent opening the encrypted profile settings', async () => {
  const engine = new Engine({ snapshot: { settings: { theme: 'paper' } } });
  const app = await createServer(engine, { themeFile: join(fileURLToPath(import.meta.url), 'not-a-directory') });
  try { assert.match(await (await fetch(app.origin + '/')).text(), /data-theme="paper"/); }
  finally { await new Promise(resolve => app.server.close(resolve)); }
});
