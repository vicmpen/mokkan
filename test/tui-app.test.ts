import { existsSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MokkanClient } from '../src/client.js';
import { clearCredentials, credentialsPath, saveCredentials } from '../src/credentials.js';
import { TuiApp } from '../src/tui/app.js';
import { MAX_INPUT_CODE_POINTS } from '../src/tui/state.js';
import { displayWidth } from '../src/tui/text.js';
import { decodeKeys, PASTE_END, PASTE_START } from '../src/tui/keys.js';
import { CliHarness, NOW } from './cli-harness.js';
import { FakeServer, PRIVACY_SUMMARY, tokenPair, type FakeAccount, type FakePrivacy } from './fake-server.js';

export const ID1 = 'aaaa1111-0000-0000-0000-000000000000'; // bottom of the active list
export const ID2 = 'bbbb2222-0000-0000-0000-000000000000'; // top of the active list
export const ID3 = '3000cccc-0000-0000-0000-000000000000'; // scheduled: the top of the stack view, not of pop's list
export const IDNEW = 'dddd4444-0000-0000-0000-000000000000';

export const rem = (id: string, text: string, position: number, over: Record<string, unknown> = {}) => ({
  id, text, state: 'due', position, due_at: null as string | null, created_at: '2026-09-28T12:00:00.000Z',
  delivered_at: null, acknowledged_at: null, done_at: null, ...over,
});

/** TODOs: 1 = second (ID2), 2 = first (ID1); Reminders: 1 = later (ID3, scheduled). Pop takes ID2, dequeue ID1. Version 7. */
export function seed(server: FakeServer, balance = 100): FakeAccount {
  const acct = server.withAccount({ balance });
  acct.reminders.set(ID1, rem(ID1, 'first', 1));
  acct.reminders.set(ID2, rem(ID2, 'second', 2));
  acct.reminders.set(ID3, rem(ID3, 'later', 3, { state: 'scheduled', due_at: '2026-09-28T15:00:00.000Z' }));
  acct.version = 7;
  return acct;
}

export interface AppOptions {
  loggedIn?: boolean;
  accessExpiresAt?: string;
  opened?: string[];
  /** Replaces the default opener, which records the URL in `opened` and reports that a browser started. */
  openUrl?: (url: string) => boolean;
}

