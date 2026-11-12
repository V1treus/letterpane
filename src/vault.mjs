import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from './errors.mjs';

// The secret travels over stdin, never through process arguments or shell interpolation.
export function dpapi(data, decrypt = false) {
  if (process.platform !== 'win32') throw new AppError('VAULT_PLATFORM', 'Защищённое хранилище этой версии работает в Windows.');
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new AppError('VAULT_TIMEOUT', 'Windows не ответила на запрос к хранилищу.')); }, 15000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new AppError('VAULT_ERROR', 'Не удалось открыть защищённое хранилище Windows.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !output.trim()) reject(new AppError('VAULT_ERROR', 'Windows не смогла расшифровать хранилище. Запустите приложение под исходной учётной записью.'));
      else resolve(Buffer.from(output.trim(), 'base64'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(data).toString('base64'));
  });
}

export function seal(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('posta-v1'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
}

export function unseal(text, key) {
  const envelope = JSON.parse(text);
  if (envelope.v !== 1) throw new Error('Unsupported vault version');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  cipher.setAAD(Buffer.from('posta-v1'));
  cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data, 'base64')), cipher.final()]).toString('utf8'));
}

export class Vault {
  constructor(directory) { this.directory = directory; this.tail = Promise.resolve(); }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const keyPath = join(this.directory, 'key.dpapi');
    let protectedKey;
    try { protectedKey = await readFile(keyPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // If a vault exists without its key, do not replace the key or existing data.
      try { await readFile(join(this.directory, 'accounts.vault')); throw new AppError('VAULT_KEY', 'Отсутствует ключ хранилища. Восстановите key.dpapi из резервной копии.'); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      protectedKey = await dpapi(randomBytes(32));
      await writeFile(keyPath, protectedKey, { flag: 'wx', mode: 0o600 });
    }
    this.key = await dpapi(protectedKey, true);
    if (this.key.length !== 32) throw new AppError('VAULT_KEY', 'Повреждён ключ хранилища.');
    try { return unseal(await readFile(join(this.directory, 'accounts.vault'), 'utf8'), this.key); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new AppError('VAULT_CORRUPT', 'Не удалось прочитать хранилище. Файлы сохранены без изменений; восстановите резервную копию.');
    }
  }
  save(value) {
    if (this.closing || !this.key) throw new AppError('VAULT_CLOSED', 'Сессия закрыта. Перезапустите приложение.', { status: 500 });
    const serialized = seal(value, this.key);
    const operation = this.tail.catch(() => {}).then(async () => {
      const temp = join(this.directory, 'accounts.vault.tmp');
      await writeFile(temp, serialized, { mode: 0o600 });
      await rename(temp, join(this.directory, 'accounts.vault'));
    });
    this.tail = operation;
    return operation;
  }
  async close() { this.closing = true; await this.tail.catch(() => {}); this.key?.fill(0); }
}
