import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { removeBlock, removeBlockText, upsertBlock, upsertBlockText } from '../src/rcfile.js';
import { UserError } from '../src/errors.js';

const BEGIN = '# >>> mokkan notify >>>';
const END = '# <<< mokkan notify <<<';
const T = new Date('2026-10-05T10:00:00.000Z');

describe('rcfile', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'mokkan-rcfile-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const backups = (d = dir): string[] => readdirSync(d).filter((n) => n.includes('.mokkan-bak-'));

  it('creates a missing file (and its directory) 0644 without a backup', () => {
    const file = path.join(dir, 'conf.d', '.zshrc');
    expect(upsertBlock(file, BEGIN, END, 'source x', T)).toEqual({ action: 'created', backup: null });
    expect(readFileSync(file, 'utf8')).toBe(`${BEGIN}\nsource x\n${END}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o644 & ~process.umask());
    expect(backups(path.dirname(file))).toEqual([]);
  });

  it('appends to an existing file after a blank line, with one backup, keeping its mode', () => {
    const file = path.join(dir, '.bashrc');
    writeFileSync(file, 'alias ll="ls -l"\n', { mode: 0o600 });
    const r = upsertBlock(file, BEGIN, END, 'source x', T);
    expect(r.action).toBe('updated');
    expect(r.backup).toBe(`${file}.mokkan-bak-20261005T100000Z`);
    expect(readFileSync(r.backup!, 'utf8')).toBe('alias ll="ls -l"\n');
    expect(readFileSync(file, 'utf8')).toBe(`alias ll="ls -l"\n\n${BEGIN}\nsource x\n${END}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(backups()).toHaveLength(1);
  });

  it('leaves an identical block untouched: no write, no backup', () => {
    const file = path.join(dir, '.bashrc');
    const text = `a\n\n${BEGIN}\nsource x\n${END}\nb`; // no final newline either
    writeFileSync(file, text);
    const before = statSync(file).mtimeMs;
    expect(upsertBlock(file, BEGIN, END, 'source x', T)).toEqual({ action: 'unchanged', backup: null });
    expect(readFileSync(file, 'utf8')).toBe(text);
    expect(statSync(file).mtimeMs).toBe(before);
    expect(backups()).toEqual([]);
  });

  it('replaces a changed block in place', () => {
    const file = path.join(dir, '.bashrc');
    writeFileSync(file, `a\n${BEGIN}\nold\nold2\n${END}\nb\n`);
    const r = upsertBlock(file, BEGIN, END, 'new\n', T);
    expect(r.action).toBe('updated');
    expect(readFileSync(file, 'utf8')).toBe(`a\n${BEGIN}\nnew\n${END}\nb\n`);
    expect(backups()).toHaveLength(1);
  });

  it('removes a block with one backup, and reports absent for a missing block or file', () => {
    const file = path.join(dir, '.zshrc');
    writeFileSync(file, `a\n\n${BEGIN}\nsource x\n${END}\n`);
    const r = removeBlock(file, BEGIN, END, T);
    expect(r.action).toBe('removed');
    expect(readFileSync(file, 'utf8')).toBe('a\n');
    expect(backups()).toHaveLength(1);
    expect(removeBlock(file, BEGIN, END, T)).toEqual({ action: 'absent', backup: null });
    expect(removeBlock(path.join(dir, 'nope'), BEGIN, END, T)).toEqual({ action: 'absent', backup: null });
    expect(existsSync(path.join(dir, 'nope'))).toBe(false);
    expect(backups()).toHaveLength(1);
  });

  it('refuses a half block, changing nothing', () => {
    const file = path.join(dir, '.zshrc');
    writeFileSync(file, `a\n${BEGIN}\nx\n`);
    expect(() => upsertBlock(file, BEGIN, END, 'y', T)).toThrow(UserError);
    expect(() => removeBlock(file, BEGIN, END, T)).toThrow(/incomplete mokkan block/);
    expect(readFileSync(file, 'utf8')).toBe(`a\n${BEGIN}\nx\n`);
    expect(removeBlockText(`${END}\n${BEGIN}\n`, BEGIN, END).status).toBe('incomplete');
    expect(backups()).toEqual([]);
  });

  it('follows a symlinked rc file: the target changes, the link stays, the backup sits next to the link', () => {
    const real = path.join(dir, 'dotfiles', 'zshrc');
    mkdirSync(path.dirname(real));
    writeFileSync(real, 'a\n');
    const link = path.join(dir, '.zshrc');
    symlinkSync(real, link);
    const r = upsertBlock(link, BEGIN, END, 'source x', T);
    expect(r.action).toBe('updated');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe(`a\n\n${BEGIN}\nsource x\n${END}\n`);
    expect(r.backup).toBe(`${link}.mokkan-bak-20261005T100000Z`);
    expect(upsertBlock(link, BEGIN, END, 'source x', T).action).toBe('unchanged');
    expect(removeBlock(link, BEGIN, END, T).action).toBe('removed');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('a\n');
  });

  it('text helpers: an empty file gets the block alone; a trailing blank line is reused', () => {
    expect(upsertBlockText('', BEGIN, END, 'x')).toBe(`${BEGIN}\nx\n${END}\n`);
    expect(upsertBlockText('a\n\n', BEGIN, END, 'x')).toBe(`a\n\n${BEGIN}\nx\n${END}\n`);
    expect(removeBlockText(`${BEGIN}\nx\n${END}\n`, BEGIN, END)).toEqual({ status: 'removed', text: '' });
    expect(removeBlockText('a\n', BEGIN, END)).toEqual({ status: 'absent', text: 'a\n' });
  });
});
