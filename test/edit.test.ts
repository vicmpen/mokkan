import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MokkanClient } from '../src/client.js';
import { CliHarness, NOW } from './cli-harness.js';
import { FakeServer, type FakeAccount } from './fake-server.js';

const ID1 = 'aaaa1111-0000-0000-0000-000000000000';
const ID2 = 'bbbb2222-0000-0000-0000-000000000000';
/** Scheduled, so only in `mokkan list --all`. Its id starts with digits on purpose (see the list-number tests). */
const ID3 = '3000cccc-0000-0000-0000-000000000000';
const IDNEW = 'dddd4444-0000-0000-0000-000000000000';

const rem = (id: string, text: string, position: number, over: Record<string, unknown> = {}) => ({
  id, text, state: 'due', position, due_at: null as string | null, created_at: '2026-09-28T12:00:00.000Z',
  delivered_at: null, acknowledged_at: null, done_at: null, ...over,
});

describe('mokkan edit', () => {
  let server: FakeServer;
  let h: CliHarness;
  beforeEach(async () => { server = new FakeServer(); await server.start(); h = new CliHarness(); });
  afterEach(async () => { await server.stop(); h.dispose(); });
  const run = (argv: string[]) => h.run(argv, { serverUrl: server.url, loggedIn: true });

  /** `mokkan list`: 1 = second (ID2), 2 = first (ID1). `mokkan list --all`: 1 = later (ID3), 2 = ID2, 3 = ID1. */
  function setup(balance = 100): FakeAccount {
    const acct = server.withAccount({ balance });
    acct.reminders.set(ID1, rem(ID1, 'first', 1));
    acct.reminders.set(ID2, rem(ID2, 'second', 2));
    acct.reminders.set(ID3, rem(ID3, 'later', 3, { state: 'scheduled', due_at: '2026-09-28T15:00:00.000Z' }));
    acct.version = 7;
    return acct;
  }
  const patches = () => server.requests.filter((r) => r.method === 'PATCH');

  it('takes the new text from the words after the target and sends expected_version', async () => {
    const acct = setup();
    const r = await run(['edit', '2', 'call', 'mom', 'at', '5']);
    expect(r.code).toBe(0);
    expect(acct.reminders.get(ID1)?.text).toBe('call mom at 5');
    expect(server.last('PATCH', `/reminders/${ID1}`)?.body).toEqual({ text: 'call mom at 5', expected_version: 7 });
    expect(server.last('GET', '/reminders')?.query.get('scope')).toBe('active');
    expect(r.stdout).toContain('Edited [aaaa1111]');
  });

  it('keeps --text as an alias, and rejects --text together with trailing words', async () => {
    const acct = setup();
    expect((await run(['edit', '2', '--text', 'new words'])).code).toBe(0);
    expect(acct.reminders.get(ID1)?.text).toBe('new words');
    const both = await run(['edit', '2', '--text', 'x', 'y']);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain('not both');
  });

  it('the multi-word slash-command form works: /mokkan edit 2 --in 2h call mom at 5', async () => {
    const acct = setup();
    const r = await h.run(['--argline', 'edit 2 --in 2h call mom at 5', '--exit-zero'], { serverUrl: server.url, loggedIn: true });
    expect(r.stdout).toContain('Edited [aaaa1111] call mom at 5');
    const body = server.last('PATCH', `/reminders/${ID1}`)?.body as { text: string; due_at: string };
    expect(body.text).toBe('call mom at 5');
    expect(Date.parse(body.due_at) - NOW.getTime()).toBe(2 * 3600_000);
    expect(acct.reminders.get(ID1)?.state).toBe('scheduled');
  });

  it('an id prefix finds a scheduled reminder and reschedules it', async () => {
    const acct = setup();
    const r = await run(['edit', '3000cc', '--in', '4h']);
    expect(r.code).toBe(0);
    expect(server.last('GET', '/reminders')?.query.get('scope')).toBe('all');
    const body = server.last('PATCH', `/reminders/${ID3}`)?.body as { due_at: string; text?: string; expected_version: number };
    expect(body.text).toBeUndefined();
    expect(body.expected_version).toBe(7);
    expect(Date.parse(body.due_at) - NOW.getTime()).toBe(4 * 3600_000);
    expect(acct.reminders.get(ID3)?.due_at).toBe(body.due_at);
  });

  it('with --all a number uses the `mokkan list --all` numbering', async () => {
    setup();
    const r = await run(['edit', '1', '--all', '--clear-due']);
    expect(r.code).toBe(0);
    expect(server.last('GET', '/reminders')?.query.get('scope')).toBe('all');
    expect(server.last('PATCH', `/reminders/${ID3}`)?.body).toEqual({ due_at: null, expected_version: 7 });
  });

  it('1-3 digits are only ever a list number: out of range is an error, never an id prefix', async () => {
    setup();
    const r = await run(['edit', '3', 'x']); // ID3 starts with "3", but `mokkan list` has only 2 rows
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no reminder number 3 in `mokkan list`');
    expect(patches()).toHaveLength(0);
    const r2 = await run(['edit', '300', 'x']);
    expect(r2.code).toBe(1);
    expect(patches()).toHaveLength(0);
  });

  it('4 or more digits are an id prefix', async () => {
    setup();
    const r = await run(['edit', '3000', 'renamed']);
    expect(r.code).toBe(0);
    expect(server.last('PATCH', `/reminders/${ID3}`)?.body).toMatchObject({ text: 'renamed' });
  });

  it('sets due_at from --at (ISO with a zone) and clears it with --clear-due', async () => {
    setup();
    await run(['edit', '1', '--at', '2030-01-02T03:04:05Z']);
    expect((server.last('PATCH', `/reminders/${ID2}`)?.body as { due_at: string }).due_at).toBe('2030-01-02T03:04:05.000Z');
    await run(['edit', '3000', '--at', '2030-01-02T05:04:05+02:00']);
    expect((server.last('PATCH', `/reminders/${ID3}`)?.body as { due_at: string }).due_at).toBe('2030-01-02T03:04:05.000Z');
    await run(['edit', 'bbbb', '--clear-due']); // now scheduled, so no longer number 1 in `mokkan list`
    expect((server.last('PATCH', `/reminders/${ID2}`)?.body as { due_at: null }).due_at).toBeNull();
  });

  it('combines text and time in one PATCH', async () => {
    setup();
    await run(['edit', '1', '--in', '10m', 'x']);
    expect(server.count('PATCH', `/reminders/${ID2}`)).toBe(1);
    expect(server.last('PATCH', `/reminders/${ID2}`)?.body).toMatchObject({ text: 'x' });
  });

  it('--json prints the response', async () => {
    setup();
    const r = await run(['edit', '1', 'j', '--json']);
    expect(JSON.parse(r.stdout).reminder.text).toBe('j');
  });

  it.each([
    [['edit'], 'Usage'],
    [['edit', '1'], 'nothing to change'],
    [['edit', '1', '--in', '2h', '--at', '2030-01-01T00:00:00Z'], 'either'],
    [['edit', '1', '--in', '2h', '--clear-due'], 'either'],
    [['edit', '1', '--at', '2030-01-01T00:00:00Z', '--clear-due'], 'either'],
    [['edit', '1', '--in', 'soon'], 'Invalid duration'],
    [['edit', '1', '--at', 'nonsense'], 'Invalid --at'],
    [['edit', '1', '--at', '5'], 'Invalid --at'],
    [['edit', '1', '--at', '2026-10-01T09:00:00'], 'Invalid --at'],
    [['edit', '1', '--at', 'Oct 1 2026 9:00 GMT'], 'Invalid --at'],
    [['edit', '1', '--text', '   '], 'empty'],
    [['edit', '1', '--in', '2h', '--text'], '--text needs a value'],
    [['edit', '1', 'x', '--in'], '--in needs a value'],
    [['edit', '9', 'x'], 'no reminder number 9'],
    [['edit', '4', '--all', 'x'], 'no reminder number 4 in `mokkan list --all`'],
    [['edit', 'zzzz', 'x'], 'No reminder matches "zzzz"'],
  ])('rejects %j', async (argv, msg) => {
    setup();
    const r = await run(argv);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(msg);
    expect(patches()).toHaveLength(0);
  });

  describe('409 stale', () => {
    it('retries once with the fresh version when the number still points at the same reminder', async () => {
      const acct = setup();
      let calls = 0;
      acct.afterList = () => { if (calls++ === 0) acct.version += 1; }; // someone acked something meanwhile
      const r = await run(['edit', '1', 'x']);
      expect(r.code).toBe(0);
      expect(patches().map((p) => p.body)).toEqual([
        { text: 'x', expected_version: 7 },
        { text: 'x', expected_version: 8 },
      ]);
      expect(acct.reminders.get(ID2)?.text).toBe('x');
    });

    it('stops when the list number now points at a different reminder', async () => {
      const acct = setup();
      let calls = 0;
      acct.afterList = () => {
        if (calls++ > 0) return;
        acct.reminders.set(IDNEW, rem(IDNEW, 'pushed meanwhile', 10));
        acct.version += 1;
      };
      const r = await run(['edit', '1', 'x']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('The list changed; run mokkan list and try again.');
      expect(patches()).toHaveLength(1);
      expect(acct.reminders.get(ID2)?.text).toBe('second');
      expect(acct.reminders.get(IDNEW)?.text).toBe('pushed meanwhile');
    });

    it('an id target keeps its id across the retry', async () => {
      const acct = setup();
      let calls = 0;
      acct.afterList = () => {
        if (calls++ > 0) return;
        acct.reminders.set(IDNEW, rem(IDNEW, 'pushed meanwhile', 10));
        acct.version += 1;
      };
      const r = await run(['edit', 'bbbb', 'x']);
      expect(r.code).toBe(0);
      expect(patches().map((p) => p.path)).toEqual([`/reminders/${ID2}`, `/reminders/${ID2}`]);
      expect(acct.reminders.get(ID2)?.text).toBe('x');
    });

    it('a second stale is reported, not retried again', async () => {
      const acct = setup();
      acct.afterList = () => { acct.version += 1; };
      const r = await run(['edit', 'bbbb', 'x']);
      expect(r.code).toBe(1);
      expect(patches()).toHaveLength(2);
    });
  });

  it('409 not_editable: the time of a delivered reminder cannot change, its text can', async () => {
    const acct = setup();
    acct.reminders.get(ID1)!.state = 'delivered';
    const r = await run(['edit', '2', '--in', '1h']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('already shown or emailed');
    expect((await run(['edit', '2', 'still editable'])).code).toBe(0);
    expect(acct.reminders.get(ID1)?.text).toBe('still editable');
  });

  it('409 not_editable once the email has been sent', async () => {
    const acct = setup();
    acct.reminders.get(ID3)!.email_sent_at = '2026-09-28T11:00:00.000Z';
    const r = await run(['edit', '3000', '--clear-due']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('already shown or emailed');
  });

  it('exits 3 on 402 with the server message', async () => {
    const acct = setup(0);
    acct.editCount = 2;
    const r = await run(['edit', '1', 'x']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('mokkan buy');
  });
});

describe('fake PATCH /reminders/:id follows the contract', () => {
  let server: FakeServer;
  beforeEach(async () => { await (server = new FakeServer()).start(); });
  afterEach(async () => { await server.stop(); });
  const client = () => new MokkanClient({
    baseUrl: server.url,
    credentials: {
      server_url: server.url, email: 'a@example.com', access_token: 'access-0', access_expires_at: '2099-01-01T00:00:00.000Z',
      refresh_token: 'refresh-0', refresh_expires_at: '2099-02-01T00:00:00.000Z',
    },
  });

  it('404 for done and unknown reminders, 400 for blank or too long text, 409 stale for a wrong version', async () => {
    const acct = server.withAccount();
    acct.reminders.set(ID1, rem(ID1, 'gone', 1, { state: 'done' }));
    acct.reminders.set(ID2, rem(ID2, 'here', 2));
    await expect(client().editReminder(ID1, { text: 'x' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(client().editReminder(IDNEW, { text: 'x' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(client().editReminder(ID2, { text: '   ' })).rejects.toMatchObject({ status: 400, code: 'validation' });
    await expect(client().editReminder(ID2, { text: 'x'.repeat(2001) })).rejects.toMatchObject({ status: 400 });
    await expect(client().editReminder(ID2, { text: 'x' }, acct.version + 5)).rejects.toMatchObject({ status: 409, code: 'stale' });
    await client().editReminder(ID2, { text: '  trimmed  ' }, acct.version);
    expect(acct.reminders.get(ID2)?.text).toBe('trimmed');
  });

  it('GET /reminders is scope-aware', async () => {
    const acct = server.withAccount();
    acct.reminders.set(ID1, rem(ID1, 'due', 1));
    acct.reminders.set(ID2, rem(ID2, 'sched', 2, { state: 'scheduled' }));
    acct.reminders.set(ID3, rem(ID3, 'done', 3, { state: 'done' }));
    const ids = async (scope: 'active' | 'all' | 'done') => (await client().list(scope)).reminders.map((r) => r.id);
    expect(await ids('active')).toEqual([ID1]);
    expect(await ids('all')).toEqual([ID2, ID1]);
    expect(await ids('done')).toEqual([ID3]);
  });
});
