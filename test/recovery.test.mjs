import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { AppError } from '../src/errors.mjs';
import { message } from '../shared/i18n.mjs';
import { createServer } from '../src/server.mjs';

const token = 'synthetic-refresh-token-for-recovery-tests-only';
const client = '12345678-1234-1234-1234-123456789abc';
const id = 'blocked-account';
function setup(options = {}) {
  let clock = 1000000;
  const engine = new Engine({
    snapshot: { settings: { auto: true }, accounts: [{ id, email: 'reader@example.com', clientId: client, refreshToken: token, authority: 'live', enabled: false, authBlocked: true, authFailure: 'error.imapAuth', nextAllowed: 0, label: 'Personal', group: 'Mail', note: 'Keep this note' }] },
    now: () => clock, jitter: () => 0, loader: async () => ({ messages: [], validity: '1' }), ...options
  });
  return { engine, advance: ms => { clock += ms; } };
}

test('manual access check retains the block, deduplicates and honors every cooldown', async () => {
  let calls = 0;
  const { engine, advance } = setup({ loader: async account => { calls++; assert.equal(account.authBlocked, true); return { messages: [] }; } });
  engine.globalNext = 1020000; engine.holdUntil = 1040000; engine.account(id).nextAllowed = 1060000;
  assert.deepEqual(engine.recheck(id), { queued: true });
  assert.deepEqual(engine.recheck(id), { queued: false });
  assert.equal(engine.enqueue(id), false);
  assert.equal((await engine.bulk([id], 'resume')).skipped, 1);
  assert.equal(engine.state().accounts[0].accessCheckPending, true);
  assert.equal(engine.snapshot().accounts[0].authBlocked, true);
  assert.equal(engine.account(id).enabled, false);
  await engine.tick(); advance(40000); await engine.tick(); assert.equal(calls, 0);
  advance(20000); await engine.tick(); assert.equal(calls, 1);
  assert.equal(engine.state().accounts[0].accessCheckPending, false);
  assert.equal(engine.account(id).authBlocked, false);
  assert.equal(engine.account(id).enabled, true);
  assert.equal(engine.account(id).errorMessage, null);
  assert.equal(engine.account(id).authority, 'live');
  assert.equal(engine.account(id).label, 'Personal');
  assert.equal(engine.account(id).note, 'Keep this note');
  await engine.tick(); assert.equal(engine.queue.length, 0);
});

test('a successful check refreshes credentials, reads at most five messages and preserves account pause', async () => {
  let release, entered, stored, calls = 0;
  const pending = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { engine } = setup({
    vault: { save: async snapshot => { stored = structuredClone(snapshot); } },
    loader: async (account, folder, limit, options) => {
      calls++; assert.equal(account.accessToken, null); assert.equal(account.expiresAt, 0);
      assert.equal(folder, 'inbox'); assert.equal(limit, 5);
      account.refreshToken = 'synthetic-rotated-refresh-token'; await options.saveTokens();
      assert.equal(stored.accounts[0].authBlocked, true);
      entered(); await gate; return { messages: [] };
    }
  });
  const account = engine.account(id); account.userPaused = true; account.accessToken = 'synthetic-stale-access'; account.expiresAt = 999999999;
  engine.recheck(id); const work = engine.tick(); await pending;
  assert.equal(engine.recheck(id).queued, false);
  assert.equal(engine.state().accounts[0].accessCheckPending, true);
  assert.equal(engine.account(id).authBlocked, true);
  release(); await work;
  assert.equal(calls, 1); assert.equal(account.status, 'paused'); assert.equal(account.userPaused, true);
  assert.equal(stored.accounts[0].authBlocked, false); assert.equal(stored.accounts[0].authFailure, null);
  assert.equal(stored.accounts[0].refreshToken, 'synthetic-rotated-refresh-token');
  assert.equal(engine.enqueue(id), false);
});

for (const [label, failure] of [
  ['OAuth denial', () => new AppError('AUTH_REQUIRED', message('error.invalidGrant'), { auth: true })],
  ['IMAP denial', () => new AppError('IMAP_AUTH', message('error.imapAuth'), { auth: true })],
  ['network failure', () => new AppError('NETWORK', message('error.network'), { retryable: true })],
  ['throttling', () => new AppError('THROTTLED', message('error.oauthThrottled'), { retryable: true, retryAfter: 180000 })],
  ['other failure', () => new AppError('INTERNAL', message('error.internal'))]
]) {
  test(`manual check stops after one ${label}, including auto mode and restart`, async () => {
    let calls = 0;
    const { engine, advance } = setup({ loader: async () => { calls++; throw failure(); } });
    engine.recheck(id); await engine.tick();
    const account = engine.account(id);
    assert.equal(account.authBlocked, true); assert.equal(account.enabled, false);
    assert.equal(account.status, 'auth'); assert.equal(engine.queue.length, 0);
    assert.equal(engine.state().accounts[0].accessCheckPending, false);
    if (label === 'throttling') { assert.equal(engine.holdUntil, 1180000); assert.equal(account.nextAllowed, 1180000); }
    if (label === 'network failure') assert.equal(account.errorMessage.key, 'recovery.unavailable');
    advance(10000000); await engine.tick(); await engine.tick(); assert.equal(calls, 1);
    const restored = new Engine({ snapshot: engine.snapshot(), loader: async () => { calls++; return { messages: [] }; } });
    await restored.tick(); assert.equal(calls, 1); assert.equal(restored.account(id).authBlocked, true);
  });
}

