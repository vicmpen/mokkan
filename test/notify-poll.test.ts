import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MokkanClient } from '../src/client.js';
import type { Credentials } from '../src/credentials.js';
import { notifyStateDir } from '../src/credentials.js';
import { saveNotifyConfig, type NotifyConfig } from '../src/notify/config.js';
import {
  LAST_FILE, PRIVACY_LINE, notifiable, pollLoop, pollOnce, readLastPoll, type PollClient, type PollDeps,
} from '../src/notify/poll.js';
import {
  OSC_FILE, SHELL_FILE, readNotified, readShellFile, readStamp, tryLockPoll, writeNotified, writeShellFiles,
} from '../src/notify/state.js';
import { bash } from '../src/notify/shells/bash.js';
import { ensureInitScripts } from '../src/notify/shells/index.js';
import { zsh } from '../src/notify/shells/zsh.js';
import type { SpawnOptions, SpawnResult, Spawner } from '../src/spawn.js';
import type { Reminder } from '../src/types.js';
import { reminder } from './cli-harness.js';
import { FakeServer, type FakeAccount } from './fake-server.js';

const T0 = new Date('2026-09-28T12:00:00.000Z');
const id = (n: number): string => `aaaa${String(n).padStart(4, '0')}-0000-0000-0000-00000000000${n % 10}`;

interface Call { file: string; args: string[]; opts?: SpawnOptions }

/** Records every spawn; answers with the scripted exit codes in turn (then the last one), default 0. */
function fakeSpawner(codes: number[] = [0]): { spawn: Spawner; calls: Call[] } {
  const calls: Call[] = [];
  const spawn: Spawner = async (file, args, opts) => {
    calls.push({ file, args, opts });
    const code = codes[Math.min(calls.length - 1, codes.length - 1)];
    return { code, stdout: '', stderr: '' } satisfies SpawnResult;
  };
  return { spawn, calls };
}

describe('notifiable', () => {
  const pending = (due: Reminder[], awaiting: Reminder[] = []) => ({ due, awaiting_ack: awaiting });

  it('keeps only fired scheduled reminders from due and awaiting_ack, once each, oldest first', () => {
    const push = reminder({ id: id(1), text: 'plain push' });
    const later = reminder({ id: id(2), text: 'not yet', due_at: '2026-09-28T12:00:01.000Z' });
    const fired = reminder({ id: id(3), text: 'fired', due_at: '2026-09-28T11:50:00.000Z' });
    const seen = reminder({ id: id(4), text: 'seen', state: 'delivered', due_at: '2026-09-28T11:40:00.000Z' });
    const exact = reminder({ id: id(5), text: 'exactly now', due_at: T0.toISOString() });
    const out = notifiable(pending([push, later, fired, exact], [seen, fired]), T0);
    expect(out.map((r) => r.text)).toEqual(['seen', 'fired', 'exactly now']);
  });

  it('excludes acknowledged reminders (the server does not return them) and orders ties by id', () => {
    const at = '2026-09-28T11:00:00.000Z';
    const b = reminder({ id: id(7), text: 'b', due_at: at });
    const a = reminder({ id: id(6), text: 'a', due_at: at, state: 'delivered' });
    expect(notifiable(pending([b], [a]), T0).map((r) => r.id)).toEqual([id(6), id(7)]);
    expect(notifiable(pending([], []), T0)).toEqual([]);
  });
});

