import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { CliHarness, NOW } from './cli-harness.js';
import { FakeServer } from './fake-server.js';

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
    expect(r.code).toBe(2);
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
