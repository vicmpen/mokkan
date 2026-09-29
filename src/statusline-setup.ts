import {
  accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CliIO } from './cli.js';
import { configDir } from './credentials.js';

/**
 * `mokkan statusline` (without `--render`): writes the mokkan status line into Claude Code's settings.json and a
 * marked block of ~/.tmux.conf (Codex's own footer cannot run a command, so Codex shows it through tmux). Every write
 * is atomic, preceded by a timestamped backup, and limited to what mokkan owns: a statusLine that is not a plain
 * mokkan invocation is never replaced without --force, and only the marked tmux block is ever touched.
 */

export const TMUX_BEGIN = '# >>> mokkan status line >>>';
export const TMUX_END = '# <<< mokkan status line <<<';
export const REFRESH_INTERVAL_SECONDS = 30;

export interface SetupOptions {
  claude: boolean;
  tmux: boolean;
  /** No target flag was given: Claude Code if it is installed, tmux if it is on PATH. */
  auto: boolean;
  remove: boolean;
  dryRun: boolean;
  force: boolean;
  /**
   * Run from Claude Code (/mokkan, /mokkan:mokkan: `--exit-zero`). With no target flag only Claude Code is set up
   * there: the tmux block is a terminal user's choice.
   */
  fromClaude: boolean;
}

const SETUP_FLAGS = new Set(['--claude', '--tmux', '--codex', '--remove', '--dry-run', '--force']);

export const SETUP_USAGE = 'Usage: mokkan statusline [--claude] [--tmux|--codex] [--remove] [--dry-run] [--force]\n'
  + '       mokkan statusline --render [--format ansi|tmux|plain] [--no-text] [--width N] [--ttl S] [--grace M]\n';

/** Returns null (with a usage message) for an unknown word: configuring must not guess. */
export function parseSetupArgs(args: string[]): SetupOptions | null {
  const opts: SetupOptions = { claude: false, tmux: false, auto: false, remove: false, dryRun: false, force: false, fromClaude: false };
  for (const arg of args) {
    if (!SETUP_FLAGS.has(arg)) return null;
    if (arg === '--claude') opts.claude = true;
    if (arg === '--tmux' || arg === '--codex') opts.tmux = true;
    if (arg === '--remove') opts.remove = true;
    if (arg === '--dry-run') opts.dryRun = true;
    if (arg === '--force') opts.force = true;
  }
  if (!opts.claude && !opts.tmux) { opts.claude = true; opts.tmux = true; opts.auto = true; }
  return opts;
}

// ---- paths ----

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME !== '' ? env.HOME : homedir();
}

export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : path.join(home(env), '.claude');
}

export function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  return path.join(claudeConfigDir(env), 'settings.json');
}

/** ~/.tmux.conf, unless only tmux's XDG location ($XDG_CONFIG_HOME/tmux/tmux.conf, tmux >= 3.1) exists. */
export function tmuxConfPath(env: NodeJS.ProcessEnv): string {
  const classic = path.join(home(env), '.tmux.conf');
  const xdgBase = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : path.join(home(env), '.config');
  const xdg = path.join(xdgBase, 'tmux', 'tmux.conf');
  return !existsSync(classic) && existsSync(xdg) ? xdg : classic;
}

/** Where a CLI running from Claude Code's plugin cache is copied, so the status line survives plugin updates. */
export function stableCliPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME !== '' ? env.XDG_DATA_HOME : path.join(home(env), '.local', 'share');
  return path.join(base, 'mokkan', 'mokkan.mjs');
}

function pluginCacheDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = [path.join(claudeConfigDir(env), 'plugins', 'cache'), path.join(home(env), '.claude', 'plugins', 'cache')];
  const out = new Set<string>();
  for (const dir of dirs) {
    out.add(dir);
    try { out.add(realpathSync(dir)); } catch { /* not there */ }
  }
  return [...out];
}

