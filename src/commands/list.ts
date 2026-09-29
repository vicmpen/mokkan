import { formatList, formatPending } from '../format.js';
import type { Ctx } from '../cli.js';

export async function listCommand(ctx: Ctx): Promise<number> {
  const res = await ctx.client.list(ctx.flags.all === true ? 'all' : 'active');
  ctx.io.stdout(ctx.json ? `${JSON.stringify(res)}\n` : formatList(res.reminders, ctx.now()));
  return 0;
}

export async function doneCommand(ctx: Ctx): Promise<number> {
  const res = await ctx.client.list('done');
  ctx.io.stdout(ctx.json ? `${JSON.stringify(res)}\n` : formatList(res.reminders, ctx.now()));
  return 0;
}

export async function pendingCommand(ctx: Ctx): Promise<number> {
  const res = await ctx.client.pending();
  if (ctx.json) {
    ctx.io.stdout(`${JSON.stringify(res)}\n`);
    return 0;
  }
  ctx.io.stdout(formatPending(res) || 'Nothing pending.\n');
  return 0;
}
