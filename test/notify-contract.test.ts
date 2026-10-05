import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENTS, type AgentContext, type NotifyAgent } from '../src/notify/agents/index.js';
import type { SpawnResult, Spawner } from '../src/spawn.js';
import { BACKENDS, type NotifyBackend } from '../src/notify/backends/index.js';
import { gvariantString } from '../src/notify/backends/linux-gdbus.js';
import { guardDefaultsValue } from '../src/notify/backends/macos-terminal-notifier.js';
import { escapeMarkup } from '../src/notify/sanitize.js';
import type { OscMode } from '../src/notify/config.js';
import { SHELLS, type NotifyShell } from '../src/notify/shells/index.js';

/**
 * The shared contract every registered notify module must meet. Backends are below; agents and shells add their own
 * describe blocks. A new backend gets these tests by being registered, plus one line in BACKEND_TEXT.
 */

/** Unsanitized on purpose: a backend must be safe even when the caller forgot `sanitizeText`. */
const HOSTILE = "\x1b]52;c;x\x07 $(rm -rf ~) \"; do shell script \"x\" <b>&</b> 'x' -flag";
const TITLE = `${HOSTILE} TITLE-MARK`;
const BODY = `${HOSTILE} BODY-MARK`;
/** Fragments of the fixture that must never appear outside the title and body elements. */
const FRAGMENTS = ['rm -rf', 'do shell script', '<b>', '&lt;b', 'TITLE-MARK', 'BODY-MARK', '\x1b', '\x07'];

/** Reverses the GVariant string literal written by `gvariantString`; other arguments come back unchanged. */
function parseGVariantString(arg: string): string {
  if (arg.length < 2 || !arg.startsWith('"') || !arg.endsWith('"')) return arg;
  const inner = arg.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') throw new Error(`unescaped quote in ${arg}`);
    if (ch !== '\\') { out += ch; continue; }
    const next = inner[++i];
    if (next === 'u') { out += String.fromCodePoint(parseInt(inner.slice(i + 1, i + 5), 16)); i += 4; }
    else out += next;
  }
  return out;
}

/**
 * How each backend carries text: `decode` undoes the backend's own quoting, and `markup` says whether the body is
 * Pango markup (escaped) there. The title is never markup.
 */
const BACKEND_TEXT: Record<string, { decode: (arg: string) => string; markup: boolean }> = {
  'macos-terminal-notifier': { decode: (a) => a.replace(/^⁠/, ''), markup: false },
  'macos-osascript': { decode: (a) => a, markup: false },
  'linux-notify-send': { decode: (a) => a, markup: true },
  'linux-gdbus': { decode: parseGVariantString, markup: true },
  'linux-kdialog': { decode: (a) => a, markup: false },
};

describe('backend registry', () => {
  it('has unique names in the documented order', () => {
    expect(BACKENDS.map((b) => b.name)).toEqual([
      'macos-terminal-notifier', 'macos-osascript', 'linux-notify-send', 'linux-gdbus', 'linux-kdialog',
    ]);
  });
});

/** A probe that knows every command, and records every call. */
function recordingProbe(installed: boolean, calls: string[]) {
  return { which: async (cmd: string) => { calls.push(cmd); return installed; } };
}