const isInside = (file: string, dir: string): boolean => {
  const rel = path.relative(dir, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** True when `file` (already resolved) lives in a Claude Code plugin cache, whose path changes on every update. */
export function inPluginCache(file: string, env: NodeJS.ProcessEnv): boolean {
  return pluginCacheDirs(env).some((dir) => isInside(file, dir));
}

function sameContent(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** Copies `source` over `target` (0755, atomically) unless they are already identical. Returns whether it copied. */
function installCopy(source: string, target: string): boolean {
  if (sameContent(source, target)) return false;
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    copyFileSync(source, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* not created */ }
    throw err;
  }
  return true;
}

export interface CliLocation {
  /** The path the status line command runs. */
  cli: string;
  /** The running CLI lives in the plugin cache, so `cli` is the stable copy. */
  copied: boolean;
}

/** `npx @vicmpen/mokkan-cli statusline`: the CLI sits in npm's throwaway npx cache, which a status line must not point into. */
export class NpxCliError extends Error {
  constructor(file: string) {
    super(`mokkan is running from npx's temporary cache (${file}), which npm may delete at any time, so a status line `
      + 'must not point there. Run /mokkan:mokkan statusline in Claude Code (with the mokkan plugin), '
      + 'or npm i -g @vicmpen/mokkan-cli first and then mokkan statusline.');
  }
}

/**
 * The CLI path to put into a status line: the running file itself (npm global install, checkout), or, when it runs
 * from Claude Code's plugin cache (whose path changes on every plugin update), a stable copy under
 * $XDG_DATA_HOME/mokkan. `write: false` (dry run) computes the path without copying.
 */
export function resolveCliLocation(running: string, env: NodeJS.ProcessEnv, write: boolean): CliLocation {
  const real = realpathSync(running);
  if (real.split(path.sep).includes('_npx')) throw new NpxCliError(real);
  if (!inPluginCache(real, env)) return { cli: real, copied: false };
  const target = stableCliPath(env);
  if (write) installCopy(real, target);
  return { cli: target, copied: true };
}

/**
 * SessionStart hook: when the running CLI is a plugin-cache copy and a stable copy exists (the user configured the
 * status line), refresh the stable copy if the plugin was updated. Never creates it. Returns whether it copied.
 */
export function refreshStableCopy(running: string, env: NodeJS.ProcessEnv): boolean {
  const real = realpathSync(running);
  const target = stableCliPath(env);
  if (!inPluginCache(real, env) || !existsSync(target)) return false;
  return installCopy(real, target);
}

// ---- commands ----

/** The first executable called `name` on PATH, like `command -v`, without running anything. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const file = path.join(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch { /* next */ }
  }
  return null;
}

/**
 * The node to write into a status line: plain `node` when `node` on PATH is the very binary running now (so a later
 * nvm/fnm/Homebrew upgrade keeps working), else the absolute path of the running binary.
 */
export function nodeWord(node: string, env: NodeJS.ProcessEnv): string {
  try {
    const found = onPath('node', env);
    if (found !== null && realpathSync(found) === realpathSync(node)) return 'node';
  } catch { /* fall back to the absolute path */ }
  return node;
}

