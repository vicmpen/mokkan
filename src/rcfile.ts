import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { UserError } from './errors.js';

/**
 * Edits of files the user owns (shell rc files, tmux.conf, settings.json): a marked block is inserted, replaced or
 * removed, an existing file that changes gets one `<file>.mokkan-bak-<ts>` backup first, and a file whose content
 * would not change is not touched at all (no write, no backup).
 */

/** Replaces `file` atomically through a symlink, keeping its mode, after a `<file>.mokkan-bak-<ts>` backup. Returns the backup path. */
export function replaceFile(file: string, content: string, now: Date): string {
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

export type BlockAction = 'created' | 'updated' | 'unchanged' | 'removed' | 'absent';

export interface BlockResult {
  action: BlockAction;
  /** The backup of the previous content, when an existing file was changed. */
  backup: string | null;
}

/** The lines of `text` without the final newline (an empty text has no lines). */
function linesOf(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

/** Where the block starts and ends (line indexes), null when there is none; throws on a half or reversed block. */
function findBlock(lines: string[], begin: string, end: string, file: string): { start: number; end: number } | null {
  const trimmed = lines.map((l) => l.trimEnd());
  const start = trimmed.indexOf(begin);
  const stop = trimmed.indexOf(end);
  if (start === -1 && stop === -1) return null;
  if (start === -1 || stop === -1 || stop < start) {
    throw new UserError(`${file} has an incomplete mokkan block; fix it by hand (nothing was changed).`);
  }
  return { start, end: stop };
}

/**
 * `text` without the marked block (and without the blank line that separated it, when it stood alone between blank
 * lines or at the end). `absent` when there is no block, `incomplete` when only one marker is there or they are reversed.
 */
export function removeBlockText(text: string, begin: string, end: string): { status: 'absent' | 'incomplete' | 'removed'; text: string } {
  const lines = linesOf(text);
  let block: { start: number; end: number } | null;
  try { block = findBlock(lines, begin, end, ''); } catch { return { status: 'incomplete', text }; }
  if (block === null) return { status: 'absent', text };
  const { start } = block;
  const next = [...lines.slice(0, start), ...lines.slice(block.end + 1)];
  if (start > 0 && next[start - 1]?.trim() === '' && (start === next.length || next[start]?.trim() === '')) next.splice(start - 1, 1);
  return { status: 'removed', text: next.length > 0 ? `${next.join('\n')}\n` : '' };
}

/** `text` with the marked block holding `body`: replaced in place when present, otherwise appended after a blank line. */
export function upsertBlockText(text: string, begin: string, end: string, body: string, file = 'the file'): string {
  const lines = linesOf(text);
  const blockLines = [begin, ...linesOf(body.endsWith('\n') ? body : `${body}\n`), end];
  const block = findBlock(lines, begin, end, file);
  let next: string[];
  if (block !== null) {
    const current = lines.slice(block.start, block.end + 1);
    if (current.length === blockLines.length && current.every((l, i) => l === blockLines[i])) return text;
    next = [...lines.slice(0, block.start), ...blockLines, ...lines.slice(block.end + 1)];
  } else {
    next = lines.length > 0 && lines[lines.length - 1]!.trim() !== '' ? [...lines, '', ...blockLines] : [...lines, ...blockLines];
  }
  return `${next.join('\n')}\n`;
}

/**
 * Inserts or replaces the block `begin`…`end` holding `body` in `file`. A missing file (and its directory) is created
 * 0644 without a backup; an existing one is replaced through symlinks with one backup, and only if it changes.
 * Throws a UserError, changing nothing, when the file holds only one of the markers.
 */
export function upsertBlock(file: string, begin: string, end: string, body: string, now: Date): BlockResult {
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, upsertBlockText('', begin, end, body, file), { mode: 0o644, flag: 'wx' });
    return { action: 'created', backup: null };
  }
  const text = readFileSync(file, 'utf8');
  const next = upsertBlockText(text, begin, end, body, file);
  if (next === text) return { action: 'unchanged', backup: null };
  return { action: 'updated', backup: replaceFile(file, next, now) };
}

/** Removes the block `begin`…`end` from `file` (one backup first). `absent` when the file or the block is not there. */
export function removeBlock(file: string, begin: string, end: string, now: Date): BlockResult {
  if (!existsSync(file)) return { action: 'absent', backup: null };
  const text = readFileSync(file, 'utf8');
  const r = removeBlockText(text, begin, end);
  if (r.status === 'incomplete') throw new UserError(`${file} has an incomplete mokkan block; fix it by hand (nothing was changed).`);
  if (r.status === 'absent') return { action: 'absent', backup: null };
  return { action: 'removed', backup: replaceFile(file, r.text, now) };
}
