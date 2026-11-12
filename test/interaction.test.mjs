import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedSettings, coalescedUpdater } from '../public/interaction.js';
import { AppError, profileError } from '../src/errors.mjs';
import { translate } from '../shared/i18n.mjs';

test('appearance edits send only deliberate changes and preserve newer sync settings', () => {
  const baseline = { language: 'en', auto: false, requestGap: 5, theme: 'dark' };
  const patch = changedSettings(baseline, { ...baseline, language: 'uk' });
  const latest = { ...baseline, auto: true, requestGap: 20 };
  assert.deepEqual(patch, { language: 'uk' });
  assert.deepEqual({ ...latest, ...patch }, { ...latest, language: 'uk' });
  assert.deepEqual(changedSettings(baseline, baseline), {});
});

test('concurrent refresh callers await the refresh requested after a mutation', async () => {
  let release, reads = 0, revision = 0, displayed = -1;
  const gate = new Promise(resolve => { release = resolve; });
  const refresh = coalescedUpdater(async () => { const snapshot = revision; if (++reads === 1) await gate; displayed = snapshot; });
  const first = refresh(); await Promise.resolve(); revision = 1;
  const afterMutation = refresh(); release(); await afterMutation; await first;
  assert.equal(displayed, 1); assert.equal(reads, 2);
});

test('a rejected refresh does not leave later refreshes stuck', async () => {
  let calls = 0;
  const refresh = coalescedUpdater(() => { if (++calls === 1) throw new Error('offline'); });
  await assert.rejects(refresh(), /offline/); await refresh(); assert.equal(calls, 2);
});

test('profile startup failures provide localized recovery without exposing file paths', () => {
  for (const [code, key] of [['EACCES', 'error.profileWrite'], ['EPERM', 'error.profileWrite'], ['EROFS', 'error.profileWrite'], ['ENOSPC', 'error.profileSpace'], ['ENOTDIR', 'error.profilePath']]) {
    const error = profileError({ code, path: 'sensitive-path', message: 'sensitive-path' });
    assert.equal(error.messageDescriptor.key, key);
    for (const language of ['ru', 'en', 'uk']) assert.equal(translate(error.messageDescriptor, language).includes('sensitive-path'), false);
  }
  const auth = new AppError('AUTH', 'Нужен новый токен. Импортируйте обновлённые данные.');
  assert.equal(profileError(auth), auth);
});
