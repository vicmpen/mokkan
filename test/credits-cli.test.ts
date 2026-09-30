import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderStatus, parseStatusArgs, type StatusOptions } from '../src/statusline.js';
import { readStatusCache, type StatusCache } from '../src/status-cache.js';
import { CliHarness, NOW } from './cli-harness.js';
import { FakeServer } from './fake-server.js';

const opts = (over: Partial<StatusOptions> = {}): StatusOptions => ({ ...parseStatusArgs([], {}), format: 'plain', timeZone: 'UTC', ...over });
const cache = (credit_balance: number | undefined, over: Partial<StatusCache> = {}): StatusCache => ({
  v: 2, server_url: 'http://x', email: 'a@example.com', attempted_at: NOW.toISOString(), fetched_at: NOW.toISOString(),
  error: null, reminders: [], ...(credit_balance === undefined ? {} : { credit_balance }), ...over,
});
const render = (c: StatusCache, o: Partial<StatusOptions> = {}) => renderStatus({ kind: 'cache', cache: c }, NOW, opts(o));
const open = (text: string) => ({
  id: 'a', text, state: 'acknowledged' as const, position: 1, due_at: null, created_at: NOW.toISOString(),
});

describe('status line credit balance', () => {
  it('shows the balance compactly', () => {
    expect(render(cache(480))).toBe('mokkan ✓ · 480 cr');
    expect(render(cache(480, { reminders: [open('buy milk'), { ...open('two'), id: 'b' }] }))).toBe('mokkan: "buy milk" +1 more · 480 cr');
  });
  it('warns below 20 credits, not at 20', () => {
    expect(render(cache(19))).toBe('mokkan ✓ · ⚠ 19 cr — mokkan buy');
    expect(render(cache(0))).toBe('mokkan ✓ · ⚠ 0 cr — mokkan buy');
    expect(render(cache(20))).toBe('mokkan ✓ · 20 cr');
    expect(render(cache(-1))).toContain('⚠ -1 cr');
  });
  it('the warning is coloured, plain balance is dim', () => {
    expect(render(cache(5), { format: 'ansi' })).toContain('\x1b[33m · ⚠ 5 cr — mokkan buy\x1b[0m');
    expect(render(cache(5), { format: 'tmux' })).toContain('#[fg=yellow]');
    expect(render(cache(0), { format: 'ansi' })).toContain('\x1b[31m');
  });
  it('shows nothing when the cache has no balance (older server)', () => {
    expect(render(cache(undefined))).toBe('mokkan ✓');
  });
  it('is dropped while the last refresh failed, and respects --width', () => {
    expect(render(cache(5, { error: 'offline' }))).not.toContain('cr');
    expect(render(cache(480), { width: 12 })).toBe('mo… · 480 cr');
    expect(render(cache(480), { width: 5 })).toBe('mokk…');
  });
  it('a long reminder text is shortened before the low-credit warning', () => {
    const long = cache(5, { reminders: [open('a very long reminder text that does not fit in the line at all')] });
    const out = render(long, { width: 50 });
    expect([...out]).toHaveLength(50);
    expect(out.endsWith(' · ⚠ 5 cr — mokkan buy')).toBe(true);
    expect(out.startsWith('mokkan: "a very')).toBe(true);
  });
  it('keeps the balance out of --no-text noise but still shows it', () => {
    expect(render(cache(50, { reminders: [open('x'), { ...open('y'), id: 'b' }] }), { showText: false })).toBe('mokkan: 2 open · 50 cr');
  });
});

