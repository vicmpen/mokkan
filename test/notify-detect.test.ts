import { describe, it, expect } from 'vitest';
import { detectPlatform, makeProbe, type Probe, type ProbeFs } from '../src/notify/detect.js';
import type { SpawnResult, Spawner } from '../src/spawn.js';

const UID = 1000;

interface Machine {
  commands?: string[];
  launchctlGui?: boolean;
  systemdUser?: boolean;
  serviceOwned?: boolean;
  graphicalSession?: boolean;
  procVersion?: string;
  busSocket?: boolean;
}

/** A Probe answering from a description of the machine; it records which checks ran. */
function fakeProbe(m: Machine, calls: string[] = []): Probe {
  const note = <T>(name: string, value: T): Promise<T> => { calls.push(name); return Promise.resolve(value); };
  return {
    which: (cmd) => note(`which ${cmd}`, (m.commands ?? []).includes(cmd)),
    launchctlGui: () => note('launchctlGui', m.launchctlGui ?? false),
    systemdUser: () => note('systemdUser', m.systemdUser ?? false),
    notificationServiceOwned: () => note('notificationServiceOwned', m.serviceOwned ?? false),
    graphicalLoginSession: () => note('graphicalLoginSession', m.graphicalSession ?? false),
    readProcVersion: () => note('readProcVersion', m.procVersion ?? 'Linux version 6.8.0-45-generic (buildd@lcy02)'),
    sessionBusExists: () => note('sessionBusExists', m.busSocket ?? false),
  };
}

const SSH = { SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22', SSH_TTY: '/dev/pts/1' };

interface Case {
  name: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  machine: Machine;
  gui: boolean;
  agent: string | null;
  backend: string | null;
}

const CASES: Case[] = [
  {
    name: 'GNOME Wayland', platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    machine: { commands: ['notify-send', 'gdbus'], serviceOwned: true, systemdUser: true, graphicalSession: true, busSocket: true },
    gui: true, agent: 'systemd-user', backend: 'linux-notify-send',
  },
  {
    name: 'KDE X11', platform: 'linux',
    env: { DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    machine: { commands: ['notify-send', 'gdbus', 'kdialog'], serviceOwned: true, systemdUser: true, graphicalSession: true, busSocket: true },
    gui: true, agent: 'systemd-user', backend: 'linux-notify-send',
  },
  {
    name: 'sway with no libnotify', platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' },
    machine: { commands: ['gdbus'], serviceOwned: true, systemdUser: true, busSocket: true },
    gui: true, agent: 'systemd-user', backend: 'linux-gdbus',
  },
  {
    name: 'Alpine + XFCE without systemd', platform: 'linux',
    env: { DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus-abc' },
    machine: { commands: ['notify-send'], serviceOwned: true, systemdUser: false },
    gui: true, agent: 'xdg-autostart', backend: 'linux-notify-send',
  },
  {
    name: 'headless Debian over SSH (user manager, no notification service)', platform: 'linux',
    env: { ...SSH },
    machine: { commands: ['gdbus'], systemdUser: true, busSocket: true, serviceOwned: false, graphicalSession: false },
    gui: false, agent: null, backend: null,
  },
  {
    name: 'GNOME desktop reached over SSH (no DISPLAY, service owned)', platform: 'linux',
    env: { ...SSH },
    machine: { commands: ['notify-send'], systemdUser: true, busSocket: true, serviceOwned: true, graphicalSession: true },
    gui: true, agent: 'systemd-user', backend: 'linux-notify-send',
  },
  {
    name: 'macOS console', platform: 'darwin',
    env: {},
    machine: { launchctlGui: true },
    gui: true, agent: 'launchd', backend: 'macos-osascript',
  },
  {
    name: 'macOS over SSH with nobody at the console', platform: 'darwin',
    env: { ...SSH },
    machine: { launchctlGui: false, commands: ['terminal-notifier'] },
    gui: false, agent: null, backend: null,
  },
  {
    name: 'WSL', platform: 'linux',
    env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' },
    machine: {
      procVersion: 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@1)', commands: ['notify-send', 'gdbus'],
      serviceOwned: true, systemdUser: true, busSocket: true, graphicalSession: true,
    },
    gui: false, agent: null, backend: null,
  },
];

describe('detectPlatform', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const facts = await detectPlatform(c.env, c.platform, UID, fakeProbe(c.machine));
      expect({ gui: facts.gui, agent: facts.agent, backend: facts.backends[0] ?? null })
        .toEqual({ gui: c.gui, agent: c.agent, backend: c.backend });
      expect(facts.reasons.length).toBeGreaterThan(0);
    });
  }

  it('flags ssh, tmux and WSL', async () => {
    const wsl = await detectPlatform({ ...SSH, TMUX: '/tmp/tmux-1000/default,1,0' }, 'linux', UID,
      fakeProbe({ procVersion: 'Linux version 5.15 (Microsoft@Microsoft.com)' }));
    expect(wsl).toMatchObject({ os: 'linux', ssh: true, tmux: true, wsl: true, backends: [] });
    const plain = await detectPlatform({}, 'linux', UID, fakeProbe({}));
    expect(plain).toMatchObject({ ssh: false, tmux: false, wsl: false });
    expect((await detectPlatform({ SSH_TTY: '/dev/pts/0' }, 'linux', UID, fakeProbe({}))).ssh).toBe(true);
  });

  it('lists every available backend in registry order, terminal-notifier first on macOS', async () => {
    const mac = await detectPlatform({}, 'darwin', UID, fakeProbe({ launchctlGui: true, commands: ['terminal-notifier'] }));
    expect(mac.backends).toEqual(['macos-terminal-notifier', 'macos-osascript']);
    const kde = await detectPlatform({ DBUS_SESSION_BUS_ADDRESS: 'x' }, 'linux', UID,
      fakeProbe({ serviceOwned: true, commands: ['kdialog', 'gdbus', 'notify-send'] }));
    expect(kde.backends).toEqual(['linux-notify-send', 'linux-gdbus', 'linux-kdialog']);
  });

  it('does not need the notification service when loginctl shows a graphical session', async () => {
    const facts = await detectPlatform({}, 'linux', UID, fakeProbe({ graphicalSession: true, systemdUser: true, commands: ['notify-send'] }));
    expect(facts).toMatchObject({ gui: true, agent: 'systemd-user' });
  });

  it('asks the notification service only when a session bus exists', async () => {
    const calls: string[] = [];
    await detectPlatform({}, 'linux', UID, fakeProbe({ serviceOwned: true }, calls));
    expect(calls).not.toContain('notificationServiceOwned');
  });

  it('does not count a user manager as a reason for an agent on a headless machine', async () => {
    const calls: string[] = [];
    const facts = await detectPlatform({}, 'linux', UID, fakeProbe({ systemdUser: true, busSocket: true }, calls));
    expect(facts.agent).toBeNull();
    expect(calls).not.toContain('systemdUser');
  });

  it('has nothing on other platforms', async () => {
    const facts = await detectPlatform({}, 'win32', UID, fakeProbe({ commands: ['notify-send'] }));
    expect(facts).toMatchObject({ os: 'other', gui: false, agent: null, backends: [] });
  });
});

