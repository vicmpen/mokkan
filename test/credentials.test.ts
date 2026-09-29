import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, chmodSync, existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadCredentials, saveCredentials, clearCredentials, credentialsPath, credentialsLockPath, resolveServerUrl, withCredentialsLock,
  CredentialsCorruptError, CredentialsLockError, CredentialsPermissionError, DEFAULT_SERVER_URL, type Credentials,
} from '../src/credentials.js';
import { UserError } from '../src/errors.js';

const sample: Credentials = {
  server_url: 'http://127.0.0.1:8787',
  email: 'a@example.com',
  access_token: 'acc',
  access_expires_at: '2026-09-29T12:00:00.000Z',
  refresh_token: 'ref',
  refresh_expires_at: '2026-12-27T12:00:00.000Z',
};

describe('credentials store', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'mokkan-creds-')); env = { XDG_CONFIG_HOME: dir }; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns null when nothing is saved', () => {
    expect(loadCredentials(env)).toBeNull();
  });

  it('saves with 0700 dir and 0600 file and loads back', () => {
    saveCredentials(sample, env);
    const file = credentialsPath(env);
    expect(file).toBe(path.join(dir, 'mokkan', 'credentials.json'));
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadCredentials(env)).toEqual(sample);
  });

  it('refuses to load a file readable by group or others', () => {
    saveCredentials(sample, env);
    chmodSync(credentialsPath(env), 0o644);
    expect(() => loadCredentials(env)).toThrow(CredentialsPermissionError);
  });

  it('throws CredentialsCorruptError (a UserError) for unparsable or incomplete files', () => {
    const file = credentialsPath(env);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const message = `credentials file is corrupt: ${file}. Run: mokkan logout (or delete it) then mokkan login`;
    for (const content of ['{not json', 'null', '[]', JSON.stringify({ ...sample, refresh_token: undefined })]) {
      writeFileSync(file, content, { mode: 0o600 });
      expect(() => loadCredentials(env)).toThrow(CredentialsCorruptError);
      expect(() => loadCredentials(env)).toThrow(message);
    }
    expect(new CredentialsCorruptError(file)).toBeInstanceOf(UserError);
  });

  it('writes through a unique tmp file and leaves none behind', () => {
    saveCredentials(sample, env);
    saveCredentials({ ...sample, access_token: 'acc2' }, env);
    expect(readdirSync(path.dirname(credentialsPath(env)))).toEqual(['credentials.json']);
    expect(loadCredentials(env)?.access_token).toBe('acc2');
  });

  it('clears the file', () => {
    saveCredentials(sample, env);
    clearCredentials(env);
    expect(existsSync(credentialsPath(env))).toBe(false);
    expect(loadCredentials(env)).toBeNull();
  });

  it('resolves the server url: env > credentials > default', () => {
    expect(resolveServerUrl(null, {})).toBe(DEFAULT_SERVER_URL);
    expect(DEFAULT_SERVER_URL).toBe('https://api.mokkan.dev');
    expect(resolveServerUrl(sample, {})).toBe('http://127.0.0.1:8787');
    expect(resolveServerUrl(sample, { MOKKAN_SERVER_URL: 'http://10.0.0.5:9000/' })).toBe('http://10.0.0.5:9000');
  });
});

describe('credentials lock', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'mokkan-lock-')); env = { XDG_CONFIG_HOME: dir }; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('serialises holders and removes its own lock, also when fn throws', async () => {
    const order: string[] = [];
    const hold = (name: string) => withCredentialsLock(env, async () => {
      order.push(`${name}:in`);
      await new Promise((resolve) => setTimeout(resolve, 60));
      order.push(`${name}:out`);
    });
    await Promise.all([hold('a'), hold('b')]);
    expect(order).toEqual(['a:in', 'a:out', 'b:in', 'b:out']);
    expect(existsSync(credentialsLockPath(env))).toBe(false);
    await expect(withCredentialsLock(env, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(credentialsLockPath(env))).toBe(false);
  });

  it('times out on a fresh lock held by someone else, and leaves that lock alone', async () => {
    mkdirSync(path.dirname(credentialsLockPath(env)), { recursive: true });
    writeFileSync(credentialsLockPath(env), 'other\n');
    await expect(withCredentialsLock(env, async () => 1, { timeoutMs: 150 })).rejects.toBeInstanceOf(CredentialsLockError);
    expect(existsSync(credentialsLockPath(env))).toBe(true);
  });

  it('removes a stale lock (older than 30 s) and proceeds', async () => {
    mkdirSync(path.dirname(credentialsLockPath(env)), { recursive: true });
    writeFileSync(credentialsLockPath(env), 'crashed\n');
    const old = new Date(Date.now() - 31_000);
    utimesSync(credentialsLockPath(env), old, old);
    await expect(withCredentialsLock(env, async () => 'ran', { timeoutMs: 150 })).resolves.toBe('ran');
    expect(existsSync(credentialsLockPath(env))).toBe(false);
  });
});
