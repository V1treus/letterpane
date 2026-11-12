import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Engine } from '../src/engine.mjs';
import { Vault } from '../src/vault.mjs';
import { createServer } from '../src/server.mjs';

const account = () => ({ id: 'test-account', email: 'test@example.com', refreshToken: 'private-refresh-token-for-local-tests-only', clientId: '12345678-1234-1234-1234-123456789abc', enabled: false, userPaused: true, nextAllowed: 9000000 });
const headers = app => ({ Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' });

test('storage failure changes the state revision so polling reveals the paused queue', async () => {
  const engine = new Engine({ snapshot: { accounts: [account()] }, vault: { save: async () => { throw new Error('synthetic storage failure'); } } });
  const app = await createServer(engine);
  try {
    const revision = engine.revision;
    const failed = await fetch(app.origin + '/api/accounts/test-account/meta', { method: 'POST', headers: headers(app), body: JSON.stringify({ favorite: true }) });
    assert.equal(failed.status, 500);
    const state = await (await fetch(app.origin + `/api/state?since=${revision}`, { headers: headers(app) })).json();
    assert.equal(state.unchanged, undefined);
    assert.equal(state.settings.paused, true);
    assert.equal(state.accounts[0].favorite, false);
  } finally { await new Promise(resolve => app.server.close(resolve)); }
});

test('failed account resume restores the paused account without clearing its cooldown', async () => {
  const engine = new Engine({ snapshot: { accounts: [account()] }, vault: { save: async () => { throw new Error('synthetic storage failure'); } } });
  await assert.rejects(engine.resume('test-account'));
  const restored = engine.account('test-account');
  assert.equal(restored.enabled, false);
  assert.equal(restored.userPaused, true);
  assert.equal(restored.status, 'paused');
  assert.equal(restored.nextAllowed, 9000000);
  assert.equal(engine.settings.paused, true);
});

test('overlapping HTTP edits do not include or erase changes from a failed save', async () => {
  let releaseFirst, enteredFirst, saves = 0, stored;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const firstEntered = new Promise(resolve => { enteredFirst = resolve; });
  const engine = new Engine({ vault: { save: async snapshot => {
    if (++saves === 1) { enteredFirst(); await firstGate; throw new Error('synthetic first save failure'); }
    stored = structuredClone(snapshot);
  } } });
  const app = await createServer(engine);
  const secondReceived = new Promise(resolve => app.server.on('request', request => {
    if (request.headers['x-test-sequence'] === 'second') request.once('end', resolve);
  }));
  const update = (change, sequence) => fetch(app.origin + '/api/settings', { method: 'POST', headers: { ...headers(app), 'X-Test-Sequence': sequence }, body: JSON.stringify(change) });
  try {
    const first = update({ theme: 'dark' }, 'first'); await firstEntered;
    const second = update({ fontSize: 16 }, 'second');
    await secondReceived; await new Promise(setImmediate);
    releaseFirst();
    assert.equal((await first).status, 500); assert.equal((await second).status, 200);
    assert.equal(engine.settings.fontSize, 16);
    assert.equal(engine.settings.theme, 'system');
    assert.equal(stored.settings.theme, 'system');
    assert.equal(stored.settings.fontSize, 16);
    assert.equal(stored.settings.paused, true);
  } finally { releaseFirst(); await new Promise(resolve => app.server.close(resolve)); }
});

test('a closed vault rejects late saves and leaves the encrypted file intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'posta-closed-vault-'));
  const vault = new Vault(directory);
  vault.key = Buffer.alloc(32, 7); // Synthetic key; this test exercises save/close ordering only.
  try {
    await vault.save({ marker: 'original synthetic data' });
    const original = await readFile(join(directory, 'accounts.vault'));
    await vault.close();
    assert.throws(() => vault.save({ marker: 'late write' }), /./);
    assert.deepEqual(await readFile(join(directory, 'accounts.vault')), original);
  } finally {
    await vault.close();
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const action of ['pause', 'pauseAccount', 'close']) {
  test(`${action} during the cooldown save prevents a new provider request`, async () => {
    let release, entered, saves = 0, requests = 0, clock = 1000000;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { entered = resolve; });
    const engine = new Engine({
      snapshot: { accounts: [{ ...account(), enabled: true, userPaused: false, nextAllowed: 0 }] },
      now: () => clock, jitter: () => 0,
      loader: async () => { requests++; return { messages: [] }; },
      vault: { save: async () => { if (++saves === 1) { entered(); await gate; } }, close: async () => {} }
    });
    engine.enqueue('test-account');
    const work = engine.tick(); await pending;
    const command = action === 'close' ? engine.close() : action === 'pauseAccount' ? engine.bulk(['test-account'], 'pause') : engine.updateSettings({ paused: true });
    release(); await work; await command;
    assert.equal(requests, 0);
    if (action === 'pause') {
      assert.equal(engine.queue.length, 1);
      await engine.updateSettings({ paused: false }); clock += 61000;
      await engine.tick(); assert.equal(requests, 1);
      await engine.close();
    }
    if (action === 'pauseAccount') {
      assert.equal(engine.queue.length, 0);
      assert.equal(engine.account('test-account').status, 'paused');
      await engine.close();
    }
  });
}
