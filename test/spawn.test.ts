import { describe, it, expect } from 'vitest';
import { execFileSpawner } from '../src/spawn.js';

const node = process.execPath;

describe('execFileSpawner', () => {
  it('returns the exit code and output', async () => {
    const r = await execFileSpawner(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    expect(r).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('passes arguments verbatim, with no shell', async () => {
    const arg = '$(echo hi) "; `x` & | <b>';
    const r = await execFileSpawner(node, ['-e', 'process.stdout.write(process.argv[1])', arg]);
    expect(r).toEqual({ code: 0, stdout: arg, stderr: '' });
  });

  it('uses the given environment', async () => {
    const r = await execFileSpawner(node, ['-e', 'process.stdout.write(process.env.MOKKAN_T ?? "unset")'], { env: { MOKKAN_T: 'yes' } });
    expect(r.stdout).toBe('yes');
  });

  it('closes stdin, so a child reading it does not hang', async () => {
    const r = await execFileSpawner(node, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { timeoutMs: 5000 });
    expect(r.code).toBe(0);
  });

  it('kills a process that runs past the timeout', async () => {
    const started = Date.now();
    const r = await execFileSpawner(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 });
    expect(r.code).toBeNull();
    expect(r.error).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports a missing command as ENOENT without throwing', async () => {
    const r = await execFileSpawner('mokkan-no-such-command-xyz', []);
    expect(r).toEqual({ code: null, stdout: '', stderr: '', error: 'ENOENT' });
  });

  it('reports invalid arguments without throwing', async () => {
    const r = await execFileSpawner(node, ['a\u0000b']);
    expect(r.code).toBeNull();
    expect(r.error).toBeTruthy();
  });
});
