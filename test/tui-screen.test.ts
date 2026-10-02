import { describe, it, expect } from 'vitest';
import { cursorPosition, inputWindow, render } from '../src/tui/screen.js';
import { initialState, type TuiState } from '../src/tui/state.js';
import type { Reminder } from '../src/types.js';
import { displayWidth } from '../src/tui/text.js';
import { NOW, reminder } from './cli-harness.js';

const SIZE = { columns: 80, rows: 24 };
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const plain = (lines: string[]) => lines.map(strip);
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

const r1 = reminder({ id: 'f3a9c1d2-0000-0000-0000-000000000000', text: 'check the flaky login test', position: 3, due_at: at(-20 * MIN), created_at: at(-3 * HOUR) });
const r2 = reminder({ id: 'bbbb2222-0000-0000-0000-000000000000', text: 'ask Maria about the release notes', state: 'delivered', position: 2, due_at: at(-40 * MIN), delivered_at: at(-30 * MIN) });
const r3 = reminder({ id: 'cccc3333-0000-0000-0000-000000000000', text: 'buy milk', state: 'acknowledged', position: 1 });

function dashboard(over: Partial<TuiState> = {}): TuiState {
  return {
    ...initialState('a@example.com', 'api.mokkan.dev'),
    reminders: [r1, r2, r3], version: 3, credits: 480, fetchedAt: new Date(NOW.getTime() - 8000),
    message: { text: 'Pushed [f3a9c1d2] check the flaky login test', tone: 'green' },
    ...over,
  };
}

