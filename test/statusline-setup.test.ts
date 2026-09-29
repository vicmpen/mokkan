import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isMokkanCommand, TMUX_BEGIN, TMUX_END } from '../src/statusline-setup.js';
import { CliHarness, NOW, type RunOptions } from './cli-harness.js';

const NODE = '/usr/bin/node';

describe('isMokkanCommand', () => {
  it('recognises plain mokkan invocations, old and new', () => {
    for (const cmd of [
      'mokkan statusline',
      '/usr/bin/node /home/u/mokkan-skill/dist/cli.js statusline',
      'node /home/u/.local/share/mokkan/mokkan.mjs statusline --render',
      "'/opt/my node/node' '/home/u/my stuff/mokkan/dist/cli.js' statusline --render",
      'mokkan statusline --format plain --width 60',
    ]) expect(isMokkanCommand(cmd), cmd).toBe(true);
  });

  it('anything else is foreign: scripts, compound commands, other programs', () => {
    for (const cmd of [
      '~/.claude/statusline.sh',
      'bash -c "mokkan statusline"',
      'mokkan statusline; echo hi',
      'node /home/u/other/dist/cli.js statusline',
      'python3 /home/u/mokkan/cli.js statusline',
      'mokkan statusline --render | head -c 80',
      'mokkan list',
    ]) expect(isMokkanCommand(cmd), cmd).toBe(false);
  });
});

