import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ENTER_SCREEN, LEAVE_SCREEN } from '../src/tui/terminal.js';
import { CliHarness, FakeTerminal } from './cli-harness.js';
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

  it('lists ui in the usage', async () => {
    const res = await h.run(['help'], { serverUrl: server.url });
    expect(res.stdout).toContain('mokkan ui');
  });
});
