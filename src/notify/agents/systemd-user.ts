import path from 'node:path';
import {
  anyForeign, assertRenderable, commandFailure, contextProblem, fileState, installedState, MARKER_TEXT,
  removeOurs, writeOurs, xdgConfigBase,
} from './files.js';
import type { AgentContext, AgentFile, AgentResult, NotifyAgent } from './types.js';

export const SYSTEMD_SERVICE = 'mokkan-notify.service';
export const SYSTEMD_TIMER = 'mokkan-notify.timer';
const MARKER = `# ${MARKER_TEXT}`;

/**
 * A double-quoted systemd word: `\` and `"` are backslash-escaped, `%` (specifiers) becomes `%%`, and with
 * `dollar` (ExecStart=, which expands `$VAR`) `$` becomes `$$`. Environment= does not expand `$`.
 */
export function systemdQuote(text: string, dollar: boolean): string {
  let out = text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/%/g, '%%');
  if (dollar) out = out.replace(/\$/g, '$$$$');
  return `"${out}"`;
}

function unitDir(ctx: AgentContext): string {
  return path.join(xdgConfigBase(ctx.env), 'systemd', 'user');
}

function paths(ctx: AgentContext): string[] {
  return [path.join(unitDir(ctx), SYSTEMD_SERVICE), path.join(unitDir(ctx), SYSTEMD_TIMER)];
}

function render(ctx: AgentContext): AgentFile[] {
  assertRenderable(ctx);
  const [servicePath, timerPath] = paths(ctx);
  const service = [
    MARKER,
    '[Unit]',
    'Description=mokkan reminder notifications',
    '',
    '[Service]',
    'Type=oneshot',
    ...(ctx.xdgConfigHome === undefined ? [] : [`Environment=${systemdQuote(`XDG_CONFIG_HOME=${ctx.xdgConfigHome}`, false)}`]),
    `ExecStart=${systemdQuote(ctx.node, true)} ${systemdQuote(ctx.cli, true)} notify poll`,
    '',
  ];
  const timer = [
    MARKER,
    '[Unit]',
    'Description=mokkan reminder notifications',
    '',
    '[Timer]',
    'OnBootSec=1min',
    `OnUnitActiveSec=${ctx.interval}s`,
    'AccuracySec=10s',
    `Unit=${SYSTEMD_SERVICE}`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ];
  return [{ path: servicePath, content: service.join('\n') }, { path: timerPath, content: timer.join('\n') }];
}

function systemctl(ctx: AgentContext, args: string[]) {
  // Over SSH XDG_RUNTIME_DIR may be unset, and systemctl --user finds the user manager through it.
  const env = { ...ctx.env, XDG_RUNTIME_DIR: ctx.env.XDG_RUNTIME_DIR || `/run/user/${ctx.uid}` };
  return ctx.spawn('systemctl', ['--user', ...args], { env });
}

/**
 * `mokkan-notify.service` (oneshot) and `mokkan-notify.timer` in the systemd user unit directory, which honours
 * `XDG_CONFIG_HOME`. Install reloads the manager, enables the timer and restarts it (so a new interval applies); unchanged files only check that it is on.
 */
export const systemdUserAgent: NotifyAgent = {
  name: 'systemd-user',
  marker: MARKER,
  applies: (facts) => facts.agent === 'systemd-user',
  files: paths,
  render,

  async install(ctx): Promise<AgentResult> {
    const messages: string[] = [];
    const problem = contextProblem(ctx);
    if (problem !== null) return { changed: false, messages: [`Not installed: ${problem}`] };
    const files = render(ctx);
    if (files.every((f) => fileState(f, MARKER) === 'same')) {
      const enabled = (await systemctl(ctx, ['is-enabled', '--quiet', SYSTEMD_TIMER])).code === 0;
      if (enabled && (await systemctl(ctx, ['is-active', '--quiet', SYSTEMD_TIMER])).code === 0) {
        return { changed: false, messages };
      }
    }
    const written = writeOurs(files, MARKER, messages);
    if (written === null) return { changed: false, messages };
    const reload = await systemctl(ctx, ['daemon-reload']);
    if (reload.code !== 0) messages.push(commandFailure('systemctl --user daemon-reload', reload));
    // `restart`, not `enable --now`: a timer that is already running keeps its old interval until it restarts.
    const enable = await systemctl(ctx, ['enable', SYSTEMD_TIMER]);
    if (enable.code !== 0) {
      messages.push(commandFailure(`systemctl --user enable ${SYSTEMD_TIMER}`, enable));
      return { changed: written.length > 0, messages };
    }
    const restart = await systemctl(ctx, ['restart', SYSTEMD_TIMER]);
    if (restart.code === 0) messages.push(`Enabled and started ${SYSTEMD_TIMER}`);
    else messages.push(commandFailure(`systemctl --user restart ${SYSTEMD_TIMER}`, restart));
    return { changed: true, messages };
  },

  async remove(ctx): Promise<AgentResult> {
    const messages: string[] = [];
    const files = paths(ctx);
    // A foreign timer with our name is someone else's: leave it running.
    let disabled = false;
    if (!anyForeign([files[1]], MARKER)) {
      disabled = (await systemctl(ctx, ['disable', '--now', SYSTEMD_TIMER])).code === 0;
      if (disabled) messages.push(`Disabled and stopped ${SYSTEMD_TIMER}`);
    }
    const removed = removeOurs(files, MARKER, messages);
    if (removed.length > 0) {
      const reload = await systemctl(ctx, ['daemon-reload']);
      if (reload.code !== 0) messages.push(commandFailure('systemctl --user daemon-reload', reload));
    }
    return { changed: disabled || removed.length > 0, messages };
  },

  installed: async (ctx) => installedState(ctx, paths(ctx), render, MARKER),
};
