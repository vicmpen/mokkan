import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OscMode } from '../src/notify/config.js';
import { SHELLS, type NotifyShell } from '../src/notify/shells/index.js';
import { shQuote } from '../src/notify/shells/types.js';

/**
 * Runs each generated `init.<shell>` in a real interactive shell. bash reads its commands from stdin (`bash -i`), so
 * its real prompt hook mechanism runs between lines; zsh and fish run them with `-i -c`, with the prompt simulated
 * between lines by running `precmd_functions` (zsh) or `emit fish_prompt` (fish), which also checks the hook was
 * registered. A stub "node" (a sh script at a path with a space and a quote) records each background poll.
 * OSC escapes go to `__mokkan_tty`, which the snippet reads as `${__mokkan_tty:-/dev/tty}`; the tests create it as
 * an empty file first (fish writes to an overridden target only when it is writable).
 *
 * MOKKAN_TEST_BASH picks the bash to test (CI points it at macOS's /bin/bash 3.2); otherwise every distinct bash
 * among /bin/bash and the one on PATH is tested.
 */

function which(cmd: string): string | null {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
}

function bashes(): string[] {
  if (process.env.MOKKAN_TEST_BASH) return [process.env.MOKKAN_TEST_BASH];
  const found = new Map<string, string>();
  for (const p of ['/bin/bash', which('bash')]) {
    if (p === null || !existsSync(p)) continue;
    const real = realpathSync(p);
    if (!found.has(real)) found.set(real, p);
  }
  return [...found.values()];
}

interface Binary { shell: NotifyShell; bin: string; label: string }

const BINARIES: Binary[] = [
  ...bashes().map((bin) => ({ shell: SHELLS.find((s) => s.name === 'bash')!, bin, label: `bash (${bin})` })),
  ...(['zsh', 'fish'] as const).map((name) => {
    const bin = which(name);
    return { shell: SHELLS.find((s) => s.name === name)!, bin: bin ?? '', label: name };
  }),
];

/** Lines the shells print about the missing terminal when run from a pipe; anything else on stderr is a failure. */
const NOISE = [
  /cannot set terminal process group/, /no job control in this shell/, /^exit$/, /^\s*$/, // bash
  /tty pgrp/, // zsh
  /No TTY for interactive shell/, /tcgetpgrp|tcsetpgrp|setpgid/, // fish
];

const CLI = '/opt/mokkan/dist/cli.js';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

