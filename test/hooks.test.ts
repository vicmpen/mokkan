import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MokkanClient } from '../src/client.js';
import { credentialsPath, hookLogPath } from '../src/credentials.js';
import { runHook } from '../src/hooks.js';
import type { Ctx } from '../src/cli.js';
import { CliHarness, NOW, reminder } from './cli-harness.js';
import { FakeServer, tokenPair } from './fake-server.js';

const stall = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const r1 = reminder({ id: 'aaaa1111-0000-0000-0000-000000000001', text: 'first' });
const r2 = reminder({ id: 'aaaa2222-0000-0000-0000-000000000002', text: 'timed', due_at: '2026-09-28T11:55:00.000Z' });
const r3 = reminder({ id: 'aaaa3333-0000-0000-0000-000000000003', text: 'seen', state: 'delivered' });

describe('mokkan hook', () => {
  let server: FakeServer;
  let h: CliHarness;

  beforeEach(async () => {
    server = new FakeServer();
    await server.start();
    h = new CliHarness();
    server.on('POST', '/heartbeat', () => ({ status: 200, body: { active_until: '2026-09-28T12:05:00.000Z' } }));
    server.on('POST', '/reminders/deliver', (req) => ({ status: 200, body: { version: 2, delivered: (req.body as { ids: string[] }).ids } }));
  });
  afterEach(async () => { await server.stop(); h.dispose(); });

  function logLines(): string[] {
    const file = hookLogPath(h.env());
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
  }

  it('session-start prints the pending block, sends a heartbeat with the session id and delivers the due ids', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [r1, r2], awaiting_ack: [r3] } }));
    const res = await h.run(['hook', 'session-start'], {
      serverUrl: server.url, loggedIn: true,
      stdin: JSON.stringify({ session_id: 'sess-9', hook_event_name: 'SessionStart', source: 'startup' }),
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(
      'Reminders (mokkan):\n' +
      '- [aaaa1111] first\n' +
      '- [aaaa2222] timed (due 2026-09-28T11:55:00.000Z)\n' +
      '1 reminder(s) awaiting acknowledgment — run /mokkan ack <id> or /mokkan ack all\n');
    expect(server.last('POST', '/heartbeat')?.body).toEqual({ source: 'claude-code', session_id: 'sess-9' });
    expect(server.last('POST', '/reminders/deliver')?.body).toEqual({ ids: [r1.id, r2.id] });
    expect(logLines()).toEqual([]);
  });

  it('session-start prints nothing and delivers nothing when there is nothing pending', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [], awaiting_ack: [] } }));
    const res = await h.run(['hook', 'session-start'], { serverUrl: server.url, loggedIn: true, stdin: '{"session_id":"s"}' });
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(server.count('POST', '/heartbeat')).toBe(1);
    expect(server.count('POST', '/reminders/deliver')).toBe(0);
  });

  it('stop prints exactly one block-decision JSON line when reminders are due, and delivers them', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [r1, r2], awaiting_ack: [] } }));
    const res = await h.run(['hook', 'stop'], {
      serverUrl: server.url, loggedIn: true,
      stdin: JSON.stringify({ session_id: 'sess-9', hook_event_name: 'Stop', stop_hook_active: false }),
    });
    expect(res.code).toBe(0);
    expect(res.stdout.endsWith('\n')).toBe(true);
    expect(res.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(res.stdout)).toEqual({
      decision: 'block',
      reason:
        'Reminders due (from the mokkan server):\n' +
        '- [aaaa1111] first\n' +
        '- [aaaa2222] timed (due 2026-09-28T11:55:00.000Z)\n' +
        'Tell the user these reminders verbatim, then remind them to run /mokkan ack <id> or /mokkan ack all. Then stop.',
      systemMessage: '2 reminder(s) due — see reply',
    });
    expect(server.last('POST', '/reminders/deliver')?.body).toEqual({ ids: [r1.id, r2.id] });
  });

  it('stop prints nothing when stop_hook_active is true (no loops) but still heartbeats', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [r1], awaiting_ack: [] } }));
    const res = await h.run(['hook', 'stop'], { serverUrl: server.url, loggedIn: true, stdin: '{"stop_hook_active":true}' });
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(server.count('POST', '/heartbeat')).toBe(1);
    expect(server.count('POST', '/reminders/deliver')).toBe(0);
  });

  it('stop prints nothing when nothing is due, even with items awaiting ack', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [], awaiting_ack: [r3] } }));
    const res = await h.run(['hook', 'stop'], { serverUrl: server.url, loggedIn: true, stdin: '{}' });
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('treats empty or invalid stdin as an empty hook input', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [r1], awaiting_ack: [] } }));
    const res = await h.run(['hook', 'stop'], { serverUrl: server.url, loggedIn: true, stdin: 'not json' });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).decision).toBe('block');
    expect(server.last('POST', '/heartbeat')?.body).toEqual({ source: 'claude-code' });
  });

  it('server down: empty stdout, exit 0, one line in hook.log', async () => {
    const res = await h.run(['hook', 'stop'], { serverUrl: 'http://127.0.0.1:1', loggedIn: true, stdin: '{}' });
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
    const lines = logLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[^ ]+ stop Cannot reach http:\/\/127\.0\.0\.1:1/);
  });

  it('no credentials: empty stdout, exit 0, logged', async () => {
    const res = await h.run(['hook', 'session-start'], { serverUrl: server.url, stdin: '{}' });
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(logLines()[0]).toContain('session-start Not logged in');
    expect(server.requests).toHaveLength(0);
  });

  it('credentials file with loose permissions: empty stdout, exit 0, logged', async () => {
    h.saveCreds(server.url);
    chmodSync(credentialsPath(h.env()), 0o644);
    const res = await h.run(['hook', 'stop'], { serverUrl: server.url, stdin: '{}' });
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(logLines()[0]).toContain('readable by other users');
  });

  it('credentials error with an unwritable hook.log: still exit 0 with empty stdout and stderr', async () => {
    h.saveCreds(server.url);
    chmodSync(credentialsPath(h.env()), 0o640);
    mkdirSync(hookLogPath(h.env()));
    const res = await h.run(['hook', 'stop'], { serverUrl: server.url, stdin: '{}' });
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(server.requests).toHaveLength(0);
  });

  it('corrupt credentials file: empty stdout, exit 0, logged', async () => {
    h.saveCreds(server.url);
    writeFileSync(credentialsPath(h.env()), '{not json', { mode: 0o600 });
    const res = await h.run(['hook', 'session-start'], { serverUrl: server.url, stdin: '{}' });
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(logLines()[0]).toContain('session-start credentials file is corrupt');
  });

  it('rejects an unknown hook kind as a user error (exit 1)', async () => {
    const res = await h.run(['hook', 'bogus'], { serverUrl: server.url, loggedIn: true, stdin: '{}' });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Usage: mokkan hook session-start|stop');
  });
  describe('expired session', () => {
    it('a rejected refresh token: exit 0, silent, one log line, credentials removed; later runs add no line', async () => {
      server.on('POST', '/heartbeat', () => ({ status: 401, body: { error: 'unauthorized', message: 'expired' } }));
      server.on('POST', '/auth/refresh', () => ({ status: 401, body: { error: 'invalid_token', message: 'Refresh token is invalid, expired or already used' } }));
      const res = await h.run(['hook', 'stop'], { serverUrl: server.url, loggedIn: true, stdin: '{}' });
      expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(existsSync(credentialsPath(h.env()))).toBe(false);
      const lines = logLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\S+ stop session expired; run: mokkan login$/);

      for (const kind of ['stop', 'session-start']) {
        const again = await h.run(['hook', kind], { serverUrl: server.url, stdin: '{}' });
        expect(again).toEqual({ code: 0, stdout: '', stderr: '' });
      }
      expect(logLines()).toEqual(lines);
      expect(server.count('POST', '/auth/refresh')).toBe(1);
    });

    it('"Not logged in" is logged again once the marker is an hour old', async () => {
      await h.run(['hook', 'stop'], { serverUrl: server.url, stdin: '{}' });
      await h.run(['hook', 'stop'], { serverUrl: server.url, stdin: '{}' });
      expect(logLines()).toHaveLength(1);
      writeFileSync(`${hookLogPath(h.env())}.notified`, `${new Date(Date.now() - 3601_000).toISOString()}\n`);
      await h.run(['hook', 'stop'], { serverUrl: server.url, stdin: '{}' });
      expect(logLines()).toHaveLength(2);
    });
  });

  describe('overall deadline', () => {
    it('a stalled server: exit 0, silent, well inside the hook budget', async () => {
      server.on('GET', '/reminders/pending', async () => { await stall(4000); return { status: 200, body: { due: [r1], awaiting_ack: [] } }; });
      const started = Date.now();
      const res = await h.run(['hook', 'stop'], { serverUrl: server.url, loggedIn: true, stdin: '{}' });
      expect(Date.now() - started).toBeLessThan(9000);
      expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(logLines()[0]).toContain('timed out after 3000 ms');
    }, 20_000);

    it('refresh + three slow requests (the old 12 s worst case) finish under 8.5 s; deliver is skipped', async () => {
      server.on('POST', '/auth/refresh', async () => { await stall(2500); return { status: 200, body: tokenPair('r1') }; });
      server.on('POST', '/heartbeat', async () => { await stall(2500); return { status: 200, body: { active_until: '2026-09-28T12:05:00.000Z' } }; });
      server.on('GET', '/reminders/pending', async () => { await stall(2500); return { status: 200, body: { due: [r1], awaiting_ack: [] } }; });
      server.on('POST', '/reminders/deliver', async (req) => { await stall(2500); return { status: 200, body: { version: 2, delivered: (req.body as { ids: string[] }).ids } }; });
      h.saveCreds(server.url, '2026-09-28T12:30:00.000Z'); // inside the pre-expiry window: the hook refreshes first
      const started = Date.now();
      const res = await h.run(['hook', 'stop'], { serverUrl: server.url, stdin: '{}' });
      expect(Date.now() - started).toBeLessThan(8500);
      expect(res.code).toBe(0);
      expect(res.stderr).toBe('');
      // ~0.5 s of budget left after three 2.5 s calls: shown now, not marked delivered, so shown again next turn.
      expect(JSON.parse(res.stdout).decision).toBe('block');
      expect(server.count('POST', '/reminders/deliver')).toBe(0);
      expect(server.count('POST', '/auth/refresh')).toBe(1);
    }, 20_000);

    it('skips deliver (but still shows the reminders) when less than 1.5 s remain', async () => {
      server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [r1], awaiting_ack: [] } }));
      const client = new MokkanClient({
        baseUrl: server.url, now: () => NOW,
        credentials: { server_url: server.url, email: 'a@example.com', access_token: 'access-0', access_expires_at: '2026-09-29T12:00:00.000Z', refresh_token: 'refresh-0', refresh_expires_at: '2026-12-27T12:00:00.000Z' },
      });
      const ctx = { client } as unknown as Ctx;
      const out = await runHook(ctx, 'stop', {}, Date.now() + 1000);
      expect(JSON.parse(out).decision).toBe('block');
      expect(server.count('POST', '/reminders/deliver')).toBe(0);
      await runHook(ctx, 'stop', {}, Date.now() + 5000);
      expect(server.count('POST', '/reminders/deliver')).toBe(1);
    });
  });
});