test('cancelling or restarting a queued check preserves the authentication block', async () => {
  const { engine } = setup(); engine.recheck(id);
  const restored = new Engine({ snapshot: engine.snapshot() });
  assert.equal(restored.queue.length, 0); assert.equal(restored.account(id).status, 'auth');
  assert.equal(restored.state().accounts[0].accessCheckPending, false);
  engine.cancel(engine.queue[0].id);
  assert.equal(engine.account(id).status, 'auth'); assert.equal(engine.account(id).authBlocked, true);
  assert.equal(engine.enqueue(id), false);
});

test('credential replacement cancels a pending access check without starting requests', async () => {
  let calls = 0;
  const { engine } = setup({ loader: async () => { calls++; return { messages: [] }; } });
  engine.settings.auto = false; engine.account(id).nextAllowed = 9000000; engine.recheck(id);
  await engine.import(`reader@example.com:${token}:${client}`, 'live', true);
  assert.equal(engine.queue.length, 0); assert.equal(engine.account(id).nextAllowed, 9000000);
  await engine.tick(); assert.equal(calls, 0);
});

test('failed storage prevents a manual check from making any provider request', async () => {
  let calls = 0;
  const { engine } = setup({ vault: { save: async () => { throw new Error('synthetic disk failure'); } }, loader: async () => { calls++; return { messages: [] }; } });
  engine.recheck(id); await engine.tick();
  assert.equal(calls, 0); assert.equal(engine.settings.paused, true);
  assert.equal(engine.account(id).authBlocked, true); assert.equal(engine.account(id).enabled, false);
});

for (const action of ['pause', 'pauseAccount', 'close']) {
  test(`${action} while a manual check saves cooldowns prevents provider dispatch`, async () => {
    let release, entered, saves = 0, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { entered = resolve; });
    const { engine, advance } = setup({
      vault: { save: async () => { if (++saves === 1) { entered(); await gate; } }, close: async () => {} },
      loader: async () => { calls++; return { messages: [] }; }
    });
    engine.recheck(id); const work = engine.tick(); await pending;
    const command = action === 'pause' ? engine.updateSettings({ paused: true }) : action === 'pauseAccount' ? engine.bulk([id], 'pause') : engine.close();
    release(); await work; await command;
    assert.equal(calls, 0); assert.equal(engine.account(id).authBlocked, true);
    if (action === 'pause') {
      assert.equal(engine.queue.length, 1);
      await engine.updateSettings({ paused: false }); advance(61000); await engine.tick(); assert.equal(calls, 1);
    } else assert.equal(engine.queue.length, 0);
    await engine.close();
  });
}

test('access-check API authenticates, deduplicates and does not let ordinary sync bypass a block', async () => {
  let calls = 0;
  const { engine } = setup({ loader: async () => { calls++; return { messages: [] }; } });
  const app = await createServer(engine);
  const headers = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
  const request = (path, auth = true) => fetch(app.origin + path, { method: 'POST', headers: auth ? headers : { 'Content-Type': 'application/json' }, body: '{}' });
  try {
    const path = `/api/accounts/${id}/recheck`;
    assert.equal((await request(path, false)).status, 401);
    assert.deepEqual(await (await request(path)).json(), { queued: true });
    assert.deepEqual(await (await request(path)).json(), { queued: false });
    assert.equal(engine.queue.length, 1); assert.equal(calls, 0);
    const ordinary = await (await request('/api/sync')).json();
    assert.equal(ordinary.queued, 0); assert.equal(ordinary.reasons.auth, 1);
    const resume = await request(`/api/accounts/${id}/resume`); assert.equal(resume.status, 400);
    assert.equal((await resume.json()).code, 'AUTH_REQUIRED');
    const state = JSON.stringify(engine.state()); assert.equal(state.includes(token), false); assert.equal(state.includes(client), false);
    engine.account(id).authBlocked = false;
    assert.equal((await request(path)).status, 409);
    assert.equal((await request('/api/accounts/missing/recheck')).status, 404);
  } finally { await new Promise(resolve => app.server.close(resolve)); await engine.close(); }
});
