import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.mjs';
import { AppError } from '../src/errors.mjs';
import { message } from '../shared/i18n.mjs';
import { parseImport } from '../src/import.mjs';

const token = 'synthetic-token-for-batch-verification';
const client = '12345678-1234-1234-1234-123456789abc';
const mail = () => ({ messages: [], validity: 'fictional' });
test('a 500-row Windows TXT may end in blank lines without weakening the row limit', () => {
  const rows = Array.from({ length: 500 }, (_, i) => `reader${i}@example.com|${token}|${client}`);
  const text = '\uFEFF' + rows.join('\r\n') + '\r\n\r\n';
  assert.equal(parseImport(text).accounts.length, 500);
  assert.throws(() => parseImport(text + 'extra@example.com|' + token + '|' + client), error => error.code === 'IMPORT_SIZE');
});
async function setup(count, options = {}) {
  let now = 1000000;
  const engine = new Engine({ now: () => now, jitter: () => 0, loader: async () => mail(), ...options });
  await engine.import(Array.from({ length: count }, (_, i) => `reader.${String(i + 1).padStart(3, '0')}@example.com|${token}|${client}`).join('\n'));
  return { engine, ids: [...engine.accounts.keys()], advance: ms => { now += ms; } };
}

test('a 500-account refresh separates four skip reasons and duplicate submission preserves its report', async () => {
  let calls = 0, changes = 0;
  const { engine, ids, advance } = await setup(500, { loader: async () => { calls++; return mail(); } });
  const [auth, paused, disabled, busy, first] = ids;
  Object.assign(engine.account(auth), { authBlocked: true, enabled: false, status: 'auth' });
  await engine.bulk([paused], 'pause');
  Object.assign(engine.account(disabled), { enabled: false, status: 'error' });
  engine.account(busy).nextAllowed = 1400000;
  engine.enqueue(busy);
  engine.on('change', () => changes++);
  const result = engine.enqueueBatch([...ids]);
  assert.equal(changes, 1, 'One change notification for the entire submission');
  assert.equal(result.queued, 496); assert.equal(result.skipped, 4);
  assert.deepEqual(result.reasons, { auth: 1, paused: 1, disabled: 1, busy: 1 });
  assert.equal(engine.queue.length, 497); assert.equal(calls, 0);
  const again = engine.enqueueBatch(ids);
  assert.equal(again.queued, 0); assert.equal(again.batchId, null);
  assert.equal(engine.state().batch.id, result.batchId);
  engine.holdUntil = 1180000; await engine.tick(); assert.equal(calls, 0);
  advance(180000); await engine.tick(); assert.equal(calls, 1);
  const report = engine.state().batch;
  assert.equal(report.rows.find(row => row.accountId === first).status, 'updated');
  assert.equal(report.counts.updated, 1); assert.equal(report.counts.queued, 495); assert.equal(report.counts.skipped, 4);
  assert.equal(report.rows.length, 500); assert.equal(JSON.stringify(report).includes(token), false); assert.equal(JSON.stringify(report).includes(client), false);
  assert.equal(new Engine({ snapshot: engine.snapshot() }).state().batch, null);
  assert.deepEqual(engine.cancelBatch(result.batchId), { cancelled: 495 });
  assert.equal(engine.queue[0].accountId, busy); assert.equal(engine.queue.length, 1);
  assert.equal(engine.state().batch.counts.cancelled, 495); assert.equal(engine.state().batch.counts.updated, 1);
  assert.equal(engine.account(paused).userPaused, true); assert.equal(engine.account(auth).authBlocked, true);
});

