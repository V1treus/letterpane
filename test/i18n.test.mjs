import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { locales, translate, message, describe, keyForSource, normalizeLanguage, intlLocale } from '../shared/i18n.mjs';
import { Engine } from '../src/engine.mjs';
import { createServer } from '../src/server.mjs';
import { AppError } from '../src/errors.mjs';
import { extractSignals } from '../src/mail.mjs';
import { validateSettings } from '../src/settings.mjs';

test('codes are recognized in Ukrainian, English and Russian messages without translating mail content', () => {
  for (const text of ['Код підтвердження: 482716', 'Ваш код безпеки — 482716', 'Код доступу: 482716', 'Verification code: 482716', 'Код безопасности: 482716']) assert.deepEqual(extractSignals(text).codes, ['482716']);
  assert.deepEqual(extractSignals('Номер замовлення: 482716').codes, []);
});

const placeholders = value => [...new Set((typeof value === 'string' ? [value] : Object.values(value)).flatMap(text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1])))].sort();
test('all three catalogs have the same keys, nonempty translations and matching placeholders', () => {
  const keys = Object.keys(locales.ru).sort();
  assert.ok(keys.length > 400);
  for (const language of ['en', 'uk']) assert.deepEqual(Object.keys(locales[language]).sort(), keys);
  for (const key of keys) for (const language of ['ru', 'en', 'uk']) {
    const value = locales[language][key];
    for (const text of typeof value === 'string' ? [value] : Object.values(value)) assert.ok(text.trim(), `${language}: ${key}`);
    assert.deepEqual(placeholders(value), placeholders(locales.ru[key]), `${language}: ${key}`);
  }
});

test('Russian, English and Ukrainian count forms handle 1, 2, 5, 11 and 21', () => {
  assert.equal(translate('count.accounts', 'ru', { count: 1 }), '1 ящик');
  assert.equal(translate('count.accounts', 'ru', { count: 2 }), '2 ящика');
  assert.equal(translate('count.accounts', 'ru', { count: 5 }), '5 ящиков');
  assert.equal(translate('count.accounts', 'ru', { count: 11 }), '11 ящиков');
  assert.equal(translate('count.accounts', 'ru', { count: 21 }), '21 ящик');
  assert.equal(translate('count.accounts', 'en', { count: 1 }), '1 account');
  assert.equal(translate('count.accounts', 'en', { count: 2 }), '2 accounts');
  for (const [count, word] of [[1, 'скринька'], [2, 'скриньки'], [5, 'скриньок'], [11, 'скриньок'], [21, 'скринька']]) assert.equal(translate('count.accounts', 'uk', { count }), `${count} ${word}`);
  assert.equal(normalizeLanguage('uk-UA'), 'uk'); assert.equal(normalizeLanguage('en-US,en;q=0.9'), 'en');
  assert.equal(normalizeLanguage('bad', 'en'), 'en'); assert.equal(intlLocale('uk'), 'uk-UA');
});

test('HTML, frontend and native translation references exist in every catalog', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]);
  for (const match of html.matchAll(/data-i18n-attrs="([^"]+)"/g)) for (const entry of match[1].split(';')) keys.push(entry.split(':')[1]);
  for (const path of ['public/app.js', 'public/customize.js', 'native/Letterpane.cs', 'native/Portable.cs']) {
    const text = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    for (const match of text.matchAll(/(?:\bt\(|NativeText.Get\()["']([^"']+)["']/g)) keys.push(match[1]);
    if (path.startsWith('public/')) assert.equal(/[А-Яа-яЁё]/.test(text), false, `${path} has untranslated runtime text`);
  }
  for (const key of keys) for (const language of ['ru', 'en', 'uk']) assert.ok(Object.hasOwn(locales[language], key), `${language}: ${key}`);
});

