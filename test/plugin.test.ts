import { afterAll, describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(SKILL_DIR, 'claude-plugin');
const COMMAND = path.join(SKILL_DIR, 'claude-command', 'mokkan-cli.md');
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

  it('registers no transcript hooks: the pane module alone polls, heartbeats and delivers', () => {
    const hooks = JSON.parse(readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
    expect(hooks.hooks ?? {}).toEqual({});
    expect(hooks.modules).toEqual(['./pane.tsx']);
    for (const name of ['session-start.sh', 'stop.sh']) expect(() => statSync(path.join(PLUGIN, 'hooks', name))).toThrow();
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
    // The skill suggests the plugin's /mokkan, the user-level command itself (/mokkan-cli); the rest is the same.
    expect(command.body).not.toMatch(/`\/mokkan /);
    expect(skill.body.replace(PLUGIN_RUN_LINE, PATH_RUN_LINE).replaceAll('`/mokkan ', '`/mokkan-cli ')).toBe(command.body);
    // The hints differ: typed /mokkan reaches the CLI without a shell (the mod answers it), /mokkan-cli through one.
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
      expect(readlinkSync(path.join(home, '.claude/commands/mokkan-cli.md'))).toBe(COMMAND);
    }
  });

  it('removes its old /mokkan command link, which would hide the plugin\'s /mokkan, and only its own', () => {
    const home = newHome();
    const old = path.join(home, '.claude/commands/mokkan.md');
    mkdirSync(path.dirname(old), { recursive: true });
    symlinkSync(path.join(SKILL_DIR, 'claude-command', 'mokkan.md'), old);
    expect(install(home)).toContain(`Removed ${old}`);
    expect(() => lstatSync(old)).toThrow();
    const other = newHome();
    const theirs = path.join(other, '.claude/commands/mokkan.md');
    mkdirSync(path.dirname(theirs), { recursive: true });
    writeFileSync(theirs, 'my own command\n');
    install(other);
    expect(readFileSync(theirs, 'utf8')).toBe('my own command\n');
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
