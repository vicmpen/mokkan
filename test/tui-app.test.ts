import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MokkanClient } from '../src/client.js';
import { clearCredentials, credentialsPath, saveCredentials } from '../src/credentials.js';
import { TuiApp } from '../src/tui/app.js';
import { decodeKeys } from '../src/tui/keys.js';
import { CliHarness, NOW } from './cli-harness.js';
import { FakeServer, type FakeAccount } from './fake-server.js';

export const ID1 = 'aaaa1111-0000-0000-0000-000000000000'; // bottom of the active list
export const ID2 = 'bbbb2222-0000-0000-0000-000000000000'; // top of the active list
export const ID3 = '3000cccc-0000-0000-0000-000000000000'; // scheduled: only in the All tab
export const IDNEW = 'dddd4444-0000-0000-0000-000000000000';

export const rem = (id: string, text: string, position: number, over: Record<string, unknown> = {}) => ({
  id, text, state: 'due', position, due_at: null as string | null, created_at: '2026-09-28T12:00:00.000Z',
  delivered_at: null, acknowledged_at: null, done_at: null, ...over,
});

/** Active tab: 1 = second (ID2), 2 = first (ID1). All tab: 1 = later (ID3), 2 = ID2, 3 = ID1. Version 7. */
export function seed(server: FakeServer, balance = 100): FakeAccount {
  const acct = server.withAccount({ balance });
  acct.reminders.set(ID1, rem(ID1, 'first', 1));
  acct.reminders.set(ID2, rem(ID2, 'second', 2));
  acct.reminders.set(ID3, rem(ID3, 'later', 3, { state: 'scheduled', due_at: '2026-09-28T15:00:00.000Z' }));
  acct.version = 7;
  return acct;
}

export interface AppOptions { loggedIn?: boolean; accessExpiresAt?: string; opened?: string[] }

export function makeApp(server: FakeServer, h: CliHarness, opts: AppOptions = {}): TuiApp {
  const creds = opts.loggedIn === false ? null : h.saveCreds(server.url, opts.accessExpiresAt);
  const client = new MokkanClient({
    baseUrl: server.url, credentials: creds, now: () => NOW,
    onCredentials: (next) => saveCredentials(next, h.env()),
    onSessionExpired: () => clearCredentials(h.env()),
  });
  const app = new TuiApp({
    client, email: creds?.email ?? null, host: new URL(server.url).host, now: () => NOW,
    openUrl: (url) => { opts.opened?.push(url); },
  });
  app.setSize({ columns: 80, rows: 24 });
  return app;
}

/** Feeds raw bytes as keys, awaiting each key's work. */
export async function type(app: TuiApp, text: string): Promise<void> {
  for (const key of decodeKeys(text)) await app.handleKey(key);
}

