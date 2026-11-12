import { translate, normalizeLanguage, intlLocale, describe } from '../shared/i18n.mjs';

let language = normalizeLanguage(globalThis.navigator?.language, 'en');
export const getLanguage = () => language;
export const getIntlLocale = () => intlLocale(language);
export const t = (key, values) => translate(key, language, values);
export const translatedMessage = value => translate(describe(value), language);
export function setLanguage(next) { language = normalizeLanguage(next); }
export function translatePage(root = document) {
  document.documentElement.lang = language;
  document.documentElement.dir = 'ltr';
  document.title = 'Letterpane — ' + t('nav.mail');
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n, node.dataset.i18nValues ? JSON.parse(node.dataset.i18nValues) : {});
  for (const node of root.querySelectorAll('[data-i18n-attrs]')) for (const entry of node.dataset.i18nAttrs.split(';')) {
    const [attribute, key] = entry.split(':'); node.setAttribute(attribute, t(key));
  }
}
