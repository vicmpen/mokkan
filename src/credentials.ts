import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { UserError } from './errors.js';

export interface Credentials {
  server_url: string;
  email: string;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
}

export const DEFAULT_SERVER_URL = 'https://api.mokkan.dev';

export class CredentialsPermissionError extends Error {
  constructor(message: string) { super(message); this.name = 'CredentialsPermissionError'; }
}

/** The credentials file exists but cannot be parsed. A user error (exit 1); login/logout treat it as "no credentials". */
export class CredentialsCorruptError extends UserError {
  constructor(readonly file: string) {
    super(`credentials file is corrupt: ${file}. Run: mokkan logout (or delete it) then mokkan login`);
    this.name = 'CredentialsCorruptError';
  }
}

const REQUIRED_KEYS = ['server_url', 'email', 'access_token', 'access_expires_at', 'refresh_token', 'refresh_expires_at'] as const;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== ''
    ? env.XDG_CONFIG_HOME
    : path.join(env.HOME && env.HOME !== '' ? env.HOME : homedir(), '.config');
  return path.join(base, 'mokkan');
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'credentials.json');
}

export function credentialsLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${credentialsPath(env)}.lock`;
}

export function hookLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'hook.log');
}

/**
 * Returns null when no credentials are stored. Throws CredentialsPermissionError when the file is too open,
 * CredentialsCorruptError when it is not valid credentials JSON.
 */
export function loadCredentials(env: NodeJS.ProcessEnv = process.env): Credentials | null {
  const file = credentialsPath(env);
  if (!existsSync(file)) return null;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    throw new CredentialsPermissionError(`${file} is readable by other users (mode ${mode.toString(8)}). Fix with: chmod 600 ${file}`);
  }
  const text = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CredentialsCorruptError(file);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new CredentialsCorruptError(file);
  const record = parsed as Partial<Record<keyof Credentials, unknown>>;
  for (const key of REQUIRED_KEYS) {
    if (typeof record[key] !== 'string') throw new CredentialsCorruptError(file);
  }
  return record as Credentials;
}

export function saveCredentials(creds: Credentials, env: NodeJS.ProcessEnv = process.env): void {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = credentialsPath(env);
  // Unique per writer so a hook and a command saving at the same instant cannot clobber each other's tmp file.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function clearCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const file = credentialsPath(env);
  if (existsSync(file)) unlinkSync(file);
}

/** Precedence: MOKKAN_SERVER_URL env, then the saved credentials, then the default. Trailing slashes are stripped. */
export function resolveServerUrl(creds: Credentials | null, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MOKKAN_SERVER_URL;
  const url = fromEnv && fromEnv !== '' ? fromEnv : (creds?.server_url ?? DEFAULT_SERVER_URL);
  return url.replace(/\/+$/, '');
}

/** Another mokkan process held the credentials lock for longer than we were willing to wait. Exit code 2 (transient). */
export class CredentialsLockError extends Error {
  constructor(message: string) { super(message); this.name = 'CredentialsLockError'; }
}

export interface CredentialsLockOptions {
  /** Give up waiting for the lock when this fires (the hook deadline). */
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  /** A lock file older than this is left over from a crashed process and is removed. */
  staleMs?: number;
}

/**
 * Runs `fn` while holding `credentials.json.lock`, an exclusive lock file shared by every mokkan process of this
 * user (hooks of several Claude Code sessions, `mokkan watch`, commands). The token refresh runs under it, so only
 * one process ever presents a given refresh token: the server treats a second presentation as theft and revokes
 * the whole family (A26, A28).
 */
export async function withCredentialsLock<T>(
  env: NodeJS.ProcessEnv, fn: () => Promise<T>, opts: CredentialsLockOptions = {},
): Promise<T> {
  const { signal, timeoutMs = 5000, pollMs = 50, staleMs = 30_000 } = opts;
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsLockPath(env);
  const owner = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try { writeSync(fd, owner); } finally { closeSync(fd); }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - statSync(file).mtimeMs > staleMs) {
        unlinkSync(file);
        continue;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // released between our open and stat
      throw err;
    }
    if (signal?.aborted) throw new CredentialsLockError(`Gave up waiting for ${file}: deadline exceeded`);
    if (Date.now() >= deadline) {
      throw new CredentialsLockError(`Timed out after ${timeoutMs} ms waiting for ${file} (another mokkan process is refreshing the session; if none is running, delete the file)`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    return await fn();
  } finally {
    // Remove only our own lock: if we overran staleMs, another process may have taken over the file.
    try {
      if (readFileSync(file, 'utf8') === owner) unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
}
