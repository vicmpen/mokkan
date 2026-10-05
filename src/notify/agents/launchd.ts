import path from 'node:path';
import {
  assertRenderable, commandFailure, contextProblem, fileState, foreignMessage, homeOf, installedState, MARKER_TEXT, removeOurs, writeOurs,
} from './files.js';
import type { AgentContext, AgentFile, AgentResult, NotifyAgent } from './types.js';

export const LAUNCHD_LABEL = 'dev.mokkan.notify';

/**
 * launchd starts agents with PATH=/usr/bin:/bin:/usr/sbin:/sbin, where Homebrew's terminal-notifier is not found, so
 * the agent's polls would use osascript although setup tested terminal-notifier. Fixed, so `status` run from any
 * shell renders the same plist.
 */
export const LAUNCHD_PATH = '/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const MARKER = `<!-- ${MARKER_TEXT} -->`;

const XML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Escapes text for an XML element: `& < > " '`. */
export function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ENTITIES[c]);
}

function plistPath(ctx: AgentContext): string {
  return path.join(homeOf(ctx.env), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function render(ctx: AgentContext): AgentFile[] {
  assertRenderable(ctx);
  const str = (s: string) => `<string>${xmlEscape(s)}</string>`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    MARKER,
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${str(LAUNCHD_LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[ctx.node, ctx.cli, 'notify', 'poll'].map((a) => `    ${str(a)}`),
    '  </array>',
  ];
  lines.push('  <key>EnvironmentVariables</key>', '  <dict>', '    <key>PATH</key>', `    ${str(LAUNCHD_PATH)}`);
  if (ctx.xdgConfigHome !== undefined) lines.push('    <key>XDG_CONFIG_HOME</key>', `    ${str(ctx.xdgConfigHome)}`);
  lines.push('  </dict>');
  lines.push(
    '  <key>StartInterval</key>',
    `  <integer>${ctx.interval}</integer>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    `  ${str('Background')}`,
    '  <key>StandardOutPath</key>',
    `  ${str('/dev/null')}`,
    '  <key>StandardErrorPath</key>',
    `  ${str('/dev/null')}`,
    '</dict>',
    '</plist>',
    '',
  );
  return [{ path: plistPath(ctx), content: lines.join('\n') }];
}

const domain = (ctx: AgentContext) => `gui/${ctx.uid}`;
const service = (ctx: AgentContext) => `${domain(ctx)}/${LAUNCHD_LABEL}`;
const launchctl = (ctx: AgentContext, args: string[]) => ctx.spawn('launchctl', args, { env: ctx.env });

/**
 * `~/Library/LaunchAgents/dev.mokkan.notify.plist`, run every `interval` seconds and at load. Install boots out a
 * loaded copy first ("not loaded" is fine), since bootstrap refuses a label that is already loaded.
 */
export const launchdAgent: NotifyAgent = {
  name: 'launchd',
  marker: MARKER,
  applies: (facts) => facts.agent === 'launchd',
  files: (ctx) => [plistPath(ctx)],
  render,

  async install(ctx): Promise<AgentResult> {
    const messages: string[] = [];
    const problem = contextProblem(ctx);
    if (problem !== null) return { changed: false, messages: [`Not installed: ${problem}`] };
    const files = render(ctx);
    const unchanged = fileState(files[0], MARKER) === 'same';
    if (unchanged && (await launchctl(ctx, ['print', service(ctx)])).code === 0) return { changed: false, messages };
    const written = writeOurs(files, MARKER, messages);
    if (written === null) return { changed: false, messages };
    await launchctl(ctx, ['bootout', service(ctx)]);
    const r = await launchctl(ctx, ['bootstrap', domain(ctx), files[0].path]);
    if (r.code === 0) messages.push(`Loaded ${service(ctx)}`);
    else messages.push(commandFailure(`launchctl bootstrap ${domain(ctx)}`, r));
    return { changed: written.length > 0 || r.code === 0, messages };
  },

  async remove(ctx): Promise<AgentResult> {
    const messages: string[] = [];
    const file = plistPath(ctx);
    const state = fileState({ path: file, content: '' }, MARKER);
    if (state === 'foreign') return { changed: false, messages: [foreignMessage(file)] };
    // Unload even when the file is already gone: a loaded job outlives its plist.
    const unloaded = (await launchctl(ctx, ['bootout', service(ctx)])).code === 0;
    if (unloaded) messages.push(`Unloaded ${service(ctx)}`);
    const removed = removeOurs([file], MARKER, messages);
    return { changed: unloaded || removed.length > 0, messages };
  },

  installed: async (ctx) => installedState(ctx, [plistPath(ctx)], render, MARKER),
};
