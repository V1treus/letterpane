import { test as base, expect } from '@playwright/test';
import { createDemo } from '../../src/demo.mjs';
import { Engine } from '../../src/engine.mjs';
import { createServer } from '../../src/server.mjs';
import { AppError } from '../../src/errors.mjs';
import { message } from '../../shared/i18n.mjs';

const test = base.extend({
  real: [false, { option: true }],
  app: async ({ real }, use) => {
    const engine = real ? new Engine() : createDemo();
    await engine.updateSettings({ language: 'en' });
    const server = await createServer(engine);
    try { await use({ ...server, engine }); }
    finally {
      try { await engine.close(); }
      finally {
        await new Promise((resolve, reject) => {
          server.server.close(error => error ? reject(error) : resolve());
          // Playwright may leave the page polling while this fixture shuts down.
          server.server.closeAllConnections();
        });
      }
    }
  }
});
test.beforeEach(async ({ page, app }) => {
  await page.goto(app.url);
  await expect(page.locator('#status-text')).toHaveText('Ready');
});

test('restored IMAP denial retains its explanation and cannot dispatch a new login', async ({ page, app }) => {
  const snapshot = app.engine.snapshot();
  const account = snapshot.accounts[0];
  Object.assign(account, { authBlocked: true, authFailure: 'error.imapAuth', enabled: false });
  const restored = new Engine({ snapshot });
  app.engine.accounts = restored.accounts;
  await page.reload();
  const explanation = 'The server denied mail access. Check IMAP permission and the token. Automatic retries have stopped.';
  await expect(page.locator('#account-alert-reason')).toHaveText(explanation);
  await expect(page.locator('#sync-button')).toBeDisabled();
  await expect(page.locator('#messages .list-empty button')).toHaveCount(0);
  expect(app.engine.queue).toHaveLength(0);
  await page.locator('#account-menu').click();
  await expect(page.locator('#managed-status')).toHaveText(explanation);
  await expect(page.locator('#resume-account')).not.toBeVisible();
  await expect(page.locator('#recheck-account')).toBeVisible();
});

