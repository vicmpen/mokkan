import path from 'node:path';
import {
  assertRenderable, contextProblem, installedState, MARKER_TEXT, removeOurs, writeOurs, xdgConfigBase,
} from './files.js';
import type { AgentContext, AgentFile, AgentResult, NotifyAgent } from './types.js';

const MARKER = `# ${MARKER_TEXT}`;

/**
 * One argument of a desktop entry `Exec=` line. An argument with a reserved character is double-quoted, with `"`,
 * `` ` ``, `$` and `\` backslash-escaped inside the quotes. Then, because the string-value escapes are undone before
 * the Exec quoting, every `\` is doubled again; and `%` (field codes) becomes `%%`.
 */
export function desktopExecArg(text: string): string {
  let arg = text;
  if (text === '' || /[\s"'\\><~|&;$*?#()`]/.test(text)) arg = `"${text.replace(/["`$\\]/g, (c) => `\\${c}`)}"`;
  return arg.replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

function desktopPath(ctx: AgentContext): string {
  return path.join(xdgConfigBase(ctx.env), 'autostart', 'mokkan-notify.desktop');
}

function render(ctx: AgentContext): AgentFile[] {
  assertRenderable(ctx);
  const argv = [ctx.node, ctx.cli, 'notify', 'poll', '--loop'];
  if (ctx.xdgConfigHome !== undefined) argv.unshift('env', `XDG_CONFIG_HOME=${ctx.xdgConfigHome}`);
  const lines = [
    MARKER,
    '[Desktop Entry]',
    'Type=Application',
    'Name=mokkan notifications',
    `Exec=${argv.map(desktopExecArg).join(' ')}`,
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    '',
  ];
  return [{ path: desktopPath(ctx), content: lines.join('\n') }];
}

/**
 * `$XDG_CONFIG_HOME/autostart/mokkan-notify.desktop`, which runs `notify poll --loop` at login (for systems without
 * a systemd user manager). Install and remove only write and delete the file: nothing is started or stopped now.
 */
export const xdgAutostartAgent: NotifyAgent = {
  name: 'xdg-autostart',
  marker: MARKER,
  applies: (facts) => facts.agent === 'xdg-autostart',
  files: (ctx) => [desktopPath(ctx)],
  render,

  async install(ctx): Promise<AgentResult> {
    const messages: string[] = [];
    const problem = contextProblem(ctx);
    if (problem !== null) return { changed: false, messages: [`Not installed: ${problem}`] };
    const written = writeOurs(render(ctx), MARKER, messages);
    if (written === null || written.length === 0) return { changed: false, messages };
    messages.push('Notifications start at your next login.');
    return { changed: true, messages };
  },

  async remove(ctx): Promise<AgentResult> {
    const messages: string[] = [];
    const removed = removeOurs([desktopPath(ctx)], MARKER, messages);
    if (removed.length > 0) messages.push('A loop that is already running stops when you log out.');
    return { changed: removed.length > 0, messages };
  },

  installed: async (ctx) => installedState(ctx, [desktopPath(ctx)], render, MARKER),
};