test('static backend errors have translations, while arbitrary message content stays unchanged', async () => {
  for (const path of ['src/errors.mjs', 'src/engine.mjs', 'src/mail.mjs', 'src/vault.mjs', 'src/server.mjs', 'src/import.mjs', 'src/settings.mjs']) {
    const text = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    for (const match of text.matchAll(/new AppError\('[^']+',\s*'([^']*[А-Яа-яЁё][^']*)'/g)) assert.ok(keyForSource(match[1]), `${path}: ${match[1]}`);
  }
  const custom = 'Пользовательская заметка <script>alert(1)</script>';
  assert.equal(translate(describe(custom), 'en'), custom);
});

test('invalid numeric settings identify the correct field in every language', () => {
  for (const key of ['interval', 'limit', 'requestGap', 'accountGap', 'maxAttempts', 'fontSize', 'sidebarWidth', 'messageWidth', 'previewLines', 'cacheMB', 'cacheMessages', 'logLimit', 'readingSize', 'messageSplit']) {
    assert.throws(() => validateSettings({ [key]: -1 }), error => {
      const field = error.messageDescriptor.values.field;
      for (const language of ['ru', 'en', 'uk']) assert.ok(locales[language][field.key], `${language}: ${key}`);
      return true;
    });
  }
  assert.throws(() => validateSettings({ messageSplit: -1 }), error => translate(error.messageDescriptor, 'uk').startsWith('Висота списку листів:'));
});

test('changing language retains credentials, metadata, cooldowns, queue and automatic refresh state', async () => {
  const engine = new Engine();
  await engine.import('test@example.com:private-test-refresh-token-only:12345678-1234-1234-1234-123456789abc');
  const account = [...engine.accounts.values()][0];
  await engine.updateMeta(account.id, { label: 'Мій ящик', group: 'Робота', note: 'Заметка' });
  account.nextAllowed = Date.now() + 600000; engine.enqueue(account.id);
  const taskId = engine.queue[0].id;
  await engine.updateSettings({ language: 'en' }); await engine.updateSettings({ language: 'uk' });
  assert.equal(engine.queue[0].id, taskId); assert.equal(engine.settings.auto, false); assert.equal(engine.settings.requestGap, 5);
  const restarted = new Engine({ snapshot: engine.snapshot() });
  assert.equal(restarted.settings.language, 'uk');
  assert.equal(restarted.account(account.id).label, 'Мій ящик'); assert.equal(restarted.account(account.id).note, 'Заметка');
  assert.equal(restarted.account(account.id).nextAllowed, account.nextAllowed);
  await assert.rejects(engine.updateSettings({ language: 'ua' }));
});

test('queued errors and historical logs can be translated after the language changes', async () => {
  const engine = new Engine({ loader: async () => { throw new AppError('NETWORK', 'Не удалось связаться с Microsoft. Проверьте подключение.', { retryable: true }); } });
  await engine.import('test@example.com:private-test-refresh-token-only:12345678-1234-1234-1234-123456789abc');
  await engine.updateSettings({ maxAttempts: 1 }); const account = [...engine.accounts.values()][0]; engine.enqueue(account.id); await engine.tick();
  const error = engine.state().accounts[0].errorMessage;
  assert.match(translate(error, 'en'), /Could not reach Microsoft/);
  assert.match(translate(error, 'uk'), /Не вдалося зв’язатися/);
  assert.match(translate(engine.logs[0].message, 'en'), /Automatic retries have stopped/);
  await engine.updateSettings({ language: 'uk' });
  assert.equal(engine.account(account.id).enabled, false); assert.equal(engine.queue.length, 0);
});

test('HTTP errors, shared modules and native language preference use only supported languages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'posta-i18n-'));
  const languageFile = join(directory, 'ui-language');
  const engine = new Engine(), instance = await createServer(engine, { languageFile });
  const auth = { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' };
  try {
    for (const [language, expected] of [['en', 'JSON is required.'], ['uk', 'Очікується JSON.'], ['ru', 'Ожидается JSON.']]) {
      const response = await fetch(instance.origin + '/api/import', { method: 'POST', headers: { Authorization: auth.Authorization, 'Accept-Language': language }, body: '{}' });
      assert.equal(response.status, 415); const result = await response.json(); assert.equal(result.error, expected); assert.equal(result.message.key, 'error.contentType');
    }
    const set = await fetch(instance.origin + '/api/settings', { method: 'POST', headers: auth, body: JSON.stringify({ language: 'uk' }) });
    assert.equal(set.status, 200); assert.equal(await readFile(languageFile, 'utf8'), 'uk');
    const bad = await fetch(instance.origin + '/api/settings', { method: 'POST', headers: auth, body: JSON.stringify({ language: '../../other' }) });
    assert.equal(bad.status, 400); assert.equal(await readFile(languageFile, 'utf8'), 'uk');
    for (const path of ['/i18n.js', '/shared/i18n.mjs', '/shared/messages.mjs', '/shared/locales/en.mjs', '/shared/locales/uk.mjs']) {
      const result = await fetch(instance.origin + path); assert.equal(result.status, 200); assert.match(result.headers.get('content-type'), /javascript/);
    }
    assert.equal((await fetch(instance.origin + '/shared/not-a-file.mjs')).status, 404);
  } finally {
    await new Promise(resolve => instance.server.close(resolve));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\') || resolve(directory).startsWith(resolve(tmpdir()) + '/'));
    await rm(directory, { recursive: true, force: true });
  }
});
