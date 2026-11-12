import { mkdir, writeFile } from 'node:fs/promises';
import { locales } from '../shared/messages.mjs';

// Native windows and the web interface use the same reviewed language catalogs.
const literal = value => JSON.stringify(value).replace(/\\u2028|\\u2029/g, ' ');
let source = 'using System.Collections.Generic;\ninternal static class NativeCatalog {\n';
source += 'internal static readonly Dictionary<string, Dictionary<string, string>> Values = new Dictionary<string, Dictionary<string, string>> {\n';
for (const [language, messages] of Object.entries(locales)) {
  source += `{ ${literal(language)}, new Dictionary<string, string> {\n`;
  for (const [key, value] of Object.entries(messages)) if (key.startsWith('native.')) source += `{ ${literal(key)}, ${literal(value)} },\n`;
  source += '} },\n';
}
source += '};\n}\n';
await mkdir(new URL('../.build/', import.meta.url), { recursive: true });
await writeFile(new URL('../.build/NativeCatalog.cs', import.meta.url), '\uFEFF' + source);
