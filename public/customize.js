import { t } from './i18n.js';
export const appearanceDefaults = { theme: 'system', accent: '#345fce', density: 'comfortable', fontSize: 14, sidebarWidth: 260, messageWidth: 340, previewLines: 1, showAvatars: true, autoSelect: true, shortcuts: true, readerPosition: 'right', messageSplit: 45, readingFont: 'system', readingSize: 16, sidebarStyle: 'muted', corners: 'soft', showCodeBadges: true, showStatusBar: true, showGroupLabels: true };
export const themeSurfaces = { light: '#ffffff', dark: '#23262c', paper: '#faf8f2', midnight: '#18232f', graphite: '#171717' };
export function accountRowHeight(settings) { return ({ compact: 46, comfortable: 58, spacious: 70 }[settings.density] || 58) + Math.max(0, (settings.fontSize || 14) - 14) * 2; }
export function resolveTheme(theme, prefersDark) { return theme === 'system' ? (prefersDark ? 'dark' : 'light') : Object.hasOwn(themeSurfaces, theme) ? theme : 'light'; }
const rgb = color => color.slice(1).match(/../g).map(v => parseInt(v, 16));
export function luminance(color) { return rgb(color).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0); }
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
function mix(a, b, ratio) { return '#' + rgb(a).map((v, i) => Math.round(v * (1 - ratio) + rgb(b)[i] * ratio).toString(16).padStart(2, '0')).join(''); }
export function accentPalette(accent, dark, surface) {
  const onAccent = contrast(accent, '#ffffff') >= contrast(accent, '#000000') ? '#ffffff' : '#000000';
  const soft = mix(surface, accent, dark ? .18 : .08);
  let ink = accent;
  for (let i = 0; i < 30 && Math.min(contrast(ink, surface), contrast(ink, soft)) < 4.5; i++) ink = mix(ink, dark ? '#ffffff' : '#152235', .12);
  return { onAccent, soft, ink };
}
export function applyAppearance(settings) {
  const root = document.documentElement;
  const theme = resolveTheme(settings.theme, matchMedia('(prefers-color-scheme: dark)').matches);
  const dark = ['dark', 'midnight', 'graphite'].includes(theme);
  root.dataset.theme = theme;
  root.dataset.density = settings.density || 'comfortable';
  root.dataset.avatars = settings.showAvatars === false ? 'off' : 'on';
  root.dataset.preview = String(settings.previewLines ?? 1);
  root.dataset.reader = settings.readerPosition || 'right';
  root.dataset.sidebar = settings.sidebarStyle || 'muted';
  root.dataset.corners = settings.corners || 'soft';
  root.dataset.codes = settings.showCodeBadges === false ? 'off' : 'on';
  root.dataset.statusbar = settings.showStatusBar === false ? 'off' : 'on';
  root.dataset.groups = settings.showGroupLabels === false ? 'off' : 'on';
  root.style.colorScheme = dark ? 'dark' : 'light';
  const accent = /^#[0-9a-f]{6}$/i.test(settings.accent) ? settings.accent : '#345fce';
  const surface = themeSurfaces[theme];
  const palette = accentPalette(accent, dark, surface);
  for (const [key, value] of Object.entries({ '--blue': accent, '--accent-contrast': palette.onAccent, '--accent-soft': palette.soft, '--accent-ink': palette.ink })) root.style.setProperty(key, value);
  const clamp = (value, min, max, fallback) => Math.min(max, Math.max(min, Number(value) || fallback));
  root.style.setProperty('--font-body', `${clamp(settings.fontSize, 13, 18, 14)}px`);
  root.style.setProperty('--reading-size', `${clamp(settings.readingSize, 14, 22, 16)}px`);
  root.style.setProperty('--reading-font', ({ system: '"Segoe UI", sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: 'Consolas, monospace' })[settings.readingFont] || '"Segoe UI", sans-serif');
  root.style.setProperty('--account-height', `${accountRowHeight(settings)}px`);
  root.style.setProperty('--sidebar-width', `${clamp(settings.sidebarWidth, 220, 360, 260)}px`);
  root.style.setProperty('--list-width', `${clamp(settings.messageWidth, 280, 480, 340)}px`);
  root.style.setProperty('--list-height', `${clamp(settings.messageSplit, 30, 65, 45)}%`);
  root.style.setProperty('--preview-lines', settings.previewLines === 0 ? 0 : clamp(settings.previewLines, 1, 3, 1));
  for (const button of document.querySelectorAll('.accent-preset')) button.setAttribute('aria-pressed', String(button.dataset.color === accent));
  for (const separator of document.querySelectorAll('[data-resize]')) separator.setAttribute('aria-valuenow', settings[separator.dataset.resize]);
}
export function fillSettings(settings, form) {
  for (const input of form.querySelectorAll('[data-setting]')) {
    const value = settings[input.dataset.setting];
    if (input.type === 'checkbox') input.checked = !!value;
    else if (input.type === 'radio') input.checked = value === input.value;
    else {
      // Preserve values saved by older versions even when a control now offers presets.
      if (input.tagName === 'SELECT' && ![...input.options].some(option => option.value === String(value))) {
        const option = document.createElement('option'); option.value = value;
        const seconds = ['interval', 'accountGap', 'requestGap'].includes(input.dataset.setting);
        option.dataset.i18n = seconds ? 'settings.savedSeconds' : 'settings.savedValue';
        option.dataset.i18nValues = JSON.stringify(seconds ? { count: value } : { value });
        option.textContent = t(option.dataset.i18n, JSON.parse(option.dataset.i18nValues));
        input.append(option);
      }
      input.value = value;
    }
  }
}
export function readSettings(settings, form) {
  const next = { ...settings };
  for (const input of form.querySelectorAll('[data-setting]')) {
    if (input.type === 'radio' && !input.checked) continue;
    next[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.type === 'number' || input.dataset.number === 'true' ? Number(input.value) : input.value;
  }
  return next;
}
