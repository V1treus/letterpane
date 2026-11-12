export function sourceIssues(path, text = '') {
  const issues = [];
  const normalized = path.replaceAll('\\', '/');
  if (/(^|\/)(?:\.data|\.build|\.test-data|artifacts|dist|node_modules|(?:Posta|Letterpane) Portable\.data|webview-profile|webview-demo)(\/|$)/i.test(normalized) || /(?:^|\/)(?:key\.dpapi|accounts\.vault(?:\.tmp)?|profile\.lock|\.env(?:\..*)?)$/i.test(normalized) && !normalized.endsWith('.env.example') || /\.(?:exe|dll|zip|pfx|p12|pem|key)$/i.test(normalized)) issues.push({ rule: 'private-or-generated-file', line: 1 });
  const patterns = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
    ['microsoft-refresh-token', /\b(?:M\.[A-Za-z0-9_.-]{80,}|0\.[A-Za-z0-9_.-]{150,})/g],
    ['jwt', /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g],
    ['api-key', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{40,}|xox[baprs]-[A-Za-z0-9-]{30,}|AKIA[A-Z0-9]{16})\b/g]
  ];
  for (const [rule, pattern] of patterns) for (const match of text.matchAll(pattern)) issues.push({ rule, line: text.slice(0, match.index).split('\n').length });
  return issues;
}