export function makeApp(server: FakeServer, h: CliHarness, opts: AppOptions = {}): TuiApp {
  const creds = opts.loggedIn === false ? null : h.saveCreds(server.url, opts.accessExpiresAt);
  const client = new MokkanClient({
    baseUrl: server.url, credentials: creds, now: () => NOW,
    onCredentials: (next) => saveCredentials(next, h.env()),
    onSessionExpired: () => clearCredentials(h.env()),
  });
  const app = new TuiApp({
    client, email: creds?.email ?? null, host: new URL(server.url).host, now: () => NOW,
    openUrl: opts.openUrl ?? ((url) => { opts.opened?.push(url); return true; }),
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
    expect(app.state.tab).toBe('todos'); // no reminder is due
    expect(app.rows().map((r) => r.id)).toEqual([ID2, ID1]);
    expect(app.state.credits).toBe(50);
    expect(app.state.fetchedAt).toEqual(NOW);
    expect(app.state.error).toBeNull();
    expect(server.last('POST', '/heartbeat')?.body).toEqual({ source: 'ui' });
    expect(server.last('POST', '/reminders/deliver')?.body).toEqual({ ids: [ID2, ID1] });
    expect(app.rows().map((r) => r.state)).toEqual(['delivered', 'delivered']);
    // The fake bumps the version on delivery; the app lists again and adopts it, so the next pop is not stale.
    expect(app.state.version).toBe(8);
    await app.refresh();
    expect(server.count('POST', '/reminders/deliver')).toBe(1);
  });

  it('moves the selection with arrows, Home, End and digits, and scrolls to keep it visible', async () => {
    const acct = server.withAccount();
    for (let i = 1; i <= 30; i++) acct.reminders.set(`r${i}`, rem(`r${String(i).padStart(3, '0')}-0000-0000-0000-000000000000`, `item ${i}`, i));
    const app = makeApp(server, h);
    await app.refresh();
    expect(app.state.selected).toBe(0);
    await type(app, '\x1b[B\x1b[B\x1b[B');
    expect(app.state.selected).toBe(3);
    await type(app, 'j\x1b[A\x1b[A'); // j no longer moves
    expect(app.state.selected).toBe(1);
    await type(app, '\x1b[A\x1b[A');
    expect(app.state.selected).toBe(0);
    await type(app, '\x1b[F');
    expect(app.state.selected).toBe(29);
    expect(app.state.scroll).toBe(13); // 30 rows, 17 visible at 24 lines (one line is the detail)
    await type(app, '\x1b[H');
    expect(app.state).toMatchObject({ selected: 0, scroll: 0 });
    await type(app, '7');
    expect(app.state.selected).toBe(6);
    expect(server.requests.filter((r) => r.method !== 'GET').length).toBe(2); // selecting changes nothing: heartbeat, deliver
  });

  it('jumps to a row with a digit, ignoring one past the end', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, '2');
    expect(app.rows()[app.state.selected].id).toBe(ID1);
    await type(app, '9');
    expect(app.state.selected).toBe(1);
    await type(app, '0');
    expect(app.state.selected).toBe(1);
  });

  it('cycles TODOs, Reminders and Archived with v and Tab, loads the archive, and keeps it fresh after', async () => {
    const acct = seed(server);
    acct.reminders.set(IDNEW, rem(IDNEW, 'old', 0, { state: 'done', done_at: '2026-09-27T12:00:00.000Z' }));
    const app = makeApp(server, h);
    await app.refresh();
    const doneLists = () => server.requests.filter((r) => r.path === '/reminders' && r.query.get('scope') === 'done').length;
    expect(app.state.tab).toBe('todos');
    expect(app.rows().map((r) => r.id)).toEqual([ID2, ID1]);
    await type(app, 'v');
    expect(app.state.tab).toBe('reminders');
    expect(app.rows().map((r) => r.id)).toEqual([ID3]);
    expect(doneLists()).toBe(0);
    await type(app, '\t');
    expect(app.state.tab).toBe('archived');
    expect(app.rows().map((r) => r.id)).toEqual([IDNEW]);
    expect(doneLists()).toBe(1);
    await type(app, 'v');
    expect(app.state.tab).toBe('todos');
    await type(app, 'vvv');
    expect(doneLists()).toBe(1);
    await app.refresh(); // once loaded, every refresh reloads it, so its count stays right
    expect(doneLists()).toBe(2);
  });

  it('keeps the selected reminder selected across a refresh', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, '\x1b[B');
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
    acct.afterList = () => { pressed ??= type(app, '\x1b[B'); }; // the server has the list request, the app awaits it
    await app.refresh();
    await pressed;
    expect(app.state.selected).toBe(1);
    expect(app.rows()[1].id).toBe(ID1);
  });

  it('lists again after delivering, so a change made in between is shown', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    let changed = false;
    acct.afterList = () => {
      if (changed) return;
      changed = true; // another session pushes after our list was answered, before our deliver
      acct.reminders.set(IDNEW, rem(IDNEW, 'from another session', 4));
      acct.version += 1;
    };
    await app.refresh();
    expect(server.count('POST', '/reminders/deliver')).toBe(1);
    expect(app.rows().map((r) => r.id)).toEqual([IDNEW, ID2, ID1]);
    expect(app.state.version).toBe(acct.version);
  });

  it('delivers only the due ones the tab shows, none from Archived', async () => {
    seed(server);
    const app = makeApp(server, h);
    await type(app, 'vv'); // a tab picked before the first list stays
    expect(app.state.tab).toBe('archived');
    await app.refresh();
    expect(app.state.tab).toBe('archived');
    expect(server.count('POST', '/reminders/deliver')).toBe(0);
    await type(app, 'v');
    await app.refresh();
    expect(server.last('POST', '/reminders/deliver')?.body).toEqual({ ids: [ID2, ID1] });
  });

  it('opens on Reminders while one is due, delivering it and not the todos', async () => {
    const acct = seed(server);
    acct.reminders.set(IDNEW, rem(IDNEW, 'call the bank', 4, { due_at: '2026-09-28T11:00:00.000Z' }));
    const app = makeApp(server, h);
    await app.refresh();
    expect(app.state.tab).toBe('reminders');
    expect(app.rows().map((r) => r.id)).toEqual([IDNEW, ID3]);
    expect(server.last('POST', '/reminders/deliver')?.body).toEqual({ ids: [IDNEW] });
    expect(app.render({ columns: 80, rows: 24 }, NOW)[1]).toContain('TODOs 2');
    await app.refresh();
    expect(app.state.tab).toBe('reminders'); // only the first list picks
  });

  it('shares a refresh that is already queued or running', async () => {
    seed(server);
    const app = makeApp(server, h);
    const first = app.refresh();
    expect(app.refresh()).toBe(first);
    await first;
    expect(server.count('POST', '/heartbeat')).toBe(1);
    await app.refresh();
    expect(server.count('POST', '/heartbeat')).toBe(2);
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
    await type(app, 't');
    expect(app.state.mode).toMatchObject({ kind: 'input', purpose: 'push', label: 'new todo', buffer: '', cursor: 0 });
    expect(app.state.message).toBeNull();
    await type(app, 'call mom\r');
    expect(server.last('POST', '/reminders')?.body).toEqual({ text: 'call mom' });
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(app.state.message).toEqual({ text: 'Added [fake0001] call mom', tone: 'green' });
    expect(app.rows()[0].text).toBe('call mom');
    expect(app.state.credits).toBe(99);
  });

  it('edits the input line: cursor keys, backspace, delete, ctrl-u, escape', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'tabc\x1b[D\x1b[DX');
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

  it('inserts a paste into the input line at the cursor in one step, newlines as spaces', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'tac\x1b[D');
    await type(app, `${PASTE_START}x🚀\r\ny${PASTE_END}`);
    expect(app.state.mode).toMatchObject({ kind: 'input', purpose: 'push', buffer: 'ax🚀 yc', cursor: 5 });
    expect(server.count('POST', '/reminders')).toBe(0);
  });

  it('caps the input line at 2000 code points, keeping the text after the cursor', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    expect(MAX_INPUT_CODE_POINTS).toBe(2000);
    await type(app, 'tab\x1b[D');
    await type(app, `${PASTE_START}${'x'.repeat(2500)}${PASTE_END}`);
    const capped = { buffer: `a${'x'.repeat(1998)}b`, cursor: 1999 };
    expect(app.state.mode).toMatchObject(capped);
    await type(app, 'y');
    expect(app.state.mode).toMatchObject(capped);
  });

  it('ignores a paste in normal mode', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    const before = server.requests.length;
    await type(app, `${PASTE_START}xay${PASTE_END}`);
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(app.state.message).toBeNull();
    expect(server.requests).toHaveLength(before);
  });

  it('does not confirm a pop with a pasted y', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'p');
    await type(app, `${PASTE_START}y${PASTE_END}`);
    expect(app.state.mode.kind).toBe('confirm');
    expect(server.count('POST', '/reminders/pop')).toBe(0);
    expect(acct.reminders.get(ID2)?.state).toBe('delivered');
  });

  it('sends nothing for an empty submit, and quits on Ctrl-C even while typing', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 't   \r');
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(server.count('POST', '/reminders')).toBe(0);
    await type(app, 'tabc\x03');
    expect(app.exitCode).toBe(0);
  });

  it('schedules with a duration, keeping the input open on a bad one', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'rsoon call mom\r');
    expect(app.state.mode).toMatchObject({ kind: 'input', purpose: 'in', buffer: 'soon call mom' });
    expect(app.state.message).toEqual({ text: 'Invalid duration "soon" (examples: 30s, 10m, 2h, 1d, 1h30m)', tone: 'red' });
    await type(app, '\x152h\r');
    expect(app.state.message).toEqual({ text: 'Add the reminder text after the duration.', tone: 'red' });
    await type(app, ' call mom\r');
    expect(server.last('POST', '/reminders')?.body).toEqual({ text: 'call mom', due_at: '2026-09-28T14:00:00.000Z' });
    expect(app.state.message).toEqual({ text: 'Scheduled [fake0001] "call mom" for 2026-09-28T14:00:00.000Z (in 2h) → Reminders', tone: 'green' });
    expect(app.state.tab).toBe('todos'); // the view stays
  });

  it('edits the selected text, prefilled, and skips the request when unchanged', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, '1e');
    expect(app.state.mode).toMatchObject({ kind: 'input', purpose: 'edit', label: 'edit [bbbb2222]', buffer: 'second', cursor: 6, targetId: ID2 });
    await type(app, '\r');
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(app.state.message).toEqual({ text: 'Unchanged.', tone: 'dim' });
    expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
    await type(app, 'e draft\r');
    expect(server.last('PATCH', `/reminders/${ID2}`)?.body).toEqual({ text: 'second draft', expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'Edited [bbbb2222] second draft', tone: 'green' });
  });

  it('keeps the edit open on an emptied text instead of closing it', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, '1e\x15   \r');
    expect(app.state.mode).toMatchObject({ kind: 'input', purpose: 'edit', buffer: '   ' });
    expect(app.state.message).toEqual({ text: 'The text can’t be empty.', tone: 'red' });
    expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });

  it('changes and clears the time of a scheduled reminder, and explains a not-editable one', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, '1w2h\r'); // ID2 is delivered by now: the fake answers 409 not_editable
    expect(server.last('PATCH', `/reminders/${ID2}`)?.body).toEqual({ due_at: '2026-09-28T14:00:00.000Z', expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'This reminder was already shown or emailed, so its time can no longer be changed.', tone: 'red' });
    await type(app, 'v1w'); // Reminders: row 1 is the scheduled ID3
    expect(app.state.mode).toMatchObject({ purpose: 'time', label: 'due in [3000cccc]', targetId: ID3, buffer: '' });
    await type(app, '2h\r');
    expect(server.last('PATCH', `/reminders/${ID3}`)?.body).toEqual({ due_at: '2026-09-28T14:00:00.000Z', expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'Edited [3000cccc] later (due 2026-09-28T14:00:00.000Z, in 2h)', tone: 'green' });
    await type(app, 'wnever\r');
    expect(app.state.mode).toMatchObject({ purpose: 'time', buffer: 'never' });
    expect(app.state.message?.tone).toBe('red');
    await type(app, '\x15clear\r'); // cleared, it moves to TODOs, and the view stays
    expect(server.last('PATCH', `/reminders/${ID3}`)?.body).toEqual({ due_at: null, expected_version: 9 });
    expect(app.state.message).toEqual({ text: 'Edited [3000cccc] later (time cleared) → TODOs', tone: 'green' });
    expect(app.state.tab).toBe('reminders');
    expect(app.rows()).toEqual([]);
  });

  it('refuses e, w, a and d without a usable selection', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'vv'); // Archived
    for (const key of ['e', 'w', 'a']) {
      await type(app, key);
      expect(app.state.mode).toEqual({ kind: 'normal' });
      expect(app.state.message).toEqual({ text: 'Archived ones cannot be changed; d reopens one.', tone: 'yellow' });
    }
    await type(app, 'd'); // nothing archived yet
    expect(app.state.message).toEqual({ text: 'Nothing selected.', tone: 'yellow' });
    const empty = makeApp(server, h);
    server.withAccount();
    await empty.refresh();
    await type(empty, 'd');
    expect(empty.state.message).toEqual({ text: 'Nothing selected.', tone: 'yellow' });
    for (const key of ['p', 'o']) {
      await type(empty, key);
      expect(empty.state.mode).toEqual({ kind: 'normal' });
      expect(empty.state.message).toEqual({ text: 'The stack is empty.', tone: 'plain' });
    }
    expect(server.count('POST', '/reminders/pop') + server.count('POST', '/reminders/dequeue')).toBe(0);
  });

  /** The server's POST /reminders/:id/done, on the seeded account (the shared fake does not have it). */
  const withDone = (acct: FakeAccount) => server.on('POST', '/reminders/:id/done', (req) => {
    const { done, expected_version } = req.body as { done: boolean; expected_version?: number };
    if (expected_version !== undefined && expected_version !== acct.version) {
      return { status: 409, body: { error: 'stale', message: 'Your view of the list is out of date' } };
    }
    const r = acct.reminders.get(req.params.id)!;
    r.state = done ? 'done' : 'due';
    r.done_at = done ? '2026-09-28T12:00:00.000Z' : null;
    acct.version += 1;
    return { status: 200, body: { version: acct.version, reminder: structuredClone(r) } };
  });

  it('archives the selected reminder with d, and reopens it from Archived', async () => {
    const acct = seed(server);
    withDone(acct);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, '1d');
    expect(server.last('POST', `/reminders/${ID2}/done`)?.body).toEqual({ done: true, expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'Archived [bbbb2222] second', tone: 'green' });
    expect(app.rows().map((r) => r.id)).toEqual([ID1]);
    await type(app, 'vv');
    expect(app.rows().map((r) => r.id)).toEqual([ID2]);
    await type(app, 'd');
    expect(server.last('POST', `/reminders/${ID2}/done`)?.body).toEqual({ done: false, expected_version: 9 });
    expect(app.state.message).toEqual({ text: 'Reopened [bbbb2222] second', tone: 'green' });
    expect(app.rows()).toEqual([]);
    expect(app.state.reminders.map((r) => r.id)).toEqual([ID3, ID2, ID1]);
  });

  it('asks with Enter before archiving the selected reminder, and before reopening it from Archived', async () => {
    const acct = seed(server);
    withDone(acct);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, '1\rn');
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(server.count('POST', `/reminders/${ID2}/done`)).toBe(0);
    await type(app, '\r');
    expect(app.state.mode).toEqual({ kind: 'confirm', action: 'done', text: 'second', version: 8, targetId: ID2 });
    expect(app.render({ columns: 80, rows: 24 }, NOW)[22]).toContain(' archive "second"?  y: archive  n: keep');
    await type(app, 'y');
    expect(server.last('POST', `/reminders/${ID2}/done`)?.body).toEqual({ done: true, expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'Archived [bbbb2222] second', tone: 'green' });
    await type(app, 'vv\r');
    expect(app.state.mode).toEqual({ kind: 'confirm', action: 'undone', text: 'second', version: 9, targetId: ID2 });
    expect(app.render({ columns: 80, rows: 24 }, NOW)[22]).toContain(' reopen "second"?  y: reopen  n: keep');
    await type(app, 'y');
    expect(server.last('POST', `/reminders/${ID2}/done`)?.body).toEqual({ done: false, expected_version: 9 });
    expect(app.state.message).toEqual({ text: 'Reopened [bbbb2222] second', tone: 'green' });
  });

  it('pops the top after confirmation with the version adopted from delivery, and cancels on any other key', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'pn');
    expect(app.state.mode).toEqual({ kind: 'normal' });
    expect(server.count('POST', '/reminders/pop')).toBe(0);
    await type(app, 'p');
    expect(app.state.mode).toEqual({ kind: 'confirm', action: 'pop', text: 'second', version: 8 });
    expect(app.render({ columns: 80, rows: 24 }, NOW)[22]).toContain(' pop "second"?  y: pop  n: keep'); // names its target
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
    await type(app, 'o');
    expect(app.state.mode).toEqual({ kind: 'confirm', action: 'dequeue', text: 'first', version: 8 });
    await type(app, 'y');
    expect(server.last('POST', '/reminders/dequeue')?.body).toEqual({ expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'Popped [aaaa1111] first', tone: 'green' });
  });

  it('refreshes and asks to retry when the list changed under a pop', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    acct.version += 1;
    await type(app, 'py');
    expect(acct.reminders.get(ID2)?.state).toBe('delivered');
    expect(app.state.message).toEqual({ text: 'The list changed, try again.', tone: 'yellow' });
    expect(app.state.version).toBe(9);
  });

  it('pops nothing when the list changed while the prompt was open', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'p');
    expect(app.state.mode).toMatchObject({ kind: 'confirm', text: 'second' });
    acct.reminders.set(IDNEW, rem(IDNEW, 'from another session', 4)); // another session pushes onto the top
    acct.version += 1;
    await app.refresh();
    expect(app.state.mode.kind).toBe('confirm');
    await type(app, 'y');
    expect(server.last('POST', '/reminders/pop')?.body).toEqual({ expected_version: 8 });
    expect(acct.reminders.get(ID2)?.state).not.toBe('done');
    expect(acct.reminders.get(IDNEW)?.state).not.toBe('done');
    expect(app.state.message).toEqual({ text: 'The list changed, try again.', tone: 'yellow' });
    expect(app.state.mode).toEqual({ kind: 'normal' });
  });

  it('does not overwrite a text change made while editing', async () => {
    const acct = seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, '1e');
    expect(app.state.mode).toMatchObject({ purpose: 'edit', buffer: 'second' });
    acct.reminders.get(ID2)!.text = 'changed elsewhere'; // another session edits it
    acct.version += 1;
    await app.refresh();
    await type(app, ' draft\r');
    expect(server.last('PATCH', `/reminders/${ID2}`)?.body).toEqual({ text: 'second draft', expected_version: 8 });
    expect(acct.reminders.get(ID2)?.text).toBe('changed elsewhere');
    expect(app.state.message).toEqual({ text: 'The list changed, try again.', tone: 'yellow' });
    // The typed text comes back, now with the version just fetched, so Enter retries against the fresh list.
    expect(app.state.mode).toMatchObject({ kind: 'input', purpose: 'edit', buffer: 'second draft', cursor: 12, targetId: ID2, version: 9 });
  });

  it('acknowledges the selected reminder with a and all of them with A', async () => {
    seed(server);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, '2a');
    expect(server.last('POST', '/reminders/ack')?.body).toEqual({ ids: [ID1], expected_version: 8 });
    expect(app.state.message).toEqual({ text: 'Acknowledged 1 reminder(s).', tone: 'green' });
    expect(app.state.selected).toBe(1); // k is ack now, not a move
    await type(app, 'A');
    expect(server.last('POST', '/reminders/ack')?.body).toEqual({ all: true });
    expect(app.state.message).toEqual({ text: 'Acknowledged 1 reminder(s).', tone: 'green' });
    expect(app.rows().map((r) => r.state)).toEqual(['acknowledged', 'acknowledged']);
  });

  it('shows the credit error when a push is refused', async () => {
    seed(server, 0);
    const app = makeApp(server, h);
    await app.refresh();
    await type(app, 'tcall mom\r');
    expect(app.state.message?.tone).toBe('red');
    expect(app.state.message?.text).toContain('Not enough credits');
    expect(app.state.message?.text).toContain('mokkan buy');
  });

  it('runs a push typed during a refresh after it, in order', async () => {
    seed(server);
    const app = makeApp(server, h);
    const first = app.refresh();
    await type(app, 't');
    const typed = type(app, 'hello\r');
    await first;
    await typed;
    const order = server.requests.filter((r) => r.method === 'POST' && (r.path === '/reminders' || r.path === '/reminders/deliver')).map((r) => r.path);
    expect(order.slice(0, 2)).toEqual(['/reminders/deliver', '/reminders']);
    expect(app.rows()[0].text).toBe('hello');
  });

  const BUY_OPENED = 'Opened Stripe Checkout in your browser; the balance updates after payment.';
  const BUY_NO_BROWSER = 'Could not open a browser here. Run: mokkan buy --no-open (prints the link).';
  const BUY_UNTRUSTED = 'Checkout link is not a Stripe address. Run: mokkan buy --no-open to see it.';

  it('keeps each buy message on one 79-column line', () => {
    for (const text of [BUY_OPENED, BUY_NO_BROWSER, BUY_UNTRUSTED]) expect(displayWidth(text)).toBeLessThanOrEqual(79);
  });

  it('opens a trusted checkout link, refuses an untrusted one, and reports missing billing', async () => {
    seed(server);
    const opened: string[] = [];
    const app = makeApp(server, h, { opened });
    await app.refresh();
    await type(app, 'b');
    expect(server.count('POST', '/billing/checkout')).toBe(1);
    expect(opened).toEqual(['https://checkout.stripe.com/c/pay/cs_test_fake']);
    expect(app.state.message).toEqual({ text: BUY_OPENED, tone: 'plain' });
    server.withAccount({ checkoutUrl: 'https://evil.example/pay' });
    await type(app, 'b');
    expect(opened).toHaveLength(1);
    expect(app.state.message).toEqual({ text: BUY_UNTRUSTED, tone: 'plain' });
    server.on('POST', '/billing/checkout', () => ({ status: 404, body: { error: 'not_found', message: 'no' } }));
    await type(app, 'b');
    expect(app.state.message).toEqual({ text: 'Billing is not enabled on this server.', tone: 'red' });
  });

  it('points to mokkan buy --no-open when no browser opens', async () => {
    seed(server);
    const noBrowser = { text: BUY_NO_BROWSER, tone: 'plain' };
    const refused = makeApp(server, h, { openUrl: () => false });
    await type(refused, 'b');
    expect(refused.state.message).toEqual(noBrowser);
    const throwing = makeApp(server, h, { openUrl: () => { throw new Error('spawn failed'); } });
    await type(throwing, 'b');
    expect(throwing.state.message).toEqual(noBrowser);
    expect(server.count('POST', '/billing/checkout')).toBe(2);
  });
});

