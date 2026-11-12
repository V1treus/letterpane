import { selectAccounts, pageRows, virtualRange } from './view-model.js';
import { t, getLanguage, getIntlLocale, setLanguage, translatePage, translatedMessage } from './i18n.js';
import { applyAppearance, appearanceDefaults, fillSettings, readSettings, accountRowHeight } from './customize.js';
import { changedSettings, coalescedUpdater, replaceContent, lockForm, lockControl, showFormError } from './interaction.js';
const $ = id => document.getElementById(id);
const icons = {
  inbox: '<path d="M4 4h16l2 12v4H2v-4z"/><path d="M2 16h6l2 3h4l2-3h6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  settings: '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 1-3-2-2 1-3-3-2-3 1-2-2z"/><circle cx="11" cy="11" r="3"/>',
  refresh: '<path d="M20 8a8 8 0 0 0-14-3L3 8m0-5v5h5M4 16a8 8 0 0 0 14 3l3-3m0 5v-5h-5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-3-3 3-3m-6 0 3-3"/>',
  link: '<path d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0)"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  flask: '<path d="M9 3h6M10 3v6l-6 10q-1 2 2 2h12q3 0 2-2L14 9V3M8 14h8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'
  ,accounts: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 9v12"/>'
  ,star: '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3L2.8 9.7l6.4-.9z"/>'
  ,folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10H3z"/>'
  ,next: '<path d="m10 6 6 6-6 6"/>'
};
function icon(name) {
  const span = document.createElement('span');
  span.setAttribute('aria-hidden', 'true'); span.dataset.icon = name;
  // Only constant, application-owned SVG markup is inserted as HTML.
  span.innerHTML = `<svg viewBox="0 0 24 24">${icons[name] || icons.mail}</svg>`;
  return span;
}
document.querySelectorAll('[data-icon]').forEach(node => node.replaceChildren(...icon(node.dataset.icon).childNodes));
translatePage();
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (['checked', 'disabled'].includes(key)) node[key] = !!value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
const initialToken = /^[0-9a-f]{64}$/.test(location.hash.slice(1)) ? location.hash.slice(1) : '';
const token = initialToken || sessionStorage.getItem('letterpane-session') || '';
if (initialToken) { sessionStorage.setItem('letterpane-session', token); history.replaceState(null, '', '/'); }
let model = null, selectedAccount = null, selectedMessage = null, folder = 'inbox', filter = 'all', view = 'mail';
let messages = [], loaded = false, connected = false, selectionVersion = 0;
let sidebarSignature = '', messageSignature = '', readerSignature = '', detailSignature = '';
let toastTimer, importCheckedText = '', importBusy = false, importGeneration = 0;
let sidebarFavorites = false, managerFavorites = false, managerPage = 1, queuePage = 1;
let batchViewed, batchExpanded = false, batchFilter = 'all', batchPage = 1, batchSubmitting = false, batchCancelling = null;
const BATCH_LABELS = { pending: 'batch.pending', running: 'batch.running', updated: 'batch.updated', failed: 'batch.failed', skipped: 'batch.skipped', cancelled: 'batch.cancelled' };
const BATCH_REASONS = { auth: 'batch.reason.auth', paused: 'batch.reason.paused', disabled: 'batch.reason.disabled', busy: 'batch.reason.busy' };
let managerData = [], managerPageData = [], managerSignature = '', lastGroups = '', appearanceSignature = '', loadedAccountKey = '';
let settingsDraft = null, settingsBaseline = null, resizeDraft = null, managedAccountId = null, bulkAction = '', bulkIds = [];
const selectedIds = new Set();
const accessCheckRequests = new Set();
let codesPage = 1, codesPages = 1, codesRequest = 0, codesTimer;

