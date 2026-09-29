import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CliHarness, reminder } from './cli-harness.js';
import { FakeServer } from './fake-server.js';

const r1 = reminder({ id: 'aaaa1111-0000-0000-0000-000000000001', text: 'first' });

describe('mokkan watch', () => {
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

  it('--once heartbeats as watcher, prints due reminders and delivers them', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [r1], awaiting_ack: [] } }));
    const res = await h.run(['watch', '--once'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('2026-09-28T12:00:00.000Z reminders due:\n- [aaaa1111] first\n');
    expect(server.last('POST', '/heartbeat')?.body).toEqual({ source: 'watcher' });
    expect(server.last('POST', '/reminders/deliver')?.body).toEqual({ ids: [r1.id] });
  });

  it('--once prints nothing when nothing is due', async () => {
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [], awaiting_ack: [] } }));
    const res = await h.run(['watch', '--once'], { serverUrl: server.url, loggedIn: true });
    expect(res).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(server.count('POST', '/reminders/deliver')).toBe(0);
  });

  it('rejects intervals under 5 seconds and requires login', async () => {
    // Not-logged-in check first: a loggedIn run writes credentials into the harness config dir.
    let res = await h.run(['watch', '--once'], { serverUrl: server.url });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Not logged in');
    res = await h.run(['watch', '--interval', '1', '--once'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--interval');
  });

  it('keeps running after a transient server error (reports to stderr, no crash)', async () => {
    let calls = 0;
    server.on('GET', '/reminders/pending', () => {
      calls++;
      return calls === 1
        ? { status: 500, body: { error: 'internal', message: 'boom' } }
        : { status: 200, body: { due: [], awaiting_ack: [] } };
    });
    const res = await h.run(['watch', '--once'], { serverUrl: server.url, loggedIn: true });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('watch error: boom');
  });
});
