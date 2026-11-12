import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { dirname, basename } from 'node:path';
import { Engine } from '../src/engine.mjs';
import { parseImport } from '../src/import.mjs';
import { AppError, retryAfterMs } from '../src/errors.mjs';
import { refreshAccess, extractSignals, parseMessage, loadMailbox } from '../src/mail.mjs';
import { Vault, seal, unseal } from '../src/vault.mjs';
import { createServer } from '../src/server.mjs';
import { message, translate } from '../shared/i18n.mjs';

const CLIENT = '12345678-1234-1234-1234-123456789abc';
const SECRET = 'private-refresh-token-for-local-tests-only';
const input = (address = 'me@outlook.com') => `${address}:${SECRET}:${CLIENT}`;
const empty = async () => ({ validity: '1', messages: [] });
function setup(loader = empty, options = {}) {
  let clock = 1000000;
  const engine = new Engine({ loader, now: () => clock, jitter: () => 0, ...options });
  return { engine, advance: ms => { clock += ms; } };
}

test('import accepts both formats, ignores a legacy password containing colons and deduplicates', () => {
  const result = parseImport(`${input()}\nME@OUTLOOK.COM|old:password|${SECRET}|${CLIENT}\nother@outlook.com:pass:with:colon:${SECRET}:${CLIENT}`);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.accounts[1].refreshToken, SECRET);
  assert.equal('password' in result.accounts[1], false);
});
test('import validates client ID, bounds size and never echoes secret data in errors', () => {
  const result = parseImport(`me@outlook.com:${SECRET}:bad-client`);
  assert.equal(result.accounts.length, 0);
  assert.equal(JSON.stringify(result.errors).includes(SECRET), false);
  assert.throws(() => parseImport('x'.repeat(1048577)), /1 МБ/);
});

test('supplier imports accept one trailing recovery email and retain only mailbox credentials', () => {
  for (const separator of ['|', ':']) {
    const text = ['reader@example.com', 'unused-password', SECRET, CLIENT, 'recovery@example.net'].join(separator);
    const parsed = parseImport(text);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.accounts, [{ email: 'reader@example.com', refreshToken: SECRET, clientId: CLIENT }]);
    assert.equal(JSON.stringify(parsed).includes('unused-password'), false);
    assert.equal(JSON.stringify(parsed).includes('recovery@example.net'), false);
    assert.equal(parseImport(['reader@example.com', SECRET, CLIENT, 'recovery@example.net'].join(separator)).accounts.length, 1);
  }
});