describe('mokkan statusline (setup)', () => {
  let h: CliHarness;
  let claudeDir: string;
  let settings: string;
  let tmuxConf: string;
  let cli: string;
  let cmd: string;

  beforeEach(() => {
    h = new CliHarness();
    claudeDir = path.join(h.home, '.claude');
    settings = path.join(claudeDir, 'settings.json');
    tmuxConf = path.join(h.home, '.tmux.conf');
    mkdirSync(h.home, { recursive: true });
    cli = h.fakeCli();
    cmd = `${NODE} ${cli} statusline --render`;
  });
  afterEach(() => h.dispose());

  const run = (args: string[], o: RunOptions = {}) => h.run(['statusline', ...args], { isTTY: true, ...o });
  const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  const backups = (file: string) => readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.mokkan-bak-`));
  const block = (c = cli) => [
    TMUX_BEGIN,
    '# Added by `mokkan statusline`; `mokkan statusline --remove --tmux` takes it out again.',
    'set -g status-interval 15',
    'set -g status-right-length 120',
    `set -g status-right '#(${NODE} ${c} statusline --render --format tmux) %H:%M'`,
    TMUX_END,
  ].join('\n');
  /** A PATH holding an executable `tmux` stub (never run). */
  const tmuxPath = () => {
    const bin = path.join(h.configHome, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nexit 1\n');
    chmodSync(path.join(bin, 'tmux'), 0o755);
    return bin;
  };

  describe('Claude Code', () => {
    it('--claude creates settings.json with the status line', async () => {
      const res = await run(['--claude']);
      expect(res.code).toBe(0);
      expect(readJson(settings)).toEqual({ statusLine: { type: 'command', command: cmd, refreshInterval: 30 } });
      expect(readFileSync(settings, 'utf8')).toBe(`${JSON.stringify(readJson(settings), null, 2)}\n`);
      expect(res.stdout).toContain(`Claude Code: added the status line in ${settings}`);
      expect(res.stdout).toContain('Restart Claude Code');
      expect(backups(settings)).toEqual([]);
      expect(existsSync(tmuxConf)).toBe(false);
    });

    it('keeps every other key and the file\'s indentation, after a timestamped backup', async () => {
      mkdirSync(claudeDir, { recursive: true });
      const original = `{\n    "model": "opus",\n    "permissions": {\n        "allow": ["Bash(ls:*)"]\n    }\n}\n`;
      writeFileSync(settings, original, { mode: 0o600 });
      const res = await run(['--claude']);
      expect(res.code).toBe(0);
      const text = readFileSync(settings, 'utf8');
      expect(JSON.parse(text)).toEqual({
        model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, statusLine: { type: 'command', command: cmd, refreshInterval: 30 },
      });
      expect(text).toContain('\n    "model": "opus"');
      expect(statSync(settings).mode & 0o777).toBe(0o600);
      expect(backups(settings)).toEqual(['settings.json.mokkan-bak-20260928T120000Z']);
      expect(readFileSync(`${settings}.mokkan-bak-20260928T120000Z`, 'utf8')).toBe(original);
      expect(res.stdout).toContain(`backup: ${settings}.mokkan-bak-20260928T120000Z`);
    });

    it('is idempotent: a second run changes nothing and says so', async () => {
      await run(['--claude']);
      const before = readFileSync(settings, 'utf8');
      const mtime = statSync(settings).mtimeMs;
      const res = await run(['--claude']);
      expect(res).toMatchObject({ code: 0 });
      expect(res.stdout).toContain(`Claude Code: already configured in ${settings}.`);
      expect(res.stdout).not.toContain('Restart');
      expect(readFileSync(settings, 'utf8')).toBe(before);
      expect(statSync(settings).mtimeMs).toBe(mtime);
      expect(backups(settings)).toEqual([]);
    });

    it('migrates an old mokkan command (no --render, stale path) and keeps its other settings', async () => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settings, JSON.stringify({
        theme: 'dark',
        statusLine: { type: 'command', command: 'node /old/place/mokkan-skill/dist/cli.js statusline', refreshInterval: 10, padding: 1 },
      }, null, 2));
      const res = await run(['--claude']);
      expect(res.code).toBe(0);
      expect(readJson(settings)).toEqual({
        theme: 'dark', statusLine: { type: 'command', command: cmd, refreshInterval: 10, padding: 1 },
      });
      expect(res.stdout).toContain('updated the status line');
      expect(res.stdout).toContain('(was: node /old/place/mokkan-skill/dist/cli.js statusline)');
      expect(backups(settings)).toHaveLength(1);
    });

    it('never overwrites a status line that is not mokkan\'s without --force', async () => {
      mkdirSync(claudeDir, { recursive: true });
      const original = JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/my-line.sh' } }, null, 2);
      writeFileSync(settings, original);
      const res = await run(['--claude']);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('already has a status line that is not mokkan\'s; left alone');
      expect(res.stdout).toContain('~/.claude/my-line.sh');
      expect(res.stdout).toContain(`make your script also print the output of: ${cmd}`);
      expect(res.stdout).toContain('mokkan statusline --claude --force');
      expect(readFileSync(settings, 'utf8')).toBe(original);
      expect(backups(settings)).toEqual([]);

      const forced = await run(['--claude', '--force']);
      expect(forced.code).toBe(0);
      expect(readJson(settings).statusLine).toEqual({ type: 'command', command: cmd, refreshInterval: 30 });
      expect(forced.stdout).toContain('replaced the status line');
      expect(backups(settings)).toHaveLength(1);
    });

    it('a user script that calls the old mokkan command gets told to add --render', async () => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo "$(mokkan statusline) | $(date)"' } }));
      const res = await run(['--claude']);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('change `statusline` to `statusline --render` there');
    });

    it('refuses to touch settings.json that is not valid JSON', async () => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settings, '{ "model": "opus", }');
      const res = await run(['--claude']);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('is not valid JSON');
      expect(readFileSync(settings, 'utf8')).toBe('{ "model": "opus", }');
    });

    it('respects CLAUDE_CONFIG_DIR', async () => {
      const dir = path.join(h.configHome, 'claude-alt');
      const res = await run(['--claude'], { env: { CLAUDE_CONFIG_DIR: dir } });
      expect(res.code).toBe(0);
      expect(readJson(path.join(dir, 'settings.json')).statusLine.command).toBe(cmd);
      expect(existsSync(settings)).toBe(false);
    });

    it('writes through a symlinked settings.json (dotfile managers) instead of replacing the link', async () => {
      const real = path.join(h.configHome, 'dotfiles', 'settings.json');
      mkdirSync(path.dirname(real), { recursive: true });
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(real, '{}\n');
      symlinkSync(real, settings);
      expect((await run(['--claude'])).code).toBe(0);
      expect(lstatSync(settings).isSymbolicLink()).toBe(true);
      expect(readJson(real).statusLine.command).toBe(cmd);
    });

    it('--remove takes out only mokkan\'s status line; a foreign one stays', async () => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settings, JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: 'mokkan statusline' } }));
      const res = await run(['--claude', '--remove']);
      expect(res.code).toBe(0);
      expect(readJson(settings)).toEqual({ model: 'opus' });
      expect(res.stdout).toContain('removed the mokkan status line');
      expect(backups(settings)).toHaveLength(1);
      expect((await run(['--claude', '--remove'])).stdout).toContain('no status line');

      writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'my-line' } }));
      const foreign = await run(['--claude', '--remove']);
      expect(foreign.stdout).toContain('is not mokkan\'s (my-line); left alone');
      expect(readJson(settings).statusLine.command).toBe('my-line');
    });
  });

  describe('tmux', () => {
    it('adds a marked block after the user\'s config, with a backup; idempotent; --remove restores the file', async () => {
      const original = 'set -g mouse on\n';
      writeFileSync(tmuxConf, original);
      const res = await run(['--tmux']);
      expect(res.code).toBe(0);
      expect(readFileSync(tmuxConf, 'utf8')).toBe(`${original}\n${block()}\n`);
      expect(res.stdout).toContain(`tmux: added the mokkan block in ${tmuxConf}`);
      expect(res.stdout).toContain(`If tmux is running, reload it: tmux source-file ${tmuxConf}`);
      expect(res.stdout).toContain('Codex: its own footer cannot run commands; run Codex inside tmux');
      expect(backups(tmuxConf)).toHaveLength(1);
      expect(existsSync(settings)).toBe(false);

      const again = await run(['--tmux']);
      expect(again.stdout).toContain(`tmux: already configured in ${tmuxConf}.`);
      expect(backups(tmuxConf)).toHaveLength(1);

      const removed = await run(['--codex', '--remove']);
      expect(removed.code).toBe(0);
      expect(readFileSync(tmuxConf, 'utf8')).toBe(original);
      expect(removed.stdout).toContain('removed the mokkan block');
    });

    it('creates ~/.tmux.conf when missing', async () => {
      await run(['--tmux']);
      expect(readFileSync(tmuxConf, 'utf8')).toBe(`${block()}\n`);
      expect(backups(tmuxConf)).toEqual([]);
    });

    it('replaces an outdated mokkan block in place and leaves the rest alone', async () => {
      const old = block('/old/mokkan/dist/cli.js').replace(' --render', '');
      writeFileSync(tmuxConf, `set -g mouse on\n\n${old}\nbind r source-file ~/.tmux.conf\n`);
      const res = await run(['--tmux']);
      expect(res.stdout).toContain('updated the mokkan block');
      expect(readFileSync(tmuxConf, 'utf8')).toBe(`set -g mouse on\n\n${block()}\nbind r source-file ~/.tmux.conf\n`);
    });

    it('an older mokkan status-right outside the block is not foreign: it is pointed out and left', async () => {
      writeFileSync(tmuxConf, "set -g status-right '#(node /x/mokkan/dist/cli.js statusline --format tmux)'\n");
      const res = await run(['--tmux']);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('line 1 is an older mokkan status-right');
      expect(readFileSync(tmuxConf, 'utf8')).toContain(block());
    });

    const snippet = () => `#(${NODE} ${cli} statusline --render --format tmux)`;

    it('auto mode leaves a config with its own status-right alone and prints the #() to combine by hand', async () => {
      const own = "set -g mouse on\nset -g status-right '%H:%M'\n";
      writeFileSync(tmuxConf, own);
      const res = await run([], { env: { PATH: tmuxPath() } });
      expect(res.code).toBe(0);
      expect(readFileSync(tmuxConf, 'utf8')).toBe(own);
      expect(backups(tmuxConf)).toEqual([]);
      expect(res.stdout).toContain(`tmux: skipped: ${tmuxConf} sets its own status-right (line 2)`);
      expect(res.stdout).toContain(`add this to your status-right: ${snippet()}`);
      expect(res.stdout).toContain('mokkan statusline --tmux --force');
    });

    it('auto mode also stays out of a config that loads plugins through TPM (themes set status-right)', async () => {
      const own = "set -g @plugin 'catppuccin/tmux'\nrun '~/.tmux/plugins/tpm/tpm'\n";
      writeFileSync(tmuxConf, own);
      const res = await run([], { env: { PATH: tmuxPath() } });
      expect(res.code).toBe(0);
      expect(readFileSync(tmuxConf, 'utf8')).toBe(own);
      expect(res.stdout).toContain('loads tmux plugins through TPM (line 2)');
    });

    it('explicit --tmux over a foreign status-right needs --force; with it the block goes in and the line is noted', async () => {
      const own = "set -g status-right '%H:%M'\n";
      writeFileSync(tmuxConf, own);
      const refused = await run(['--tmux']);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toContain('left alone');
      expect(refused.stdout).toContain(snippet());
      expect(readFileSync(tmuxConf, 'utf8')).toBe(own);

      const forced = await run(['--tmux', '--force']);
      expect(forced.code).toBe(0);
      expect(readFileSync(tmuxConf, 'utf8')).toBe(`${own}\n${block()}\n`);
      expect(forced.stdout).toContain('line 1 sets your own status-right; the mokkan block overrides it');
      // Once the block is there the user has opted in: later runs keep it current without --force.
      writeFileSync(tmuxConf, `${own}\n${block('/old/mokkan/dist/cli.js')}\n`);
      expect((await run([], { env: { PATH: tmuxPath() } })).stdout).toContain('updated the mokkan block');
    });

    it('finds its block despite CRLF line ends and trailing blanks', async () => {
      writeFileSync(tmuxConf, `set -g mouse on\r\n\r\n${block().split('\n').map((l) => `${l} \r`).join('\n')}\n`);
      const res = await run(['--tmux', '--remove']);
      expect(res.stdout).toContain('removed the mokkan block');
      expect(readFileSync(tmuxConf, 'utf8')).not.toContain('mokkan');
    });

    it('refuses an incomplete block', async () => {
      writeFileSync(tmuxConf, `${TMUX_BEGIN}\nset -g status-interval 15\n`);
      const res = await run(['--tmux']);
      expect(res.code).toBe(1);
      expect(res.stdout).toContain('incomplete mokkan block');
      expect(readFileSync(tmuxConf, 'utf8')).toBe(`${TMUX_BEGIN}\nset -g status-interval 15\n`);
    });

    it('uses $XDG_CONFIG_HOME/tmux/tmux.conf when that exists and ~/.tmux.conf does not', async () => {
      const xdg = path.join(h.configHome, 'tmux', 'tmux.conf');
      mkdirSync(path.dirname(xdg), { recursive: true });
      writeFileSync(xdg, 'set -g mouse on\n');
      await run(['--tmux']);
      expect(readFileSync(xdg, 'utf8')).toContain(TMUX_BEGIN);
      expect(existsSync(tmuxConf)).toBe(false);
    });
  });

  describe('targets, dry run, arguments', () => {
    it('no target flag: Claude Code when ~/.claude exists, tmux when it is on PATH', async () => {
      const none = await run([]);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain(`Claude Code: ${claudeDir} does not exist; skipped`);
      expect(none.stdout).toContain('tmux: not installed; skipped');
      expect(existsSync(settings)).toBe(false);
      expect(existsSync(tmuxConf)).toBe(false);

      mkdirSync(claudeDir, { recursive: true });
      const both = await run([], { env: { PATH: tmuxPath() } });
      expect(both.code).toBe(0);
      expect(readJson(settings).statusLine.command).toBe(cmd);
      expect(readFileSync(tmuxConf, 'utf8')).toContain(block());
    });

    it('--dry-run prints the exact changes and writes nothing', async () => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settings, '{"model":"opus"}');
      const res = await run(['--dry-run'], { env: { PATH: tmuxPath() } });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(`Claude Code: would add the status line in ${settings}:`);
      expect(res.stdout).toContain(`"statusLine": ${JSON.stringify({ type: 'command', command: cmd, refreshInterval: 30 })}`);
      expect(res.stdout).toContain(`tmux: would add this block in ${tmuxConf}:`);
      expect(res.stdout).toContain(`  set -g status-right '#(${NODE} ${cli} statusline --render --format tmux) %H:%M'`);
      expect(res.stdout).toContain('Dry run: nothing was written.');
      expect(readFileSync(settings, 'utf8')).toBe('{"model":"opus"}');
      expect(existsSync(tmuxConf)).toBe(false);
      expect(backups(settings)).toEqual([]);
    });

    it('an unknown word is a usage error and changes nothing', async () => {
      const res = await run(['--claud']);
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('Usage: mokkan statusline [--claude]');
      expect(existsSync(settings)).toBe(false);
    });

    it('through /mokkan (--argline, --exit-zero, no TTY) it configures Claude Code only and reports on stdout', async () => {
      mkdirSync(claudeDir, { recursive: true });
      const res = await h.run(['--argline', 'statusline', '--exit-zero'], { isTTY: false, env: { PATH: tmuxPath() } });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('Claude Code: added the status line');
      expect(readJson(settings).statusLine.command).toBe(cmd);
      expect(existsSync(tmuxConf)).toBe(false);
      expect(res.stdout).toContain('tmux: not set up from Claude Code; add --tmux for the tmux block');

      const tmux = await h.run(['--argline', 'statusline --tmux', '--exit-zero'], { isTTY: false, env: { PATH: tmuxPath() } });
      expect(tmux.stdout).toContain('tmux: added the mokkan block');

      // Removing is not a choice about the user's tmux: /mokkan statusline --remove takes out both (before an uninstall).
      const removed = await h.run(['--argline', 'statusline --remove', '--exit-zero'], { isTTY: false, env: { PATH: tmuxPath() } });
      expect(removed.stdout).toContain('tmux: removed the mokkan block');
      expect(readJson(settings).statusLine).toBeUndefined();
    });

    it('configure or render depends on stdin alone: `mokkan statusline > log` in a terminal configures', async () => {
      mkdirSync(claudeDir, { recursive: true });
      const res = await h.run(['statusline', '--claude'], { isTTY: false, stdinIsTTY: true });
      expect(res.stdout).toContain('Claude Code: added the status line');
      const plain = await h.run(['statusline'], { isTTY: false, stdinIsTTY: true });
      expect(plain.stdout).toContain('Claude Code: already configured');
    });

    it('plain `statusline` no longer renders; --render does', async () => {
      const res = await run([]);
      expect(res.stdout).not.toContain('mokkan: logged out');
      expect((await run(['--render', '--format', 'plain'])).stdout).toBe('mokkan: logged out\n');
      // Older tmux snippets passed render flags without --render: they still render.
      expect((await run(['--format', 'plain'])).stdout).toBe('mokkan: logged out\n');
    });
  });

  describe('old statusLine configs calling plain `statusline` (Claude Code, no TTY)', () => {
    const oldCmd = 'node /home/u/mokkan-skill/dist/cli.js statusline';
    const legacy = (o: RunOptions = {}) => h.run(['statusline'], { isTTY: false, env: { PATH: tmuxPath() }, ...o });

    beforeEach(() => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: oldCmd, refreshInterval: 30 } }, null, 2));
    });

    it('first call migrates the setting to --render and renders; later calls only render', async () => {
      const first = await legacy();
      expect(first).toMatchObject({ code: 0, stdout: '\x1b[2mmokkan: logged out\x1b[0m\n' });
      expect(readJson(settings).statusLine.command).toBe(cmd);
      expect(backups(settings)).toHaveLength(1);
      expect(existsSync(tmuxConf)).toBe(false);

      const mtime = statSync(settings).mtimeMs;
      const second = await legacy();
      expect(second).toMatchObject({ code: 0, stdout: '\x1b[2mmokkan: logged out\x1b[0m\n' });
      expect(statSync(settings).mtimeMs).toBe(mtime);
      expect(backups(settings)).toHaveLength(1);
      expect(existsSync(tmuxConf)).toBe(false);
    });

    it('a terminal or /mokkan still configures', async () => {
      const tty = await legacy({ isTTY: true });
      expect(tty.stdout).toContain('Claude Code: updated the status line');
      expect(existsSync(tmuxConf)).toBe(true);
    });

    const refreshHint = 'mokkan: run "mokkan statusline" in a terminal to update this status line\n';

    it('a status line that calls plain `statusline` in a way mokkan cannot migrate gets one line, and nothing is written', async () => {
      for (const text of [
        // a path without "mokkan" in it
        JSON.stringify({ statusLine: { type: 'command', command: 'node /opt/tools/cli.js statusline' } }),
        // a wrapped command
        JSON.stringify({ statusLine: { type: 'command', command: "sh -c 'mokkan statusline'" } }),
        // JSONC (comments) that JSON.parse rejects
        `{\n  // mine\n  "statusLine": { "type": "command", "command": "${oldCmd}" }\n}\n`,
      ]) {
        writeFileSync(settings, text);
        const res = await legacy();
        expect(res, text).toEqual({ code: 0, stdout: refreshHint, stderr: '' });
        expect(readFileSync(settings, 'utf8')).toBe(text);
        expect(backups(settings)).toEqual([]);
        expect(existsSync(tmuxConf)).toBe(false);
      }
    });

    it('without a terminal and without a mokkan status line the plain command sets up nothing either', async () => {
      writeFileSync(settings, '{}');
      const res = await legacy();
      expect(res.code).toBe(0);
      expect(res.stdout.trim().split('\n')).toHaveLength(1);
      expect(res.stdout).toContain('mokkan statusline --claude');
      expect(readFileSync(settings, 'utf8')).toBe('{}');
      expect(existsSync(tmuxConf)).toBe(false);
    });

    it('a settings.json that cannot be written (read-only symlink target): no backup pile-up, one retry a day', async () => {
      const ro = path.join(h.configHome, 'nix-store');
      mkdirSync(ro);
      const real = path.join(ro, 'settings.json');
      const text = JSON.stringify({ env: { SECRET: 'x' }, statusLine: { type: 'command', command: oldCmd } });
      writeFileSync(real, text);
      rmSync(settings);
      symlinkSync(real, settings);
      chmodSync(ro, 0o555);
      try {
        for (let i = 0; i < 3; i++) {
          const res = await legacy();
          expect(res).toMatchObject({ code: 0, stdout: '\x1b[2mmokkan: logged out\x1b[0m\n' });
        }
        expect(backups(settings)).toEqual([]);
        expect(readdirSync(ro)).toEqual(['settings.json']);
        expect(readFileSync(real, 'utf8')).toBe(text);

        chmodSync(ro, 0o755);
        await legacy({ now: new Date(NOW.getTime() + 60 * 60 * 1000) });
        expect(readFileSync(real, 'utf8')).toBe(text);
        await legacy({ now: new Date(NOW.getTime() + 25 * 60 * 60 * 1000) });
        expect(JSON.parse(readFileSync(real, 'utf8')).statusLine.command).toBe(cmd);
        expect(backups(settings)).toHaveLength(1);
      } finally {
        chmodSync(ro, 0o755);
      }
    });

    it('an explicit setup into a read-only target fails without leaving a backup', async () => {
      const ro = path.join(h.configHome, 'ro');
      mkdirSync(ro);
      writeFileSync(path.join(ro, 'settings.json'), '{}');
      rmSync(settings);
      symlinkSync(path.join(ro, 'settings.json'), settings);
      chmodSync(ro, 0o555);
      try {
        const res = await run(['--claude']);
        expect(res.code).toBe(1);
        expect(res.stdout).toContain('nothing was changed');
        expect(backups(settings)).toEqual([]);
      } finally {
        chmodSync(ro, 0o755);
      }
    });
  });

  describe('CLI in the Claude Code plugin cache', () => {
    const cached = (root: string) => {
      const file = path.join(root, 'plugins', 'cache', 'mokkan', 'mokkan', '0.2.0', 'scripts', 'mokkan.mjs');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, '// bundle v1\n');
      return file;
    };

    it('the status line points at a stable 0755 copy under $XDG_DATA_HOME, not the versioned cache path', async () => {
      const dataHome = path.join(h.configHome, 'data');
      const file = cached(claudeDir);
      const res = await run(['--claude'], { cliPath: file, env: { XDG_DATA_HOME: dataHome } });
      expect(res.code).toBe(0);
      const stable = path.join(dataHome, 'mokkan', 'mokkan.mjs');
      expect(readFileSync(stable, 'utf8')).toBe('// bundle v1\n');
      expect(statSync(stable).mode & 0o777).toBe(0o755);
      expect(readJson(settings).statusLine.command).toBe(`${NODE} ${stable} statusline --render`);
      expect(res.stdout).toContain(`the status line runs ${stable}`);
    });

    it('defaults to ~/.local/share/mokkan and honours CLAUDE_CONFIG_DIR\'s cache', async () => {
      const alt = path.join(h.configHome, 'claude-alt');
      const file = cached(alt);
      await run(['--claude'], { cliPath: file, env: { CLAUDE_CONFIG_DIR: alt } });
      const stable = path.join(h.home, '.local', 'share', 'mokkan', 'mokkan.mjs');
      expect(readJson(path.join(alt, 'settings.json')).statusLine.command).toBe(`${NODE} ${stable} statusline --render`);
      expect(existsSync(stable)).toBe(true);
    });

    it('--dry-run does not copy', async () => {
      const file = cached(claudeDir);
      const res = await run(['--claude', '--dry-run'], { cliPath: file });
      expect(res.stdout).toContain('CLI: would copy');
      expect(existsSync(path.join(h.home, '.local', 'share', 'mokkan'))).toBe(false);
    });

    it('the SessionStart hook refreshes an existing stable copy after a plugin update, and never creates one', async () => {
      const file = cached(claudeDir);
      const stable = path.join(h.home, '.local', 'share', 'mokkan', 'mokkan.mjs');
      await h.run(['hook', 'session-start'], { cliPath: file });
      expect(existsSync(stable)).toBe(false);

      await run(['--claude'], { cliPath: file });
      writeFileSync(file, '// bundle v2, longer\n');
      await h.run(['hook', 'session-start'], { cliPath: file });
      expect(readFileSync(stable, 'utf8')).toBe('// bundle v2, longer\n');
      expect(statSync(stable).mode & 0o777).toBe(0o755);
    });

    it('--remove also deletes the stable copy once nothing points at it', async () => {
      const file = cached(claudeDir);
      const stable = path.join(h.home, '.local', 'share', 'mokkan', 'mokkan.mjs');
      await run(['--claude', '--tmux'], { cliPath: file });
      expect(existsSync(stable)).toBe(true);
      // The tmux block still runs it: keep it.
      await run(['--claude', '--remove'], { cliPath: file });
      expect(existsSync(stable)).toBe(true);
      const res = await run(['--tmux', '--remove'], { cliPath: file });
      expect(existsSync(stable)).toBe(false);
      expect(res.stdout).toContain(`CLI: removed the copy at ${stable}`);
    });

    it('a CLI outside the cache (npm global, checkout) is used in place', async () => {
      await run(['--claude']);
      expect(readJson(settings).statusLine.command).toBe(cmd);
      expect(existsSync(path.join(h.home, '.local', 'share', 'mokkan'))).toBe(false);
    });
  });

  describe('where the status line command points', () => {
    it('refuses a CLI running from npx\'s throwaway cache', async () => {
      const npx = path.join(h.home, '.npm', '_npx', '1a2b3c', 'node_modules', 'mokkan', 'dist', 'cli.js');
      mkdirSync(path.dirname(npx), { recursive: true });
      writeFileSync(npx, '// npx copy\n');
      mkdirSync(claudeDir, { recursive: true });
      const res = await run(['--claude'], { cliPath: npx });
      expect(res.code).toBe(1);
      expect(res.stderr).toContain('/mokkan:mokkan statusline');
      expect(res.stderr).toContain('npm i -g @vicmpen/mokkan-cli');
      expect(existsSync(settings)).toBe(false);
    });

    it('writes plain `node` when `node` on PATH is the running node binary, else its absolute path', async () => {
      const nodeDir = path.join(h.configHome, 'nvm', 'v22', 'bin');
      mkdirSync(nodeDir, { recursive: true });
      const nodeBin = path.join(nodeDir, 'node');
      writeFileSync(nodeBin, '#!/bin/sh\n', { mode: 0o755 });
      const bin = tmuxPath();
      symlinkSync(nodeBin, path.join(bin, 'node'));
      mkdirSync(claudeDir, { recursive: true });
      await run(['--claude'], { nodePath: nodeBin, env: { PATH: bin } });
      expect(readJson(settings).statusLine.command).toBe(`node ${cli} statusline --render`);

      const other = path.join(h.configHome, 'other-node');
      writeFileSync(other, '#!/bin/sh\n', { mode: 0o755 });
      await run(['--claude'], { nodePath: other, env: { PATH: bin } });
      expect(readJson(settings).statusLine.command).toBe(`${other} ${cli} statusline --render`);
    });
  });
});
