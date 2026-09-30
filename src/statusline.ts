import { spawn } from 'node:child_process';
import { ApiError, NetworkError, type MokkanClient } from './client.js';
import { loadCredentials, resolveServerUrl, type Credentials } from './credentials.js';
import { SessionExpiredError } from './errors.js';
import {
  readStatusCache, refreshInFlight, tryAcquireRefreshLock, writeStatusCache, type SlimReminder, type StatusCache,
  type StatusError,
} from './status-cache.js';
import type { CliIO } from './cli.js';

export type StatusFormat = 'ansi' | 'tmux' | 'plain';

export interface StatusOptions {
  format: StatusFormat;
  /** Visible width limit; 0 = none. Defaults to $COLUMNS (Claude Code sets it for status line commands). */
  width: number;
  /** Cache age after which a render starts a background refresh. */
  ttlMs: number;
  /** A due reminder nobody has seen for longer than this is shown as OVERDUE (red). */
  graceMs: number;
  showText: boolean;
  /** Internal: the detached refresher. */
  refresh: boolean;
  /** For tests; undefined = the system time zone. */
  timeZone?: string;
}

const DEFAULT_TTL_SECONDS = 30;
export const DEFAULT_GRACE_MINUTES = 15;
/** A cold render (no cache) waits this long for the server: Claude Code cancels slow status line commands. */
const COLD_FETCH_TIMEOUT_MS = 800;
const REFRESH_TIMEOUT_MS = 3000;
const MAX_TEXT = 40;

/** Words that make `mokkan statusline` render instead of configure. Older configs passed render flags without --render. */
const RENDER_FLAGS = new Set(['--render', '--format', '--no-text', '--width', '--ttl', '--grace', '--refresh']);

export function isRenderInvocation(args: string[]): boolean {
  return args.some((a) => RENDER_FLAGS.has(a.split('=')[0]));
}

/** Status line flags are parsed here, not in cli.ts's global flag table, so they can never eat reminder text. */
export function parseStatusArgs(args: string[], env: NodeJS.ProcessEnv): StatusOptions {
  const opts: StatusOptions = {
    format: 'ansi', width: positiveInt(env.COLUMNS) ?? 0, ttlMs: DEFAULT_TTL_SECONDS * 1000,
    graceMs: DEFAULT_GRACE_MINUTES * 60_000, showText: true, refresh: false,
  };
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i].split(/=(.*)/s, 2);
    const value = (): string | undefined => inline ?? args[++i];
    switch (name) {
      case '--format': {
        const v = value();
        if (v === 'ansi' || v === 'tmux' || v === 'plain') opts.format = v;
        break;
      }
      case '--width': opts.width = positiveInt(value()) ?? opts.width; break;
      case '--ttl': opts.ttlMs = (positiveInt(value()) ?? DEFAULT_TTL_SECONDS) * 1000; break;
      case '--grace': opts.graceMs = (positiveInt(value()) ?? DEFAULT_GRACE_MINUTES) * 60_000; break;
      case '--no-text': opts.showText = false; break;
      case '--refresh': opts.refresh = true; break;
      default: break; // Unknown words are ignored: the status line must never fail on a typo.
    }
  }
  return opts;
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 ? n : undefined;
}

// ---- rendering ----

/** Below this many credits the status line warns. */
const LOW_CREDITS = 20;

export type Tone = 'red' | 'yellow' | 'green' | 'dim' | 'plain';
/** `keep`: shown in full while the width allows; other segments are shortened first (the credit warning must survive). */
export interface Segment { text: string; tone: Tone; keep?: boolean }

/** Strips control characters (a reminder must not be able to inject terminal escapes), collapses whitespace, caps length. */
export function cleanText(text: string, max = MAX_TEXT): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}

/** 17:00 today, `Wed 17:00` within a week, `Oct 12 17:00` beyond. Local time (or opts.timeZone). */
export function formatWhen(at: Date, now: Date, timeZone?: string): string {
  const day = (d: Date): string => d.toLocaleDateString('en-CA', { timeZone });
  const time = at.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  if (day(at) === day(now)) return time;
  const prefix = at.getTime() - now.getTime() < 6 * 86400_000
    ? at.toLocaleDateString('en-US', { timeZone, weekday: 'short' })
    : at.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric' });
  return `${prefix} ${time}`;
}

const dueTime = (r: SlimReminder): number => (r.due_at ? Date.parse(r.due_at) : NaN);

/**
 * Everything after the `mokkan:` head: the most recently added open reminder and how many others are open.
 * The colour is the most urgent state on the list, classified against `now` so cached data ages between refreshes:
 * red = due and unseen for longer than the grace period, yellow = due, dim = only unacknowledged ones left.
 */
