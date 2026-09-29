import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { configDir } from './credentials.js';
import type { ReminderState } from './types.js';

/** The fields the status line needs; reminder text is included, so the file is 0600 in the 0700 config dir. */
export interface SlimReminder {
  id: string; text: string; state: ReminderState; position: number; due_at: string | null; created_at: string;
}

/** Why the last refresh failed. `null` when it succeeded. */
export type StatusError = 'offline' | 'logged_out' | 'error';

export interface StatusCache {
  v: 2;
  server_url: string;
  email: string;
  /** Last refresh attempt (success or failure): drives the TTL, so a down server is retried once per TTL, not per render. */
  attempted_at: string;
  /** Last successful fetch, or null if none yet. */
  fetched_at: string | null;
  error: StatusError | null;
  reminders: SlimReminder[];
  /** Credit balance from /me; absent when the server does not report one. */
  credit_balance?: number;
}

/** A refresh lock older than this belongs to a refresher that died; the refresh itself is capped well below it. */
const REFRESH_LOCK_STALE_MS = 15_000;

export function statusCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(configDir(env), 'status.json');
}

function refreshLockPath(env: NodeJS.ProcessEnv): string {
  return `${statusCachePath(env)}.lock`;
}

/** Returns null for a missing, unreadable or malformed file: the status line then fetches afresh. */
export function readStatusCache(env: NodeJS.ProcessEnv = process.env): StatusCache | null {
  try {
    const value = JSON.parse(readFileSync(statusCachePath(env), 'utf8')) as Partial<StatusCache>;
    if (value?.v !== 2 || typeof value.server_url !== 'string' || typeof value.email !== 'string'
      || typeof value.attempted_at !== 'string' || !Array.isArray(value.reminders)) return null;
    return value as StatusCache;
  } catch {
    return null;
  }
}

/** Atomic (tmp + rename), like saveCredentials, so a render never reads a half-written file. */
export function writeStatusCache(cache: StatusCache, env: NodeJS.ProcessEnv = process.env): void {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = statusCachePath(env);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Called after every change to the list (push, pop, ack, deliver, login, logout). Never throws. */
export function invalidateStatusCache(env: NodeJS.ProcessEnv = process.env): void {
  try {
    unlinkSync(statusCachePath(env));
  } catch {
    // Already gone, or unwritable: the TTL bounds how stale the status line can get.
  }
}

/** True when a live refresher holds the lock, so a render does not start another one. */
export function refreshInFlight(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return Date.now() - statSync(refreshLockPath(env)).mtimeMs < REFRESH_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Takes the refresh lock (O_EXCL), so at most one refresher runs per machine however many sessions render.
 * Returns a release function, or null when another live refresher holds it.
 */
export function tryAcquireRefreshLock(env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  const file = refreshLockPath(env);
  mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
  const owner = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try { writeSync(fd, owner); } finally { closeSync(fd); }
      return () => {
        try {
          if (readFileSync(file, 'utf8') === owner) unlinkSync(file);
        } catch {
          // Already gone.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (refreshInFlight(env)) return null;
    try { unlinkSync(file); } catch { /* raced with its owner */ }
  }
  return null;
}
