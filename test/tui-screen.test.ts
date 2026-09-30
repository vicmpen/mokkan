import { describe, it, expect } from 'vitest';
import { formatWhen } from '../src/statusline.js';
import { cursorPosition, inputWindow, render } from '../src/tui/screen.js';
import { initialState, type TuiState } from '../src/tui/state.js';
import { displayWidth } from '../src/tui/text.js';
import { NOW, reminder } from './cli-harness.js';

const SIZE = { columns: 80, rows: 24 };
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const plain = (lines: string[]) => lines.map(strip);
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;

const r1 = reminder({ id: 'f3a9c1d2-0000-0000-0000-000000000000', text: 'check the flaky login test', position: 3, due_at: at(-20 * MIN) });
const r2 = reminder({ id: 'bbbb2222-0000-0000-0000-000000000000', text: 'ask Maria about the release notes', state: 'delivered', position: 2, due_at: at(5 * HOUR) });
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
    for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(80);
    for (const l of raw) expect(l.endsWith('\x1b[0m')).toBe(true);
    expect(lines[0].startsWith(' mokkan · a@example.com · 480 cr · api.mokkan.dev')).toBe(true);
    expect(lines[0].endsWith('refreshed 8s ago')).toBe(true);
    expect(displayWidth(lines[0])).toBe(80);
    expect(lines[1].trimEnd()).toBe(' Active 3 │ All 3 │ Done');
    expect(lines[2]).toBe('─'.repeat(80));
    expect(lines[3].startsWith('▸  1  due          check the flaky login test')).toBe(true);
    expect(lines[3].endsWith('overdue 20m')).toBe(true);
    expect(raw[3]).toMatch(/\x1b\[31[;m]/); // red
    expect(raw[3]).toMatch(/\x1b\[(7|31;7)m/); // selected: reverse video
    expect(lines[4].startsWith('   2  delivered    ask Maria about the release notes')).toBe(true);
    expect(lines[4].endsWith(`due ${formatWhen(new Date(r2.due_at!), NOW)}`)).toBe(true);
    expect(lines[5].trimEnd()).toBe('   3  acknowledged buy milk');
    expect(lines.slice(6, 21).every((l) => l === '')).toBe(true);
    expect(lines[21].trimEnd()).toBe(' Pushed [f3a9c1d2] check the flaky login test');
    expect(lines[22].trimEnd()).toBe(' p push · i schedule · e edit · t time · a ack · A ack all');
    expect(lines[23].trimEnd()).toBe(' x pop · d dequeue · b buy · Tab view · r refresh · q quit · ↑↓ move');
    expect(cursorPosition(dashboard(), SIZE)).toBeNull();
  });

  it('shows header states: refreshing, offline with data age, low credits, loading', () => {
    expect(strip(render(dashboard({ refreshing: true }), SIZE, NOW)[0]).endsWith('refreshing…')).toBe(true);
    const offline = render(dashboard({ error: { kind: 'offline', message: 'x' }, fetchedAt: new Date(NOW.getTime() - 45_000) }), SIZE, NOW);
    expect(strip(offline[0]).endsWith('offline · data 45s old')).toBe(true);
    expect(offline[0]).toContain('\x1b[31m');
    expect(strip(render(dashboard({ credits: 12 }), SIZE, NOW)[0])).toContain(' · ⚠ 12 cr — mokkan buy · api.mokkan.dev');
    expect(strip(render(dashboard({ credits: null, fetchedAt: null }), SIZE, NOW)[0]).endsWith('loading…')).toBe(true);
    expect(strip(render(dashboard({ credits: null, fetchedAt: null }), SIZE, NOW)[0])).toContain(' mokkan · a@example.com · api.mokkan.dev');
  });

  it('shortens a long header error so the data age stays visible', () => {
    const raw = render(dashboard({ error: { kind: 'error', message: 'x'.repeat(103) }, fetchedAt: new Date(NOW.getTime() - 45_000) }), SIZE, NOW);
    const header = strip(raw[0]);
    expect(header.startsWith(' mokkan · a@example.com')).toBe(true);
    expect(header).toContain('error: xxx');
    expect(header).toContain('…');
    expect(header.endsWith('· data 45s old')).toBe(true);
    expect(displayWidth(header)).toBe(80);
  });

  it('marks tabs and counts, and shows the Done count once loaded', () => {
    const all = plain(render(dashboard({ tab: 'all', reminders: [reminder({ id: 'd', text: 's', state: 'scheduled', due_at: at(HOUR) }), r1] }), SIZE, NOW));
    expect(all[1].trimEnd()).toBe(' Active 1 │ All 2 │ Done');
    expect(all[3].startsWith('▸  1  scheduled    s')).toBe(true);
    expect(all[3].endsWith(`@ ${formatWhen(new Date(NOW.getTime() + HOUR), NOW)}`)).toBe(true);
    const done = plain(render(dashboard({ tab: 'done', done: [reminder({ id: 'x', text: 'gone', state: 'done', done_at: at(-HOUR) })] }), SIZE, NOW));
    expect(done[1].trimEnd()).toBe(' Active 3 │ All 3 │ Done 1');
    expect(done[3].startsWith('▸  1  done         gone')).toBe(true);
    expect(done[3].endsWith(`done ${formatWhen(new Date(NOW.getTime() - HOUR), NOW)}`)).toBe(true);
  });

  it('shows empty tabs', () => {
    expect(plain(render(dashboard({ reminders: [] }), SIZE, NOW))[3].trimEnd()).toBe(' No reminders. Press p to push one.');
    expect(plain(render(dashboard({ tab: 'done', done: [] }), SIZE, NOW))[3].trimEnd()).toBe(' Nothing done yet.');
  });

  it('scrolls from state.scroll', () => {
    const many = Array.from({ length: 30 }, (_, i) => reminder({ id: `r${i}`, text: `item ${i + 1}`, position: 30 - i }));
    const lines = plain(render(dashboard({ reminders: many, selected: 25, scroll: 8 }), SIZE, NOW));
    expect(lines[3].startsWith('   9  due          item 9')).toBe(true);
    expect(lines[19].startsWith('  25  due          item 25')).toBe(true);
    expect(lines[20].startsWith('▸ 26  due          item 26')).toBe(true); // selected 25, scroll 8
  });

  it('truncates text and drops the time column on narrow terminals', () => {
    const narrow = plain(render(dashboard(), { columns: 40, rows: 24 }, NOW));
    expect(narrow[3]).toContain('…');
    for (const l of narrow) expect(displayWidth(l)).toBeLessThanOrEqual(40);
    const tight = plain(render(dashboard(), { columns: 56, rows: 24 }, NOW));
    expect(tight[3].endsWith('…  overdue 20m')).toBe(true); // at least two columns before the time
    const tiny = plain(render(dashboard(), { columns: 30, rows: 24 }, NOW));
    expect(tiny[3]).not.toContain('overdue');
    expect(displayWidth(tiny[3])).toBe(30);
  });

  it('never lets a reminder inject escape codes, and keeps wide text inside the width', () => {
    const evil = reminder({ id: 'e', text: 'evil\x1b[31mred\ntext', state: 'delivered', position: 1 });
    const raw = render(dashboard({ reminders: [r1, evil] }), SIZE, NOW);
    expect(strip(raw[4])).toContain('evil [31mred text'); // the ESC byte became a space, so nothing is interpreted
    expect(raw[4]).not.toContain('\x1b[31m');
    const wide = reminder({ id: 'w', text: '🚀'.repeat(30), position: 1 });
    const lines = plain(render(dashboard({ reminders: [wide] }), { columns: 40, rows: 24 }, NOW));
    expect(displayWidth(lines[3])).toBe(40);
  });

  it('draws the input line with the cursor and the confirm line', () => {
    const input = dashboard({ mode: { kind: 'input', purpose: 'push', label: 'push', hint: 'Enter to push (1 credit) · Esc to cancel', buffer: 'call', cursor: 4 } });
    const lines = plain(render(input, SIZE, NOW));
    expect(lines[22].trimEnd()).toBe(' push › call');
    expect(lines[23].trimEnd()).toBe(' Enter to push (1 credit) · Esc to cancel');
    expect(cursorPosition(input, SIZE)).toEqual({ row: 23, column: 13 });
    const confirm = dashboard({ mode: { kind: 'confirm', action: 'pop', prompt: 'Pop "second"? y/n' } });
    const c = plain(render(confirm, SIZE, NOW));
    expect(c[22].trimEnd()).toBe(' Pop "second"? y/n');
    expect(c[23]).toBe('');
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
    expect(plain(render(dashboard(), { columns: 10, rows: 5 }, NOW))).toEqual(['mokkan ui…', '', '', '', '']);
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
});
