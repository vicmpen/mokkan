import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { notifyStateDir, removeNotifyState } from '../src/credentials.js';
import {
  LOCK_FILE, NOTIFIED_FILE, OSC_FILE, SHELL_FILE, STAMP_FILE, pruneNotified, readNotified, readShellFile, readStamp,
  tryLockPoll, writeNotified, writeShellFiles, writeStamp,
} from '../src/notify/state.js';

describe('notify state', () => {
  let base: string;
  let env: NodeJS.ProcessEnv;
  let dir: string;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'mokkan-notify-state-'));
    env = { XDG_CONFIG_HOME: base };
    dir = notifyStateDir(env);
  });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  it('lives in $XDG_CONFIG_HOME/mokkan/notify with 0700, files 0600 and no temp files left', () => {
    writeShellFiles(env, '- [abc] call mom\n', 'call mom\n');
    expect(dir).toBe(path.join(base, 'mokkan', 'notify'));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of [SHELL_FILE, OSC_FILE]) expect(statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual([OSC_FILE, SHELL_FILE]);
    expect(readShellFile(env)).toBe('- [abc] call mom\n');
  });

  it('tightens a state dir that was created too open', () => {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    writeStamp(env, 1);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('reads the stamp back, and treats a missing or non-numeric stamp as 0', () => {
    expect(readStamp(env)).toBe(0);
    writeStamp(env, 1_790_000_000.9);
    expect(readFileSync(path.join(dir, STAMP_FILE), 'utf8')).toBe('1790000000\n');
    expect(readStamp(env)).toBe(1_790_000_000);
    for (const bad of ['a[$(touch pwned)]', '12x', '-5', '', '1e9']) {
      writeFileSync(path.join(dir, STAMP_FILE), bad);
      expect(readStamp(env)).toBe(0);
    }
  });

  describe('poll lock', () => {
    it('lets one poll in at a time and frees the lock on release', () => {
      const release = tryLockPoll(env);
      expect(release).not.toBeNull();
      expect(tryLockPoll(env)).toBeNull();
      release!();
      expect(existsSync(path.join(dir, LOCK_FILE))).toBe(false);
      const again = tryLockPoll(env);
      expect(again).not.toBeNull();
      again!();
    });

    it('only one of many simultaneous attempts wins', () => {
      const results = Array.from({ length: 10 }, () => tryLockPoll(env));
      expect(results.filter((r) => r !== null)).toHaveLength(1);
      results.find((r) => r !== null)!();
    });

    it('takes over a stale lock left by a crashed poll', () => {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, LOCK_FILE);
      writeFileSync(file, '999999 dead\n');
      const old = (Date.now() - 60_000) / 1000;
      utimesSync(file, old, old);
      const release = tryLockPoll(env);
      expect(release).not.toBeNull();
      release!();
    });

    it('release never removes a lock another poll took over', () => {
      const release = tryLockPoll(env)!;
      const file = path.join(dir, LOCK_FILE);
      writeFileSync(file, 'someone else\n');
      release();
      expect(readFileSync(file, 'utf8')).toBe('someone else\n');
    });
  });

  describe('notified ids', () => {
    it('round-trips, and a malformed file or entry counts as not notified', () => {
      expect(readNotified(env)).toEqual({});
      writeNotified(env, { a: { done: true, attempts: 0 }, b: { done: false, attempts: 2 } });
      expect(readNotified(env)).toEqual({ a: { done: true, attempts: 0 }, b: { done: false, attempts: 2 } });
      writeFileSync(path.join(dir, NOTIFIED_FILE), '{oops');
      expect(readNotified(env)).toEqual({});
      writeFileSync(path.join(dir, NOTIFIED_FILE), JSON.stringify({ a: { done: 'yes', attempts: 0 }, b: { done: true, attempts: 1 } }));
      expect(readNotified(env)).toEqual({ b: { done: true, attempts: 1 } });
    });

    it('prunes ids that are no longer notifiable', () => {
      const state = { a: { done: true, attempts: 0 }, b: { done: false, attempts: 1 } };
      expect(pruneNotified(state, ['b', 'c'])).toEqual({ b: { done: false, attempts: 1 } });
    });
  });

  it('removeNotifyState drops the reminder text but keeps the generated init scripts', () => {
    writeShellFiles(env, 'x\n', 'x\n');
    writeStamp(env, 1);
    writeNotified(env, { a: { done: true, attempts: 0 } });
    writeFileSync(path.join(dir, 'init.zsh'), '# generated\n');
    removeNotifyState(env);
    expect(readdirSync(dir)).toEqual(['init.zsh']);
    removeNotifyState({ XDG_CONFIG_HOME: path.join(base, 'nothing-here') });
  });
});
