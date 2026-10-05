import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError, NetworkError, type MokkanClient } from '../client.js';
import { notifyStateDir } from '../credentials.js';
import { SessionExpiredError } from '../errors.js';
import { appendHookLogHourly, safeAppendHookLog } from '../hooks.js';
import { isPrivacyRequired } from '../privacy.js';
import type { Spawner } from '../spawn.js';
import type { PendingResponse, Reminder } from '../types.js';
import { BACKENDS, type NotifyBackend } from './backends/index.js';
import { loadNotifyConfig, type NotifyConfig } from './config.js';
import { osOf } from './detect.js';
import { formatDueLocal, formatNotifyLine } from './format.js';
import { forOsc, sanitizeText } from './sanitize.js';
import { ensureInitScripts } from './shells/index.js';
import {
  pruneNotified, readNotified, readStamp, tryLockPoll, writeNotified, writeShellFiles, writeStamp, writeStateFile,
  type NotifiedState,
} from './state.js';

/** The last poll that reached the server (or tried to), for `mokkan notify status`. */
export const LAST_FILE = 'last.json';

export const POLL_TIMEOUT_MS = 10_000;
export const NOTIFIER_TIMEOUT_MS = 3_000;
/** A desktop notification that failed this many times is given up. */
export const MAX_NOTIFY_ATTEMPTS = 3;
/** More new reminders than this become one summary notification. */
export const MAX_SINGLE_NOTIFICATIONS = 3;

/** The shell line shown while the privacy policy is not accepted. */
export const PRIVACY_LINE = 'privacy policy updated: run mokkan accept in a terminal\n';

/** Poll is read-only toward the server: the type admits `pending` and nothing else (no heartbeat, no deliver). */
export type PollClient = Pick<MokkanClient, 'pending'>;

export interface PollDeps {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** null: not logged in. A function is called once per poll, so a loop sees a login or logout in between. */
  client: PollClient | null | (() => PollClient | null);
  spawn: Spawner;
  platform: NodeJS.Platform;
  /** Whether a command is on PATH (the backends' availability probe). */
  which: (cmd: string) => Promise<boolean>;
  backends?: readonly NotifyBackend[];
  /** For the due times in shell.txt and notifications; the system zone when omitted. */
  timeZone?: string;
  overallTimeoutMs?: number;
  notifierTimeoutMs?: number;
  /**
   * The absolute node and cli.js paths and the CLI version baked into `init.<shell>`. With all three, each poll
   * regenerates the init scripts that exist and differ (after an update, or a changed interval or osc mode).
   */
  node?: string;
  cli?: string;
  version?: string;
}

export type PollStatus = 'skipped-disabled' | 'skipped-locked' | 'skipped-fresh' | 'ok' | 'error';

export interface PollOutcome {
  status: PollStatus;
  /** Notifiable reminders (fired, scheduled, not acknowledged) in this poll. */
  shown: number;
  /** Reminders whose desktop notification succeeded in this poll. */
  notified: number;
  /** The desktop backend used in this poll, if one was needed. */
  backend: string | null;
  /** Desktop is on and there was something to show, but no backend is available here. */
  noBackend?: boolean;
  error?: string;
}

/** `last.json`: the outcome of the last poll that tried the server, and when (ISO). */
export interface LastPoll extends PollOutcome { at: string }

/**
 * The reminders to notify: scheduled ones (`due_at` set) whose time has passed and that are not acknowledged, from
 * `due` and `awaiting_ack`, each once, oldest due time first (ties by id). Plain pushes never notify.
 */
