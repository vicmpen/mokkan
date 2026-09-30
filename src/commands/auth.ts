import { ApiError, NetworkError } from '../client.js';
import { clearCredentials } from '../credentials.js';
import { UserError } from '../errors.js';
import type { Ctx } from '../cli.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 10;

async function requireEmail(ctx: Ctx, given: string | undefined, usage: string): Promise<string> {
  const email = given ?? (ctx.io.isTTY ? await ctx.io.prompt('Email: ', false) : '');
  if (!EMAIL_RE.test(email)) throw new UserError(`Provide an email address. Usage: ${usage}`);
  return email;
}

async function requirePassword(ctx: Ctx, question: string): Promise<string> {
  const fromEnv = ctx.io.env.MOKKAN_PASSWORD;
  if (fromEnv && fromEnv !== '') return fromEnv;
  if (!ctx.io.isTTY) throw new UserError('A password is needed: run this in a terminal, or set MOKKAN_PASSWORD');
  return ctx.io.prompt(question, true);
}

async function requireOtp(ctx: Ctx, email: string): Promise<string> {
  const flag = ctx.flags.otp;
  if (typeof flag === 'string' && flag !== '') return flag;
  if (!ctx.io.isTTY) throw new UserError(`Provide the code: mokkan register --complete ${email} --otp <code>`);
  return ctx.io.prompt('One-time code: ', false);
}

export async function registerCommand(ctx: Ctx, args: string[]): Promise<number> {
  const { io, client, flags } = ctx;
  const email = await requireEmail(ctx, args[0], 'mokkan register you@example.com');
  if (flags.complete !== true) {
    await client.registerStart(email);
    io.stdout(`One-time code sent to ${email}. (Dev server: read it from GET /dev/outbox?to=${email} or server/outbox.jsonl.)\n`);
    if (flags.start === true) return 0;
    if (!io.isTTY) {
      io.stdout(`Finish in a terminal: mokkan register --complete ${email}\n`);
      return 0;
    }
  }
  const otp = await requireOtp(ctx, email);
  const password = await requirePassword(ctx, `New password (min ${MIN_PASSWORD_LENGTH} chars): `);
  if (password.length < MIN_PASSWORD_LENGTH) throw new UserError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const creds = await client.registerComplete(email, otp, password);
  io.stdout(`Registered and logged in as ${creds.email} (${client.baseUrl}).\n`);
  return 0;
}

export async function loginCommand(ctx: Ctx, args: string[]): Promise<number> {
  const email = await requireEmail(ctx, args[0], 'mokkan login you@example.com');
  const fromEnv = ctx.io.env.MOKKAN_PASSWORD;
  if (!ctx.io.isTTY && (fromEnv === undefined || fromEnv === '')) {
    // Same as register: the hidden password prompt needs a terminal (e.g. /mokkan login inside Claude Code).
    ctx.io.stdout(`Finish in a terminal: mokkan login ${email}\n`);
    return 0;
  }
  const password = await requirePassword(ctx, 'Password: ');
  const creds = await ctx.client.login(email, password);
  ctx.io.stdout(`Logged in as ${creds.email} (${ctx.client.baseUrl}).\n`);
  return 0;
}

export async function logoutCommand(ctx: Ctx): Promise<number> {
  if (!ctx.client.hasCredentials()) {
    ctx.io.stdout('Not logged in.\n');
    return 0;
  }
  try {
    await ctx.client.logout();
  } catch (err) {
    // The local credentials are removed regardless; a dead server must not keep us logged in.
    if (!(err instanceof NetworkError) && !(err instanceof ApiError)) throw err;
  }
  clearCredentials(ctx.io.env);
  ctx.io.stdout('Logged out.\n');
  return 0;
}

export async function statusCommand(ctx: Ctx): Promise<number> {
  const { io, client } = ctx;
  if (!client.hasCredentials()) {
    io.stdout(`Server: ${client.baseUrl}\nNot logged in. Run: mokkan login\n`);
    return 0;
  }
  const [me, list, pending] = await Promise.all([client.me(), client.list('active'), client.pending()]);
  if (ctx.json) {
    io.stdout(`${JSON.stringify({ server_url: client.baseUrl, me, active: list.reminders.length, due: pending.due.length, awaiting_ack: pending.awaiting_ack.length })}\n`);
    return 0;
  }
  io.stdout([
    `Server: ${client.baseUrl}`,
    `Account: ${me.email}`,
    ...(typeof me.credit_balance === 'number' ? [`Credits: ${me.credit_balance}`] : []),
    `Session: ${me.session_active ? 'active' : 'inactive'} (last heartbeat ${me.last_heartbeat_at ?? 'never'})`,
    `Active reminders: ${list.reminders.length}`,
    `Due now: ${pending.due.length}, awaiting ack: ${pending.awaiting_ack.length}`,
    '',
  ].join('\n'));
  return 0;
}