describe('pollOnce', () => {
  let base: string;
  let env: NodeJS.ProcessEnv;
  let server: FakeServer;
  let acct: FakeAccount;
  let clock: Date;

  beforeEach(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'mokkan-notify-poll-'));
    env = { XDG_CONFIG_HOME: base, HOME: path.join(base, 'home') };
    server = new FakeServer();
    await server.start();
    acct = server.withAccount();
    clock = T0;
    setConfig({ desktop: true });
  });
  afterEach(async () => {
    // Read-only toward the server, in every test.
    expect(server.count('POST', '/heartbeat')).toBe(0);
    expect(server.count('POST', '/reminders/deliver')).toBe(0);
    await server.stop();
    rmSync(base, { recursive: true, force: true });
  });

  function setConfig(patch: Partial<NotifyConfig>): void { saveNotifyConfig(env, patch); }

  function creds(accessExpiresAt = '2099-01-01T00:00:00.000Z'): Credentials {
    return {
      server_url: server.url, email: 'a@example.com', access_token: 'access-0', access_expires_at: accessExpiresAt,
      refresh_token: 'refresh-0', refresh_expires_at: '2099-01-01T00:00:00.000Z',
    };
  }

  function client(baseUrl = server.url, c: Credentials = creds()): MokkanClient {
    return new MokkanClient({ baseUrl, credentials: c, now: () => clock });
  }

  function add(n: number, text: string, dueAt: string | null, state = 'due'): string {
    acct.reminders.set(id(n), {
      ...reminder({ id: id(n), text, due_at: dueAt }), state, position: n,
    });
    return id(n);
  }

  function deps(over: Partial<PollDeps> = {}): PollDeps {
    return {
      env, now: () => clock, client: client(), spawn: fakeSpawner().spawn, platform: 'linux',
      which: async (cmd) => cmd === 'notify-send', timeZone: 'UTC', ...over,
    };
  }

  const advance = (seconds: number): void => { clock = new Date(clock.getTime() + seconds * 1000); };
  const pendingCalls = (): number => server.count('GET', '/reminders/pending');
  const oscFile = (): string => readFileSync(path.join(notifyStateDir(env), OSC_FILE), 'utf8');

  it('notifies a fired reminder once, keeps it in shell.txt, and prunes it after the ack', async () => {
    const r = add(1, 'call mom', '2026-09-28T11:30:00.000Z');
    add(2, 'plain push', null);
    const { spawn, calls } = fakeSpawner();
    const first = await pollOnce(deps({ spawn }));
    expect(first).toEqual({ status: 'ok', shown: 1, notified: 1, backend: 'linux-notify-send' });
    expect(calls).toEqual([{
      file: 'notify-send', args: ['--app-name=mokkan', '--', 'mokkan', 'call mom (due 11:30)'], opts: { timeoutMs: 3000 },
    }]);
    expect(readNotified(env)).toEqual({ [r]: { done: true, attempts: 0 } });
    expect(readShellFile(env)).toBe('- [aaaa0001] call mom (due 11:30)\n');

    advance(61);
    expect((await pollOnce(deps({ spawn }))).status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(pendingCalls()).toBe(2);

    acct.reminders.get(r)!.state = 'acknowledged';
    advance(61);
    expect(await pollOnce(deps({ spawn }))).toMatchObject({ status: 'ok', shown: 0 });
    expect(readNotified(env)).toEqual({});
    expect(readShellFile(env)).toBe('');
    expect(calls).toHaveLength(1);
  });

  it('turns more than 3 new reminders into one summary that counts for all of them', async () => {
    const ids = [1, 2, 3, 4].map((n) => add(n, `r${n}`, `2026-09-28T11:0${n}:00.000Z`));
    const { spawn, calls } = fakeSpawner();
    expect(await pollOnce(deps({ spawn }))).toMatchObject({ status: 'ok', shown: 4, notified: 4 });
    expect(calls.map((c) => c.args)).toEqual([['--app-name=mokkan', '--', 'mokkan', '4 reminders due']]);
    expect(Object.keys(readNotified(env)).sort()).toEqual(ids);
    expect(Object.values(readNotified(env)).every((e) => e.done)).toBe(true);
  });

  it('a failed summary counts as a failed attempt for every reminder in it', async () => {
    const ids = [1, 2, 3, 4].map((n) => add(n, `r${n}`, '2026-09-28T11:00:00.000Z'));
    const { spawn } = fakeSpawner([1]);
    expect(await pollOnce(deps({ spawn }))).toMatchObject({ status: 'ok', notified: 0 });
    expect(readNotified(env)).toEqual(Object.fromEntries(ids.map((i) => [i, { done: false, attempts: 1 }])));
  });

  it('10 concurrent polls make exactly one request', async () => {
    add(1, 'x', '2026-09-28T11:00:00.000Z');
    const { spawn, calls } = fakeSpawner();
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => pollOnce(deps({ spawn }))));
    expect(pendingCalls()).toBe(1);
    expect(outcomes.filter((o) => o.status === 'ok')).toHaveLength(1);
    expect(outcomes.every((o) => ['ok', 'skipped-locked', 'skipped-fresh'].includes(o.status))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('with the server down the stamp still advances, the next poll inside the interval makes no request, files stay', async () => {
    writeShellFiles(env, '- [aaaa0001] old (due 11:00)\n', 'old\n');
    const down = deps({ client: client('http://127.0.0.1:1') });
    const first = await pollOnce(down);
    expect(first.status).toBe('error');
    expect(first.error).toMatch(/Cannot reach/);
    expect(readStamp(env)).toBe(T0.getTime() / 1000);
    advance(30);
    expect((await pollOnce(down)).status).toBe('skipped-fresh');
    expect(readShellFile(env)).toBe('- [aaaa0001] old (due 11:00)\n');
    expect(oscFile()).toBe('old\n');
    advance(31);
    expect((await pollOnce(deps())).status).toBe('ok');
    expect(readStamp(env)).toBe(T0.getTime() / 1000 + 61);
  });

  it('a failing backend is retried on the next polls and given up after 3 attempts', async () => {
    const r = add(1, 'x', '2026-09-28T11:00:00.000Z');
    const { spawn, calls } = fakeSpawner([1]);
    for (let i = 1; i <= 3; i++) {
      await pollOnce(deps({ spawn }));
      expect(readNotified(env)).toEqual({ [r]: { done: false, attempts: i } });
      advance(60);
    }
    await pollOnce(deps({ spawn }));
    expect(calls).toHaveLength(3);
    expect(readNotified(env)).toEqual({ [r]: { done: false, attempts: 3 } });
    expect(readShellFile(env)).toBe('- [aaaa0001] x (due 11:00)\n');
  });

  it('a retry succeeds: done after an earlier failure', async () => {
    const r = add(1, 'x', '2026-09-28T11:00:00.000Z');
    const { spawn } = fakeSpawner([1, 0]);
    await pollOnce(deps({ spawn }));
    advance(60);
    await pollOnce(deps({ spawn }));
    expect(readNotified(env)).toEqual({ [r]: { done: true, attempts: 1 } });
  });

  it('without credentials the files and notified.json are emptied', async () => {
    writeShellFiles(env, 'old\n', 'old\n');
    writeNotified(env, { [id(1)]: { done: true, attempts: 0 } });
    const { spawn, calls } = fakeSpawner();
    const out = await pollOnce(deps({ client: null, spawn }));
    expect(out).toMatchObject({ status: 'error', error: 'Not logged in. Run: mokkan login' });
    expect(readShellFile(env)).toBe('');
    expect(oscFile()).toBe('');
    expect(readNotified(env)).toEqual({});
    expect(calls).toHaveLength(0);
    expect(pendingCalls()).toBe(0);
  });

  it('an expired session empties the files and notified.json', async () => {
    server.on('POST', '/auth/refresh', () => ({ status: 401, body: { error: 'invalid_token', message: 'Invalid refresh token' } }));
    writeShellFiles(env, 'old\n', 'old\n');
    writeNotified(env, { [id(1)]: { done: true, attempts: 0 } });
    const out = await pollOnce(deps({ client: client(server.url, creds(T0.toISOString())) }));
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/Session expired/);
    expect(readShellFile(env)).toBe('');
    expect(oscFile()).toBe('');
    expect(readNotified(env)).toEqual({});
  });

  it('privacy_not_accepted writes the accept line and pops up nothing', async () => {
    server.withPrivacy();
    add(1, 'x', '2026-09-28T11:00:00.000Z');
    writeShellFiles(env, 'old\n', 'old\n');
    const { spawn, calls } = fakeSpawner();
    expect((await pollOnce(deps({ spawn }))).status).toBe('error');
    expect(readShellFile(env)).toBe(PRIVACY_LINE);
    expect(readShellFile(env)).toBe('privacy policy updated: run mokkan accept in a terminal\n');
    expect(oscFile()).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('a 429 keeps the files as they are', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 429, body: { error: 'rate_limited', message: 'Slow down' } }));
    writeShellFiles(env, 'old\n', 'old osc\n');
    writeNotified(env, { [id(1)]: { done: true, attempts: 0 } });
    expect(await pollOnce(deps())).toMatchObject({ status: 'error', error: 'Slow down' });
    expect(readShellFile(env)).toBe('old\n');
    expect(oscFile()).toBe('old osc\n');
    expect(readNotified(env)).toEqual({ [id(1)]: { done: true, attempts: 0 } });
  });

  it('a 5xx keeps the files as they are', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 503, body: { error: 'unavailable', message: 'down' } }));
    writeShellFiles(env, 'old\n', '');
    expect((await pollOnce(deps())).status).toBe('error');
    expect(readShellFile(env)).toBe('old\n');
  });

  it('writes shell.txt (0600) for two reminders, and osc.txt per the osc setting', async () => {
    add(1, 'first; with\x1b]52;c;evil\x07 text', '2026-09-28T11:30:00.000Z');
    add(2, 'second', '2026-09-28T11:45:00.000Z', 'delivered');
    setConfig({ osc: 'off' });
    await pollOnce(deps());
    const dir = notifyStateDir(env);
    expect(readShellFile(env)).toBe(
      '- [aaaa0001] first; with]52;c;evil text (due 11:30)\n' +
      '- [aaaa0002] second (due 11:45)\n');
    for (const f of [SHELL_FILE, OSC_FILE, LAST_FILE]) expect(statSync(path.join(dir, f)).mode & 0o777).toBe(0o600);
    expect(oscFile()).toBe('');

    setConfig({ osc: '9' });
    advance(60);
    await pollOnce(deps());
    expect(oscFile()).toBe('first with]52cevil text\nsecond\n');
    expect(oscFile()).not.toContain(';');
  });

  it('desktop off: no spawn, shell files still written', async () => {
    setConfig({ desktop: false });
    add(1, 'x', '2026-09-28T11:00:00.000Z');
    const { spawn, calls } = fakeSpawner();
    expect(await pollOnce(deps({ spawn }))).toEqual({ status: 'ok', shown: 1, notified: 0, backend: null });
    expect(calls).toHaveLength(0);
    expect(readShellFile(env)).toBe('- [aaaa0001] x (due 11:00)\n');
  });

  it('shell off: both files empty, desktop still notifies', async () => {
    setConfig({ shell: false, osc: '9' });
    add(1, 'x', '2026-09-28T11:00:00.000Z');
    writeShellFiles(env, 'old\n', 'old\n');
    const { spawn, calls } = fakeSpawner();
    await pollOnce(deps({ spawn }));
    expect(readShellFile(env)).toBe('');
    expect(oscFile()).toBe('');
    expect(calls).toHaveLength(1);
  });

  it('every channel off (or MOKKAN_NOTIFY=0): empties the files and makes no request', async () => {
    setConfig({ shell: false, desktop: false });
    writeShellFiles(env, 'old\n', 'old\n');
    expect((await pollOnce(deps())).status).toBe('skipped-disabled');
    expect(readShellFile(env)).toBe('');
    setConfig({ shell: true, desktop: true });
    writeShellFiles(env, 'old\n', 'old\n');
    expect((await pollOnce(deps({ env: { ...env, MOKKAN_NOTIFY: '0' } }))).status).toBe('skipped-disabled');
    expect(readShellFile(env)).toBe('');
    expect(oscFile()).toBe('');
    expect(pendingCalls()).toBe(0);
  });

  it('no available backend: nothing spawned, no attempt used, reported', async () => {
    const r = add(1, 'x', '2026-09-28T11:00:00.000Z');
    const { spawn, calls } = fakeSpawner();
    const out = await pollOnce(deps({ spawn, which: async () => false }));
    expect(out).toMatchObject({ status: 'ok', backend: null, noBackend: true, notified: 0 });
    expect(calls).toHaveLength(0);
    expect(readNotified(env)[r]).toBeUndefined();
  });

  it('gives up after the overall timeout and releases the lock', async () => {
    const hang: PollClient = { pending: () => new Promise(() => undefined) };
    writeShellFiles(env, 'old\n', '');
    const started = Date.now();
    const out = await pollOnce(deps({ client: hang, overallTimeoutMs: 50 }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toMatchObject({ status: 'error', error: 'timed out after 50 ms' });
    const release = tryLockPoll(env);
    expect(release).not.toBeNull();
    release!();
    expect(readShellFile(env)).toBe('old\n');
  });

  it('passes the notifier timeout to the spawn', async () => {
    add(1, 'x', '2026-09-28T11:00:00.000Z');
    const { spawn, calls } = fakeSpawner();
    await pollOnce(deps({ spawn, notifierTimeoutMs: 1234 }));
    expect(calls[0].opts).toEqual({ timeoutMs: 1234 });
  });

  it('records the last poll for notify status', async () => {
    add(1, 'x', '2026-09-28T11:00:00.000Z');
    await pollOnce(deps());
    expect(readLastPoll(env)).toEqual({
      at: T0.toISOString(), status: 'ok', shown: 1, notified: 1, backend: 'linux-notify-send',
    });
    advance(10);
    await pollOnce(deps()); // skipped-fresh is not recorded
    expect(readLastPoll(env)?.at).toBe(T0.toISOString());
  });

  it('pollLoop polls once per interval and stops when aborted', async () => {
    setConfig({ interval: 45 });
    const stop = new AbortController();
    const slept: number[] = [];
    const rounds = await pollLoop({
      ...deps(),
      signal: stop.signal,
      sleep: async (ms) => {
        slept.push(ms);
        advance(ms / 1000);
        if (slept.length === 3) stop.abort();
      },
    });
    expect(rounds).toBe(3);
    expect(slept).toEqual([45_000, 45_000, 45_000]);
    expect(pendingCalls()).toBe(3);
  });

  describe('init.<shell> regeneration', () => {
    const baked = { node: '/usr/bin/node', cli: '/opt/mokkan/dist/cli.js', version: '0.8.0' };
    const initPath = (name: string): string => path.join(notifyStateDir(env), `init.${name}`);
    const write = (name: string, content: string): void => {
      mkdirSync(notifyStateDir(env), { recursive: true });
      writeFileSync(initPath(name), content, { mode: 0o600 });
    };

    it('rewrites an existing init file whose version or settings differ, and creates none', async () => {
      setConfig({ interval: 90, osc: '9' });
      write('bash', bash.snippet({ ...baked, version: '0.7.0', interval: 60, osc: 'off' }));
      await pollOnce(deps(baked));
      const text = readFileSync(initPath('bash'), 'utf8');
      expect(text).toBe(bash.snippet({ ...baked, interval: 90, osc: '9' }));
      expect(text.split('\n')[0]).toBe('# generated by mokkan 0.8.0 (interval 90, osc 9); regenerate with: mokkan notify setup');
      expect(statSync(initPath('bash')).mode & 0o777).toBe(0o600);
      expect(existsSync(initPath('zsh'))).toBe(false);
      expect(existsSync(initPath('fish'))).toBe(false);
    });

    it('leaves an up-to-date file alone, and skips regeneration without baked paths or on a fresh stamp', async () => {
      const current = zsh.snippet({ ...baked, interval: 60, osc: 'off' });
      write('zsh', current);
      const before = statSync(initPath('zsh')).mtimeMs;
      await pollOnce(deps(baked));
      expect(statSync(initPath('zsh')).mtimeMs).toBe(before);

      write('zsh', 'old\n');
      advance(61);
      await pollOnce(deps()); // no node/cli/version: Task 7 wires them
      expect(readFileSync(initPath('zsh'), 'utf8')).toBe('old\n');
      advance(10);
      await pollOnce(deps(baked)); // skipped-fresh: no regeneration either
      expect(readFileSync(initPath('zsh'), 'utf8')).toBe('old\n');
      advance(61);
      await pollOnce(deps(baked));
      expect(readFileSync(initPath('zsh'), 'utf8')).toBe(current);
    });

    it('ensureInitScripts reports what it rewrote', () => {
      write('fish', 'stale\n');
      write('bash', bash.snippet({ ...baked, interval: 60, osc: 'off' }));
      expect(ensureInitScripts(env, { ...baked, interval: 60, osc: 'off' })).toEqual(['fish']);
      expect(ensureInitScripts(env, { ...baked, interval: 60, osc: 'off' })).toEqual([]);
    });
  });
});
