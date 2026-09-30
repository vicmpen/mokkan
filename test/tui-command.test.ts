import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CliIO } from '../src/cli.js';
import { MokkanClient } from '../src/client.js';
import { TuiApp } from '../src/tui/app.js';
import type { Key } from '../src/tui/keys.js';
import { ENTER_SCREEN, LEAVE_SCREEN, runTerminal } from '../src/tui/terminal.js';
import { CliHarness, FakeTerminal, NOW } from './cli-harness.js';
import { FakeServer } from './fake-server.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

describe('mokkan ui', () => {
  let server: FakeServer;
  let h: CliHarness;
  beforeEach(async () => {
    server = new FakeServer();
    await server.start();
    h = new CliHarness();
    server.withAccount();
  });
  afterEach(async () => { await server.stop(); h.dispose(); });

  it('needs an interactive terminal', async () => {
    const res = await h.run(['ui'], { serverUrl: server.url, loggedIn: true });
    expect(res).toEqual({ code: 1, stdout: '', stderr: 'mokkan ui needs an interactive terminal.\n' });
    const slash = await h.run(['--argline', 'ui', '--exit-zero'], { serverUrl: server.url, loggedIn: true });
    expect(slash).toEqual({ code: 0, stdout: 'mokkan ui needs an interactive terminal.\n', stderr: '' });
    const noTerminalObject = await h.run(['ui'], { serverUrl: server.url, loggedIn: true, isTTY: true });
    expect(noTerminalObject.code).toBe(1);
  });

  it('draws the dashboard in the alternate screen in raw mode and quits on q', async () => {
    const tty = new FakeTerminal();
    const running = h.run(['ui'], { serverUrl: server.url, loggedIn: true, isTTY: true, tty });
    tty.type('q');
    const res = await running;
    expect(res.code).toBe(0);
    expect(res.stderr).toBe('');
    expect(res.stdout.startsWith(ENTER_SCREEN)).toBe(true);
    expect(res.stdout.endsWith(LEAVE_SCREEN)).toBe(true);
    expect(strip(res.stdout)).toContain(' mokkan · a@example.com');
    expect(strip(res.stdout)).toContain('x pop · d dequeue · b buy');
    expect(tty.rawModes).toEqual([true, false]);
    // Each line is erased before it is drawn, never after (xterm would erase a character in the last column).
    expect(res.stdout).toContain('\x1b[H\x1b[2K\x1b[1m mokkan');
    expect(res.stdout).not.toContain('\x1b[K');
  });

  it('shows the login screen when logged out and quits on Esc without a request', async () => {
    const tty = new FakeTerminal(60, 20);
    const running = h.run(['ui'], { serverUrl: server.url, isTTY: true, tty });
    tty.type('\x1b');
    const res = await running;
    expect(res.code).toBe(0);
    expect(strip(res.stdout)).toContain(' Log in');
    expect(strip(res.stdout)).toContain('not logged in');
    expect(server.requests).toHaveLength(0);
  });

  describe('driver', () => {
    const ID = 'aaaa1111-0000-0000-0000-000000000000';
    let out: string;
    const io: CliIO = {
      stdout: (t) => { out += t; }, stderr: () => undefined, env: {}, isTTY: true,
      prompt: async () => '', readStdin: async () => '', now: () => NOW, sleep: async () => undefined,
    };
    /** A logged-in app with one reminder on screen. */
    async function loadedApp(make: (client: MokkanClient) => TuiApp = (client) => new TuiApp({ client, email: 'a@example.com', host: 'test', now: () => NOW })): Promise<TuiApp> {
      out = '';
      const acct = server.withAccount();
      acct.reminders.set(ID, { id: ID, text: 'first', state: 'due', position: 1, due_at: null, created_at: NOW.toISOString(), delivered_at: null, acknowledged_at: null, done_at: null });
      const app = make(new MokkanClient({ baseUrl: server.url, credentials: h.saveCreds(server.url), now: () => NOW }));
      await app.refresh();
      expect(app.rows()).toHaveLength(1);
      return app;
    }

    it('stops dispatching keys once one quits: q, x, y in one chunk pops nothing', async () => {
      const app = await loadedApp();
      const tty = new FakeTerminal();
      tty.type('qxy');
      expect(await runTerminal(app, io, tty)).toBe(0);
      await app.refresh(); // waits for anything the keys queued
      expect(server.count('POST', '/reminders/pop')).toBe(0);
      expect(app.state.mode).toEqual({ kind: 'normal' });
    });

    it('shows a failure that escapes a key handler on the message line', async () => {
      class Failing extends TuiApp {
        override handleKey(key: Key): Promise<void> {
          return key.name === 'char' && key.ch === 'z' ? Promise.reject(new Error('boom')) : super.handleKey(key);
        }
      }
      const app = await loadedApp((client) => new Failing({ client, email: 'a@example.com', host: 'test', now: () => NOW }));
      const tty = new FakeTerminal();
      tty.type('zq');
      expect(await runTerminal(app, io, tty)).toBe(0);
      expect(app.state.message).toEqual({ text: 'boom', tone: 'red' });
    });

    it('leaves the alternate screen even when raw mode cannot be turned off', async () => {
      const app = await loadedApp();
      class Broken extends FakeTerminal {
        override setRawMode(on: boolean): void { if (!on) throw new Error('stdin is gone'); super.setRawMode(on); }
      }
      const tty = new Broken();
      tty.type('q');
      await expect(runTerminal(app, io, tty)).rejects.toThrow('stdin is gone');
      expect(out.endsWith(LEAVE_SCREEN)).toBe(true);
    });
  });

  it('lists ui in the usage', async () => {
    const res = await h.run(['help'], { serverUrl: server.url });
    expect(res.stdout).toContain('mokkan ui');
  });
});
