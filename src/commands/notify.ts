import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import path from 'node:path';
import { CredentialsCorruptError, CredentialsPermissionError, loadCredentials, notifyStateDir, removeNotifyState, type Credentials } from '../credentials.js';
import { UserError } from '../errors.js';
import { appendHookLogHourly, safeAppendHookLog } from '../hooks.js';
import type { Spawner } from '../spawn.js';
import { VERSION } from '../version.js';
import { AGENTS, agentFor, type AgentContext, type AgentInstallState, type NotifyAgent } from '../notify/agents/index.js';
import { BACKENDS } from '../notify/backends/index.js';
import { configFilePath, loadNotifyConfig, saveNotifyConfig, type NotifyConfig, type OscMode } from '../notify/config.js';
import { detectPlatform, makeProbe, osOf, type AgentKind, type PlatformFacts, type Probe } from '../notify/detect.js';
import { NOTIFIER_TIMEOUT_MS, pollLoop, pollOnce, readLastPoll, type LastPoll, type PollClient, type PollDeps } from '../notify/poll.js';
import {
  ensureInitScripts, RC_BEGIN, RC_END, SHELLS, shellByName, shellFromEnv, type NotifyShell, type ShellName, type SnippetOptions,
} from '../notify/shells/index.js';
import { writeStateFile } from '../notify/state.js';
import { upsertBlock, removeBlock } from '../rcfile.js';
import type { CliIO } from '../cli.js';

/**
 * What the notify commands need to know about the running process, resolved in one place (`resolveNotifyEnv`) so
 * tests can fake every part through `CliIO.notify` without touching `process`.
 */
export interface NotifyEnv {
  /** Absolute node binary baked into the agent and the shell snippet (`stableNode`). */
  node: string;
  /** The realpath of the running cli.js (or the plugin's bundled mokkan.mjs). */
  cli: string;
  uid: number;
  platform: NodeJS.Platform;
  /** Only for `doctor`, which redacts it. */
  hostname: string;
}

/**
 * The node to bake in: the first `node` on PATH when it is the running binary, else `process.execPath`. A PATH entry
 * such as /opt/homebrew/bin/node or ~/.local/bin/node is a symlink that survives upgrades; the binary it points to
 * (a versioned Homebrew Cellar path) does not (the rule U16 had for the status line).
 */
export function stableNode(execPath: string, pathVar: string | undefined): string {
  let target: string;
  try { target = realpathSync(execPath); } catch { return execPath; }
  for (const dir of (pathVar ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'node');
    try {
      if (realpathSync(candidate) === target) return candidate;
    } catch { /* not here */ }
  }
  return execPath;
}

export function resolveNotifyEnv(io: CliIO): NotifyEnv {
  const given = io.notify ?? {};
  const cli = given.cli ?? process.argv[1] ?? '';
  let real = cli;
  try { real = realpathSync(cli); } catch { /* keep the path as given */ }
  return {
    node: given.node ?? stableNode(process.execPath, io.env.PATH),
    cli: real,
    uid: given.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0),
    platform: given.platform ?? process.platform,
    hostname: given.hostname ?? osHostname(),
  };
}

/** The flags and IO of a notify command; it needs no client (only `poll` talks to the server). */
export interface NotifyCtx {
  io: CliIO;
  json: boolean;
  flags: Record<string, string | boolean>;
}

const NOTIFY_USAGE = 'Usage: mokkan notify setup [--yes] | remove | on|off [shell|desktop|osc] | status [--json] | test | doctor';
const SHELL_USAGE = 'Usage: mokkan shell init zsh|bash|fish';
const TEST_TITLE = 'mokkan';
const TEST_BODY = 'test notification';
/** The first line of the fish conf.d drop-in (`fish.rcLine()`). */
const DROP_IN_MARKER = '# managed by mokkan';
/** Commands that exist on PATH for the desktop backends, listed by `doctor`. */
const NOTIFIER_BINARIES = ['terminal-notifier', 'notify-send', 'gdbus', 'kdialog'];

const missingSpawner: Spawner = async () => ({ code: null, stdout: '', stderr: '', error: 'ENOENT' });
const spawnOf = (io: CliIO): Spawner => io.spawn ?? missingSpawner;

/**
 * The running CLI lives where an update replaces it (the Claude plugin cache, npm's `_npx` cache): a path baked into
 * the agent or the shell snippet would break with the next update.
 */
export function isUnstableCliPath(cli: string): boolean {
  const p = `${cli.split(path.sep).join('/')}`;
  return p.includes('/plugins/cache/') || p.includes('/.claude/plugins/') || p.includes('/_npx/');
}

function unstableMessage(cli: string): string {
  return [
    `mokkan is running from ${cli}, which changes with every update (the Claude plugin cache or npx).`,
    'The prompt hook and the background agent need a stable path. Install mokkan first:',
    '  npm i -g @vicmpen/mokkan-cli   (or install.sh, which links ~/.local/bin/mokkan)',
    'then run it in a terminal: mokkan notify setup',
  ].join('\n');
}

/** `setup` and `remove` change rc files and install services: only the user, in a terminal (never /mokkan). */
function refuseOutsideTerminal(ctx: NotifyCtx, sub: 'setup' | 'remove'): void {
  if (ctx.flags['exit-zero'] === true || !ctx.io.isTTY) throw new UserError(`Run it in a terminal: mokkan notify ${sub}`);
}

