import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { validateSettings, DEFAULT_SETTINGS } from '../src/settings.mjs';
import { createDemo } from '../src/demo.mjs';
import { createServer } from '../src/server.mjs';
import { selectAccounts, pageRows, virtualRange } from '../public/view-model.js';
import { accentPalette, contrast, accountRowHeight, resolveTheme, themeSurfaces } from '../public/customize.js';

const client = '12345678-1234-1234-1234-123456789abc';
const token = 'private-refresh-token-for-local-tests-only';
const rows = count => Array.from({ length: count }, (_, i) => `reader${String(i).padStart(3, '0')}@example.com:${token}:${client}`).join('\n');
async function profile(count = 10, options = {}) {
  const engine = new Engine({ loader: async () => ({ messages: [], validity: '1' }), now: () => 1000000, jitter: () => 0, ...options });
  await engine.import(rows(count)); return engine;
}
test('old profiles migrate appearance and retain original account credentials and pause limits', () => {
  const engine = new Engine({ snapshot: { settings: { auto: false, interval: 180, limit: 15, paused: false }, accounts: [{ id: 'old', email: 'a@example.com', clientId: client, refreshToken: token, enabled: true, nextAllowed: 999999999 }] } });
  assert.equal(engine.settings.interval, 180); assert.equal(engine.settings.theme, 'system'); assert.equal(engine.account('old').favorite, false);
  assert.equal(engine.account('old').nextAllowed, 999999999); assert.equal(engine.snapshot().accounts[0].refreshToken, token);
});
test('appearance survives snapshot/restart and partial setting updates retain other settings', async () => {
  const engine = await profile(); await engine.updateSettings({ theme: 'dark', accent: '#157D70', density: 'compact', fontSize: 16, sidebarWidth: 300 });
  await engine.updateSettings({ auto: true });
  const next = new Engine({ snapshot: engine.snapshot() }); assert.equal(next.settings.theme, 'dark'); assert.equal(next.settings.accent, '#157d70'); assert.equal(next.settings.sidebarWidth, 300); assert.equal(next.settings.auto, true);
});
test('invalid settings cannot lower the rate floors or inject CSS', () => {
  for (const change of [{ requestGap: 4 }, { accountGap: 59 }, { maxAttempts: 4 }, { theme: 'unknown' }, { accent: '#fff;url(http://bad)' }, { fontSize: '16' }, { cacheMB: 1024 }]) assert.throws(() => validateSettings(change));
  assert.equal(validateSettings({ extra: 'ignored' }).extra, undefined); assert.deepEqual(validateSettings({}), DEFAULT_SETTINGS);
});

test('new presentation options survive restart without changing request settings', async () => {
  const engine = await profile();
  await engine.updateSettings({ theme: 'graphite', density: 'spacious', readerPosition: 'bottom', readingFont: 'serif', readingSize: 20, sidebarStyle: 'accent', corners: 'square', showStatusBar: false, showCodeBadges: false, showGroupLabels: false });
  const restarted = new Engine({ snapshot: engine.snapshot() });
  assert.equal(restarted.settings.readerPosition, 'bottom'); assert.equal(restarted.settings.readingSize, 20); assert.equal(restarted.settings.theme, 'graphite');
  assert.equal(restarted.settings.showStatusBar, false); assert.equal(restarted.settings.requestGap, 5); assert.equal(restarted.settings.auto, false);
  for (const invalid of [{ readerPosition: 'bad' }, { readingFont: 'url(http://bad)' }, { readingSize: 99 }, { sidebarStyle: 'bad' }, { corners: 'bad' }, { showCodeBadges: 1 }]) assert.throws(() => validateSettings(invalid));
});

test('all density and text sizes keep the 500-account sidebar range aligned and bounded', () => {
  for (const density of ['compact', 'comfortable', 'spacious']) for (const fontSize of [13, 14, 16, 18]) {
    const height = accountRowHeight({ density, fontSize });
    for (const scroll of [0, 5000, height * 500]) {
      const range = virtualRange(500, scroll, 350, height);
      assert.equal(range.total, height * 500); assert.ok(range.end - range.start <= 17); assert.ok(range.end <= 500);
    }
  }
});