async function api(path, data, method = data === undefined ? 'GET' : 'POST') {
  let response, result;
  try {
    response = await fetch(`/api${path}`, {
      method, cache: 'no-store', signal: AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${token}`, 'Accept-Language': getLanguage(), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {})
    });
    result = await response.json();
  } catch { throw new Error(t('common.offline')); }
  if (!response.ok) throw new Error(result.message ? t(result.message) : result.error || t('common.actionFailed'));
  return result;
}
function notify(text) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
const act = fn => async event => { try { await fn(event); } catch (error) { notify(error.message || t('common.offline')); } };
const controlAction = fn => act(async event => {
  const unlock = lockControl(event.currentTarget); if (!unlock) return;
  try { await fn(event); } finally { unlock(); }
});
function current() { return model?.accounts.find(a => a.id === selectedAccount); }
function statusName(status) { return ({ idle: t('status.idle'), ok: t('status.ok'), queued: t('status.queued'), syncing: t('status.syncing'), waiting: t('status.waiting'), auth: t('status.auth'), error: t('status.error'), paused: t('status.paused') })[status] || t('status.pending'); }
function time(timestamp) { return new Intl.DateTimeFormat(getIntlLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp)); }
function fullDate(timestamp) { return timestamp ? new Intl.DateTimeFormat(getIntlLocale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp)) : t('common.noDate'); }
function waitText(ms) { const s = Math.max(1, Math.ceil(ms / 1000)); return s < 60 ? t('duration.seconds', { count: s }) : t('duration.minutes', { count: Math.ceil(s / 60) }); }
function senderParts(from) { from ||= t('mail.unknownSender'); const match = from.match(/^(.*?)\s*<([^>]+)>/); return match ? { name: match[1].replace(/^"|"$/g, '') || match[2], address: match[2] } : { name: from, address: from }; }
function accountError(account) { return account?.errorMessage ? t(account.errorMessage) : translatedMessage(account?.error || ''); }
function accessCheckLabel(account) { return account?.accessCheckPending ? t(account.status === 'syncing' ? 'recovery.checking' : 'recovery.queued') : t('recovery.check'); }
function accessCheckBusy(account) { return account?.accessCheckPending || accessCheckRequests.has(account?.id); }
function replaceCredentials(id) {
  const account = model?.accounts.find(a => a.id === id); if (!account) return;
  if (model.demo) { notify(t('demo.importBlocked')); return; }
  if ($('meta-form').getAttribute('aria-busy') === 'true') return;
  openImport(); $('replace-existing').checked = true; $('authority').value = account.authority || 'microsoft';
  $('import-title').textContent = t('recovery.replace'); $('account-input').focus();
}
async function checkAccess(id, inDialog = false) {
  const account = model?.accounts.find(a => a.id === id); if (!account || accessCheckBusy(account)) return;
  const unlock = inDialog ? lockForm($('meta-form')) : null;
  if (inDialog && !unlock) return;
  accessCheckRequests.add(id); if (inDialog) $('meta-error').textContent = '';
  renderHeader();
  try { await api(`/accounts/${id}/recheck`, {}); await poll(); notify(t('recovery.queued')); }
  catch (error) { if (inDialog) showFormError($('meta-error'), error.message); else notify(error.message); }
  finally { accessCheckRequests.delete(id); unlock?.(); renderHeader(); }
}
function renderAccountRecovery() {
  if (!$('account-dialog').open) return;
  const account = model?.accounts.find(a => a.id === managedAccountId); if (!account) return;
  $('managed-status').textContent = accountError(account) || statusName(account.status);
  $('managed-recovery').hidden = !account.authBlocked;
  const busy = $('meta-form').getAttribute('aria-busy') === 'true';
  $('recheck-account').disabled = busy || accessCheckBusy(account);
  $('recheck-account-label').textContent = accessCheckLabel(account);
  $('replace-account').disabled = busy || account.status === 'syncing';
  $('resume-account').hidden = (!account.userPaused && account.enabled !== false) || account.authBlocked;
  $('pause-account').hidden = account.userPaused || account.authBlocked;
  $('delete-account').disabled = busy || model.active?.accountId === account.id;
}

function renderSidebar() {
  if (!model) return;
  $('mail-count').textContent = model.accounts.length;
  document.querySelectorAll('[data-view]').forEach(node => { node.classList.toggle('active', node.dataset.view === view); node.setAttribute('aria-current', node.dataset.view === view ? 'page' : 'false'); });
  const rows = selectAccounts(model.accounts, { locale: getIntlLocale(), q: $('sidebar-search').value, favorites: sidebarFavorites, sort: 'favorites' });
  $('sidebar-result').textContent = $('sidebar-search').value || sidebarFavorites ? t('format.of', { count: rows.length, total: model.accounts.length }) : '';
  const rowHeight = accountRowHeight(resizeDraft || settingsDraft || model.settings);
  const range = virtualRange(rows.length, $('accounts').scrollTop, $('accounts').clientHeight || 200, rowHeight);
  const visible = rows.slice(range.start, range.end);
  const signature = JSON.stringify([visible, selectedAccount, range.start, range.end, rowHeight]);
  $('account-spacer').style.height = `${range.total}px`;
  $('account-window').style.top = `${range.offset}px`;
  if (signature === sidebarSignature) return;
  sidebarSignature = signature;
  replaceContent($('account-window'), ...(visible.length ? visible.map(a =>
    h('div', { class: `account-row${a.id === selectedAccount ? ' selected' : ''}` },
      h('button', { class: 'account', 'data-focus-key': `account:${a.id}`, 'data-account-id': a.id, title: `${a.email}: ${statusName(a.status)}`, 'aria-pressed': String(a.id === selectedAccount), onclick: act(() => chooseAccount(a.id)) },
        h('span', { class: 'account-avatar', 'aria-hidden': 'true' }, (a.label || a.email).slice(0, 2).toUpperCase()),
        h('span', { class: 'account-info' },
          h('span', { class: 'account-name-line' }, ['auth', 'error', 'paused', 'queued', 'syncing', 'waiting'].includes(a.status) ? h('span', { class: `mini-dot ${a.status}`, 'aria-hidden': 'true' }) : null, h('span', { class: 'account-alias' }, a.label || a.email)),
          a.label ? h('span', { class: 'account-secondary' }, a.email) : a.group ? h('span', { class: 'account-secondary account-group' }, a.group) : null)),
      favoriteButton(a))) : model.accounts.length ? [h('p', { class: 'sidebar-empty' }, t('common.nothingFound'))] : []));
}
function favoriteButton(a) { return h('button', { class: `favorite${a.favorite ? ' active' : ''}`, 'data-focus-key': `favorite:${a.id}`, 'aria-label': `${a.favorite ? t('favorite.remove') : t('favorite.add')}: ${a.email}`, 'aria-pressed': String(a.favorite), onclick: act(async () => { await api(`/accounts/${a.id}/meta`, { favorite: !a.favorite }); await poll(); }) }, icon('star')); }
function renderHeader() {
  $('app-version').textContent = `Letterpane ${model.version}`;
  $('view-title').textContent = ({ accounts: t('nav.accounts'), codes: t('nav.codes'), queue: t('nav.queue'), journal: t('nav.journal') })[view] || current()?.label || current()?.email || t('nav.mail');
  $('view-subtitle').textContent = view === 'mail' && current()?.label ? current().email : '';
  $('view-subtitle').hidden = !$('view-subtitle').textContent;
  $('demo-badge').hidden = !model.demo; $('demo-notice').hidden = !model.demo;
  $('sync-button').disabled = !selectedAccount || current()?.authBlocked || current()?.enabled === false || current()?.userPaused;
  $('sync-button').hidden = view !== 'mail' || !model.accounts.length;
  $('import-button').hidden = !model.accounts.length;
  $('auto-button').setAttribute('aria-pressed', String(model.settings.auto));
  $('auto-label').textContent = t('sync.auto');
  $('auto-button').title = model.settings.auto ? t('sync.disableAuto') : t('sync.enableAuto');
  $('auto-button').setAttribute('aria-label', model.settings.auto ? t('sync.disableAuto') : t('sync.enableAuto'));
  $('auto-button').hidden = view !== 'mail' || !model.accounts.length;
  $('empty-onboarding').hidden = model.accounts.length > 0;
  $('mail-layout').hidden = !model.accounts.length;
  $('mail-view').hidden = view !== 'mail'; $('queue-view').hidden = view !== 'queue'; $('journal-view').hidden = view !== 'journal';
  $('accounts-view').hidden = view !== 'accounts'; $('codes-view').hidden = view !== 'codes';
  $('demo-size').value = String(model.accounts.length);
  $('queue-count').textContent = model.queue.length + (model.active ? 1 : 0);
  const a = current();
  const recoveryHadFocus = $('account-alert').contains(document.activeElement);
  $('account-alert').hidden = !a?.error;
  if (!a?.error && recoveryHadFocus && !document.querySelector('dialog[open]')) $('sync-button').focus({ preventScroll: true });
  if (a?.error) {
    const content = [h('span', { id: 'account-alert-reason' }, accountError(a))];
    if (a.authBlocked) {
      const check = h('button', { class: 'button', type: 'button', 'data-focus-key': `access-check:${a.id}`, disabled: accessCheckBusy(a), title: t('recovery.oneAttempt'), onclick: () => checkAccess(a.id) }, icon('refresh'), accessCheckLabel(a));
      const replace = h('button', { class: 'button', type: 'button', 'data-focus-key': `replace-credentials:${a.id}`, disabled: a.status === 'syncing', onclick: () => replaceCredentials(a.id) }, t('recovery.replace'));
      content.push(h('div', { class: 'recovery-actions' }, check, replace));
    }
    if (a.enabled === false && !a.authBlocked) content.push(h('button', { class: 'button', onclick: act(async () => { await api(`/accounts/${a.id}/resume`, {}); await poll(); }) }, t('sync.resumeAttempts')));
    replaceContent($('account-alert'), ...content);
  }
  renderAccountRecovery();
  renderStatus();
}
function renderStatus() {
  if (!model) return;
  const now = Date.now(); let text, warning = false;
  if (!connected) { text = t('status.disconnected'); }
  else if (model.settings.paused) { text = t('status.queuePaused'); warning = true; }
  else if (model.holdUntil > now) { text = t('status.hold', { duration: waitText(model.holdUntil - now) }); warning = true; }
  else if (model.active) { text = t('status.refreshing', { email: model.active.email }); }
  else if (model.queue.length) { const ready = Math.min(...model.queue.map(t => t.wait)) - (now - modelReceivedAt); text = t('status.queuedCount', { count: model.queue.length }) + (ready > 0 ? t('status.nextRequest', { duration: waitText(ready) }) : t('status.waitingStart')); }
  else { text = model.settings.auto ? t('sync.autoEnabled') : t('common.ready'); }
  $('status-text').textContent = text;
  $('connection-dot').className = `status-dot${!connected ? ' error' : warning ? ' warning' : ''}`;
  $('pause-button').hidden = !model.settings.paused && !model.queue.length && !model.active;
  $('pause-button').replaceChildren(icon(model.settings.paused ? 'play' : 'pause'), h('span', {}, model.settings.paused ? t('common.continue') : t('common.pause')));
  $('pause-button').title = model.settings.paused ? t('queue.resume') : t('queue.pause');
}
let modelReceivedAt = Date.now();

function renderMessages() {
  const search = $('search').value.toLocaleLowerCase();
  const blocked = !!current()?.authBlocked;
  const filtered = messages.filter(m => (filter === 'all' || (filter === 'codes' ? m.codes?.length : m.links?.length)) && `${m.from} ${m.subject} ${m.text}`.toLocaleLowerCase().includes(search));
  $('message-total').textContent = filtered.length === messages.length ? String(messages.length) : `${filtered.length}/${messages.length}`;
  const signature = JSON.stringify([filtered, selectedMessage, selectedAccount, loaded, filter, search, blocked]);
  if (signature === messageSignature) return;
  messageSignature = signature;
  const oldScroll = $('messages').scrollTop;
  if (!filtered.length) {
    const empty = h('div', { class: 'list-empty' }, icon(search || filter !== 'all' ? 'search' : 'inbox'), h('strong', {}, search || filter !== 'all' ? t('mail.noMatches') : loaded ? t('mail.empty') : t('mail.notLoaded')), search || filter !== 'all' ? h('span', {}, t('mail.changeQuery')) : loaded ? h('span', {}, t('mail.tryFolder')) : blocked ? null : h('span', {}, t('mail.refreshHint')));
    if (!blocked && !loaded && !search && filter === 'all') empty.append(h('button', { class: 'button', onclick: act(syncSelected) }, icon('refresh'), t('sync.refreshAccount')));
    replaceContent($('messages'), empty);
  } else {
    replaceContent($('messages'), ...filtered.map(m => {
      const sender = senderParts(m.from);
      const top = h('div', { class: 'message-top' }, m.unread ? h('span', { class: 'unread-dot', 'aria-label': t('mail.unread') }) : null, h('span', { class: 'message-sender' }, sender.name), h('span', { class: 'message-time' }, m.date ? time(m.date) : ''));
      const node = h('button', { class: `message${m.id === selectedMessage ? ' selected' : ''}`, 'data-focus-key': `message:${m.id}`, 'aria-pressed': String(m.id === selectedMessage), onclick: () => { selectedMessage = m.id; renderMessages(); renderReader(); $('mail-layout').classList.add('show-reader'); if (model.settings.readerPosition === 'focus' || $('mail-layout').classList.contains('single-pane')) $('reader').focus(); } }, top, h('p', { class: 'message-subject' }, m.subject || t('mail.noSubject')), h('p', { class: 'message-preview' }, m.preview));
      if (m.codes?.length) node.append(h('span', { class: 'signal-chip' }, icon('key'), m.codes[0]));
      else if (m.links?.length) node.append(h('span', { class: 'signal-chip' }, icon('link'), t('mail.confirmationLink')));
      return node;
    }));
  }
  $('messages').scrollTop = oldScroll;
}
async function copy(value) {
  try { await navigator.clipboard.writeText(value); notify(t('clipboard.copied')); }
  catch { notify(t('clipboard.failed')); }
}
function renderReader() {
  const message = messages.find(m => m.id === selectedMessage);
  const signature = JSON.stringify([message, selectedAccount]);
  if (signature === readerSignature) return;
  readerSignature = signature;
  if (!message) { $('reader').replaceChildren(h('div', { class: 'reader-blank' }, icon('mail'), h('strong', {}, t('mail.select')))); return; }
  const sender = senderParts(message.from);
  const toolbar = h('div', { class: 'reader-toolbar' }, h('button', { class: 'button mobile-back', onclick: () => { $('mail-layout').classList.remove('show-reader'); $('messages').querySelector('.message[aria-pressed="true"]')?.focus(); } }, icon('back'), t('mail.back')), h('span', { class: 'reader-context' }, icon('mail'), folder === 'inbox' ? t('folder.inbox') : t('folder.junk')), h('button', { class: 'button', onclick: () => copy(message.text), title: t('mail.copyTextTitle') }, icon('copy'), t('mail.copyText')));
  const content = h('article', { class: 'reader-content' }, h('h2', {}, message.subject || t('mail.noSubject')), h('div', { class: 'sender-line' }, h('div', { class: 'sender-avatar', 'aria-hidden': 'true' }, sender.name.slice(0, 1).toUpperCase()), h('div', { class: 'sender-detail' }, h('div', { class: 'sender-name' }, sender.name), h('div', { class: 'sender-address' }, sender.address)), h('div', { class: 'sender-date' }, fullDate(message.date))));
  for (const code of message.codes || []) {
    content.append(h('div', { class: 'code-box' }, h('div', {}, h('div', { class: 'code-label' }, icon('key'), t('mail.code')), h('div', { class: 'code-value' }, code)), h('button', { class: 'button copy-code', onclick: () => copy(code) }, icon('copy'), t('common.copy'))));
  }
  for (const link of message.links || []) content.append(h('div', { class: 'link-box' }, h('div', { class: 'link-header' }, icon('link'), t('mail.link')), h('code', {}, link), h('button', { class: 'button', onclick: () => copy(link) }, icon('copy'), t('mail.copyLink'))));
  if (message.truncated) content.append(h('p', { class: 'account-alert' }, t('mail.truncated')));
  if (message.codes?.length || message.links?.length) content.append(h('hr', { class: 'body-divider' }));
  content.append(h('pre', { class: 'message-body' }, message.unavailable ? t('mail.unavailable') : message.text || t('mail.noText')));
  $('reader').replaceChildren(toolbar, content);
  $('reader').scrollTop = 0;
}
function groupNames() { return [...new Set(model.accounts.map(a => a.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, getIntlLocale())); }
function renderGroups() {
  const groups = groupNames();
  const signature = JSON.stringify([groups, model.settings.autoGroup]);
  if (signature === lastGroups) return;
  lastGroups = signature;
  $('group-names').replaceChildren(...groups.map(group => h('option', { value: group })));
  for (const [id, ungrouped] of [['manager-group', true], ['setting-auto-group', false]]) {
    const control = $(id), previous = control.value || (id === 'setting-auto-group' ? model.settings.autoGroup : '');
    const options = [h('option', { value: '' }, t('groups.all'))];
    if (ungrouped) options.push(h('option', { value: '__ungrouped__' }, t('groups.none')));
    for (const group of groups) options.push(h('option', { value: group }, group));
    if (previous && !groups.includes(previous) && previous !== '__ungrouped__') options.push(h('option', { value: previous }, previous));
    control.replaceChildren(...options); control.value = previous;
  }
}
function renderManager(force = false) {
  if (!model || view !== 'accounts') return;
  managerData = selectAccounts(model.accounts, { locale: getIntlLocale(), q: $('manager-search').value, group: $('manager-group').value, status: $('manager-status').value, favorites: managerFavorites, sort: $('manager-sort').value });
  const page = pageRows(managerData, managerPage, Number($('manager-page-size').value));
  managerPage = page.page; managerPageData = page.rows;
  const signature = JSON.stringify([page, model.settings.showAvatars]);
  const issues = model.accounts.filter(a => a.authBlocked || a.enabled === false).length;
  const paused = model.accounts.filter(a => a.userPaused).length;
  replaceContent($('manager-summary'), ...[h('span', {}, t('accounts.found', { count: page.total, total: model.accounts.length })), issues ? h('span', { class: 'summary-issue' }, t('accounts.issueCount', { count: issues })) : null, paused ? h('span', { class: 'summary-paused' }, t('accounts.pausedCount', { count: paused })) : null,
    model.batch ? h('button', { class: 'text-button', 'data-focus-key': 'batch-report', onclick: () => { setView('queue'); $('batch-card')?.focus({ preventScroll: true }); } }, t('batch.open')) : null,
    page.total ? h('button', { class: 'text-button', 'data-focus-key': 'select-found', onclick: () => { managerData.forEach(a => selectedIds.add(a.id)); updateSelectionBar(); } }, t('selection.selectFound')) : null].filter(Boolean));
  if (force || signature !== managerSignature) {
    managerSignature = signature;
    replaceContent($('manager-rows'), ...page.rows.map(a => {
      const box = h('input', { type: 'checkbox', checked: selectedIds.has(a.id), 'data-focus-key': `check:${a.id}`, 'data-check-id': a.id, 'aria-label': t('account.select', { email: a.email }), onchange: event => { event.target.checked ? selectedIds.add(a.id) : selectedIds.delete(a.id); updateSelectionBar(); } });
      const accountButton = h('button', { class: 'table-account', 'data-focus-key': `table:${a.id}`, onclick: act(() => chooseAccount(a.id)), title: a.email }, h('span', { class: 'table-avatar', 'aria-hidden': 'true' }, (a.label || a.email).slice(0, 2).toUpperCase()), h('span', { class: 'table-account-info' }, h('span', { class: 'table-account-name' }, a.label || a.email), a.label ? h('span', { class: 'table-account-email' }, a.email) : null, a.note ? h('span', { class: 'table-note', title: a.note }, a.note) : null));
      const manageButton = h('button', { class: 'icon-button', 'data-focus-key': `manage:${a.id}`, 'aria-label': t('account.manage', { email: a.email }), onclick: () => openAccount(a.id) }, icon('more'));
      return h('tr', { class: selectedIds.has(a.id) ? 'is-selected' : '', 'data-account-row': a.id }, h('td', { class: 'check-cell' }, box), h('td', {}, accountButton), h('td', {}, a.group ? h('span', { class: 'group-pill', title: a.group }, a.group) : h('span', { class: 'table-date' }, t('groups.none'))), h('td', {}, h('span', { class: `state-pill ${a.status}`, title: accountError(a) || statusName(a.status) }, h('span', { class: 'mini-dot', 'aria-hidden': 'true' }), statusName(a.status))), h('td', { class: 'table-date' }, a.lastSync ? fullDate(a.lastSync) : t('account.neverUpdated')), h('td', {}, h('div', { class: 'table-actions' }, favoriteButton(a), manageButton)));
    }));
  }
  $('manager-empty').hidden = page.total > 0;
  if (!page.total) $('manager-empty').replaceChildren(icon('search'), h('strong', {}, model.accounts.length ? t('accounts.notFound') : t('accounts.addFirst')), model.accounts.length ? t('accounts.changeQuery') : t('accounts.importHint'));
  $('manager-range').textContent = page.total ? t('format.range', { start: (page.page - 1) * Number($('manager-page-size').value) + 1, end: Math.min(page.page * Number($('manager-page-size').value), page.total), total: page.total }) : t('accounts.zero');
  $('manager-page').textContent = `${page.page} / ${page.pages}`;
  $('manager-prev').disabled = page.page <= 1; $('manager-next').disabled = page.page >= page.pages;
  updateSelectionBar();
}
function updateSelectionBar() {
  $('bulk-bar').hidden = !selectedIds.size;
  const outside = selectedIds.size - managerData.filter(a => selectedIds.has(a.id)).length;
  $('selected-count').textContent = t('selection.count', { count: selectedIds.size }) + (outside ? ' · ' + t('selection.outsideFilter', { count: outside }) : '');
  $('select-filtered').disabled = !managerData.length;
  $('bulk-bar').querySelector('[data-bulk=sync]').disabled = batchSubmitting;
  $('check-page').disabled = !managerPageData.length;
  $('check-page').checked = managerPageData.length > 0 && managerPageData.every(a => selectedIds.has(a.id));
  $('check-page').indeterminate = managerPageData.some(a => selectedIds.has(a.id)) && !$('check-page').checked;
  for (const box of $('manager-rows').querySelectorAll('[data-check-id]')) {
    box.checked = selectedIds.has(box.dataset.checkId);
    box.closest('tr').classList.toggle('is-selected', box.checked);
  }
}
function openBulk(action, ids = [...selectedIds]) {
  if (!ids.length) return;
  bulkAction = action; bulkIds = [...ids];
  $('bulk-error').textContent = '';
  $('bulk-group-field').hidden = action !== 'group';
  $('bulk-group-name').value = '';
  $('bulk-title').textContent = action === 'remove' ? t('bulk.removeTitle', { count: ids.length }) : t('bulk.groupTitle', { count: ids.length });
  $('bulk-description').textContent = action === 'remove' ? t('bulk.removeDescription') : t('bulk.groupDescription');
  $('bulk-confirm').className = action === 'remove' ? 'button danger' : 'button primary';
  $('bulk-confirm').textContent = action === 'remove' ? t('bulk.removeConfirm') : t('bulk.assignGroup');
  $('bulk-dialog').showModal();
}
async function runBulk(action) {
  const ids = [...selectedIds]; if (!ids.length) return;
  if (action === 'copy') { await copy(ids.map(id => model.accounts.find(a => a.id === id)?.email).filter(Boolean).join('\n')); return; }
  if (['group', 'remove'].includes(action)) { openBulk(action, ids); return; }
  if (action === 'sync') return requestBatch(ids);
  const result = await api('/accounts/bulk', { ids, action, ...(action === 'favorite' ? { value: true } : {}) });
  notify(t('bulk.result', { count: result.updated, skipped: result.skipped }));
  await poll();
}
async function requestBatch(ids) {
  if (batchSubmitting) return;
  batchSubmitting = true; updateSelectionBar(); renderDetail();
  try {
    const result = await api('/sync', ids ? { ids } : {});
    const reasons = Object.entries(result.reasons).filter(([, count]) => count).map(([reason, count]) => t('batch.reasonCount', { reason: t(BATCH_REASONS[reason]), count }));
    notify([t('bulk.queued', { count: result.queued, skipped: result.skipped }), ...reasons].join(' · '));
    await poll();
  } finally { batchSubmitting = false; updateSelectionBar(); renderDetail(); }
}
async function cancelLatestBatch(id) {
  if (batchCancelling) return;
  batchCancelling = id; renderDetail();
  try {
    const result = await api('/queue/cancel-batch', { id });
    await poll(); notify(t('batch.cancelledToast', { count: result.cancelled }));
  } finally { batchCancelling = null; renderDetail(); }
}
async function refreshCodes() {
  if (view !== 'codes') return;
  const request = ++codesRequest;
  const result = await api(`/codes?q=${encodeURIComponent($('codes-search').value.slice(0, 200))}&page=${codesPage}`);
  if (request !== codesRequest || view !== 'codes') return;
  codesPage = result.page; codesPages = result.pages;
  $('codes-total').textContent = t('codes.count', { count: result.total });
  $('codes-page').textContent = `${codesPage} / ${codesPages}`;
  $('codes-prev').disabled = codesPage <= 1; $('codes-next').disabled = codesPage >= codesPages;
  $('codes-results').replaceChildren(...(result.rows.length ? result.rows.map(row => h('article', { class: 'code-result' }, h('div', { class: 'code-result-info' }, h('div', { class: 'code-result-email' }, row.label ? `${row.label} · ${row.email}` : row.email), h('h2', { class: 'code-result-subject' }, row.subject || t('mail.noSubject')), h('div', { class: 'code-result-date' }, fullDate(row.date))), h('span', { class: 'code-result-value' }, row.codes[0]), h('div', { class: 'code-result-actions' }, h('button', { class: 'button copy-code', onclick: () => copy(row.codes[0]) }, icon('copy'), t('common.copy')), h('button', { class: 'button', onclick: act(() => chooseAccount(row.accountId, { nextFolder: row.folder, messageId: row.messageId })) }, t('codes.openMessage'))))) : [h('div', { class: 'detail-empty' }, icon('key'), h('strong', {}, t('codes.empty')), t('codes.emptyHint'))]));
}
function openAccount(id) {
  const a = model.accounts.find(a => a.id === id); if (!a) return;
  managedAccountId = id;
  $('managed-email').textContent = a.email; $('managed-status').textContent = accountError(a) || statusName(a.status);
  $('meta-label').value = a.label; $('meta-group').value = a.group; $('meta-note').value = a.note; $('meta-favorite').checked = a.favorite; $('meta-error').textContent = '';
  $('resume-account').hidden = (!a.userPaused && a.enabled !== false) || a.authBlocked;
  $('pause-account').hidden = a.userPaused || a.authBlocked;
  $('delete-account').disabled = model.active?.accountId === id;
  $('account-dialog').showModal();
  renderAccountRecovery();
}
function applyModelAppearance() {
  const settings = resizeDraft || settingsDraft || model?.settings; if (!settings) return;
  if (getLanguage() !== settings.language || document.documentElement.lang !== settings.language) {
    setLanguage(settings.language); translatePage();
    sidebarSignature = messageSignature = readerSignature = detailSignature = managerSignature = lastGroups = '';
    renderSidebar(); renderHeader(); renderMessages(); renderReader(); renderGroups(); renderDetail(); renderManager(true);
    if (view === 'codes') refreshCodes().catch(error => notify(error.message));
  }
  const signature = JSON.stringify(Object.keys(appearanceDefaults).map(k => settings[k]));
  if (signature === appearanceSignature) return;
  appearanceSignature = signature; applyAppearance(settings); sidebarSignature = ''; renderSidebar(); updateReadingLayout(settings);
}
function updateReadingLayout(settings = resizeDraft || settingsDraft || model?.settings) {
  if (!settings) return;
  $('mail-layout').classList.toggle('single-pane', $('main').clientWidth < settings.messageWidth + 380);
}
function renderDetail() {
  if (model.batch?.id !== batchViewed) { batchViewed = model.batch?.id; batchExpanded = false; batchFilter = 'all'; batchPage = 1; }
  const signature = JSON.stringify([view, model.revision, queuePage, batchExpanded, batchFilter, batchPage, batchSubmitting, batchCancelling]);
  if (signature === detailSignature) return;
  detailSignature = signature;
  if (view === 'queue') {
    const nodes = [h('div', { class: 'section-intro' }, h('button', { class: 'button', 'data-focus-key': 'refresh-all', disabled: batchSubmitting || !model.accounts.length, onclick: act(() => requestBatch()) }, icon('refresh'), t('sync.refreshAll'))),
      h('div', { class: 'queue-policy' }, h('span', {}, icon('layers'), t('queue.oneSession')), h('span', {}, icon('clock'), t('queue.gap', { count: model.settings.requestGap })), h('span', {}, icon('shield'), t('queue.attemptLimit', { count: model.settings.maxAttempts })))];
    if (model.batch) nodes.push(renderBatch(model.batch));
    if (model.active) nodes.push(taskRow(model.active, true));
    const page = pageRows(model.queue, queuePage, 50); queuePage = page.page;
    nodes.push(...page.rows.map(t => taskRow(t, false)));
    const firstStartWait = Math.max(0, Math.max(model.globalNext, model.holdUntil) - Date.now());
    const minimumWait = firstStartWait + (model.queue.length - 1) * model.settings.requestGap * 1000;
    if (model.queue.length && minimumWait > 0) nodes.push(h('div', { class: 'queue-estimate' }, t('queue.estimate', { count: model.queue.length, duration: waitText(minimumWait) })));
    if (page.pages > 1) nodes.push(h('div', { class: 'manager-pagination' }, h('button', { class: 'button', disabled: page.page <= 1, onclick: () => { queuePage--; renderDetail(); } }, t('common.back')), h('span', {}, `${page.page} / ${page.pages}`), h('button', { class: 'button', disabled: page.page >= page.pages, onclick: () => { queuePage++; renderDetail(); } }, t('common.next'))));
    if (!model.active && !model.queue.length) nodes.push(h('div', { class: 'detail-empty' }, icon('check'), h('strong', {}, t('queue.empty')), t('queue.emptyHint')));
    replaceContent($('queue-view'), ...nodes);
  }
  if (view === 'journal') $('journal-view').replaceChildren(...model.logs.map(log => h('div', { class: `log-row ${log.level}` }, h('time', { class: 'log-time', datetime: new Date(log.time).toISOString() }, time(log.time)), h('span', { class: 'log-text' }, log.message ? t(log.message) : translatedMessage(log.text)))), ...(!model.logs.length ? [h('div', { class: 'detail-empty' }, icon('activity'), h('strong', {}, t('journal.empty')))] : []));
}
const batchGroup = status => ['queued', 'waiting'].includes(status) ? 'pending' : status;
function renderBatch(batch) {
  const counts = { ...batch.counts, pending: batch.counts.queued + batch.counts.waiting };
  const finished = batch.rows.length - counts.pending - counts.running;
  const number = new Intl.NumberFormat(getIntlLocale());
  const header = h('div', { class: 'batch-header' }, h('div', {}, h('h2', { id: 'batch-title' }, t('batch.title')), h('span', { class: 'muted' }, t('count.accounts', { count: batch.rows.length }))),
    counts.pending ? h('button', { id: 'batch-cancel', class: 'button', 'data-focus-key': 'batch-cancel', disabled: Boolean(batchCancelling), onclick: act(() => cancelLatestBatch(batch.id)) }, t('batch.cancel')) : null);
  const stats = h('div', { class: 'batch-counts' }, ...Object.entries(BATCH_LABELS).filter(([key]) => counts[key] || key === 'updated').map(([key, label]) =>
    h('span', { class: `batch-count ${key}`, 'data-batch-count': key }, t(label), h('strong', {}, number.format(counts[key])))));
  const details = h('details', { id: 'batch-details', open: batchExpanded ? '' : null, ontoggle: event => {
    const node = event.currentTarget;
    if (node.isConnected && batchExpanded !== node.open) { batchExpanded = node.open; renderDetail(); }
  } }, h('summary', { 'data-focus-key': 'batch-details' }, t('batch.details')));
  if (batchExpanded) {
    const filter = h('select', { id: 'batch-filter', 'data-focus-key': 'batch-filter', 'aria-label': t('batch.filter'), onchange: event => { batchFilter = event.target.value; batchPage = 1; renderDetail(); } },
      h('option', { value: 'all' }, t('batch.all')), ...Object.entries(BATCH_LABELS).map(([key, label]) => h('option', { value: key }, t(label))));
    filter.value = batchFilter;
    const page = pageRows(batch.rows.filter(row => batchFilter === 'all' || batchGroup(row.status) === batchFilter), batchPage, 25); batchPage = page.page;
    details.append(filter, h('div', { id: 'batch-results' }, ...page.rows.map(row => {
      const status = batchGroup(row.status);
      const explanation = row.reason ? t(BATCH_REASONS[row.reason]) : row.errorMessage ? t(row.errorMessage) : '';
      return h('div', { class: 'batch-result', 'data-batch-result': status }, h('div', {}, h('strong', {}, row.email || t('batch.removed')), explanation ? h('span', { class: 'muted' }, explanation) : null),
        h('span', { class: `batch-result-state ${status}` }, row.status === 'waiting' ? t('status.waiting') : t(BATCH_LABELS[status])));
    }), page.total ? null : h('p', { class: 'muted' }, t('batch.noResults'))));
    if (page.pages > 1) details.append(h('div', { class: 'batch-pages' }, h('button', { class: 'button', 'data-focus-key': 'batch-prev', disabled: page.page <= 1, onclick: () => { batchPage--; renderDetail(); } }, t('common.back')), h('span', {}, `${page.page} / ${page.pages}`), h('button', { class: 'button', 'data-focus-key': 'batch-next', disabled: page.page >= page.pages, onclick: () => { batchPage++; renderDetail(); } }, t('common.next'))));
  }
  return h('section', { class: 'batch-card', id: 'batch-card', tabindex: '-1', 'data-focus-key': 'batch-card', 'aria-labelledby': 'batch-title' }, header,
    h('progress', { class: 'batch-progress', max: batch.rows.length, value: finished, 'aria-label': t('batch.progress') }), stats, details);
}
function taskRow(task, active) {
  return h('div', { class: 'task-row' }, h('span', { class: `task-symbol${active ? ' spin' : ''}` }, icon(active ? 'refresh' : 'clock')), h('div', { class: 'task-text' }, h('span', { class: 'task-email' }, task.email), h('span', { class: 'task-meta' }, task.recheck ? t('recovery.oneAttempt') : t('queue.task', { folder: task.folder === 'inbox' ? t('folder.inbox') : t('folder.junk'), attempt: task.attempt, total: model.settings.maxAttempts }))), active ? h('span', { class: 'active-label' }, task.recheck ? t('recovery.checking') : t('queue.receiving')) : h('span', { class: 'task-wait', 'data-ready': modelReceivedAt + task.wait }, task.wait > 0 ? t('queue.in', { duration: waitText(task.wait) }) : t('queue.waiting')), active ? null : h('button', { class: 'icon-button', 'aria-label': t('queue.remove', { email: task.email }), onclick: act(async () => { await api('/queue/cancel', { id: task.id }); await poll(); }) }, icon('close')));
}
function setView(next) {
  if (!model) return;
  view = next; renderSidebar(); renderHeader(); renderDetail(); renderManager();
  if (view === 'codes') refreshCodes().catch(error => notify(error.message));
}
async function chooseAccount(id, { nextFolder = folder, messageId = null } = {}) {
  selectedAccount = id; selectedMessage = messageId; messages = []; loaded = false; loadedAccountKey = ''; selectionVersion++; folder = nextFolder;
  document.querySelectorAll('[data-folder]').forEach(n => n.classList.toggle('active', n.dataset.folder === folder));
  const sidebarRows = selectAccounts(model.accounts, { locale: getIntlLocale(), q: $('sidebar-search').value, favorites: sidebarFavorites, sort: 'favorites' });
  if (!sidebarRows.some(a => a.id === id)) { $('sidebar-search').value = ''; sidebarFavorites = false; $('sidebar-favorites').setAttribute('aria-pressed', 'false'); }
  const index = selectAccounts(model.accounts, { locale: getIntlLocale(), q: $('sidebar-search').value, favorites: sidebarFavorites, sort: 'favorites' }).findIndex(a => a.id === id);
  const rowHeight = accountRowHeight(model.settings);
  if (index * rowHeight < $('accounts').scrollTop || (index + 1) * rowHeight > $('accounts').scrollTop + $('accounts').clientHeight) $('accounts').scrollTop = Math.max(0, index * rowHeight);
  $('mail-layout').classList.remove('show-reader'); $('search').value = ''; filter = 'all';
  document.querySelectorAll('[data-filter]').forEach(n => n.classList.toggle('active', n.dataset.filter === filter));
  setView('mail'); renderMessages(); renderReader(); await fetchMessages();
  if (messageId) $('mail-layout').classList.add('show-reader');
}
function accountCacheKey() { const account = current(); return `${selectedAccount}|${folder}|${account?.cacheVersions?.[folder] || 'empty'}|${!!account?.authBlocked}`; }
async function fetchMessages() {
  if (!selectedAccount) return;
  const request = ++selectionVersion, id = selectedAccount, key = accountCacheKey();
  const result = await api(`/accounts/${id}/messages?folder=${folder}`);
  if (request !== selectionVersion || id !== selectedAccount) return;
  messages = result.messages; loaded = result.loaded; loadedAccountKey = key;
  if (!messages.some(m => m.id === selectedMessage)) selectedMessage = model.settings.autoSelect ? messages[0]?.id || null : null;
  if (selectedMessage && model.settings.readerPosition === 'focus' && model.settings.autoSelect) $('mail-layout').classList.add('show-reader');
  renderMessages(); renderReader();
}
async function syncSelected() {
  if (!selectedAccount) return;
  const account = current();
  if (!account?.enabled || account.userPaused) { notify(account?.authBlocked ? accountError(account) || t('error.authNeeded') : t('sync.resumeHint')); return; }
  const response = await api('/sync', { accountId: selectedAccount, folder });
  notify(t(response.queued ? 'sync.added' : response.prioritized ? 'sync.prioritized' : 'sync.alreadyQueued')); await poll();
}
const poll = coalescedUpdater(async () => {
  try {
    const query = new URLSearchParams();
    if (model) query.set('since', model.revision);
    if (selectedAccount && view === 'mail') { query.set('reading', selectedAccount); query.set('folder', folder); }
    const next = await api(`/state?${query}`); connected = true;
    if (next.unchanged) { renderStatus(); return; }
    modelReceivedAt = Date.now();
    const changed = !model || model.revision !== next.revision;
    model = next;
    const ids = new Set(model.accounts.map(a => a.id));
    for (const id of selectedIds) if (!ids.has(id)) selectedIds.delete(id);
    if (!ids.has(selectedAccount)) { selectedAccount = model.accounts[0]?.id || null; selectedMessage = null; messages = []; loaded = false; loadedAccountKey = ''; }
    applyModelAppearance(); renderGroups(); renderSidebar(); renderHeader(); renderDetail(); renderManager();
    if (selectedAccount && (loadedAccountKey !== accountCacheKey() || !messageSignature)) await fetchMessages();
    if (changed && view === 'codes') await refreshCodes();
    if (!selectedAccount) { renderMessages(); renderReader(); }
  } catch { connected = false; if (model) renderStatus(); else $('status-text').textContent = t('session.openFailed'); }
});

document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => setView(node.dataset.view)));
document.querySelectorAll('[data-folder]').forEach(node => node.addEventListener('click', act(async () => {
  folder = node.dataset.folder; selectedMessage = null; messages = []; loaded = false;
  document.querySelectorAll('[data-folder]').forEach(n => n.classList.toggle('active', n === node));
  $('mail-layout').classList.remove('show-reader'); renderHeader(); renderMessages(); renderReader(); await fetchMessages();
})));
document.querySelectorAll('[data-filter]').forEach(node => node.addEventListener('click', () => { filter = node.dataset.filter; document.querySelectorAll('[data-filter]').forEach(n => n.classList.toggle('active', n === node)); renderMessages(); }));
$('search').addEventListener('input', renderMessages);
$('sync-button').addEventListener('click', act(syncSelected));
$('pause-button').addEventListener('click', controlAction(async () => { await api('/settings', { paused: !model.settings.paused }); await poll(); }));
$('auto-button').addEventListener('click', controlAction(async () => { const auto = !model.settings.auto; await api('/settings', { auto }); await poll(); notify(auto ? t('sync.autoEnabled') : t('sync.autoDisabled')); }));

document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (dialog.querySelector('form[aria-busy="true"]')) event.preventDefault(); }));
document.querySelectorAll('[data-close]').forEach(node => node.addEventListener('click', () => { const dialog = $(node.dataset.close); if (!dialog.querySelector('form[aria-busy="true"]')) dialog.close(); }));
function openImport() { if (model?.demo) { notify(t('demo.importBlocked')); return; } importGeneration++; $('import-title').textContent = t('accounts.add'); $('import-dialog').showModal(); }
['import-button', 'add-small', 'first-import', 'manager-import'].forEach(id => $(id).addEventListener('click', openImport));
$('import-dialog').addEventListener('close', () => { importGeneration++; importBusy = false; $('account-input').value = ''; $('import-file').value = ''; $('import-preview').replaceChildren(); $('import-preview').hidden = true; $('import-error').textContent = ''; $('import-submit').disabled = true; $('import-submit').textContent = t('common.add'); $('preview-button').disabled = false; importCheckedText = ''; });
$('account-input').addEventListener('input', () => { importGeneration++; importCheckedText = ''; if ($('import-form').getAttribute('aria-busy') !== 'true') { importBusy = false; $('preview-button').disabled = false; } $('import-submit').disabled = true; $('import-submit').textContent = t('common.add'); $('import-preview').hidden = true; $('import-error').textContent = ''; });
$('open-import-file').addEventListener('click', () => $('import-file').click());
$('preview-button').addEventListener('click', async () => {
  if (importBusy) return;
  importBusy = true; $('preview-button').disabled = true; $('import-error').textContent = '';
  const text = $('account-input').value, generation = importGeneration;
  try {
    const result = await api('/import/preview', { text });
    if (generation !== importGeneration || !$('import-dialog').open || text !== $('account-input').value) return;
    importCheckedText = text;
    $('import-preview').replaceChildren(h('div', { class: 'preview-summary' }, t('import.summary', { valid: result.emails.length, errors: result.errors.length, duplicates: result.duplicates })), ...result.emails.map(a => h('div', { class: 'preview-email' }, a.email, a.exists ? t('import.alreadyAdded') : '')), ...result.errors.map(e => h('div', { class: 'preview-error' }, t('import.lineError', { line: e.line, error: e.messageDescriptor || e.message }))));
    $('import-preview').hidden = false; $('import-submit').disabled = !result.emails.length;
    $('import-submit').textContent = t('import.addCount', { count: result.emails.length });
  } catch (error) { if (generation === importGeneration) showFormError($('import-error'), error.message); }
  finally { if (generation === importGeneration) { importBusy = false; $('preview-button').disabled = false; } }
});
$('import-form').addEventListener('submit', async event => {
  event.preventDefault(); if (importBusy || !importCheckedText || importCheckedText !== $('account-input').value) return;
  const data = { text: importCheckedText, authority: $('authority').value, replace: $('replace-existing').checked, group: $('import-group').value };
  const unlock = lockForm($('import-form')); if (!unlock) return;
  importBusy = true; $('import-error').textContent = '';
  try { const result = await api('/import', data); $('import-dialog').close(); await poll(); notify(t('import.result', { added: result.added, updated: result.updated, skipped: result.skipped })); }
  catch (error) { showFormError($('import-error'), error.message); }
  finally { unlock(); importBusy = false; $('import-submit').disabled = !importCheckedText; }
});
$('settings-button').addEventListener('click', () => {
  if (!model) return;
  renderGroups(); settingsBaseline = { ...model.settings }; settingsDraft = { ...settingsBaseline }; fillSettings(settingsDraft, $('settings-form')); $('settings-error').textContent = ''; showSettingsTab('appearance'); $('settings-dialog').showModal();
});
$('settings-form').noValidate = true;
$('settings-form').addEventListener('input', () => { settingsDraft = readSettings(settingsBaseline || model.settings, $('settings-form')); applyModelAppearance(); });
$('settings-dialog').addEventListener('close', () => { settingsDraft = null; settingsBaseline = null; appearanceSignature = ''; applyModelAppearance(); });
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const patch = changedSettings(settingsBaseline || model.settings, readSettings(settingsBaseline || model.settings, $('settings-form')));
  const unlock = lockForm($('settings-form')); if (!unlock) return;
  $('settings-error').textContent = '';
  try { if (Object.keys(patch).length) await api('/settings', patch); await poll(); settingsDraft = null; $('settings-dialog').close(); notify(t('settings.saved')); }
  catch (error) { showFormError($('settings-error'), error.message); }
  finally { unlock(); }
});
$('account-menu').addEventListener('click', () => { if (selectedAccount) openAccount(selectedAccount); });
async function changeAccountState(action) {
  const unlock = lockForm($('meta-form')); if (!unlock) return;
  $('meta-error').textContent = '';
  try {
    if (action === 'resume') await api(`/accounts/${managedAccountId}/resume`, {});
    else await api('/accounts/bulk', { ids: [managedAccountId], action: 'pause' });
    await poll(); $('account-dialog').close();
  } catch (error) { showFormError($('meta-error'), error.message); }
  finally { unlock(); }
}
$('resume-account').addEventListener('click', () => changeAccountState('resume'));
$('recheck-account').addEventListener('click', () => checkAccess(managedAccountId, true));
$('replace-account').addEventListener('click', () => replaceCredentials(managedAccountId));
$('pause-account').addEventListener('click', () => changeAccountState('pause'));
$('delete-account').addEventListener('click', () => { const id = managedAccountId; $('account-dialog').close(); openBulk('remove', [id]); });
$('meta-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = { label: $('meta-label').value, group: $('meta-group').value, note: $('meta-note').value, favorite: $('meta-favorite').checked };
  const unlock = lockForm($('meta-form')); if (!unlock) return;
  $('meta-error').textContent = '';
  try { await api(`/accounts/${managedAccountId}/meta`, data); $('account-dialog').close(); await poll(); notify(t('account.saved')); }
  catch (error) { showFormError($('meta-error'), error.message); }
  finally { unlock(); }
});
$('bulk-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = { ids: bulkIds, action: bulkAction, ...(bulkAction === 'group' ? { value: $('bulk-group-name').value } : { confirmed: true }) };
  const unlock = lockForm($('bulk-form')); if (!unlock) return;
  $('bulk-error').textContent = '';
  try { const result = await api('/accounts/bulk', data); $('bulk-dialog').close(); await poll(); notify(t('bulk.result', { count: result.updated, skipped: result.skipped })); }
  catch (error) { showFormError($('bulk-error'), error.message); }
  finally { unlock(); }
});
for (const button of document.querySelectorAll('[data-bulk]')) button.addEventListener('click', act(() => runBulk(button.dataset.bulk)));
$('clear-selection').addEventListener('click', () => { selectedIds.clear(); updateSelectionBar(); });
$('select-filtered').addEventListener('click', () => { managerData.forEach(a => selectedIds.add(a.id)); updateSelectionBar(); });
$('check-page').addEventListener('change', event => { managerPageData.forEach(a => event.target.checked ? selectedIds.add(a.id) : selectedIds.delete(a.id)); updateSelectionBar(); });
for (const id of ['manager-search', 'manager-group', 'manager-status', 'manager-sort', 'manager-page-size']) $(id).addEventListener(id === 'manager-search' ? 'input' : 'change', () => { managerPage = 1; renderManager(); });
$('manager-favorites').addEventListener('click', () => { managerFavorites = !managerFavorites; $('manager-favorites').setAttribute('aria-pressed', String(managerFavorites)); managerPage = 1; renderManager(); });
$('manager-prev').addEventListener('click', () => { managerPage--; renderManager(); $('manager-rows').closest('.accounts-table-wrap').scrollTop = 0; });
$('manager-next').addEventListener('click', () => { managerPage++; renderManager(); $('manager-rows').closest('.accounts-table-wrap').scrollTop = 0; });
$('sidebar-search').addEventListener('input', () => { $('accounts').scrollTop = 0; renderSidebar(); });
$('sidebar-favorites').addEventListener('click', () => { sidebarFavorites = !sidebarFavorites; $('sidebar-favorites').setAttribute('aria-pressed', String(sidebarFavorites)); $('accounts').scrollTop = 0; renderSidebar(); });
let sidebarFrame = 0;
$('accounts').addEventListener('scroll', () => { if (!sidebarFrame) sidebarFrame = requestAnimationFrame(() => { sidebarFrame = 0; renderSidebar(); }); }, { passive: true });
new ResizeObserver(() => renderSidebar()).observe($('accounts'));
new ResizeObserver(() => updateReadingLayout()).observe($('main'));
$('accounts').addEventListener('keydown', event => {
  if (!model || event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return;
  const rows = selectAccounts(model.accounts, { locale: getIntlLocale(), q: $('sidebar-search').value, favorites: sidebarFavorites, sort: 'favorites' });
  if (!rows.length) return;
  event.preventDefault();
  const focused = event.target.closest('[data-account-id]');
  const height = accountRowHeight(resizeDraft || settingsDraft || model.settings);
  const index = focused ? rows.findIndex(a => a.id === focused.dataset.accountId) : Math.floor($('accounts').scrollTop / height);
  const step = event.key.startsWith('Page') ? Math.max(1, Math.floor($('accounts').clientHeight / height)) : focused ? 1 : 0;
  const next = Math.max(0, Math.min(rows.length - 1, event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + (['ArrowUp', 'PageUp'].includes(event.key) ? -step : step)));
  if (next * height < $('accounts').scrollTop) $('accounts').scrollTop = next * height;
  else if ((next + 1) * height > $('accounts').scrollTop + $('accounts').clientHeight) $('accounts').scrollTop = (next + 1) * height - $('accounts').clientHeight;
  sidebarSignature = ''; renderSidebar();
  [...$('account-window').querySelectorAll('[data-account-id]')].find(node => node.dataset.accountId === rows[next].id)?.focus({ preventScroll: true });
});
$('messages').addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...$('messages').querySelectorAll('.message')]; if (!buttons.length) return;
  event.preventDefault();
  const index = buttons.indexOf(event.target.closest('.message'));
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
  buttons[next].focus();
});
$('codes-search').addEventListener('input', () => { clearTimeout(codesTimer); codesPage = 1; codesTimer = setTimeout(() => refreshCodes().catch(error => notify(error.message)), 180); });
$('codes-prev').addEventListener('click', act(async () => { codesPage = Math.max(1, codesPage - 1); await refreshCodes(); }));
$('codes-next').addEventListener('click', act(async () => { codesPage = Math.min(codesPages, codesPage + 1); await refreshCodes(); }));
$('demo-size').addEventListener('change', act(async () => { await api('/demo/size', { count: Number($('demo-size').value) }); selectedIds.clear(); managerPage = 1; loadedAccountKey = ''; await poll(); }));
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  const generation = ++importGeneration;
  importBusy = true; importCheckedText = ''; $('import-submit').disabled = true; $('preview-button').disabled = true; $('import-preview').hidden = true;
  try {
    if (file.size > 1024 * 1024) throw new Error(t('import.fileTooLarge'));
    const text = await file.text();
    if (generation !== importGeneration || !$('import-dialog').open) return;
    $('account-input').value = text; $('account-input').dispatchEvent(new Event('input'));
  }
  catch (error) { if (generation === importGeneration) showFormError($('import-error'), error.message); }
  finally { if (generation === importGeneration) { importBusy = false; $('preview-button').disabled = false; } if (event.target.files[0] === file) event.target.value = ''; }
});
function showSettingsTab(name) {
  document.querySelectorAll('[data-settings-tab]').forEach(button => { button.setAttribute('aria-selected', String(button.dataset.settingsTab === name)); button.tabIndex = button.dataset.settingsTab === name ? 0 : -1; });
  document.querySelectorAll('[data-settings-panel]').forEach(panel => { panel.hidden = panel.dataset.settingsPanel !== name; });
  document.querySelector('.settings-sections').scrollTop = 0;
  $('reset-appearance').hidden = !['appearance', 'layout', 'reading'].includes(name);
}
document.querySelectorAll('[data-settings-tab]').forEach(button => button.addEventListener('click', () => showSettingsTab(button.dataset.settingsTab)));
document.querySelector('.settings-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const buttons = [...document.querySelectorAll('[data-settings-tab]')], index = buttons.indexOf(document.activeElement);
  if (index < 0) return; event.preventDefault();
  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : buttons.length - 1)) % buttons.length;
  const next = buttons[nextIndex]; showSettingsTab(next.dataset.settingsTab); next.focus();
});
const accentColors = [['#345fce', 'color.blue'], ['#157d70', 'color.green'], ['#7955b5', 'color.purple'], ['#a55325', 'color.orange'], ['#ad3f67', 'color.pink'], ['#466173', 'color.gray']];
$('accent-presets').replaceChildren(...accentColors.map(([color, key]) => {
  const button = h('button', { class: 'accent-preset', type: 'button', 'data-color': color, 'data-i18n-attrs': `aria-label:${key};title:${key}`, 'aria-label': t(key), title: t(key), onclick: () => { $('setting-accent').value = color; $('settings-form').dispatchEvent(new Event('input')); } }); button.style.backgroundColor = color; return button;
}));
$('reset-appearance').addEventListener('click', () => {
  const { autoSelect, shortcuts, ...visualDefaults } = appearanceDefaults;
  settingsDraft = { ...readSettings(settingsBaseline || model.settings, $('settings-form')), ...visualDefaults };
  fillSettings(settingsDraft, $('settings-form')); applyModelAppearance();
});
$('clear-all-cache').addEventListener('click', act(async () => { if (!model.accounts.length) { notify(t('cache.alreadyEmpty')); return; } await api('/accounts/bulk', { ids: model.accounts.map(a => a.id), action: 'clearCache' }); loadedAccountKey = ''; await poll(); notify(t('cache.cleared')); }));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { appearanceSignature = ''; applyModelAppearance(); });

// Resize panes locally during a drag, then save once when the pointer is released.
// Keyboard users can resize with arrow keys and restore the default with Home.
for (const handle of document.querySelectorAll('[data-resize]')) {
  const key = handle.dataset.resize;
  const vertical = key === 'messageSplit';
  const bounds = vertical ? [30, 65] : key === 'sidebarWidth' ? [220, 360] : [280, 480];
  const clampWidth = value => Math.max(bounds[0], Math.min(bounds[1], Math.round(value)));
  let drag = null, saving = false;
  const saveWidth = async width => {
    saving = true;
    try { await api('/settings', { [key]: clampWidth(width) }); await poll(); }
    catch (error) { notify(error.message); }
    finally { saving = false; resizeDraft = null; appearanceSignature = ''; applyModelAppearance(); }
  };
  handle.addEventListener('pointerdown', event => {
    if (!model || saving || event.button !== 0) return;
    drag = { id: event.pointerId, x: vertical ? event.clientY : event.clientX, width: model.settings[key] };
    resizeDraft = { ...model.settings }; handle.setPointerCapture(event.pointerId);
    document.body.classList.add(vertical ? 'resizing-vertical' : 'resizing'); handle.classList.add('dragging'); event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const delta = vertical ? (event.clientY - drag.x) / $('mail-layout').clientHeight * 100 : event.clientX - drag.x;
    resizeDraft[key] = clampWidth(drag.width + delta); applyModelAppearance();
  });
  const finish = (event, cancel) => {
    if (!drag || drag.id !== event.pointerId) return;
    const width = resizeDraft[key]; drag = null;
    document.body.classList.remove('resizing', 'resizing-vertical'); handle.classList.remove('dragging');
    if (cancel) { resizeDraft = null; appearanceSignature = ''; applyModelAppearance(); }
    else saveWidth(width);
  };
  handle.addEventListener('pointerup', event => finish(event, false));
  handle.addEventListener('pointercancel', event => finish(event, true));
  handle.addEventListener('lostpointercapture', event => finish(event, true));
  handle.addEventListener('dblclick', () => { if (model && !saving) saveWidth(appearanceDefaults[key]); });
  handle.addEventListener('keydown', event => {
    const keys = vertical ? ['ArrowUp', 'ArrowDown', 'Home'] : ['ArrowLeft', 'ArrowRight', 'Home'];
    if (!model || saving || !keys.includes(event.key)) return;
    event.preventDefault();
    saveWidth(event.key === 'Home' ? appearanceDefaults[key] : model.settings[key] + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) * (vertical ? 5 : 20));
  });
}
document.addEventListener('keydown', event => {
  if (document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape' && $('mail-layout').classList.contains('show-reader')) { $('mail-layout').classList.remove('show-reader'); $('messages').querySelector('.message[aria-pressed="true"]')?.focus(); return; }
  if (!model?.settings.shortcuts) return;
  if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); setView('accounts'); $('manager-search').focus(); return; }
  if (event.altKey && /^[1-5]$/.test(event.key)) { event.preventDefault(); setView(['mail', 'accounts', 'codes', 'queue', 'journal'][Number(event.key) - 1]); return; }
  if (/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  if (event.key === '/' && view === 'mail' && selectedAccount) { event.preventDefault(); $('search').focus(); }
  if (event.key === 'Escape') $('mail-layout').classList.remove('show-reader');
});
await poll();
setInterval(poll, 2500); // Local state only. This never starts Microsoft requests.
setInterval(() => { renderStatus(); for (const node of document.querySelectorAll('.task-wait[data-ready]')) { const wait = Number(node.dataset.ready) - Date.now(); node.textContent = wait > 0 ? t('queue.in', { duration: waitText(wait) }) : t('queue.waiting'); } }, 1000);
