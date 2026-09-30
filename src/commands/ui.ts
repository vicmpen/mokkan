import type { Ctx } from '../cli.js';
import { UserError } from '../errors.js';
import { TuiApp } from '../tui/app.js';
import { runTerminal } from '../tui/terminal.js';

/**
 * `mokkan ui`: the full-screen dashboard. Needs a real terminal (from /mokkan:mokkan there is none, and the
 * message is all the user sees). Without credentials it opens on the login screen; the client saves credentials
 * on login and clears them on session expiry, so no credential handling lives here.
 */
export async function uiCommand(ctx: Ctx): Promise<number> {
  const { io, client } = ctx;
  if (!io.isTTY || !io.tty) throw new UserError('mokkan ui needs an interactive terminal.');
  const app = new TuiApp({
    client, email: client.email, host: new URL(client.baseUrl).host, now: ctx.now, openUrl: io.openUrl,
  });
  return runTerminal(app, io, io.tty);
}
