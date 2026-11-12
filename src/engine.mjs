import { randomUUID, randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AppError, safeError } from './errors.mjs';
import { loadMailbox } from './mail.mjs';
import { parseImport } from './import.mjs';
import { DEFAULT_SETTINGS, validateSettings, cleanText } from './settings.mjs';
import { message, describe, translate, normalizeLanguage } from '../shared/i18n.mjs';
import { VERSION } from './version.mjs';

export { DEFAULT_SETTINGS } from './settings.mjs';
const ACCOUNT_GAP = 60000;
const AUTH_ERRORS = new Set(['error.authNeeded', 'error.invalidGrant', 'error.invalidClient', 'error.interactionRequired', 'error.consentRequired', 'error.invalidScope', 'error.authRejected', 'error.imapAuth']);
export class Engine extends EventEmitter {
  constructor({ vault, snapshot = null, loader = loadMailbox, now = Date.now, jitter = () => randomInt(0, 15001), demo = false } = {}) {
    super();
    Object.assign(this, { vault, loader, now, jitter, demo });
    this.settings = validateSettings({ language: snapshot ? 'ru' : normalizeLanguage(process.env.POSTA_LANG), ...snapshot?.settings });
    this.accounts = new Map();
    for (const item of snapshot?.accounts || []) {
      const authFailure = item.authBlocked ? (AUTH_ERRORS.has(item.authFailure) ? item.authFailure : 'error.authNeeded') : null;
      const errorMessage = authFailure ? message(authFailure) : null;
      this.accounts.set(item.id, { label: '', group: '', note: '', favorite: false, userPaused: false, ...item, authFailure, cache: {}, accessToken: null, expiresAt: 0, status: item.authBlocked ? 'auth' : item.userPaused ? 'paused' : item.enabled === false ? 'error' : 'idle', error: errorMessage ? translate(errorMessage, 'ru') : '', errorMessage });
    }
    this.queue = [];
    this.active = null;
    this.lastBatch = null;
    this.globalNext = snapshot?.globalNext || 0;
    this.holdUntil = snapshot?.holdUntil || 0;
    this.logs = [];
    this.revision = 0;
    this.networkFailures = 0;
  }
  changed() { this.revision++; this.emit('change'); }
  log(value, level = 'info') {
    const descriptor = describe(value);
    this.logs.unshift({ id: randomUUID(), time: this.now(), text: translate(descriptor, 'ru'), message: descriptor, level });
    this.logs.length = Math.min(this.logs.length, this.settings.logLimit);
    this.changed();
  }
  snapshot() {
    return { settings: this.settings, globalNext: this.globalNext, holdUntil: this.holdUntil,
      accounts: [...this.accounts.values()].map(({ id, email, clientId, refreshToken, authority, enabled, authBlocked, authFailure, nextAllowed, lastSync, label, group, note, favorite, userPaused }) => ({ id, email, clientId, refreshToken, authority, enabled, authBlocked, authFailure: authBlocked && AUTH_ERRORS.has(authFailure) ? authFailure : null, nextAllowed, lastSync, label, group, note, favorite, userPaused })) };
  }
  async persist() {
    if (!this.vault) return;
    try { await this.vault.save(this.snapshot()); }
    catch { this.settings.paused = true; this.changed(); throw new AppError('SAVE', 'Не удалось сохранить защищённое хранилище. Очередь остановлена. Проверьте доступ к папке .data.', { status: 500 }); }
  }
  state() {
    const now = this.now();
    const accessChecks = new Set(this.queue.filter(task => task.recheck).map(task => task.accountId));
    if (this.active?.recheck) accessChecks.add(this.active.accountId);
    return {
      version: VERSION, demo: this.demo, portable: process.env.POSTA_PORTABLE_MODE === '1', revision: this.revision, settings: this.settings,
      accounts: [...this.accounts.values()].map(a => ({ id: a.id, email: a.email, label: a.label || '', group: a.group || '', note: a.note || '', favorite: !!a.favorite, userPaused: !!a.userPaused, status: a.status, error: a.error || '', errorMessage: a.error ? a.errorMessage || describe(a.error) : null, enabled: a.enabled, authBlocked: !!a.authBlocked, accessCheckPending: accessChecks.has(a.id), lastSync: a.lastSync || 0, nextAllowed: a.nextAllowed || 0,
        cacheVersions: Object.fromEntries(Object.entries(a.cache).map(([folder, cache]) => [folder, cache.version || 1])),
        count: Object.values(a.cache).reduce((sum, f) => sum + f.messages.length, 0), authority: a.authority || 'microsoft' })),
      queue: this.queue.map(t => ({ ...t, email: this.accounts.get(t.accountId)?.email, wait: Math.max(0, this.readyAt(t) - now) })),
      active: this.active ? { ...this.active, email: this.accounts.get(this.active.accountId)?.email } : null,
      holdUntil: this.holdUntil, globalNext: this.globalNext, logs: this.logs, batch: this.batchState()
    };
  }
  account(id) { const a = this.accounts.get(id); if (!a) throw new AppError('NOT_FOUND', 'Ящик не найден.', { status: 404 }); return a; }
  codes(query = '', page = 1) {
    if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(page) || page < 1) throw new AppError('SEARCH', 'Проверьте запрос поиска.');
    const search = query.toLocaleLowerCase();
    const rows = [];
    for (const account of this.accounts.values()) for (const [folder, cache] of Object.entries(account.cache)) for (const message of cache.messages) {
      if (!message.codes?.length || !`${account.email} ${account.label || ''} ${message.subject} ${message.from} ${message.codes.join(' ')}`.toLocaleLowerCase().includes(search)) continue;
      rows.push({ accountId: account.id, email: account.email, label: account.label || '', folder, messageId: message.id, subject: message.subject, from: message.from, date: message.date, codes: message.codes });
    }
    rows.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    const pages = Math.max(1, Math.ceil(rows.length / 50));
    page = Math.min(page, pages);
    return { rows: rows.slice((page - 1) * 50, page * 50), total: rows.length, page, pages };
  }
  trimCache(protectedCache) {
    const entries = [...this.accounts.values()].flatMap(account => Object.entries(account.cache).map(([folder, cache]) => ({ account, folder, cache })));
    let totalBytes = 0, totalMessages = 0;
    for (const { cache } of entries) {
      cache.bytes = cache.messages.reduce((sum, m) => sum + 1024 + 2 * [m.text, m.from, m.subject, m.preview, ...(m.codes || []), ...(m.links || [])].reduce((n, s) => n + (s?.length || 0), 0), 0);
      totalBytes += cache.bytes; totalMessages += cache.messages.length;
    }
    entries.sort((a, b) => (a.cache.lastUsed || 0) - (b.cache.lastUsed || 0));
    for (const entry of entries) {
      if (totalBytes <= this.settings.cacheMB * 1024 * 1024 && totalMessages <= this.settings.cacheMessages) break;
      if (entry.cache === protectedCache) continue;
      totalBytes -= entry.cache.bytes; totalMessages -= entry.cache.messages.length;
      delete entry.account.cache[entry.folder];
    }
  }
  preview(text) {
    const parsed = parseImport(text);
    const existingEmails = new Set(Array.from(this.accounts.values(), account => account.email));
    return { emails: parsed.accounts.map(a => ({ email: a.email, exists: existingEmails.has(a.email) })), errors: parsed.errors, duplicates: parsed.duplicates };
  }
  async import(text, authority = 'microsoft', replace = false, group = '') {
    if (this.demo) throw new AppError('DEMO', 'Настоящие токены нельзя добавить в деморежим. Перезапустите Letterpane без --demo.');
    if (!['microsoft', 'live'].includes(authority)) throw new AppError('AUTHORITY', 'Выберите тип OAuth.');
    group = cleanText(group, 40, 'группы');
    const parsed = parseImport(text);
    if (!parsed.accounts.length) throw new AppError('IMPORT', 'Нет корректных строк. Проверьте формат.');
    const activeEmail = this.accounts.get(this.active?.accountId)?.email;
    if (replace && parsed.accounts.some(input => input.email === activeEmail)) throw new AppError('BUSY', 'Дождитесь завершения текущего запроса перед заменой токена.');
    const existingByEmail = new Map();
    for (const account of this.accounts.values()) {
      if (!existingByEmail.has(account.email)) existingByEmail.set(account.email, account);
    }
    let added = 0, updated = 0, skipped = parsed.duplicates;
    const backup = new Map(this.accounts);
    const replaced = new Set();
    for (const input of parsed.accounts) {
      const existing = existingByEmail.get(input.email);
      if (existing && !replace) { skipped++; continue; }
      const account = { ...input, id: existing?.id || randomUUID(), authority, label: existing?.label || '', group: group || existing?.group || '', note: existing?.note || '', favorite: !!existing?.favorite, userPaused: !!existing?.userPaused, enabled: true, authBlocked: false, authFailure: null, nextAllowed: existing?.nextAllowed || 0, lastSync: 0, cache: {}, status: existing?.userPaused ? 'paused' : 'idle', error: '' };
      this.accounts.set(account.id, account);
      if (existing) replaced.add(account.id);
      existing ? updated++ : added++;
    }
    try { await this.persist(); } catch (e) { this.accounts = backup; throw e; }
    if (replaced.size) this.dropQueued(task => task.recheck && replaced.has(task.accountId));
    this.log(message('log.import', { added, updated, skipped }));
    return { added, updated, skipped, errors: parsed.errors };
  }
  enqueue(accountId, folder = 'inbox', attempt = 1, notBefore = 0) {
    if (!['inbox', 'junk'].includes(folder)) throw new AppError('FOLDER', 'Неизвестная папка.');
    const account = this.account(accountId);
    if (account.authBlocked || !account.enabled || account.userPaused) return false;
    if (this.active?.accountId === accountId || this.queue.some(t => t.accountId === accountId && t.folder === folder)) return false;
    this.queueTask(account, folder, attempt, notBefore);
    this.changed();
    return true;
  }
  requestSync(accountId, folder = 'inbox') {
    const queued = this.enqueue(accountId, folder);
    const index = this.queue.findIndex(task => task.accountId === accountId && task.folder === folder && !task.recheck);
    if (index > 0) {
      const [task] = this.queue.splice(index, 1);
      this.queue.unshift(task);
      this.changed();
    }
    return { queued: Number(queued), prioritized: !queued && index > 0 };
  }
  queueTask(account, folder, attempt = 1, notBefore = 0) {
    const task = { id: randomUUID(), accountId: account.id, folder, attempt, notBefore, created: this.now() };
    this.queue.push(task);
    account.status = 'queued';
    return task;
  }
  enqueueBatch(ids, folder = 'inbox') {
    if (!['inbox', 'junk'].includes(folder)) throw new AppError('FOLDER', 'Неизвестная папка.');
    const accounts = ids === undefined ? [...this.accounts.values()] : this.selection(ids);
    const busy = new Set(this.queue.filter(task => task.folder === folder).map(task => task.accountId));
    if (this.active) busy.add(this.active.accountId);
    const entries = new Map(), reasons = { auth: 0, paused: 0, disabled: 0, busy: 0 };
    let queued = 0;
    for (const account of accounts) {
      const reason = account.authBlocked ? 'auth' : account.userPaused ? 'paused' : !account.enabled ? 'disabled' : busy.has(account.id) ? 'busy' : null;
      if (reason) { reasons[reason]++; entries.set(account.id, { status: 'skipped', reason }); }
      else {
        const task = this.queueTask(account, folder);
        entries.set(account.id, { status: 'pending', taskId: task.id });
        queued++;
      }
    }
    // An accidental repeat with no new work must not hide a running report.
    const existingWork = this.lastBatch && [...this.lastBatch.entries.values()].some(entry => entry.status === 'pending');
    let batchId = null;
    if (queued || (entries.size && !existingWork)) {
      batchId = randomUUID(); this.lastBatch = { id: batchId, entries };
      this.changed();
    }
    return { queued, skipped: accounts.length - queued, reasons, batchId };
  }
  batchEntry(task) {
    const entry = task && this.lastBatch?.entries.get(task.accountId);
    return entry?.taskId === task?.id ? entry : undefined;
  }
  finishBatchTask(task, status, reason = null, errorMessage = null) {
    const entry = this.batchEntry(task);
    if (entry?.status === 'pending') Object.assign(entry, { status, reason, errorMessage });
  }
  batchState() {
    if (!this.lastBatch) return null;
    const waiting = new Map(this.queue.map(task => [task.id, task]));
    const counts = { queued: 0, waiting: 0, running: 0, updated: 0, failed: 0, skipped: 0, cancelled: 0 };
    const rows = [...this.lastBatch.entries].map(([accountId, entry]) => {
      const status = entry.status === 'pending' ? this.active?.id === entry.taskId ? 'running' : (waiting.get(entry.taskId)?.attempt || 1) > 1 ? 'waiting' : 'queued' : entry.status;
      counts[status]++;
      return { accountId, email: this.accounts.get(accountId)?.email || '', status, reason: entry.reason || null, errorMessage: entry.errorMessage || null };
    });
    return { id: this.lastBatch.id, counts, rows };
  }
  dropQueued(matches, status = 'cancelled', reason = null) {
    const removed = new Set();
    let count = 0;
    this.queue = this.queue.filter(task => {
      if (!matches(task)) return true;
      count++; removed.add(task.accountId);
      this.finishBatchTask(task, status, reason);
      return false;
    });
    if (removed.size) {
      for (const task of this.queue) removed.delete(task.accountId);
      if (this.active) removed.delete(this.active.accountId);
      for (const id of removed) {
        const account = this.accounts.get(id);
        if (account) account.status = account.authBlocked ? 'auth' : account.userPaused ? 'paused' : !account.enabled ? 'error' : account.lastSync ? 'ok' : 'idle';
      }
    }
    return count;
  }
  cancelBatch(id) {
    if (!this.lastBatch || this.lastBatch.id !== id) return { cancelled: 0 };
    if (this.batchEntry(this.active)?.status === 'pending') this.active.stopRetry = true;
    const cancelled = this.dropQueued(task => this.batchEntry(task)?.status === 'pending');
    this.changed();
    return { cancelled };
  }
  readyAt(task) { return Math.max(task.notBefore, this.accounts.get(task.accountId)?.nextAllowed || 0, this.globalNext, this.holdUntil); }
  recheck(accountId) {
    if (this.closed) throw new AppError('SESSION', message('error.session'), { status: 409 });
    const account = this.account(accountId);
    if (!account.authBlocked) throw new AppError('NO_AUTH_BLOCK', message('recovery.notNeeded'), { status: 409 });
    if (this.active?.accountId === accountId || this.queue.some(task => task.accountId === accountId)) return { queued: false };
    this.queue.push({ id: randomUUID(), accountId, folder: 'inbox', attempt: 1, notBefore: 0, created: this.now(), recheck: true });
    account.status = 'queued';
    this.changed();
    return { queued: true };
  }
  async tick() {
    if (this.active || this.closed || this.settings.paused) return;
    const now = this.now();
    if (this.settings.auto) {
      for (const account of this.accounts.values()) {
        if ((!account.autoNext || account.autoNext <= now) && (this.settings.autoScope !== 'favorites' || account.favorite) && (!this.settings.autoGroup || account.group === this.settings.autoGroup)) {
          this.enqueue(account.id);
          account.autoNext = now + this.settings.interval * 1000 + this.jitter();
        }
      }
    }
    const index = this.queue.findIndex(t => this.readyAt(t) <= now);
    if (index === -1) return;
    const task = this.queue.splice(index, 1)[0];
    const account = this.accounts.get(task.accountId);
    if (!account || (!task.recheck && (account.authBlocked || !account.enabled || account.userPaused))) {
      this.finishBatchTask(task, 'cancelled'); this.changed(); return;
    }
    if (task.attempt > this.settings.maxAttempts) {
      account.enabled = false; account.status = 'error'; account.error = 'Лимит попыток уменьшен. Автоповтор отменён; возобновите ящик вручную при необходимости.';
      account.errorMessage = describe(account.error);
      this.finishBatchTask(task, 'failed', null, account.errorMessage);
      this.dropQueued(t => t.accountId === account.id, 'skipped', 'disabled');
      await this.persist(); this.log(message('log.accountError', { email: account.email, error: account.errorMessage }), 'warning'); return;
    }
    this.active = task;
    account.abortController = new AbortController();
    account.status = 'syncing';
    account.nextAllowed = now + this.settings.accountGap * 1000;
    this.globalNext = now + this.settings.requestGap * 1000;
    this.changed();
    try {
      // Save cooldown before dispatch so restarting cannot clear rate limits.
      await this.persist();
      // Pause/close can arrive while the cooldown is being saved.
      if (this.closed) return;
      if (task.cancelled || task.stopRetry || (!task.recheck && (account.userPaused || account.authBlocked || !account.enabled))) {
        account.status = account.authBlocked ? 'auth' : account.userPaused ? 'paused' : !account.enabled ? 'error' : account.lastSync ? 'ok' : 'idle';
        this.finishBatchTask(task, 'cancelled');
        return;
      }
      if (this.settings.paused) { this.queue.unshift(task); account.status = 'queued'; return; }
      // Count the delay from dispatch, including time spent waiting for storage.
      const dispatchedAt = this.now();
      this.globalNext = Math.max(this.globalNext, dispatchedAt + this.settings.requestGap * 1000);
      account.nextAllowed = Math.max(account.nextAllowed, dispatchedAt + this.settings.accountGap * 1000);
      // A manual access check retains its auth block until a complete read succeeds.
      if (task.recheck) { account.accessToken = null; account.expiresAt = 0; }
      const result = await this.loader(account, task.folder, task.recheck ? Math.min(5, this.settings.limit) : this.settings.limit, { saveTokens: () => this.persist() });
      if (this.closed || !this.accounts.has(account.id)) return;
      account.cache[task.folder] = result;
      result.lastUsed = this.now();
      result.version = randomUUID();
      this.trimCache(result);
      account.lastSync = this.now();
      if (task.recheck) { account.authBlocked = false; account.enabled = true; account.autoNext = this.now() + this.settings.interval * 1000 + this.jitter(); }
      account.status = account.userPaused ? 'paused' : 'ok'; account.error = ''; account.errorMessage = null; account.authFailure = null;
      this.finishBatchTask(task, 'updated');
      this.networkFailures = 0;
      this.log(message('log.refreshed', { email: account.email, count: result.messages.length }));
    } catch (raw) {
      if (this.closed || !this.accounts.has(account.id)) return;
      const error = safeError(raw);
      account.error = error.message;
      account.errorMessage = error.messageDescriptor;
      if (error.auth) {
        account.authFailure = AUTH_ERRORS.has(error.messageDescriptor.key) ? error.messageDescriptor.key : 'error.authNeeded';
        account.authBlocked = true; account.enabled = false; account.status = 'auth';
        this.dropQueued(t => t.accountId === account.id, 'skipped', 'auth');
      } else if (error.retryable) {
        const delay = Math.max(ACCOUNT_GAP * 2 ** (task.attempt - 1) + this.jitter(), error.retryAfter);
        account.nextAllowed = Math.max(account.nextAllowed, this.now() + delay);
        if (error.code === 'THROTTLED') this.holdUntil = Math.max(this.holdUntil, this.now() + Math.max(60000, error.retryAfter));
        this.networkFailures++;
        if (this.networkFailures >= 3) { this.holdUntil = Math.max(this.holdUntil, this.now() + 120000); this.networkFailures = 0; }
        if (task.recheck) {
          account.status = 'auth';
          if (error.code !== 'THROTTLED') { account.errorMessage = message('recovery.unavailable'); account.error = translate(account.errorMessage, 'ru'); }
        } else if (!task.stopRetry && task.attempt < this.settings.maxAttempts && !account.userPaused) {
          this.queue.push({ ...task, attempt: task.attempt + 1, notBefore: account.nextAllowed });
          account.status = 'waiting';
        } else if (account.userPaused) { account.status = 'paused'; }
        else if (task.stopRetry) { account.status = 'error'; account.errorMessage = message('batch.retryCancelled'); account.error = translate(account.errorMessage, 'ru'); }
        else { account.enabled = false; account.status = 'error'; account.errorMessage = message('error.exhausted', { error: account.errorMessage, count: this.settings.maxAttempts }); account.error = translate(account.errorMessage, 'ru'); }
      } else { account.enabled = false; account.status = task.recheck ? 'auth' : 'error'; }
      if (account.status !== 'waiting') this.finishBatchTask(task, 'failed', null, account.errorMessage);
      this.log(message('log.accountError', { email: account.email, error: account.errorMessage }), 'warning');
    } finally {
      this.active = null;
      try { await this.persist(); } catch (e) { this.log(e.message, 'error'); }
      this.changed();
      this.emit('idle');
    }
  }
  async updateSettings(input) {
    const previous = this.settings;
    this.settings = validateSettings(input, this.settings);
    try { await this.persist(); } catch (e) { this.settings = { ...previous, paused: true }; throw e; }
    this.trimCache(); this.logs.length = Math.min(this.logs.length, this.settings.logLimit); this.changed();
  }
  selection(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new AppError('SELECTION', message('error.selection'));
    return [...new Set(ids)].map(id => this.account(id));
  }
  async updateMeta(id, input) {
    const account = this.account(id);
    const previous = { label: account.label, group: account.group, note: account.note, favorite: account.favorite };
    const next = {
      label: cleanText(input.label ?? account.label ?? '', 60, 'названия'),
      group: cleanText(input.group ?? account.group ?? '', 40, 'группы'),
      note: cleanText(input.note ?? account.note ?? '', 250, 'заметки'),
      favorite: input.favorite ?? account.favorite ?? false
    };
    if (typeof next.favorite !== 'boolean') throw new AppError('METADATA', 'Проверьте признак избранного.');
    Object.assign(account, next);
    try { await this.persist(); } catch (e) { Object.assign(account, previous); throw e; }
    this.changed();
  }
  async bulk(ids, action, value, confirmed = false) {
    const accounts = this.selection(ids);
    if (!['pause', 'resume', 'favorite', 'group', 'remove', 'clearCache'].includes(action)) throw new AppError('ACTION', 'Неизвестное действие.');
    if (action === 'remove' && !confirmed) throw new AppError('CONFIRM', 'Подтвердите удаление выбранных ящиков.');
    if (action === 'remove' && accounts.some(a => a.id === this.active?.accountId)) throw new AppError('BUSY', 'Один из выбранных ящиков обновляется. Дождитесь завершения запроса.');
    if (action === 'group') value = cleanText(value, 40, 'группы');
    if (action === 'favorite' && typeof value !== 'boolean') throw new AppError('METADATA', 'Проверьте признак избранного.');
    const backups = accounts.map(account => [account, { ...account }]);
    let updated = 0, skipped = 0;
    for (const account of accounts) {
      if (action === 'resume' && account.authBlocked) { skipped++; continue; }
      if (action === 'pause') { account.userPaused = true; if (this.active?.recheck && this.active.accountId === account.id) this.active.cancelled = true; if (this.active?.accountId !== account.id) account.status = account.authBlocked ? 'auth' : 'paused'; }
      if (action === 'resume') { account.userPaused = false; account.enabled = true; account.error = ''; account.errorMessage = null; account.status = this.active?.accountId === account.id ? 'syncing' : 'idle'; account.autoNext = 0; }
      if (action === 'favorite') account.favorite = value;
      if (action === 'group') account.group = value;
      if (action === 'remove') this.accounts.delete(account.id);
      if (action === 'clearCache') account.cache = {};
      updated++;
    }
    try { await this.persist(); }
    catch (e) { for (const [account, original] of backups) { Object.assign(account, original); this.accounts.set(account.id, account); } throw e; }
    if (['pause', 'remove'].includes(action)) { const ids = new Set(accounts.map(a => a.id)); this.dropQueued(t => ids.has(t.accountId)); }
    const labels = { pause: 'Приостановлены', resume: 'Возобновлены', favorite: 'Избранное обновлено', group: 'Группа изменена', remove: 'Удалены из профиля', clearCache: 'Кэш освобождён' };
    this.log(message('log.bulk', { action: describe(labels[action]), count: updated, skipped }));
    return { updated, skipped };
  }
  async resume(id) {
    const account = this.account(id);
    if (account.authBlocked) throw new AppError('AUTH_REQUIRED', account.errorMessage || message('error.authNeeded'));
    await this.bulk([id], 'resume');
  }
  async remove(id) {
    const account = this.account(id);
    if (this.active?.accountId === id) throw new AppError('BUSY', 'Дождитесь завершения запроса перед удалением ящика.');
    this.accounts.delete(id);
    try { await this.persist(); } catch (e) { this.accounts.set(id, account); throw e; }
    this.dropQueued(t => t.accountId === id);
    this.log('Ящик удалён из локального профиля.');
  }
  cancel(taskId) {
    if (this.dropQueued(task => task.id === taskId)) this.changed();
  }
  start() { this.timer = setInterval(() => this.tick().catch(() => { this.settings.paused = true; this.log('Очередь остановлена из-за внутренней ошибки.', 'error'); }), 500); }
  async close() {
    this.closed = true; clearInterval(this.timer);
    const idle = this.active ? new Promise(resolve => this.once('idle', resolve)) : Promise.resolve();
    for (const a of this.accounts.values()) { a.abortController?.abort(); a.activeClient?.close(); }
    await idle;
    await this.vault?.close();
  }
}
