import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cleanText, formatWhen, parseStatusArgs, renderStatus, type StatusOptions } from '../src/statusline.js';
import { readStatusCache, statusCachePath, tryAcquireRefreshLock, writeStatusCache, type SlimReminder, type StatusCache } from '../src/status-cache.js';
import { CliHarness, NOW, reminder } from './cli-harness.js';
import { FakeServer } from './fake-server.js';

const opts = (over: Partial<StatusOptions> = {}): StatusOptions => ({
  ...parseStatusArgs([], {}), format: 'plain', timeZone: 'UTC', ...over,
});
let seq = 0;
/** Each call is "added" one minute after the previous one, so the last one listed is the newest. */
const slim = (over: Partial<SlimReminder> & { id: string; text: string }): SlimReminder => ({
  state: 'due', position: 1, due_at: null, created_at: new Date(NOW.getTime() - 3600_000 + ++seq * 60_000).toISOString(), ...over,
});
const cache = (reminders: SlimReminder[], over: Partial<StatusCache> = {}): StatusCache => ({
  v: 2, server_url: 'http://x', email: 'a@example.com', attempted_at: NOW.toISOString(),
  fetched_at: NOW.toISOString(), error: null, reminders, ...over,
});
const render = (reminders: SlimReminder[], o: Partial<StatusOptions> = {}, over: Partial<StatusCache> = {}) =>
  renderStatus({ kind: 'cache', cache: cache(reminders, over) }, NOW, opts(o));

const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const later = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

