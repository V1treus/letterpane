import { describe, translate, message } from '../shared/i18n.mjs';
export class AppError extends Error {
  constructor(code, message, { retryable = false, retryAfter = 0, auth = false, status = 400 } = {}) {
    const descriptor = describe(message);
    super(translate(descriptor, 'ru'));
    Object.assign(this, { code, retryable, retryAfter, auth, status, messageDescriptor: descriptor });
  }
}

export function safeError(error) {
  return error instanceof AppError ? error : new AppError('INTERNAL', 'Не удалось выполнить действие. Повторите попытку позже.', { status: 500 });
}

export function profileError(error) {
  if (error instanceof AppError) return error;
  const key = ['EACCES', 'EPERM', 'EROFS'].includes(error?.code) ? 'error.profileWrite' : error?.code === 'ENOSPC' ? 'error.profileSpace' : ['ENOTDIR', 'EISDIR', 'EINVAL'].includes(error?.code) ? 'error.profilePath' : null;
  return key ? new AppError('PROFILE', message(key), { status: 500 }) : error;
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
