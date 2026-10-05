import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CliHarness, reminder } from './cli-harness.js';
import { FakeServer } from './fake-server.js';
import { bakedPathsOf, redact, stableNode, type NotifyEnv, type NotifyStatusJson } from '../src/commands/notify.js';
import { bash } from '../src/notify/shells/bash.js';
import { fish } from '../src/notify/shells/fish.js';
import { zsh } from '../src/notify/shells/zsh.js';
import { RC_BEGIN } from '../src/notify/shells/index.js';
import type { SpawnResult, Spawner } from '../src/spawn.js';
import { VERSION } from '../src/version.js';

const ENOENT: SpawnResult = { code: null, stdout: '', stderr: '', error: 'ENOENT' };
const OK: SpawnResult = { code: 0, stdout: '', stderr: '' };

/** A Spawner that records `file args...` and answers through `answer` (missing command when it returns undefined). */
function recorder(answer: (file: string, args: string[]) => SpawnResult | undefined): { spawn: Spawner; calls: string[] } {
  const calls: string[] = [];
  const spawn: Spawner = async (file, args) => {
    calls.push([file, ...args].join(' '));
    return answer(file, args) ?? ENOENT;
  };
  return { spawn, calls };
}

/** Linux with GNOME: a notification service on the session bus, a systemd user manager, notify-send. */
const gnome = (): ReturnType<typeof recorder> => recorder((file, args) => {
  if (file === 'busctl') return OK;
  if (file === 'systemctl') return args.includes('is-system-running') ? { ...OK, stdout: 'running\n' } : OK;
  if (file === 'notify-send') return OK;
  return undefined;
});

/** macOS with someone at the console. */
const mac = (): ReturnType<typeof recorder> => recorder((file) => (file === 'launchctl' || file === 'osascript' ? OK : undefined));

