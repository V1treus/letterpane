const collators = new Map();
export function accountStatus(account, status) {
  if (status === 'issues') return account.authBlocked || account.enabled === false;
  if (status === 'paused') return !!account.userPaused;
  if (status === 'queued') return ['queued', 'syncing', 'waiting'].includes(account.status);
  if (status === 'ready') return account.enabled !== false && !account.authBlocked && !account.userPaused;
  return true;
}
export function selectAccounts(accounts, { q = '', group = '', status = '', favorites = false, sort = 'email', locale = 'ru' } = {}) {
  if (!collators.has(locale)) collators.set(locale, new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }));
  const collator = collators.get(locale);
  const words = q.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const rows = accounts.filter(a => (!favorites || a.favorite) && accountStatus(a, status) && (!group || (group === '__ungrouped__' ? !a.group : a.group === group)) && words.every(word => `${a.email} ${a.label || ''} ${a.group || ''} ${a.note || ''}`.toLocaleLowerCase().includes(word)));
  rows.sort((a, b) => {
    if (sort === 'recent') return (b.lastSync || 0) - (a.lastSync || 0) || collator.compare(a.email, b.email);
    if (sort === 'group') return collator.compare(a.group || '', b.group || '') || collator.compare(a.email, b.email);
    if (sort === 'status') return collator.compare(a.status, b.status) || collator.compare(a.email, b.email);
    if (sort === 'name') return collator.compare(a.label || a.email, b.label || b.email);
    if (sort === 'favorites') return Number(!!b.favorite) - Number(!!a.favorite) || collator.compare(a.email, b.email);
    return collator.compare(a.email, b.email);
  });
  return rows;
}
export function pageRows(rows, page = 1, size = 50) {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  page = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((page - 1) * size, page * size), page, pages, total: rows.length };
}
export function virtualRange(count, scroll, height, rowHeight, overscan = 4) {
  scroll = Math.min(Math.max(0, scroll), Math.max(0, count * rowHeight - height));
  const start = Math.max(0, Math.floor(scroll / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scroll + height) / rowHeight) + overscan);
  return { start: Math.min(start, count), end, offset: Math.min(start, count) * rowHeight, total: count * rowHeight };
}
