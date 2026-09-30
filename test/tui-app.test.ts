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

  it('keeps navigation made while a refresh is in flight', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    let pressed: Promise<void> | undefined;
    acct.afterList = () => { pressed ??= type(app, 'j'); }; // the server has the list request, the app awaits it
    await app.refresh();
    await pressed;
    expect(app.state.selected).toBe(1);
    expect(app.rows()[1].id).toBe(ID1);
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

describe('TuiApp actions', () => {
  let server: FakeServer;
  let h: CliHarness;
  beforeEach(async () => { server = new FakeServer(); await server.start(); h = new CliHarness(); });
  afterEach(async () => { await server.stop(); h.dispose(); });

  it('pushes typed text and reports it', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'p');
    expect(app.state.mode).toMatchObject({ kind: 'input', purpose: 'push', label: 'push', buffer: '', cursor: 0 });
    expect(app.state.message).toBeNull();
    await type(app, 'call mom\r');
    expect(server.last('POST', '/reminders')?.body).toEqual({ text: 'call mom' });
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(app.state.message).toEqual({ text: 'Pushed [fake0001] call mom', tone: 'green' });
    expect(app.rows()[0].text).toBe('call mom');
    expect(app.state.credits).toBe(99);
  });

  it('edits the input line: cursor keys, backspace, delete, ctrl-u, escape', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'pabc\x1b[D\x1b[DX');
    expect(app.state.mode).toMatchObject({ buffer: 'aXbc', cursor: 2 });
    await type(app, '\x7f\x1b[3~');
    expect(app.state.mode).toMatchObject({ buffer: 'ac', cursor: 1 });
    await type(app, '\x1b[H\x1b[F🚀');
    expect(app.state.mode).toMatchObject({ buffer: 'ac🚀', cursor: 3 });
    await type(app, '\x15');
    expect(app.state.mode).toMatchObject({ buffer: '', cursor: 0 });
    await type(app, 'j\t');
    expect(app.state.mode).toMatchObject({ buffer: 'j' }); // navigation keys are text or ignored while typing
    expect(app.state.selected).toBe(0);
    await type(app, '\x1b');
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(server.count('POST', '/reminders')).toBe(0);
  });

  it('sends nothing for an empty submit, and quits on Ctrl-C even while typing', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'p   \r');
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(server.count('POST', '/reminders')).toBe(0);
    await type(app, 'pabc\x03');
    expect(app.exitCode).toBe(0);
  });

  it('schedules with a duration, keeping the input open on a bad one', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'isoon call mom\r');
    expect(app.state.mode).toMatchObject({ kind: 'input', purpose: 'in', buffer: 'soon call mom' });
    expect(app.state.message).toEqual({ text: 'Invalid duration "soon" (examples: 30s, 10m, 2h, 1d, 1h30m)', tone: 'red' });
    await type(app, '\x152h\r');
    expect(app.state.message).toEqual({ text: 'Add the reminder text after the duration.', tone: 'red' });
    await type(app, ' call mom\r');
    expect(server.last('POST', '/reminders')?.body).toEqual({ text: 'call mom', due_at: '2026-09-28T14:00:00.000Z' });
    expect(app.state.message).toEqual({ text: 'Scheduled [fake0001] "call mom" for 2026-09-28T14:00:00.000Z (in 2h)', tone: 'green' });
  });

  it('edits the selected text, prefilled, and skips the request when unchanged', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'e');
    expect(app.state.mode).toMatchObject({ kind: 'input', purpose: 'edit', label: 'edit [bbbb2222]', buffer: 'second', cursor: 6, targetId: ID2 });
    await type(app, '\r');
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(app.state.message).toEqual({ text: 'Unchanged.', tone: 'dim' });
    expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    await type(app, 'e draft\r');
    expect(server.last('PATCH', `/reminders/${ID2}`)?.body).toEqual({ text: 'second draft', expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'Edited [bbbb2222] second draft', tone: 'green' });
  });

  it('changes and clears the time of a scheduled reminder, and explains a not-editable one', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 't2h\r'); // ID2 is delivered by now: the fake answers 409 not_editable
    expect(server.last('PATCH', `/reminders/${ID2}`)?.body).toEqual({ due_at: '2026-09-28T14:00:00.000Z', expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'This reminder was already shown or emailed, so its time can no longer be changed.', tone: 'red' });
    await type(app, '\t'); // All tab: row 1 is the scheduled ID3
    await type(app, 't');
    expect(app.state.mode).toMatchObject({ purpose: 'time', label: 'time [3000cccc]', targetId: ID3, buffer: '' });
    await type(app, '2h\r');
    expect(server.last('PATCH', `/reminders/${ID3}`)?.body).toEqual({ due_at: '2026-09-28T14:00:00.000Z', expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'Edited [3000cccc] later (due 2026-09-28T14:00:00.000Z, in 2h)', tone: 'green' });
    await type(app, 'tclear\r');
    expect(server.last('PATCH', `/reminders/${ID3}`)?.body).toEqual({ due_at: null, expected_version: 9 });
    expect(app.state.message).toEqual({ text: 'Edited [3000cccc] later (time cleared)', tone: 'green' });
    await type(app, 'tnever\r');
    expect(app.state.mode).toMatchObject({ purpose: 'time', buffer: 'never' });
    expect(app.state.message?.tone).toBe('red');
  });

  it('refuses e, t and a without a usable selection', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, '\t\t'); // Done tab
    await type(app, 'e');
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(app.state.message).toEqual({ text: 'Switch to Active or All to change reminders.', tone: 'yellow' });
    const empty = makeApp(server, h);
    server.withAccount();
    await empty.refresh();
    await type(empty, 'a');
    expect(empty.state.message).toEqual({ text: 'Nothing selected.', tone: 'yellow' });
    await type(empty, 'x');
    expect(empty.state.mode).toEqual({ kind: 'normal' });
    expect(empty.state.message).toEqual({ text: 'List is empty.', tone: 'plain' });
  });

  it('pops the top after confirmation with the version adopted from delivery, and cancels on any other key', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'xn');
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(server.count('POST', '/reminders/pop')).toBe(0);
    await type(app, 'x');
    expect(app.state.mode).toEqual({ kind: 'confirm', action: 'pop', prompt: 'Pop "second"? y/n' });
    await type(app, 'y');
    expect(server.last('POST', '/reminders/pop')?.body).toEqual({ expected_version: 8 });
    expect(acct.reminders.get(ID2)?.state).toBe('done');
    expect(app.state.message).toEqual({ text: 'Popped [bbbb2222] second', tone: 'green' });
    expect(app.rows().map((r) => r.id)).toEqual([ID1]);
  });

  it('dequeues the bottom after confirmation', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'd');
    expect(app.state.mode).toEqual({ kind: 'confirm', action: 'dequeue', prompt: 'Dequeue "first"? y/n' });
    await type(app, 'y');
    expect(server.last('POST', '/reminders/dequeue')?.body).toEqual({ expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'Dequeued [aaaa1111] first', tone: 'green' });
  });

  it('refreshes and asks to retry when the list changed under a pop', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    acct.version += 1;
    await type(app, 'xy');
    expect(acct.reminders.get(ID2)?.state).toBe('delivered');
    expect(app.state.message).toEqual({ text: 'The list changed, try again.', tone: 'yellow' });
    expect(app.state.version).toBe(9);
  });

  it('acknowledges the selected reminder and all of them', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'ja');
    expect(server.last('POST', '/reminders/ack')?.body).toEqual({ ids: [ID1], expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'Acknowledged 1 reminder(s).', tone: 'green' });
    await type(app, 'A');
    expect(server.last('POST', '/reminders/ack')?.body).toEqual({ all: true });
    expect(app.state.message).toEqual({ text: 'Acknowledged 1 reminder(s).', tone: 'green' });
    expect(app.rows().every((r) => r.state === 'acknowledged')).toBe(true);
  });

  it('shows the credit error when a push is refused', async () => {
    seed(server, 0);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'pcall mom\r');
    expect(app.state.message?.tone).toBe('red');
    expect(app.state.message?.text).toContain('Not enough credits');
    expect(app.state.message?.text).toContain('mokkan buy');
  });

  it('runs a push typed during a refresh after it, in order', async () => {
    seed(server);
    const app = makeApp(server, h);
    const first = app.refresh();
    await type(app, 'p');
    const typed = type(app, 'hello\r');
    await first;
    await typed;
    const order = server.requests.filter((r) => r.method === 'POST' && (r.path === '/reminders' || r.path === '/reminders/deliver')).map((r) => r.path);
    expect(order.slice(0, 2)).toEqual(['/reminders/deliver', '/reminders']);
    expect(app.rows()[0].text).toBe('hello');
  });

  it('opens a trusted checkout link, shows an untrusted one without opening, and reports missing billing', async () => {
    seed(server);
    const opened: string[] = [];
    const app = makeApp(server, h, { opened });
    await app.refresh();
    await type(app, 'b');
    expect(server.count('POST', '/billing/checkout')).toBe(1);
    expect(opened).toEqual(['https://checkout.stripe.com/c/pay/cs_test_fake']);
    expect(app.state.message).toEqual({
      text: 'Checkout: https://checkout.stripe.com/c/pay/cs_test_fake · opening in your browser When the payment completes, the balance updates on the next refresh.',
      tone: 'plain',
    });
    server.withAccount({ checkoutUrl: 'https://evil.example/pay' });
    await type(app, 'b');
    expect(opened).toHaveLength(1);
    expect(app.state.message?.text).toContain('Checkout: https://evil.example/pay · not opened: not a Stripe Checkout address');
    server.on('POST', '/billing/checkout', () => ({ status: 404, body: { error: 'not_found', message: 'no' } }));
    await type(app, 'b');
    expect(app.state.message).toEqual({ text: 'Billing is not enabled on this server.', tone: 'red' });
  });
});
