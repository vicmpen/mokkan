import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApiError } from './client.js';
import { hookLogPath } from './credentials.js';
import { SessionExpiredError, UserError } from './errors.js';
import { ACK_HINT, formatPending, formatReminderLine } from './format.js';
import type { Reminder } from './types.js';
import type { Ctx } from './cli.js';

export type HookKind = 'session-start' | 'stop';

/** One overall deadline per hook run, inside Claude Code's 10 s hook timeout. */
export const HOOK_BUDGET_MS = 8000;
/** Below this much remaining budget, skip marking reminders delivered: they are simply shown again next turn. */
export const DELIVER_MIN_REMAINING_MS = 1500;
/** "Not logged in" is logged at most this often, so a logged-out user's hook.log does not grow on every reply. */
const NOT_LOGGED_IN_LOG_INTERVAL_MS = 3600 * 1000;

/** The subset of Claude Code's hook stdin JSON that the hooks use. */
export interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  stop_hook_active?: boolean;
}

export function parseHookInput(raw: string): HookInput {
  if (raw.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

/** Stop-hook output: one JSON line that makes Claude relay the reminders in its next reply. */
export function formatStopDecision(due: Reminder[]): string {
  const reason = [
    'Reminders due (from the mokkan server):',
    ...due.map(formatReminderLine),
    `Tell the user these reminders verbatim, then remind them to ${ACK_HINT}. Then stop.`,
  ].join('\n');
  const systemMessage = `${due.length} reminder(s) due — see reply`;
  return `${JSON.stringify({ decision: 'block', reason, systemMessage })}\n`;
}

export function appendHookLog(env: NodeJS.ProcessEnv, kind: string, message: string): void {
  const file = hookLogPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${new Date().toISOString()} ${kind} ${message}\n`, { mode: 0o600 });
}

function notifiedMarkerPath(env: NodeJS.ProcessEnv, suffix = ''): string {
  return `${hookLogPath(env)}${suffix}.notified`;
}

function notifiedRecently(env: NodeJS.ProcessEnv, suffix = ''): boolean {
  try {
    const at = Date.parse(readFileSync(notifiedMarkerPath(env, suffix), 'utf8').trim());
    const age = Date.now() - at;
    return Number.isFinite(at) && age >= 0 && age < NOT_LOGGED_IN_LOG_INTERVAL_MS;
  } catch {
    return false;
  }
}

function markNotified(env: NodeJS.ProcessEnv, suffix = ''): void {
  writeFileSync(notifiedMarkerPath(env, suffix), `${new Date().toISOString()}\n`, { mode: 0o600 });
}

/**
 * Logs a hook failure to hook.log; a failure to log is swallowed too. Hooks must never fail a Claude Code session.
 * An expired session is logged once; the "Not logged in" that every later hook hits is logged at most hourly.
 */
export function safeAppendHookLog(env: NodeJS.ProcessEnv, kind: string, err: unknown): void {
  try {
    if (err instanceof SessionExpiredError) {
      appendHookLog(env, kind, 'session expired; run: mokkan login');
      markNotified(env);
      return;
    }
    if (err instanceof ApiError && err.code === 'no_credentials') {
      if (notifiedRecently(env)) return;
      appendHookLog(env, kind, err.message);
      markNotified(env);
      return;
    }
    if (err instanceof ApiError && err.status === 402) {
      // Out of credits: logged at most hourly, like "not logged in", so hooks never spam hook.log.
      if (notifiedRecently(env, '.402')) return;
      appendHookLog(env, kind, err.message);
      markNotified(env, '.402');
      return;
    }
    appendHookLog(env, kind, err instanceof Error ? err.message : String(err));
  } catch {
    // Logging must never fail the hook either.
  }
}

/**
 * Returns what the hook prints. Throws on any failure; hookCommand turns that into a silent exit 0.
 * `deadlineAt` (epoch ms): when too little time is left, the reminders are shown without being marked delivered.
 */
export async function runHook(ctx: Ctx, kind: HookKind, input: HookInput, deadlineAt = Infinity): Promise<string> {
  const { client } = ctx;
  const deliver = async (ids: string[]): Promise<void> => {
    if (ids.length > 0 && deadlineAt - Date.now() >= DELIVER_MIN_REMAINING_MS) await client.deliver(ids);
  };
  await client.heartbeat('claude-code', input.session_id);
  const pending = await client.pending();
  const dueIds = pending.due.map((r) => r.id);
  if (kind === 'session-start') {
    const block = formatPending(pending);
    await deliver(dueIds);
    return block;
  }
  if (input.stop_hook_active === true || dueIds.length === 0) return '';
  await deliver(dueIds);
  return formatStopDecision(pending.due);
}

export async function hookCommand(ctx: Ctx, args: string[], deadlineAt = Infinity): Promise<number> {
  const kind = args[0];
  if (kind !== 'session-start' && kind !== 'stop') throw new UserError('Usage: mokkan hook session-start|stop');
  try {
    const input = parseHookInput(await ctx.io.readStdin());
    ctx.io.stdout(await runHook(ctx, kind, input, deadlineAt));
  } catch (err) {
    safeAppendHookLog(ctx.io.env, kind, err);
  }
  return 0;
}