for (const { shell, bin, label } of BINARIES) {
  describe.skipIf(bin === '')(`${label}: prompt hook in a real shell`, () => {
    let root: string;
    let state: string;
    let stub: string;
    let log: string;
    let work: string;
    let init: string;

    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), 'mokkan-shells-'));
      const cfg = path.join(root, 'cfg');
      state = path.join(cfg, 'mokkan', 'notify');
      mkdirSync(state, { recursive: true, mode: 0o700 });
      mkdirSync(path.join(root, 'home'));
      work = path.join(root, 'work');
      mkdirSync(work);
      const stubDir = path.join(root, "my node's dir");
      mkdirSync(stubDir);
      stub = path.join(stubDir, 'node');
      log = path.join(root, 'calls.log');
      writeFileSync(stub, [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${shQuote(log)}`,
        `if [ -f ${shQuote(path.join(root, 'fail'))} ]; then echo boom >&2; echo out; exit 3; fi`,
        'exit 0',
        '',
      ].join('\n'));
      chmodSync(stub, 0o755);
      init = path.join(state, `init.${shell.name}`);
      writeInit('off');
      setStamp(Math.floor(Date.now() / 1000));
      writeFileSync(tty(), '');
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    function writeInit(osc: OscMode): void {
      writeFileSync(init, shell.snippet({ node: stub, cli: CLI, version: 'test', interval: 60, osc }), { mode: 0o600 });
    }
    function setStamp(value: number | string): void { writeFileSync(path.join(state, 'stamp'), `${value}\n`); }
    const setShell = (text: string): void => writeFileSync(path.join(state, 'shell.txt'), text);
    const setOsc = (text: string): void => writeFileSync(path.join(state, 'osc.txt'), text);
    const calls = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l !== '') : []);
    const tty = (): string => path.join(root, 'tty');

    /**
     * Runs `lines` in an interactive shell with a prompt after each one; returns stdout after the `BEGIN` marker
     * (SGR colors removed) and the stderr lines that are not terminal noise.
     */
    function session(lines: string[], extraEnv: Record<string, string> = {}): { out: string; err: string } {
      const env: Record<string, string> = {
        HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'cfg'), PATH: process.env.PATH ?? '/usr/bin:/bin',
        TERM: 'dumb', PS1: '', PS2: '', MK_INIT: init, MK_D: state, __mokkan_tty: tty(), fish_greeting: '', ...extraEnv,
      };
      const all = ['echo BEGIN', ...lines];
      let args: string[];
      let input = '';
      if (shell.name === 'bash') {
        args = ['--norc', '--noprofile', '--noediting', '-i'];
        input = `${all.join('\n')}\n`;
      } else if (shell.name === 'zsh') {
        const prompt = '__mk_prompt';
        args = ['-f', '-i', '-c', [`${prompt}() { local f; for f in $precmd_functions; do "$f"; done }`, all[0], ...all.slice(1).flatMap((l) => [l, prompt])].join('\n')];
      } else {
        args = ['--no-config', '-i', '-c', [all[0], ...all.slice(1).flatMap((l) => [l, 'emit fish_prompt'])].join('\n')];
      }
      const r = spawnSync(bin, args, { cwd: work, env, input, encoding: 'utf8', timeout: 10_000 });
      const stdout = r.stdout.replace(/\x1b\[[0-9;]*m|\x1b\(B/g, '');
      const at = stdout.indexOf('BEGIN\n');
      const err = r.stderr.split('\n').filter((l) => !NOISE.some((re) => re.test(l))).join('\n');
      return { out: at === -1 ? `<no BEGIN> ${stdout}` : stdout.slice(at + 'BEGIN\n'.length), err };
    }

    const SRC = 'source "$MK_INIT"';
    const SET = "- [aaaa0001] call mom (due 11:30)\n- [bbbb0002] $(touch pwned) `touch pwned` %s \\e[31m (due 11:31)\n";

    it('prints the set once, then stays silent; a second shell prints it again; text is never evaluated', () => {
      setShell(SET);
      for (let i = 0; i < 2; i++) {
        const r = session([SRC, 'echo A', 'echo B']);
        expect(r.out).toBe(`mokkan:\n${SET}A\nB\n`);
        expect(r.err).toBe('');
      }
      expect(existsSync(path.join(work, 'pwned'))).toBe(false);
      expect(calls()).toEqual([]);
    });

    it('reprints the rest when the set shrinks, and prints nothing once it is empty', () => {
      setShell(SET);
      const r = session([SRC, 'echo A', `printf '%s\\n' '- [aaaa0001] call mom (due 11:30)' > "$MK_D/shell.txt"`, 'echo B', 'true > "$MK_D/shell.txt"', 'echo C']);
      expect(r.out).toBe(`mokkan:\n${SET}A\nmokkan:\n- [aaaa0001] call mom (due 11:30)\nB\nC\n`);
      expect(r.err).toBe('');
    });

    it('survives errexit (set -e / setopt err_exit err_return), also with a stamp lacking its newline', () => {
      setShell(SET);
      const errexit = shell.name === 'bash' ? ['set -e'] : shell.name === 'zsh' ? ['setopt err_exit err_return'] : [];
      // A fresh stamp, so no background poll rewrites the files mid-session; once without its trailing newline.
      const now = Math.floor(Date.now() / 1000);
      for (const stamp of [`${now}\n`, `${now}`]) {
        writeFileSync(path.join(state, 'stamp'), stamp);
        const r = session([...errexit, SRC, 'echo A', 'echo B']);
        expect(r.out).toBe(`mokkan:\n${SET}A\nB\n`);
        expect(r.err).toBe('');
      }
    });

    it('sourcing the init file twice still prints once', () => {
      setShell(SET);
      const r = session([SRC, SRC, 'echo A']);
      expect(r.out).toBe(`mokkan:\n${SET}A\n`);
      expect(r.err).toBe('');
    });

    it('sends OSC only over SSH, wraps it for tmux, and picks the sequence for auto', () => {
      setShell(SET);
      setOsc('call mom\nsecond\n');
      writeInit('9');
      session([SRC, 'echo A']);
      expect(readFileSync(tty(), 'latin1')).toBe('');

      expect(session([SRC, 'echo A'], { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }).err).toBe('');
      expect(readFileSync(tty(), 'latin1')).toBe('\x1b]9;call mom\x07\x1b]9;second\x07');

      session([SRC], { SSH_CONNECTION: 'x', TMUX: '/tmp/tmux-1/default,1,0' });
      expect(readFileSync(tty(), 'latin1')).toBe('\x1bPtmux;\x1b\x1b]9;call mom\x07\x1b\\\x1bPtmux;\x1b\x1b]9;second\x07\x1b\\');

      writeInit('auto');
      session([SRC], { SSH_CONNECTION: 'x', TERM: 'xterm-kitty' });
      expect(readFileSync(tty(), 'latin1')).toBe('\x1b]99;;call mom\x1b\\\x1b]99;;second\x1b\\');
      session([SRC], { SSH_CONNECTION: 'x', TERM: 'xterm-kitty', TMUX: 't' });
      expect(readFileSync(tty(), 'latin1')).toBe('\x1bPtmux;\x1b\x1b]99;;call mom\x1b\x1b\\\x1b\\\x1bPtmux;\x1b\x1b]99;;second\x1b\x1b\\\x1b\\');
      session([SRC], { SSH_CONNECTION: 'x', TERM: 'foot-extra' });
      expect(readFileSync(tty(), 'latin1')).toBe('\x1b]777;notify;mokkan;call mom\x07\x1b]777;notify;mokkan;second\x07');
      session([SRC], { SSH_CONNECTION: 'x', TERM: 'xterm-256color' });
      expect(readFileSync(tty(), 'latin1')).toBe('\x1b]9;call mom\x07\x1b]9;second\x07');
    });

    it('an unwritable terminal prints no error', () => {
      setShell(SET);
      setOsc('call mom\n');
      writeInit('9');
      const r = session([SRC, 'echo A'], { SSH_CONNECTION: 'x', __mokkan_tty: path.join(root, 'no', 'such', 'dir', 'tty') });
      expect(r.out).toBe(`mokkan:\n${SET}A\n`);
      expect(r.err).toBe('');
    });

    it('a stale stamp starts exactly one background poll per prompt; a fresh one none', async () => {
      setStamp(0);
      const r = session([SRC, 'echo A']);
      expect(r.out).toBe('A\n');
      expect(r.err).toBe('');
      expect(await waitFor(() => calls().length >= 2)).toBe(true);
      await sleep(200);
      expect(calls()).toEqual([`${CLI} notify poll`, `${CLI} notify poll`]);

      rmSync(log);
      setStamp(Math.floor(Date.now() / 1000) - 5);
      session([SRC, 'echo A']);
      await sleep(300);
      expect(calls()).toEqual([]);
    });

    it('a failing stub, a deleted stub and hostile stamps print nothing and run nothing else', async () => {
      setStamp(0);
      writeFileSync(path.join(root, 'fail'), '');
      let r = session([SRC, 'echo A']);
      expect(r).toEqual({ out: 'A\n', err: '' });
      expect(await waitFor(() => calls().length >= 1)).toBe(true);

      rmSync(stub);
      r = session([SRC, 'echo A']);
      expect(r).toEqual({ out: 'A\n', err: '' });

      for (const stamp of ['a[$(touch pwned)]', '$(touch pwned)', '08', '99999999999999999999999', '-5', '1e9']) {
        setStamp(stamp);
        r = session([SRC, 'echo A']);
        expect(r).toEqual({ out: 'A\n', err: '' });
      }
      await sleep(100);
      expect(existsSync(path.join(work, 'pwned'))).toBe(false);
      expect(existsSync(path.join(root, 'home', 'pwned'))).toBe(false);
    });

    it('MOKKAN_NOTIFY=0 prints nothing and starts no poll', async () => {
      setStamp(0);
      setShell(SET);
      const r = session([SRC, 'echo A'], { MOKKAN_NOTIFY: '0' });
      expect(r).toEqual({ out: 'A\n', err: '' });
      await sleep(300);
      expect(calls()).toEqual([]);
    });

    it('does nothing in a non-interactive shell', async () => {
      setStamp(0);
      setShell(SET);
      const args = shell.name === 'bash' ? ['--norc', '--noprofile', '-c', `${SRC}; echo done`]
        : shell.name === 'zsh' ? ['-f', '-c', `${SRC}; echo done`]
          : ['-c', 'echo done']; // fish: the conf.d drop-in is loaded by fish itself
      if (shell.name === 'fish') {
        const dropIn = shell.rcFile({ HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'cfg') }, process.platform);
        mkdirSync(path.dirname(dropIn), { recursive: true });
        writeFileSync(dropIn, shell.rcLine());
      }
      const r = spawnSync(bin, args, {
        cwd: work, encoding: 'utf8', timeout: 10_000,
        env: { HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'cfg'), PATH: process.env.PATH ?? '/usr/bin:/bin', MK_INIT: init },
      });
      expect(r.stdout).toBe('done\n');
      expect(r.stderr).toBe('');
      await sleep(300);
      expect(calls()).toEqual([]);
    });

    if (shell.name === 'bash') {
      const version = spawnSync(bin, ['-c', 'echo $(( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] ))'], { encoding: 'utf8' }).stdout.trim();

      it('keeps the exit status for the prompt', () => {
        const r = session([SRC, 'false', 'echo "rc=$?"']);
        expect(r).toEqual({ out: 'rc=1\n', err: '' });
      });

      it('hooks into a string PROMPT_COMMAND ending in ";" or a newline, once even when sourced twice', () => {
        setShell(SET);
        for (const pc of ["PROMPT_COMMAND='echo foo;'", "PROMPT_COMMAND=$'echo foo\\n'"]) {
          const r = session([pc, SRC, SRC, 'echo A', 'printf "%s|" "$PROMPT_COMMAND"; echo']);
          // Prompts after: pc, source, source, echo A, printf.
          expect(r.out).toBe(`foo\nfoo\nmokkan:\n${SET}foo\nA\nfoo\n${pc.includes('$') ? 'echo foo\n\n' : 'echo foo;\n'}__mokkan_prompt|\nfoo\n`);
          expect(r.err).toBe('');
        }
        const r = session([SRC, SRC, 'printf "%s|" "$PROMPT_COMMAND"; echo']);
        expect(r.out).toBe(`mokkan:\n${SET}__mokkan_prompt|\n`);
      });

      it.skipIf(Number(version) < 501)('appends to an array PROMPT_COMMAND (bash >= 5.1)', () => {
        setShell(SET);
        const r = session(["PROMPT_COMMAND=('echo foo' 'echo bar')", SRC, SRC, 'echo "${#PROMPT_COMMAND[@]} ${PROMPT_COMMAND[2]}"']);
        expect(r.out).toBe(`foo\nbar\nfoo\nbar\nmokkan:\n${SET}foo\nbar\n3 __mokkan_prompt\nfoo\nbar\n`);
        expect(r.err).toBe('');
      });

      it('uses precmd_functions when bash-preexec is loaded, leaving PROMPT_COMMAND alone', () => {
        setShell(SET);
        const preexec = [
          '__bp_imported=defined; __bp_install() { :; }; __t() { echo foo; }; precmd_functions=(__t)',
          'PROMPT_COMMAND=\'for __f in "${precmd_functions[@]}"; do "$__f"; done\'',
        ].join('; ');
        const r = session([preexec, SRC, SRC, 'echo "${precmd_functions[*]}"', 'echo "$PROMPT_COMMAND"']);
        expect(r.out).toBe(`foo\nfoo\nmokkan:\n${SET}foo\n__t __mokkan_prompt\nfoo\nfor __f in "\${precmd_functions[@]}"; do "$__f"; done\nfoo\n`);
        expect(r.err).toBe('');
      });
    }
  });
}
