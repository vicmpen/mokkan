import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { notifyStateDir } from '../credentials.js';

/**
 * Files in the notify state directory (`$XDG_CONFIG_HOME/mokkan/notify`, 0700). They hold reminder text, so every
 * file is 0600 and written atomically: a shell may read one at any moment.
 */
export const STAMP_FILE = 'stamp';
export const LOCK_FILE = 'poll.lock';
export const SHELL_FILE = 'shell.txt';
export const OSC_FILE = 'osc.txt';
export const NOTIFIED_FILE = 'notified.json';

/** A poll lock older than this was left by a crashed process (a poll's own budget is 10 s). */
export const POLL_LOCK_STALE_MS = 30_000;

/** Per reminder id: whether a desktop notification was shown, and how many attempts failed. */
export interface NotifiedEntry { done: boolean; attempts: number }
export type NotifiedState = Record<string, NotifiedEntry>;

export function ensureNotifyDir(env: NodeJS.ProcessEnv): string {
  const dir = notifyStateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Writes `file` in the state directory through a temp file and rename, 0600. */
export function writeStateFile(env: NodeJS.ProcessEnv, name: string, content: string): void {
  const dir = ensureNotifyDir(env);
  const file = path.join(dir, name);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function readStateFile(env: NodeJS.ProcessEnv, name: string): string | null {
  try {
    return readFileSync(path.join(notifyStateDir(env), name), 'utf8');
  } catch {
    return null;
  }
}

/** Epoch seconds of the last poll attempt; 0 when missing or not a plain number (the shells apply the same rule). */
export function readStamp(env: NodeJS.ProcessEnv): number {
  const text = readStateFile(env, STAMP_FILE)?.trim() ?? '';
  return /^[0-9]{1,15}$/.test(text) ? Number(text) : 0;
}

export function writeStamp(env: NodeJS.ProcessEnv, epochSeconds: number): void {
  writeStateFile(env, STAMP_FILE, `${Math.floor(epochSeconds)}\n`);
}

/**
 * Takes the poll lock without waiting: returns its release function, or null when another poll holds it. The agent
 * and every shell share it, so they never poll at the same time. A lock older than `staleMs` is taken over.
 */
export function tryLockPoll(env: NodeJS.ProcessEnv, staleMs = POLL_LOCK_STALE_MS): (() => void) | null {
  const file = path.join(ensureNotifyDir(env), LOCK_FILE);
  const owner = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try { writeSync(fd, owner); } finally { closeSync(fd); }
      return () => {
        // Remove only our own lock: after overrunning staleMs another poll may own the file.
        try { if (readFileSync(file, 'utf8') === owner) unlinkSync(file); } catch { /* already gone */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - statSync(file).mtimeMs <= staleMs) return null;
      unlinkSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Released between our open and stat: try once more.
    }
  }
  return null;
}

/** What the shells print (`shell.txt`) and the OSC payload lines (`osc.txt`). Empty strings mean nothing to show. */
export function writeShellFiles(env: NodeJS.ProcessEnv, shell: string, osc: string): void {
  writeStateFile(env, SHELL_FILE, shell);
  writeStateFile(env, OSC_FILE, osc);
}

export function readShellFile(env: NodeJS.ProcessEnv): string {
  return readStateFile(env, SHELL_FILE) ?? '';
}

/** The notified ids; an unreadable or malformed file counts as empty (at worst a reminder pops up again). */
export function readNotified(env: NodeJS.ProcessEnv): NotifiedState {
  const text = readStateFile(env, NOTIFIED_FILE);
  if (text === null) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { return {}; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: NotifiedState = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Partial<NotifiedEntry>;
    if (typeof e.done === 'boolean' && typeof e.attempts === 'number' && Number.isInteger(e.attempts) && e.attempts >= 0) {
      out[id] = { done: e.done, attempts: e.attempts };
    }
  }
  return out;
}

export function writeNotified(env: NodeJS.ProcessEnv, state: NotifiedState): void {
  writeStateFile(env, NOTIFIED_FILE, `${JSON.stringify(state)}\n`);
}

/** Drops the ids that are no longer notifiable (acknowledged, done or deleted). */
export function pruneNotified(state: NotifiedState, keep: Iterable<string>): NotifiedState {
  const ids = new Set(keep);
  return Object.fromEntries(Object.entries(state).filter(([id]) => ids.has(id)));
}