export function notifiable(pending: PendingResponse, now: Date): Reminder[] {
  const byId = new Map<string, Reminder>();
  for (const r of [...pending.due, ...pending.awaiting_ack]) {
    if (r.due_at === null || byId.has(r.id)) continue;
    const due = Date.parse(r.due_at);
    if (Number.isFinite(due) && due <= now.getTime()) byId.set(r.id, r);
  }
  return [...byId.values()].sort((a, b) =>
    Date.parse(a.due_at!) - Date.parse(b.due_at!) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const outcome = (status: PollStatus, extra: Partial<PollOutcome> = {}): PollOutcome =>
  ({ status, shown: 0, notified: 0, backend: null, ...extra });

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function logFailure(env: NodeJS.ProcessEnv, err: unknown): void {
  // safeAppendHookLog rate-limits 429, privacy and "not logged in", but would log a NetworkError every interval.
  if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) {
    appendHookLogHourly(env, 'notify', 'network', message(err));
  } else {
    safeAppendHookLog(env, 'notify', err);
  }
}

/**
 * One poll (spec "Poll", steps 1 to 8): under `poll.lock`, at most once per `interval`, call `pending`, rewrite
 * `shell.txt`/`osc.txt` and pop up a desktop notification for each newly fired reminder. Never throws and never
 * prints; failures are logged to hook.log and returned.
 */
export async function pollOnce(deps: PollDeps): Promise<PollOutcome> {
  const { env } = deps;
  try {
    const loaded = loadNotifyConfig(env);
    if (loaded.disabledBy === 'corrupt' && loaded.problem !== null) {
      appendHookLogHourly(env, 'notify', 'config', loaded.problem);
    }
    const config = loaded.config;
    if (!config.shell && !config.desktop) {
      writeShellFiles(env, '', '');
      return outcome('skipped-disabled');
    }
    const release = tryLockPoll(env);
    if (release === null) return outcome('skipped-locked');
    try {
      const now = deps.now();
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const stamp = readStamp(env);
      // A stamp in the future (clock moved back) does not block polling forever.
      if (stamp <= nowSeconds && nowSeconds - stamp < config.interval) return outcome('skipped-fresh');
      // Before any network I/O, so a slow or failing server cannot make every prompt start node.
      writeStamp(env, nowSeconds);
      regenerateInitScripts(deps, config);
      const result = await withDeadline(deps, config, now);
      try {
        writeStateFile(env, LAST_FILE, `${JSON.stringify({ at: now.toISOString(), ...result } satisfies LastPoll)}\n`);
      } catch { /* status only */ }
      return result;
    } finally {
      release();
    }
  } catch (err) {
    safeAppendHookLog(env, 'notify', err);
    return outcome('error', { error: message(err) });
  }
}

/** Rewrites stale `init.<shell>` files (cheap: a read and a compare each); a failure is logged, never fatal. */
function regenerateInitScripts(deps: PollDeps, config: NotifyConfig): void {
  const { node, cli, version } = deps;
  if (node === undefined || cli === undefined || version === undefined) return;
  try {
    ensureInitScripts(deps.env, { node, cli, version, interval: config.interval, osc: config.osc });
  } catch (err) {
    appendHookLogHourly(deps.env, 'notify', 'init', message(err));
  }
}

/** Runs the network part under the overall timeout; once it has passed, the late work writes nothing. */
async function withDeadline(deps: PollDeps, config: NotifyConfig, now: Date): Promise<PollOutcome> {
  const ms = deps.overallTimeoutMs ?? POLL_TIMEOUT_MS;
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<PollOutcome>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      const error = `timed out after ${ms} ms`;
      appendHookLogHourly(deps.env, 'notify', 'network', `poll ${error}`);
      resolve(outcome('error', { error }));
    }, ms);
  });
  try {
    return await Promise.race([pollWork(deps, config, now, () => !expired), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function pollWork(deps: PollDeps, config: NotifyConfig, now: Date, live: () => boolean): Promise<PollOutcome> {
  const { env } = deps;
  const client = typeof deps.client === 'function' ? deps.client() : deps.client;
  let pending: PendingResponse;
  try {
    if (client === null) throw new ApiError(401, 'no_credentials', 'Not logged in. Run: mokkan login');
    pending = await client.pending();
  } catch (err) {
    if (!live()) return outcome('error', { error: message(err) });
    logFailure(env, err);
    if ((err instanceof ApiError && err.code === 'no_credentials') || err instanceof SessionExpiredError) {
      // The reminder text is no longer this user's to show.
      writeShellFiles(env, '', '');
      writeNotified(env, {});
    } else if (isPrivacyRequired(err)) {
      writeShellFiles(env, config.shell ? PRIVACY_LINE : '', '');
    }
    // Anything else (server down, 5xx, 429, a timeout): keep the files, they are at worst one interval old.
    return outcome('error', { error: message(err) });
  }
  if (!live()) return outcome('error', { error: 'timed out' });

  const due = notifiable(pending, now);
  if (config.shell) {
    const shell = due.map((r) => `${formatNotifyLine(r, now, deps.timeZone)}\n`).join('');
    const osc = config.osc === 'off' ? '' : due.map((r) => `${forOsc(r.text)}\n`).join('');
    writeShellFiles(env, shell, osc);
  } else {
    writeShellFiles(env, '', '');
  }

  const before = readNotified(env);
  const state = pruneNotified(before, due.map((r) => r.id));
  let result = outcome('ok', { shown: due.length });
  if (config.desktop) result = { ...result, ...(await notifyDesktop(deps, due, state, now, live)) };
  if (!live()) return outcome('error', { error: 'timed out' });
  if (JSON.stringify(state) !== JSON.stringify(before)) writeNotified(env, state);
  return result;
}

/** Step 6: pops up the reminders not yet notified, updating `state` in place. */
async function notifyDesktop(
  deps: PollDeps, due: Reminder[], state: NotifiedState, now: Date, live: () => boolean,
): Promise<Partial<PollOutcome>> {
  const fresh = due.filter((r) => {
    const e = state[r.id];
    return e === undefined || (!e.done && e.attempts < MAX_NOTIFY_ATTEMPTS);
  });
  if (fresh.length === 0) return {};
  const backend = await pickBackend(deps);
  if (backend === null) return { noBackend: true };
  const send = async (body: string): Promise<boolean> => {
    const { file, args } = backend.command('mokkan', body);
    const res = await deps.spawn(file, args, { timeoutMs: deps.notifierTimeoutMs ?? NOTIFIER_TIMEOUT_MS });
    return res.code === 0;
  };
  const record = (ids: string[], ok: boolean): void => {
    for (const id of ids) {
      const prev = state[id] ?? { done: false, attempts: 0 };
      state[id] = ok ? { done: true, attempts: prev.attempts } : { done: false, attempts: prev.attempts + 1 };
    }
  };
  let notified = 0;
  if (fresh.length > MAX_SINGLE_NOTIFICATIONS) {
    // One summary instead of a burst; its result counts for every reminder in it.
    const ok = await send(`${fresh.length} reminders due`);
    record(fresh.map((r) => r.id), ok);
    if (ok) notified = fresh.length;
  } else {
    for (const r of fresh) {
      if (!live()) break;
      const body = `${sanitizeText(r.text)} (due ${formatDueLocal(new Date(r.due_at!), now, deps.timeZone)})`;
      const ok = await send(body);
      record([r.id], ok);
      if (ok) notified += 1;
    }
  }
  return { backend: backend.name, notified };
}

async function pickBackend(deps: PollDeps): Promise<NotifyBackend | null> {
  const os = osOf(deps.platform);
  for (const b of deps.backends ?? BACKENDS) {
    if (!(b.platforms as string[]).includes(os)) continue;
    try {
      if (await b.available({ os }, { which: deps.which })) return b;
    } catch { /* a failing probe means not available */ }
  }
  return null;
}

/** The last recorded poll, or null when there is none (or it is unreadable). */
export function readLastPoll(env: NodeJS.ProcessEnv): LastPoll | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(notifyStateDir(env), LAST_FILE), 'utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Partial<LastPoll>;
    return typeof v.at === 'string' && typeof v.status === 'string' ? (v as LastPoll) : null;
  } catch {
    return null;
  }
}

export interface PollLoopDeps extends PollDeps {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}

/**
 * `notify poll --loop` (XDG autostart): polls, then sleeps for the configured interval (re-read every round), until
 * `signal` aborts. Returns the number of polls run.
 */
export async function pollLoop(deps: PollLoopDeps): Promise<number> {
  let rounds = 0;
  while (!deps.signal.aborted) {
    await pollOnce(deps);
    rounds += 1;
    if (deps.signal.aborted) break;
    try {
      await deps.sleep(loadNotifyConfig(deps.env).config.interval * 1000, deps.signal);
    } catch {
      // An aborted sleep may reject; the loop condition decides.
    }
  }
  return rounds;
}
