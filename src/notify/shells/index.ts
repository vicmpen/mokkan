import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeStateFile } from '../state.js';
import { bash } from './bash.js';
import { fish } from './fish.js';
import type { NotifyShell, ShellName, SnippetOptions } from './types.js';
import { zsh } from './zsh.js';

export type { NotifyShell, ShellName, SnippetOptions } from './types.js';

/** The markers around the one line an `rc-block` shell's rc file gets. */
export const RC_BEGIN = '# >>> mokkan notify >>>';
export const RC_END = '# <<< mokkan notify <<<';

/** Every supported shell. */
export const SHELLS: readonly NotifyShell[] = [zsh, bash, fish];

export function shellByName(name: string): NotifyShell | null {
  return SHELLS.find((s) => s.name === name) ?? null;
}

/** The user's login shell, from the basename of `$SHELL` (`/bin/zsh`, `/usr/local/bin/fish`, `-bash`). */
export function shellFromEnv(env: NodeJS.ProcessEnv): NotifyShell | null {
  const base = path.basename(env.SHELL ?? '').replace(/^-/, '');
  return base === '' ? null : shellByName(base);
}

/**
 * Rewrites `init.<shell>` (0600) for every shell whose init file already exists and differs from what `opts` would
 * generate now: a new CLI version, interval or osc mode. Shells never set up are left alone. Returns the shells
 * whose file was rewritten.
 */
export function ensureInitScripts(env: NodeJS.ProcessEnv, opts: SnippetOptions, shells: readonly NotifyShell[] = SHELLS): ShellName[] {
  const rewritten: ShellName[] = [];
  for (const shell of shells) {
    let current: string;
    try { current = readFileSync(shell.initFile(env), 'utf8'); } catch { continue; }
    const next = shell.snippet(opts);
    if (current === next) continue;
    writeStateFile(env, path.basename(shell.initFile(env)), next);
    rewritten.push(shell.name);
  }
  return rewritten;
}