test.describe('access recovery', () => {
  test.use({ real: true });
  const seed = async (page, app, failure = 'error.imapAuth') => {
    await app.engine.import('reader@example.com|synthetic-refresh-token-for-ui-recovery|12345678-1234-1234-1234-123456789abc', 'live');
    const account = [...app.engine.accounts.values()][0];
    Object.assign(account, { authBlocked: true, authFailure: failure, enabled: false, errorMessage: message(failure), error: 'synthetic denial', status: 'auth' });
    app.engine.changed(); await page.reload();
    await expect(page.locator('#account-alert-reason')).toBeVisible();
    return account;
  };

  test('one queued check disables duplicates, preserves the block and can be cancelled', async ({ page, app }) => {
    const account = await seed(page, app);
    app.engine.holdUntil = Date.now() + 180000;
    await page.locator('#account-alert').getByRole('button', { name: 'Check access', exact: true }).click();
    await expect(page.locator('#account-alert').getByRole('button', { name: 'Access check queued', exact: true })).toBeDisabled();
    expect(app.engine.queue).toHaveLength(1); expect(account.authBlocked).toBe(true);
    await page.locator('#account-menu').click();
    await expect(page.locator('#recheck-account')).toBeDisabled();
    await expect(page.locator('#recheck-account')).toHaveText('Access check queued');
    await page.locator('#account-dialog [data-close]').click();
    await page.locator('[data-view=queue]').click();
    await expect(page.locator('.task-meta')).toHaveText('Access check · one attempt');
    await expect(page.locator('.task-wait')).toHaveText(/^In \d+m$/);
    await page.locator('.task-row .icon-button').click();
    expect(app.engine.queue).toHaveLength(0); expect(account.authBlocked).toBe(true);
    await page.locator('[data-view=mail]').click();
    await expect(page.locator('#account-alert').getByRole('button', { name: 'Check access', exact: true })).toBeEnabled();
  });

  test('successful check updates an open account card without discarding its draft', async ({ page, app }) => {
    const account = await seed(page, app);
    app.engine.loader = async () => ({ messages: [], validity: '1' });
    await page.locator('#account-menu').click();
    await page.locator('#meta-label').fill('Keep this draft');
    await page.locator('#recheck-account').click();
    await expect(page.locator('#recheck-account')).toHaveText('Access check queued');
    await app.engine.tick();
    await expect(page.locator('#managed-recovery')).not.toBeVisible();
    await expect(page.locator('#managed-status')).toHaveText('Updated');
    await expect(page.locator('#meta-label')).toHaveValue('Keep this draft');
    await expect(page.locator('#account-dialog')).toBeVisible();
    expect(account.authBlocked).toBe(false);
    await page.locator('#account-dialog [data-close]').click();
    await expect(page.locator('#account-alert')).not.toBeVisible();
    await expect(page.locator('#sync-button')).toBeEnabled();
  });

  test('check submission failure keeps the draft, restores actions and focuses its error', async ({ page, app }) => {
    await seed(page, app);
    await page.route('**/api/accounts/*/recheck', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic queue failure' }) }));
    await page.locator('#account-menu').click();
    await page.locator('#meta-note').fill('Unsaved recovery note');
    await page.locator('#recheck-account').click();
    await expect(page.locator('#meta-error')).toBeFocused();
    await expect(page.locator('#meta-error')).toHaveText('Synthetic queue failure');
    await expect(page.locator('#meta-note')).toHaveValue('Unsaved recovery note');
    await expect(page.locator('#recheck-account')).toBeEnabled();
    expect(app.engine.queue).toHaveLength(0);
  });

  test('pending submission blocks duplicate checks and premature dialog closing', async ({ page, app }) => {
    await seed(page, app);
    let release, entered, writes = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { entered = resolve; });
    await page.route('**/api/accounts/*/recheck', async route => { writes++; entered(); await gate; await route.continue(); });
    await page.locator('#account-menu').click();
    const click = page.locator('#recheck-account').click(); await pending;
    try {
      await expect(page.locator('#meta-form')).toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('#recheck-account')).toBeDisabled();
      await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
      await expect(page.locator('#account-dialog')).toBeVisible();
      await expect(page.locator('#account-dialog [data-close]')).toBeDisabled();
      expect(writes).toBe(1);
    } finally { release(); await click; }
    await expect(page.locator('#meta-form')).toHaveAttribute('aria-busy', 'false');
    expect(app.engine.queue).toHaveLength(1);
  });

  test('replacement keeps the original OAuth mode and does not expose saved credentials', async ({ page, app }) => {
    const account = await seed(page, app, 'error.invalidGrant');
    await page.locator('#account-menu').click();
    await page.locator('#meta-note').fill('Keep replacement draft');
    await page.locator('#replace-account').click();
    await expect(page.locator('#import-title')).toHaveText('Replace credentials');
    await expect(page.locator('#replace-existing')).toBeChecked();
    await expect(page.locator('#authority')).toHaveValue('live');
    await expect(page.locator('#account-input')).toHaveValue('');
    expect(account.authBlocked).toBe(true); expect(app.engine.queue).toHaveLength(0);
    await page.locator('#import-dialog [data-close]').click();
    await expect(page.locator('#account-dialog')).toBeVisible();
    await expect(page.locator('#meta-note')).toHaveValue('Keep replacement draft');
  });

  test('failed check stays blocked and can be deliberately queued again', async ({ page, app }) => {
    const account = await seed(page, app);
    let calls = 0;
    app.engine.loader = async () => { calls++; throw new AppError('IMAP_AUTH', message('error.imapAuth'), { auth: true }); };
    await page.locator('#account-alert').getByRole('button', { name: 'Check access', exact: true }).click();
    await expect(page.locator('#account-alert').getByRole('button', { name: 'Access check queued', exact: true })).toBeDisabled();
    await app.engine.tick();
    await expect(page.locator('#account-alert').getByRole('button', { name: 'Check access', exact: true })).toBeEnabled();
    expect(account.authBlocked).toBe(true); expect(app.engine.queue).toHaveLength(0); expect(calls).toBe(1);
    await page.locator('#account-alert').getByRole('button', { name: 'Check access', exact: true }).click();
    await app.engine.tick(); expect(calls).toBe(1); expect(app.engine.queue).toHaveLength(1);
  });

  test('keyboard focus stays in recovery while waiting and moves to Refresh on success', async ({ page, app }) => {
    await seed(page, app); app.engine.loader = async () => ({ messages: [] });
    const button = page.locator('#account-alert').getByRole('button', { name: 'Check access', exact: true });
    await button.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#account-alert').getByRole('button', { name: 'Access check queued', exact: true })).toBeDisabled();
    await expect(page.locator('#account-alert')).toBeFocused();
    await app.engine.tick();
    await expect(page.locator('#sync-button')).toBeFocused();
  });

  test('recovery actions fit large text in narrow light and dark windows in all languages', async ({ page, app }) => {
    await seed(page, app);
    await page.setViewportSize({ width: 1000, height: 700 });
    for (const theme of ['light', 'graphite']) for (const language of ['ru', 'en', 'uk']) {
      await app.engine.updateSettings({ theme, language, fontSize: 18 }); await page.reload();
      const alert = page.locator('#account-alert');
      await expect(alert.locator('button')).toHaveCount(2);
      expect(await alert.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.locator('#account-menu').click();
      const dialog = page.locator('#account-dialog');
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await expect(page.locator('#recheck-account')).toBeInViewport();
      await expect(page.locator('#replace-account')).toBeInViewport();
      await page.screenshot({ path: `../.build/recovery-${theme}-${language}.png` });
      await page.locator('#account-dialog [data-close]').click();
    }
  });
});

