import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MokkanClient, ApiError, NetworkError } from '../src/client.js';
import {
  clearCredentials, credentialsLockPath, credentialsPath, loadCredentials, saveCredentials, withCredentialsLock,
  type Credentials,
} from '../src/credentials.js';
import { SessionExpiredError } from '../src/errors.js';
import { FakeServer, tokenPair } from './fake-server.js';

const NOW = new Date('2026-09-28T12:00:00.000Z');

function creds(accessExpiresAt = '2026-09-29T12:00:00.000Z'): Credentials {
  return {
    server_url: 'unused', email: 'a@example.com',
    access_token: 'access-0', access_expires_at: accessExpiresAt,
    refresh_token: 'refresh-0', refresh_expires_at: '2026-12-27T12:00:00.000Z',
  };
}

describe('MokkanClient', () => {
  let server: FakeServer;
  beforeEach(async () => { server = new FakeServer(); await server.start(); });
  afterEach(async () => { await server.stop(); });

  it('posts registration start and completes with a token pair', async () => {
    server.on('POST', '/auth/register/start', () => ({ status: 202, body: { ok: true } }));
    server.on('POST', '/auth/register/complete', () => ({ status: 201, body: tokenPair('new') }));
    const saved: Credentials[] = [];
    const c = new MokkanClient({ baseUrl: server.url, onCredentials: (x) => saved.push(x), now: () => NOW });
    await c.registerStart('a@example.com');
    expect(server.last('POST', '/auth/register/start')?.body).toEqual({ email: 'a@example.com' });
    const result = await c.registerComplete('a@example.com', '123456', 'long enough pw');
    expect(server.last('POST', '/auth/register/complete')?.body).toEqual({ email: 'a@example.com', otp: '123456', password: 'long enough pw' });
    expect(result.access_token).toBe('access-new');
    expect(result.email).toBe('a@example.com');
    expect(result.server_url).toBe(server.url);
    expect(saved).toEqual([result]);
  });

  it('sends the bearer token on authenticated calls', async () => {
    server.on('GET', '/reminders', () => ({ status: 200, body: { version: 3, reminders: [] } }));
    const c = new MokkanClient({ baseUrl: server.url, credentials: creds(), now: () => NOW });
    const res = await c.list('active');
    expect(res.version).toBe(3);
    const req = server.last('GET', '/reminders');
    expect(req?.headers.authorization).toBe('Bearer access-0');
    expect(req?.query.get('scope')).toBe('active');
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    let calls = 0;
    server.on('GET', '/me', (req) => {
      calls++;
      return req.headers.authorization === 'Bearer access-1'
        ? { status: 200, body: { email: 'a@example.com', last_heartbeat_at: null, session_active: false } }
        : { status: 401, body: { error: 'unauthorized', message: 'expired' } };
    });
    server.on('POST', '/auth/refresh', () => ({ status: 200, body: tokenPair('1') }));
    const saved: Credentials[] = [];
    const c = new MokkanClient({ baseUrl: server.url, credentials: creds(), onCredentials: (x) => saved.push(x), now: () => NOW });
    const me = await c.me();
    expect(me.email).toBe('a@example.com');
    expect(calls).toBe(2);
    expect(server.last('POST', '/auth/refresh')?.body).toEqual({ refresh_token: 'refresh-0' });
    expect(saved[0]?.access_token).toBe('access-1');
    expect(saved[0]?.email).toBe('a@example.com');
  });

  it('refreshes pre-emptively when the access token expires within an hour', async () => {
    server.on('POST', '/auth/refresh', () => ({ status: 200, body: tokenPair('2') }));
    server.on('GET', '/reminders/pending', () => ({ status: 200, body: { due: [], awaiting_ack: [] } }));
    const c = new MokkanClient({ baseUrl: server.url, credentials: creds('2026-09-28T12:30:00.000Z'), now: () => NOW });
    await c.pending();
    expect(server.count('POST', '/auth/refresh')).toBe(1);
    expect(server.last('GET', '/reminders/pending')?.headers.authorization).toBe('Bearer access-2');
  });

  describe('single-flight refresh', () => {
    /** A /auth/refresh that rotates like the real server: a refresh token already rotated is reuse, answered 401. */
    function rotatingRefresh(): void {
      const rotated = new Set<string>();
      let n = 0;
      server.on('POST', '/auth/refresh', async (req) => {
        const token = (req.body as { refresh_token: string }).refresh_token;
        if (rotated.has(token)) return { status: 401, body: { error: 'invalid_refresh', message: 'refresh token reuse' } };
        rotated.add(token);
        await new Promise((resolve) => setTimeout(resolve, 20));
        n++;
        return { status: 200, body: tokenPair(`r${n}`) };
      });
    }

    function authorisedAs(token: string, ok: unknown) {
      return (req: { headers: { authorization?: string } }) => req.headers.authorization === `Bearer ${token}`
        ? { status: 200, body: ok }
        : { status: 401, body: { error: 'unauthorized', message: 'expired' } };
    }

    function routes(): void {
      server.on('GET', '/me', authorisedAs('access-r1', { email: 'a@example.com', last_heartbeat_at: null, session_active: false }));
      server.on('GET', '/reminders', authorisedAs('access-r1', { version: 1, reminders: [] }));
      server.on('GET', '/reminders/pending', authorisedAs('access-r1', { due: [], awaiting_ack: [] }));
    }

    it('concurrent calls inside the pre-emptive window share one /auth/refresh', async () => {
      rotatingRefresh();
      routes();
      const saved: Credentials[] = [];
      const c = new MokkanClient({
        baseUrl: server.url, credentials: creds('2026-09-28T12:30:00.000Z'), onCredentials: (x) => saved.push(x), now: () => NOW,
      });
      const [me, list, pending] = await Promise.all([c.me(), c.list('active'), c.pending()]);
      expect(me.email).toBe('a@example.com');
      expect(list.version).toBe(1);
      expect(pending.due).toEqual([]);
      expect(server.count('POST', '/auth/refresh')).toBe(1);
      expect(saved.map((x) => x.access_token)).toEqual(['access-r1']);
    });

    it('concurrent 401s share one /auth/refresh', async () => {
      rotatingRefresh();
      routes();
      const saved: Credentials[] = [];
      const c = new MokkanClient({ baseUrl: server.url, credentials: creds(), onCredentials: (x) => saved.push(x), now: () => NOW });
      await Promise.all([c.me(), c.list('active'), c.pending()]);
      expect(server.count('POST', '/auth/refresh')).toBe(1);
      expect(saved).toHaveLength(1);
    });

    it('a failed refresh is not cached: the next call refreshes again', async () => {
      let fail = true;
      server.on('POST', '/auth/refresh', () => fail
        ? { status: 500, body: { error: 'internal', message: 'boom' } }
        : { status: 200, body: tokenPair('r1') });
      routes();
      const c = new MokkanClient({ baseUrl: server.url, credentials: creds('2026-09-28T12:30:00.000Z'), now: () => NOW });
      await expect(c.me()).rejects.toMatchObject({ status: 500 });
      fail = false;
      await expect(c.me()).resolves.toMatchObject({ email: 'a@example.com' });
      expect(server.count('POST', '/auth/refresh')).toBe(2);
    });
  });

  it('does not retry forever: a 401 after refresh becomes an ApiError', async () => {
    server.on('GET', '/me', () => ({ status: 401, body: { error: 'unauthorized', message: 'nope' } }));
    server.on('POST', '/auth/refresh', () => ({ status: 200, body: tokenPair('3') }));
    const c = new MokkanClient({ baseUrl: server.url, credentials: creds(), now: () => NOW });
    await expect(c.me()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(server.count('GET', '/me')).toBe(2);
  });

  it('throws ApiError with the server code and body on 4xx', async () => {
    server.on('POST', '/reminders/pop', () => ({ status: 409, body: { error: 'stale', message: 'stale version', version: 7, reminders: [] } }));
    const c = new MokkanClient({ baseUrl: server.url, credentials: creds(), now: () => NOW });
    const err = await c.pop(5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'stale', body: { version: 7 } });
    expect(server.last('POST', '/reminders/pop')?.body).toEqual({ expected_version: 5 });
  });

  it('serialises push, dequeue, deliver and ack bodies exactly', async () => {
    const reminder = { id: 'r1', text: 'x', state: 'due', position: 1, due_at: null, created_at: NOW.toISOString(), delivered_at: null, acknowledged_at: null, done_at: null };
    server.on('POST', '/reminders', () => ({ status: 201, body: { version: 1, reminder } }));
    server.on('POST', '/reminders/dequeue', () => ({ status: 200, body: { version: 2, reminder } }));
    server.on('POST', '/reminders/deliver', () => ({ status: 200, body: { version: 3, delivered: ['r1'] } }));
    server.on('POST', '/reminders/ack', () => ({ status: 200, body: { version: 4, acknowledged: ['r1'] } }));
    server.on('POST', '/heartbeat', () => ({ status: 200, body: { active_until: '2026-09-28T12:05:00.000Z' } }));
    const c = new MokkanClient({ baseUrl: server.url, credentials: creds(), now: () => NOW });
    await c.push('hello', new Date('2026-09-28T13:00:00.000Z'), 'cid-1');
    expect(server.last('POST', '/reminders')?.body).toEqual({ text: 'hello', due_at: '2026-09-28T13:00:00.000Z', client_id: 'cid-1' });
    await c.push('plain');
    expect(server.last('POST', '/reminders')?.body).toEqual({ text: 'plain' });
    await c.dequeue();
    expect(server.last('POST', '/reminders/dequeue')?.body).toEqual({});
    await c.deliver(['r1']);
    expect(server.last('POST', '/reminders/deliver')?.body).toEqual({ ids: ['r1'] });
    await c.ack('all');
    expect(server.last('POST', '/reminders/ack')?.body).toEqual({ all: true });
    await c.ack(['r1'], 4);
    expect(server.last('POST', '/reminders/ack')?.body).toEqual({ ids: ['r1'], expected_version: 4 });
    await c.heartbeat('claude-code', 'sess-1');
    expect(server.last('POST', '/heartbeat')?.body).toEqual({ source: 'claude-code', session_id: 'sess-1' });
  });

  it('logout posts with the token, tolerates an empty 204 body and drops credentials', async () => {
    server.on('POST', '/auth/logout', () => ({ status: 204 }));
    const c = new MokkanClient({ baseUrl: server.url, credentials: creds(), now: () => NOW });
    await c.logout();
    expect(server.last('POST', '/auth/logout')?.headers.authorization).toBe('Bearer access-0');
    expect(c.hasCredentials()).toBe(false);
  });

  it('throws ApiError(no_credentials) for authenticated calls without credentials', async () => {
    const c = new MokkanClient({ baseUrl: server.url, now: () => NOW });
    await expect(c.me()).rejects.toMatchObject({ status: 401, code: 'no_credentials' });
    expect(server.requests).toHaveLength(0);
  });

  it('throws NetworkError when the server is unreachable', async () => {
    const dead = server.url;
    await server.stop();
    const c = new MokkanClient({ baseUrl: dead, now: () => NOW });
    await expect(c.health()).rejects.toBeInstanceOf(NetworkError);
  });

  it('checkout uses a 30 s timeout, other calls the client default', async () => {
    const seen: number[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => { seen.push(ms as number); return real(fn, ms); }) as typeof setTimeout);
    try {
      server.withAccount({ balance: 5 });
      const c = new MokkanClient({ baseUrl: server.url, credentials: creds(), timeoutMs: 1234, now: () => NOW });
      await c.checkout().catch(() => undefined);
      await c.balance().catch(() => undefined);
    } finally { spy.mockRestore(); }
    expect(seen).toContain(30_000);
    expect(seen).toContain(1234);
  });

  it('throws NetworkError on timeout', async () => {
    server.on('GET', '/health', () => new Promise(() => undefined));
    const c = new MokkanClient({ baseUrl: server.url, timeoutMs: 100, now: () => NOW });
    await expect(c.health()).rejects.toBeInstanceOf(NetworkError);
  });
  describe('cross-process refresh (shared credentials file)', () => {
    let configHome: string;
    let env: NodeJS.ProcessEnv;
    beforeEach(() => {
      configHome = mkdtempSync(path.join(tmpdir(), 'mokkan-client-'));
      env = { XDG_CONFIG_HOME: configHome };
    });
    afterEach(() => { rmSync(configHome, { recursive: true, force: true }); });

    /** Like the real server: a refresh token already rotated is reuse, answered 401 invalid_token. */
    function strictRotatingRefresh(): void {
      const rotated = new Set<string>();
      let n = 0;
      server.on('POST', '/auth/refresh', async (req) => {
        const token = (req.body as { refresh_token: string }).refresh_token;
        if (rotated.has(token)) return { status: 401, body: { error: 'invalid_token', message: 'Refresh token is invalid, expired or already used' } };
        rotated.add(token);
        await new Promise((resolve) => setTimeout(resolve, 30));
        n++;
        return { status: 200, body: tokenPair(`r${n}`) };
      });
    }

    function meAcceptsOnly(token: string): void {
      server.on('GET', '/me', (req) => req.headers.authorization === `Bearer ${token}`
        ? { status: 200, body: { email: 'a@example.com', last_heartbeat_at: null, session_active: true } }
        : { status: 401, body: { error: 'unauthorized', message: 'expired' } });
    }

    /** One "process": its own client, loading from and saving to the shared file like cli.ts does. */
    function processClient(): MokkanClient {
      return new MokkanClient({
        baseUrl: server.url,
        credentials: loadCredentials(env),
        onCredentials: (next) => saveCredentials(next, env),
        reloadCredentials: () => loadCredentials(env),
        lock: (fn, signal) => withCredentialsLock(env, fn, { signal }),
        onSessionExpired: () => clearCredentials(env),
        now: () => NOW,
      });
    }

    it('two processes inside the pre-expiry window: exactly one /auth/refresh, both succeed', async () => {
      strictRotatingRefresh();
      meAcceptsOnly('access-r1');
      saveCredentials({ ...creds('2026-09-28T12:30:00.000Z'), server_url: server.url }, env);
      const a = processClient();
      const b = processClient();
      const [ma, mb] = await Promise.all([a.me(), b.me()]);
      expect(ma.email).toBe('a@example.com');
      expect(mb.email).toBe('a@example.com');
      expect(server.count('POST', '/auth/refresh')).toBe(1);
      expect(loadCredentials(env)?.refresh_token).toBe('refresh-r1');
      expect(existsSync(credentialsLockPath(env))).toBe(false);
    });

    it('a process holding stale tokens adopts the rotated ones from the file on 401 instead of refreshing', async () => {
      strictRotatingRefresh();
      meAcceptsOnly('access-r1');
      saveCredentials({ ...creds(), server_url: server.url }, env);
      const b = processClient(); // e.g. a long-running `mokkan watch`: loaded access-0/refresh-0
      const a = processClient(); // a Stop hook that rotates
      await a.me();
      expect(server.count('POST', '/auth/refresh')).toBe(1);
      const me = await b.me();
      expect(me.email).toBe('a@example.com');
      expect(server.count('POST', '/auth/refresh')).toBe(1);
      expect(server.last('GET', '/me')?.headers.authorization).toBe('Bearer access-r1');
      expect(loadCredentials(env)?.refresh_token).toBe('refresh-r1');
    });

    it('a rejected refresh token: SessionExpiredError, credentials file removed', async () => {
      server.on('POST', '/auth/refresh', () => ({ status: 401, body: { error: 'invalid_token', message: 'Refresh token is invalid, expired or already used' } }));
      meAcceptsOnly('access-never');
      saveCredentials({ ...creds(), server_url: server.url }, env);
      const c = processClient();
      const err = await c.me().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SessionExpiredError);
      expect((err as Error).message).toBe('Session expired on this machine; run: mokkan login');
      expect(existsSync(credentialsPath(env))).toBe(false);
      expect(c.hasCredentials()).toBe(false);
      expect(existsSync(credentialsLockPath(env))).toBe(false);
    });
  });
});
