import { ApiError } from '../client.js';
import { parseDuration } from '../duration.js';
import { UserError } from '../errors.js';
import { formatRelative, shortId } from '../format.js';
import type { EditPatch, Reminder } from '../types.js';
import type { Ctx } from '../cli.js';

export async function pushCommand(ctx: Ctx, args: string[]): Promise<number> {
  const text = args.join(' ').trim();
  if (text === '') throw new UserError('Usage: mokkan push <text>');
  const res = await ctx.client.push(text);
  ctx.io.stdout(ctx.json ? `${JSON.stringify(res)}\n` : `Pushed [${shortId(res.reminder.id)}] ${res.reminder.text}\n`);
  return 0;
}

export async function takeCommand(ctx: Ctx, end: 'pop' | 'dequeue'): Promise<number> {
  try {
    const res = end === 'pop' ? await ctx.client.pop() : await ctx.client.dequeue();
    const verb = end === 'pop' ? 'Popped' : 'Dequeued';
    ctx.io.stdout(ctx.json ? `${JSON.stringify(res)}\n` : `${verb} [${shortId(res.reminder.id)}] ${res.reminder.text}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'empty') {
      ctx.io.stdout(ctx.json ? `${JSON.stringify({ error: 'empty', message: 'List is empty.' })}\n` : 'List is empty.\n');
      return 1;
    }
    throw err;
  }
}

export async function inCommand(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length < 2) throw new UserError('Usage: mokkan in <duration> <text>   (e.g. mokkan in 30m call mom)');
  let seconds: number;
  try {
    seconds = parseDuration(args[0]);
  } catch (err) {
    throw new UserError((err as Error).message);
  }
  const text = args.slice(1).join(' ').trim();
  if (text === '') throw new UserError('Usage: mokkan in <duration> <text>');
  const now = ctx.now();
  const dueAt = new Date(now.getTime() + seconds * 1000);
  if (!Number.isFinite(dueAt.getTime())) throw new UserError('duration is too large');
  const res = await ctx.client.push(text, dueAt);
  ctx.io.stdout(ctx.json
    ? `${JSON.stringify(res)}\n`
    : `Scheduled [${shortId(res.reminder.id)}] "${res.reminder.text}" for ${dueAt.toISOString()} (${formatRelative(dueAt, now)})\n`);
  return 0;
}

/** Maps user-typed id prefixes to full ids from the given list. Unknown or ambiguous prefixes are user errors. */
export function resolvePrefixes(reminders: Reminder[], prefixes: string[], listCommand = 'mokkan list'): string[] {
  const ids = new Set<string>();
  for (const prefix of prefixes) {
    const matches = reminders.filter((r) => r.id.startsWith(prefix));
    const kind = listCommand === 'mokkan list' ? 'active ' : listCommand === 'mokkan done' ? 'finished ' : '';
    if (matches.length === 0) throw new UserError(`No ${kind}reminder matches "${prefix}" (run: ${listCommand})`);
    if (matches.length > 1) throw new UserError(`"${prefix}" is ambiguous: ${matches.map((r) => shortId(r.id)).sort().join(', ')}`);
    ids.add(matches[0].id);
  }
  return [...ids];
}

export async function ackCommand(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length === 0) throw new UserError('Usage: mokkan ack <id-prefix>... | mokkan ack all');
  let acknowledged: string[];
  if (args[0] === 'all') {
    acknowledged = (await ctx.client.ack('all')).acknowledged;
  } else {
    acknowledged = await ackWithRetry(ctx, args);
  }
  ctx.io.stdout(ctx.json ? `${JSON.stringify({ acknowledged })}\n` : `Acknowledged ${acknowledged.length} reminder(s).\n`);
  return 0;
}

/**
 * `mokkan done <id-prefix>...` finishes reminders one by one (as pop does, but anywhere on the list);
 * `mokkan undone <id-prefix>...` reopens finished ones at their old position. Prefixes resolve against the open
 * list (`mokkan list --all`) for done and the history (`mokkan done`) for undone. Both free.
 */
export async function markDoneCommand(ctx: Ctx, args: string[], done: boolean): Promise<number> {
  const verb = done ? 'done' : 'undone';
  if (args.length === 0) throw new UserError(`Usage: mokkan ${verb} <id-prefix>...`);
  const changed: Reminder[] = [];
  for (let attempt = 0; ; attempt++) {
    const list = await ctx.client.list(done ? 'all' : 'done');
    const ids = resolvePrefixes(list.reminders, args, done ? 'mokkan list --all' : 'mokkan done');
    try {
      let version = list.version;
      for (const id of ids) {
        const res = await ctx.client.setDone(id, done, version);
        version = res.version;
        changed.push(res.reminder);
      }
      break;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale' && attempt === 0) { changed.length = 0; continue; }
      throw err;
    }
  }
  if (ctx.json) {
    ctx.io.stdout(`${JSON.stringify({ [done ? 'done' : 'reopened']: changed.map((r) => r.id) })}\n`);
  } else {
    for (const r of changed) ctx.io.stdout(`${done ? 'Done' : 'Reopened'} [${shortId(r.id)}] ${r.text}\n`);
  }
  return 0;
}

/** Optimistic concurrency: send the version we resolved against; on 409 stale, re-fetch and retry once. */
async function ackWithRetry(ctx: Ctx, prefixes: string[]): Promise<string[]> {
  for (let attempt = 0; ; attempt++) {
    const list = await ctx.client.list('active');
    const ids = resolvePrefixes(list.reminders, prefixes);
    try {
      return (await ctx.client.ack(ids, list.version)).acknowledged;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'stale' && attempt === 0) continue;
      throw err;
    }
  }
}

/** A list number ("2", as printed by `mokkan list`) is 1..3 digits and nothing else; anything longer is an id prefix. */
const POSITION_RE = /^\d{1,3}$/;

/** Full ISO-8601 date and time with a zone (Z or +hh:mm), e.g. 2026-10-01T09:00:00Z. */
const ISO_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;

const EDIT_USAGE = 'Usage: mokkan edit <n|id> [--all] [--in <duration> | --at <iso> | --clear-due] [new text...]';

interface EditTarget { kind: 'number'; n: number; scope: 'active' | 'all' }
interface EditPrefix { kind: 'prefix'; prefix: string }

function listCommandName(scope: 'active' | 'all'): string {
  return scope === 'all' ? 'mokkan list --all' : 'mokkan list';
}

/** Resolves the target once against the given list; a number uses that list's numbering, a prefix any non-done reminder. */
function resolveEditTarget(list: Reminder[], target: EditTarget | EditPrefix): string {
  if (target.kind === 'prefix') {
    return resolvePrefixes(list, [target.prefix], 'mokkan list --all')[0];
  }
  if (target.n < 1 || target.n > list.length) {
    throw new UserError(`There is no reminder number ${target.n} in \`${listCommandName(target.scope)}\` (it shows ${list.length}).`);
  }
  return list[target.n - 1].id;
}