test('the report distinguishes running, retry waiting and terminal failures', async () => {
  let release, entered, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { entered = resolve; });
  const { engine, ids, advance } = await setup(2, { loader: async () => {
    if (++calls === 1) { entered(); await gate; throw new AppError('NETWORK', message('error.network'), { retryable: true }); }
    if (calls === 2) throw new AppError('AUTH_REQUIRED', message('error.invalidGrant'), { auth: true });
    return mail();
  } });
  engine.enqueueBatch(ids);
  const work = engine.tick(); await pending;
  assert.equal(engine.state().batch.counts.running, 1); assert.equal(engine.state().batch.counts.queued, 1);
  release(); await work;
  assert.equal(engine.state().batch.counts.waiting, 1); assert.equal(engine.state().batch.counts.failed, 0);
  advance(5000); await engine.tick();
  assert.equal(engine.state().batch.counts.failed, 1);
  assert.equal(engine.state().batch.rows.find(row => row.accountId === ids[1]).errorMessage.key, 'error.invalidGrant');
  advance(55000); await engine.tick();
  assert.equal(engine.state().batch.counts.updated, 1); assert.equal(engine.state().batch.counts.waiting, 0);
  assert.equal(calls, 3);
});

test('all 500 synthetic accounts can complete in order with the normal gaps and no duplicate reads', async () => {
  const visited = [];
  const { engine, ids, advance } = await setup(500, { loader: async account => { visited.push(account.id); return mail(); } });
  engine.enqueueBatch(ids);
  for (let index = 0; index < ids.length; index++) {
    await engine.tick();
    await engine.tick(); // No additional dispatch at the same instant.
    assert.equal(visited.length, index + 1);
    advance(5000);
  }
  assert.deepEqual(visited, ids);
  assert.equal(engine.queue.length, 0);
  assert.equal(engine.state().batch.counts.updated, 500);
});

test('cancelling a batch lets the dispatched attempt finish but suppresses its retry and preserves provider holds', async () => {
  let release, entered, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { entered = resolve; });
  const { engine, ids } = await setup(3, { loader: async () => {
    calls++; entered(); await gate;
    throw new AppError('THROTTLED', message('error.oauthThrottled'), { retryable: true, retryAfter: 180000 });
  } });
  const { batchId } = engine.enqueueBatch(ids.slice(0, 2));
  engine.enqueue(ids[2], 'junk');
  const work = engine.tick(); await pending;
  assert.deepEqual(engine.cancelBatch('stale-id'), { cancelled: 0 });
  assert.deepEqual(engine.cancelBatch(batchId), { cancelled: 1 });
  assert.equal(engine.state().batch.counts.running, 1); assert.equal(engine.state().batch.counts.cancelled, 1);
  release(); await work;
  assert.equal(calls, 1); assert.equal(engine.queue.length, 1); assert.equal(engine.queue[0].accountId, ids[2]);
  assert.equal(engine.state().batch.counts.failed, 1); assert.equal(engine.holdUntil, 1180000);
  assert.equal(engine.account(ids[0]).enabled, true);
});

test('batch cancellation before the cooldown write completes does not dispatch the selected job', async () => {
  let release, entered, calls = 0, saves = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { entered = resolve; });
  const { engine, ids } = await setup(2, { loader: async () => { calls++; return mail(); } });
  engine.vault = { save: async () => { if (++saves === 1) { entered(); await gate; } } };
  const { batchId } = engine.enqueueBatch(ids);
  const work = engine.tick(); await pending;
  engine.cancelBatch(batchId); release(); await work;
  assert.equal(calls, 0); assert.equal(engine.state().batch.counts.cancelled, 2);
  assert.equal(engine.account(ids[0]).status, 'idle'); assert.equal(engine.account(ids[0]).nextAllowed, 1060000);
});

test('per-row removal, account pause and account deletion settle pending rows and invalid selections are atomic', async () => {
  const { engine, ids } = await setup(3);
  assert.throws(() => engine.enqueueBatch([ids[0], 'missing']), error => error.code === 'NOT_FOUND');
  assert.equal(engine.queue.length, 0); assert.equal(engine.state().batch, null);
  engine.enqueueBatch(ids);
  engine.cancel(engine.queue[0].id);
  await engine.bulk([ids[1]], 'pause'); await engine.remove(ids[2]);
  assert.equal(engine.state().batch.counts.cancelled, 3); assert.equal(engine.queue.length, 0);
  assert.equal(engine.account(ids[1]).status, 'paused');
  assert.equal(engine.state().batch.rows.find(row => row.accountId === ids[2]).email, '');
});