for (const backend of BACKENDS as NotifyBackend[]) {
  describe(`backend contract: ${backend.name}`, () => {
    const text = BACKEND_TEXT[backend.name];

    it('is described in BACKEND_TEXT', () => {
      expect(text).toBeDefined();
    });

    it('runs a bare command name', () => {
      const { file } = backend.command('t', 'b');
      expect(file).toMatch(/^[a-z][a-z0-9-]*$/);
    });

    it('carries the hostile title and body as one argv element each, and nowhere else', () => {
      const { args } = backend.command(TITLE, BODY);
      expect(args.every((a) => typeof a === 'string')).toBe(true);
      const titleAt = args.findIndex((a) => a.includes('TITLE-MARK'));
      const bodyAt = args.findIndex((a) => a.includes('BODY-MARK'));
      expect(titleAt).toBeGreaterThanOrEqual(0);
      expect(bodyAt).toBeGreaterThanOrEqual(0);
      expect(titleAt).not.toBe(bodyAt);
      expect(text.decode(args[titleAt])).toBe(TITLE);
      expect(text.decode(args[bodyAt])).toBe(text.markup ? escapeMarkup(BODY) : BODY);
      args.forEach((a, i) => {
        if (i === titleAt || i === bodyAt) return;
        for (const f of FRAGMENTS) expect(a, `argv[${i}] of ${backend.name}`).not.toContain(f);
      });
    });

    it('escapes markup only in the body, and only where the backend needs it', () => {
      const { args } = backend.command('<i>a & b</i>', '<b>c & d</b>');
      const title = args.find((a) => text.decode(a).includes('a & b'));
      expect(title && text.decode(title)).toBe('<i>a & b</i>');
      const body = args.map(text.decode).find((a) => a.includes('c &'));
      expect(body).toBe(text.markup ? '&lt;b&gt;c &amp; d&lt;/b&gt;' : '<b>c & d</b>');
    });

    it('keeps text that looks like an option or a literal as text', () => {
      for (const t of ['-flag', '--help', "'x'", '123', 'true', '[]', '"quoted"', 'a\\b', '(a,b)', '{k=v;}', '']) {
        const { args } = backend.command(`${t}`, `${t}`);
        const decoded = args.map(text.decode);
        expect(decoded.filter((a) => a === t).length, `${backend.name} with ${JSON.stringify(t)}`)
          .toBeGreaterThanOrEqual(text.markup && /[&<>]/.test(t) ? 1 : 2);
      }
    });

    it('decides availability from the probe alone, and only on its platforms', async () => {
      for (const os of ['macos', 'linux', 'other']) {
        for (const installed of [true, false]) {
          const calls: string[] = [];
          const first = await backend.available({ os }, recordingProbe(installed, calls));
          const second = await backend.available({ os }, recordingProbe(installed, []));
          expect(second).toBe(first);
          if (!(backend.platforms as string[]).includes(os)) expect(first).toBe(false);
        }
      }
      for (const os of backend.platforms) {
        // Installed everywhere means available on its own platforms.
        expect(await backend.available({ os }, recordingProbe(true, []))).toBe(true);
      }
    });
  });
}

describe('backend details', () => {
  it('osascript passes text as run arguments, never inside the script', () => {
    const { args } = BACKENDS.find((b) => b.name === 'macos-osascript')!.command(TITLE, BODY);
    const scripts = args.filter((_, i) => args[i - 1] === '-e');
    expect(scripts.join('\n')).toBe(
      'on run argv\ndisplay notification (item -1 of argv) with title (item -2 of argv)\nend run');
    expect(args.slice(-3)).toEqual(['--', TITLE, BODY]);
  });

  it('notify-send puts -- before the positional text', () => {
    const { args } = BACKENDS.find((b) => b.name === 'linux-notify-send')!.command('-t', '-b');
    expect(args).toEqual(['--app-name=mokkan', '--', '-t', '-b']);
  });

  it('gdbus writes every string as a typed literal that no GVariant reading can change', () => {
    expect(gvariantString("'x'")).toBe(`"'x'"`);
    expect(gvariantString('123')).toBe('"123"');
    expect(gvariantString('true')).toBe('"true"');
    expect(gvariantString('[]')).toBe('"[]"');
    expect(gvariantString('"quoted"')).toBe('"\\"quoted\\""');
    expect(gvariantString('a\\b')).toBe('"a\\\\b"');
    expect(gvariantString('a\x1bb\x07\x9b')).toBe('"a\\u001bb\\u0007\\u009b"');
    expect(gvariantString('')).toBe('""');
    const { args } = BACKENDS.find((b) => b.name === 'linux-gdbus')!.command('-flag', '-flag');
    expect(args.slice(-8)).toEqual(['"mokkan"', 'uint32 0', '""', '"-flag"', '"-flag"', '@as []', '@a{sv} {}', 'int32 -1']);
    // Nothing after --method may look like an option.
    expect(args.slice(args.indexOf('--method') + 2).some((a) => a.startsWith('-'))).toBe(false);
  });

  it('terminal-notifier guards values NSUserDefaults would parse', () => {
    for (const t of ['-flag', '[x]', '(a,b)', '{a=b;}', '<00>', '"q"', "'q'", '\\x', ' x', '']) {
      expect(guardDefaultsValue(t)).toBe(`⁠${t}`);
    }
    expect(guardDefaultsValue('plain text')).toBe('plain text');
    const { args } = BACKENDS.find((b) => b.name === 'macos-terminal-notifier')!.command('T', 'B');
    expect(args).toEqual(['-title', 'T', '-message', 'B', '-group', 'mokkan']);
  });
});

