import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Use the interface's actual colors for both native startup windows.
export function startupPalette(css) {
  const palette = {};
  for (const theme of ['light', 'dark', 'paper', 'midnight', 'graphite']) {
    const selector = theme === 'light' ? ':root' : `:root[data-theme=${theme}]`;
    const block = css.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]+)\\}'))?.[1];
    const color = name => {
      const value = block?.match(new RegExp(`--${name}:\\s*(#[a-f0-9]{3}(?:[a-f0-9]{3})?);`, 'i'))?.[1];
      if (!value) throw new Error(`Missing startup color: ${theme}/${name}`);
      return value.length === 4 ? '#' + [...value.slice(1)].map(c => c + c).join('') : value;
    };
    palette[theme] = { background: color('surface'), foreground: color('ink') };
  }
  return palette;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const palette = startupPalette(await readFile(new URL('../public/themes.css', import.meta.url), 'utf8'));
  let source = 'using System.Drawing;\nusing System.Collections.Generic;\ninternal static class NativeThemeCatalog {\n';
  source += 'internal static readonly Dictionary<string, Color[]> Values = new Dictionary<string, Color[]> {\n';
  for (const [name, colors] of Object.entries(palette)) {
    const literal = hex => `Color.FromArgb(255, ${hex.slice(1).match(/../g).map(v => parseInt(v, 16)).join(', ')})`;
    source += `{ "${name}", new Color[] { ${literal(colors.background)}, ${literal(colors.foreground)} } },\n`;
  }
  source += '};\n}\n';
  await mkdir(new URL('../.build/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.build/NativeThemeCatalog.cs', import.meta.url), source);
}