/** The settings in config.json, ignoring `MOKKAN_NOTIFY=0` (which only silences this environment). */
function fileConfig(env: NodeJS.ProcessEnv): ReturnType<typeof loadNotifyConfig> {
  return loadNotifyConfig({ ...env, MOKKAN_NOTIFY: undefined });
}

/** Saves `patch` only when it changes something, so a repeated setup leaves config.json untouched. */
function saveIfChanged(env: NodeJS.ProcessEnv, patch: Partial<NotifyConfig>): boolean {
  const current = fileConfig(env).config;
  const changes = (Object.keys(patch) as Array<keyof NotifyConfig>).some((k) => patch[k] !== current[k]);
  if (!changes) return false;
  saveNotifyConfig(env, patch);
  return true;
}

function homeOf(env: NodeJS.ProcessEnv): string | null {
  const h = env.HOME;
  return h && h.length > 1 ? h.replace(/\/+$/, '') : null;
}

/** `path` with the home directory shown as `~`, for messages. */
function tilde(env: NodeJS.ProcessEnv, p: string): string {
  const home = homeOf(env);
  if (home === null) return p;
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function readOrNull(file: string): string | null {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

async function ask(io: CliIO, question: string, yes: boolean, defaultYes = false): Promise<boolean> {
  if (yes) {
    io.stdout(`${question}y (--yes)\n`);
    return true;
  }
  const answer = (await io.prompt(question, false)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function snippetOptions(paths: { node: string; cli: string }, config: NotifyConfig): SnippetOptions {
  return { node: paths.node, cli: paths.cli, version: VERSION, interval: config.interval, osc: config.osc };
}

function agentContext(env: NodeJS.ProcessEnv, spawn: Spawner, ne: NotifyEnv, interval: number, paths: { node: string; cli: string } = ne): AgentContext {
  const ctx: AgentContext = { env, spawn, uid: ne.uid, node: paths.node, cli: paths.cli, interval };
  if (env.XDG_CONFIG_HOME) ctx.xdgConfigHome = env.XDG_CONFIG_HOME;
  return ctx;
}

async function detect(io: CliIO, ne: NotifyEnv): Promise<{ facts: PlatformFacts; probe: Probe }> {
  const probe = makeProbe(spawnOf(io), io.env, ne.uid);
  return { facts: await detectPlatform(io.env, ne.platform, ne.uid, probe), probe };
}

// ---------------------------------------------------------------------------------------------------------------
// Baked paths: the node and cli.js an init file or an agent runs.

function shWords(text: string): string[] {
  const words: string[] = [];
  let i = text.indexOf("'");
  while (i !== -1) {
    let word = '';
    for (;;) {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return words;
      word += text.slice(i + 1, end);
      i = end + 1;
      if (!text.startsWith("\\''", i)) break;
      word += "'";
      i += 2;
    }
    words.push(word);
    i = text.indexOf("'", i);
  }
  return words;
}

function fishWords(text: string): string[] {
  const words: string[] = [];
  let i = text.indexOf("'");
  while (i !== -1) {
    let word = '';
    let j = i + 1;
    for (; j < text.length && text[j] !== "'"; j++) {
      if (text[j] === '\\' && (text[j + 1] === '\\' || text[j + 1] === "'")) j++;
      word += text[j];
    }
    if (j >= text.length) return words;
    words.push(word);
    i = text.indexOf("'", j + 1);
  }
  return words;
}

/** The node and cli paths baked into a generated `init.<shell>` (from its `notify poll` line), or null. */
export function bakedPathsOf(shell: ShellName, script: string): { node: string; cli: string } | null {
  const line = script.split('\n').find((l) => l.includes(' notify poll'));
  if (line === undefined) return null;
  const head = line.slice(0, line.indexOf(' notify poll'));
  const words = shell === 'fish' ? fishWords(head) : shWords(head);
  return words.length >= 2 ? { node: words[words.length - 2]!, cli: words[words.length - 1]! } : null;
}

function bakedInits(env: NodeJS.ProcessEnv): Array<{ shell: NotifyShell; file: string; paths: { node: string; cli: string } | null }> {
  const out = [];
  for (const shell of SHELLS) {
    const file = shell.initFile(env);
    const text = readOrNull(file);
    if (text !== null) out.push({ shell, file, paths: bakedPathsOf(shell.name, text) });
  }
  return out;
}

/**
 * Regenerates the init scripts that exist. The paths come from this process unless it runs from an unstable
 * location (/mokkan runs the plugin's copy): then each file keeps the paths already baked into it.
 */
function regenerateInits(env: NodeJS.ProcessEnv, ne: NotifyEnv, config: NotifyConfig): ShellName[] {
  const rewritten: ShellName[] = [];
  for (const { shell, paths } of bakedInits(env)) {
    const use = isUnstableCliPath(ne.cli) ? paths : ne;
    if (use === null) continue;
    rewritten.push(...ensureInitScripts(env, snippetOptions(use, config), [shell]));
  }
  return rewritten;
}

interface AgentReport {
  name: AgentKind;
  installed: AgentInstallState;
  /** The node and cli its files run, when they match what mokkan renders for some known pair of paths. */
  baked: { node: string; cli: string } | null;
}

/** The agent's state, judged against this process's paths and those baked into the init files. */
async function agentReport(agent: NotifyAgent, io: CliIO, ne: NotifyEnv, interval: number): Promise<AgentReport> {
  const env = io.env;
  const spawn = spawnOf(io);
  const candidates = [{ node: ne.node, cli: ne.cli }, ...bakedInits(env).flatMap((b) => (b.paths === null ? [] : [b.paths]))];
  for (const c of candidates) {
    const ctx = agentContext(env, spawn, ne, interval, c);
    let files;
    try { files = agent.render(ctx); } catch { continue; }
    if (files.every((f) => readOrNull(f.path) === f.content)) return { name: agent.name, installed: await agent.installed(ctx), baked: c };
  }
  return { name: agent.name, installed: await agent.installed(agentContext(env, spawn, ne, interval)), baked: null };
}

// ---------------------------------------------------------------------------------------------------------------
// Shell hook files.

/** The rc files a block may be in: the platform's choice and the other one (bash on macOS may use either). */
function rcCandidates(shell: NotifyShell, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return [...new Set([shell.rcFile(env, platform), shell.rcFile(env, 'linux'), shell.rcFile(env, 'darwin')])];
}

function hasRcBlock(file: string): boolean {
  const text = readOrNull(file);
  return text !== null && text.split('\n').some((l) => l.trimEnd() === RC_BEGIN);
}

/** Where this shell's hook is installed, or null. */
function hookFile(shell: NotifyShell, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (shell.installStyle === 'drop-in') {
    const file = shell.rcFile(env, platform);
    return readOrNull(file)?.startsWith(DROP_IN_MARKER) === true ? file : null;
  }
  return rcCandidates(shell, env, platform).find(hasRcBlock) ?? null;
}

/** Writes the fish drop-in when it is missing or ours and different; refuses a file without the marker. */
function writeDropIn(file: string, content: string): 'created' | 'updated' | 'unchanged' | 'foreign' {
  const current = readOrNull(file);
  if (current === content) return 'unchanged';
  if (current !== null && !current.startsWith(DROP_IN_MARKER)) return 'foreign';
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o644 });
  return current === null ? 'created' : 'updated';
}

/** Writes `init.<shell>` when its content would change. */
function writeInit(env: NodeJS.ProcessEnv, shell: NotifyShell, opts: SnippetOptions): boolean {
  const content = shell.snippet(opts);
  if (readOrNull(shell.initFile(env)) === content) return false;
  writeStateFile(env, path.basename(shell.initFile(env)), content);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Desktop test notifications.

function failureDetail(r: { code: number | null; stderr: string; error?: string }): string {
  return r.stderr.trim().split('\n')[0] || r.error || `exit code ${r.code}`;
}

/**
 * Sends the test notification through each backend in turn. `ask`: asks after each one that ran and stops at the
 * first yes; `first`: stops at the first that exits 0; `all`: runs every one. Returns whether one was seen (ask) or
 * succeeded (first, all).
 */
async function sendTest(io: CliIO, names: string[], mode: 'ask' | 'first' | 'all'): Promise<boolean> {
  const spawn = spawnOf(io);
  let ok = false;
  for (const name of names) {
    const backend = BACKENDS.find((b) => b.name === name);
    if (backend === undefined) continue;
    const { file, args } = backend.command(TEST_TITLE, TEST_BODY);
    const r = await spawn(file, args, { timeoutMs: NOTIFIER_TIMEOUT_MS, env: io.env });
    if (r.code !== 0) {
      io.stdout(`  ${name}: failed (${failureDetail(r)})\n`);
      continue;
    }
    io.stdout(`  ${name}: sent "${TEST_TITLE}: ${TEST_BODY}"\n`);
    if (mode === 'ask') {
      if (await ask(io, 'Did you see it? [Y/n] ', false, true)) return true;
      continue;
    }
    ok = true;
    if (mode === 'first') return true;
  }
  return ok;
}

function notSeenHint(os: PlatformFacts['os']): string {
  return os === 'macos'
    ? 'No notification appeared. Allow notifications for Script Editor in System Settings → Notifications, or install terminal-notifier: brew install terminal-notifier\n'
    : 'No notification appeared. Is a notification daemon running? Run mokkan notify doctor to see what mokkan detects.\n';
}

/** The OSC sequence for `osc` (auto picks from TERM/TERM_PROGRAM, as the snippets do), tmux-wrapped inside tmux. */
export function oscSequence(osc: Exclude<OscMode, 'off'>, env: NodeJS.ProcessEnv, text: string): string {
  const ESC = '\x1b';
  const BEL = '\x07';
  let mode = osc;
  if (mode === 'auto') {
    mode = '9';
    if (env.TERM_PROGRAM === 'kitty') mode = '99';
    else if ((env.TERM_PROGRAM ?? '').startsWith('foot')) mode = '777';
    if (env.TERM === 'xterm-kitty') mode = '99';
    else if ((env.TERM ?? '').startsWith('foot')) mode = '777';
  }
  const seq = mode === '99' ? `${ESC}]99;;${text}${ESC}\\` : mode === '777' ? `${ESC}]777;notify;mokkan;${text}${BEL}` : `${ESC}]9;${text}${BEL}`;
  return env.TMUX ? `${ESC}Ptmux;${seq.split(ESC).join(ESC + ESC)}${ESC}\\` : seq;
}

// ---------------------------------------------------------------------------------------------------------------
// setup

async function setupCommand(ctx: NotifyCtx, ne: NotifyEnv): Promise<number> {
  const { io, flags } = ctx;
  const env = io.env;
  const yes = flags.yes === true;
  refuseOutsideTerminal(ctx, 'setup');
  if (isUnstableCliPath(ne.cli)) throw new UserError(unstableMessage(ne.cli));
  const loaded = fileConfig(env);
  if (loaded.disabledBy === 'corrupt') throw new UserError(`${loaded.problem}. Fix or delete it, then run mokkan notify setup again.`);
  const shell = shellFromEnv(env);
  const { facts } = await detect(io, ne);
  const agent = agentFor(facts);
  const config = loaded.config;
  const where = facts.ssh ? " (they appear on this machine's screen; you are connected over SSH)" : '';

  const plan = ['mokkan notify setup: shows fired, unacknowledged scheduled reminders (mokkan in ...) outside Claude Code.'];
  plan.push(`  CLI: ${ne.cli} (node ${ne.node})`);
  if (shell !== null) {
    const file = shell.rcFile(env, ne.platform);
    plan.push(shell.installStyle === 'drop-in'
      ? `  1. Prompt hook for ${shell.name}: ${tilde(env, file)} sources ${tilde(env, shell.initFile(env))}`
      : `  1. Prompt hook for ${shell.name}: a marked block in ${tilde(env, file)} sources ${tilde(env, shell.initFile(env))}`);
  } else {
    plan.push(`  1. Prompt hook: not available for SHELL=${env.SHELL ?? '(unset)'} (zsh, bash and fish are supported)`);
  }
  if (facts.gui) {
    plan.push(`  2. Desktop notifications on this machine${where}, through ${facts.backends[0] ?? 'no notifier found'}`);
    if (agent !== null) plan.push(`  3. A background agent (${agent.name}) that checks every ${config.interval} s, so they arrive without a terminal open`);
    plan.push('  4. A test notification');
  } else {
    plan.push(`  No desktop notifications or background agent: ${facts.wsl ? 'WSL has no desktop backend in mokkan' : 'no graphical session found here'}. The prompt hook covers this machine.`);
  }
  if (env.SSH_CONNECTION) plan.push('  5. Over SSH: a terminal escape (OSC) so the terminal on your own computer can show a notification');
  plan.push('Each step asks first.', '');
  io.stdout(plan.join('\n'));

  const changes: string[] = [];
  let hookChanged = false;

  // 1. The prompt hook.
  let hookShell: NotifyShell | null = null;
  if (shell !== null && await ask(io, `Add the prompt hook for ${shell.name}? [y/N] `, yes)) {
    // init.<shell> itself is written at the end, with the settings chosen below; the rc line checks it is readable.
    hookShell = shell;
    const file = shell.rcFile(env, ne.platform);
    if (shell.installStyle === 'drop-in') {
      const r = writeDropIn(file, shell.rcLine());
      if (r === 'foreign') io.stdout(`  ${file} exists and is not mokkan's; left alone. Add this to your fish config instead:\n${shell.rcLine()}`);
      else if (r !== 'unchanged') { changes.push(`${r} ${tilde(env, file)} (sources init.fish)`); hookChanged = true; }
    } else {
      const r = upsertBlock(file, RC_BEGIN, RC_END, shell.rcLine(), io.now());
      if (r.action !== 'unchanged') {
        changes.push(`${r.action === 'created' ? 'created' : 'added the hook to'} ${tilde(env, file)}${r.action === 'created' ? ' with the hook' : ''}${r.backup ? ` (backup: ${tilde(env, r.backup)})` : ''}`);
        hookChanged = true;
      }
    }
  }

  // 2. mokkan's own consent for desktop notifications.
  let desktop = config.desktop;
  if (facts.gui) {
    desktop = await ask(io, `Show desktop notifications on this machine${where}? [y/N] `, yes);
    if (saveIfChanged(env, { desktop })) changes.push(`desktop notifications ${desktop ? 'on' : 'off'} in ${tilde(env, configFilePath(env))}`);
  }

  // 3. The background agent.
  if (agent !== null && await ask(io, `Install the background agent (${agent.name}, every ${config.interval} s)? [y/N] `, yes)) {
    const r = await agent.install(agentContext(env, spawnOf(io), ne, config.interval));
    for (const m of r.messages) io.stdout(`  ${tilde(env, m)}\n`);
    if (r.changed) changes.push(`installed the ${agent.name} agent`);
  }

  // 4. The test notification: the only way to learn whether the OS shows them (macOS can block them silently).
  if (facts.gui && desktop) {
    if (facts.backends.length === 0) {
      io.stdout(facts.os === 'macos' ? '  No notifier found.\n' : '  No notifier found: install notify-send (libnotify) and run mokkan notify test.\n');
    } else if (await ask(io, 'Send a test notification? [y/N] ', yes)) {
      const seen = await sendTest(io, facts.backends, yes ? 'first' : 'ask');
      if (!seen) io.stdout(notSeenHint(facts.os));
    }
  }

  // 5. OSC over SSH: opt-in, so --yes leaves it as it is.
  if (env.SSH_CONNECTION) {
    const current = fileConfig(env).config.osc;
    if (yes) {
      io.stdout(`Terminal escapes over SSH stay ${current} (--yes does not turn them on; run mokkan notify on osc).\n`);
    } else {
      const on = await ask(io, 'Over SSH, also send a terminal escape (OSC 9/777/99) so your local terminal can show a notification? [y/N] ', false);
      const osc: OscMode = on ? (current === 'off' ? 'auto' : current) : 'off';
      if (saveIfChanged(env, { osc })) changes.push(`terminal escapes over SSH ${osc === 'off' ? 'off' : `on (${osc})`}`);
    }
  }

  // The generated scripts follow the settings chosen above.
  const final = fileConfig(env).config;
  if (hookShell !== null && writeInit(env, hookShell, snippetOptions(ne, final))) changes.push(`wrote ${tilde(env, hookShell.initFile(env))}`);
  for (const name of regenerateInits(env, ne, final)) changes.push(`regenerated init.${name}`);

  if (changes.length === 0) {
    io.stdout('Nothing changed: notifications were already set up this way.\n');
  } else {
    io.stdout(`Changed:\n${changes.map((c) => `  - ${c}\n`).join('')}`);
  }
  if (hookChanged) io.stdout('Reload your shell to start the prompt hook: exec $SHELL (or open a new terminal).\n');
  if (env.MOKKAN_NOTIFY === '0') io.stdout('Note: MOKKAN_NOTIFY=0 is set here, which turns every notification off.\n');
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// remove

async function removeCommand(ctx: NotifyCtx, ne: NotifyEnv): Promise<number> {
  const { io } = ctx;
  const env = io.env;
  refuseOutsideTerminal(ctx, 'remove');
  const lines: string[] = [];
  const warnings: string[] = [];
  for (const shell of SHELLS) {
    if (shell.installStyle === 'drop-in') {
      const file = shell.rcFile(env, ne.platform);
      const text = readOrNull(file);
      if (text === null) continue;
      if (!text.startsWith(DROP_IN_MARKER)) { warnings.push(`${tilde(env, file)} exists and is not mokkan's; left alone`); continue; }
      unlinkSync(file);
      lines.push(`removed ${tilde(env, file)}`);
      continue;
    }
    for (const file of rcCandidates(shell, env, ne.platform)) {
      try {
        const r = removeBlock(file, RC_BEGIN, RC_END, io.now());
        if (r.action === 'removed') lines.push(`removed the hook from ${tilde(env, file)}${r.backup ? ` (backup: ${tilde(env, r.backup)})` : ''}`);
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
        warnings.push(err.message);
      }
    }
  }

  const interval = fileConfig(env).config.interval;
  const actx = agentContext(env, spawnOf(io), ne, interval);
  for (const agent of AGENTS) {
    // A launchd job can stay loaded after its plist is gone, so on macOS launchd is always asked.
    const present = agent.files(actx).some((f) => existsSync(f)) || (agent.name === 'launchd' && osOf(ne.platform) === 'macos');
    if (!present) continue;
    const r = await agent.remove(actx);
    for (const m of r.messages) (/not mokkan's|failed/.test(m) ? warnings : lines).push(tilde(env, m));
  }

  const dir = notifyStateDir(env);
  if (existsSync(dir)) {
    removeNotifyState(env);
    for (const name of readdirSync(dir)) {
      if (name.startsWith('init.')) { rmSync(path.join(dir, name), { force: true }); lines.push(`removed ${tilde(env, path.join(dir, name))}`); }
    }
    try { rmdirSync(dir); } catch { /* not empty: something else lives there */ }
  }

  io.stdout(lines.length > 0 ? `Removed:\n${lines.map((l) => `  - ${l}\n`).join('')}` : 'Nothing to remove: notifications were not set up.\n');
  for (const w of warnings) io.stdout(`Warning: ${w}\n`);
  if (existsSync(configFilePath(env))) io.stdout(`Kept your settings in ${tilde(env, configFilePath(env))}.\n`);
  if (lines.some((l) => l.includes('hook from') || l.endsWith('mokkan.fish'))) io.stdout('Open shells keep the hook until they restart: exec $SHELL (or open a new terminal).\n');
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// on / off

const CHANNELS = ['shell', 'desktop', 'osc'] as const;
type Channel = typeof CHANNELS[number];

function describeConfig(c: NotifyConfig): string {
  return `shell ${c.shell ? 'on' : 'off'}, desktop ${c.desktop ? 'on' : 'off'}, osc ${c.osc}, every ${c.interval} s`;
}

async function onOffCommand(ctx: NotifyCtx, ne: NotifyEnv, on: boolean, args: string[]): Promise<number> {
  const { io } = ctx;
  const env = io.env;
  if (args.length > 1 || (args.length === 1 && !(CHANNELS as readonly string[]).includes(args[0]!))) {
    throw new UserError(`Usage: mokkan notify ${on ? 'on' : 'off'} [shell|desktop|osc]`);
  }
  const channels: readonly Channel[] = args.length === 1 ? [args[0] as Channel] : CHANNELS;
  const current = fileConfig(env).config;
  const patch: Partial<NotifyConfig> = {};
  for (const c of channels) {
    if (c === 'osc') patch.osc = on ? (current.osc === 'off' ? 'auto' : current.osc) : 'off';
    else patch[c] = on;
  }
  const next = saveNotifyConfig(env, patch);
  const rewritten = regenerateInits(env, ne, next);
  if (ctx.json) {
    io.stdout(`${JSON.stringify({ notifications: next, regenerated: rewritten })}\n`);
    return 0;
  }
  io.stdout(`Notifications: ${describeConfig(next)}.\n`);
  if (rewritten.length > 0) io.stdout(`Regenerated ${rewritten.map((n) => `init.${n}`).join(', ')}.\n`);
  if (env.MOKKAN_NOTIFY === '0') io.stdout('Note: MOKKAN_NOTIFY=0 is set here, which turns every notification off.\n');
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// status

/**
 * `mokkan notify status --json`. A stable shape: fields may be added, never renamed or removed.
 */
export interface NotifyStatusJson {
  /** The CLI version. */
  version: string;
  /** The effective settings: everything off when `disabledBy` is set. */
  config: NotifyConfig;
  /** `env`: MOKKAN_NOTIFY=0 in this environment; `corrupt`: config.json is unreadable (see `problem`). */
  disabledBy: 'env' | 'corrupt' | null;
  problem: string | null;
  /** Absolute path of config.json (it may not exist). */
  configFile: string;
  /** Every supported shell: whether its rc block (or fish drop-in) is in place, and whether init.<shell> exists. */
  shells: Array<{ name: ShellName; rcFile: string; hook: boolean; initFile: string; init: boolean }>;
  /** Every background agent with its files' state (`no` when absent). */
  agents: Array<{ name: AgentKind; installed: AgentInstallState }>;
  /** The last poll that tried the server, or null. */
  lastPoll: LastPoll | null;
  /** The desktop backend a poll would use now, or null (no GUI, or no notifier installed). */
  backend: string | null;
  /** What detection found on this machine. */
  platform: {
    os: PlatformFacts['os'];
    gui: boolean;
    /** The agent setup would install here, or null. */
    agent: AgentKind | null;
    ssh: boolean;
    wsl: boolean;
    tmux: boolean;
    backends: string[];
  };
}

interface Collected { status: NotifyStatusJson; facts: PlatformFacts; probe: Probe; agents: AgentReport[] }

async function collectStatus(io: CliIO, ne: NotifyEnv): Promise<Collected> {
  const env = io.env;
  const loaded = loadNotifyConfig(env);
  const { facts, probe } = await detect(io, ne);
  const interval = fileConfig(env).config.interval;
  const agents = await Promise.all(AGENTS.map((a) => agentReport(a, io, ne, interval)));
  const status: NotifyStatusJson = {
    version: VERSION,
    config: loaded.config,
    disabledBy: loaded.disabledBy,
    problem: loaded.problem,
    configFile: configFilePath(env),
    shells: SHELLS.map((s) => {
      const found = hookFile(s, env, ne.platform);
      return { name: s.name, rcFile: found ?? s.rcFile(env, ne.platform), hook: found !== null, initFile: s.initFile(env), init: existsSync(s.initFile(env)) };
    }),
    agents: agents.map((a) => ({ name: a.name, installed: a.installed })),
    lastPoll: readLastPoll(env),
    backend: facts.backends[0] ?? null,
    platform: {
      os: facts.os, gui: facts.gui, agent: facts.agent, ssh: facts.ssh, wsl: facts.wsl, tmux: facts.tmux, backends: facts.backends,
    },
  };
  return { status, facts, probe, agents };
}

function formatStatus(s: NotifyStatusJson, env: NodeJS.ProcessEnv): string {
  const lines = [`mokkan ${s.version} notifications: ${describeConfig(s.config)}`];
  lines.push(`  config:    ${tilde(env, s.configFile)}${existsSync(s.configFile) ? '' : ' (not created; defaults)'}`);
  if (s.disabledBy === 'env') lines.push('             MOKKAN_NOTIFY=0 is set: everything is off here');
  if (s.disabledBy === 'corrupt') lines.push(`             unreadable, so everything is off: ${s.problem}`);
  for (const sh of s.shells) {
    const parts = [sh.hook ? `hook in ${tilde(env, sh.rcFile)}` : 'no hook', sh.init ? `${path.basename(sh.initFile)} present` : `no ${path.basename(sh.initFile)}`];
    lines.push(`  ${`${sh.name}:`.padEnd(10)} ${sh.hook || sh.init ? parts.join(', ') : 'not set up'}`);
  }
  const installed = s.agents.filter((a) => a.installed !== 'no');
  lines.push(`  agent:     ${installed.length === 0 ? 'none installed' : installed.map((a) => `${a.name} ${a.installed === 'yes' ? 'installed' : a.installed}`).join(', ')}`
    + (s.platform.agent !== null ? ` (this machine uses ${s.platform.agent})` : ' (none for this machine)'));
  lines.push(`  desktop:   ${s.backend !== null ? `${s.backend} would be used` : s.platform.gui ? 'no notifier installed' : 'no graphical session'}`);
  const p = s.lastPoll;
  if (p === null) lines.push('  last poll: never');
  else {
    const detail = p.status === 'error' ? `error: ${p.error ?? 'unknown'}` : `${p.status}, ${p.shown} shown, ${p.notified} notified${p.backend ? ` via ${p.backend}` : ''}`;
    lines.push(`  last poll: ${p.at} (${detail})`);
  }
  return `${lines.join('\n')}\n`;
}

async function statusCommand(ctx: NotifyCtx, ne: NotifyEnv): Promise<number> {
  const { status } = await collectStatus(ctx.io, ne);
  ctx.io.stdout(ctx.json ? `${JSON.stringify(status)}\n` : formatStatus(status, ctx.io.env));
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// test

async function testCommand(ctx: NotifyCtx, ne: NotifyEnv): Promise<number> {
  const { io } = ctx;
  const env = io.env;
  const loaded = loadNotifyConfig(env);
  if (loaded.disabledBy !== null) {
    io.stdout(loaded.disabledBy === 'env' ? 'Nothing sent: MOKKAN_NOTIFY=0 turns every notification off.\n' : `Nothing sent: ${loaded.problem}\n`);
    return 0;
  }
  const config = loaded.config;
  const { facts } = await detect(io, ne);
  if (!config.desktop) io.stdout('desktop: off (turn it on with mokkan notify on desktop)\n');
  else if (!facts.gui) io.stdout('desktop: no graphical session on this machine\n');
  else if (facts.backends.length === 0) io.stdout('desktop: no notifier installed\n');
  else {
    io.stdout('desktop:\n');
    const ok = await sendTest(io, facts.backends, io.isTTY ? 'ask' : 'all');
    if (io.isTTY && !ok) io.stdout(notSeenHint(facts.os));
  }
  if (config.osc === 'off') io.stdout('osc: off\n');
  else if (!io.isTTY) io.stdout('osc: not sent (not a terminal)\n');
  else {
    io.stdout(oscSequence(config.osc, env, `${TEST_TITLE}: ${TEST_BODY}`));
    io.stdout(`osc: sent a terminal notification escape (${config.osc})\n`);
  }
  io.stdout(config.shell ? 'shell: on (reminders print at the next prompt; nothing to send)\n' : 'shell: off\n');
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// doctor

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replaces the home path with `~`, the host name with `<host>` and the user name with `<user>`. */
export function redact(text: string, env: NodeJS.ProcessEnv, host: string): string {
  let out = text;
  const home = homeOf(env);
  if (home !== null) out = out.replace(new RegExp(`${escapeRe(home)}(?![A-Za-z0-9_.-])`, 'g'), '~');
  const word = (s: string): RegExp => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(s)}(?![A-Za-z0-9_])`, 'g');
  const hosts = [...new Set([host, host.split('.')[0] ?? ''])].filter((h) => h.length >= 2).sort((a, b) => b.length - a.length);
  for (const h of hosts) out = out.replace(word(h), '<host>');
  const users = [...new Set([env.USER, env.LOGNAME].filter((u): u is string => typeof u === 'string' && u.length >= 2))];
  for (const u of users) out = out.replace(word(u), '<user>');
  return out;
}

const setOrUnset = (v: string | undefined): string => (v ? 'set' : 'unset');
const exists = (p: string): string => `${p} (${existsSync(p) ? 'exists' : 'MISSING'})`;

async function doctorCommand(ctx: NotifyCtx, ne: NotifyEnv): Promise<number> {
  const { io } = ctx;
  const env = io.env;
  const { status, facts, probe, agents } = await collectStatus(io, ne);
  const lines: string[] = ['mokkan notify doctor (paste this into an issue)', ''];
  lines.push(formatStatus(status, env).trimEnd(), '');
  lines.push('Detection inputs:');
  lines.push(`  os: ${facts.os} (${ne.platform}), node ${process.version}, uid ${ne.uid}`);
  lines.push(`  XDG_SESSION_TYPE: ${env.XDG_SESSION_TYPE || '(unset)'}`);
  lines.push(`  DISPLAY: ${setOrUnset(env.DISPLAY)}, WAYLAND_DISPLAY: ${setOrUnset(env.WAYLAND_DISPLAY)}`);
  if (facts.os === 'macos') {
    lines.push(`  launchctl print gui/${ne.uid}: ${(await probe.launchctlGui(ne.uid)) ? 'ok (console session)' : 'failed'}`);
  } else if (facts.os === 'linux') {
    const bus = Boolean(env.DBUS_SESSION_BUS_ADDRESS) || await probe.sessionBusExists(ne.uid);
    lines.push(`  session bus: ${bus ? 'yes' : 'no'} (DBUS_SESSION_BUS_ADDRESS ${setOrUnset(env.DBUS_SESSION_BUS_ADDRESS)})`);
    lines.push(`  org.freedesktop.Notifications owned: ${bus && await probe.notificationServiceOwned() ? 'yes' : 'no'}`);
    lines.push(`  systemctl --user: ${(await probe.systemdUser()) ? 'reachable' : 'not reachable'}`);
    lines.push(`  wsl: ${facts.wsl ? 'yes' : 'no'}`);
  }
  const bins = await Promise.all(NOTIFIER_BINARIES.map(async (b) => `${b} ${(await probe.which(b)) ? 'yes' : 'no'}`));
  lines.push(`  notifier binaries on PATH: ${bins.join(', ')}`);
  lines.push(`  TERM: ${env.TERM || '(unset)'}, TERM_PROGRAM: ${env.TERM_PROGRAM || '(unset)'}`);
  if (env.TMUX) {
    const r = await spawnOf(io)('tmux', ['show', '-gv', 'allow-passthrough'], { timeoutMs: 3000, env });
    const value = r.code === 0 ? r.stdout.trim() : `unknown (${failureDetail(r)})`;
    lines.push(`  TMUX: set, allow-passthrough: ${value}${value === 'on' || value === 'all' ? '' : ' (OSC needs: tmux set -g allow-passthrough on)'}`);
  } else {
    lines.push('  TMUX: unset');
  }
  lines.push(`  SSH: ${facts.ssh ? 'yes' : 'no'}`);
  lines.push('', 'Baked paths:');
  lines.push(`  this CLI: node ${exists(ne.node)}, cli ${exists(ne.cli)}${isUnstableCliPath(ne.cli) ? ' (unstable path: plugin cache or npx)' : ''}`);
  const inits = bakedInits(env);
  if (inits.length === 0) lines.push('  init files: none');
  for (const b of inits) {
    lines.push(b.paths === null
      ? `  ${path.basename(b.file)}: no node/cli line found`
      : `  ${path.basename(b.file)}: node ${exists(b.paths.node)}, cli ${exists(b.paths.cli)}`);
  }
  for (const a of agents.filter((x) => x.installed !== 'no')) {
    lines.push(a.baked === null
      ? `  agent ${a.name} (${a.installed}): its files differ from what this mokkan writes; run mokkan notify setup`
      : `  agent ${a.name} (${a.installed}): node ${exists(a.baked.node)}, cli ${exists(a.baked.cli)}`);
  }
  lines.push('', 'Detection reasons:', ...facts.reasons.map((r) => `  - ${r}`));
  io.stdout(`${redact(lines.join('\n'), env, ne.hostname)}\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// poll and shell init

/** The client timeout for `notify poll` (the poll's own budget is 10 s). */
export const NOTIFY_POLL_CLIENT_TIMEOUT_MS = 8000;

/**
 * `mokkan notify poll [--loop]`: run by the agent and the prompt hook. Never prints and always exits 0; failures go
 * to hook.log. `makeClient` builds the client like every other command (cli.ts owns that).
 */
export async function notifyPollCommand(
  io: CliIO, flags: Record<string, string | boolean>, makeClient: (creds: Credentials | null) => PollClient,
): Promise<number> {
  const env = io.env;
  try {
    const ne = resolveNotifyEnv(io);
    const spawn = spawnOf(io);
    const loadClient = (): PollClient | null | 'bad' => {
      try {
        const creds = loadCredentials(env);
        return creds === null ? null : makeClient(creds);
      } catch (err) {
        if (err instanceof CredentialsPermissionError || err instanceof CredentialsCorruptError) {
          appendHookLogHourly(env, 'notify', 'credentials', err.message);
          return 'bad';
        }
        throw err;
      }
    };
    const deps: PollDeps = {
      env, now: io.now, client: null, spawn, platform: ne.platform,
      which: makeProbe(spawn, env, ne.uid).which,
      // A copy in the plugin cache must not bake its own path into the init scripts.
      ...(isUnstableCliPath(ne.cli) ? {} : { node: ne.node, cli: ne.cli, version: VERSION }),
    };
    if (flags.loop !== true) {
      const client = loadClient();
      if (client === 'bad') return 0;
      await pollOnce({ ...deps, client });
      return 0;
    }
    const stop = new AbortController();
    const onSignal = (): void => { stop.abort(); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      await pollLoop({
        ...deps,
        client: () => { const c = loadClient(); return c === 'bad' ? null : c; },
        sleep: io.sleep,
        signal: stop.signal,
      });
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  } catch (err) {
    safeAppendHookLog(env, 'notify', err);
  }
  return 0;
}

/** `mokkan shell init zsh|bash|fish`: the hook for people who manage their dotfiles by hand. */
export async function shellCommand(ctx: NotifyCtx, args: string[]): Promise<number> {
  const { io } = ctx;
  const shell = args[0] === 'init' && args.length === 2 ? shellByName(args[1]!) : null;
  if (shell === null) throw new UserError(SHELL_USAGE);
  const ne = resolveNotifyEnv(io);
  if (isUnstableCliPath(ne.cli)) io.stderr(`Warning: ${ne.cli} changes with every update; install mokkan with npm i -g @vicmpen/mokkan-cli first.\n`);
  io.stdout(shell.snippet(snippetOptions(ne, loadNotifyConfig(io.env).config)));
  return 0;
}

/** `mokkan notify <sub>` (everything but `poll`, which cli.ts runs before credentials are loaded). */
export async function notifyCommand(ctx: NotifyCtx, args: string[]): Promise<number> {
  const ne = resolveNotifyEnv(ctx.io);
  const [sub, ...rest] = args;
  switch (sub) {
    case 'setup': return setupCommand(ctx, ne);
    case 'remove': return removeCommand(ctx, ne);
    case 'on': return onOffCommand(ctx, ne, true, rest);
    case 'off': return onOffCommand(ctx, ne, false, rest);
    case 'status': return statusCommand(ctx, ne);
    case 'test': return testCommand(ctx, ne);
    case 'doctor': return doctorCommand(ctx, ne);
    default: throw new UserError(NOTIFY_USAGE);
  }
}