/** A Spawner that records every call and answers `result(file, args)` (exit 0 by default). */
function recordingSpawner(result: (file: string, args: string[]) => SpawnResult = () => ({ code: 0, stdout: '', stderr: '' })) {
  const calls: string[][] = [];
  const spawn: Spawner = async (file, args) => { calls.push([file, ...args]); return result(file, args); };
  return { calls, spawn };
}

for (const agent of AGENTS as NotifyAgent[]) {
  describe(`agent contract: ${agent.name}`, () => {
    let dir: string;
    let ctx: AgentContext;
    let calls: string[][];

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), 'mokkan-agent-'));
      const cli = path.join(dir, 'pkg dir', 'cli.js');
      mkdirSync(path.dirname(cli));
      writeFileSync(cli, '');
      const xdg = path.join(dir, 'cfg');
      const rec = recordingSpawner();
      calls = rec.calls;
      ctx = {
        env: { HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: xdg }, spawn: rec.spawn, uid: 501,
        node: process.execPath, cli, interval: 300, xdgConfigHome: xdg,
      };
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('manages files under the temp HOME or XDG_CONFIG_HOME, matching render()', () => {
      const files = agent.files(ctx);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) expect(f.startsWith(dir + path.sep)).toBe(true);
      expect(agent.render(ctx).map((f) => f.path)).toEqual(files);
      expect(agent.render(ctx)).toEqual(agent.render(ctx));
    });

    it('install, installed, a second install that changes nothing, remove', async () => {
      expect(await agent.installed(ctx)).toBe('no');
      const first = await agent.install(ctx);
      expect(first.changed).toBe(true);
      expect(await agent.installed(ctx)).toBe('yes');
      const stats = agent.files(ctx).map((f) => statSync(f));
      for (const [i, f] of agent.files(ctx).entries()) {
        expect(readFileSync(f, 'utf8').split('\n', 5).map((l) => l.trim())).toContain(agent.marker);
        expect(stats[i].mode & 0o777).toBe(0o644);
      }

      calls.length = 0;
      const second = await agent.install(ctx);
      expect(second.changed).toBe(false);
      for (const [i, f] of agent.files(ctx).entries()) {
        const now = statSync(f);
        expect(now.mtimeMs).toBe(stats[i].mtimeMs);
        expect(now.ino).toBe(stats[i].ino);
      }
      // Only checks: nothing that loads, reloads or enables.
      expect(calls.flat().some((a) => ['bootstrap', 'bootout', 'daemon-reload', 'enable'].includes(a))).toBe(false);

      const removed = await agent.remove(ctx);
      expect(removed.changed).toBe(true);
      for (const f of agent.files(ctx)) expect(existsSync(f)).toBe(false);
      expect(await agent.installed(ctx)).toBe('no');
    });

    it('leaves a file with its name but without the marker alone', async () => {
      const file = agent.files(ctx)[0];
      mkdirSync(path.dirname(file), { recursive: true });
      const foreign = 'not ours\n# managed elsewhere\n';
      writeFileSync(file, foreign);
      expect(await agent.installed(ctx)).toBe('foreign');

      const r = await agent.install(ctx);
      expect(r.changed).toBe(false);
      expect(r.messages.join('\n')).toContain(`${file} exists and is not mokkan's; left alone`);
      expect(readFileSync(file, 'utf8')).toBe(foreign);
      for (const other of agent.files(ctx).slice(1)) expect(existsSync(other)).toBe(false);

      await agent.remove(ctx);
      expect(readFileSync(file, 'utf8')).toBe(foreign);
      expect(await agent.installed(ctx)).toBe('foreign');
      expect(calls.flat()).not.toContain('bootstrap');
      expect(calls.flat()).not.toContain('enable');
    });

    it('is stale when the baked cli no longer exists or the content differs', async () => {
      await agent.install(ctx);
      expect(await agent.installed({ ...ctx, cli: path.join(dir, 'gone', 'cli.js') })).toBe('stale');
      rmSync(ctx.cli);
      expect(await agent.installed(ctx)).toBe('stale');
      writeFileSync(ctx.cli, '');
      expect(await agent.installed({ ...ctx, xdgConfigHome: undefined })).toBe('stale');
      expect(await agent.installed(ctx)).toBe('yes');
    });

    it('rewrites a stale file of its own', async () => {
      await agent.install(ctx);
      const file = agent.files(ctx)[0];
      writeFileSync(file, `${readFileSync(file, 'utf8')}# edited\n`);
      expect(await agent.installed(ctx)).toBe('stale');
      expect((await agent.install(ctx)).changed).toBe(true);
      expect(await agent.installed(ctx)).toBe('yes');
    });
  });
}

