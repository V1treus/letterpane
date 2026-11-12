import { AppError } from './errors.mjs';
import { message, describe } from '../shared/i18n.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  auto: false, interval: 120, limit: 20, paused: false,
  requestGap: 5, accountGap: 60, maxAttempts: 3, autoScope: 'all', autoGroup: '',
  theme: 'system', accent: '#345fce', density: 'comfortable', fontSize: 14,
  sidebarWidth: 260, messageWidth: 340, previewLines: 1, showAvatars: true,
  autoSelect: true, shortcuts: true, cacheMB: 32, cacheMessages: 2000, logLimit: 200,
  readerPosition: 'right', messageSplit: 45, readingFont: 'system', readingSize: 16,
  sidebarStyle: 'muted', corners: 'soft', showCodeBadges: true,
  showStatusBar: true, showGroupLabels: true, language: 'ru'
});
const ranges = { interval: [60, 3600], limit: [5, 50], requestGap: [5, 60], accountGap: [60, 3600], maxAttempts: [1, 3], fontSize: [13, 18], sidebarWidth: [220, 360], messageWidth: [280, 480], previewLines: [0, 3], cacheMB: [16, 128], cacheMessages: [500, 5000], logLimit: [200, 1000], readingSize: [14, 22], messageSplit: [30, 65] };
const choices = { theme: ['system', 'light', 'dark', 'paper', 'midnight', 'graphite'], density: ['comfortable', 'compact', 'spacious'], autoScope: ['all', 'favorites'], readerPosition: ['right', 'bottom', 'focus'], readingFont: ['system', 'serif', 'mono'], sidebarStyle: ['muted', 'contrast', 'accent'], corners: ['soft', 'square'], language: ['ru', 'en', 'uk'] };
const labels = { interval: 'field.interval', limit: 'sync.messageLimit', requestGap: 'field.requestGap', accountGap: 'field.accountGap', maxAttempts: 'field.attempts', fontSize: 'field.fontSize', sidebarWidth: 'resize.sidebar', messageWidth: 'resize.messages', previewLines: 'field.preview', cacheMB: 'field.cache', cacheMessages: 'field.cachedMessages', logLimit: 'data.logLimit', readingSize: 'field.readingSize', messageSplit: 'resize.height' };
export function validateSettings(input, current = DEFAULT_SETTINGS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('SETTINGS', 'Не удалось прочитать настройки.');
  const next = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) next[key] = Object.hasOwn(input, key) ? input[key] : current[key] ?? fallback;
  for (const [key, [min, max]] of Object.entries(ranges)) if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) throw new AppError('SETTINGS', message('error.range', { field: message(labels[key]), min, max }));
  const choiceLabels = { theme: 'theme.title', density: 'density.title', autoScope: 'nav.accounts', readerPosition: 'layout.reader', readingFont: 'reading.font', sidebarStyle: 'sidebar.title', corners: 'corners.title', language: 'language.label' };
  for (const [key, values] of Object.entries(choices)) if (!values.includes(next[key])) throw new AppError('SETTINGS', message('error.choice', { field: message(choiceLabels[key]) }));
  for (const key of ['auto', 'paused', 'showAvatars', 'autoSelect', 'shortcuts', 'showCodeBadges', 'showStatusBar', 'showGroupLabels']) if (typeof next[key] !== 'boolean') throw new AppError('SETTINGS', 'Проверьте переключатели настроек.');
  if (typeof next.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(next.accent)) throw new AppError('SETTINGS', 'Акцентный цвет должен иметь формат #RRGGBB.');
  next.accent = next.accent.toLowerCase();
  next.autoGroup = cleanText(next.autoGroup, 40, 'группы');
  return next;
}
export function cleanText(value, max, name) {
  if (typeof value !== 'string' || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) throw new AppError('METADATA', message('error.metadata', { field: describe(name), max }));
  return value.trim();
}