test('initial paint uses saved theme colors before the application module loads', async ({ page, app }) => {
  await page.route('**/app.js', route => route.abort());
  const colors = { light: 'rgb(255, 255, 255)', dark: 'rgb(35, 38, 44)', paper: 'rgb(250, 248, 242)', midnight: 'rgb(24, 35, 47)', graphite: 'rgb(23, 23, 23)' };
  for (const [theme, color] of Object.entries(colors)) {
    await app.engine.updateSettings({ theme });
    await page.goto(app.url);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('html')).toHaveCSS('background-color', color);
    await expect(page.locator('body')).toHaveCSS('background-color', color);
  }
  await app.engine.updateSettings({ theme: 'system' });
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme }); await page.goto(app.url);
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    await expect(page.locator('body')).toHaveCSS('background-color', colors[colorScheme]);
  }
});

test('cancelling a theme preview keeps the saved theme on the next launch', async ({ page, app }) => {
  await app.engine.updateSettings({ theme: 'graphite' }); await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
  await page.locator('#settings-button').click();
  await page.locator('.theme-option').filter({ has: page.locator('input[value=paper]') }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
  await page.locator('#settings-dialog .modal-footer [data-close]').click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
});

test('selecting mail and updating favorites retain keyboard focus', async ({ page }) => {
  const message = page.locator('#messages .message').nth(1);
  await message.focus(); await page.keyboard.press('Enter');
  await expect(message).toBeFocused();
  await expect(message).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#messages .message').nth(2)).toBeFocused();
  const favorite = page.locator('#account-window .favorite').first();
  await favorite.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#account-window .favorite[aria-pressed="false"]').first()).toBeFocused();
});

test('all 500 virtualized accounts are reachable with keyboard navigation', async ({ page }) => {
  await page.locator('#demo-size').selectOption('500');
  await expect(page.locator('#mail-count')).toHaveText('500');
  await page.locator('#accounts').focus(); await page.keyboard.press('End');
  const last = page.locator('#account-window .account').filter({ hasText: 'reader.500@outlook.example' });
  await expect(last).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#account-window .account').filter({ hasText: 'reader.499@outlook.example' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.locator('#account-window .account').first()).toBeFocused();
  expect(await page.locator('#account-window .account').count()).toBeLessThan(30);
});

test('saving appearance preserves settings changed while the dialog was open', async ({ page, app }) => {
  await page.locator('#settings-button').click();
  await page.locator('#interface-language').selectOption('uk');
  // This server does not run the mail worker, even when auto is enabled.
  await app.engine.updateSettings({ auto: true, requestGap: 20 });
  await expect(page.locator('#auto-button')).toHaveAttribute('aria-pressed', 'true');
  const request = page.waitForRequest(r => r.url().endsWith('/api/settings') && r.method() === 'POST');
  await page.locator('#settings-form [type=submit]').click();
  expect((await request).postDataJSON()).toEqual({ language: 'uk' });
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  expect(app.engine.settings.auto).toBe(true); expect(app.engine.settings.requestGap).toBe(20);
});

test('pending account save blocks duplicate submission and premature dismissal', async ({ page }) => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  let writes = 0;
  await page.route('**/api/accounts/*/meta', async route => { writes++; started(); await gate; await route.continue(); });
  await page.locator('#account-menu').click();
  await page.locator('#meta-label').fill('Edited once');
  await page.locator('#meta-label').press('Enter'); await pending;
  try {
    await expect(page.locator('#meta-form')).toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
    await expect(page.locator('#account-dialog')).toBeVisible();
    await expect(page.locator('#account-dialog [data-close]')).toBeDisabled();
    expect(writes).toBe(1);
  } finally { release(); }
  await expect(page.locator('#account-dialog')).not.toBeVisible();
  await expect(page.locator('#view-title')).toHaveText('Edited once');
});