test('supplier import does not guess credentials around malformed or extra trailing fields', () => {
  for (const suffix of ['not-an-email', 'recovery@example.net|extra@example.net', 'recovery@example.net|extra', '']) {
    const parsed = parseImport(`reader@example.com|unused-password|${SECRET}|${CLIENT}|${suffix}`);
    assert.equal(parsed.accounts.length, 0);
    assert.equal(parsed.errors.length, 1);
    assert.equal(JSON.stringify(parsed.errors).includes(SECRET), false);
  }
});
test('import does not start any network work; state never exposes tokens or client IDs', async () => {
  let calls = 0;
  const { engine } = setup(async () => { calls++; return empty(); });
  await engine.import(input()); await engine.tick();
  assert.equal(calls, 0); assert.equal(engine.queue.length, 0);
  const state = JSON.stringify(engine.state());
  assert.equal(state.includes(SECRET), false); assert.equal(state.includes(CLIENT), false);
});
test('repeated clicks and ticks cannot start parallel account sessions', async () => {
  let release, calls = 0;
  const { engine, advance } = setup(async () => { calls++; await new Promise(r => { release = r; }); return empty(); });
  await engine.import(`${input()}\n${input('two@outlook.com')}`);
  const [a, b] = [...engine.accounts.keys()];
  assert.equal(engine.enqueue(a), true); assert.equal(engine.enqueue(a), false); engine.enqueue(b);
  const running = engine.tick(); await new Promise(r => setImmediate(r));
  advance(200000); await engine.tick(); assert.equal(calls, 1); assert.equal(engine.enqueue(a), false);
  release(); await running; assert.equal(calls, 1);
});
test('global spacing counts from dispatch; per-account cooldown survives restart', async () => {
  let calls = 0;
  const { engine, advance } = setup(async () => { if (++calls === 1) advance(2000); return empty(); });
  await engine.import(`${input()}\n${input('two@outlook.com')}`);
  const [a, b] = [...engine.accounts.keys()];
  engine.enqueue(a); engine.enqueue(b); await engine.tick();
  advance(2999); await engine.tick(); assert.equal(calls, 1);
  advance(1); await engine.tick(); assert.equal(calls, 2);
  engine.enqueue(a); advance(5000); await engine.tick(); assert.equal(calls, 2);
  const restarted = new Engine({ snapshot: engine.snapshot(), now: () => 1010000, loader: async () => { calls++; return empty(); } });
  restarted.enqueue(a); await restarted.tick(); assert.equal(calls, 2);
  advance(50000); await engine.tick(); assert.equal(calls, 3);
});
test('manual refresh moves a queued batch task forward without duplicating it or skipping a provider hold', async () => {
  const runs = [];
  const { engine, advance } = setup(async account => { runs.push(account.id); return empty(); });
  await engine.import(`${input()}\n${input('two@outlook.com')}`);
  const [a, b] = [...engine.accounts.keys()];
  const batch = engine.enqueueBatch();
  const task = engine.queue[1];
  assert.deepEqual(engine.requestSync(b), { queued: 0, prioritized: true });
  assert.equal(engine.queue[0], task);
  assert.equal(engine.queue.length, 2);
  engine.holdUntil = 1005000;
  await engine.tick(); assert.deepEqual(runs, []);
  advance(5000); await engine.tick(); assert.deepEqual(runs, [b]);
  assert.equal(engine.batchState().id, batch.batchId);
  assert.equal(engine.batchState().counts.updated, 1);
  advance(5000); await engine.tick(); assert.deepEqual(runs, [b, a]);
});
test('429 pauses all accounts for Retry-After; no retries while the hold is active', async () => {
  let calls = 0;
  const { engine, advance } = setup(async () => { calls++; throw new AppError('THROTTLED', 'Pause', { retryable: true, retryAfter: 180000 }); });
  await engine.import(`${input()}\n${input('two@outlook.com')}`);
  for (const id of engine.accounts.keys()) engine.enqueue(id);
  await engine.tick(); advance(120000); await engine.tick(); assert.equal(calls, 1);
  assert.equal(engine.holdUntil, 1180000);
  const snapshot = engine.snapshot(); assert.equal(snapshot.holdUntil, 1180000);
});
test('invalid credentials stop retries across restart and cannot be resumed without new credentials', async () => {
  let calls = 0;
  const { engine, advance } = setup(async () => { calls++; throw new AppError('AUTH_REQUIRED', 'New token required', { auth: true }); });
  await engine.import(input()); const id = [...engine.accounts.keys()][0]; engine.enqueue(id); await engine.tick();
  advance(1000000); engine.settings.auto = true; await engine.tick();
  assert.equal(calls, 1); assert.equal(engine.enqueue(id), false); assert.equal(engine.queue.length, 0);
  await assert.rejects(engine.resume(id), error => error.code === 'AUTH_REQUIRED');
  const restarted = new Engine({ snapshot: engine.snapshot() }); assert.equal(restarted.account(id).authBlocked, true);
});

test('IMAP and OAuth denial causes survive restart without retrying or confusing their explanations', async () => {
  for (const key of ['error.imapAuth', 'error.invalidGrant']) {
    let calls = 0;
    const { engine } = setup(async () => { calls++; throw new AppError('AUTH_REQUIRED', message(key), { auth: true }); });
    await engine.import(input()); const id = [...engine.accounts.keys()][0];
    engine.enqueue(id); await engine.tick();
    assert.equal(engine.snapshot().accounts[0].authFailure, key);
    const restarted = new Engine({ snapshot: engine.snapshot(), now: () => 3000000, loader: async () => { calls++; return empty(); } });
    assert.deepEqual(restarted.state().accounts[0].errorMessage, message(key));
    await assert.rejects(restarted.resume(id), error => error.messageDescriptor.key === key);
    restarted.settings.auto = true; await restarted.tick();
    assert.equal(restarted.enqueue(id), false); assert.equal(calls, 1);
    const cooldown = restarted.account(id).nextAllowed;
    await restarted.import(input(), 'microsoft', true);
    assert.equal(restarted.account(id).authFailure, null);
    assert.equal(restarted.account(id).authBlocked, false);
    assert.equal(restarted.account(id).nextAllowed, cooldown);
    assert.equal(restarted.state().accounts[0].errorMessage, null);
    restarted.enqueue(id); await restarted.tick();
    assert.equal(calls, 2); assert.equal(restarted.account(id).status, 'ok');
  }
});