test('every theme keeps custom accents readable and system follows the OS', () => {
  assert.equal(resolveTheme('system', true), 'dark'); assert.equal(resolveTheme('system', false), 'light'); assert.equal(resolveTheme('bad', true), 'light');
  for (const [theme, surface] of Object.entries(themeSurfaces)) for (const accent of ['#000000', '#ffffff', '#345fce', '#ffff00', '#00ff00']) {
    const palette = accentPalette(accent, ['dark', 'midnight', 'graphite'].includes(theme), surface);
    assert.ok(contrast(palette.ink, surface) >= 4.5); assert.ok(contrast(palette.ink, palette.soft) >= 4.5); assert.ok(contrast(accent, palette.onAccent) >= 4.5);
  }
});
test('multiple imports can exceed 500 accounts and repeated bulk sync stays deduplicated', async () => {
  let calls = 0;
  const engine = await profile(500, { loader: async () => { calls++; return { messages: [], validity: '1' }; } });
  assert.equal((await engine.import(`extra@example.com:${token}:${client}`)).added, 1);
  assert.equal(new Engine({ snapshot: engine.snapshot() }).accounts.size, 501);
  const ids = [...engine.accounts.keys()];
  assert.equal(engine.enqueueBatch(ids).queued, 501);
  assert.equal(engine.enqueueBatch(ids).queued, 0);
  await engine.tick();
  await engine.tick();
  assert.equal(calls, 1);
  assert.equal(engine.queue.length, 500);
});
test('bulk pause cancels pending jobs, persists, and prevents auto sync until resumed', async () => {
  const engine = await profile(100); const ids = [...engine.accounts.keys()]; ids.forEach(id => engine.enqueue(id));
  await engine.bulk(ids.slice(0, 40), 'pause'); assert.equal(engine.queue.length, 60);
  await engine.updateSettings({ auto: true }); await engine.tick();
  assert.equal(engine.account(ids[0]).userPaused, true); assert.equal(engine.enqueue(ids[0]), false);
  const next = new Engine({ snapshot: engine.snapshot() }); assert.equal(next.account(ids[0]).status, 'paused');
  await engine.bulk([ids[0]], 'resume'); assert.equal(engine.account(ids[0]).userPaused, false);
});
test('pausing an active account allows the in-flight read to complete and retains paused status', async () => {
  let release;
  const engine = await profile(1, { loader: async () => { await new Promise(resolve => { release = resolve; }); return { messages: [], validity: '1' }; } });
  const id = [...engine.accounts.keys()][0]; engine.enqueue(id); const job = engine.tick(); await new Promise(resolve => setImmediate(resolve));
  await engine.bulk([id], 'pause'); assert.equal(engine.account(id).status, 'syncing'); release(); await job;
  assert.equal(engine.account(id).status, 'paused'); assert.equal(engine.enqueue(id), false);
});
test('bulk resume cannot bypass an authentication block or reset its cooldown', async () => {
  const engine = await profile(2), ids = [...engine.accounts.keys()]; const account = engine.account(ids[0]);
  account.authBlocked = true; account.enabled = false; account.nextAllowed = 90000000;
  const result = await engine.bulk(ids, 'resume'); assert.equal(result.skipped, 1); assert.equal(account.authBlocked, true); assert.equal(account.nextAllowed, 90000000); assert.equal(engine.enqueue(ids[0]), false);
});
test('bulk validation is atomic: unknown IDs and unconfirmed removal change nothing', async () => {
  const engine = await profile(3), ids = [...engine.accounts.keys()];
  await assert.rejects(engine.bulk([ids[0], 'unknown'], 'pause')); assert.equal(engine.account(ids[0]).userPaused, false);
  await assert.rejects(engine.bulk(ids, 'remove'), /Подтвердите/); assert.equal(engine.accounts.size, 3);
  await engine.bulk([ids[0]], 'remove', undefined, true); assert.equal(engine.accounts.size, 2);
});
test('metadata persists without exposing credentials and is retained when a refresh token is replaced', async () => {
  const engine = await profile(2), id = [...engine.accounts.keys()][0];
  await engine.updateMeta(id, { label: 'Работа', group: 'Команда', note: 'Для проекта', favorite: true });
  await engine.import(rows(1), 'microsoft', true);
  assert.equal(engine.account(id).label, 'Работа'); assert.equal(engine.account(id).favorite, true);
  const next = new Engine({ snapshot: engine.snapshot() }); assert.equal(next.account(id).group, 'Команда');
  const state = JSON.stringify(next.state()); assert.equal(state.includes(token), false); assert.equal(state.includes(client), false);
  await assert.rejects(engine.updateMeta(id, { note: 'a'.repeat(251) }));
});
test('failed bulk storage writes roll back metadata and leave queued jobs in place', async () => {
  const engine = await profile(2), ids = [...engine.accounts.keys()]; engine.enqueue(ids[0]); engine.vault = { save: async () => { throw new Error('disk'); } };
  await assert.rejects(engine.bulk(ids, 'pause')); assert.equal(engine.account(ids[0]).userPaused, false); assert.equal(engine.queue.length, 1); assert.equal(engine.settings.paused, true);
});
test('automatic refresh can be scoped to favorite accounts within a group', async () => {
  const engine = await profile(4), ids = [...engine.accounts.keys()];
  await engine.updateMeta(ids[0], { favorite: true, group: 'Работа' }); await engine.updateMeta(ids[1], { favorite: true, group: 'Личное' }); await engine.updateMeta(ids[2], { group: 'Работа' });
  await engine.updateSettings({ auto: true, autoScope: 'favorites', autoGroup: 'Работа' }); await engine.tick();
  assert.ok(engine.account(ids[0]).lastSync); assert.equal(engine.account(ids[1]).lastSync, 0); assert.equal(engine.account(ids[2]).lastSync, 0); assert.equal(engine.queue.length, 0);
});
test('single-attempt mode does not schedule retries for temporary failures', async () => {
  const { AppError } = await import('../src/errors.mjs');
  const engine = await profile(1, { loader: async () => { throw new AppError('NETWORK', 'offline', { retryable: true }); } });
  await engine.updateSettings({ maxAttempts: 1 }); const id = [...engine.accounts.keys()][0]; engine.enqueue(id); await engine.tick();
  assert.equal(engine.queue.length, 0); assert.equal(engine.account(id).enabled, false);
});

