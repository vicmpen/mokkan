import { spawn as nodeSpawn } from 'node:child_process';
import { ApiError } from '../client.js';
import { UserError } from '../errors.js';
import type { Ctx } from '../cli.js';
import type { CheckoutResponse } from '../types.js';

export type SpawnFn = (cmd: string, args: string[], opts: { detached: boolean; stdio: 'ignore'; windowsHide: boolean; env: NodeJS.ProcessEnv })
  => { on(event: 'error', listener: () => void): unknown; unref(): void };

/**
 * Only a Stripe Checkout address is opened automatically. The URL comes from the server, so a compromised or
 * mistyped server must not be able to make the CLI open a local file, an app or anything that is not https.
 */
export function isTrustedCheckoutUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return u.protocol === 'https:' && (host === 'checkout.stripe.com' || host.endsWith('.stripe.com'));
}

/**
 * Best effort: start the platform opener detached and ignore every failure (no display, no opener).
 * No shell is involved on any platform: the URL is always one argv entry. Returns whether an opener was started.
 */
export function openUrlDetached(
  url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env,
  spawn: SpawnFn = nodeSpawn as unknown as SpawnFn,
): boolean {
  if (!isTrustedCheckoutUrl(url)) return false;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open'; args = [url];
  } else if (platform === 'win32') {
    // Not `cmd /c start`: cmd.exe would parse &, | and ^ in the URL.
    cmd = 'rundll32'; args = ['url.dll,FileProtocolHandler', url];
  } else {
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
    cmd = 'xdg-open'; args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false; /* nothing to open with */
  }
}

export async function buyCommand(ctx: Ctx): Promise<number> {
  if (ctx.flags.pack === '') throw new UserError('--pack needs a value.\nUsage: mokkan buy [--pack <key>] [--no-open]');
  const pack = typeof ctx.flags.pack === 'string' ? ctx.flags.pack : undefined;
  let res: CheckoutResponse;
  try {
    res = await ctx.client.checkout(pack);
  } catch (err) {
    // The checkout route exists only when the server has Stripe configured.
    if (err instanceof ApiError && err.status === 404) throw new UserError('Billing is not enabled on this server.');
    throw err;
  }
  const wanted = ctx.flags['no-open'] !== true;
  const trusted = isTrustedCheckoutUrl(res.url);
  if (wanted && trusted) {
    try { ctx.io.openUrl?.(res.url); } catch { /* the URL is printed anyway */ }
  }
  if (ctx.json) {
    ctx.io.stdout(`${JSON.stringify(res)}\n`);
    return 0;
  }
  let how: string;
  if (!wanted) how = 'Open the link above in your browser to pay.';
  else if (trusted) how = 'Opening it in your browser (open the link above if nothing appears).';
  else how = 'This link was not opened automatically because it is not a Stripe Checkout (https://checkout.stripe.com) address. Check it before opening it.';
  ctx.io.stdout([
    `Checkout: ${res.url}`,
    how,
    'When the payment completes, run `mokkan balance` to see your credits.',
    '',
  ].join('\n'));
  return 0;
}

export async function balanceCommand(ctx: Ctx): Promise<number> {
  const res = await ctx.client.balance();
  if (ctx.json) {
    ctx.io.stdout(`${JSON.stringify(res)}\n`);
    return 0;
  }
  const lines = [`Balance: ${res.balance} ${Math.abs(res.balance) === 1 ? 'credit' : 'credits'}`];
  if (res.ledger.length === 0) {
    lines.push('No transactions yet.');
  } else {
    lines.push('', 'Recent transactions (UTC):');
    for (const e of res.ledger) {
      const when = e.created_at.replace('T', ' ').slice(0, 16);
      const delta = e.delta > 0 ? `+${e.delta}` : String(e.delta);
      lines.push(`  ${when}  ${delta.padStart(6)}  ${e.reason}`);
    }
  }
  ctx.io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