test('legacy auth blocks use a neutral cause and persist no arbitrary error text', async () => {
  const { engine } = setup(); await engine.import(input());
  for (const authFailure of [undefined, SECRET, 'error.profileWrite']) {
    const snapshot = engine.snapshot();
    Object.assign(snapshot.accounts[0], { authBlocked: true, enabled: false, authFailure });
    const restored = new Engine({ snapshot });
    assert.deepEqual(restored.state().accounts[0].errorMessage, message('error.authNeeded'));
    assert.equal(restored.snapshot().accounts[0].authFailure, 'error.authNeeded');
    assert.equal(restored.enqueue(snapshot.accounts[0].id), false);
    for (const language of ['ru', 'en', 'uk']) {
      assert.equal(translate(restored.state().accounts[0].errorMessage, language), translate('error.authNeeded', language));
    }
  }
});

test('import and restart preserve literal asterisks and punctuation in a refresh token', async () => {
  const token = 'M.C528.synthetic!one*two*three*four*five*six*seven$';
  const { engine } = setup();
  await engine.import(`reader@example.com|unused-password|${token}|${CLIENT}|recovery@example.net`);
  assert.equal(engine.snapshot().accounts[0].refreshToken, token);
  const restarted = new Engine({ snapshot: engine.snapshot() });
  assert.equal([...restarted.accounts.values()][0].refreshToken, token);
});
test('transient failures stop after exactly three attempts instead of looping in auto mode', async () => {
  let calls = 0;
  const { engine, advance } = setup(async () => { calls++; throw new AppError('NETWORK', 'Offline', { retryable: true }); });
  await engine.import(input()); const id = [...engine.accounts.keys()][0]; engine.enqueue(id);
  await engine.tick(); advance(60000); await engine.tick(); advance(120000); await engine.tick();
  advance(1000000); engine.settings.auto = true; await engine.tick();
  assert.equal(calls, 3); assert.equal(engine.account(id).enabled, false); assert.equal(engine.queue.length, 0);
});
test('paused queue and canceled jobs make no network requests', async () => {
  let calls = 0;
  const { engine } = setup(async () => { calls++; return empty(); });
  await engine.import(input()); engine.enqueue([...engine.accounts.keys()][0]); engine.settings.paused = true;
  await engine.tick(); assert.equal(calls, 0);
  engine.cancel(engine.queue[0].id); engine.settings.paused = false; await engine.tick(); assert.equal(calls, 0);
});
test('bulk reading evicts old cache before it grows without bounds and preserves the newly loaded folder', async () => {
  const { engine } = setup(); await engine.import(`${input()}\n${input('two@outlook.com')}\n${input('three@outlook.com')}`);
  const accounts = [...engine.accounts.values()];
  for (const [i, account] of accounts.entries()) account.cache.inbox = { lastUsed: i, messages: Array.from({ length: 50 }, () => ({ text: 'x'.repeat(180000), codes: [], links: [] })) };
  engine.trimCache(accounts[2].cache.inbox);
  assert.equal(accounts[0].cache.inbox, undefined); assert.equal(accounts[1].cache.inbox, undefined); assert.equal(accounts[2].cache.inbox.messages.length, 50);
});
test('failed storage writes stop the queue before any provider request', async () => {
  let calls = 0;
  const { engine } = setup(async () => { calls++; return empty(); });
  await engine.import(input()); engine.vault = { save: async () => { throw new Error('Disk full'); } };
  engine.enqueue([...engine.accounts.keys()][0]); await engine.tick(); assert.equal(calls, 0); assert.equal(engine.settings.paused, true);
});
test('closing an active job aborts it and waits before zeroing the vault key', async () => {
  let release, closed = false;
  const { engine } = setup(async account => { await new Promise(r => { release = r; account.abortController.signal.addEventListener('abort', r); }); return empty(); });
  await engine.import(input()); engine.vault = { save: async () => assert.equal(closed, false), close: async () => { closed = true; } };
  engine.enqueue([...engine.accounts.keys()][0]); const job = engine.tick(); await new Promise(r => setImmediate(r));
  await engine.close(); await job; assert.ok(release); assert.equal(closed, true); assert.equal(engine.active, null);
});
test('OAuth uses exactly one endpoint/client, caches access tokens and rotates refresh tokens', async () => {
  let calls = 0;
  const account = { refreshToken: SECRET, clientId: CLIENT, authority: 'microsoft' };
  const options = { now: () => 1000000, fetchImpl: async (url, opts) => {
    calls++; assert.equal(url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token'); assert.equal(opts.body.get('client_id'), CLIENT);
    assert.equal(opts.redirect, 'error');
    return new Response(JSON.stringify({ access_token: 'access', refresh_token: 'rotated', expires_in: 3600 }), { status: 200 });
  } };
  await refreshAccess(account, options); await refreshAccess(account, options);
  assert.equal(calls, 1); assert.equal(account.refreshToken, 'rotated');
});
test('invalid_grant does not try alternate client IDs/endpoints or leak provider descriptions', async () => {
  let calls = 0;
  await assert.rejects(refreshAccess({ refreshToken: SECRET, clientId: CLIENT }, { fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: 'invalid_grant', error_description: SECRET }), { status: 400 }); } }), e => e.auth && !e.message.includes(SECRET));
  assert.equal(calls, 1);
});
test('Retry-After supports seconds, dates and values longer than a day without capping them', () => {
  assert.equal(retryAfterMs('120'), 120000);
  assert.equal(retryAfterMs('Wed, 04 Nov 2026 10:05:00 GMT', Date.parse('2026-11-04T10:00:00Z')), 300000);
  assert.equal(retryAfterMs('172800'), 172800000);
  assert.equal(retryAfterMs('invalid'), 0);
});
test('OAuth 429 honors the server hold and remains retryable', async () => {
  await assert.rejects(refreshAccess({ refreshToken: SECRET, clientId: CLIENT }, { fetchImpl: async () => new Response('{}', { status: 429, headers: { 'retry-after': '300' } }) }), e => e.code === 'THROTTLED' && e.retryAfter === 300000 && e.retryable);
});
test('signal extraction requires code context and ignores normal numbers and unsafe URLs', () => {
  assert.deepEqual(extractSignals('Invoice 20261104\nКод подтверждения: 482716\nCode: A3F92\nhttps://user:secret@example.com/verify\nhttps://example.com/confirm?token=x\nhttps://example.com/unsubscribe?token=y'), { codes: ['482716', 'A3F92'], links: ['https://example.com/confirm?token=x'] });
});
test('HTML email becomes inert text and no HTML or image is returned to the renderer', async () => {
  const message = await parseMessage(Buffer.from('From: Test <test@example.com>\r\nSubject: Test\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Code: <b>123456</b></p><script>alert(1)</script><img src="https://tracker.example/x">'), { uid: 1, size: 300 });
  assert.equal('html' in message, false); assert.ok(message.codes.includes('123456')); assert.equal(message.text.includes('<script>'), false);
});
test('IMAP requests are read-only and batched; cached bodies are reused and UIDVALIDITY resets cache', async () => {
  let validity = 1, bodyFetches = 0, tokenSaves = 0, readOnly;
  const account = { email: 'me@outlook.com', accessToken: 'access', refreshToken: 'previous', cache: {} };
  const clientFactory = options => {
    assert.equal(options.logger, false); assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.disableAutoIdle, true);
    return { mailbox: { uidValidity: validity, exists: 1 }, on() {}, async connect() {}, async getMailboxLock(path, opts) { readOnly = opts.readOnly; assert.equal(path, 'INBOX'); return { release() {} }; }, async fetchAll(range, query, options) {
      if (!query.source) return [{ uid: 1, size: 80, flags: new Set(['\\Seen']), internalDate: new Date(), envelope: { subject: 'Test' } }];
      bodyFetches++; assert.deepEqual(range, [1]); assert.equal(query.source.maxLength, 524288); assert.equal(options.uid, true);
      return [{ uid: 1, source: Buffer.from('Subject: Test\r\n\r\nCode: 123456') }];
    }, close() {} };
  };
  const options = { clientFactory, tokenRefresh: async () => 'access', saveTokens: async () => { tokenSaves++; } };
  account.cache.inbox = await loadMailbox(account, 'inbox', 20, options);
  assert.equal(readOnly, true); assert.equal(account.cache.inbox.messages[0].unread, false);
  account.cache.inbox = await loadMailbox(account, 'inbox', 20, options); assert.equal(bodyFetches, 1);
  assert.equal(tokenSaves, 0);
  validity++;
  await loadMailbox(account, 'inbox', 20, {
    ...options,
    tokenRefresh: async () => { account.refreshToken = 'rotated'; return 'access'; },
    clientFactory: opts => { assert.equal(tokenSaves, 1); return clientFactory(opts); }
  });
  assert.equal(bodyFetches, 2);
});
test('AES-GCM hides tokens and detects tampering or an incorrect key', () => {
  const key = randomBytes(32), value = { refreshToken: SECRET };
  const encrypted = seal(value, key); assert.equal(encrypted.includes(SECRET), false); assert.deepEqual(unseal(encrypted, key), value);
  assert.throws(() => unseal(encrypted, randomBytes(32)));
  const envelope = JSON.parse(encrypted); envelope.data = Buffer.from('tampered').toString('base64'); assert.throws(() => unseal(JSON.stringify(envelope), key));
});
test('Windows DPAPI vault survives restart and only stores encrypted credentials', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'posta-vault-'));
  try {
    const vault = new Vault(directory); assert.equal(await vault.open(), null);
    await vault.save({ accounts: [{ refreshToken: SECRET }] }); await vault.close();
    assert.equal((await readFile(join(directory, 'accounts.vault'), 'utf8')).includes(SECRET), false);
    const reopened = new Vault(directory); const result = await reopened.open(); assert.equal(result.accounts[0].refreshToken, SECRET); await reopened.close();
  } finally {
    assert.equal(dirname(directory), tmpdir()); assert.ok(basename(directory).startsWith('posta-vault-'));
    await rm(directory, { recursive: true, force: true });
  }
});
test('HTTP API rejects missing auth, cross-origin calls, DNS rebinding and traversal', async () => {
  const { engine } = setup(); await engine.import(input());
  const instance = await createServer(engine);
  try {
    const headers = { Authorization: `Bearer ${instance.token}` };
    assert.equal((await fetch(`${instance.origin}/api/state`)).status, 401);
    assert.equal((await fetch(`${instance.origin}/api/state`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    const reboundStatus = await new Promise((resolve, reject) => {
      const request = http.get(`${instance.origin}/api/state`, { headers: { ...headers, Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(reboundStatus, 403);
    assert.equal((await fetch(`${instance.origin}/%2e%2e/package.json`, { headers })).status, 404);
    const response = await fetch(`${instance.origin}/api/state`, { headers }); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
    assert.equal((await response.text()).includes(SECRET), false);
    assert.equal(engine.queue.length, 0);
  } finally { await new Promise(resolve => instance.server.close(resolve)); await engine.close(); }
});
test('HTTP import preview reports invalid rows without returning raw credentials', async () => {
  const { engine } = setup(); const instance = await createServer(engine);
  try {
    const response = await fetch(`${instance.origin}/api/import/preview`, { method: 'POST', headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `${input()}\n${SECRET}` }) });
    const text = await response.text(); assert.equal(response.status, 200); assert.equal(text.includes(SECRET), false); assert.equal(JSON.parse(text).errors.length, 1);
  } finally { await new Promise(resolve => instance.server.close(resolve)); }
});
