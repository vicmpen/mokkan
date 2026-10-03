import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { credentialsPath } from '../src/credentials.js';
import { parseArgs } from '../src/cli.js';
import { CliHarness, NOW, reminder } from './cli-harness.js';
import { FakeServer, tokenPair } from './fake-server.js';

describe('parseArgs', () => {
  it('splits command, positionals and flags', () => {
    expect(parseArgs(['push', 'buy', 'milk', '--json'])).toEqual({ command: 'push', args: ['buy', 'milk'], flags: { json: true } });
    expect(parseArgs(['register', '--complete', 'a@b.c', '--otp', '123456'])).toEqual({ command: 'register', args: ['a@b.c'], flags: { complete: true, otp: '123456' } });
    expect(parseArgs(['watch', '--interval=30', '--once'])).toEqual({ command: 'watch', args: [], flags: { interval: '30', once: true } });
    expect(parseArgs([])).toEqual({ command: undefined, args: [], flags: {} });
  });

  it('keeps unknown --words as positional text and stops flag parsing at --', () => {
    expect(parseArgs(['push', 'check', 'the', '--force', 'flag'])).toEqual({ command: 'push', args: ['check', 'the', '--force', 'flag'], flags: {} });
    const dashed = parseArgs(['push', '--', '--json']);
    expect(dashed).toEqual({ command: 'push', args: ['--json'], flags: {} });
    expect(dashed.flags.json).toBeUndefined();
    expect(parseArgs(['list', '--json'])).toEqual({ command: 'list', args: [], flags: { json: true } });
  });

  it('--argline as the first argument splits one string on whitespace; later args parse as usual', () => {
    expect(parseArgs(['--argline', "push don't forget #123", '--exit-zero'])).toEqual({
      command: 'push', args: ["don't", 'forget', '#123'], flags: { 'exit-zero': true },
    });
    // An older command file's retired --no-color is ignored, not turned into reminder text.
    expect(parseArgs(['--argline', 'push x', '--exit-zero', '--no-color'])).toEqual({
      command: 'push', args: ['x'], flags: { 'exit-zero': true },
    });
    expect(parseArgs(['--argline', '  in\t10m  call   bob '])).toEqual({ command: 'in', args: ['10m', 'call', 'bob'], flags: {} });
    expect(parseArgs(['--argline', 'list --all'])).toEqual({ command: 'list', args: [], flags: { all: true } });
    expect(parseArgs(['--argline', ''])).toEqual(parseArgs([]));
    expect(parseArgs(['--argline'])).toEqual(parseArgs([]));
    // Only in first position: elsewhere it is ordinary reminder text.
    expect(parseArgs(['push', '--argline', 'x'])).toEqual({ command: 'push', args: ['--argline', 'x'], flags: {} });
  });

  it('edit and buy flags are parsed only for their own command', () => {
    expect(parseArgs(['edit', '2', '--in', '2h', 'call', 'mom', '--all'])).toEqual({
      command: 'edit', args: ['2', 'call', 'mom'], flags: { in: '2h', all: true },
    });
    expect(parseArgs(['edit', '1', '--at=2030-01-01T00:00:00Z', '--clear-due', '--text', 'x'])).toEqual({
      command: 'edit', args: ['1'], flags: { at: '2030-01-01T00:00:00Z', 'clear-due': true, text: 'x' },
    });
    expect(parseArgs(['edit', '1', '--in', '2h', '--text']).flags).toEqual({ in: '2h', text: '' });
    expect(parseArgs(['buy', '--pack', 'credits_1500', '--no-open'])).toEqual({ command: 'buy', args: [], flags: { pack: 'credits_1500', 'no-open': true } });
    expect(parseArgs(['push', 'meet', 'bob', '--at', '5pm', 'sharp'])).toEqual({
      command: 'push', args: ['meet', 'bob', '--at', '5pm', 'sharp'], flags: {},
    });
    expect(parseArgs(['constructor', '--text', 'x']).args).toEqual(['--text', 'x']);
    expect(parseArgs(['edit', '1', '--pack', 'p', '--no-open']).args).toEqual(['1', '--pack', 'p', '--no-open']);
    expect(parseArgs(['--argline', 'edit 2 --in 2h call mom at 5', '--exit-zero'])).toEqual({
      command: 'edit', args: ['2', 'call', 'mom', 'at', '5'], flags: { in: '2h', 'exit-zero': true },
    });
  });

  it('--argline text cannot swallow or override the fixed flags that follow it', () => {
    expect(parseArgs(['--argline', 'push see -- the big one', '--exit-zero'])).toEqual({
      command: 'push', args: ['see', 'the', 'big', 'one'], flags: { 'exit-zero': true },
    });
    const noValue = parseArgs(['--argline', 'heartbeat --source', '--exit-zero']);
    expect(noValue.command).toBe('heartbeat');
    expect(noValue.flags.source).toBeUndefined();
    expect(noValue.flags['exit-zero']).toBe(true);
    const dashed = parseArgs(['--argline', 'push -- --json', '--exit-zero']);
    expect(dashed).toEqual({ command: 'push', args: ['--json'], flags: { 'exit-zero': true } });
    expect(dashed.flags.json).toBeUndefined();
    // The fixed flags win over the same flag typed by the user.
    expect(parseArgs(['--argline', 'list --exit-zero', '--exit-zero']).flags['exit-zero']).toBe(true);
  });
});