describe('render: dashboard', () => {
  it('draws the frame from the spec', () => {
    const raw = render(dashboard(), SIZE, NOW);
    const lines = plain(raw);
    expect(raw).toHaveLength(24);
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(79); // the last column stays blank
    for (const l of raw) expect(l.endsWith('\x1b[0m')).toBe(true);
    expect(lines[0].startsWith(' mokkan · a@example.com · 480 credits · api.mokkan.dev')).toBe(true);
    expect(lines[0].endsWith('synced 8s')).toBe(true);
    expect(displayWidth(lines[0])).toBe(79);
    expect(lines[1].trimEnd()).toBe(' Stack 3 │ Done');
    expect(lines[2]).toBe('─'.repeat(79));
    expect(displayWidth(lines[3])).toBe(79);
    expect(lines[3].startsWith('▸ ● 1: check the flaky login test')).toBe(true);
    expect(lines[3].endsWith('overdue 20m')).toBe(true);
    expect(raw[3]).toMatch(/\x1b\[33;1m●/); // a due timed reminder: yellow
    expect(raw[3]).toMatch(/\x1b\[31;1moverdue 20m/); // red, and selected: bold, no background
    expect(lines[4].trimEnd()).toBe('       reminder · pushed 3h ago'); // the selected row's detail, under its text
    expect(raw[4]).toContain('\x1b[2mreminder · pushed 3h ago');
    expect(lines[5].startsWith('  ○ 2: ask Maria about the release notes')).toBe(true);
    expect(lines[5].endsWith('40m ago')).toBe(true);
    expect(lines[6].trimEnd()).toBe('  □ 3: buy milk'); // a todo: no time column
    expect(lines.slice(7, 21).every((l) => l === '')).toBe(true);
    expect(lines[21].trimEnd()).toBe(' Pushed [f3a9c1d2] check the flaky login test');
    expect(lines[22].trimEnd()).toBe(' p todo · i remind · e edit · t time · a done · k ack · s view');
    expect(lines[23].trimEnd()).toBe(' x pop · d dequeue · K ack all · r refresh · b buy · q quit · ↑↓ 1-9 move');
    expect(cursorPosition(dashboard(), SIZE)).toBeNull();
  });

  it('shows header states: syncing, offline with data age, credits, low and none, loading', () => {
    expect(strip(render(dashboard({ refreshing: true }), SIZE, NOW)[0]).endsWith('syncing…')).toBe(true);
    const offline = render(dashboard({ error: { kind: 'offline', message: 'x' }, fetchedAt: new Date(NOW.getTime() - 180_000) }), SIZE, NOW);
    expect(strip(offline[0]).endsWith('offline · 3m old')).toBe(true);
    expect(offline[0]).toContain('\x1b[33moffline'); // yellow
    const low = render(dashboard({ credits: 7 }), SIZE, NOW)[0];
    expect(strip(low)).toContain(' · 7 credits · low · api.mokkan.dev');
    expect(low).toContain('\x1b[33m · 7 credits · low');
    const none = render(dashboard({ credits: 0 }), SIZE, NOW)[0];
    expect(strip(none)).toContain(' · 0 credits · buy · api.mokkan.dev');
    expect(none).toContain('\x1b[31m · 0 credits · buy');
    expect(render(dashboard({ credits: 42 }), SIZE, NOW)[0]).toContain('\x1b[2m · 42 credits');
    expect(strip(render(dashboard({ credits: null, fetchedAt: null }), SIZE, NOW)[0]).endsWith('loading…')).toBe(true);
    expect(strip(render(dashboard({ credits: null, fetchedAt: null }), SIZE, NOW)[0])).toContain(' mokkan · a@example.com · api.mokkan.dev');
  });

  it('shortens a long header error so the data age stays visible', () => {
    const raw = render(dashboard({ error: { kind: 'error', message: 'x'.repeat(103) }, fetchedAt: new Date(NOW.getTime() - 45_000) }), SIZE, NOW);
    const header = strip(raw[0]);
    expect(header.startsWith(' mokkan · a@example.com')).toBe(true);
    expect(header).toContain('error: xxx');
    expect(header).toContain('…');
    expect(header.endsWith('· 45s old')).toBe(true);
    expect(displayWidth(header)).toBe(79);
  });

  it('marks the views and counts, and shows the done count once loaded', () => {
    const stack = plain(render(dashboard({ reminders: [reminder({ id: 'd', text: 's', state: 'scheduled', due_at: at(40 * MIN) }), r1] }), SIZE, NOW));
    expect(stack[1].trimEnd()).toBe(' Stack 2 │ Done');
    expect(stack[3].startsWith('▸ ◷ 1: s')).toBe(true);
    expect(stack[3].endsWith('in 40m')).toBe(true);
    const gone = reminder({ id: 'x', text: 'gone', state: 'done', done_at: at(-2 * HOUR), created_at: at(-26 * HOUR) });
    const done = plain(render(dashboard({ tab: 'done', done: [gone] }), SIZE, NOW));
    expect(done[1].trimEnd()).toBe(' Stack 3 │ Done 1');
    expect(done[3].trimEnd()).toBe('▸ ✓ 1: gone');
    expect(done[4].trimEnd()).toBe('       done 2h ago · pushed 1d ago');
  });

  it('tells todos from reminders by glyph and time column; only a due timed reminder is yellow', () => {
    const rows = [
      reminder({ id: 'a', text: 'todo due', state: 'due' }),
      reminder({ id: 'b', text: 'todo seen', state: 'delivered' }),
      reminder({ id: 'c', text: 'todo acked', state: 'acknowledged' }),
      reminder({ id: 'd', text: 'later', state: 'scheduled', due_at: at(40 * MIN) }),
      reminder({ id: 'e', text: 'late', state: 'due', due_at: at(-3 * HOUR) }),
      reminder({ id: 'f', text: 'seen', state: 'delivered', due_at: at(-2 * 86_400_000) }),
      reminder({ id: 'g', text: 'acked', state: 'acknowledged', due_at: at(-40 * MIN) }),
      reminder({ id: 'h', text: 'flip pending', state: 'scheduled', due_at: at(-MIN) }),
    ];
    const raw = render(dashboard({ reminders: rows, selected: 7 }), SIZE, NOW);
    const lines = plain(raw);
    expect(lines.slice(3, 11).map((l) => l.trimEnd().replace(/(\S) {2,}/g, '$1 | '))).toEqual([
      '  □ 1: todo due', '  □ 2: todo seen', '  □ 3: todo acked', '  ◷ 4: later | in 40m',
      '  ● 5: late | overdue 3h', '  ○ 6: seen | 2d ago', '  · 7: acked | 40m ago', '▸ ● 8: flip pending | overdue 1m',
    ]);
    expect(raw.slice(3, 6).join('')).not.toContain('\x1b[33m'); // todos are never yellow
    expect(raw[5]).toContain('\x1b[2m□'); // an acknowledged todo is dim
    expect(raw[6]).toContain('\x1b[2m◷');
    expect(raw[6]).toContain('\x1b[2min 40m');
    expect(raw[7]).toContain('\x1b[33m●');
    expect(raw[7]).toContain('\x1b[31moverdue 3h');
    expect(raw[8]).toContain('\x1b[2m2d ago');
    expect(raw[9]).toContain('\x1b[2m·');
    expect(lines[11].trimEnd()).toBe('       reminder · pushed 0s ago');
  });

  it('formats future times as in 40m, 17:00, Wed 17:00 and 12 Oct, in local time', () => {
    const now = new Date(2026, 8, 28, 9, 0); // Monday 09:00 local
    const times = [new Date(2026, 8, 28, 9, 40), new Date(2026, 8, 28, 17, 0), new Date(2026, 8, 30, 17, 0), new Date(2026, 9, 12, 9, 0)];
    const rows = times.map((t, i) => reminder({ id: `t${i}`, text: `r${i}`, state: 'scheduled', due_at: t.toISOString(), created_at: now.toISOString() }));
    const lines = plain(render(dashboard({ reminders: rows, fetchedAt: now }), SIZE, now));
    expect([lines[3], ...lines.slice(5, 8)].map((l) => l.split(/ {2,}/).pop())).toEqual(['in 40m', '17:00', 'Wed 17:00', '12 Oct']);
  });

  it('shows the detail line for the selected row only: kind, pushed, seen, acked', () => {
    const t = reminder({ id: 't', text: 'renew the TLS cert', state: 'acknowledged', created_at: at(-3 * HOUR), delivered_at: at(-HOUR), acknowledged_at: at(-MIN) });
    const lines = plain(render(dashboard({ reminders: [r1, t], selected: 1 }), SIZE, NOW));
    expect(lines[3].startsWith('  ● 1: check')).toBe(true);
    expect(lines[4].trimEnd()).toBe('▸ □ 2: renew the TLS cert');
    expect(lines[5].trimEnd()).toBe('       todo · pushed 3h ago · seen 1h ago · acked');
    expect(lines[6]).toBe('');
  });

  it('shows empty views', () => {
    expect(plain(render(dashboard({ reminders: [] }), SIZE, NOW))[3].trimEnd()).toBe(' Nothing on the stack. p adds a todo, i a reminder.');
    expect(plain(render(dashboard({ tab: 'done', done: [] }), SIZE, NOW))[3].trimEnd()).toBe(' Nothing finished yet.');
  });

  it('starts error messages with error: in red', () => {
    const raw = render(dashboard({ message: { text: 'Not enough credits.', tone: 'red' } }), SIZE, NOW);
    expect(strip(raw[21]).trimEnd()).toBe(' error: Not enough credits.');
    expect(raw[21]).toContain('\x1b[31m error: Not enough credits.');
    expect(strip(render(dashboard({ message: { text: 'Nothing selected.', tone: 'yellow' } }), SIZE, NOW)[21]).trimEnd()).toBe(' Nothing selected.');
  });

  it('scrolls from state.scroll', () => {
    const many = Array.from({ length: 30 }, (_, i) => reminder({ id: `r${i}`, text: `item ${i + 1}`, position: 30 - i }));
    const lines = plain(render(dashboard({ reminders: many, selected: 25, scroll: 9 }), SIZE, NOW));
    expect(lines[3].startsWith('  □ 10: item 10')).toBe(true);
    expect(lines[18].startsWith('  □ 25: item 25')).toBe(true);
    expect(lines[19].startsWith('▸ □ 26: item 26')).toBe(true); // selected 25, scroll 9: 17 rows and the detail line
    expect(lines[20].trim()).toBe('todo · pushed 0s ago');
    expect(lines[21]).not.toContain('item');
  });

  it('truncates text and drops the time column on narrow terminals', () => {
    const narrow = plain(render(dashboard(), { columns: 40, rows: 24 }, NOW));
    expect(narrow[3]).toContain('…');
    for (const l of narrow) expect(displayWidth(l)).toBeLessThanOrEqual(39);
    const tight = plain(render(dashboard(), { columns: 44, rows: 24 }, NOW));
    expect(tight[3].endsWith('…  overdue 20m')).toBe(true); // at least two columns before the time
    expect(displayWidth(tight[3])).toBe(43);
    const tiny = plain(render(dashboard(), { columns: 28, rows: 24 }, NOW));
    expect(tiny[3]).not.toContain('overdue');
    expect(displayWidth(tiny[3])).toBe(27);
  });

  it('never lets a reminder inject escape codes, and keeps wide text inside the width', () => {
    const evil = reminder({ id: 'e', text: 'evil\x1b[31mred\ntext', state: 'delivered', position: 1 });
    const raw = render(dashboard({ reminders: [r1, evil] }), SIZE, NOW);
    expect(strip(raw[5])).toContain('evil [31mred text'); // the ESC byte became a space, so nothing is interpreted
    expect(raw[5]).not.toContain('\x1b[31m');
    const wide = reminder({ id: 'w', text: '🚀'.repeat(30), position: 1 });
    const lines = plain(render(dashboard({ reminders: [wide] }), { columns: 40, rows: 24 }, NOW));
    expect(displayWidth(lines[3])).toBe(39);
    const ja = reminder({ id: 'j', text: '日本語のテキスト'.repeat(6), position: 1, due_at: at(-20 * MIN) });
    const jaLine = plain(render(dashboard({ reminders: [ja] }), { columns: 40, rows: 24 }, NOW))[3];
    expect(displayWidth(jaLine)).toBe(39);
    expect(jaLine.endsWith('…  overdue 20m') || jaLine.endsWith('… overdue 20m')).toBe(true); // a wide cut may leave one more space
    const odd = reminder({ id: 's', text: 'odd state', state: '\x1b]0;pwned\x07\x1b[2J' as Reminder['state'], position: 1, due_at: at(-MIN) });
    const stateLines = render(dashboard({ reminders: [odd] }), SIZE, NOW).slice(3, 5).join('');
    expect(stateLines.replace(/\x1b\[[\d;]*m/g, '')).not.toContain('\x1b'); // only our own colours
  });

  it('draws the input line with the cursor and the confirm line', () => {
    const input = dashboard({ mode: { kind: 'input', purpose: 'push', label: 'push', hint: 'Enter to push (1 credit) · Esc to cancel', buffer: 'call', cursor: 4 } });
    const lines = plain(render(input, SIZE, NOW));
    expect(lines[22].trimEnd()).toBe(' push › call');
    expect(lines[23].trimEnd()).toBe(' Enter to push (1 credit) · Esc to cancel');
    expect(cursorPosition(input, SIZE)).toEqual({ row: 23, column: 13 });
    const confirm = dashboard({ mode: { kind: 'confirm', action: 'pop', text: 'call the bank', version: 3 } });
    const c = plain(render(confirm, SIZE, NOW));
    expect(c[22].trimEnd()).toBe(' pop "call the bank"?  y: yes  n: no');
    expect(c[23]).toBe('');
  });

  it('shortens the reminder in the confirm prompt so the answers stay visible', () => {
    const long = dashboard({ mode: { kind: 'confirm', action: 'dequeue', text: `${'long '.repeat(30)}\x1b[2J`, version: 3 } });
    const raw = render(long, SIZE, NOW);
    const l = strip(raw[22]);
    expect(l.startsWith(' dequeue "long long')).toBe(true);
    expect(l.endsWith('…"?  y: yes  n: no')).toBe(true);
    expect(displayWidth(l)).toBe(79);
    const narrow = strip(render(dashboard({ mode: { kind: 'confirm', action: 'pop', text: 'x'.repeat(50), version: 3 } }), { columns: 30, rows: 24 }, NOW)[22]);
    expect(narrow).toBe(` pop "${'x'.repeat(5)}…"?  y: yes  n: no`); // 29 drawn columns
    expect(displayWidth(narrow)).toBe(29);
  });

  it('blanks control characters in the input buffer without moving the cursor', () => {
    const state = dashboard({ mode: { kind: 'input', purpose: 'edit', label: 'edit [f3a9c1d2]', hint: '', buffer: 'a\x1bb', cursor: 3 } });
    const raw = render(state, SIZE, NOW);
    expect(strip(raw[22]).trimEnd()).toBe(' edit [f3a9c1d2] › a b');
    expect(raw[22]).not.toContain('\x1b[2');
    expect(cursorPosition(state, SIZE)).toEqual({ row: 23, column: displayWidth(' edit [f3a9c1d2] › ') + 3 + 1 });
    const crlf = dashboard({ mode: { kind: 'input', purpose: 'edit', label: 'edit [f3a9c1d2]', hint: '', buffer: 'a\r\nb', cursor: 4 } });
    expect(plain(render(crlf, SIZE, NOW))[22].trimEnd()).toBe(' edit [f3a9c1d2] › a  b');
    expect(cursorPosition(crlf, SIZE)).toEqual({ row: 23, column: displayWidth(' edit [f3a9c1d2] › ') + 4 + 1 });
  });

  it('shows one line when the terminal is too small', () => {
    expect(plain(render(dashboard(), { columns: 10, rows: 5 }, NOW))).toEqual(['mokkan u…', '', '', '', '']);
    expect(render(dashboard(), { columns: 20, rows: 8 }, NOW)).toHaveLength(8);
    expect(cursorPosition(dashboard({ mode: { kind: 'input', purpose: 'push', label: 'push', hint: '', buffer: '', cursor: 0 } }), { columns: 10, rows: 5 })).toBeNull();
  });
});

describe('render: login screen', () => {
  it('draws the fields, masks the password and places the cursor', () => {
    const state = initialState(null, 'api.mokkan.dev');
    state.login = { field: 'password', email: 'you@example.com', password: 'hunter2', cursor: 7, busy: false, error: { text: 'Wrong email or password.', tone: 'red' } };
    const raw = render(state, SIZE, NOW);
    const lines = plain(raw);
    expect(raw).toHaveLength(24);
    expect(lines[0].startsWith(' mokkan · api.mokkan.dev')).toBe(true);
    expect(lines[0].endsWith('not logged in')).toBe(true);
    expect(displayWidth(lines[0])).toBe(79);
    expect(lines[2].trimEnd()).toBe(' Log in');
    expect(lines[4].trimEnd()).toBe(' Email     › you@example.com');
    expect(lines[5].trimEnd()).toBe(' Password  › •••••••');
    expect(lines[7].trimEnd()).toBe(' Wrong email or password.');
    expect(lines[9].trimEnd()).toBe(' Enter next field / log in · Tab switch field · Esc quit');
    expect(lines[10].trimEnd()).toBe(' No account? Quit and run: mokkan register you@example.com');
    expect(cursorPosition(state, SIZE)).toEqual({ row: 6, column: 21 });
    state.login.field = 'email';
    state.login.cursor = 3;
    expect(cursorPosition(state, SIZE)).toEqual({ row: 5, column: 17 });
  });

  it('cleans the server error shown under the fields', () => {
    const state = initialState(null, 'api.mokkan.dev');
    state.login.error = { text: 'bad\x1b[2Jlogin', tone: 'red' };
    const raw = render(state, SIZE, NOW);
    expect(strip(raw[7])).toContain('bad [2Jlogin');
    expect(raw[7]).not.toContain('\x1b[2J');
  });
});

describe('inputWindow', () => {
  it('keeps the cursor visible in a narrow field', () => {
    expect(inputWindow('abcdefgh', 8, 5)).toEqual({ text: 'efgh', cursorColumn: 4 });
    expect(inputWindow('abcdefgh', 0, 5)).toEqual({ text: 'abcde', cursorColumn: 0 });
    expect(inputWindow('ab', 1, 10)).toEqual({ text: 'ab', cursorColumn: 1 });
  });

  it('windows a 2000-character buffer', () => {
    const long = 'x'.repeat(1000) + '日'.repeat(1000);
    for (const cursor of [0, 999, 1000, 1500, 2000]) {
      const { text, cursorColumn } = inputWindow(long, cursor, 60);
      expect(cursorColumn).toBeLessThanOrEqual(59);
      expect(displayWidth(text)).toBeLessThanOrEqual(60);
    }
    expect(inputWindow(long, 2000, 60)).toEqual({ text: '日'.repeat(29), cursorColumn: 58 });
  });
});
