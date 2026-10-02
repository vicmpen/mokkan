import { UserError } from '../errors.js';
import type { Ctx } from '../cli.js';

export async function feedbackCommand(ctx: Ctx, args: string[]): Promise<number> {
  const text = args.join(' ').trim();
  if (text === '') throw new UserError('Usage: mokkan feedback <text>');
  const res = await ctx.client.feedback(text);
  ctx.io.stdout(ctx.json ? `${JSON.stringify(res)}\n` : 'Feedback sent. Thank you.\n');
  return 0;
}