/** Single-quotes a word for sh when it needs it. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function claudeCommand(node: string, cli: string): string {
  return `${shellWord(node)} ${shellWord(cli)} statusline --render`;
}

/** Inside tmux's single-quoted status-right and its #() shell: double quotes, and no characters either would expand. */
function tmuxWord(word: string): string {
  if (/[#'"$`\\\n]/.test(word)) throw new Error(`cannot use ${word} in a tmux status line (it contains # ' " $ \` or \\)`);
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `"${word}"`;
}

export function tmuxBlock(node: string, cli: string): string {
  return [
    TMUX_BEGIN,
    '# Added by `mokkan statusline`; `mokkan statusline --remove --tmux` takes it out again.',
    'set -g status-interval 15',
    'set -g status-right-length 120',
    `set -g status-right '${tmuxSnippet(node, cli)} %H:%M'`,
    TMUX_END,
  ].join('\n');
}

/** Splits a shell command into words (quotes honoured). null when it uses shell syntax: then it is not ours alone. */
function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return null;
      cur += command.slice(i + 1, end); started = true; i = end;
    } else if (c === '"') {
      const end = command.indexOf('"', i + 1);
      if (end === -1) return null;
      const inner = command.slice(i + 1, end);
      if (/[$`\\]/.test(inner)) return null;
      cur += inner; started = true; i = end;
    } else if (/\s/.test(c)) {
      if (started) { words.push(cur); cur = ''; started = false; }
    } else if (/[;&|<>()$`\\*?{}~#]/.test(c)) {
      return null;
    } else {
      cur += c; started = true;
    }
  }
  if (started) words.push(cur);
  return words;
}

const RENDER_WORDS = /^--(render|format|no-text|width|ttl|grace)(=.*)?$|^(ansi|tmux|plain|\d+)$/;

/**
 * A status line command that is nothing but a mokkan invocation: `[node] <…mokkan…|…/cli.js> statusline [render flags]`.
 * Such a command is mokkan's own (possibly an old form or a stale path) and may be migrated.
 */
export function isMokkanCommand(command: string): boolean {
  const words = shellWords(command);
  if (!words) return false;
  const at = words.indexOf('statusline');
  if (at < 1 || at > 2) return false;
  const cli = words[at - 1];
  const base = path.basename(cli);
  const cliLooksRight = base === 'mokkan' || base === 'mokkan.mjs' || (/^cli\.m?js$/.test(base) && cli.includes('mokkan'));
  if (!cliLooksRight) return false;
  if (at === 2 && !/^node(js)?(\d+)?(\.exe)?$/.test(path.basename(words[0]))) return false;
  return words.slice(at + 1).every((w) => RENDER_WORDS.test(w));
}

// ---- file edits ----

function timestamp(now: Date): string {
  return now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

/** Copies `file` to `<file>.mokkan-bak-<ts>` (never over an existing backup). Returns the backup path. */
function backup(file: string, now: Date): string {
  const base = `${file}.mokkan-bak-${timestamp(now)}`;
  for (let n = 0; ; n++) {
    const target = n === 0 ? base : `${base}-${n}`;
    try {
      copyFileSync(file, target, constants.COPYFILE_EXCL);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/**
 * Replaces `file` atomically, writing through a symlink (dotfile managers) to its target and keeping the file's mode.
 * `was` is the text the edit started from (null: the file did not exist); an existing file is backed up to
 * `<file>.mokkan-bak-<ts>`. Order matters: the new content is written to a temp file first, then the backup is taken,
 * then the temp file is renamed over the target, so a target that cannot be written (a read-only Nix/home-manager
 * store) fails before any backup exists and a failed rename takes its backup with it. Just before the rename the file
 * is read again: if something else (Claude Code itself) changed it meanwhile, nothing is replaced.
 * Returns the backup path.
 */
function replaceFile(file: string, content: string, was: string | null, now: Date): string | null {
  let target = file;
  try { target = realpathSync(file); } catch { /* new file */ }
  let mode = 0o644;
  try { mode = statSync(target).mode & 0o777; } catch { /* new file */ }
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let bak: string | null = null;
  try {
    writeFileSync(tmp, content, { mode });
    chmodSync(tmp, mode);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (current !== was) throw new Error(`${file} changed while mokkan was editing it; run the command again`);
    if (was !== null) bak = backup(file, now);
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* not created, or already renamed */ }
    if (bak !== null) { try { unlinkSync(bak); } catch { /* best effort */ } }
    throw err;
  }
  return bak;
}

/** The indentation the file already uses (Claude Code writes 2 spaces). */
function detectIndent(text: string): string | number {
  const m = /^[ \t]*[{[][^\n]*\n([ \t]+)\S/.exec(text);
  return m ? m[1] : 2;
}

interface Outcome { lines: string[]; failed: boolean; changed: boolean }

type Settings = Record<string, unknown>;

function readSettings(file: string): { settings: Settings; text: string | null } | { error: string } {
  if (!existsSync(file)) return { settings: {}, text: null };
  const text = readFileSync(file, 'utf8');
  if (text.trim() === '') return { settings: {}, text };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { error: `${file} is not valid JSON; fix it first (nothing was changed)` }; }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: `${file} does not hold a JSON object; fix it first (nothing was changed)` };
  }
  return { settings: value as Settings, text };
}

function statusLineCommandOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const cmd = (value as { command?: unknown }).command;
  return typeof cmd === 'string' ? cmd : undefined;
}

function writeSettings(file: string, settings: Settings, text: string | null, now: Date): string | null {
  const indent = text !== null ? detectIndent(text) : 2;
  return replaceFile(file, `${JSON.stringify(settings, null, indent)}\n`, text, now);
}

export interface SetupEnv {
  env: NodeJS.ProcessEnv;
  now: Date;
  node: string;
  cli: string;
}

function configureClaude(s: SetupEnv, opts: SetupOptions): Outcome {
  const file = claudeSettingsPath(s.env);
  const read = readSettings(file);
  if ('error' in read) return { lines: [`Claude Code: ${read.error}.`], failed: true, changed: false };
  const { settings, text } = read;
  const current = settings.statusLine;
  const currentCmd = statusLineCommandOf(current);
  const ours = currentCmd !== undefined && isMokkanCommand(currentCmd);
  const command = claudeCommand(s.node, s.cli);

  if (opts.remove) {
    if (current === undefined) return { lines: [`Claude Code: no status line in ${file}; nothing to remove.`], failed: false, changed: false };
    if (!ours) {
      return { lines: [`Claude Code: the status line in ${file} is not mokkan's (${describe(current)}); left alone.`], failed: false, changed: false };
    }
    const next = { ...settings };
    delete next.statusLine;
    if (opts.dryRun) return { lines: [`Claude Code: would remove the mokkan status line from ${file}.`], failed: false, changed: true };
    const bak = writeSettings(file, next, text, s.now);
    return { lines: [`Claude Code: removed the mokkan status line from ${file}${bak ? ` (backup: ${bak})` : ''}.`], failed: false, changed: true };
  }

  if (current !== undefined && !ours && !opts.force) {
    const lines = [
      `Claude Code: ${file} already has a status line that is not mokkan's; left alone:`,
      `  ${describe(current)}`,
    ];
    if (currentCmd?.includes('statusline') && currentCmd.includes('mokkan') && !currentCmd.includes('--render')) {
      lines.push('  It seems to call mokkan: change `statusline` to `statusline --render` there (the plain command now configures).');
    } else {
      lines.push(`  To show both, make your script also print the output of: ${command}`);
    }
    lines.push('  Or replace it: mokkan statusline --claude --force');
    return { lines, failed: true, changed: false };
  }

  const prev = typeof current === 'object' && current !== null && ours ? current as Record<string, unknown> : {};
  const interval = typeof prev.refreshInterval === 'number' ? prev.refreshInterval : REFRESH_INTERVAL_SECONDS;
  const wanted = { ...prev, type: 'command', command, refreshInterval: interval };
  if (ours && JSON.stringify(current) === JSON.stringify(wanted)) {
    return { lines: [`Claude Code: already configured in ${file}.`], failed: false, changed: false };
  }
  const verb = current === undefined ? 'add' : ours ? 'update' : 'replace';
  const detail = `  "statusLine": ${JSON.stringify(wanted)}`;
  const was = current !== undefined ? [`  (was: ${describe(current)})`] : [];
  if (opts.dryRun) {
    return { lines: [`Claude Code: would ${verb} the status line in ${file}:`, detail, ...was], failed: false, changed: true };
  }
  const bak = writeSettings(file, { ...settings, statusLine: wanted }, text, s.now);
  const done = { add: 'added', update: 'updated', replace: 'replaced' }[verb];
  return {
    lines: [`Claude Code: ${done} the status line in ${file}${bak ? ` (backup: ${bak})` : ''}:`, detail, ...was],
    failed: false, changed: true,
  };
}

function describe(value: unknown): string {
  const cmd = statusLineCommandOf(value);
  return cmd !== undefined ? cmd : JSON.stringify(value);
}

interface BlockSpan { start: number; end: number }

/** The marker lines, tolerating CRLF line ends and trailing whitespace (editors, Windows checkouts). */
function findBlock(lines: string[]): BlockSpan | null | 'broken' {
  const trimmed = lines.map((l) => l.trimEnd());
  const start = trimmed.indexOf(TMUX_BEGIN);
  const end = trimmed.indexOf(TMUX_END);
  if (start === -1 && end === -1) return null;
  if (start === -1 || end === -1 || end < start) return 'broken';
  if (trimmed.indexOf(TMUX_BEGIN, start + 1) !== -1) return 'broken';
  return { start, end };
}

function configureTmux(s: SetupEnv, opts: SetupOptions): Outcome {
  const file = tmuxConfPath(s.env);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const lines = text === null ? [] : text.replace(/\n$/, '').split('\n');
  if (text === '') lines.length = 0;
  const span = findBlock(lines);
  if (span === 'broken') {
    return { lines: [`tmux: ${file} has an incomplete mokkan block (${TMUX_BEGIN} / ${TMUX_END}); fix it by hand (nothing was changed).`], failed: true, changed: false };
  }

  if (opts.remove) {
    if (!span) return { lines: [`tmux: no mokkan block in ${file}; nothing to remove.`], failed: false, changed: false };
    const next = [...lines.slice(0, span.start), ...lines.slice(span.end + 1)];
    // The blank line we put before the block goes with it.
    const blank = (l: string | undefined) => l !== undefined && l.trim() === '';
    if (span.start > 0 && blank(next[span.start - 1]) && (span.start === next.length || blank(next[span.start]))) next.splice(span.start - 1, 1);
    if (opts.dryRun) return { lines: [`tmux: would remove the mokkan block from ${file}.`], failed: false, changed: true };
    const bak = replaceFile(file, next.length > 0 ? `${next.join('\n')}\n` : '', text, s.now);
    return { lines: [`tmux: removed the mokkan block from ${file} (backup: ${bak}).`, ...reloadHint(file)], failed: false, changed: true };
  }

  let block: string;
  try {
    block = tmuxBlock(s.node, s.cli);
  } catch (err) {
    return { lines: [`tmux: ${(err as Error).message}; nothing was changed.`], failed: true, changed: false };
  }
  const blockLines = block.split('\n');
  if (!span && !opts.force) {
    const foreign = foreignTmuxConfig(lines);
    if (foreign) {
      const combine = [
        `  To show mokkan there too, add this to your status-right: ${tmuxSnippet(s.node, s.cli)}`,
        `  Or let mokkan's block override it: mokkan statusline --tmux --force`,
      ];
      if (opts.auto) {
        return { lines: [`tmux: skipped: ${file} ${foreign}, which mokkan's block would override.`, ...combine], failed: false, changed: false };
      }
      return { lines: [`tmux: ${file} ${foreign}; left alone (nothing was changed).`, ...combine], failed: true, changed: false };
    }
  }
  let next: string[];
  if (span) {
    if (lines.slice(span.start, span.end + 1).join('\n') === block) {
      return { lines: [`tmux: already configured in ${file}.`, ...foreignNotes(lines, span)], failed: false, changed: false };
    }
    next = [...lines.slice(0, span.start), ...blockLines, ...lines.slice(span.end + 1)];
  } else {
    next = lines.length > 0 && lines[lines.length - 1] !== '' ? [...lines, '', ...blockLines] : [...lines, ...blockLines];
  }
  const newSpan = findBlock(next) as BlockSpan;
  const notes = foreignNotes(next, newSpan);
  const verb = span ? 'update' : 'add';
  if (opts.dryRun) {
    return { lines: [`tmux: would ${verb} this block in ${file}:`, ...blockLines.map((l) => `  ${l}`), ...notes], failed: false, changed: true };
  }
  const bak = replaceFile(file, `${next.join('\n')}\n`, text, s.now);
  return {
    lines: [`tmux: ${span ? 'updated' : 'added'} the mokkan block in ${file}${bak ? ` (backup: ${bak})` : ''}.`, ...notes, ...reloadHint(file)],
    failed: false, changed: true,
  };
}

const STATUS_RIGHT = /^\s*set(-option)?\s+(-\w+\s+)*status-right\s/;
const TPM_RUN = /^\s*run(-shell)?\s.*\btpm\b/;

const isOlderMokkanLine = (line: string) => line.includes('mokkan') || line.includes('statusline');

/**
 * Why a tmux config without a mokkan block is someone else's status bar: its own status-right, or TPM (whose themes
 * set status-right when tmux starts). null when there is nothing to override.
 */
function foreignTmuxConfig(lines: string[]): string | null {
  const own = lines.findIndex((l) => STATUS_RIGHT.test(l) && !isOlderMokkanLine(l));
  if (own !== -1) return `sets its own status-right (line ${own + 1})`;
  const tpm = lines.findIndex((l) => TPM_RUN.test(l));
  if (tpm !== -1) return `loads tmux plugins through TPM (line ${tpm + 1}), whose themes set status-right`;
  return null;
}

/** The part of the block's status-right that shows mokkan, for a user to put into their own status-right. */
function tmuxSnippet(node: string, cli: string): string {
  return `#(${tmuxWord(node)} ${tmuxWord(cli)} statusline --render --format tmux)`;
}

/** The user's own status-right lines stay; the mokkan block comes later in the file and wins. Say so. */
function foreignNotes(lines: string[], span: BlockSpan): string[] {
  const notes: string[] = [];
  lines.forEach((line, i) => {
    if (i >= span.start && i <= span.end) return;
    if (!STATUS_RIGHT.test(line)) return;
    if (i > span.end) {
      notes.push(`  note: line ${i + 1} sets status-right after the mokkan block, so it hides mokkan.`);
    } else if (isOlderMokkanLine(line)) {
      notes.push(`  note: line ${i + 1} is an older mokkan status-right (outside the block); the block overrides it, you can delete it.`);
    } else {
      notes.push(`  note: line ${i + 1} sets your own status-right; the mokkan block overrides it. To keep both, add #(...) from the block to yours and run mokkan statusline --remove --tmux.`);
    }
  });
  return notes;
}

function reloadHint(file: string): string[] {
  return [`  If tmux is running, reload it: tmux source-file ${file}`];
}

/** `tmux` somewhere on PATH (executable), without running it. */
export function tmuxOnPath(env: NodeJS.ProcessEnv): boolean {
  return onPath('tmux', env) !== null;
}

/** `--remove`: the stable plugin copy goes too once neither config runs it any more. */
function removeUnusedStableCopy(env: NodeJS.ProcessEnv): string[] {
  const stable = stableCliPath(env);
  if (!existsSync(stable)) return [];
  for (const file of [claudeSettingsPath(env), tmuxConfPath(env)]) {
    try { if (readFileSync(file, 'utf8').includes(stable)) return []; } catch { /* no such file */ }
  }
  try {
    unlinkSync(stable);
    return [`CLI: removed the copy at ${stable}.`];
  } catch (err) {
    return [`CLI: could not remove ${stable}: ${(err as Error).message}`];
  }
}

export interface SetupDeps {
  /** The running CLI file (process.argv[1]). */
  running: string;
  /** The node binary (process.execPath). */
  node: string;
}

/**
 * `mokkan statusline [--claude] [--tmux|--codex] [--remove] [--dry-run] [--force]`. Never prompts. `fromClaude`: run
 * through /mokkan or /mokkan:mokkan (`--exit-zero`).
 */
export function statuslineSetupCommand(io: CliIO, args: string[], deps: SetupDeps, fromClaude = false): number {
  const parsed = parseSetupArgs(args);
  if (!parsed) {
    io.stderr(SETUP_USAGE);
    return 1;
  }
  const opts: SetupOptions = { ...parsed, fromClaude };
  const env = io.env;
  let location: CliLocation;
  try {
    location = resolveCliLocation(deps.running, env, !opts.dryRun && !opts.remove);
  } catch (err) {
    if (err instanceof NpxCliError && opts.remove) {
      location = { cli: deps.running, copied: false };
    } else {
      io.stderr(err instanceof NpxCliError ? `${err.message}\n` : `Cannot find the running mokkan CLI (${deps.running}): ${(err as Error).message}\n`);
      return 1;
    }
  }
  const s: SetupEnv = { env, now: io.now(), node: nodeWord(deps.node, env), cli: location.cli };
  const out: string[] = [];
  let failed = false;
  let claudeChanged = false;
  let tmuxChanged = false;

  const run = (label: string, fn: () => Outcome): Outcome | null => {
    try {
      const o = fn();
      out.push(...o.lines);
      failed ||= o.failed;
      return o;
    } catch (err) {
      out.push(`${label}: ${(err as Error).message}; nothing was changed.`);
      failed = true;
      return null;
    }
  };

  if (opts.claude) {
    if (opts.auto && !existsSync(claudeConfigDir(env))) {
      out.push(`Claude Code: ${claudeConfigDir(env)} does not exist; skipped (use --claude to set it up anyway).`);
    } else {
      claudeChanged = run('Claude Code', () => configureClaude(s, opts))?.changed === true;
    }
  }
  if (opts.tmux) {
    if (opts.auto && opts.fromClaude && !opts.remove) {
      out.push('tmux: not set up from Claude Code; add --tmux for the tmux block (Codex shows mokkan only inside tmux).');
    } else if (opts.auto && !tmuxOnPath(env)) {
      out.push('tmux: not installed; skipped (Codex shows mokkan only inside tmux; use --tmux to write the block anyway).');
    } else {
      tmuxChanged = run('tmux', () => configureTmux(s, opts))?.changed === true;
      if (!opts.remove) out.push('  Codex: its own footer cannot run commands; run Codex inside tmux to see mokkan in the tmux status bar.');
    }
  }
  if (opts.remove && !opts.dryRun) out.push(...removeUnusedStableCopy(env));
  if (location.copied && !opts.remove) {
    out.push(opts.dryRun
      ? `CLI: would copy the plugin's CLI to ${location.cli} (the plugin path changes on every update).`
      : `CLI: the status line runs ${location.cli}, a copy of the plugin's CLI kept up to date by the plugin's SessionStart hook.`);
  }
  if (opts.dryRun) out.push('Dry run: nothing was written.');
  else if (claudeChanged) out.push('Restart Claude Code (or open a new session) to see the status line.');
  io.stdout(`${out.join('\n')}\n`);
  return failed ? 1 : 0;
}

/**
 * Claude Code runs the old statusLine command `… mokkan statusline` (no --render) on every refresh, non-interactively.
 * When the plain command runs without a terminal and settings.json's statusLine is mokkan's own, this is that call:
 * migrate the setting in place (once; later calls are a cheap read) and let the caller render as before, so the
 * status line never shows setup text and tmux is never touched from here.
 * Returns true when the caller should render.
 */
/** A failed migration (read-only settings.json) is not retried for this long: the status line refreshes every 30 s. */
const MIGRATE_RETRY_MS = 24 * 60 * 60 * 1000;

function migrateStampPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), 'statusline-migrate-failed');
}

