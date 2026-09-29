import { ApiError } from './client.js';
import { SessionExpiredError, UserError } from './errors.js';
import { formatReminderLine } from './format.js';
import type { Ctx } from './cli.js';

const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 5;

/** One poll: heartbeat as `watcher`, print due reminders, mark them delivered. Returns how many were shown. */
export async function watchOnce(ctx: Ctx): Promise<number> {
  await ctx.client.heartbeat('watcher');
  const pending = await ctx.client.pending();
  if (pending.due.length === 0) return 0;
  ctx.io.stdout(`${ctx.now().toISOString()} reminders due:\n${pending.due.map(formatReminderLine).join('\n')}\n`);
  await ctx.client.deliver(pending.due.map((r) => r.id));
  return pending.due.length;
}

export async function watchCommand(ctx: Ctx): Promise<number> {
  const raw = ctx.flags.interval;
  const interval = raw === undefined ? DEFAULT_INTERVAL_SECONDS : Number(raw);
  if (!Number.isInteger(interval) || interval < MIN_INTERVAL_SECONDS) {
    throw new UserError(`--interval must be a whole number of seconds, at least ${MIN_INTERVAL_SECONDS}`);
  }
  if (!ctx.client.hasCredentials()) throw new UserError('Not logged in. Run: mokkan login');
  const once = ctx.flags.once === true;
  const stop = new AbortController();
  const onSignal = (): void => { stop.abort(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (!once) ctx.io.stderr(`mokkan watch: polling ${ctx.client.baseUrl} every ${interval}s (Ctrl-C to stop)\n`);
    while (!stop.signal.aborted) {
      try {
        await watchOnce(ctx);
      } catch (err) {
        // Logged out, or the session expired and the credentials were removed: polling cannot recover.
        if ((err instanceof ApiError && err.code === 'no_credentials') || err instanceof SessionExpiredError) throw err;
        ctx.io.stderr(`${ctx.now().toISOString()} watch error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      if (once) break;
      await ctx.io.sleep(interval * 1000, stop.signal);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return 0;
}