type Reply = Partial<SpawnResult>;

/** A Spawner answering by the joined command line; anything unknown is missing (ENOENT). */
function fakeSpawner(replies: Record<string, Reply>, calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = []): Spawner {
  return async (file, args, opts) => {
    calls.push({ file, args, env: opts?.env });
    const reply = replies[[file, ...args].join(' ')];
    if (!reply) return { code: null, stdout: '', stderr: '', error: 'ENOENT' };
    return { code: 0, stdout: '', stderr: '', ...reply };
  };
}

const noFs: ProbeFs = { isExecutable: () => false, exists: () => false, readFile: () => null };

const BUSCTL = 'busctl --user status org.freedesktop.Notifications';
const GDBUS = 'gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus '
  + '--method org.freedesktop.DBus.NameHasOwner org.freedesktop.Notifications';
const SYSTEMCTL = 'systemctl --user is-system-running';

describe('makeProbe', () => {
  it('counts a degraded user manager as reachable', async () => {
    const probe = (r: Reply) => makeProbe(fakeSpawner({ [SYSTEMCTL]: r }), {}, UID, noFs);
    expect(await probe({ code: 0, stdout: 'running\n' }).systemdUser()).toBe(true);
    expect(await probe({ code: 1, stdout: 'degraded\n' }).systemdUser()).toBe(true);
    expect(await probe({ code: 1, stdout: 'offline\n' }).systemdUser()).toBe(false);
    expect(await probe({ code: 1, stdout: '', stderr: 'Failed to connect to bus' }).systemdUser()).toBe(false);
    expect(await makeProbe(fakeSpawner({}), {}, UID, noFs).systemdUser()).toBe(false);
  });

  it('checks the notification service with busctl, then gdbus NameHasOwner', async () => {
    const owned = (replies: Record<string, Reply>) => makeProbe(fakeSpawner(replies), {}, UID, noFs).notificationServiceOwned();
    expect(await owned({ [BUSCTL]: { code: 0 } })).toBe(true);
    expect(await owned({ [BUSCTL]: { code: 1 }, [GDBUS]: { stdout: '(true,)\n' } })).toBe(true);
    expect(await owned({ [GDBUS]: { stdout: '(true,)\n' } })).toBe(true);
    expect(await owned({ [GDBUS]: { stdout: '(false,)\n' } })).toBe(false);
    expect(await owned({ [GDBUS]: { code: 1, stdout: '(true,)\n' } })).toBe(false);
    expect(await owned({})).toBe(false);
  });

  it('points the bus tools at /run/user/<uid>/bus when the environment has no session bus (SSH)', async () => {
    const calls: Array<{ file: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const fs: ProbeFs = { ...noFs, exists: (f) => f === '/run/user/1000/bus' };
    await makeProbe(fakeSpawner({}, calls), { PATH: '/usr/bin' }, UID, fs).notificationServiceOwned();
    expect(calls[0].env).toMatchObject({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000' });
    const kept: typeof calls = [];
    await makeProbe(fakeSpawner({}, kept), { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/x' }, UID, fs).notificationServiceOwned();
    expect(kept[0].env?.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/tmp/x');
  });

  it('turns every missing tool into false', async () => {
    const probe = makeProbe(fakeSpawner({}), {}, UID, noFs);
    expect(await probe.launchctlGui(UID)).toBe(false);
    expect(await probe.graphicalLoginSession(UID)).toBe(false);
    expect(await probe.readProcVersion()).toBe('');
    expect(await probe.sessionBusExists(UID)).toBe(false);
    expect(await probe.which('notify-send')).toBe(false);
  });

  it('reads launchctl print gui/<uid> by exit code', async () => {
    expect(await makeProbe(fakeSpawner({ 'launchctl print gui/501': { code: 0 } }), {}, 501, noFs).launchctlGui(501)).toBe(true);
    expect(await makeProbe(fakeSpawner({ 'launchctl print gui/501': { code: 113 } }), {}, 501, noFs).launchctlGui(501)).toBe(false);
  });

  it('finds an x11 or wayland session for the uid with loginctl', async () => {
    const list = { stdout: '  3 1000 alice seat0 tty2\n  7 1001 bob   -     pts/0\n c2 1000 alice -   pts/3\n' };
    const show = (type: string, state = 'active') => ({ stdout: `Type=${type}\nState=${state}\n` });
    const session = (replies: Record<string, Reply>, uid = 1000) =>
      makeProbe(fakeSpawner({ 'loginctl list-sessions --no-legend': list, ...replies }), {}, uid, noFs).graphicalLoginSession(uid);
    const SHOW = (id: string) => `loginctl show-session ${id} -p Type -p State`;
    expect(await session({ [SHOW('3')]: show('wayland'), [SHOW('c2')]: show('tty') })).toBe(true);
    expect(await session({ [SHOW('3')]: show('tty'), [SHOW('c2')]: show('x11') })).toBe(true);
    expect(await session({ [SHOW('3')]: show('tty'), [SHOW('c2')]: show('tty') })).toBe(false);
    expect(await session({ [SHOW('3')]: show('wayland', 'closing') })).toBe(false);
    // bob's x11 session is not alice's desktop.
    expect(await session({ [SHOW('7')]: show('x11') })).toBe(false);
    expect(await session({ [SHOW('7')]: show('x11') }, 1001)).toBe(true);
  });

  it('looks commands up on PATH and reads /proc/version and the bus socket from the filesystem', async () => {
    const fs: ProbeFs = {
      isExecutable: (f) => f === '/opt/bin/notify-send',
      exists: (f) => f === '/run/user/1000/bus',
      readFile: (f) => (f === '/proc/version' ? 'Linux version 5.15 microsoft' : null),
    };
    const probe = makeProbe(fakeSpawner({}), { PATH: '/usr/bin::/opt/bin' }, UID, fs);
    expect(await probe.which('notify-send')).toBe(true);
    expect(await probe.which('gdbus')).toBe(false);
    expect(await probe.readProcVersion()).toContain('microsoft');
    expect(await probe.sessionBusExists(1000)).toBe(true);
    expect(await probe.sessionBusExists(1001)).toBe(false);
  });
});
