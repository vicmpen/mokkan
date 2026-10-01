import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM build script without type declarations
import { BUNDLE_PATH, buildBundle } from '../tools/bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('plugin CLI bundle (claude-plugin/scripts/mokkan.mjs)', () => {
  it('lives inside the plugin directory', () => {
    expect(BUNDLE_PATH).toBe(path.join(ROOT, 'claude-plugin', 'scripts', 'mokkan.mjs'));
  });

  it('is up to date with src/ (run `npm run bundle` and commit the result if this fails)', async () => {
    const fresh: string = await buildBundle();
    const committed = readFileSync(BUNDLE_PATH, 'utf8');
    expect(committed === fresh, 'claude-plugin/scripts/mokkan.mjs is stale: run `npm run bundle`').toBe(true);
  });

  it('is one executable, self-contained ESM file', () => {
    const src = readFileSync(BUNDLE_PATH, 'utf8');
    expect(src.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(statSync(BUNDLE_PATH).mode & 0o111).not.toBe(0);
    // Only node: builtins may be imported: the plugin cache holds this one file and no node_modules.
    const specifiers = [...src.matchAll(/^import\s[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s.startsWith('node:'), s).toBe(true);
    expect(src).not.toMatch(/\brequire\(["'](?!node:)/);
  });

  it('runs on its own with plain node', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mokkan-bundle-'));
    try {
      const out = execFileSync(process.execPath, [BUNDLE_PATH, 'help'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') },
      });
      expect(out).toContain('Usage: mokkan');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
