import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Spawner } from '../spawn.js';
import { BACKENDS, type NotifyBackend } from './backends/index.js';

/**
 * The external checks detection needs, each async and injectable so detection is a pure function of
 * `(env, platform, uid, probe)` and tests never run launchctl, systemctl, busctl, gdbus or loginctl.
 */
export interface Probe {
  /** Whether `cmd` is an executable on PATH. */
  which(cmd: string): Promise<boolean>;
  /** macOS: `launchctl print gui/<uid>` succeeds, i.e. someone is logged in at the console. */
  launchctlGui(uid: number): Promise<boolean>;
  /** `systemctl --user` reaches a user manager (`degraded` counts). */
  systemdUser(): Promise<boolean>;
  /** `org.freedesktop.Notifications` has an owner on the session bus. */
  notificationServiceOwned(): Promise<boolean>;
  /** loginctl shows a live x11 or wayland session for `uid`. */
  graphicalLoginSession(uid: number): Promise<boolean>;
  /** `/proc/version`, or '' where there is none. */
  readProcVersion(): Promise<string>;
  /** The session bus socket `/run/user/<uid>/bus` exists. */
  sessionBusExists(uid: number): Promise<boolean>;
}

export type AgentKind = 'launchd' | 'systemd-user' | 'xdg-autostart';

/** What `notify setup`, `status` and `doctor` need to know about this machine. */
export interface PlatformFacts {
  os: 'macos' | 'linux' | 'other';
  /** A desktop exists that can show a notification (it may be on another screen than the user's, over SSH). */
  gui: boolean;
  /** The background agent to install; null on a headless machine, WSL or an unsupported OS. */
  agent: AgentKind | null;
  ssh: boolean;
  wsl: boolean;
  tmux: boolean;
  /** Available desktop backends in preference order; empty without a GUI. */
  backends: string[];
  /** Why each fact came out the way it did, one line each, for `notify doctor`. */
  reasons: string[];
}

const PROBE_TIMEOUT_MS = 3000;

export function osOf(platform: NodeJS.Platform): PlatformFacts['os'] {
  return platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'other';
}

/** Detects the platform facts, following the spec's detection table. `DISPLAY`/`WAYLAND_DISPLAY` are not required. */
export async function detectPlatform(
  env: NodeJS.ProcessEnv, platform: NodeJS.Platform, uid: number, probe: Probe,
  backends: readonly NotifyBackend[] = BACKENDS,
): Promise<PlatformFacts> {
  const os = osOf(platform);
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY);
  const tmux = Boolean(env.TMUX);
  const reasons: string[] = [];
  if (ssh) reasons.push('ssh: SSH_CONNECTION or SSH_TTY is set');
  if (tmux) reasons.push('tmux: TMUX is set');
  const facts = (gui: boolean, agent: AgentKind | null, wsl = false, names: string[] = []): PlatformFacts =>
    ({ os, gui, agent, ssh, wsl, tmux, backends: names, reasons });

  if (os === 'other') {
    reasons.push(`os: ${platform} has no desktop backend or agent in core`);
    return facts(false, null);
  }

  let gui: boolean;
  let agent: AgentKind | null = null;
  if (os === 'macos') {
    gui = await probe.launchctlGui(uid);
    reasons.push(gui ? `gui: launchctl print gui/${uid} succeeded` : `gui: launchctl print gui/${uid} failed (nobody at the console)`);
    if (gui) agent = 'launchd';
  } else {
    if (/microsoft/i.test(await probe.readProcVersion())) {
      reasons.push('wsl: /proc/version mentions Microsoft; shell and OSC only');
      return facts(false, null, true);
    }
    const bus = Boolean(env.DBUS_SESSION_BUS_ADDRESS) || await probe.sessionBusExists(uid);
    const owned = bus && await probe.notificationServiceOwned();
    if (!bus) reasons.push(`gui: no session bus (DBUS_SESSION_BUS_ADDRESS unset, no /run/user/${uid}/bus)`);
    else reasons.push(owned ? 'gui: org.freedesktop.Notifications is owned on the session bus' : 'gui: no notification service on the session bus');
    gui = owned;
    if (!gui) {
      gui = await probe.graphicalLoginSession(uid);
      reasons.push(gui ? `gui: loginctl shows an x11/wayland session for uid ${uid}` : `gui: loginctl shows no x11/wayland session for uid ${uid}`);
    }
    if (gui) {
      const systemd = await probe.systemdUser();
      reasons.push(systemd ? 'agent: systemctl --user reaches a user manager' : 'agent: no systemd user manager; XDG autostart');
      agent = systemd ? 'systemd-user' : 'xdg-autostart';
    }
  }
  if (!gui) {
    reasons.push('agent: none without a GUI session');
    return facts(false, null);
  }

  const names: string[] = [];
  for (const b of backends) {
    if (!(b.platforms as string[]).includes(os)) continue;
    if (await b.available({ os }, probe)) names.push(b.name);
  }
  reasons.push(names.length > 0 ? `backends: ${names.join(', ')}` : 'backends: none installed');
  return facts(true, agent, false, names);
}

