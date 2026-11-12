import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { AppError, retryAfterMs } from './errors.mjs';
import { VERSION } from './version.mjs';

const ENDPOINTS = {
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  live: 'https://login.live.com/oauth20_token.srf'
};
const MAX_SOURCE = 512 * 1024;

export async function refreshAccess(account, { fetchImpl = fetch, now = Date.now } = {}) {
  if (account.accessToken && account.expiresAt > now() + 120000) return account.accessToken;
  let response;
  try {
    response = await fetchImpl(ENDPOINTS[account.authority] || ENDPOINTS.microsoft, {
      method: 'POST', redirect: 'error', signal: account.abortController ? AbortSignal.any([AbortSignal.timeout(20000), account.abortController.signal]) : AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `Letterpane/${VERSION}` },
      body: new URLSearchParams({ client_id: account.clientId, refresh_token: account.refreshToken, grant_type: 'refresh_token' })
    });
  } catch {
    throw new AppError('NETWORK', 'Не удалось связаться с Microsoft. Проверьте подключение.', { retryable: true });
  }
  let data = {};
  try { data = await response.json(); } catch { /* Never expose the provider response to the UI. */ }
  if (response.status === 429) throw new AppError('THROTTLED', 'Microsoft попросила снизить нагрузку. Очередь ждёт.', { retryable: true, retryAfter: Math.max(60000, retryAfterMs(response.headers.get('retry-after'), now())) });
  if (response.status >= 500 || response.status === 408 || data.error === 'temporarily_unavailable') {
    throw new AppError('PROVIDER', 'Microsoft временно недоступна. Повторим с паузой.', { retryable: true, retryAfter: retryAfterMs(response.headers.get('retry-after'), now()) });
  }
  if (!response.ok || !data.access_token) {
    const messages = {
      invalid_grant: 'Доступ отозван или токен истёк. Импортируйте новый refresh_token с его исходным client_id.',
      invalid_client: 'Microsoft не принимает client_id. Проверьте приложение, которому выдан токен.',
      interaction_required: 'Microsoft требует повторного входа в аккаунт. Обновите токен.',
      consent_required: 'Приложению нужно разрешение на чтение почты. Повторно предоставьте доступ.',
      invalid_scope: 'Токен не имеет нужного разрешения IMAP. Предоставьте IMAP.AccessAsUser.All.'
    };
    throw new AppError('AUTH_REQUIRED', messages[data.error] || 'Microsoft отклонила вход. Проверьте токен, client_id и выбранный тип OAuth.', { auth: true });
  }
  account.accessToken = data.access_token;
  account.expiresAt = now() + Math.max(1, Number(data.expires_in) || 3600) * 1000;
  if (data.refresh_token) account.refreshToken = data.refresh_token;
  return account.accessToken;
}

export function extractSignals(text) {
  const codes = [];
  const pattern = /(?:код(?:\s+(?:подтверждения|підтвердження|безопасности|безпеки|доступа|доступу))?|code|pin|guard|security\s+code|one.time\s+(?:code|password))[^\n\r\p{L}\p{N}_]{0,30}([A-Z0-9]{4,8})\b/giu;
  for (const match of text.matchAll(pattern)) {
    if (/\d/.test(match[1]) && !codes.includes(match[1].toUpperCase())) codes.push(match[1].toUpperCase());
  }
  const links = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(match[0].replace(/[).,;]+$/, ''));
      if (url.username || url.password) continue;
      if (/verify|confirm|activate|newaccount|[?&](?:token|stoken)=/i.test(url.href) && !/unsubscribe|privacy/i.test(url.href)) {
        if (!links.includes(url.href)) links.push(url.href);
      }
    } catch { /* Ignore malformed URLs. */ }
  }
  return { codes: codes.slice(0, 5), links: links.slice(0, 5) };
}

export async function parseMessage(source, metadata) {
  const parsed = await simpleParser(source, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: MAX_SOURCE });
  const text = (parsed.text || '').slice(0, 100000);
  // HTML is never sent to the renderer. No images, trackers, scripts or clickable links.
  return {
    ...metadata,
    from: (parsed.from?.text || metadata.from || '').slice(0, 500),
    subject: (parsed.subject || metadata.subject || '').slice(0, 1000),
    text,
    ...extractSignals(text),
    preview: text.replace(/\s+/g, ' ').slice(0, 160),
    truncated: metadata.size > MAX_SOURCE
  };
}