describe('renderStatus', () => {
  it('all clear', () => {
    expect(render([])).toBe('mokkan ✓');
    expect(render([], { format: 'ansi' })).toBe('\x1b[32mmokkan ✓\x1b[0m');
  });

  it('shows the most recently added open reminder and how many others are open', () => {
    expect(render([
      slim({ id: 'a', text: 'older', state: 'acknowledged' }),
      slim({ id: 'b', text: 'buy milk', state: 'acknowledged' }),
    ])).toBe('mokkan: "buy milk" +1 more');
    expect(render([slim({ id: 'a', text: 'only one', state: 'acknowledged' })])).toBe('mokkan: "only one"');
  });

  it('newest by creation time, not by stack position; ties go to the top of the stack', () => {
    expect(render([
      slim({ id: 'a', text: 'newest', position: 1, created_at: later(-1) }),
      slim({ id: 'b', text: 'older', position: 9, created_at: later(-5) }),
    ])).toBe('mokkan: "newest" +1 more');
    expect(render([
      slim({ id: 'a', text: 'low', position: 1, created_at: later(-1) }),
      slim({ id: 'b', text: 'top', position: 9, created_at: later(-1) }),
    ])).toBe('mokkan: "top" +1 more');
  });

  it('a scheduled newest reminder shows when it is due', () => {
    expect(render([slim({ id: 'a', text: 'call dentist', state: 'scheduled', due_at: later(300) })]))
      .toBe('mokkan: "call dentist" @17:00');
  });

  it('colour is the most urgent state on the list', () => {
    const ack = slim({ id: 'z', text: 'newest', state: 'acknowledged', created_at: later(0) });
    expect(render([slim({ id: 'a', text: 'x', due_at: minutesAgo(2) }), ack], { format: 'ansi' }))
      .toBe('mokkan: \x1b[33m"newest" +1 more\x1b[0m');
    expect(render([slim({ id: 'a', text: 'x', due_at: minutesAgo(25) }), ack], { format: 'ansi' }))
      .toBe('mokkan: \x1b[31m"newest" +1 more\x1b[0m');
    expect(render([slim({ id: 'a', text: 'x', due_at: minutesAgo(14) }), ack], { format: 'ansi', graceMs: 10 * 60_000 }))
      .toBe('mokkan: \x1b[31m"newest" +1 more\x1b[0m');
    expect(render([slim({ id: 'a', text: 'x', state: 'delivered', due_at: minutesAgo(60) }), ack], { format: 'ansi' }))
      .toBe('mokkan: \x1b[2m"newest" +1 more\x1b[0m');
    expect(render([slim({ id: 'a', text: 'x', state: 'scheduled', due_at: later(60) }), ack], { format: 'ansi' }))
      .toBe('mokkan: "newest" +1 more');
  });

  it('a scheduled reminder whose time has passed counts as due (scheduler not ticked yet)', () => {
    expect(render([slim({ id: 'a', text: 'x', state: 'scheduled', due_at: minutesAgo(1) })], { format: 'ansi' }))
      .toBe('mokkan: \x1b[33m"x"\x1b[0m');
  });

  it('--no-text shows only the count', () => {
    expect(render([slim({ id: 'a', text: 'secret' }), slim({ id: 'b', text: 'secret2' })], { showText: false }))
      .toBe('mokkan: 2 open');
  });

  it('offline with cached data, offline without, logged out', () => {
    expect(render([slim({ id: 'a', text: 'x', state: 'acknowledged' })], {}, { error: 'offline', fetched_at: minutesAgo(2) }))
      .toBe('mokkan: offline (2m old) · "x"');
    expect(render([], {}, { error: 'offline', fetched_at: minutesAgo(2) })).toBe('mokkan: offline (2m old) · ✓');
    expect(render([], {}, { error: 'offline', fetched_at: null })).toBe('mokkan: offline');
    expect(render([], {}, { error: 'logged_out' })).toBe('mokkan: logged out');
    expect(renderStatus({ kind: 'logged_out' }, NOW, opts())).toBe('mokkan: logged out');
  });

  it('strips control characters so a reminder cannot inject terminal escapes, and caps its length', () => {
    expect(cleanText('a\x1b[31mb\nc\u009bd')).toBe('a [31mb c d');
    expect(cleanText('x'.repeat(60))).toBe(`${'x'.repeat(39)}…`);
  });

  it('tmux format uses tmux styles and escapes #', () => {
    expect(render([slim({ id: 'a', text: 'issue #42', due_at: minutesAgo(1) })], { format: 'tmux' }))
      .toBe('mokkan: #[fg=yellow]"issue ##42"#[fg=default]');
  });

  it('truncates to the width', () => {
    expect(render([slim({ id: 'a', text: 'deploy check', due_at: minutesAgo(1) })], { width: 14 })).toBe('mokkan: "depl…');
  });

  it('formats times: today, this week, later', () => {
    expect(formatWhen(new Date('2026-09-28T17:05:00Z'), NOW, 'UTC')).toBe('17:05');
    expect(formatWhen(new Date('2026-09-30T09:00:00Z'), NOW, 'UTC')).toBe('Wed 09:00');
    expect(formatWhen(new Date('2026-10-12T09:00:00Z'), NOW, 'UTC')).toBe('Oct 12 09:00');
  });

  it('parses its own flags and ignores junk', () => {
    const o = parseStatusArgs(['--format', 'tmux', '--width=50', '--ttl', '10', '--grace', '5', '--no-text', '--bogus', '--format', 'nope'], { COLUMNS: '80' });
    expect(o).toMatchObject({ format: 'tmux', width: 50, ttlMs: 10_000, graceMs: 300_000, showText: false, refresh: false });
    expect(parseStatusArgs([], { COLUMNS: '80' }).width).toBe(80);
  });
});