describe('mokkan notify', () => {
  let h: CliHarness;
  let ne: NotifyEnv;
  let bin: string;

  beforeEach(() => {
    h = new CliHarness();
    mkdirSync(h.home, { recursive: true });
    bin = path.join(h.configHome, 'bin');
    mkdirSync(bin);
    const opt = path.join(h.configHome, 'opt');
    mkdirSync(path.join(opt, 'mokkan', 'dist'), { recursive: true });
    writeFileSync(path.join(opt, 'node'), '', { mode: 0o755 });
    writeFileSync(path.join(opt, 'mokkan', 'dist', 'cli.js'), '');
    ne = { node: path.join(opt, 'node'), cli: path.join(opt, 'mokkan', 'dist', 'cli.js'), uid: 4242, platform: 'linux', hostname: 'testhost' };
  });
  afterEach(() => h.dispose());

  const notifyDir = (): string => path.join(h.configHome, 'mokkan', 'notify');
  const configFile = (): string => path.join(h.configHome, 'mokkan', 'config.json');
  const unitDir = (): string => path.join(h.configHome, 'systemd', 'user');
  const bashrc = (): string => path.join(h.home, '.bashrc');
  const backups = (): string[] => readdirSync(h.home).filter((f) => f.includes('.mokkan-bak'));
  const mtime = (f: string): number => statSync(f).mtimeMs;

  function addNotifier(name: string): void {
    writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  }

  const gnomeEnv = (): NodeJS.ProcessEnv => ({ SHELL: '/bin/bash', PATH: bin, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus' });

  async function setupGnome(answers = ['y', 'y', 'y', 'y', 'y']) {
    addNotifier('notify-send');
    const fake = gnome();
    const r = await h.run(['notify', 'setup'], { isTTY: true, answers, env: gnomeEnv(), spawn: fake.spawn, notify: ne });
    return { ...r, calls: fake.calls };
  }

  describe('setup', () => {
    it('on Linux with GNOME: rc block, init.bash, desktop consent, systemd timer and a test notification', async () => {
      writeFileSync(bashrc(), 'alias ll="ls -l"\n');
      const r = await setupGnome();
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Prompt hook for bash: a marked block in ~/.bashrc');
      expect(r.stdout).toContain('A background agent (systemd-user) that checks every 60 s');
      expect(readFileSync(bashrc(), 'utf8')).toContain(RC_BEGIN);
      expect(readFileSync(bashrc(), 'utf8')).toContain(bash.rcLine());
      expect(readFileSync(path.join(notifyDir(), 'init.bash'), 'utf8')).toBe(
        bash.snippet({ node: ne.node, cli: ne.cli, version: VERSION, interval: 60, osc: 'off' }));
      expect(JSON.parse(readFileSync(configFile(), 'utf8')).notifications.desktop).toBe(true);
      expect(existsSync(path.join(unitDir(), 'mokkan-notify.service'))).toBe(true);
      expect(existsSync(path.join(unitDir(), 'mokkan-notify.timer'))).toBe(true);
      expect(r.calls).toEqual(expect.arrayContaining([
        'systemctl --user daemon-reload', 'systemctl --user enable mokkan-notify.timer', 'systemctl --user restart mokkan-notify.timer',
        'notify-send --app-name=mokkan -- mokkan test notification',
      ]));
      expect(backups()).toHaveLength(1);
      expect(r.stdout).toContain('exec $SHELL');
    });

    it('a second run with the same answers changes nothing', async () => {
      writeFileSync(bashrc(), 'alias ll="ls -l"\n');
      await setupGnome();
      const files = [bashrc(), path.join(notifyDir(), 'init.bash'), configFile(),
        path.join(unitDir(), 'mokkan-notify.service'), path.join(unitDir(), 'mokkan-notify.timer')];
      const before = files.map(mtime);
      const again = await setupGnome();
      expect(again.code).toBe(0);
      expect(again.stdout).toContain('Nothing changed');
      expect(files.map(mtime)).toEqual(before);
      expect(backups()).toHaveLength(1);
      expect(again.calls).not.toContain('systemctl --user daemon-reload');
    });

    it('on macOS: zsh block, a launchd plist bootstrapped, osascript tried', async () => {
      const fake = mac();
      const r = await h.run(['notify', 'setup'], {
        isTTY: true, answers: ['y', 'y', 'y', 'y', 'y'], env: { SHELL: '/bin/zsh', PATH: bin }, spawn: fake.spawn,
        notify: { ...ne, platform: 'darwin' },
      });
      expect(r.code).toBe(0);
      const plist = path.join(h.home, 'Library', 'LaunchAgents', 'dev.mokkan.notify.plist');
      expect(readFileSync(plist, 'utf8')).toContain('<!-- managed by mokkan -->');
      expect(fake.calls).toContain(`launchctl bootstrap gui/4242 ${plist}`);
      expect(fake.calls.some((c) => c.startsWith('osascript '))).toBe(true);
      expect(readFileSync(path.join(h.home, '.zshrc'), 'utf8')).toContain(RC_BEGIN);
    });

    it('on macOS, a "no" for every backend prints where to allow notifications', async () => {
      const r = await h.run(['notify', 'setup'], {
        isTTY: true, answers: ['n', 'y', 'n', 'y', 'n'], env: { SHELL: '/bin/zsh', PATH: bin }, spawn: mac().spawn,
        notify: { ...ne, platform: 'darwin' },
      });
      expect(r.stdout).toContain('System Settings → Notifications');
      expect(r.stdout).toContain('brew install terminal-notifier');
    });

    it('on a headless machine: only the shell hook, no agent and no desktop question', async () => {
      const fake = recorder(() => undefined);
      const r = await h.run(['notify', 'setup'], { isTTY: true, answers: ['y'], env: { SHELL: '/bin/bash' }, spawn: fake.spawn, notify: ne });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('No desktop notifications or background agent');
      expect(existsSync(path.join(notifyDir(), 'init.bash'))).toBe(true);
      expect(existsSync(unitDir())).toBe(false);
      expect(existsSync(configFile())).toBe(false);
      expect(fake.calls.some((c) => c.startsWith('systemctl --user enable'))).toBe(false);
    });

    it('--yes accepts every step without asking, and leaves OSC off', async () => {
      addNotifier('notify-send');
      const fake = gnome();
      const r = await h.run(['notify', 'setup', '--yes'], {
        isTTY: true, env: { ...gnomeEnv(), SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' }, spawn: fake.spawn, notify: ne,
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('stay off');
      expect(JSON.parse(readFileSync(configFile(), 'utf8')).notifications).toMatchObject({ desktop: true, osc: 'off' });
      expect(existsSync(path.join(unitDir(), 'mokkan-notify.timer'))).toBe(true);
    });

    it('refuses an unstable CLI path before writing anything', async () => {
      const r = await h.run(['notify', 'setup'], {
        isTTY: true, answers: ['y'], env: { SHELL: '/bin/bash' },
        notify: { ...ne, cli: '/home/x/.claude/plugins/cache/mokkan/mokkan/0.7.0/scripts/mokkan.mjs' },
      });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('npm i -g @vicmpen/mokkan-cli');
      expect(r.stderr).toContain('~/.local/bin/mokkan');
      expect(existsSync(bashrc())).toBe(false);
      expect(existsSync(notifyDir())).toBe(false);
    });

    it('refuses without a terminal, and from /mokkan', async () => {
      const noTty = await h.run(['notify', 'setup'], { env: { SHELL: '/bin/bash' }, notify: ne });
      expect(noTty.code).toBe(1);
      expect(noTty.stderr).toBe('Run it in a terminal: mokkan notify setup\n');
      const slash = await h.run(['--argline', 'notify setup --yes', '--exit-zero'], { isTTY: true, env: { SHELL: '/bin/bash' }, notify: ne });
      expect(slash.code).toBe(0);
      expect(slash.stdout).toBe('Run it in a terminal: mokkan notify setup\n');
      const remove = await h.run(['--argline', 'notify remove', '--exit-zero'], { isTTY: true, notify: ne });
      expect(remove.stdout).toBe('Run it in a terminal: mokkan notify remove\n');
      expect(existsSync(bashrc())).toBe(false);
      expect(existsSync(notifyDir())).toBe(false);
    });
  });

  describe('from /mokkan', () => {
    it('allows status, test, doctor, on and off', async () => {
      for (const words of ['notify status', 'notify test', 'notify doctor', 'notify on shell', 'notify off desktop']) {
        const r = await h.run(['--argline', words, '--exit-zero'], { notify: ne });
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain('Run it in a terminal');
        expect(r.stdout).not.toMatch(/Unknown command|Usage:/);
      }
      expect(JSON.parse(readFileSync(configFile(), 'utf8')).notifications).toMatchObject({ shell: true, desktop: false });
    });

    it('on/off keep the paths already baked into init files when running from the plugin cache', async () => {
      await h.run(['notify', 'setup'], { isTTY: true, answers: ['y'], env: { SHELL: '/bin/bash' }, notify: ne });
      const plugin = '/home/x/.claude/plugins/cache/mokkan/mokkan/0.7.0/scripts/mokkan.mjs';
      await h.run(['--argline', 'notify on osc', '--exit-zero'], { notify: { ...ne, cli: plugin } });
      const init = readFileSync(path.join(notifyDir(), 'init.bash'), 'utf8');
      expect(init).toContain('osc auto');
      expect(bakedPathsOf('bash', init)).toEqual({ node: ne.node, cli: ne.cli });
    });
  });

  describe('remove', () => {
    it('takes out the rc block, the agent and the state, and keeps config.json', async () => {
      writeFileSync(bashrc(), 'alias ll="ls -l"\n');
      await setupGnome();
      const fake = gnome();
      const r = await h.run(['notify', 'remove'], { isTTY: true, env: gnomeEnv(), spawn: fake.spawn, notify: ne });
      expect(r.code).toBe(0);
      expect(readFileSync(bashrc(), 'utf8')).toBe('alias ll="ls -l"\n');
      expect(existsSync(path.join(unitDir(), 'mokkan-notify.timer'))).toBe(false);
      expect(existsSync(path.join(unitDir(), 'mokkan-notify.service'))).toBe(false);
      expect(existsSync(notifyDir())).toBe(false);
      expect(existsSync(configFile())).toBe(true);
      expect(fake.calls).toContain('systemctl --user disable --now mokkan-notify.timer');
      expect(r.stdout).toContain('Kept your settings');
    });

    it('removes the fish drop-in only when it carries the marker', async () => {
      const dropIn = fish.rcFile({ XDG_CONFIG_HOME: h.configHome, HOME: h.home }, 'linux');
      mkdirSync(path.dirname(dropIn), { recursive: true });
      writeFileSync(dropIn, fish.rcLine());
      await h.run(['notify', 'remove'], { isTTY: true, notify: ne });
      expect(existsSync(dropIn)).toBe(false);
      writeFileSync(dropIn, 'set -x EDITOR vim\n');
      const r = await h.run(['notify', 'remove'], { isTTY: true, notify: ne });
      expect(existsSync(dropIn)).toBe(true);
      expect(r.stdout).toContain("is not mokkan's");
    });

    it('leaves a foreign unit file and a foreign plist alone', async () => {
      mkdirSync(unitDir(), { recursive: true });
      const timer = path.join(unitDir(), 'mokkan-notify.timer');
      writeFileSync(timer, '[Timer]\nOnCalendar=daily\n');
      const r = await h.run(['notify', 'remove'], { isTTY: true, spawn: gnome().spawn, notify: ne });
      expect(readFileSync(timer, 'utf8')).toBe('[Timer]\nOnCalendar=daily\n');
      expect(r.stdout).toContain("not mokkan's");

      const plist = path.join(h.home, 'Library', 'LaunchAgents', 'dev.mokkan.notify.plist');
      mkdirSync(path.dirname(plist), { recursive: true });
      writeFileSync(plist, '<plist>mine</plist>\n');
      const fake = mac();
      await h.run(['notify', 'remove'], { isTTY: true, spawn: fake.spawn, notify: { ...ne, platform: 'darwin' } });
      expect(readFileSync(plist, 'utf8')).toBe('<plist>mine</plist>\n');
      expect(fake.calls.some((c) => c.startsWith('launchctl bootout'))).toBe(false);
    });
  });

  describe('on/off', () => {
    beforeEach(async () => {
      await h.run(['notify', 'setup'], { isTTY: true, answers: ['y'], env: { SHELL: '/bin/bash' }, notify: ne });
    });
    const config = () => JSON.parse(readFileSync(configFile(), 'utf8')).notifications;
    const header = () => readFileSync(path.join(notifyDir(), 'init.bash'), 'utf8').split('\n')[0];

    it('flips one channel, and regenerates the init file', async () => {
      const r = await h.run(['notify', 'on', 'osc'], { notify: ne });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Regenerated init.bash');
      expect(config()).toEqual({ shell: true, desktop: false, osc: 'auto', interval: 60 });
      expect(header()).toBe(`# generated by mokkan ${VERSION} (interval 60, osc auto); regenerate with: mokkan notify setup`);
      await h.run(['notify', 'on', 'desktop'], { notify: ne });
      expect(config()).toMatchObject({ desktop: true, osc: 'auto' });
      await h.run(['notify', 'off', 'shell'], { notify: ne });
      expect(config()).toMatchObject({ shell: false, desktop: true });
    });

    it('flips every channel without one, with the interval from config.json', async () => {
      await h.run(['notify', 'on'], { notify: ne });
      expect(config()).toEqual({ shell: true, desktop: true, osc: 'auto', interval: 60 });
      writeFileSync(configFile(), JSON.stringify({ notifications: { ...config(), interval: 120 } }));
      await h.run(['notify', 'off'], { notify: ne });
      expect(config()).toEqual({ shell: false, desktop: false, osc: 'off', interval: 120 });
      expect(header()).toContain('(interval 120, osc off)');
    });

    it('rejects an unknown channel', async () => {
      const r = await h.run(['notify', 'on', 'email'], { notify: ne });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Usage: mokkan notify on [shell|desktop|osc]');
    });
  });

  it('status --json has the documented shape', async () => {
    writeFileSync(bashrc(), '');
    await setupGnome();
    const r = await h.run(['notify', 'status', '--json'], { env: gnomeEnv(), spawn: gnome().spawn, notify: ne });
    expect(r.code).toBe(0);
    const s = JSON.parse(r.stdout) as NotifyStatusJson;
    expect(Object.keys(s).sort()).toEqual(
      ['agents', 'backend', 'config', 'configFile', 'disabledBy', 'lastPoll', 'platform', 'problem', 'shells', 'version']);
    expect(s).toMatchObject({
      version: VERSION, config: { shell: true, desktop: true, osc: 'off', interval: 60 }, disabledBy: null, problem: null,
      configFile: configFile(), lastPoll: null, backend: 'linux-notify-send',
      platform: { os: 'linux', gui: true, agent: 'systemd-user', ssh: false, wsl: false, tmux: false, backends: ['linux-notify-send'] },
    });
    expect(s.shells).toEqual([
      { name: 'zsh', rcFile: path.join(h.home, '.zshrc'), hook: false, initFile: path.join(notifyDir(), 'init.zsh'), init: false },
      { name: 'bash', rcFile: bashrc(), hook: true, initFile: path.join(notifyDir(), 'init.bash'), init: true },
      { name: 'fish', rcFile: path.join(h.configHome, 'fish', 'conf.d', 'mokkan.fish'), hook: false, initFile: path.join(notifyDir(), 'init.fish'), init: false },
    ]);
    expect(s.agents).toEqual([
      { name: 'launchd', installed: 'no' }, { name: 'systemd-user', installed: 'yes' }, { name: 'xdg-autostart', installed: 'no' },
    ]);
    const text = await h.run(['notify', 'status'], { env: gnomeEnv(), spawn: gnome().spawn, notify: ne });
    expect(text.stdout).toContain('agent:     systemd-user installed');
  });

  it('test asks per backend on a terminal and reports exit codes without one', async () => {
    addNotifier('notify-send');
    addNotifier('gdbus');
    mkdirSync(path.dirname(configFile()), { recursive: true });
    writeFileSync(configFile(), JSON.stringify({ notifications: { desktop: true, osc: '9' } }));
    const fake = recorder((file) => (file === 'busctl' || file === 'notify-send' ? OK : file === 'gdbus' ? { ...OK, code: 1, stderr: 'no' } : undefined));
    const tty = await h.run(['notify', 'test'], { isTTY: true, answers: ['n'], env: gnomeEnv(), spawn: fake.spawn, notify: ne });
    expect(tty.stdout).toContain('linux-notify-send: sent');
    expect(tty.stdout).toContain('linux-gdbus: failed (no)');
    expect(tty.stdout).toContain('notification daemon running');
    expect(tty.stdout).toContain('\x1b]9;mokkan: test notification\x07');
    const slash = await h.run(['--argline', 'notify test', '--exit-zero'], { env: gnomeEnv(), spawn: fake.spawn, notify: ne });
    expect(slash.stdout).toContain('linux-notify-send: sent');
    expect(slash.stdout).toContain('osc: not sent (not a terminal)');
    expect(slash.stdout).not.toContain('\x1b');
  });

  it('doctor redacts the user name, host name and home path, and never prints DISPLAY', async () => {
    const r = await h.run(['notify', 'doctor'], {
      env: {
        USER: 'alice', LOGNAME: 'alice', HOME: '/home/alice', DISPLAY: 'localhost:17.3', WAYLAND_DISPLAY: 'wayland-secret',
        XDG_SESSION_TYPE: 'wayland', TERM: 'xterm-256color', TERM_PROGRAM: 'alice-on-fakehost',
      },
      notify: { ...ne, hostname: 'fakehost.example.org', cli: '/home/alice/.local/lib/mokkan/dist/cli.js' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/alice|fakehost|17\.3|wayland-secret/);
    expect(r.stdout).toContain('cli ~/.local/lib/mokkan/dist/cli.js (MISSING)');
    expect(r.stdout).toContain('TERM_PROGRAM: <user>-on-<host>');
    expect(r.stdout).toContain('DISPLAY: set, WAYLAND_DISPLAY: set');
    expect(r.stdout).toContain('Detection reasons:');
  });

  it('redact replaces whole words only', () => {
    const env = { HOME: '/home/al', USER: 'al' };
    expect(redact('/home/al/x /home/alan al alan', env, 'box')).toBe('~/x /home/alan <user> alan');
  });

  it('bakedPathsOf reads the node and cli paths back from every shell', () => {
    const paths = { node: "/opt/it's node/bin/node", cli: '/opt/a\\b/cli.js' };
    for (const s of [zsh, bash, fish]) {
      expect(bakedPathsOf(s.name, s.snippet({ ...paths, version: '1.0.0', interval: 60, osc: 'off' }))).toEqual(paths);
    }
  });

  describe('poll', () => {
    it('with a too-open credentials file prints nothing, exits 0 and logs once', async () => {
      h.saveCreds('http://127.0.0.1:9');
      chmodSync(path.join(h.configHome, 'mokkan', 'credentials.json'), 0o644);
      for (let i = 0; i < 2; i++) {
        const r = await h.run(['notify', 'poll'], { notify: ne });
        expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
      }
      const log = readFileSync(path.join(h.configHome, 'mokkan', 'hook.log'), 'utf8').trim().split('\n');
      expect(log).toHaveLength(1);
      expect(log[0]).toContain('readable by other users');
    });

    it('without credentials prints nothing and exits 0', async () => {
      expect(await h.run(['notify', 'poll'], { notify: ne })).toEqual({ code: 0, stdout: '', stderr: '' });
    });

    it('writes shell.txt for a fired scheduled reminder, read-only toward the server', async () => {
      const server = new FakeServer();
      await server.start();
      try {
        const acct = server.withAccount();
        acct.reminders.set('r1', { ...reminder({ id: 'r1', text: 'call mom', due_at: '2026-09-28T11:30:00.000Z' }), state: 'due' });
        h.saveCreds(server.url);
        const r = await h.run(['notify', 'poll'], { notify: ne });
        expect(r).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(readFileSync(path.join(notifyDir(), 'shell.txt'), 'utf8')).toContain('call mom');
        expect(server.count('GET', '/reminders/pending')).toBe(1);
        expect(server.count('POST', '/heartbeat')).toBe(0);
        expect(server.count('POST', '/reminders/deliver')).toBe(0);
      } finally {
        await server.stop();
      }
    });
  });

  describe('shell init', () => {
    it('prints the snippet for this node, cli, version and config', async () => {
      const r = await h.run(['shell', 'init', 'bash'], { notify: ne });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(bash.snippet({ node: ne.node, cli: ne.cli, version: VERSION, interval: 60, osc: 'off' }));
      expect(r.stdout.split('\n')[0]).toBe(`# generated by mokkan ${VERSION} (interval 60, osc off); regenerate with: mokkan notify setup`);
    });

    it('rejects an unknown shell', async () => {
      const r = await h.run(['shell', 'init', 'tcsh'], { notify: ne });
      expect(r.code).toBe(1);
      expect(r.stderr).toBe('Usage: mokkan shell init zsh|bash|fish\n');
    });
  });

  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

describe('stableNode', () => {
  it('prefers a PATH entry that links to the running node over its versioned real path', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mokkan-node-'));
    try {
      const cellar = path.join(root, 'Cellar', 'node', '24.1.0', 'bin');
      const bin = path.join(root, 'bin');
      const other = path.join(root, 'other');
      for (const d of [cellar, bin, other]) mkdirSync(d, { recursive: true });
      const real = path.join(cellar, 'node');
      writeFileSync(real, '');
      writeFileSync(path.join(other, 'node'), '');
      symlinkSync(real, path.join(bin, 'node'));
      const pathVar = ['relative', other, bin].join(path.delimiter);
      expect(stableNode(real, pathVar)).toBe(path.join(bin, 'node'));
      expect(stableNode(real, other)).toBe(real);
      expect(stableNode(real, undefined)).toBe(real);
      expect(stableNode(path.join(root, 'missing'), pathVar)).toBe(path.join(root, 'missing'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