export async function loadMailbox(account, folder, limit, { saveTokens = async () => {}, clientFactory = opts => new ImapFlow(opts), tokenRefresh = refreshAccess } = {}) {
  const previousRefreshToken = account.refreshToken;
  const accessToken = await tokenRefresh(account);
  if (account.refreshToken !== previousRefreshToken) await saveTokens();
  const client = clientFactory({
    host: 'outlook.office365.com', port: 993, secure: true,
    auth: { user: account.email, accessToken },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    logger: false, logRaw: false, disableAutoIdle: true, disableCompression: true,
    connectionTimeout: 20000, greetingTimeout: 15000, socketTimeout: 25000,
    maxLiteralSize: MAX_SOURCE + 65536, maxResponseSize: MAX_SOURCE * 4, maxLineLength: MAX_SOURCE * 2,
    clientInfo: { name: 'Letterpane', version: VERSION }
  });
  client.on('error', () => {}); // Errors reject awaited operations; never log tokens or raw mail.
  account.activeClient = client;
  const deadline = setTimeout(() => client.close(), 90000);
  try {
    await client.connect();
    let path = 'INBOX';
    if (folder === 'junk') {
      const mailboxes = await client.list({ listOnly: true });
      path = mailboxes.find(box => box.specialUse === '\\Junk')?.path;
      if (!path) throw new AppError('FOLDER', 'Сервер не сообщил папку «Спам». Используйте «Входящие».');
    }
    const lock = await client.getMailboxLock(path, { readOnly: true });
    try {
      const validity = String(client.mailbox.uidValidity);
      const previous = account.cache[folder]?.validity === validity ? account.cache[folder].messages : [];
      const cached = new Map(previous.map(message => [message.uid, message]));
      if (!client.mailbox.exists) return { validity, messages: [] };
      // One small metadata batch, not SEARCH ALL followed by one FETCH per email.
      const start = Math.max(1, client.mailbox.exists - limit + 1);
      const meta = await client.fetchAll(`${start}:*`, { uid: true, envelope: true, flags: true, size: true, internalDate: true });
      const missing = meta.filter(item => !cached.has(item.uid));
      if (missing.length) {
        const bodies = await client.fetchAll(missing.map(item => item.uid), { uid: true, source: { start: 0, maxLength: MAX_SOURCE } }, { uid: true });
        for (const item of bodies) {
          if (!item.source) continue;
          const metadata = meta.find(m => m.uid === item.uid);
          if (!metadata) continue;
          cached.set(item.uid, await parseMessage(item.source, { uid: item.uid, size: metadata.size }));
        }
      }
      const messages = meta.map(item => ({
        ...(cached.get(item.uid) || { uid: item.uid, text: '', unavailable: true, codes: [], links: [], preview: '' }),
        id: `${validity}-${item.uid}`, uid: item.uid,
        subject: item.envelope?.subject || cached.get(item.uid)?.subject || '',
        from: cached.get(item.uid)?.from || item.envelope?.from?.map(p => p.name || p.address).join(', ') || '',
        date: item.internalDate ? new Date(item.internalDate).toISOString() : null,
        unread: !item.flags?.has('\\Seen')
      })).reverse();
      return { validity, messages };
    } finally { lock.release(); }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const text = `${error.serverResponseCode || ''} ${error.responseText || ''} ${error.response || ''}`;
    // Throttling may be sent during authentication; check it before auth failures.
    if (/throttl|limit|too many|serverbusy|try again later/i.test(text)) {
      throw new AppError('THROTTLED', 'Почтовый сервер ограничил запросы. Общая очередь приостановлена на 5 минут.', { retryable: true, retryAfter: 300000 });
    }
    if (error.authenticationFailed || /AUTHENTICATIONFAILED|AUTHORIZATIONFAILED/i.test(text)) {
      account.accessToken = null;
      throw new AppError('IMAP_AUTH', 'Сервер отклонил доступ к почте. Проверьте разрешение IMAP и токен. Автоповторы остановлены.', { auth: true });
    }
    throw new AppError('IMAP_NETWORK', 'Нет соединения с почтовым сервером. Повторим после паузы.', { retryable: true });
  } finally {
    clearTimeout(deadline);
    account.activeClient = null;
    // Close immediately: read-only sessions have nothing to commit.
    client.close();
  }
}
