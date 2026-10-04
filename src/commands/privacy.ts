import { ApiError } from '../client.js';
import { removeAccountFiles } from '../credentials.js';
import { UserError } from '../errors.js';
import { EXIT_PRIVACY_REQUIRED, formatPolicy, isPrivacyStale, terminalCommand } from '../privacy.js';
import type { Ctx } from '../cli.js';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `mokkan privacy [--json]`: no login needed. `--json` prints exactly `{version,url,summary}` (the pane reads it). */
export async function privacyCommand(ctx: Ctx): Promise<number> {
  const p = await ctx.client.privacy();
  ctx.io.stdout(ctx.json ? `${JSON.stringify({ version: p.version, url: p.url, summary: p.summary })}\n` : formatPolicy(p));
  return 0;
}

/**
 * The acceptance prompt (needs a terminal): after the gate stopped a command, and for `mokkan accept`. Returns null
 * once accepted, so the caller can run its command once more; otherwise the exit code: 4 for `n`, the delete flow's
 * for `d`, 2 when the policy changed again while it was shown a second time.
 */
export async function askToAccept(ctx: Ctx): Promise<number | null> {
  const { io, client } = ctx;
  for (let shown = 1; ; shown++) {
    const p = await client.privacy();
    io.stdout(formatPolicy(p));
    const answer = (await io.prompt('Accept? y accept · n quit · d delete my account ', false)).trim().toLowerCase();
    if (answer === 'd') return deleteAccountCommand(ctx);
    if (answer !== 'y') {
      io.stderr('Not accepted. Run mokkan accept when you are ready.\n');
      return EXIT_PRIVACY_REQUIRED;
    }
    try {
      await client.acceptPrivacy(p.version);
    } catch (err) {
      if (!isPrivacyStale(err)) throw err;
      if (shown === 2) {
        io.stderr('The privacy policy changed again while it was shown; try again later.\n');
        return 2;
      }
      io.stdout('The privacy policy has just changed. The new version:\n');
      continue;
    }
    io.stdout(`Accepted the privacy policy (version ${p.version}).\n`);
    return null;
  }
}

/**
 * `mokkan accept [--yes [--version <v>]]`. Without `--yes` it is the prompt, so it needs a terminal. `--yes` prints
 * the summary and accepts without asking; `--version` accepts only that version, so a policy that changed after the
 * pane showed it is a 409 (exit 4), never accepted unseen. Refused under `--exit-zero`: that is how Claude runs
 * mokkan (/mokkan, /mokkan-cli), and only the user accepts.
 */
export async function acceptCommand(ctx: Ctx): Promise<number> {
  const { io, client, flags } = ctx;
  const usage = 'Usage: mokkan accept [--yes [--version <v>]]';
  if (flags.version === '') throw new UserError(`--version needs a value.\n${usage}`);
  if (typeof flags.version === 'string' && flags.yes !== true) throw new UserError(`--version needs --yes.\n${usage}`);
  const inTerminal = `Accept the privacy policy in a terminal: ${terminalCommand('accept')}`;
  if (flags['exit-zero'] === true) throw new UserError(inTerminal);
  if (!client.hasCredentials()) throw new UserError('Not logged in. Run: mokkan login');
  if (flags.yes !== true) {
    if (!io.isTTY) throw new UserError(inTerminal);
    return (await askToAccept(ctx)) ?? 0;
  }
  const p = await client.privacy();
  const version = typeof flags.version === 'string' ? flags.version : p.version;
  io.stdout(formatPolicy(p));
  await client.acceptPrivacy(version);
  io.stdout(`Accepted the privacy policy (version ${version}).\n`);
  return 0;
}

/**
 * `mokkan delete-account`: terminal only (never through Claude, Codex or the pane). Says what goes, then asks for the
 * password and for the word `delete`. GET /me and DELETE /me pass the privacy gate, so this works either way.
 */
export async function deleteAccountCommand(ctx: Ctx): Promise<number> {
  const { io, client } = ctx;
  if (!io.isTTY) throw new UserError(`Run it in a terminal: ${terminalCommand('delete-account')}`);
  const me = await client.me();
  io.stdout(`This deletes ${me.email}, its ${plural(me.reminder_count, 'reminder')} and ${plural(me.credit_balance, 'unspent credit')}. Payment records are kept without your name.\n`);
  const password = await io.prompt('Password: ', true);
  const word = await io.prompt('Type delete to delete the account: ', false);
  if (word.trim() !== 'delete') throw new UserError('Not deleted.');
  try {
    await client.deleteAccount(password);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'wrong_password') throw new UserError('Wrong password. Nothing was deleted.');
    throw err;
  }
  removeAccountFiles(io.env);
  io.stdout('Account deleted.\n');
  return 0;
}
