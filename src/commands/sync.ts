import { formatList } from '../format.js';
import type { Ctx } from '../cli.js';

/**
 * `mokkan sync [--source X] [--deliver]`: everything the Claude Code pane shows, in one process over one client:
 * the whole list, the history, the balance and a heartbeat. Only the list must succeed; a failed history or
 * balance is null, a failed heartbeat is ignored. With --deliver, the timed reminders the list shows as due are
 * marked delivered; `delivered` holds their ids (null when that call failed), and `reminders` is the list as fetched.
 */
export async function syncCommand(ctx: Ctx): Promise<number> {
  const source = typeof ctx.flags.source === 'string' && ctx.flags.source !== '' ? ctx.flags.source : 'cli';
  const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  const [list, done, balance] = await Promise.all([
    ctx.client.list('all'),
    optional(ctx.client.list('done')),
    optional(ctx.client.balance()),
    optional(ctx.client.heartbeat(source)),
  ]);
  const due = list.reminders.filter((r) => r.due_at !== null && r.state === 'due').map((r) => r.id);
  const delivered = ctx.flags.deliver !== true ? [] : due.length === 0 ? [] : (await optional(ctx.client.deliver(due)))?.delivered ?? null;
  if (ctx.json) {
    ctx.io.stdout(`${JSON.stringify({ ...list, done: done?.reminders ?? null, balance: balance?.balance ?? null, delivered })}\n`);
    return 0;
  }
  ctx.io.stdout(formatList(list.reminders, ctx.now()));
  if (delivered !== null && delivered.length > 0) ctx.io.stdout(`Delivered ${delivered.length} reminder(s).\n`);
  return 0;
}
