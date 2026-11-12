import { AppError } from './errors.mjs';
import { message } from '../shared/i18n.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@:|<>]+@[^\s@:|<>]+\.[^\s@:|<>]+$/;

export function parseImport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) {
    throw new AppError('IMPORT_SIZE', 'Импортируйте до 1 МБ текста за один раз.');
  }
  const lines = text.split(/\r?\n/);
  const accounts = [], errors = [], seen = new Set();
  let duplicates = 0, rows = 0;
  lines.forEach((raw, index) => {
    if (!raw.trim()) return;
    if (++rows > 500) throw new AppError('IMPORT_SIZE', 'Не более 500 строк за один импорт.');
    const delimiter = raw.includes('|') ? '|' : ':';
    const parts = raw.trim().split(delimiter).map(p => p.trim());
    // Read from the ends so an unused legacy password may itself contain ':'.
    const address = parts[0]?.toLowerCase();
    // Some suppliers append one recovery address after client_id. It is unused.
    const recoveryColumn = parts.length >= 4 && EMAIL.test(parts.at(-1)) && UUID.test(parts.at(-2));
    const clientIndex = parts.length - (recoveryColumn ? 2 : 1);
    const clientId = parts[clientIndex];
    const refreshToken = parts[clientIndex - 1];
    if (parts.length < 3 || !EMAIL.test(address) || !UUID.test(clientId || '') ||
        !refreshToken || refreshToken.length < 20 || refreshToken.length > 32768 || /\s/.test(refreshToken)) {
      errors.push({ line: index + 1, message: 'Нужны email, refresh_token и исходный client_id. Проверьте разделители.', messageDescriptor: message('error.importRow') });
      return;
    }
    if (seen.has(address)) { duplicates++; return; }
    seen.add(address);
    accounts.push({ email: address, clientId: clientId.toLowerCase(), refreshToken });
  });
  return { accounts, errors, duplicates };
}