test('settings failure retains the draft and focuses the error', async ({ page }) => {
  await page.route('**/api/settings', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Could not save. Try again.' }) }));
  await page.locator('#settings-button').click();
  await page.locator('.theme-option').filter({ has: page.locator('[data-setting=theme][value=paper]') }).click();
  await page.locator('#settings-form [type=submit]').click();
  await expect(page.locator('#settings-error')).toBeFocused();
  await expect(page.locator('#settings-error')).toHaveText('Could not save. Try again.');
  await expect(page.locator('[data-setting=theme][value=paper]')).toBeChecked();
  await expect(page.locator('#settings-form [type=submit]')).toBeEnabled();
});

for (const action of ['pause', 'resume']) {
  test(`pending account ${action} blocks duplicate commands and closing`, async ({ page, app }) => {
    const account = [...app.engine.accounts.values()][0];
    if (action === 'resume') { await app.engine.bulk([account.id], 'pause'); await page.reload(); }
    let release, started, writes = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { started = resolve; });
    await page.route(action === 'resume' ? '**/api/accounts/*/resume' : '**/api/accounts/bulk', async route => { writes++; started(); await gate; await route.continue(); });
    await page.locator('#account-menu').click();
    const button = page.locator(`#${action}-account`);
    await button.click(); await pending;
    try {
      await expect(page.locator('#meta-form')).toHaveAttribute('aria-busy', 'true');
      await expect(button).toBeDisabled();
      await expect(page.locator('#account-dialog [data-close]')).toBeDisabled();
      await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
      await expect(page.locator('#account-dialog')).toBeVisible();
      expect(writes).toBe(1);
    } finally { release(); }
    await expect(page.locator('#account-dialog')).not.toBeVisible();
    expect(account.userPaused).toBe(action === 'pause');
  });

  test(`failed account ${action} retains the draft and reveals the stopped queue`, async ({ page, app }) => {
    const account = [...app.engine.accounts.values()][0];
    if (action === 'resume') { await app.engine.bulk([account.id], 'pause'); await page.reload(); }
    app.engine.vault = { save: async () => { throw new Error('synthetic storage failure'); }, close: async () => {} };
    await page.locator('#account-menu').click();
    await page.locator('#meta-label').fill('Keep this unsaved name');
    await page.locator(`#${action}-account`).click();
    await expect(page.locator('#meta-error')).toBeFocused();
    await expect(page.locator('#meta-error')).not.toBeEmpty();
    await expect(page.locator('#meta-label')).toHaveValue('Keep this unsaved name');
    await expect(page.locator(`#${action}-account`)).toBeEnabled();
    await expect(page.locator('#pause-button')).toHaveText('Resume');
    expect(account.userPaused).toBe(action === 'resume');
  });
}

for (const control of ['auto', 'pause']) {
  test(`pending ${control} toggle is disabled until its state has refreshed`, async ({ page, app }) => {
    if (control === 'pause') { await app.engine.updateSettings({ paused: true }); await page.reload(); }
    let release, started, writes = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { started = resolve; });
    await page.route('**/api/settings', async route => { writes++; started(); await gate; await route.continue(); });
    const button = page.locator(`#${control}-button`);
    await button.click(); await pending;
    try {
      await expect(button).toBeDisabled(); await expect(button).toHaveAttribute('aria-busy', 'true');
      await page.keyboard.press('Enter'); expect(writes).toBe(1);
    } finally { release(); }
    await expect(button).toBeEnabled();
    if (control === 'auto') await expect(button).toBeFocused();
    expect(app.engine.settings[control === 'auto' ? 'auto' : 'paused']).toBe(control === 'auto');
  });
}

