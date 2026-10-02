import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiError, MokkanClient } from '../src/client.js';
import { isTrustedCheckoutUrl, openUrlDetached, type SpawnFn } from '../src/commands/billing.js';
import type { Credentials } from '../src/credentials.js';
import { CliHarness } from './cli-harness.js';
import { FakeServer } from './fake-server.js';

const creds = (url: string): Credentials => ({
  server_url: url, email: 'a@example.com', access_token: 'access-0', access_expires_at: '2099-01-01T00:00:00.000Z',
  refresh_token: 'refresh-0', refresh_expires_at: '2099-02-01T00:00:00.000Z',
});

describe('credits (client + CLI against the fake server)', () => {
  let server: FakeServer;
  let h: CliHarness;
  beforeEach(async () => { server = new FakeServer(); await server.start(); h = new CliHarness(); });
  afterEach(async () => { await server.stop(); h.dispose(); });
  const run = (argv: string[], extra: { opened?: string[] } = {}) => h.run(argv, { serverUrl: server.url, loggedIn: true, ...extra });

  describe('client', () => {
    const client = () => new MokkanClient({ baseUrl: server.url, credentials: creds(server.url) });

    it('checkout sends the pack only when given', async () => {
      server.withAccount();
      expect(await client().checkout()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_fake', session_id: 'cs_test_fake' });
      expect(server.last('POST', '/billing/checkout')?.body).toEqual({});
      await client().checkout('credits_1500');
      expect(server.last('POST', '/billing/checkout')?.body).toEqual({ pack: 'credits_1500' });
    });

    it('checkout surfaces a 400 validation error for an unknown pack', async () => {
      server.withAccount();
      await expect(client().checkout('nope')).rejects.toMatchObject({ status: 400, code: 'validation' });
    });

    it('balance and /me expose credit_balance', async () => {
      server.withAccount({ balance: 42 });
      expect((await client().balance()).balance).toBe(42);
      expect((await client().me()).credit_balance).toBe(42);
    });

    it('editReminder PATCHes text, due_at (ISO or null) and expected_version', async () => {
      const acct = server.withAccount();
      acct.version = 6;
      const c = client();
      const pushed = await c.push('old'); // version 7
      await c.editReminder(pushed.reminder.id, { text: 'new', due_at: new Date('2030-01-01T00:00:00.000Z') }, 7);
      const req = server.last('PATCH', `/reminders/${pushed.reminder.id}`)!;
      expect(req.body).toEqual({ text: 'new', due_at: '2030-01-01T00:00:00.000Z', expected_version: 7 });
      await c.editReminder(pushed.reminder.id, { due_at: null });
      expect(server.last('PATCH', `/reminders/${pushed.reminder.id}`)?.body).toEqual({ due_at: null });
    });

    it('a 402 is an ApiError carrying the contract body', async () => {
      server.withAccount({ balance: 1 });
      const err = await client().push('later', new Date('2030-01-01T00:00:00.000Z')).catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(402);
      expect(err.code).toBe('insufficient_credits');
      expect(err.body).toEqual({
        error: 'insufficient_credits',
        message: 'Not enough credits: this needs 2, you have 1. Run `mokkan buy` to add credits.',
        balance: 1, cost: 1, required: 2,
      });
    });

    it('a second scheduled push needs push 1 + email 1 x (1 outstanding + 1) = 3', async () => {
      server.withAccount({ balance: 3 });
      const c = client();
      await c.push('one', new Date('2030-01-01T00:00:00.000Z')); // needs 1 + 1 = 2, balance 3 -> 2
      const err = await c.push('two', new Date('2030-01-02T00:00:00.000Z')).catch((e) => e);
      expect(err.status).toBe(402);
      expect(err.body).toMatchObject({ balance: 2, cost: 1, required: 3 });
    });

    it('setting a due time on a reminder without one reserves an email credit', async () => {
      server.withAccount({ balance: 3 });
      const c = client();
      await c.push('scheduled', new Date('2030-01-01T00:00:00.000Z')); // balance 2, one outstanding
      const { reminder } = await c.push('plain'); // balance 1
      // Needs 0 (no edit debit) + 1 x (1 outstanding + 1) = 2.
      const err = await c.editReminder(reminder.id, { due_at: new Date('2030-01-02T00:00:00.000Z') }).catch((e) => e);
      expect(err.status).toBe(402);
      expect(err.body).toMatchObject({ balance: 1, cost: 0, required: 2 });
    });

    it('the third edit costs a credit; at balance 0 it is a 402 and nothing changes', async () => {
      const acct = server.withAccount({ balance: 1 });
      const c = client();
      const { reminder } = await c.push('x'); // balance 0
      await c.editReminder(reminder.id, { text: 'a' });
      await c.editReminder(reminder.id, { text: 'b' });
      await expect(c.editReminder(reminder.id, { text: 'c' })).rejects.toMatchObject({ status: 402 });
      expect(acct.editCount).toBe(2);
      expect(acct.reminders.get(reminder.id)?.text).toBe('b');
    });
  });

  describe('mokkan buy', () => {
    it('prints the URL, opens it and points at `mokkan balance`', async () => {
      server.withAccount();
      const opened: string[] = [];
      const res = await run(['buy'], { opened });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Checkout: https://checkout.stripe.com/c/pay/cs_test_fake\n');
      expect(res.stdout).toContain('mokkan balance');
      expect(opened).toEqual(['https://checkout.stripe.com/c/pay/cs_test_fake']);
      expect(server.last('POST', '/billing/checkout')?.body).toEqual({});
    });

    it('--no-open still prints the URL and never opens; --pack is sent', async () => {
      server.withAccount();
      const opened: string[] = [];
      const res = await run(['buy', '--pack', 'credits_1500', '--no-open'], { opened });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Checkout: https://checkout.stripe.com/');
      expect(opened).toEqual([]);
      expect(server.last('POST', '/billing/checkout')?.body).toEqual({ pack: 'credits_1500' });
    });

    it('--json prints the raw response', async () => {
      server.withAccount();
      const res = await run(['buy', '--json', '--no-open']);
      expect(res.stdout).toBe('{"url":"https://checkout.stripe.com/c/pay/cs_test_fake","session_id":"cs_test_fake","opened":false}\n');
    });

    it('an unknown pack is reported and exits 1', async () => {
      server.withAccount();
      const res = await run(['buy', '--pack', 'nope']);
      expect(res).toMatchObject({ code: 1, stdout: '' });
      expect(res.stderr).toContain('Unknown pack');
    });

    it('a server without billing (404) says so', async () => {
      const res = await run(['buy']);
      expect(res.code).toBe(1);
      expect(res.stderr).toBe('Billing is not enabled on this server.\n');
    });

    it('a URL that is not a Stripe https address is printed but never opened', async () => {
      for (const url of ['http://checkout.stripe.com/c/pay/x', 'https://evil.test/a&calc.exe', 'file:///etc/passwd', 'https://stripe.com.evil.test/x']) {
        const acct = server.withAccount();
        acct.checkoutUrl = url;
        const opened: string[] = [];
        const res = await run(['buy'], { opened });
        expect(res.code).toBe(0);
        expect(opened).toEqual([]);
        expect(res.stdout).toContain(`Checkout: ${url}\n`);
        expect(res.stdout).toContain('was not opened automatically');
      }
    });
  });

  describe('mokkan balance', () => {
    it('shows the balance and the ledger newest first', async () => {
      const acct = server.withAccount({ balance: 480 });
      acct.ledger.push(
        { delta: 500, reason: 'purchase', ref: 'cs_1', created_at: '2026-09-28T12:34:56.000Z' },
        { delta: -1, reason: 'push', ref: 'r1', created_at: '2026-09-27T08:05:00.000Z' },
      );
      const res = await run(['balance']);
      expect(res.code).toBe(0);
      expect(res.stdout).toBe(
        'Balance: 480 credits\n\nRecent transactions (UTC):\n' +
        '  2026-09-28 12:34    +500  purchase\n' +
        '  2026-09-27 08:05      -1  push\n');
    });

    it('uses the singular for a balance of 1', async () => {
      server.withAccount({ balance: 1 });
      expect((await run(['balance'])).stdout).toContain('Balance: 1 credit\n');
    });

    it('says so when there are no transactions; --json is raw', async () => {
      server.withAccount({ balance: 0 });
      expect((await run(['balance'])).stdout).toBe('Balance: 0 credits\nNo transactions yet.\n');
      expect((await run(['balance', '--json'])).stdout).toBe('{"balance":0,"ledger":[]}\n');
    });
  });

  it('help lists buy and balance', async () => {
    const res = await h.run(['help']);
    expect(res.stdout).toContain('mokkan buy');
    expect(res.stdout).toContain('mokkan balance');
  });
});

describe('openUrlDetached', () => {
  const URL_OK = 'https://checkout.stripe.com/c/pay/cs_test_a1#fid=x';
  const recorder = () => {
    const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const spawn: SpawnFn = (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts.env });
      return { on: () => undefined, unref: () => undefined };
    };
    return { calls, spawn };
  };

  it('uses open on macOS, rundll32 (no cmd.exe) on Windows and xdg-open on Linux, the URL as one argument', () => {
    const r = recorder();
    expect(openUrlDetached(URL_OK, 'darwin', {}, r.spawn)).toBe(true);
    expect(openUrlDetached(URL_OK, 'win32', {}, r.spawn)).toBe(true);
    expect(openUrlDetached(URL_OK, 'linux', { DISPLAY: ':0' }, r.spawn)).toBe(true);
    expect(openUrlDetached(URL_OK, 'linux', { WAYLAND_DISPLAY: 'wayland-0' }, r.spawn)).toBe(true);
    expect(r.calls.map(({ cmd, args }) => [cmd, ...args])).toEqual([
      ['open', URL_OK],
      ['rundll32', 'url.dll,FileProtocolHandler', URL_OK],
      ['xdg-open', URL_OK],
      ['xdg-open', URL_OK],
    ]);
    expect(r.calls[2].env).toEqual({ DISPLAY: ':0' });
  });

  it('does nothing on Linux without a display', () => {
    const r = recorder();
    expect(openUrlDetached(URL_OK, 'linux', {}, r.spawn)).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it('opens only https URLs on stripe.com', () => {
    const r = recorder();
    for (const url of [
      'http://checkout.stripe.com/x', 'https://evil.test/a&calc.exe', 'file:///etc/passwd', '/System/Applications/Terminal.app',
      '-a Terminal', 'https://stripe.com.evil.test/', 'https://notstripe.com/', 'not a url',
    ]) {
      expect(isTrustedCheckoutUrl(url)).toBe(false);
      for (const platform of ['darwin', 'win32', 'linux'] as const) expect(openUrlDetached(url, platform, { DISPLAY: ':0' }, r.spawn)).toBe(false);
    }
    expect(r.calls).toEqual([]);
    expect(isTrustedCheckoutUrl('https://checkout.stripe.com/c/pay/cs_1')).toBe(true);
    expect(isTrustedCheckoutUrl('https://pay.stripe.com/x')).toBe(true);
  });

  it('never throws when spawn fails', () => {
    const boom: SpawnFn = () => { throw new Error('ENOENT'); };
    expect(openUrlDetached(URL_OK, 'linux', { DISPLAY: ':0' }, boom)).toBe(false);
  });
});