describe('TuiApp login screen', () => {
  let server: FakeServer;
  let h: CliHarness;
  beforeEach(async () => {
    server = new FakeServer();
    await server.start();
    h = new CliHarness();
    seed(server);
    server.on('POST', '/auth/login', (req) => (req.body as { password: string }).password === 'correct horse'
      ? { status: 200, body: tokenPair('L') }
      : { status: 401, body: { error: 'invalid_credentials', message: 'Wrong email or password' } });
  });
  afterEach(async () => { await server.stop(); h.dispose(); });

  it('starts on the login screen when there are no credentials, and nothing is fetched', async () => {
    const app = makeApp(server, h, { loggedIn: false });
    expect(app.state.screen).toBe('login');
    await app.refresh();
    expect(server.requests).toHaveLength(0);
  });

  it('edits the two fields, switching with Tab, arrows and Enter', async () => {
    const app = makeApp(server, h, { loggedIn: false });
    await type(app, 'you@example.com');
    expect(app.state.login).toMatchObject({ field: 'email', email: 'you@example.com', cursor: 15 });
    await type(app, '\t');
    expect(app.state.login).toMatchObject({ field: 'password', cursor: 0 });
    await type(app, 'pw\x1b[A');
    expect(app.state.login).toMatchObject({ field: 'email', password: 'pw', cursor: 15 });
    await type(app, '\x7f\x7f\x7fnet\r');
    expect(app.state.login).toMatchObject({ field: 'password', email: 'you@example.net', cursor: 2 });
    await type(app, '\x15');
    expect(app.state.login.password).toBe('');
    await type(app, 'q'); // a letter here, not quit
    expect(app.exitCode).toBeNull();
    expect(app.state.login.password).toBe('q');
  });

  it('inserts a paste into the active field', async () => {
    const app = makeApp(server, h, { loggedIn: false });
    await type(app, 'you.com\x1b[D\x1b[D\x1b[D\x1b[D');
    await type(app, `${PASTE_START}@example${PASTE_END}`);
    expect(app.state.login).toMatchObject({ field: 'email', email: 'you@example.com', cursor: 11 });
    await type(app, `\t${PASTE_START}${'p'.repeat(2500)}${PASTE_END}`);
    expect(app.state.login).toMatchObject({ field: 'password', password: 'p'.repeat(2000), cursor: 2000 });
  });

  it('rejects an empty email or password locally', async () => {
    const app = makeApp(server, h, { loggedIn: false });
    await type(app, '\r\r');
    expect(app.state.login).toMatchObject({ field: 'email', error: { text: 'Enter an email address.', tone: 'red' } });
    await type(app, 'you@example.com\r\r');
    expect(app.state.login).toMatchObject({ field: 'password', error: { text: 'Enter your password.', tone: 'red' } });
    expect(server.count('POST', '/auth/login')).toBe(0);
  });

  it('shows the server message on a wrong password and clears the password', async () => {
    const app = makeApp(server, h, { loggedIn: false });
    await type(app, 'you@example.com\twrong\r');
    expect(server.last('POST', '/auth/login')?.body).toEqual({ email: 'you@example.com', password: 'wrong' });
    expect(app.state.screen).toBe('login');
    expect(app.state.login).toMatchObject({ field: 'password', password: '', cursor: 0, busy: false, error: { text: 'Wrong email or password', tone: 'red' } });
    expect(existsSync(credentialsPath(h.env()))).toBe(false);
  });

  it('logs in, saves the credentials, and loads the dashboard', async () => {
    const app = makeApp(server, h, { loggedIn: false });
    await type(app, 'you@example.com\tcorrect horse\r');
    expect(app.state.screen).toBe('dashboard');
    expect(app.state.email).toBe('you@example.com');
    expect(existsSync(credentialsPath(h.env()))).toBe(true);
    expect(app.rows().map((r) => r.id)).toEqual([ID2, ID1]);
    expect(app.state.credits).toBe(100);
    expect(app.state.login.password).toBe('');
  });

  it('comes back to the dashboard after a session loss and a new login', async () => {
    server.on('POST', '/auth/refresh', () => ({ status: 401, body: { error: 'invalid_token', message: 'dead' } }));
    const app = makeApp(server, h, { accessExpiresAt: '2026-09-28T11:00:00.000Z' });
    await app.refresh();
    expect(app.state.screen).toBe('login');
    await type(app, 'a@example.com\tcorrect horse\r');
    expect(app.state.screen).toBe('dashboard');
    expect(app.rows()).toHaveLength(2);
  });
});

