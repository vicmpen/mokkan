import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SpawnResult } from '../../spawn.js';
import type { AgentContext, AgentFile, AgentInstallState } from './types.js';

/** The text every agent file carries, as an XML comment in the plist and a `#` comment elsewhere. */
export const MARKER_TEXT = 'managed by mokkan';
/** Lines searched for the marker: a plist puts the XML declaration and doctype first. */
const MARKER_LINES = 5;

export function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME !== '' ? env.HOME : homedir();
}

/** `$XDG_CONFIG_HOME`, or `~/.config`: systemd user units and XDG autostart both honour it. */
export function xdgConfigBase(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== '' ? env.XDG_CONFIG_HOME : path.join(homeOf(env), '.config');
}

/**
 * Why `ctx` cannot be rendered, or null. Paths must be absolute and free of control characters (a newline would
 * add a line to a unit file), and the interval a positive whole number of seconds.
 */
export function contextProblem(ctx: AgentContext): string | null {
  const paths: Array<[string, string | undefined]> = [['node', ctx.node], ['cli', ctx.cli], ['XDG_CONFIG_HOME', ctx.xdgConfigHome]];
  for (const [what, value] of paths) {
    if (value === undefined) continue;
    if (!path.isAbsolute(value)) return `the ${what} path ${JSON.stringify(value)} is not absolute`;
    if (/[\x00-\x1f\x7f]/.test(value)) return `the ${what} path ${JSON.stringify(value)} contains a control character`;
  }
  if (!Number.isInteger(ctx.interval) || ctx.interval < 1) return `the interval ${ctx.interval} is not a whole number of seconds`;
  return null;
}

export function assertRenderable(ctx: AgentContext): void {
  const problem = contextProblem(ctx);
  if (problem !== null) throw new Error(problem);
}

/** Whether `content` carries `marker` as a whole line near the top. */
export function hasMarker(content: string, marker: string): boolean {
  return content.split('\n', MARKER_LINES).some((line) => line.trim() === marker);
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** `missing`, `foreign` (no marker), `same` (byte-identical to `content`) or `differs` (ours, other content). */
export type FileState = 'missing' | 'foreign' | 'same' | 'differs';

export function fileState(file: AgentFile, marker: string): FileState {
  const current = readOrNull(file.path);
  if (current === null) return 'missing';
  if (!hasMarker(current, marker)) return 'foreign';
  return current === file.content ? 'same' : 'differs';
}

/** Writes `content` through a temp file and rename, 0644, creating the directory. */
export function writeAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, file);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}

/** The refusal line for a file that is not ours. */
export function foreignMessage(file: string): string {
  return `${file} exists and is not mokkan's; left alone`;
}

/**
 * Writes every file that is missing or differs. Refuses all of them, writing nothing, when any is foreign. Returns
 * the files written (empty when everything was already identical), or null after a refusal.
 */
export function writeOurs(files: AgentFile[], marker: string, messages: string[]): string[] | null {
  const states = files.map((f) => fileState(f, marker));
  const foreign = files.filter((_, i) => states[i] === 'foreign');
  if (foreign.length > 0) {
    for (const f of foreign) messages.push(foreignMessage(f.path));
    return null;
  }
  const written: string[] = [];
  files.forEach((f, i) => {
    if (states[i] === 'same') return;
    writeAtomic(f.path, f.content);
    written.push(f.path);
    messages.push(`Wrote ${f.path}`);
  });
  return written;
}

/** Deletes each file that carries the marker; a foreign file stays, with a message. Returns the files deleted. */
export function removeOurs(files: string[], marker: string, messages: string[]): string[] {
  const removed: string[] = [];
  for (const file of files) {
    const current = readOrNull(file);
    if (current === null) continue;
    if (!hasMarker(current, marker)) {
      messages.push(foreignMessage(file));
      continue;
    }
    try {
      unlinkSync(file);
      removed.push(file);
      messages.push(`Removed ${file}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return removed;
}

/** Whether any of `files` exists without the marker. */
export function anyForeign(files: string[], marker: string): boolean {
  return files.some((file) => {
    const current = readOrNull(file);
    return current !== null && !hasMarker(current, marker);
  });
}

/** The shared `installed()`: decided from the files on disk and the baked node and cli paths. */
export function installedState(ctx: AgentContext, paths: string[], render: (ctx: AgentContext) => AgentFile[], marker: string): AgentInstallState {
  const current = paths.map(readOrNull);
  if (current.some((c) => c !== null && !hasMarker(c, marker))) return 'foreign';
  if (current.every((c) => c === null)) return 'no';
  if (contextProblem(ctx) !== null || current.some((c) => c === null)) return 'stale';
  const expected = render(ctx);
  if (expected.some((f, i) => f.content !== current[i])) return 'stale';
  return existsSync(ctx.node) && existsSync(ctx.cli) ? 'yes' : 'stale';
}

/** One line for a failed launchctl or systemctl call: its stderr, or why it did not run. */
export function commandFailure(what: string, r: SpawnResult): string {
  const detail = r.stderr.trim() || r.stdout.trim() || r.error || `exit code ${r.code}`;
  return `${what} failed: ${detail}`;
}