function bodySegments(reminders: SlimReminder[], now: Date, opts: StatusOptions): Segment[] {
  if (reminders.length === 0) return [];
  const t = now.getTime();
  // Unseen: due, or scheduled whose time has passed but the server's scheduler has not flipped yet.
  const unseen = reminders.filter((r) => r.state === 'due' || (r.state === 'scheduled' && dueTime(r) <= t));
  const tone: Tone = unseen.some((r) => t - dueTime(r) > opts.graceMs) ? 'red'
    : unseen.length > 0 ? 'yellow'
    : reminders.some((r) => r.state === 'delivered') ? 'dim'
    : 'plain';
  const latest = [...reminders].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.position - a.position)[0];
  const more = reminders.length - 1;
  if (!opts.showText) return [{ text: `${reminders.length} open`, tone }];
  const when = latest.state === 'scheduled' && dueTime(latest) > t
    ? ` @${formatWhen(new Date(dueTime(latest)), now, opts.timeZone)}` : '';
  return [{ text: `"${cleanText(latest.text)}"${when}${more > 0 ? ` +${more} more` : ''}`, tone }];
}

export type RenderInput =
  | { kind: 'logged_out' }
  | { kind: 'credentials_error' }
  | { kind: 'unavailable' }
  | { kind: 'cache'; cache: StatusCache };

export function renderStatus(input: RenderInput, now: Date, opts: StatusOptions): string {
  let segments: Segment[];
  if (input.kind === 'logged_out') segments = [{ text: 'mokkan: logged out', tone: 'dim' }];
  else if (input.kind === 'credentials_error') segments = [{ text: 'mokkan: credentials error', tone: 'dim' }];
  else if (input.kind === 'unavailable') segments = [{ text: 'mokkan: …', tone: 'dim' }];
  else segments = cacheSegments(input.cache, now, opts);
  return paint(truncate(segments, opts.width), opts.format);
}

function cacheSegments(cache: StatusCache, now: Date, opts: StatusOptions): Segment[] {
  if (cache.error === 'logged_out') return [{ text: 'mokkan: logged out', tone: 'dim' }];
  const body = bodySegments(cache.reminders, now, opts);
  const failed = cache.error !== null;
  if (failed && cache.fetched_at === null) return [{ text: cache.error === 'offline' ? 'mokkan: offline' : 'mokkan: error', tone: 'dim' }];
  const head: Segment[] = failed
    ? [{ text: `mokkan: ${cache.error === 'offline' ? 'offline' : 'error'} (${formatAge(now.getTime() - Date.parse(cache.fetched_at!))} old) · `, tone: 'dim' }]
    : [{ text: 'mokkan: ', tone: 'plain' }];
  const credits = failed ? [] : creditSegments(cache.credit_balance);
  if (body.length === 0) return failed ? [...head, { text: '✓', tone: 'green' }] : [{ text: 'mokkan ✓', tone: 'green' }, ...credits];
  return [...head, ...body, ...credits];
}

/** ` · 480 cr`, or ` · ⚠ 12 cr — mokkan buy` below the threshold. Nothing when the server reports no balance. */
export function creditSegments(balance: unknown): Segment[] {
  if (typeof balance !== 'number' || !Number.isFinite(balance)) return [];
  if (balance >= LOW_CREDITS) return [{ text: ` · ${balance} cr`, tone: 'dim', keep: true }];
  return [{ text: ` · ⚠ ${balance} cr — mokkan buy`, tone: balance <= 0 ? 'red' : 'yellow', keep: true }];
}

function truncate(segments: Segment[], width: number): Segment[] {
  if (width <= 0) return segments;
  const len = (list: Segment[]) => list.reduce((n, s) => n + [...s.text].length, 0);
  if (len(segments) <= width) return segments;
  // The kept segments (the credit balance) come last: shorten the rest first so they stay visible.
  const kept = segments.filter((s) => s.keep === true);
  const reserved = len(kept);
  if (kept.length > 0 && reserved < width) {
    return [...cut(segments.filter((s) => s.keep !== true), width - reserved), ...kept];
  }
  return cut(segments, width);
}

function cut(segments: Segment[], width: number): Segment[] {
  const out: Segment[] = [];
  let left = width;
  for (const s of segments) {
    const chars = [...s.text];
    if (chars.length <= left) {
      out.push(s);
      left -= chars.length;
      continue;
    }
    if (left > 0) out.push({ text: `${chars.slice(0, left - 1).join('')}…`, tone: s.tone });
    break;
  }
  return out;
}

const ANSI: Record<Tone, [string, string]> = {
  red: ['\x1b[31m', '\x1b[0m'], yellow: ['\x1b[33m', '\x1b[0m'], green: ['\x1b[32m', '\x1b[0m'],
  dim: ['\x1b[2m', '\x1b[0m'], plain: ['', ''],
};
const TMUX: Record<Tone, [string, string]> = {
  red: ['#[fg=red]', '#[fg=default]'], yellow: ['#[fg=yellow]', '#[fg=default]'], green: ['#[fg=green]', '#[fg=default]'],
  dim: ['#[dim]', '#[nodim]'], plain: ['', ''],
};

