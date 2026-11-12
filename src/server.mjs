import http from 'node:http';
import { readFile, mkdir, open, unlink, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Vault } from './vault.mjs';
import { Engine } from './engine.mjs';
import { createDemo, populateDemo } from './demo.mjs';
import { AppError, safeError, profileError } from './errors.mjs';
import { translate, normalizeLanguage } from '../shared/i18n.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const LIMIT = 1100000;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'";

async function body(req) {
  const type = req.headers['content-type']?.split(';')[0];
  if (type !== 'application/json') throw new AppError('CONTENT_TYPE', 'Ожидается JSON.', { status: 415 });
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > LIMIT) throw new AppError('SIZE', 'Слишком большой запрос.', { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('JSON', 'Не удалось прочитать запрос.'); }
}

export async function createServer(engine, { port = 0, token = randomBytes(32).toString('hex'), languageFile = null, themeFile = null } = {}) {
  let origin;
  let mutationTail = Promise.resolve();
  let startupWrite = Promise.resolve();
  const rememberStartup = () => {
    const values = [[languageFile, engine.settings.language], [themeFile, engine.settings.theme]];
    startupWrite = startupWrite.then(async () => {
      // Public preference codes only. The encrypted settings remain authoritative.
      for (const [file, value] of values) if (file) {
        try { await writeFile(file + '.tmp', value, { mode: 0o600 }); await rename(file + '.tmp', file); } catch { }
      }
    });
    return startupWrite;
  };
  await rememberStartup(); // Also migrate profiles created before startup hints existed.
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const language = normalizeLanguage(req.headers['accept-language'], engine.settings.language);
    let releaseMutation;
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) throw new AppError('ORIGIN', 'Запрос из другого приложения отклонён.', { status: 403 });
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new AppError('ORIGIN', 'Запрос из другого приложения отклонён.', { status: 403 });
      const path = new URL(req.url, origin).pathname;
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET') throw new AppError('METHOD', 'Метод не поддерживается.', { status: 405 });
        const files = { '/': ['index.html', 'text/html'], '/startup.js': ['startup.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/view-model.js': ['view-model.js', 'text/javascript'], '/customize.js': ['customize.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/themes.css': ['themes.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
        const file = files[path];
        const sharedFiles = ['/shared/i18n.mjs', '/shared/messages.mjs', '/shared/locales/ru.mjs', '/shared/locales/en.mjs', '/shared/locales/uk.mjs'];
        const localizedFile = ['/i18n.js', '/interaction.js'].includes(path) ? [path.slice(1), 'text/javascript'] : sharedFiles.includes(path) ? ['..' + path, 'text/javascript'] : null;
        const selectedFile = file || localizedFile;
        if (!selectedFile) throw new AppError('NOT_FOUND', 'Страница не найдена.', { status: 404 });
        let content = await readFile(join(PUBLIC, selectedFile[0]));
        if (path === '/') content = content.toString('utf8').replace('data-theme="system"', `data-theme="${engine.settings.theme}"`);
        res.writeHead(200, { 'Content-Type': selectedFile[1] + '; charset=utf-8' }); res.end(content); return;
      }
      const provided = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new AppError('SESSION', 'Сессия закрыта. Перезапустите приложение.', { status: 401 });
      if (req.method === 'GET' && path === '/api/state') {
        const query = new URL(req.url, origin).searchParams;
        const reading = engine.accounts.get(query.get('reading'))?.cache[query.get('folder')];
        if (reading) reading.lastUsed = engine.now();
        return json(200, query.has('since') && Number(query.get('since')) === engine.revision ? { unchanged: true, revision: engine.revision } : engine.state());
      }
      if (req.method === 'GET' && path === '/api/codes') {
        const query = new URL(req.url, origin).searchParams;
        return json(200, engine.codes(query.get('q') || '', Number(query.get('page') || 1)));
      }
      const match = path.match(/^\/api\/accounts\/([^/]+)(?:\/(messages|resume|meta|recheck))?$/);
      if (req.method === 'GET' && match?.[2] === 'messages') {
        const account = engine.account(match[1]);
        const folder = new URL(req.url, origin).searchParams.get('folder') || 'inbox';
        if (!['inbox', 'junk'].includes(folder)) throw new AppError('FOLDER', 'Неизвестная папка.');
        if (account.cache[folder]) account.cache[folder].lastUsed = engine.now();
        return json(200, { messages: account.cache[folder]?.messages || [], loaded: !!account.cache[folder], lastSync: account.lastSync || 0 });
      }
      if (!['POST', 'DELETE'].includes(req.method)) throw new AppError('METHOD', 'Метод не поддерживается.', { status: 405 });
      const data = req.method === 'POST' ? await body(req) : null;
      // Keep each UI edit and its rollback together. Reads remain independent.
      const previousMutation = mutationTail;
      mutationTail = new Promise(resolve => { releaseMutation = resolve; });
      await previousMutation;
      if (req.method === 'DELETE' && match && !match[2]) { await engine.remove(match[1]); return json(200, { ok: true }); }
      if (req.method !== 'POST') throw new AppError('METHOD', 'Метод не поддерживается.', { status: 405 });
      if (path === '/api/import/preview') return json(200, engine.preview(data.text));
      if (path === '/api/import') return json(200, await engine.import(data.text, data.authority, data.replace === true, data.group || ''));
      if (path === '/api/accounts/bulk') return json(200, await engine.bulk(data.ids, data.action, data.value, data.confirmed === true));
      if (path === '/api/demo/size') {
        if (!engine.demo) throw new AppError('DEMO', 'Это действие доступно только в демонстрации.');
        if (engine.active) throw new AppError('BUSY', 'Дождитесь завершения демонстрационного запроса.');
        if (![10, 100, 500].includes(data.count)) throw new AppError('DEMO_SIZE', 'Выберите 10, 100 или 500 ящиков.');
        populateDemo(engine, data.count); return json(200, { ok: true });
      }
      if (path === '/api/sync') {
        const folder = data.folder || 'inbox';
        return json(200, Object.hasOwn(data, 'ids') || !data.accountId ? engine.enqueueBatch(data.ids, folder) : engine.requestSync(data.accountId, folder));
      }
      if (path === '/api/settings') {
        await engine.updateSettings(data);
        if (Object.hasOwn(data, 'language') || Object.hasOwn(data, 'theme')) await rememberStartup();
        return json(200, { ok: true });
      }
      if (path === '/api/queue/cancel') { engine.cancel(data.id); return json(200, { ok: true }); }
      if (path === '/api/queue/cancel-batch') return json(200, engine.cancelBatch(data.id));
      if (match?.[2] === 'resume') { await engine.resume(match[1]); return json(200, { ok: true }); }
      if (match?.[2] === 'recheck') return json(200, engine.recheck(match[1]));
      if (match?.[2] === 'meta') { await engine.updateMeta(match[1], data); return json(200, { ok: true }); }
      throw new AppError('NOT_FOUND', 'Действие не найдено.', { status: 404 });
    } catch (error) { const safe = safeError(error); if (!res.headersSent) json(safe.status, { error: translate(safe.messageDescriptor, language), message: safe.messageDescriptor, code: safe.code }); else res.end(); }
    finally { releaseMutation?.(); }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000; server.maxHeadersCount = 40;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, url: `${origin}/#${token}`, token };
}