describe('TuiApp privacy acceptance view', () => {
  let server: FakeServer;
  let h: CliHarness;
  let privacy: FakePrivacy;
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  beforeEach(async () => {
    server = new FakeServer();
    await server.start();
    h = new CliHarness();
    seed(server);
    privacy = server.withPrivacy();
  });
  afterEach(async () => { await server.stop(); h.dispose(); });

  it('shows the acceptance view; y accepts and goes back to the list', async () => {
    const app = makeApp(server, h);
    await app.refresh();
    expect(app.state.screen).toBe('privacy');
    expect(app.state.privacy).toEqual({ version: '2026-10-04', url: 'https://mokkan.dev/privacy', summary: PRIVACY_SUMMARY });
    const screen = strip(app.render({ columns: 80, rows: 24 }, new Date()).join('\n'));
    expect(screen).toContain('The privacy policy (version 2026-10-04) needs your acceptance.');
    expect(screen).toContain(PRIVACY_SUMMARY[0].slice(0, 40));
    expect(screen).toContain('Full text: https://mokkan.dev/privacy');
    expect(screen).toContain('y accept · n quit · d delete');
    await type(app, 'xy');
    expect(server.last('POST', '/privacy/accept')?.body).toEqual({ version: '2026-10-04' });
    expect(app.state.screen).toBe('dashboard');
    expect(app.state.message).toEqual({ text: 'Privacy policy accepted.', tone: 'green' });
    expect(app.rows().map((r) => r.id)).toEqual([ID2, ID1]);
  });

  it('a 409 shows the new version; n quits with exit 4', async () => {
    const app = makeApp(server, h);
    await app.refresh();
    privacy.version = '2026-11-01';
    await type(app, 'y');
    expect(app.state.screen).toBe('privacy');
    expect(app.state.privacy?.version).toBe('2026-11-01');
    expect(app.state.message?.tone).toBe('yellow');
    await type(app, 'n');
    expect(app.exitCode).toBe(4);
  });
});