function paint(segments: Segment[], format: StatusFormat): string {
  return segments.map(({ text, tone }) => {
    if (format === 'plain') return text;
    // tmux expands `#` sequences in #() output; `##` is a literal `#`.
    if (format === 'tmux') return `${TMUX[tone][0]}${text.replace(/#/g, '##')}${TMUX[tone][1]}`;
    return `${ANSI[tone][0]}${text}${ANSI[tone][1]}`;
  }).join('');
}

// ---- fetching ----

export type ClientFactory = (creds: Credentials, timeoutMs: number) => MokkanClient;

function slim(reminders: SlimReminder[]): SlimReminder[] {
  return reminders
    .filter((r) => r.state !== 'done')
    .map(({ id, text, state, position, due_at, created_at }) => ({ id, text, state, position, due_at, created_at }));
}

function classify(err: unknown): StatusError {
  if (err instanceof NetworkError) return 'offline';
  if (err instanceof SessionExpiredError || (err instanceof ApiError && err.code === 'no_credentials')) return 'logged_out';
  return 'error';
}

/** Fetches every non-done reminder and writes the cache. On failure keeps the last good data and records why. */
export async function refreshStatus(io: CliIO, creds: Credentials, makeClient: ClientFactory, timeoutMs: number): Promise<StatusCache> {
  const base = { v: 2 as const, server_url: resolveServerUrl(creds, io.env), email: creds.email, attempted_at: io.now().toISOString() };
  let cache: StatusCache;
  try {
    const client = makeClient(creds, timeoutMs);
    const [list, me] = await Promise.all([client.list('all'), client.me().catch(() => null)]);
    // /me only adds the balance: if it fails alone, the list is still good (list() surfaces auth and network errors).
    cache = { ...base, fetched_at: base.attempted_at, error: null, reminders: slim(list.reminders) };
    if (typeof me?.credit_balance === 'number') {
      cache.credit_balance = me.credit_balance;
    } else if (me === null) {
      // Only /me failed: keep the last known balance rather than hiding it until the next refresh.
      const prev = readStatusCache(io.env);
      if (prev && prev.server_url === base.server_url && prev.email === base.email && prev.credit_balance !== undefined) {
        cache.credit_balance = prev.credit_balance;
      }
    }
  } catch (err) {
    const prev = readStatusCache(io.env);
    const same = prev && prev.server_url === base.server_url && prev.email === base.email;
    cache = { ...base, fetched_at: same ? prev.fetched_at : null, error: classify(err), reminders: same ? prev.reminders : [] };
    if (same && prev.credit_balance !== undefined) cache.credit_balance = prev.credit_balance;
  }
  writeStatusCache(cache, io.env);
  return cache;
}

/** Starts `mokkan statusline --render --refresh` fully detached: the render returns immediately and is never cancelled mid-write. */
export function spawnDetachedRefresh(): void {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'statusline', '--render', '--refresh'], {
    detached: true, stdio: 'ignore',
  });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * `mokkan statusline --render`: one line for Claude Code's statusLine or tmux's status-right. Always prints something and
 * exits 0 (empty output or a non-zero exit blanks Claude Code's whole status line). Normally reads only the cache;
 * a stale cache is refreshed in the background, a missing one with one short synchronous fetch.
 */
export async function statuslineCommand(io: CliIO, args: string[], makeClient: ClientFactory): Promise<number> {
  const opts = parseStatusArgs(args, io.env);
  const now = io.now();
  const print = (input: RenderInput): number => {
    io.stdout(`${renderStatus(input, now, opts)}\n`);
    return 0;
  };
  try {
    let creds: Credentials | null;
    try {
      creds = loadCredentials(io.env);
    } catch {
      return opts.refresh ? 0 : print({ kind: 'credentials_error' });
    }
    if (opts.refresh) {
      if (!creds) return 0;
      const release = tryAcquireRefreshLock(io.env);
      if (!release) return 0;
      try { await refreshStatus(io, creds, makeClient, REFRESH_TIMEOUT_MS); } finally { release(); }
      return 0;
    }
    if (!creds) return print({ kind: 'logged_out' });
    let cache = readStatusCache(io.env);
    if (cache && (cache.server_url !== resolveServerUrl(creds, io.env) || cache.email !== creds.email)) cache = null;
    if (!cache) {
      cache = await refreshStatus(io, creds, makeClient, COLD_FETCH_TIMEOUT_MS);
    } else if (now.getTime() - Date.parse(cache.attempted_at) >= opts.ttlMs && !refreshInFlight(io.env)) {
      (io.spawnRefresh ?? spawnDetachedRefresh)();
    }
    return print({ kind: 'cache', cache });
  } catch {
    return opts.refresh ? 0 : print({ kind: 'unavailable' });
  }
}