test('lowering the attempt limit also cancels a retry that was already queued', async () => {
  const { AppError } = await import('../src/errors.mjs');
  let now = 1000000, calls = 0;
  const engine = await profile(1, { now: () => now, loader: async () => { calls++; throw new AppError('NETWORK', 'offline', { retryable: true }); } });
  const id = [...engine.accounts.keys()][0]; engine.enqueue(id); await engine.tick();
  assert.equal(engine.queue[0].attempt, 2);
  await engine.updateSettings({ maxAttempts: 1 }); now += 120000; await engine.tick();
  assert.equal(calls, 1); assert.equal(engine.queue.length, 0); assert.equal(engine.account(id).enabled, false);
});
test('search, group and status filters operate across all 500 accounts before paging', () => {
  const accounts = Array.from({ length: 500 }, (_, i) => ({ id: String(i), email: `reader${i}@example.com`, group: i % 2 ? 'Работа' : 'Личное', label: i === 499 ? 'Важная почта' : '', favorite: i % 10 === 0, enabled: true, status: 'idle' }));
  assert.equal(selectAccounts(accounts, { q: 'важная' })[0].id, '499'); assert.equal(selectAccounts(accounts, { group: 'Работа' }).length, 250);
  assert.equal(selectAccounts(accounts, { favorites: true }).length, 50);
  const sorted = selectAccounts(accounts); assert.equal(pageRows(sorted, 10, 50).rows.length, 50); assert.equal(pageRows(sorted, 99, 50).page, 10);
  assert.equal(accounts[0].id, '0');
});
test('sidebar virtualization remains bounded at the top, middle, and bottom of a 500-account list', () => {
  for (const scroll of [0, 5000, 20000, 1000000]) {
    const range = virtualRange(500, scroll, 350, 50); assert.ok(range.end - range.start <= 15); assert.ok(range.start < range.end); assert.equal(range.total, 25000);
  }
  assert.equal(virtualRange(10, 1000000, 350, 50).end, 10);
});
test('custom accent text remains readable on the button and highlighted surfaces', () => {
  for (const color of ['#000000', '#ffffff', '#345fce', '#ffff00', '#ff0000', '#00ff00', '#157d70', '#7955b5', '#808080', '#cccccc']) for (const dark of [false, true]) {
    const surface = dark ? '#182330' : '#ffffff'; const palette = accentPalette(color, dark, surface);
    assert.ok(contrast(color, palette.onAccent) >= 4.5, `${color} button`); assert.ok(contrast(palette.ink, palette.soft) >= 4.5, `${color} highlight`); assert.ok(contrast(palette.ink, surface) >= 4.5, `${color} text`);
  }
});
test('code search filters before paging and does not fetch or expose message bodies', () => {
  const engine = createDemo(500); const result = engine.codes('reader.010'); assert.ok(result.total > 0); assert.ok(result.rows.every(row => row.email.includes('reader.010'))); assert.equal('text' in result.rows[0], false); assert.equal(engine.queue.length, 0);
  assert.equal(engine.state().accounts.length, 500);
});
test('HTTP revision polling returns a compact response until account metadata changes', async () => {
  const engine = await profile(500); const instance = await createServer(engine);
  const headers = { Authorization: `Bearer ${instance.token}` };
  try {
    const first = await (await fetch(`${instance.origin}/api/state`, { headers })).json(); assert.equal(first.accounts.length, 500);
    const same = await (await fetch(`${instance.origin}/api/state?since=${first.revision}`, { headers })).json(); assert.deepEqual(same, { unchanged: true, revision: first.revision });
    await engine.updateMeta(first.accounts[0].id, { favorite: true }); const changed = await (await fetch(`${instance.origin}/api/state?since=${first.revision}`, { headers })).json(); assert.equal(changed.accounts[0].favorite, true);
  } finally { await new Promise(resolve => instance.server.close(resolve)); }
});
