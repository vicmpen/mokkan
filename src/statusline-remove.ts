import { constants, copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { CliIO } from './cli.js';

/**
 * 0.3.0 removed the status line. `mokkan statusline` stays for one release so that nothing breaks for people who set
 * it up with 0.2.0: a status bar still running `mokkan statusline --render` gets an empty line and exit 0, and
 * `mokkan statusline --remove` takes the old configuration out of Claude Code's settings.json and ~/.tmux.conf (backups
 * first) and deletes the CLI copy 0.2.0 kept for it. A person typing the bare command in a terminal gets one hint.
 */
export function statuslineCommand(io: CliIO, args: string[]): number {
  if (!args.includes('--remove')) {
    if (io.isTTY) io.stdout('mokkan 0.3.0 has no status line. `mokkan statusline --remove` takes an earlier version\'s out of settings.json and ~/.tmux.conf.\n');
    return 0;
  }
  const dryRun = args.includes('--dry-run');
  const now = io.now();
  const lines = [...removeClaude(io.env, now, dryRun), ...removeTmux(io.env, now, dryRun), ...removeStableCopy(io.env, dryRun)];
  if (dryRun) lines.push('Dry run: nothing was written.');
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

const TMUX_BEGIN = '# >>> mokkan status line >>>';
const TMUX_END = '# <<< mokkan status line <<<';

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME !== '' ? env.HOME : homedir();
}

function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  const dir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR !== '' ? env.CLAUDE_CONFIG_DIR : path.join(home(env), '.claude');
  return path.join(dir, 'settings.json');
}

/** ~/.tmux.conf, unless only tmux's XDG location exists. */
function tmuxConfPath(env: NodeJS.ProcessEnv): string {
  const classic = path.join(home(env), '.tmux.conf');
  const xdgBase = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : path.join(home(env), '.config');
  const xdg = path.join(xdgBase, 'tmux', 'tmux.conf');
  return !existsSync(classic) && existsSync(xdg) ? xdg : classic;
}

function stableCliPath(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_DATA_HOME && env.XDG_DATA_HOME !== '' ? env.XDG_DATA_HOME : path.join(home(env), '.local', 'share');
  return path.join(base, 'mokkan', 'mokkan.mjs');
}

/** Replaces `file` atomically through a symlink, keeping its mode, after a `<file>.mokkan-bak-<ts>` backup. Returns the backup path. */
function replaceFile(file: string, content: string, now: Date): string {
  let target = file;
  try { target = realpathSync(file); } catch { /* keep */ }
  const mode = statSync(target).mode & 0o777;
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
  let bak = `${file}.mokkan-bak-${stamp}`;
  for (let n = 1; existsSync(bak); n++) bak = `${file}.mokkan-bak-${stamp}-${n}`;
  copyFileSync(file, bak, constants.COPYFILE_EXCL);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, target);
  return bak;
}

/** A status line command that is nothing but a mokkan invocation. */
const isMokkanCommand = (command: string): boolean => /(^|[\s/])(mokkan|mokkan\.mjs|cli\.m?js)\s+statusline(\s|$)/.test(command) && command.includes('mokkan');

function removeClaude(env: NodeJS.ProcessEnv, now: Date, dryRun: boolean): string[] {
  const file = claudeSettingsPath(env);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  let settings: Record<string, unknown>;
  try { settings = JSON.parse(text) as Record<string, unknown>; } catch { return [`Claude Code: ${file} is not valid JSON; left alone.`]; }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return [`Claude Code: ${file} does not hold a JSON object; left alone.`];
  const current = settings.statusLine;
  if (current === undefined) return [`Claude Code: no status line in ${file}; nothing to remove.`];
  const cmd = typeof current === 'object' && current !== null ? (current as { command?: unknown }).command : undefined;
  if (typeof cmd !== 'string' || !isMokkanCommand(cmd)) return [`Claude Code: the status line in ${file} is not mokkan's; left alone.`];
  if (dryRun) return [`Claude Code: would remove the mokkan status line from ${file}.`];
  const next = { ...settings };
  delete next.statusLine;
  const indent = /^[{[][^\n]*\n([ \t]+)\S/.exec(text)?.[1] ?? 2;
  const bak = replaceFile(file, `${JSON.stringify(next, null, indent)}\n`, now);
  return [`Claude Code: removed the mokkan status line from ${file} (backup: ${bak}). Restart Claude Code.`];
}

function removeTmux(env: NodeJS.ProcessEnv, now: Date, dryRun: boolean): string[] {
  const file = tmuxConfPath(env);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  const lines = text.replace(/\n$/, '').split('\n');
  const trimmed = lines.map((l) => l.trimEnd());
  const start = trimmed.indexOf(TMUX_BEGIN);
  const end = trimmed.indexOf(TMUX_END);
  if (start === -1 && end === -1) return [`tmux: no mokkan block in ${file}; nothing to remove.`];
  if (start === -1 || end === -1 || end < start) return [`tmux: ${file} has an incomplete mokkan block; fix it by hand (nothing was changed).`];
  const next = [...lines.slice(0, start), ...lines.slice(end + 1)];
  if (start > 0 && next[start - 1]?.trim() === '' && (start === next.length || next[start]?.trim() === '')) next.splice(start - 1, 1);
  if (dryRun) return [`tmux: would remove the mokkan block from ${file}.`];
  const bak = replaceFile(file, next.length > 0 ? `${next.join('\n')}\n` : '', now);
  return [`tmux: removed the mokkan block from ${file} (backup: ${bak}). Reload with: tmux source-file ${file}`];
}

function removeStableCopy(env: NodeJS.ProcessEnv, dryRun: boolean): string[] {
  const stable = stableCliPath(env);
  if (!existsSync(stable)) return [];
  if (dryRun) return [`CLI: would remove the copy at ${stable}.`];
  try {
    unlinkSync(stable);
    return [`CLI: removed the copy at ${stable}.`];
  } catch (err) {
    return [`CLI: could not remove ${stable}: ${(err as Error).message}`];
  }
}
