import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CliHarness } from './cli-harness.js';

describe('mokkan statusline (0.3.0 stub)', () => {
  let h: CliHarness;
  let home: string;
  beforeEach(() => { h = new CliHarness(); home = h.home; mkdirSync(home, { recursive: true }); });
  afterEach(() => h.dispose());
  const run = (args: string[], isTTY = false) => h.run(args, { isTTY });

  it('prints nothing and exits 0 when a status bar still runs the old --render command', async () => {
    const r = await run(['statusline', '--render', '--format', 'plain']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
  });

  it('tells a person at a terminal that the status line is gone', async () => {
    const r = await run(['statusline'], true);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('has no status line');
    expect(r.stdout).toContain('mokkan statusline --remove');
  });

  it('--remove takes a 0.2.0 setup out of settings.json and ~/.tmux.conf with backups, and deletes the CLI copy', async () => {
    const claude = path.join(home, '.claude');
    mkdirSync(claude, { recursive: true });
    const settings = path.join(claude, 'settings.json');
    writeFileSync(settings, `${JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: '/usr/bin/node /x/mokkan.mjs statusline --render', refreshInterval: 30 } }, null, 2)}\n`);
    const tmux = path.join(home, '.tmux.conf');
    writeFileSync(tmux, 'set -g mouse on\n\n# >>> mokkan status line >>>\nset -g status-right "#(mokkan statusline --render --format tmux)"\n# <<< mokkan status line <<<\n');
    const stable = path.join(home, '.local', 'share', 'mokkan', 'mokkan.mjs');
    mkdirSync(path.dirname(stable), { recursive: true });
    writeFileSync(stable, '// old copy\n');

    const r = await run(['statusline', '--remove']);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ model: 'opus' });
    expect(readFileSync(tmux, 'utf8')).toBe('set -g mouse on\n');
    expect(existsSync(stable)).toBe(false);
    expect(readdirSync(claude).some((f) => f.startsWith('settings.json.mokkan-bak-'))).toBe(true);
    expect(readdirSync(home).some((f) => f.startsWith('.tmux.conf.mokkan-bak-'))).toBe(true);
    expect(r.stdout).toContain('removed the mokkan status line');
    expect(r.stdout).toContain('removed the mokkan block');
    expect(r.stdout).toContain('removed the copy');
  });

  it('--remove leaves a status line that is not mokkan\'s alone', async () => {
    const claude = path.join(home, '.claude');
    mkdirSync(claude, { recursive: true });
    const settings = path.join(claude, 'settings.json');
    const before = `${JSON.stringify({ statusLine: { type: 'command', command: 'my-own-script' } }, null, 2)}\n`;
    writeFileSync(settings, before);
    const r = await run(['statusline', '--remove']);
    expect(r.code).toBe(0);
    expect(readFileSync(settings, 'utf8')).toBe(before);
    expect(r.stdout).toContain("is not mokkan's; left alone");
  });
});
