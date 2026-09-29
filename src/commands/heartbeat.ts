import type { Ctx } from '../cli.js';

export async function heartbeatCommand(ctx: Ctx): Promise<number> {
  const source = typeof ctx.flags.source === 'string' && ctx.flags.source !== '' ? ctx.flags.source : 'cli';
  const res = await ctx.client.heartbeat(source);
  ctx.io.stdout(ctx.json ? `${JSON.stringify(res)}\n` : `Heartbeat sent (${source}); session active until ${res.active_until}.\n`);
  return 0;
}