describe('TuiApp core', () => {
  let server: FakeServer;
  let h: CliHarness;
  beforeEach(async () => { server = new FakeServer(); await server.start(); h = new CliHarness(); });
  afterEach(async () => { await server.stop(); h.dispose(); });

  it('loads the list and credits, heartbeats as ui, and delivers due reminders once', async () => {
    seed(server, 50);
    const app = makeApp(server, h);
    expect(app.state.screen).toBe('dashboard');
    await app.refresh();
    expect(app.state.reminders.map((r) => r.text)).toEqual(['later', 'second', 'first']);
    expect(app.rows().map((r) => r.id)).toEqual([ID2, ID1]);
    expect(app.state.credits).toBe(50);
    expect(app.state.fetchedAt).toEqual(NOW);
    expect(app.state.error).toBeNull();
    expect(server.last('POST', '/heartbeat')?.body).toEqual({ source: 'ui' });
    expect(server.last('POST', '/reminders/deliver')?.body).toEqual({ ids: [ID2, ID1] });
    expect(app.rows().every((r) => r.state === 'delivered')).toBe(true);
    // The fake bumps the version on delivery; the app adopts it so the next pop is not stale.
    expect(app.state.version).toBe(8);
    await app.refresh();
    expect(server.count('POST', '/reminders/deliver')).toBe(1);
  });

  it('moves the selection with arrows, j/k, Home and End, and scrolls to keep it visible', async () => {
    const acct = server.withAccount();
    for (let i = 1; i <= 30; i++) acct.reminders.set(`r${i}`, rem(`r${String(i).padStart(3, '0')}-0000-0000-0000-000000000000`, `item ${i}`, i));
    const app = makeApp(server, h);
    await app.refresh();
    expect(app.state.selected).toBe(0);
    await type(app, '\x1b[B\x1b[Bj');
    expect(app.state.selected).toBe(3);
    await type(app, 'k\x1b[A');
    expect(app.state.selected).toBe(1);
    await type(app, '\x1b[A\x1b[A');
    expect(app.state.selected).toBe(0);
    await type(app, '\x1b[F');
    expect(app.state.selected).toBe(29);
    expect(app.state.scroll).toBe(12); // 30 rows, 18 visible at 24 lines
    await type(app, '\x1b[H');
    expect(app.state).toMatchObject({ selected: 0, scroll: 0 });
  });

  it('cycles tabs with Tab and loads the done list once', async () => {
    const acct = seed(server);
    acct.reminders.set(IDNEW, rem(IDNEW, 'old', 0, { state: 'done', done_at: '2026-09-27T12:00:00.000Z' }));
    const app = makeApp(server, h);
    await app.refresh();
    const doneLists = () => server.requests.filter((r) => r.path === '/reminders' && r.query.get('scope') === 'done').length;
    await type(app, '\t');
    expect(app.state.tab).toBe('all');
    expect(app.rows().map((r) => r.id)).toEqual([ID3, ID2, ID1]);
    await type(app, '\t');
    expect(app.state.tab).toBe('done');
    expect(app.rows().map((r) => r.id)).toEqual([IDNEW]);
    expect(doneLists()).toBe(1);
    await type(app, '\t');
    expect(app.state.tab).toBe('active');
    await type(app, '\t\t');
    expect(doneLists()).toBe(1);
    await app.refresh(); // in the Done tab a refresh reloads it
    expect(doneLists()).toBe(2);
  });

  it('keeps the selected reminder selected across a refresh', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'j');
    expect(app.rows()[app.state.selected].id).toBe(ID1);
    acct.reminders.set(IDNEW, rem(IDNEW, 'new', 4));
    await app.refresh();
    expect(app.state.selected).toBe(2);
    expect(app.rows()[2].id).toBe(ID1);
  });

  it('keeps the last list and reports offline when the server goes away', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await server.stop();
    await app.refresh();
    expect(app.state.error?.kind).toBe('offline');
    expect(app.state.reminders).toHaveLength(3);
    expect(app.state.fetchedAt).toEqual(NOW);
  });

  it('quits on q and Ctrl-C', async () => {
    seed(server);
    const app = makeApp(server, h);
    expect(app.exitCode).toBeNull();
    await type(app, 'q');
    expect(app.exitCode).toBe(0);
    const again = makeApp(server, h);
    await type(again, '\x03');
    expect(again.exitCode).toBe(0);
  });

  it('switches to the login screen when the session is lost', async () => {
    seed(server);
    server.on('POST', '/auth/refresh', () => ({ status: 401, body: { error: 'invalid_token', message: 'dead' } }));
    const app = makeApp(server, h, { accessExpiresAt: '2026-09-28T11:00:00.000Z' });
    await app.refresh();
    expect(app.state.screen).toBe('login');
    expect(app.state.login.error).toEqual({ text: 'Session expired, log in again.', tone: 'red' });
    expect(app.state.reminders).toEqual([]);
    expect(existsSync(credentialsPath(h.env()))).toBe(false);
    await type(app, '\x1b');
    expect(app.exitCode).toBe(0);
  });
});
