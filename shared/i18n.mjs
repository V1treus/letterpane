import { locales } from './messages.mjs';

export { locales } from './messages.mjs';
export const LANGUAGES = Object.freeze({ ru: 'Русский', en: 'English', uk: 'Українська' });
export const intlLocale = language => ({ ru: 'ru-RU', en: 'en-US', uk: 'uk-UA' })[normalizeLanguage(language)];
export function normalizeLanguage(value, fallback = 'ru') {
  const code = typeof value === 'string' ? value.trim().toLowerCase().split(/[-_,;]/)[0] : '';
  return Object.hasOwn(LANGUAGES, code) ? code : fallback;
}
const sourceKeys = new Map();
for (const [key, value] of Object.entries(locales.ru)) if (typeof value === 'string' && !sourceKeys.has(value)) sourceKeys.set(value, key);
export const keyForSource = source => sourceKeys.get(source);
export function message(key, values = {}) { return { key, values }; }
export function describe(value) {
  if (value && typeof value === 'object' && typeof value.key === 'string') return value;
  const key = sourceKeys.get(value);
  return key ? message(key) : message('literal', { text: String(value ?? '') });
}
const rules = new Map(), numbers = new Map();
export function translate(input, language = 'ru', values = {}) {
  const locale = normalizeLanguage(language);
  const descriptor = typeof input === 'object' && input ? input : message(input, values);
  const params = descriptor.values || {};
  if (descriptor.key === 'literal') return String(params.text ?? '');
  let template = locales[locale][descriptor.key] ?? locales.en[descriptor.key];
  if (template === undefined) return String(descriptor.key ?? '');
  if (typeof template === 'object') {
    if (!rules.has(locale)) rules.set(locale, new Intl.PluralRules(intlLocale(locale)));
    template = template[rules.get(locale).select(Number(params.count) || 0)] ?? template.other;
  }
  if (!numbers.has(locale)) numbers.set(locale, new Intl.NumberFormat(intlLocale(locale)));
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, name) => {
    const value = params[name];
    if (value && typeof value === 'object' && value.key) return translate(value, locale);
    return typeof value === 'number' ? numbers.get(locale).format(value) : String(value ?? '');
  });
}