function recentMigrateFailure(env: NodeJS.ProcessEnv, now: Date): boolean {
  try {
    const at = Date.parse(readFileSync(migrateStampPath(env), 'utf8').trim());
    return Number.isFinite(at) && now.getTime() - at < MIGRATE_RETRY_MS && now.getTime() >= at;
  } catch {
    return false;
  }
}

function stampMigrateFailure(env: NodeJS.ProcessEnv, now: Date): void {
  try {
    mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
    writeFileSync(migrateStampPath(env), `${now.toISOString()}\n`, { mode: 0o600 });
  } catch { /* best effort */ }
}

export function migrateLegacyInvocation(io: CliIO, deps: SetupDeps): boolean {
  let cmd: string | undefined;
  try {
    const file = claudeSettingsPath(io.env);
    if (!existsSync(file)) return false;
    const read = readSettings(file);
    if ('error' in read) return false;
    cmd = statusLineCommandOf(read.settings.statusLine);
  } catch {
    return false;
  }
  if (cmd === undefined || !isMokkanCommand(cmd)) return false;
  if (/(^|\s)--render(\s|$)/.test(cmd)) return true;
  const now = io.now();
  if (recentMigrateFailure(io.env, now)) return true;
  try {
    const location = resolveCliLocation(deps.running, io.env, true);
    const outcome = configureClaude({ env: io.env, now, node: nodeWord(deps.node, io.env), cli: location.cli },
      { claude: true, tmux: false, auto: false, remove: false, dryRun: false, force: false, fromClaude: false });
    if (outcome.failed) stampMigrateFailure(io.env, now);
    else { try { unlinkSync(migrateStampPath(io.env)); } catch { /* none */ } }
  } catch {
    // The render below still works; a day passes before the next attempt (no backup is left behind either way).
    stampMigrateFailure(io.env, now);
  }
  return true;
}

/**
 * Plain `statusline` without a terminal and outside Claude Code's /mokkan, when it is not an old mokkan statusLine
 * that could be migrated: never set anything up from here (it may be a status bar refresh). One line, for the bar.
 */
export function nonTerminalHint(env: NodeJS.ProcessEnv): string {
  let text = '';
  try { text = readFileSync(claudeSettingsPath(env), 'utf8'); } catch { /* none */ }
  if (text.includes('statusline') && !text.includes('--render')) {
    return 'mokkan: run "mokkan statusline" in a terminal to update this status line';
  }
  return 'mokkan: nothing was set up without a terminal; run "mokkan statusline" in one, or "mokkan statusline --claude" (or --tmux) here';
}