function buildEditPatch(ctx: Ctx, words: string[], now: Date): EditPatch {
  const { text: textFlag, in: inFlag, at, 'clear-due': clearDue } = ctx.flags;
  for (const [name, value] of [['text', textFlag], ['in', inFlag], ['at', at]] as const) {
    if (value === '') throw new UserError(`--${name} needs a value.\n${EDIT_USAGE}`);
  }
  const timeFlags = [inFlag !== undefined, at !== undefined, clearDue === true].filter(Boolean).length;
  if (timeFlags > 1) throw new UserError('Use either --in, --at or --clear-due, not several.');
  const positionalText = words.join(' ').trim();
  if (textFlag !== undefined && words.length > 0) {
    throw new UserError(`Give the new text either after the target or with --text, not both.\n${EDIT_USAGE}`);
  }
  const rawText = textFlag !== undefined ? String(textFlag).trim() : positionalText;
  if (textFlag !== undefined && rawText === '') throw new UserError('--text must not be empty.');
  if (rawText === '' && timeFlags === 0) {
    throw new UserError(`There is nothing to change: give new text and/or --in, --at or --clear-due.\n${EDIT_USAGE}`);
  }
  const patch: EditPatch = {};
  if (rawText !== '') patch.text = rawText;
  if (inFlag !== undefined) {
    let seconds: number;
    try {
      seconds = parseDuration(String(inFlag));
    } catch (err) {
      throw new UserError((err as Error).message);
    }
    const due = new Date(now.getTime() + seconds * 1000);
    if (!Number.isFinite(due.getTime())) throw new UserError('duration is too large');
    patch.due_at = due;
  } else if (at !== undefined) {
    const due = new Date(String(at));
    if (!ISO_WITH_ZONE_RE.test(String(at)) || Number.isNaN(due.getTime())) {
      throw new UserError(`Invalid --at "${String(at)}" (use an ISO time with a zone, such as 2026-10-01T09:00:00Z or 2026-10-01T11:00:00+02:00)`);
    }
    patch.due_at = due;
  } else if (clearDue === true) {
    patch.due_at = null;
  }
  return patch;
}

/**
 * `mokkan edit <n|id> [--all] [--in 2h | --at <iso> | --clear-due] [new text...]`: one PATCH, one edit.
 * The target is resolved to an id once. On a 409 stale the retry keeps that id; if a list number now points
 * at a different reminder, it stops instead of editing the wrong one.
 */
export async function editCommand(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length === 0) throw new UserError(EDIT_USAGE);
  const now = ctx.now();
  const patch = buildEditPatch(ctx, args.slice(1), now);
  const target: EditTarget | EditPrefix = POSITION_RE.test(args[0])
    ? { kind: 'number', n: Number(args[0]), scope: ctx.flags.all === true ? 'all' : 'active' }
    : { kind: 'prefix', prefix: args[0] };
  // Id prefixes match any non-done reminder (scheduled ones included); `all` has the same account-wide version.
  const scope = target.kind === 'number' ? target.scope : 'all';
  let list = await ctx.client.list(scope);
  const id = resolveEditTarget(list.reminders, target);
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await ctx.client.editReminder(id, patch, list.version);
      const r = res.reminder;
      ctx.io.stdout(ctx.json
        ? `${JSON.stringify(res)}\n`
        : `Edited [${shortId(r.id)}] ${r.text}${r.due_at ? ` (due ${r.due_at}, ${formatRelative(new Date(r.due_at), now)})` : ''}\n`);
      return 0;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_editable') {
        throw new UserError('This reminder was already shown or emailed, so --in/--at/--clear-due no longer apply (its text can still be edited).');
      }
      if (!(err instanceof ApiError && err.code === 'stale' && attempt === 0)) throw err;
    }
    list = await ctx.client.list(scope);
    if (target.kind === 'number') {
      const current = list.reminders[target.n - 1];
      if (current?.id !== id) throw new UserError(`The list changed; run ${listCommandName(target.scope)} and try again.`);
    }
  }
}