describe('agent commands', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'mokkan-agent-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const agent = (name: string) => AGENTS.find((a) => a.name === name)!;
  const context = (spawn: Spawner): AgentContext => ({
    env: { HOME: path.join(dir, 'home') }, spawn, uid: 501, node: process.execPath, cli: process.execPath, interval: 120,
  });

  it('launchd boots out, then bootstraps into gui/<uid>; remove boots out', async () => {
    const { calls, spawn } = recordingSpawner();
    const ctx = context(spawn);
    const plist = agent('launchd').files(ctx)[0];
    await agent('launchd').install(ctx);
    expect(calls).toEqual([
      ['launchctl', 'bootout', 'gui/501/dev.mokkan.notify'],
      ['launchctl', 'bootstrap', 'gui/501', plist],
    ]);
    calls.length = 0;
    await agent('launchd').install(ctx);
    expect(calls).toEqual([['launchctl', 'print', 'gui/501/dev.mokkan.notify']]);
    calls.length = 0;
    await agent('launchd').remove(ctx);
    expect(calls).toEqual([['launchctl', 'bootout', 'gui/501/dev.mokkan.notify']]);
  });

  it('launchd reloads identical content that is not loaded', async () => {
    const loaded = recordingSpawner();
    await agent('launchd').install(context(loaded.spawn));
    const { calls, spawn } = recordingSpawner((_, args) => ({ code: args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' }));
    expect((await agent('launchd').install(context(spawn))).changed).toBe(true);
    expect(calls.map((c) => c[1])).toEqual(['print', 'bootout', 'bootstrap']);
  });

  it('systemd reloads and enables the timer; remove disables, deletes and reloads', async () => {
    const { calls, spawn } = recordingSpawner();
    const ctx = context(spawn);
    await agent('systemd-user').install(ctx);
    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'mokkan-notify.timer'],
      ['systemctl', '--user', 'restart', 'mokkan-notify.timer'],
    ]);
    calls.length = 0;
    await agent('systemd-user').install(ctx);
    expect(calls).toEqual([
      ['systemctl', '--user', 'is-enabled', '--quiet', 'mokkan-notify.timer'],
      ['systemctl', '--user', 'is-active', '--quiet', 'mokkan-notify.timer'],
    ]);
    calls.length = 0;
    await agent('systemd-user').remove(ctx);
    expect(calls).toEqual([
      ['systemctl', '--user', 'disable', '--now', 'mokkan-notify.timer'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
  });

  it('xdg-autostart starts nothing', async () => {
    const { calls, spawn } = recordingSpawner();
    const r = await agent('xdg-autostart').install(context(spawn));
    expect(r.messages.join('\n')).toMatch(/next login/);
    await agent('xdg-autostart').remove(context(spawn));
    expect(calls).toEqual([]);
  });

  it('a failed bootstrap or enable is a message, not an exception', async () => {
    const failing = recordingSpawner((_, args) => (['bootstrap', 'enable'].includes(args[0] === '--user' ? args[1] : args[0])
      ? { code: 1, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' }
      : { code: 0, stdout: '', stderr: '' }));
    const launchd = await agent('launchd').install(context(failing.spawn));
    expect(launchd.messages).toContain('launchctl bootstrap gui/501 failed: Bootstrap failed: 5: Input/output error');
    const systemd = await agent('systemd-user').install(context(failing.spawn));
    expect(systemd.messages).toContain(
      'systemctl --user enable mokkan-notify.timer failed: Bootstrap failed: 5: Input/output error');
    const missing = recordingSpawner(() => ({ code: null, stdout: '', stderr: '', error: 'ENOENT' }));
    rmSync(dir, { recursive: true, force: true });
    const r = await agent('systemd-user').install(context(missing.spawn));
    expect(r.messages).toContain('systemctl --user daemon-reload failed: ENOENT');
  });
});

describe('shell registry', () => {
  it('has unique names', () => {
    expect(new Set(SHELLS.map((s) => s.name)).size).toBe(SHELLS.length);
  });
});

const NONINTERACTIVE_GUARD: Record<string, string> = {
  zsh: '[[ -o interactive ]] || return 0',
  bash: '[[ $- == *i* ]] || return 0',
  fish: 'status is-interactive; or exit',
};

for (const shell of SHELLS as NotifyShell[]) {
  describe(`shell contract: ${shell.name}`, () => {
    const modes: OscMode[] = ['off', 'auto', '9', '777', '99'];
    const snippets = modes.map((osc) => shell.snippet({ node: '/usr/bin/node', cli: '/opt/mokkan/cli.js', version: '0.8.0', interval: 60, osc }));

    it('has a non-interactive guard right after the version line', () => {
      expect(NONINTERACTIVE_GUARD[shell.name]).toBeDefined();
      for (const s of snippets) {
        expect(s.split('\n')[0]).toMatch(/^# generated by mokkan 0\.8\.0 \(interval 60, osc [a-z0-9]+\); regenerate with: mokkan notify setup$/);
        expect(s.split('\n')[1]).toBe(NONINTERACTIVE_GUARD[shell.name]);
      }
    });

    it('leaves no <placeholder> behind', () => {
      for (const s of snippets) expect(s).not.toMatch(/<[a-z_]+>/i);
    });

    it('checks MOKKAN_NOTIFY before starting node', () => {
      for (const s of snippets) {
        expect(s).toContain('MOKKAN_NOTIFY');
        expect(s.indexOf('MOKKAN_NOTIFY')).toBeLessThan(s.indexOf("'/usr/bin/node'"));
      }
    });

    it('never expands reminder text', () => {
      for (const s of snippets) {
        expect(s).not.toContain('print -P "$');
        expect(s).not.toContain('echo -e');
      }
    });

    it('has a stable rc file and an rc line or drop-in that sources init.<shell>', () => {
      expect(shell.rcFile({ HOME: '/h' }, 'linux')).toMatch(/^\/h\//);
      expect(shell.rcLine()).toContain(`mokkan/notify/init.${shell.name}`);
      if (shell.installStyle === 'drop-in') expect(shell.rcLine()).toMatch(/^# managed by mokkan/);
      else expect(shell.rcLine()).not.toContain('\n');
    });
  });
}
