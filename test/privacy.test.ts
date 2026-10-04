import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { credentialsPath, hookLogPath } from '../src/credentials.js';
import { CliHarness, FakeTerminal } from './cli-harness.js';
import { FakeServer, PRIVACY_SUMMARY, tokenPair, type FakeAccount, type FakePrivacy } from './fake-server.js';

const GATE = 'Accept the updated privacy policy: run mokkan accept in a terminal\n'
  + "(or npx @vicmpen/mokkan-cli accept if mokkan isn't installed)\n"
  + 'Privacy policy: https://mokkan.dev/privacy\n';
const POLICY = 'mokkan privacy policy, version 2026-10-04:\n'
  + `  ${PRIVACY_SUMMARY[0]}\n  ${PRIVACY_SUMMARY[1]}\n`
  + 'Full text: https://mokkan.dev/privacy\n';
const ID = 'aaaa1111-0000-0000-0000-000000000000';

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(cond()).toBe(true);
}

describe('privacy policy', () => {
  let server: FakeServer;
  let h: CliHarness;
  let acct: FakeAccount;
  let privacy: FakePrivacy;
  beforeEach(async () => {
    server = new FakeServer();
    await server.start();
    h = new CliHarness();
    acct = server.withAccount({ balance: 42 });
    acct.reminders.set(ID, { id: ID, text: 'first', state: 'due', position: 1, due_at: null, created_at: '2026-09-28T12:00:00.000Z', delivered_at: null, acknowledged_at: null, done_at: null });
    privacy = server.withPrivacy();
  });
  afterEach(async () => { await server.stop(); h.dispose(); });

  describe('the gate', () => {
    it('without a terminal: the 403 message, the npx form and the URL, exit 4 (sync too)', async () => {
      const res = await h.run(['list'], { serverUrl: server.url, loggedIn: true });
      expect(res).toEqual({ code: 4, stdout: '', stderr: GATE });
      const sync = await h.run(['sync', '--json'], { serverUrl: server.url, loggedIn: true });
      expect(sync.code).toBe(4);
      expect(server.count('POST', '/privacy/accept')).toBe(0);
      // Through /mokkan (exit 0 for Claude Code's `!`): the same text on stdout, and nothing is accepted.
      const slash = await h.run(['--argline', 'list', '--exit-zero'], { serverUrl: server.url, loggedIn: true });
      expect(slash).toEqual({ code: 0, stdout: GATE, stderr: '' });
    });

    it('with a terminal, y accepts the version shown and runs the command once more', async () => {
      const res = await h.run(['list'], { serverUrl: server.url, loggedIn: true, isTTY: true, answers: ['y'] });
      expect(res.code).toBe(0);
      expect(res.stdout).toBe(`${POLICY}Accepted the privacy policy (version 2026-10-04).\n 1. [aaaa1111] due          first\n`);
      expect(server.last('POST', '/privacy/accept')?.body).toEqual({ version: '2026-10-04' });
      expect(privacy.accepted).toBe('2026-10-04');
    });

    it('with --json a terminal is not asked: the 403 message on stderr, exit 4', async () => {
      const res = await h.run(['list', '--json'], { serverUrl: server.url, loggedIn: true, isTTY: true, answers: ['y'] });
      expect(res).toEqual({ code: 4, stdout: '', stderr: GATE });
      expect(server.count('GET', '/privacy')).toBe(0);
    });

    it('n exits 4 without accepting', async () => {
      const res = await h.run(['push', 'x'], { serverUrl: server.url, loggedIn: true, isTTY: true, answers: ['n'] });
      expect(res.code).toBe(4);
      expect(res.stderr).toBe('Not accepted. Run mokkan accept when you are ready.\n');
      expect(server.count('POST', '/privacy/accept')).toBe(0);
      expect(acct.reminders.size).toBe(1);
    });

    it('d runs the delete-account flow instead', async () => {
      const res = await h.run(['list'], { serverUrl: server.url, loggedIn: true, isTTY: true, answers: ['d', 'a long password', 'delete'] });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('This deletes a@example.com, its 1 reminder and 42 unspent credits.');
      expect(res.stdout.endsWith('Account deleted.\n')).toBe(true);
      expect(acct.deleted).toBe(true);
      expect(server.count('POST', '/privacy/accept')).toBe(0);
    });

    it('a 409 on accept shows the new version once more; a second 409 exits 2', async () => {
      // The policy changes while the prompt is open: the first GET /privacy still answers the old version.
      privacy.version = '2026-11-01';
      let gets = 0;
      server.on('GET', '/privacy', () => ({ status: 200, body: { version: gets++ === 0 ? '2026-10-04' : privacy.version, url: privacy.url, summary: ['new'] } }));
      const res = await h.run(['list'], { serverUrl: server.url, loggedIn: true, isTTY: true, answers: ['y', 'y'] });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('The privacy policy has just changed. The new version:\nmokkan privacy policy, version 2026-11-01:\n  new\n');
      expect(server.requests.filter((r) => r.path === '/privacy/accept').map((r) => r.body)).toEqual([{ version: '2026-10-04' }, { version: '2026-11-01' }]);
      expect(res.stdout).toContain('first');

      privacy.accepted = null;
      server.on('GET', '/privacy', () => ({ status: 200, body: { version: '2026-10-04', url: privacy.url, summary: ['old'] } }));
      const again = await h.run(['list'], { serverUrl: server.url, loggedIn: true, isTTY: true, answers: ['y', 'y'] });
      expect(again.code).toBe(2);
      expect(again.stderr).toBe('The privacy policy changed again while it was shown; try again later.\n');
    });

    it('heartbeat, ack, me (status shows it) and logout pass the gate', async () => {
      expect((await h.run(['heartbeat'], { serverUrl: server.url, loggedIn: true })).code).toBe(0);
      expect((await h.run(['ack', 'all'], { serverUrl: server.url, loggedIn: true })).code).toBe(0);
      server.on('POST', '/auth/logout', () => ({ status: 204 }));
      expect((await h.run(['logout'], { serverUrl: server.url, loggedIn: true })).stdout).toBe('Logged out.\n');
    });
  });

  describe('mokkan accept', () => {
    it('without a terminal it needs --yes', async () => {
      const res = await h.run(['accept'], { serverUrl: server.url, loggedIn: true });
      expect(res).toEqual({
        code: 1, stdout: '',
        stderr: "Accept the privacy policy in a terminal: mokkan accept (or npx @vicmpen/mokkan-cli accept if mokkan isn't installed)\n",
      });
      expect(server.requests).toHaveLength(0);
    });

    it('through /mokkan (--exit-zero) it is refused even with --yes; the pane form still accepts', async () => {
      const slash = await h.run(['--argline', 'accept --yes', '--exit-zero'], { serverUrl: server.url, loggedIn: true });
      expect(slash).toEqual({
        code: 0, stderr: '',
        stdout: "Accept the privacy policy in a terminal: mokkan accept (or npx @vicmpen/mokkan-cli accept if mokkan isn't installed)\n",
      });
      const direct = await h.run(['accept', '--yes', '--exit-zero'], { serverUrl: server.url, loggedIn: true, isTTY: true });
      expect(direct.stdout).toContain('Accept the privacy policy in a terminal');
      expect(server.requests).toHaveLength(0);
      expect(privacy.accepted).toBeNull();
      const pane = await h.run(['accept', '--yes', '--version', '2026-10-04', '--json'], { serverUrl: server.url, loggedIn: true });
      expect(pane.code).toBe(0);
      expect(privacy.accepted).toBe('2026-10-04');
    });

    it('--version without --yes is a usage error', async () => {
      const res = await h.run(['accept', '--version', '2026-10-04'], { serverUrl: server.url, loggedIn: true, isTTY: true });
      expect(res).toEqual({ code: 1, stdout: '', stderr: '--version needs --yes.\nUsage: mokkan accept [--yes [--version <v>]]\n' });
      expect(server.requests).toHaveLength(0);
    });

    it('--yes prints the summary and accepts the current version', async () => {
      const res = await h.run(['accept', '--yes'], { serverUrl: server.url, loggedIn: true });
      expect(res).toEqual({ code: 0, stdout: `${POLICY}Accepted the privacy policy (version 2026-10-04).\n`, stderr: '' });
      expect(privacy.accepted).toBe('2026-10-04');
    });

    it('--yes --version accepts only that version: a stale one exits 4', async () => {
      const stale = await h.run(['accept', '--yes', '--version', '2026-09-01'], { serverUrl: server.url, loggedIn: true });
      expect(stale.code).toBe(4);
      expect(stale.stderr).toBe('The privacy policy has changed; read it again\nPrivacy policy: https://mokkan.dev/privacy\n');
      expect(privacy.accepted).toBeNull();
      expect((await h.run(['accept', '--yes', '--version', '2026-09-01', '--json'], { serverUrl: server.url, loggedIn: true })).code).toBe(4);
      const ok = await h.run(['accept', '--yes', '--version', '2026-10-04', '--json'], { serverUrl: server.url, loggedIn: true });
      expect(ok.code).toBe(0);
      expect(server.last('POST', '/privacy/accept')?.body).toEqual({ version: '2026-10-04' });
      expect((await h.run(['accept', '--yes', '--version'], { serverUrl: server.url, loggedIn: true })).code).toBe(1);
    });

    it('with a terminal it is the prompt; logged out it says so', async () => {
      const res = await h.run(['accept'], { serverUrl: server.url, loggedIn: true, isTTY: true, answers: ['y'] });
      expect(res).toEqual({ code: 0, stdout: `${POLICY}Accepted the privacy policy (version 2026-10-04).\n`, stderr: '' });
      const fresh = new CliHarness();
      try {
        const out = await fresh.run(['accept', '--yes'], { serverUrl: server.url });
        expect(out).toEqual({ code: 1, stdout: '', stderr: 'Not logged in. Run: mokkan login\n' });
      } finally {
        fresh.dispose();
      }
    });
  });

  it('mokkan privacy --json prints {version,url,summary} on one line, without a login', async () => {
    const res = await h.run(['privacy', '--json'], { serverUrl: server.url });
    expect(res).toEqual({
      code: 0, stderr: '',
      stdout: `${JSON.stringify({ version: '2026-10-04', url: 'https://mokkan.dev/privacy', summary: PRIVACY_SUMMARY })}\n`,
    });
    expect(server.last('GET', '/privacy')?.headers.authorization).toBeUndefined();
    expect((await h.run(['privacy'], { serverUrl: server.url })).stdout).toBe(POLICY);
  });

  describe('mokkan register', () => {
    beforeEach(() => {
      server.on('POST', '/auth/register/start', () => ({ status: 202, body: { ok: true } }));
    });

    it('with a terminal: the summary comes first, and n sends no code', async () => {
      const res = await h.run(['register', 'new@example.com'], { serverUrl: server.url, isTTY: true, answers: ['n'] });
      expect(res).toEqual({ code: 1, stdout: POLICY, stderr: 'Registration cancelled.\n' });
      expect(server.count('POST', '/auth/register/start')).toBe(0);
    });

    it('with a terminal: a 409 shows the new summary, asks again and retries with the same code', async () => {
      let completes = 0;
      server.on('POST', '/auth/register/complete', (req) => {
        if (completes++ > 0) return { status: 201, body: tokenPair('reg') };
        privacy.version = '2026-11-01';
        return { status: 409, body: { version: privacy.version, url: privacy.url, error: 'privacy_version_stale', message: 'stale' } };
      });
      const res = await h.run(['register', 'new@example.com'], { serverUrl: server.url, isTTY: true, answers: ['y', '654321', 'another long pw', 'y'] });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('The privacy policy has just changed. The new version:\nmokkan privacy policy, version 2026-11-01:');
      const bodies = server.requests.filter((r) => r.path === '/auth/register/complete').map((r) => r.body);
      expect(bodies).toEqual([
        { email: 'new@example.com', otp: '654321', password: 'another long pw', privacy_version: '2026-10-04' },
        { email: 'new@example.com', otp: '654321', password: 'another long pw', privacy_version: '2026-11-01' },
      ]);
    });

    it('without a terminal both steps need --accept-privacy <version>', async () => {
      const message = 'Register in a terminal, or pass --accept-privacy <version> after showing the policy\n';
      for (const argv of [['register', 'new@example.com', '--start'], ['register', '--complete', 'new@example.com', '--otp', '123456']]) {
        const res = await h.run(argv, { serverUrl: server.url, env: { MOKKAN_PASSWORD: 'a long password' } });
        expect(res).toEqual({ code: 1, stdout: '', stderr: message });
      }
      expect(server.requests).toHaveLength(0);
      const start = await h.run(['register', 'new@example.com', '--start', '--accept-privacy', '2026-10-04'], { serverUrl: server.url });
      expect(start.code).toBe(0);
      expect(server.count('POST', '/auth/register/start')).toBe(1);
    });

    it('without a terminal, the pane form (with --json) works, and a stale version on --complete exits 4', async () => {
      server.on('POST', '/auth/register/complete', (req) => ((req.body as { privacy_version: string }).privacy_version === privacy.version
        ? { status: 201, body: tokenPair('reg') }
        : { status: 409, body: { version: privacy.version, url: privacy.url, error: 'privacy_version_stale', message: 'The privacy policy has changed; read it again' } }));
      const env = { MOKKAN_PASSWORD: 'a long password' };
      expect((await h.run(['register', 'new@example.com', '--start', '--accept-privacy', '2026-10-04', '--json'], { serverUrl: server.url })).code).toBe(0);
      const stale = await h.run(['register', '--complete', 'new@example.com', '--otp', '123456', '--accept-privacy', '2026-09-01', '--json'], { serverUrl: server.url, env });
      expect(stale).toEqual({ code: 4, stdout: '', stderr: 'The privacy policy has changed; read it again\nPrivacy policy: https://mokkan.dev/privacy\n' });
      const ok = await h.run(['register', '--complete', 'new@example.com', '--otp', '123456', '--accept-privacy', '2026-10-04', '--json'], { serverUrl: server.url, env });
      expect(ok.code).toBe(0);
      expect(existsSync(credentialsPath(h.env()))).toBe(true);
    });
  });

  describe('mokkan delete-account', () => {
    it('is refused without a terminal', async () => {
      const res = await h.run(['delete-account'], { serverUrl: server.url, loggedIn: true });
      expect(res).toEqual({
        code: 1, stdout: '',
        stderr: "Run it in a terminal: mokkan delete-account (or npx @vicmpen/mokkan-cli delete-account if mokkan isn't installed)\n",
      });
      expect(server.requests).toHaveLength(0);
    });

    it('anything but the word delete aborts', async () => {
      const res = await h.run(['delete-account'], { serverUrl: server.url, loggedIn: true, isTTY: true, answers: ['a long password', 'yes'] });
      expect(res.code).toBe(1);
      expect(res.stderr).toBe('Not deleted.\n');
      expect(server.count('DELETE', '/me')).toBe(0);
    });

    it('a wrong password is reported without a token refresh, and nothing is removed', async () => {
      const res = await h.run(['delete-account'], { serverUrl: server.url, loggedIn: true, isTTY: true, answers: ['wrong one', 'delete'] });
      expect(res.code).toBe(1);
      expect(res.stderr).toBe('Wrong password. Nothing was deleted.\n');
      expect(server.count('POST', '/auth/refresh')).toBe(0);
      expect(existsSync(credentialsPath(h.env()))).toBe(true);
      expect(acct.deleted).toBe(false);
    });

    it('deletes the account and removes credentials.json and hook.log*', async () => {
      h.saveCreds(server.url);
      for (const suffix of ['', '.notified', '.403.notified']) writeFileSync(`${hookLogPath(h.env())}${suffix}`, 'x\n');
      const res = await h.run(['delete-account'], { serverUrl: server.url, isTTY: true, answers: ['a long password', 'delete'] });
      expect(res).toEqual({
        code: 0, stderr: '',
        stdout: 'This deletes a@example.com, its 1 reminder and 42 unspent credits. Payment records are kept without your name.\nAccount deleted.\n',
      });
      expect(server.last('DELETE', '/me')?.body).toEqual({ password: 'a long password' });
      for (const suffix of ['', '.notified', '.403.notified']) expect(existsSync(`${hookLogPath(h.env())}${suffix}`)).toBe(false);
      expect(existsSync(credentialsPath(h.env()))).toBe(false);
    });
  });

  it('help names the policy and delete-account', async () => {
    const res = await h.run(['help']);
    expect(res.stdout).toContain('Privacy policy: https://mokkan.dev/privacy. To delete your account and everything on it, run mokkan delete-account in a terminal.');
    expect(res.stdout).toContain('mokkan accept [--yes [--version <v>]]');
  });

  it('hooks: a 403 is logged once, then at most hourly', async () => {
    const lines = () => readFileSync(hookLogPath(h.env()), 'utf8').trim().split('\n');
    for (let i = 0; i < 3; i++) {
      expect(await h.run(['hook', 'stop'], { serverUrl: server.url, loggedIn: true, stdin: '{}' })).toEqual({ code: 0, stdout: '', stderr: '' });
    }
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('stop Accept the updated privacy policy');
    writeFileSync(`${hookLogPath(h.env())}.403.notified`, `${new Date(Date.now() - 3601_000).toISOString()}\n`);
    await h.run(['hook', 'stop'], { serverUrl: server.url, loggedIn: true, stdin: '{}' });
    expect(lines()).toHaveLength(2);
  });

  it('watch stops with the 403 message, exit 4', async () => {
    const res = await h.run(['watch'], { serverUrl: server.url, loggedIn: true, isTTY: true });
    expect(res.code).toBe(4);
    expect(res.stderr).toContain(GATE);
    expect(server.count('GET', '/reminders/pending')).toBe(1);
  });

  describe('mokkan ui', () => {
    it('d leaves the full screen and runs the delete-account flow in the plain terminal', async () => {
      const tty = new FakeTerminal();
      const running = h.run(['ui'], { serverUrl: server.url, loggedIn: true, isTTY: true, tty, answers: ['a long password', 'delete'] });
      await until(() => server.count('GET', '/privacy') > 0);
      tty.type('d');
      const res = await running;
      expect(res.code).toBe(0);
      expect(res.stdout.endsWith('\x1b[?1049lThis deletes a@example.com, its 1 reminder and 42 unspent credits. Payment records are kept without your name.\nAccount deleted.\n')).toBe(true);
      expect(acct.deleted).toBe(true);
    });
  });
});