test('saving account metadata returns focus to its table action after refresh', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const manage = page.locator('#manager-rows .table-actions .icon-button').first();
  await manage.click(); await page.locator('#meta-label').fill('Renamed');
  await page.locator('#meta-form [type=submit]').click();
  await expect(page.locator('#account-dialog')).not.toBeVisible();
  await expect(manage).toBeFocused();
});

test('focus reading returns to the selected message with Escape even with shortcuts disabled', async ({ page, app }) => {
  await app.engine.updateSettings({ readerPosition: 'focus', shortcuts: false });
  await expect(page.locator('html')).toHaveAttribute('data-reader', 'focus');
  await page.locator('#messages .message').nth(1).click();
  await expect(page.locator('#reader')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#mail-layout')).not.toHaveClass(/show-reader/);
  await expect(page.locator('#messages .message').nth(1)).toBeFocused();
});

test('large interface text fits settings in all three languages in a small desktop window', async ({ page, app }) => {
  await app.engine.updateSettings({ fontSize: 18 });
  await expect(page.locator('html')).toHaveCSS('--font-body', '18px');
  await page.setViewportSize({ width: 950, height: 610 });
  await page.locator('#settings-button').click();
  for (const language of ['ru', 'en', 'uk']) {
    await page.locator('#tab-appearance').click();
    await page.locator('#interface-language').selectOption(language);
    for (const tab of ['appearance', 'layout', 'reading', 'sync', 'storage']) {
      await page.locator('#tab-' + tab).click();
      expect(await page.locator('#settings-dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await expect(page.locator('#settings-form [type=submit]')).toBeInViewport();
      await expect(page.locator('#settings-dialog [data-close]').first()).toBeInViewport();
    }
  }
});

test.describe('Import', () => {
  test.use({ real: true });
  test('supplier row previews and imports only the primary mailbox', async ({ page, app }) => {
    await page.locator('#first-import').click();
    await page.locator('#account-input').fill('primary@example.com|unused-password|private-refresh-token-ui-test-only|12345678-1234-1234-1234-123456789abc|recovery@example.net');
    await page.locator('#preview-button').click();
    await expect(page.locator('#import-submit')).toBeEnabled();
    await expect(page.locator('#import-preview')).toContainText('primary@example.com');
    for (const privateValue of ['unused-password', 'private-refresh-token-ui-test-only', 'recovery@example.net']) await expect(page.locator('#import-preview')).not.toContainText(privateValue);
    await page.locator('#import-submit').click();
    await expect(page.locator('#import-dialog')).not.toBeVisible();
    expect(app.engine.accounts.size).toBe(1);
    const account = [...app.engine.accounts.values()][0];
    expect(account.email).toBe('primary@example.com');
    expect(Object.hasOwn(account, 'password')).toBe(false);
    expect(Object.hasOwn(account, 'recoveryEmail')).toBe(false);
    expect(JSON.stringify(app.engine.snapshot())).not.toContain('recovery@example.net');
    expect(app.engine.queue.length).toBe(0);
  });
  test('Open TXT is a keyboard-operable button', async ({ page }) => {
    await page.locator('#first-import').click();
    const open = page.getByRole('button', { name: 'Open TXT', exact: true });
    await open.focus(); await expect(open).toBeFocused();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    await (await chooser).setFiles([]);
  });
  test('closing import discards a file read that completes later', async ({ page }) => {
    await page.locator('#first-import').click();
    await page.evaluate(() => { File.prototype.text = () => new Promise(resolve => { window.finishSyntheticFile = () => resolve('smoke@example.com:private-refresh-token-ui-test-only:12345678-1234-1234-1234-123456789abc'); }); });
    await page.locator('#import-file').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') });
    await page.waitForFunction(() => typeof window.finishSyntheticFile === 'function');
    await page.evaluate(() => document.getElementById('import-dialog').addEventListener('close', () => { window.importHasClosed = true; }, { once: true }));
    await page.keyboard.press('Escape');
    await expect(page.locator('#import-dialog')).not.toBeVisible();
    await page.waitForFunction(() => window.importHasClosed);
    await page.evaluate(() => window.finishSyntheticFile());
    await page.locator('#first-import').click();
    await expect(page.locator('#account-input')).toHaveValue('');
    await expect(page.locator('#import-submit')).toBeDisabled();
  });
  test('editing input cancels the old preview without leaving Check disabled', async ({ page }) => {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { started = resolve; });
    let previews = 0;
    await page.route('**/api/import/preview', async route => { if (++previews === 1) { started(); await gate; } await route.continue(); });
    const row = email => `${email}:private-refresh-token-ui-test-only:12345678-1234-1234-1234-123456789abc`;
    await page.locator('#first-import').click();
    await page.locator('#account-input').fill(row('first@example.com'));
    await page.locator('#preview-button').click(); await pending;
    try {
      await page.locator('#account-input').fill(row('second@example.com') + '\n' + row('third@example.com'));
      await expect(page.locator('#preview-button')).toBeEnabled();
    } finally { release(); }
    await page.locator('#preview-button').click();
    await expect(page.locator('#import-submit')).toBeEnabled();
    await expect(page.locator('#import-preview')).toContainText('second@example.com');
    await expect(page.locator('#import-preview')).not.toContainText('first@example.com');
  });
  test('oversized file reports an error and allows another attempt', async ({ page }) => {
    await page.locator('#first-import').click();
    await page.locator('#import-file').setInputFiles({ name: 'too-large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1024 * 1024 + 1, 65) });
    await expect(page.locator('#import-error')).not.toBeEmpty();
    await expect(page.locator('#preview-button')).toBeEnabled();
    await expect(page.locator('#import-submit')).toBeDisabled();
  });
});

test.describe('large-account workflow', () => {
  test.use({ real: true });
  test('imports a Windows TXT, keeps selection across pages and reports or cancels each outcome', async ({ page, app }) => {
    test.setTimeout(45000);
    const source = '\uFEFF' + Array.from({ length: 500 }, (_, index) => `reader.${String(index + 1).padStart(3, '0')}@example.com|unused-password|fictional-refresh-token-for-batch-ui|12345678-1234-1234-1234-123456789abc|recovery@example.net`).join('\r\n') + '\r\n';
    await page.locator('#first-import').click();
    await page.locator('#import-file').setInputFiles({ name: 'fictional-500.txt', mimeType: 'text/plain', buffer: Buffer.from(source) });
    await expect(page.locator('#account-input')).not.toHaveValue('');
    await page.locator('#preview-button').click();
    await expect(page.locator('#import-submit')).toBeEnabled();
    await page.locator('#import-submit').click();
    await expect(page.locator('#mail-count')).toHaveText('500');
    await page.locator('#import-button').click();
    await page.locator('#account-input').fill('reader.501@example.com|fictional-refresh-token-for-batch-ui|12345678-1234-1234-1234-123456789abc');
    await page.locator('#preview-button').click();
    await page.locator('#import-submit').click();
    await expect(page.locator('#mail-count')).toHaveText('501');
    expect(app.engine.queue).toHaveLength(0);

    await page.locator('[data-view=accounts]').click();
    await expect(page.locator('#manager-page')).toHaveText('1 / 11');
    await page.locator('#check-page').check();
    await page.locator('#manager-next').click();
    await page.locator('#check-page').check();
    await expect(page.locator('#selected-count')).toHaveText('Selected: 100');
    await page.locator('[data-bulk=group]').click();
    await page.locator('#bulk-group-name').fill('Batch QA');
    await page.locator('#bulk-confirm').click();
    await expect(page.locator('#bulk-dialog')).toBeHidden();
    await page.locator('#manager-group').selectOption('Batch QA');
    await expect(page.locator('#manager-summary')).toContainText('Found 100 of 501');
    await expect(page.locator('#manager-page')).toHaveText('1 / 2');
    await expect(page.locator('#check-page')).toBeChecked();
    await page.locator('#manager-group').selectOption('');
    await page.locator('#manager-search').fill('reader.501');
    await expect(page.locator('#manager-summary')).toContainText('Found 1 of 501');
    await expect(page.locator('[data-account-row]')).toContainText('reader.501@example.com');
    await expect(page.locator('#selected-count')).toHaveText('Selected: 100 · outside filter: 100');
    await page.locator('#manager-search').fill('');
    await page.locator('#select-filtered').click();
    await expect(page.locator('#selected-count')).toHaveText('Selected: 501');

    let clock = Date.now(), calls = 0;
    app.engine.now = () => clock;
    const [auth, paused, disabled, busy] = [...app.engine.accounts.values()];
    Object.assign(auth, { authBlocked: true, enabled: false, status: 'auth', authFailure: 'error.imapAuth' });
    await app.engine.bulk([paused.id], 'pause');
    Object.assign(disabled, { enabled: false, status: 'error' });
    busy.nextAllowed = clock + 600000; app.engine.enqueue(busy.id);
    app.engine.holdUntil = clock + 180000;
    app.engine.loader = async () => {
      if (++calls === 2) throw new AppError('IMAP_AUTH', message('error.imapAuth'), { auth: true });
      return { messages: [], validity: 'fictional' };
    };
    await page.locator('[data-bulk=sync]').click();
    await expect(page.locator('#toast')).toContainText('Queued: 497. Skipped: 4.');
    for (const reason of ['Access denied: 1', 'Account paused: 1', 'Attempts stopped: 1', 'Already queued or running: 1']) await expect(page.locator('#toast')).toContainText(reason);
    await page.getByRole('button', { name: 'Refresh report', exact: true }).click();
    const card = page.locator('#batch-card');
    const count = name => card.locator(`[data-batch-count=${name}] strong`);
    await expect(count('pending')).toHaveText('497');
    await expect(count('skipped')).toHaveText('4');
    await card.locator('summary').click();
    await card.locator('#batch-filter').selectOption('skipped');
    await expect(card.locator('[data-batch-result=skipped]')).toHaveCount(4);
    for (const reason of ['Access denied', 'Account paused', 'Attempts stopped', 'Already queued or running']) await expect(card.locator('#batch-results')).toContainText(reason);
    await app.engine.tick(); expect(calls).toBe(0);
    clock += 180000; await app.engine.tick();
    clock += 5000; await app.engine.tick();
    await expect(count('updated')).toHaveText('1');
    await expect(count('failed')).toHaveText('1');
    await expect(count('pending')).toHaveText('495');
    await expect(card.locator('#batch-filter')).toHaveValue('skipped');
    await card.locator('#batch-cancel').click();
    await expect(count('cancelled')).toHaveText('495');
    await expect(card.locator('progress')).toHaveAttribute('value', '501');
    await expect(card.locator('#batch-cancel')).toHaveCount(0);
    expect(app.engine.queue.map(task => task.accountId)).toEqual([busy.id]);
    await card.locator('#batch-filter').selectOption('updated');
    await expect(card.locator('#batch-results')).toContainText('reader.005@example.com');
    await card.locator('#batch-filter').selectOption('failed');
    await expect(card.locator('#batch-results')).toContainText('reader.006@example.com');
    await expect(card.locator('#batch-results')).toContainText('Check IMAP permission');
    await card.locator('#batch-filter').selectOption('cancelled');
    await expect(card.locator('[data-batch-result=cancelled]')).toHaveCount(25);
    await card.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(card.locator('.batch-pages')).toContainText('2 / 20');
    expect(calls).toBe(2);

    // Effective viewport at 125%, 150% and 200% on a 1920×1080 display.
    for (const [scale, language] of [[1.25, 'en'], [1.5, 'uk'], [2, 'ru']]) {
      await app.engine.updateSettings({ language, theme: 'graphite', fontSize: 18 });
      await page.setViewportSize({ width: Math.floor(1920 / scale), height: Math.floor(1080 / scale) });
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      expect(await page.locator('#queue-view').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await expect(card.locator('#batch-filter')).toHaveValue('cancelled');
    }
    await app.engine.updateSettings({ fontSize: 14 });
    await page.setViewportSize({ width: 1280, height: 860 });
    await expect(page.locator('html')).toHaveCSS('--font-body', '14px');
    await card.locator('#batch-filter').selectOption('skipped');
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: '../.build/batch-report.png', animations: 'disabled' });
  });
});