/** Filesystem access for `makeProbe`, injectable for tests. */
export interface ProbeFs {
  isExecutable(file: string): boolean;
  exists(file: string): boolean;
  readFile(file: string): string | null;
}

export const realProbeFs: ProbeFs = {
  isExecutable: (file) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
  exists: (file) => existsSync(file),
  readFile: (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
};

/** States `systemctl --user is-system-running` prints when no manager answers. */
const SYSTEMD_UNREACHABLE = new Set(['', 'offline', 'unknown']);

/** Builds the real Probe on a Spawner. Every check is best effort: a failure or a missing tool means false. */
export function makeProbe(spawn: Spawner, env: NodeJS.ProcessEnv, uid: number, fs: ProbeFs = realProbeFs): Probe {
  // Over SSH the session bus may be unset in the environment even though the desktop's bus is there.
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const busEnv: NodeJS.ProcessEnv = { ...env, XDG_RUNTIME_DIR: runtimeDir };
  if (!busEnv.DBUS_SESSION_BUS_ADDRESS && fs.exists(path.join(runtimeDir, 'bus'))) {
    busEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(runtimeDir, 'bus')}`;
  }
  const run = (file: string, args: string[]) => spawn(file, args, { timeoutMs: PROBE_TIMEOUT_MS, env: busEnv });

  return {
    which: async (cmd) => (env.PATH ?? '').split(path.delimiter)
      .some((dir) => dir !== '' && fs.isExecutable(path.join(dir, cmd))),
    launchctlGui: async (id) => (await run('launchctl', ['print', `gui/${id}`])).code === 0,
    systemdUser: async () => {
      const r = await run('systemctl', ['--user', 'is-system-running']);
      // Exits non-zero when degraded, which still means a manager answered.
      return r.code === 0 || (r.code !== null && !SYSTEMD_UNREACHABLE.has(r.stdout.trim()));
    },
    notificationServiceOwned: async () => {
      if ((await run('busctl', ['--user', 'status', 'org.freedesktop.Notifications'])).code === 0) return true;
      const r = await run('gdbus', [
        'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
        '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.freedesktop.Notifications',
      ]);
      return r.code === 0 && r.stdout.trim() === '(true,)';
    },
    graphicalLoginSession: async (id) => {
      const list = await run('loginctl', ['list-sessions', '--no-legend']);
      if (list.code !== 0) return false;
      // Each line starts with SESSION UID; the remaining columns differ between systemd versions.
      const sessions = list.stdout.split('\n').map((line) => line.trim().split(/\s+/))
        .filter((cols) => cols.length >= 2 && cols[1] === String(id)).map((cols) => cols[0]);
      for (const session of sessions) {
        const show = await run('loginctl', ['show-session', session, '-p', 'Type', '-p', 'State']);
        if (show.code !== 0) continue;
        const props = new Map(show.stdout.split('\n').map((line) => {
          const eq = line.indexOf('=');
          return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()] as const;
        }));
        if ((props.get('Type') === 'x11' || props.get('Type') === 'wayland') && props.get('State') !== 'closing') return true;
      }
      return false;
    },
    readProcVersion: async () => fs.readFile('/proc/version') ?? '',
    sessionBusExists: async (id) => fs.exists(`/run/user/${id}/bus`),
  };
}