describe('mokkan statusline', () => {
  let server: FakeServer;
  let h: CliHarness;
  let spawned: number;
  const spawnRefresh = () => { spawned++; };
  const scheduled = reminder({ id: 'aaaa1111-0000-0000-0000-000000000001', text: 'call dentist', state: 'scheduled', due_at: '2026-09-28T17:00:00.000Z' });

  beforeEach(async () => {
    server = new FakeServer();
    await server.start();
    h = new CliHarness();
    spawned = 0;
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 3, reminders: [scheduled] } }));
  });
  afterEach(async () => { await server.stop(); h.dispose(); });

  const run = (extra: string[] = [], o: { now?: Date } = {}) =>
    h.run(['statusline', '--render', '--format', 'plain', ...extra], { serverUrl: server.url, spawnRefresh, env: { TZ: 'UTC' }, ...o });

  it('logged out: no network, exit 0', async () => {
    const res = await run();
    expect(res).toMatchObject({ code: 0, stdout: 'mokkan: logged out\n', stderr: '' });
    expect(server.requests).toHaveLength(0);
  });

  it('cold: one synchronous fetch of every non-done reminder, written to a 0600 cache', async () => {
    h.saveCreds(server.url);
    const res = await run();
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/^mokkan: "call dentist" @\d\d:00\n$/);
    expect(server.last('GET', '/reminders')?.query.get('scope')).toBe('all');
    const file = statusCachePath(h.env());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readStatusCache(h.env())?.reminders.map((r) => r.text)).toEqual(['call dentist']);
    expect(spawned).toBe(0);
  });

  it('fresh cache: no network; stale cache: renders it and starts one background refresh', async () => {
    h.saveCreds(server.url);
    await run();
    await run(['--ttl', '30'], { now: new Date(NOW.getTime() + 10_000) });
    expect(server.count('GET', '/reminders')).toBe(1);
    expect(spawned).toBe(0);
    const res = await run(['--ttl', '30'], { now: new Date(NOW.getTime() + 31_000) });
    expect(res.stdout).toContain('call dentist');
    expect(server.count('GET', '/reminders')).toBe(1);
    expect(spawned).toBe(1);
  });

  it('--refresh updates the cache; a held lock makes it a no-op', async () => {
    h.saveCreds(server.url);
    await run();
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 4, reminders: [] } }));
    const release = tryAcquireRefreshLock(h.env())!;
    expect(await run(['--refresh'])).toMatchObject({ code: 0, stdout: '' });
    expect(readStatusCache(h.env())?.reminders).toHaveLength(1);
    release();
    await run(['--refresh']);
    expect(readStatusCache(h.env())?.reminders).toHaveLength(0);
    expect((await run()).stdout).toBe('mokkan ✓\n');
  });

  it('server down: keeps the last data and says offline; cold with no data says offline', async () => {
    h.saveCreds(server.url);
    await run();
    await server.stop();
    await run(['--refresh'], { now: new Date(NOW.getTime() + 120_000) });
    const res = await run([], { now: new Date(NOW.getTime() + 125_000) });
    expect(res.stdout).toMatch(/^mokkan: offline \(2m old\) · "call dentist" @\d\d:00\n$/);
    writeFileSync(statusCachePath(h.env()), 'garbage');
    expect((await run()).stdout).toBe('mokkan: offline\n');
  });

  it('a cache for another account or server is ignored', async () => {
    h.saveCreds(server.url);
    writeStatusCache({
      v: 2, server_url: 'http://elsewhere', email: 'a@example.com', attempted_at: NOW.toISOString(),
      fetched_at: NOW.toISOString(), error: null, reminders: [],
    }, h.env());
    expect((await run()).stdout).toContain('call dentist');
  });

  it('list-changing commands invalidate the cache; reads do not', async () => {
    h.saveCreds(server.url);
    server.on('POST', '/reminders', () => ({ status: 201, body: { version: 5, reminder: reminder({ id: 'bbbb', text: 'new' }) } }));
    await run();
    await h.run(['list', '--all'], { serverUrl: server.url });
    expect(existsSync(statusCachePath(h.env()))).toBe(true);
    await h.run(['push', 'new'], { serverUrl: server.url });
    expect(existsSync(statusCachePath(h.env()))).toBe(false);
  });

  it('corrupt credentials: still prints a line and exits 0', async () => {
    h.saveCreds(server.url);
    writeFileSync(`${h.configHome}/mokkan/credentials.json`, '{', { mode: 0o600 });
    expect(await run()).toMatchObject({ code: 0, stdout: 'mokkan: credentials error\n' });
    expect(readFileSync(`${h.configHome}/mokkan/credentials.json`, 'utf8')).toBe('{');
  });
});
