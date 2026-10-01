import { afterAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(SKILL_DIR, 'claude-plugin');
const COMMAND = path.join(SKILL_DIR, 'claude-command', 'mokkan.md');
const PLUGIN_SKILL = path.join(PLUGIN, 'skills', 'mokkan', 'SKILL.md');
// Quoted: a plugin root with a space in it (verified live; the rule in allowed-tools must carry the same quotes).
const PLUGIN_RUN_LINE = '!`node "${CLAUDE_PLUGIN_ROOT}/scripts/mokkan.mjs" --argline "$ARGUMENTS" --exit-zero 2>&1`';
const PATH_RUN_LINE = '!`mokkan --argline "$ARGUMENTS" --exit-zero 2>&1`';
/** Splits a Markdown file with YAML frontmatter into its frontmatter lines and its body. */
const splitFrontmatter = (md: string) => {
  const end = md.indexOf('\n---\n', 4);
  return { front: md.slice(4, end).split('\n'), body: md.slice(end + 5) };
};

describe('Claude Code plugin files', () => {
  it('has a valid manifest', () => {
    const manifest = JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.name).toBe('mokkan');
    expect(typeof manifest.version).toBe('string');
    expect(typeof manifest.description).toBe('string');
    // Users stay on a plugin version until it changes: it moves together with the npm package.
    const pkg = JSON.parse(readFileSync(path.join(SKILL_DIR, 'package.json'), 'utf8'));
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe('MIT');
    expect(pkg.license).toBe('MIT');
    expect(manifest.repository).toBe('https://github.com/vicmpen/mokkan');
    expect(pkg.repository.url).toBe('git+https://github.com/vicmpen/mokkan.git');
  });

  it('the repo root is a marketplace that lists the plugin directory', () => {
    const market = JSON.parse(readFileSync(path.join(SKILL_DIR, '.claude-plugin', 'marketplace.json'), 'utf8'));
    expect(market.name).toBe('mokkan');
    expect(typeof market.owner.name).toBe('string');
    expect(market.plugins).toEqual([expect.objectContaining({ name: 'mokkan', source: './claude-plugin' })]);
  });

  it('has no top-level bin/ (claude.ai and Cowork reject such plugins) and no commands/ clashing with the skill', () => {
    expect(() => statSync(path.join(PLUGIN, 'bin'))).toThrow();
    expect(() => statSync(path.join(PLUGIN, 'commands'))).toThrow();
  });

  it('registers SessionStart and Stop hooks pointing at the plugin scripts', () => {
    const hooks = JSON.parse(readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
    const start = hooks.hooks.SessionStart[0];
    expect(start.matcher).toBe('startup|resume|clear|compact');
    expect(start.hooks[0]).toEqual({ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"', timeout: 10 });
    const stop = hooks.hooks.Stop[0];
    expect(stop.hooks[0]).toEqual({ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh"', timeout: 10 });
  });

  it('hook scripts are executable and syntactically valid bash', () => {
    for (const name of ['session-start.sh', 'stop.sh']) {
      const file = path.join(PLUGIN, 'hooks', name);
      expect(statSync(file).mode & 0o111, `${name} executable`).not.toBe(0);
      expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
      expect(readFileSync(file, 'utf8')).toContain(`mokkan hook ${name.replace('.sh', '')}`);
    }
    const install = path.join(SKILL_DIR, 'install.sh');
    expect(statSync(install).mode & 0o111).not.toBe(0);
    expect(() => execFileSync('bash', ['-n', install])).not.toThrow();
  });

  it('hook scripts without any CLI: exit 0, silent, one line in hook.log', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'mokkan-nocli-'));
    try {
      // Only the external tools the scripts need; no node, no mokkan, and no dist/ next to the copied script.
      const bin = path.join(tmp, 'bin');
      mkdirSync(bin);
      for (const tool of ['dirname', 'mkdir', 'date']) {
        symlinkSync(execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(bin, tool));
      }
      const bash = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
      mkdirSync(path.join(tmp, 'plugin', 'hooks'), { recursive: true });
      const config = path.join(tmp, 'config');
      for (const name of ['session-start.sh', 'stop.sh']) {
        const copy = path.join(tmp, 'plugin', 'hooks', name);
        copyFileSync(path.join(PLUGIN, 'hooks', name), copy);
        const out = execFileSync(bash, [copy], { env: { PATH: bin, HOME: tmp, XDG_CONFIG_HOME: config }, encoding: 'utf8', input: '{}' });
        expect(out).toBe('');
      }
      const log = readFileSync(path.join(config, 'mokkan', 'hook.log'), 'utf8').trim().split('\n');
      expect(log).toHaveLength(2);
      for (const line of log) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z hook: mokkan CLI not found \(install node, or reinstall the mokkan plugin\)$/);
      expect(statSync(path.join(config, 'mokkan')).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('hook scripts prefer the plugin bundle, then a sibling dist/, then mokkan on PATH', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'mokkan-hookorder-'));
    try {
      const bin = path.join(tmp, 'bin');
      mkdirSync(bin);
      for (const tool of ['dirname', 'mkdir', 'date']) {
        symlinkSync(execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), path.join(bin, tool));
      }
      symlinkSync(process.execPath, path.join(bin, 'node'));
      writeFileSync(path.join(bin, 'mokkan'), '#!/bin/sh\necho "path $*"\n', { mode: 0o755 });
      const bash = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
      const hooks = path.join(tmp, 'claude-plugin', 'hooks');
      mkdirSync(hooks, { recursive: true });
      const fake = (label: string) => `console.log(${JSON.stringify(label)}, process.argv.slice(2).join(' '));\n`;
      const bundle = path.join(tmp, 'claude-plugin', 'scripts', 'mokkan.mjs');
      const dist = path.join(tmp, 'dist', 'cli.js');
      const run = (name: string) => {
        copyFileSync(path.join(PLUGIN, 'hooks', `${name}.sh`), path.join(hooks, `${name}.sh`));
        return execFileSync(bash, [path.join(hooks, `${name}.sh`)], { env: { PATH: bin, HOME: tmp }, encoding: 'utf8', input: '{}' }).trim();
      };
      expect(run('session-start')).toBe('path hook session-start');
      mkdirSync(path.dirname(dist));
      writeFileSync(dist, fake('dist'));
      expect(run('stop')).toBe('dist hook stop');
      mkdirSync(path.dirname(bundle));
      writeFileSync(bundle, fake('bundle'));
      expect(run('session-start')).toBe('bundle hook session-start');
      expect(run('stop')).toBe('bundle hook stop');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the user-level /mokkan command runs the CLI from PATH deterministically before the model sees anything', () => {
    const md = readFileSync(COMMAND, 'utf8');
    expect(md).toContain('allowed-tools: Bash(mokkan:*)');
    // One double-quoted string: ', #, *, ;, |, & and parentheses in reminder text reach the CLI untouched, and
    // --exit-zero keeps a failing command (empty pop, logged out) from aborting the slash command.
    expect(md).toContain(PATH_RUN_LINE);
    expect(md).not.toContain('--no-color');
    expect(md).toMatch(/^argument-hint: .*\blist\b.*\blogout\b/m);
    expect(md).toContain('verbatim');
  });

  it('the plugin skill runs the bundled CLI through ${CLAUDE_PLUGIN_ROOT}, pre-approved by the same path', () => {
    const { front, body } = splitFrontmatter(readFileSync(PLUGIN_SKILL, 'utf8'));
    expect(front).toContain('name: mokkan');
    expect(front.find((l) => l.startsWith('description: '))).toMatch(/remind/);
    expect(front).toContain('allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/mokkan.mjs" *)');
    expect(body).toContain(PLUGIN_RUN_LINE);
    expect(body).not.toContain(PATH_RUN_LINE);
  });

  it('the plugin skill and the user-level command give the same instructions', () => {
    const skill = splitFrontmatter(readFileSync(PLUGIN_SKILL, 'utf8'));
    const command = splitFrontmatter(readFileSync(COMMAND, 'utf8'));
    // The plugin's command is namespaced: the skill says /mokkan:mokkan where the user-level command says /mokkan.
    expect(skill.body).not.toMatch(/`\/mokkan /);
    expect(skill.body.replace(PLUGIN_RUN_LINE, PATH_RUN_LINE).replaceAll('`/mokkan:mokkan ', '`/mokkan ')).toBe(command.body);
    const hint = (front: string[]) => front.find((l) => l.startsWith('argument-hint: '));
    expect(hint(skill.front)).toBe(hint(command.front));
  });

  it('the Codex skill has the required frontmatter', () => {
    const md = readFileSync(path.join(SKILL_DIR, 'codex', 'SKILL.md'), 'utf8');
    expect(md.startsWith('---\nname: mokkan\n')).toBe(true);
    expect(md).toMatch(/^description: .+/m);
    expect(md).toContain('mokkan heartbeat');
    expect(md).toContain('mokkan pending');
  });
});

describe('install.sh', () => {
  const INSTALL = path.join(SKILL_DIR, 'install.sh');
  const homes: string[] = [];
  const newHome = () => { const d = mkdtempSync(path.join(tmpdir(), 'mokkan-install-')); homes.push(d); return d; };
  const install = (home: string) => execFileSync('bash', [INSTALL], {
    encoding: 'utf8',
    // Never the real home; never npm ci / build in tests.
    env: { PATH: process.env.PATH, HOME: home, MOKKAN_INSTALL_SKIP_BUILD: '1' },
  });

  afterAll(() => { for (const d of homes) rmSync(d, { recursive: true, force: true }); });

  it('links the CLI and the Codex skill, and is idempotent', () => {
    const home = newHome();
    for (let run = 0; run < 2; run++) {
      const out = install(home);
      expect(out).not.toContain('is not ours');
      expect(lstatSync(path.join(home, '.local/bin/mokkan')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(home, '.local/bin/mokkan'))).toBe(path.join(SKILL_DIR, 'dist', 'cli.js'));
      expect(readlinkSync(path.join(home, '.codex/skills/mokkan'))).toBe(path.join(SKILL_DIR, 'codex'));
      expect(readlinkSync(path.join(home, '.claude/commands/mokkan.md'))).toBe(COMMAND);
    }
  });

  it('leaves a pre-existing file or directory that is not its own untouched', () => {
    const home = newHome();
    const bin = path.join(home, '.local/bin/mokkan');
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/bin/sh\necho calendar mokkan\n');
    const skillDir = path.join(home, '.codex/skills/mokkan');
    mkdirSync(skillDir, { recursive: true });
    const out = install(home);
    expect(out).toContain(`warning: ${bin} exists and is not ours; skipped`);
    expect(out).toContain(`warning: ${skillDir} exists and is not ours; skipped`);
    expect(lstatSync(bin).isSymbolicLink()).toBe(false);
    expect(readFileSync(bin, 'utf8')).toBe('#!/bin/sh\necho calendar mokkan\n');
    expect(lstatSync(skillDir).isDirectory()).toBe(true);
    expect(() => lstatSync(path.join(skillDir, 'codex'))).toThrow();
  });
});