describe('credits in the CLI', () => {
  let server: FakeServer;
  let h: CliHarness;
  beforeEach(async () => { server = new FakeServer(); await server.start(); h = new CliHarness(); });
  afterEach(async () => { await server.stop(); h.dispose(); });
  const run = (argv: string[], extra: { env?: NodeJS.ProcessEnv } = {}) => h.run(argv, { serverUrl: server.url, loggedIn: true, ...extra });

  const lists = () => {
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 1, reminders: [] } }));
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [], awaiting_ack: [] } }));
  };

  it('mokkan status prints Credits', async () => {
    server.withAccount({ balance: 480 });
    lists();
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Credits: 480\n');
  });
  it('mokkan status omits Credits for a server without credit_balance', async () => {
    server.on('GET', '/me', () => ({ status: 200, body: { email: 'a@example.com', session_active: false, last_heartbeat_at: null } }));
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 1, reminders: [] } }));
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [], awaiting_ack: [] } }));
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain('Credits');
  });

  it('statusline caches credit_balance from /me and renders it', async () => {
    server.withAccount({ balance: 12 });
    lists();
    const r = await run(['statusline', '--render', '--format', 'plain']);
    expect(r.stdout).toBe('mokkan ✓ · ⚠ 12 cr — mokkan buy\n');
    expect(readStatusCache(h.env())?.credit_balance).toBe(12);
  });
  it('statusline against a server without credit_balance shows no balance', async () => {
    server.on('GET', '/me', () => ({ status: 200, body: { email: 'a@example.com', session_active: false, last_heartbeat_at: null } }));
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 1, reminders: [] } }));
    const r = await run(['statusline', '--render', '--format', 'plain']);
    expect(r.stdout).toBe('mokkan ✓\n');
    expect(readStatusCache(h.env())?.credit_balance).toBeUndefined();
  });

  it('a 402 prints the server message and exits 3', async () => {
    server.withAccount({ balance: 0 });
    const r = await run(['push', 'hello']);
    expect(r.code).toBe(3);
    expect(r.stderr).toBe('Not enough credits: this needs 1, you have 0. Run `mokkan buy` to add credits.\n');
    expect(r.stdout).toBe('');
  });
  it('a 402 with a reserve (required > cost) adds a hint about pending reminder emails', async () => {
    server.on('POST', '/reminders', () => ({ status: 402, body: {
      error: 'insufficient_credits', message: 'Not enough credits: this needs 4, you have 2. Run `mokkan buy` to add credits.', balance: 2, cost: 1, required: 4 } }));
    const r = await run(['push', 'hello']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('(3 credits are kept for pending reminder emails; acknowledge shown reminders with `mokkan ack` or run `mokkan buy`)');
  });
  it('a 429 with retry-after prints minutes from 60 s up', async () => {
    server.on('POST', '/reminders', () => ({ status: 429, headers: { 'retry-after': '3600' }, body: { error: 'rate_limited', message: 'Too many requests' } }));
    const r = await run(['push', 'hello']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('try again in about 60 minutes');
  });
  it('buy --pack with an empty value is a usage error', async () => {
    const r = await run(['buy', '--pack', '']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--pack needs a value');
  });
  it('with --exit-zero the 402 message goes to stdout and the code is 0', async () => {
    server.withAccount({ balance: 0 });
    const r = await run(['push', 'hello', '--exit-zero']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Run `mokkan buy`');
  });
  it('other 4xx errors keep exit 1', async () => {
    server.withAccount({ balance: 5 });
    server.on('POST', '/reminders/pop', () => ({ status: 403, body: { error: 'forbidden', message: 'nope' } }));
    const r = await run(['pop']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('nope');
  });

  it('statusline keeps the last balance when only /me fails', async () => {
    server.withAccount({ balance: 12 });
    lists();
    await run(['statusline', '--render']);
    expect(readStatusCache(h.env())?.credit_balance).toBe(12);
    server.on('GET', '/me', () => ({ status: 500, body: { error: 'internal', message: 'boom' } }));
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 2, reminders: [open('fresh')] } }));
    await run(['statusline', '--render', '--refresh']);
    const c = readStatusCache(h.env());
    expect(c?.error).toBeNull();
    expect(c?.reminders.map((r) => r.text)).toEqual(['fresh']);
    expect(c?.credit_balance).toBe(12);
  });

  describe('hooks on 402', () => {
    const paid = () => server.on('POST', '/heartbeat', () => ({
      status: 402, body: { error: 'insufficient_credits', message: 'Not enough credits: this needs 1, you have 0. Run `mokkan buy` to add credits.' },
    }));
    it('exit 0, silent, and logged at most once per hour', async () => {
      paid();
      for (let i = 0; i < 3; i++) {
        const r = await run(['hook', 'stop']);
        expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
      }
      const log = readFileSync(`${h.configHome}/mokkan/hook.log`, 'utf8').trim().split('\n');
      expect(log).toHaveLength(1);
      expect(log[0]).toContain('mokkan buy');
    });
  });
});
