// Runs before stylesheets and the app module, so the first paint uses the saved theme.
(() => {
  const root = document.documentElement;
  const theme = root.dataset.theme || 'system';
  root.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  root.style.colorScheme = ['dark', 'midnight', 'graphite'].includes(root.dataset.theme) ? 'dark' : 'light';
})();