describe('mokkan CLI', () => {
  let server: FakeServer;
  let h: CliHarness;
  const r1 = reminder({ id: 'aaaa1111-0000-0000-0000-000000000001', text: 'first', position: 1 });
  const r2 = reminder({ id: 'aaaa2222-0000-0000-0000-000000000002', text: 'second', position: 2, state: 'delivered' });
  const r3 = reminder({ id: 'aaaa2233-0000-0000-0000-000000000003', text: 'third', position: 3 });

  beforeEach(async () => { server = new FakeServer(); await server.start(); h = new CliHarness(); });
  afterEach(async () => { await server.stop(); h.dispose(); });

  it('fails with exit 1 when not logged in', async () => {
    const res = await h.run(['list'], { serverUrl: server.url });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Not logged in');
    expect(server.requests).toHaveLength(0);
  });

  it('a rejected refresh token: exit 1, "Session expired", credentials removed', async () => {
    server.on('GET', '/reminders', () => ({ status: 401, body: { error: 'unauthorized', message: 'expired' } }));
    server.on('POST', '/auth/refresh', () => ({ status: 401, body: { error: 'invalid_token', message: 'Refresh token is invalid, expired or already used' } }));
    const res = await h.run(['list'], { serverUrl: server.url, loggedIn: true });
    expect(res).toEqual({ code: 1, stdout: '', stderr: 'Session expired on this machine; run: mokkan login\n' });
    expect(existsSync(credentialsPath(h.env()))).toBe(false);
    const again = await h.run(['list'], { serverUrl: server.url });
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('Not logged in');
  });

  it('prints an unknown command as a user error with usage', async () => {
    const res = await h.run(['frobnicate'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Unknown command "frobnicate"');
    expect(res.stderr).toContain('Usage: mokkan');
  });

  it('lists active reminders top of stack first', async () => {
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 1, reminders: [r3, r2, r1] } }));
    const res = await h.run([], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(
      ' 1. [aaaa2233] due          third\n' +
      ' 2. [aaaa2222] delivered    second\n' +
      ' 3. [aaaa1111] due          first\n');
    expect(server.last('GET', '/reminders')?.query.get('scope')).toBe('active');
  });

  it('list --all asks for scope=all and --json prints raw JSON', async () => {
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 9, reminders: [] } }));
    const res = await h.run(['list', '--all', '--json'], { serverUrl: server.url, loggedIn: true });
    expect(res.stdout).toBe('{"version":9,"reminders":[]}\n');
    expect(server.last('GET', '/reminders')?.query.get('scope')).toBe('all');
  });

  it('push sends the joined text', async () => {
    server.on('POST', '/reminders', (req) => ({ status: 201, body: { version: 2, reminder: reminder({ id: 'bbbb0000-0000-0000-0000-000000000000', text: (req.body as { text: string }).text }) } }));
    const res = await h.run(['push', 'buy', 'milk'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(0);
    expect(server.last('POST', '/reminders')?.body).toEqual({ text: 'buy milk' });
    expect(res.stdout).toBe('Pushed [bbbb0000] buy milk\n');
  });

  it('push without text is a user error', async () => {
    const res = await h.run(['push'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Usage: mokkan push');
  });

  it('pop prints the popped item; empty list exits 1', async () => {
    server.on('POST', '/reminders/pop', () => ({ status: 200, body: { version: 3, reminder: r3 } }));
    let res = await h.run(['pop'], { serverUrl: server.url, loggedIn: true });
    expect(res).toEqual({ code: 0, stdout: 'Popped [aaaa2233] third\n', stderr: '' });
    server.on('POST', '/reminders/pop', () => ({ status: 404, body: { error: 'empty', message: 'List is empty' } }));
    res = await h.run(['pop'], { serverUrl: server.url, loggedIn: true });
    expect(res).toEqual({ code: 1, stdout: 'List is empty.\n', stderr: '' });
  });

  it('pop and dequeue on an empty list with --json print a JSON error and exit 1', async () => {
    const empty = () => ({ status: 404, body: { error: 'empty', message: 'List is empty' } });
    server.on('POST', '/reminders/pop', empty);
    server.on('POST', '/reminders/dequeue', empty);
    for (const cmd of ['pop', 'dequeue']) {
      const res = await h.run([cmd, '--json'], { serverUrl: server.url, loggedIn: true });
      expect(res).toEqual({ code: 1, stdout: '{"error":"empty","message":"List is empty."}\n', stderr: '' });
    }
  });

  describe('--exit-zero (slash command mode)', () => {
    it('pop on an empty list exits 0 with the message on stdout', async () => {
      server.on('POST', '/reminders/pop', () => ({ status: 404, body: { error: 'empty', message: 'List is empty' } }));
      const res = await h.run(['pop', '--exit-zero'], { serverUrl: server.url, loggedIn: true });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('List is empty.');
      expect(res.stderr).toBe('');
    });

    it('list while logged out exits 0 with the error on stdout', async () => {
      const res = await h.run(['list', '--exit-zero'], { serverUrl: server.url });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Not logged in');
      expect(res.stderr).toBe('');
    });

    it('an unreachable server exits 0 with the error on stdout', async () => {
      const res = await h.run(['list', '--exit-zero'], { serverUrl: 'http://127.0.0.1:1', loggedIn: true });
      expect(res.code).toBe(0);
      expect(res.stdout).not.toBe('');
      expect(res.stderr).toBe('');
    });

    it('login a@b.c (non-TTY, no MOKKAN_PASSWORD) exits 0 with the terminal hint', async () => {
      const res = await h.run(['login', 'a@b.c', '--exit-zero'], { serverUrl: server.url });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Finish in a terminal: mokkan login a@b.c');
    });
  });

  describe('--argline (slash command arguments as one string)', () => {
    it('pushes text with quotes and # intact', async () => {
      server.on('POST', '/reminders', (req) => ({ status: 201, body: { version: 2, reminder: reminder({ id: 'bbbb0000-0000-0000-0000-000000000000', text: (req.body as { text: string }).text }) } }));
      const res = await h.run(['--argline', "push don't forget #123", '--exit-zero'], { serverUrl: server.url, loggedIn: true });
      expect(res.code).toBe(0);
      expect(server.last('POST', '/reminders')?.body).toEqual({ text: "don't forget #123" });
      expect(res.stdout).toBe("Pushed [bbbb0000] don't forget #123\n");
    });

    it('surrounding whitespace is ignored: "  pop  " behaves like pop', async () => {
      server.on('POST', '/reminders/pop', () => ({ status: 200, body: { version: 3, reminder: r3 } }));
      const res = await h.run(['--argline', '  pop  '], { serverUrl: server.url, loggedIn: true });
      expect(res).toEqual({ code: 0, stdout: 'Popped [aaaa2233] third\n', stderr: '' });
      expect(server.count('POST', '/reminders/pop')).toBe(1);
    });

    it('an empty string behaves like no command (the active list)', async () => {
      server.on('GET', '/reminders', () => ({ status: 200, body: { version: 1, reminders: [r1] } }));
      const plain = await h.run([], { serverUrl: server.url, loggedIn: true });
      const viaArgline = await h.run(['--argline', ''], { serverUrl: server.url, loggedIn: true });
      expect(viaArgline).toEqual(plain);
      expect(plain.stdout).toBe(' 1. [aaaa1111] due          first\n');
      expect(server.count('GET', '/reminders')).toBe(2);
    });
  });

  it('push keeps flag-like words in the reminder text', async () => {
    server.on('POST', '/reminders', (req) => ({ status: 201, body: { version: 2, reminder: reminder({ id: 'bbbb0000-0000-0000-0000-000000000000', text: (req.body as { text: string }).text }) } }));
    await h.run(['push', 'check', 'the', '--force', 'flag'], { serverUrl: server.url, loggedIn: true });
    expect(server.last('POST', '/reminders')?.body).toEqual({ text: 'check the --force flag' });
  });

  it('edit and buy flags stay in the text of push and in (mokkan push meet bob --at 5pm sharp)', async () => {
    server.on('POST', '/reminders', (req) => ({ status: 201, body: { version: 2, reminder: reminder({ id: 'bbbb0000-0000-0000-0000-000000000000', text: (req.body as { text: string }).text }) } }));
    await h.run(['push', 'meet', 'bob', '--at', '5pm', 'sharp'], { serverUrl: server.url, loggedIn: true });
    expect(server.last('POST', '/reminders')?.body).toEqual({ text: 'meet bob --at 5pm sharp' });
    await h.run(['in', '10m', 'pay', '--text', 'x', '--in', '2h', '--clear-due', '--pack', 'p', '--no-open'], { serverUrl: server.url, loggedIn: true });
    expect((server.last('POST', '/reminders')?.body as { text: string }).text).toBe('pay --text x --in 2h --clear-due --pack p --no-open');
  });

  it('dequeue prints the dequeued item', async () => {
    server.on('POST', '/reminders/dequeue', () => ({ status: 200, body: { version: 3, reminder: r1 } }));
    const res = await h.run(['dequeue'], { serverUrl: server.url, loggedIn: true });
    expect(res.stdout).toBe('Dequeued [aaaa1111] first\n');
  });

  it('in <duration> <text> schedules relative to now', async () => {
    server.on('POST', '/reminders', (req) => {
      const body = req.body as { text: string; due_at: string };
      return { status: 201, body: { version: 2, reminder: reminder({ id: 'cccc0000-0000-0000-0000-000000000000', text: body.text, state: 'scheduled', due_at: body.due_at }) } };
    });
    const res = await h.run(['in', '10m', 'call', 'mom'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(0);
    expect(server.last('POST', '/reminders')?.body).toEqual({ text: 'call mom', due_at: '2026-09-28T12:10:00.000Z' });
    expect(res.stdout).toBe('Scheduled [cccc0000] "call mom" for 2026-09-28T12:10:00.000Z (in 10m)\n');
  });

  it('in with a bad duration is a user error', async () => {
    const res = await h.run(['in', 'soon', 'x'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Invalid duration "soon"');
    expect(server.requests).toHaveLength(0);
  });

  it('in with a duration too large for a date is a user error', async () => {
    const res = await h.run(['in', '99999999d', 'x'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(1);
    expect(res.stderr).toBe('duration is too large\n');
    expect(server.requests).toHaveLength(0);
  });

  it('ack resolves id prefixes against the active list and sends the version', async () => {
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 5, reminders: [r3, r2, r1] } }));
    server.on('POST', '/reminders/ack', (req) => ({ status: 200, body: { version: 6, acknowledged: (req.body as { ids: string[] }).ids } }));
    const res = await h.run(['ack', 'aaaa1', 'aaaa2222'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(0);
    expect(server.last('POST', '/reminders/ack')?.body).toEqual({ ids: [r1.id, r2.id], expected_version: 5 });
    expect(res.stdout).toBe('Acknowledged 2 reminder(s).\n');
  });

  it('done finishes reminders by id prefix against the open list, chaining versions; undone reopens from the history', async () => {
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 5, reminders: [r3, r2, r1] } }));
    let version = 5;
    server.on('POST', '/reminders/:id/done', (req) => {
      const id = req.path.split('/')[2];
      const r = [r1, r2, r3].find((x) => x.id === id)!;
      const body = req.body as { done: boolean };
      return { status: 200, body: { version: ++version, reminder: { ...r, state: body.done ? 'done' : 'due' } } };
    });
    const res = await h.run(['done', 'aaaa1', 'aaaa2222'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('Done [aaaa1111] first\nDone [aaaa2222] second\n');
    const calls = server.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/done'));
    expect(calls.map((q) => q.path)).toEqual([`/reminders/${r1.id}/done`, `/reminders/${r2.id}/done`]);
    expect(calls.map((q) => q.body)).toEqual([{ done: true, expected_version: 5 }, { done: true, expected_version: 6 }]);
    expect(server.last('GET', '/reminders')?.query.get('scope')).toBe('all');

    const back = await h.run(['undone', 'aaaa1', '--json'], { serverUrl: server.url, loggedIn: true });
    expect(back.code).toBe(0);
    expect(JSON.parse(back.stdout)).toEqual({ reopened: [r1.id] });
    expect(server.last('GET', '/reminders')?.query.get('scope')).toBe('done');
    expect(server.last('POST', `/reminders/${r1.id}/done`)?.body).toEqual({ done: false, expected_version: 5 });
  });

  it('bare `mokkan done` still lists the history; done/undone without ids print usage', async () => {
    server.on('GET', '/reminders', (req) => ({ status: 200, body: { version: 1, reminders: req.query.get('scope') === 'done' ? [r1] : [] } }));
    const hist = await h.run(['done'], { serverUrl: server.url, loggedIn: true });
    expect(hist.code).toBe(0);
    expect(hist.stdout).toContain('first');
    const res = await h.run(['undone'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Usage: mokkan undone <id-prefix>...');
  });

  it('ack rejects ambiguous and unknown prefixes', async () => {
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 5, reminders: [r3, r2, r1] } }));
    let res = await h.run(['ack', 'aaaa22'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('"aaaa22" is ambiguous: aaaa2222, aaaa2233');
    res = await h.run(['ack', 'zzzz'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('No active reminder matches "zzzz"');
    expect(server.count('POST', '/reminders/ack')).toBe(0);
  });

  it('ack retries once after a stale version', async () => {
    let version = 5;
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: version++, reminders: [r1] } }));
    let acks = 0;
    server.on('POST', '/reminders/ack', (req) => {
      acks++;
      const body = req.body as { expected_version: number };
      return body.expected_version === 6
        ? { status: 200, body: { version: 7, acknowledged: [r1.id] } }
        : { status: 409, body: { error: 'stale', message: 'stale', version: 6, reminders: [r1] } };
    });
    const res = await h.run(['ack', 'aaaa1'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(0);
    expect(acks).toBe(2);
    expect(server.count('GET', '/reminders')).toBe(2);
  });

  it('ack all sends {all:true}', async () => {
    server.on('POST', '/reminders/ack', () => ({ status: 200, body: { version: 6, acknowledged: [r1.id, r2.id] } }));
    const res = await h.run(['ack', 'all'], { serverUrl: server.url, loggedIn: true });
    expect(server.last('POST', '/reminders/ack')?.body).toEqual({ all: true });
    expect(res.stdout).toBe('Acknowledged 2 reminder(s).\n');
  });

  it('pending prints the hook block or "Nothing pending."', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [r1], awaiting_ack: [r2] } }));
    let res = await h.run(['pending'], { serverUrl: server.url, loggedIn: true });
    expect(res.stdout).toBe('Reminders (mokkan):\n- [aaaa1111] first\n1 reminder(s) awaiting acknowledgment — run /mokkan ack <id> or /mokkan ack all\n');
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [], awaiting_ack: [] } }));
    res = await h.run(['pending'], { serverUrl: server.url, loggedIn: true });
    expect(res.stdout).toBe('Nothing pending.\n');
  });

  it('register (non-TTY) starts the OTP flow and tells the user how to finish', async () => {
    server.on('POST', '/auth/register/start', () => ({ status: 202, body: { ok: true } }));
    const res = await h.run(['register', 'new@example.com'], { serverUrl: server.url });
    expect(res.code).toBe(0);
    expect(server.last('POST', '/auth/register/start')?.body).toEqual({ email: 'new@example.com' });
    expect(res.stdout).toContain('One-time code sent to new@example.com');
    expect(res.stdout).toContain('mokkan register --complete new@example.com');
    expect(existsSync(credentialsPath(h.env()))).toBe(false);
  });

  it('register --complete with --otp and MOKKAN_PASSWORD saves credentials with mode 600', async () => {
    server.on('POST', '/auth/register/complete', () => ({ status: 201, body: tokenPair('reg') }));
    const res = await h.run(['register', '--complete', 'new@example.com', '--otp', '123456'], { serverUrl: server.url, env: { MOKKAN_PASSWORD: 'a long password' } });
    expect(res.code).toBe(0);
    expect(server.last('POST', '/auth/register/complete')?.body).toEqual({ email: 'new@example.com', otp: '123456', password: 'a long password' });
    expect(res.stdout).toBe(`Registered and logged in as new@example.com (${server.url}).\n`);
    const file = credentialsPath(h.env());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ email: 'new@example.com', access_token: 'access-reg', server_url: server.url });
  });

  it('register (TTY) prompts for code and hidden password after sending the OTP', async () => {
    server.on('POST', '/auth/register/start', () => ({ status: 202, body: { ok: true } }));
    server.on('POST', '/auth/register/complete', () => ({ status: 201, body: tokenPair('tty') }));
    const res = await h.run(['register', 'new@example.com'], { serverUrl: server.url, isTTY: true, answers: ['654321', 'another long pw'] });
    expect(res.code).toBe(0);
    expect(server.last('POST', '/auth/register/complete')?.body).toEqual({ email: 'new@example.com', otp: '654321', password: 'another long pw' });
  });

  it('register rejects a short password before calling the server', async () => {
    const res = await h.run(['register', '--complete', 'new@example.com', '--otp', '123456'], { serverUrl: server.url, env: { MOKKAN_PASSWORD: 'short' } });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('at least 10 characters');
    expect(server.count('POST', '/auth/register/complete')).toBe(0);
  });

  it('login with MOKKAN_PASSWORD saves credentials; wrong password exits 1', async () => {
    server.on('POST', '/auth/login', (req) => (req.body as { password: string }).password === 'a long password'
      ? { status: 200, body: tokenPair('login') }
      : { status: 401, body: { error: 'invalid_credentials', message: 'Invalid email or password' } });
    let res = await h.run(['login', 'a@example.com'], { serverUrl: server.url, env: { MOKKAN_PASSWORD: 'a long password' } });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(`Logged in as a@example.com (${server.url}).\n`);
    expect(existsSync(credentialsPath(h.env()))).toBe(true);
    res = await h.run(['login', 'a@example.com'], { serverUrl: server.url, env: { MOKKAN_PASSWORD: 'wrong password!' } });
    expect(res.code).toBe(1);
    expect(res.stderr).toBe('Invalid email or password\n');
  });

  it('login without a password source (non-TTY) tells the user to finish in a terminal and exits 0', async () => {
    const res = await h.run(['login', 'a@b.c'], { serverUrl: server.url });
    expect(res).toEqual({ code: 0, stdout: 'Finish in a terminal: mokkan login a@b.c\n', stderr: '' });
    expect(server.requests).toHaveLength(0);
  });

  it('logout revokes on the server and removes the file, even if the server is down', async () => {
    server.on('POST', '/auth/logout', () => ({ status: 204 }));
    let res = await h.run(['logout'], { serverUrl: server.url, loggedIn: true });
    expect(res).toEqual({ code: 0, stdout: 'Logged out.\n', stderr: '' });
    expect(server.count('POST', '/auth/logout')).toBe(1);
    expect(existsSync(credentialsPath(h.env()))).toBe(false);
    h.saveCreds('http://127.0.0.1:1');
    res = await h.run(['logout'], { serverUrl: 'http://127.0.0.1:1' });
    expect(res.code).toBe(0);
    expect(existsSync(credentialsPath(h.env()))).toBe(false);
  });

  it('status summarises account and session', async () => {
    server.on('GET', '/me', () => ({ status: 200, body: { email: 'a@example.com', last_heartbeat_at: '2026-09-28T11:59:00.000Z', session_active: true } }));
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 1, reminders: [r1, r2] } }));
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [r1], awaiting_ack: [r2] } }));
    const res = await h.run(['status'], { serverUrl: server.url, loggedIn: true });
    expect(res.stdout).toBe(
      `Server: ${server.url}\nAccount: a@example.com\nSession: active (last heartbeat 2026-09-28T11:59:00.000Z)\nActive reminders: 2\nDue now: 1, awaiting ack: 1\n`);
  });

  it('heartbeat posts the source', async () => {
    server.on('POST', '/heartbeat', () => ({ status: 200, body: { active_until: '2026-09-28T12:05:00.000Z' } }));
    const res = await h.run(['heartbeat', '--source', 'codex'], { serverUrl: server.url, loggedIn: true });
    expect(server.last('POST', '/heartbeat')?.body).toEqual({ source: 'codex' });
    expect(res.stdout).toBe('Heartbeat sent (codex); session active until 2026-09-28T12:05:00.000Z.\n');
  });

  it('feedback posts the text, keeping its line breaks', async () => {
    server.on('POST', '/feedback', () => ({ status: 201, body: { ok: true } }));
    const res = await h.run(['feedback', 'first line\nsecond'], { serverUrl: server.url, loggedIn: true });
    expect(server.last('POST', '/feedback')?.body).toEqual({ text: 'first line\nsecond' });
    expect(res).toEqual({ code: 0, stdout: 'Feedback sent. Thank you.\n', stderr: '' });
    expect((await h.run(['feedback', '  '], { serverUrl: server.url, loggedIn: true })).code).not.toBe(0);
  });

  it('deliver marks the given reminders shown', async () => {
    server.on('POST', '/reminders/deliver', () => ({ status: 200, body: { version: 3, delivered: [r1.id] } }));
    const res = await h.run(['deliver', r1.id], { serverUrl: server.url, loggedIn: true });
    expect(server.last('POST', '/reminders/deliver')?.body).toEqual({ ids: [r1.id] });
    expect(res.stdout).toBe('Delivered 1 reminder(s).\n');
  });

  it('sync fetches the list, history and balance, sends a heartbeat, and with --deliver delivers the due timed ones', async () => {
    const timed = reminder({ id: 'aaaa3333-0000-0000-0000-000000000003', text: 'timed', due_at: '2026-09-28T11:00:00.000Z' });
    const done = reminder({ id: 'aaaa4444-0000-0000-0000-000000000004', text: 'old', state: 'done' });
    server.on('GET', '/reminders', (req) => ({ status: 200, body: { version: 1, reminders: req.query.get('scope') === 'done' ? [done] : [r1, r2, timed] } }));
    server.on('GET', '/billing/balance', () => ({ status: 200, body: { balance: 42, ledger: [] } }));
    server.on('POST', '/heartbeat', () => ({ status: 200, body: { active_until: '2026-09-28T12:05:00.000Z' } }));
    server.on('POST', '/reminders/deliver', (req) => ({ status: 200, body: { version: 2, delivered: (req.body as { ids: string[] }).ids } }));

    const res = await h.run(['sync', '--source', 'claude-code-pane', '--deliver', '--json'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(0);
    // The untimed due one (r1) is a todo: never delivered.
    expect(JSON.parse(res.stdout)).toEqual({ version: 1, reminders: [r1, r2, timed], done: [done], balance: 42, delivered: [timed.id] });
    expect(server.last('POST', '/heartbeat')?.body).toEqual({ source: 'claude-code-pane' });
    expect(server.last('POST', '/reminders/deliver')?.body).toEqual({ ids: [timed.id] });

    await h.run(['sync', '--json'], { serverUrl: server.url, loggedIn: true });
    expect(server.count('POST', '/reminders/deliver')).toBe(1); // without --deliver, never
  });

  it('sync fails only on the list: a failed history, balance or deliver is null', async () => {
    const timed = reminder({ id: 'aaaa3333-0000-0000-0000-000000000003', text: 'timed', due_at: '2026-09-28T11:00:00.000Z' });
    server.on('GET', '/reminders', (req) => (req.query.get('scope') === 'done'
      ? { status: 500, body: { error: 'internal', message: 'boom' } }
      : { status: 200, body: { version: 1, reminders: [timed] } }));
    const res = await h.run(['sync', '--deliver', '--json'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ version: 1, reminders: [timed], done: null, balance: null, delivered: null });

    const fresh = new CliHarness();
    try {
      expect((await fresh.run(['sync', '--json'], { serverUrl: server.url })).code).toBe(1); // logged out: the pane reads 1 as that
    } finally {
      fresh.dispose();
    }
  });

  it('deliver without ids is a usage error', async () => {
    const res = await h.run(['deliver'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Usage: mokkan deliver <id>...');
  });

  it('unreachable server exits 2', async () => {
    const res = await h.run(['list'], { serverUrl: 'http://127.0.0.1:1', loggedIn: true });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Cannot reach http://127.0.0.1:1');
  });

  describe('corrupt credentials file', () => {
    function corrupt(): string {
      const file = credentialsPath(h.env());
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, '{not json', { mode: 0o600 });
      return file;
    }

    it('status exits 1 with recovery guidance', async () => {
      const file = corrupt();
      const res = await h.run(['status'], { serverUrl: server.url });
      expect(res).toEqual({
        code: 1, stdout: '',
        stderr: `credentials file is corrupt: ${file}. Run: mokkan logout (or delete it) then mokkan login\n`,
      });
      expect(server.requests).toHaveLength(0);
    });

    it('logout removes the file and exits 0', async () => {
      const file = corrupt();
      const res = await h.run(['logout'], { serverUrl: server.url });
      expect(res).toEqual({ code: 0, stdout: `Removed corrupt credentials file ${file}.\nLogged out.\n`, stderr: '' });
      expect(existsSync(file)).toBe(false);
      expect(server.requests).toHaveLength(0);
    });

    it('login replaces it with fresh credentials', async () => {
      const file = corrupt();
      server.on('POST', '/auth/login', () => ({ status: 200, body: tokenPair('login') }));
      const res = await h.run(['login', 'a@example.com'], { serverUrl: server.url, env: { MOKKAN_PASSWORD: 'a long password' } });
      expect(res.code).toBe(0);
      expect(JSON.parse(readFileSync(file, 'utf8')).access_token).toBe('access-login');
    });
  });

  it('uses the injected clock for relative times', () => {
    expect(NOW.toISOString()).toBe('2026-09-28T12:00:00.000Z');
  });
});