async function acquireLock(directory) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'profile.lock');
  try {
    const fd = await open(path, 'wx');
    await fd.writeFile(String(process.pid)); await fd.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let active = false;
    try { const pid = Number(await readFile(path, 'utf8')); if (pid > 0) { process.kill(pid, 0); active = true; } } catch {}
    if (active) throw new AppError('ALREADY_RUNNING', 'Letterpane уже работает с этим профилем. Откройте существующее окно.');
    await unlink(path);
    return acquireLock(directory);
  }
  return () => unlink(path).catch(() => {});
}

async function main() {
  const demo = process.argv.includes('--demo');
  const dataDirectory = resolve(process.env.POSTA_DATA_DIR || join(ROOT, '.data'));
  const unlock = await acquireLock(join(dataDirectory, demo ? 'demo' : 'profile')).catch(error => { throw profileError(error); });
  let engine;
  try {
    if (demo) {
      engine = createDemo();
      if (['system', 'light', 'dark', 'paper', 'midnight', 'graphite'].includes(process.env.POSTA_THEME)) await engine.updateSettings({ theme: process.env.POSTA_THEME });
    }
    else {
      const vault = new Vault(join(dataDirectory, 'profile'));
      engine = new Engine({ vault, snapshot: await vault.open().catch(error => { throw profileError(error); }) });
    }
    const instance = await createServer(engine, demo ? {} : { languageFile: join(dataDirectory, 'ui-language'), themeFile: join(dataDirectory, 'ui-theme') });
    engine.start();
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; instance.server.close(); await engine.close(); await unlock(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    // A pipe owned by the native launcher: closing its stdin shuts down the service.
    if (process.argv.includes('--native')) {
      process.stdin.resume(); process.stdin.on('end', stop);
      process.stdout.write(`POSTA_READY:${JSON.stringify({ url: instance.url, origin: instance.origin, demo, language: engine.settings.language, theme: engine.settings.theme })}\n`);
    } else {
      console.log(translate('console.running', engine.settings.language));
      if (process.env.POSTA_DEV_URL === '1') console.log(instance.url);
    }
  } catch (error) { await engine?.close(); await unlock(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`POSTA_ERROR:${translate(safeError(error).messageDescriptor, normalizeLanguage(process.env.POSTA_LANG))}`); process.exitCode = 1; });
}
