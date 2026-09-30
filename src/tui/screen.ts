import { cleanText, creditSegments, formatAge, formatWhen, DEFAULT_GRACE_MINUTES, type Tone } from '../statusline.js';
import type { Reminder } from '../types.js';
import { ACTIVE_STATES, rowsOf, type Size, type Tab, type TuiState } from './state.js';
import { displayWidth, fit, padEnd, padStart } from './text.js';

export type { Size };

const MIN_COLUMNS = 20;
const MIN_ROWS = 8;
/** Header, tabs, rule, message and two footer lines. */
const CHROME_ROWS = 6;
/** Below this many columns for the text, a row drops its time column. */
const MIN_TEXT_COLUMNS = 10;
/** Width of the row prefix: marker, number, state. */
const ROW_PREFIX_COLUMNS = 1 + 3 + 2 + 12 + 1;
const GRACE_MS = DEFAULT_GRACE_MINUTES * 60_000;
/** ` Email     › ` and ` Password  › ` are this wide. */
export const LOGIN_FIELD_COLUMN = 13;

type Style = Tone | 'bold' | 'reverse';
const SGR: Record<Style, string> = { red: '31', yellow: '33', green: '32', dim: '2', plain: '', bold: '1', reverse: '7' };

export function paint(text: string, ...styles: Style[]): string {
  const codes = styles.map((s) => SGR[s]).filter((c) => c !== '');
  return codes.length === 0 || text === '' ? text : `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

interface Part { text: string; styles: Style[] }
const part = (text: string, ...styles: Style[]): Part => ({ text, styles });
const partsWidth = (parts: Part[]): number => parts.reduce((n, p) => n + displayWidth(p.text), 0);
/** Strips control characters from anything that came from the server. */
const clean = (text: string): string => cleanText(text, Number.MAX_SAFE_INTEGER);

function cut(parts: Part[], columns: number): Part[] {
  const out: Part[] = [];
  let left = columns;
  for (const p of parts) {
    const w = displayWidth(p.text);
    if (w <= left) { out.push(p); left -= w; continue; }
    if (left > 0) out.push({ text: fit(p.text, left), styles: p.styles });
    break;
  }
  return out;
}

const paintParts = (parts: Part[], extra: Style[]): string => parts.map((p) => paint(p.text, ...p.styles, ...extra)).join('');

/**
 * One line of exactly `columns` columns: `left`, padding, `right`. The left side is shortened first; the right
 * side is dropped when keeping it would leave the left fewer than `minLeft` columns.
 */
function line(left: Part[], right: Part[], columns: number, opts: { minLeft?: number; rowStyle?: Style } = {}): string {
  const rw = partsWidth(right);
  const keepRight = rw > 0 && columns - 1 - rw >= (opts.minLeft ?? 8);
  const l = cut(left, keepRight ? columns - 1 - rw : columns);
  const r = keepRight ? right : [];
  const gap = ' '.repeat(Math.max(0, columns - partsWidth(l) - partsWidth(r)));
  const extra: Style[] = opts.rowStyle ? [opts.rowStyle] : [];
  return paintParts(l, extra) + (opts.rowStyle ? paint(gap, opts.rowStyle) : gap) + paintParts(r, extra);
}

/** The part of a one-line buffer that fits `width` columns with the cursor visible, and the cursor's column in it. */
export function inputWindow(buffer: string, cursor: number, width: number): { text: string; cursorColumn: number } {
  const chars = [...buffer];
  const w = (from: number, to: number): number => displayWidth(chars.slice(from, to).join(''));
  let start = 0;
  while (start < cursor && w(start, cursor) >= width) start++;
  let end = cursor;
  while (end < chars.length && w(start, end + 1) <= width) end++;
  return { text: chars.slice(start, end).join(''), cursorColumn: w(start, cursor) };
}

export function render(state: TuiState, size: Size, now: Date): string[] {
  const { columns, rows } = size;
  let lines: string[];
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    lines = [fit('mokkan ui: terminal too small', columns)];
  } else if (state.screen === 'login') {
    lines = loginLines(state, size);
  } else {
    lines = dashboardLines(state, size, now);
  }
  while (lines.length < rows) lines.push('');
  return lines.slice(0, rows).map((l) => `${l}\x1b[0m`);
}

/** Where the terminal cursor goes (1-based), or null to keep it hidden. */
export function cursorPosition(state: TuiState, size: Size): { row: number; column: number } | null {
  if (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS) return null;
  if (state.screen === 'login') {
    const l = state.login;
    const value = l.field === 'email' ? l.email : '•'.repeat([...l.password].length);
    const { cursorColumn } = inputWindow(value, l.cursor, size.columns - LOGIN_FIELD_COLUMN);
    return { row: l.field === 'email' ? 5 : 6, column: LOGIN_FIELD_COLUMN + cursorColumn + 1 };
  }
  if (state.mode.kind !== 'input') return null;
  const labelWidth = displayWidth(` ${state.mode.label} › `);
  const { cursorColumn } = inputWindow(state.mode.buffer, state.mode.cursor, size.columns - labelWidth);
  return { row: size.rows - 1, column: labelWidth + cursorColumn + 1 };
}

// ---- dashboard ----

function dashboardLines(state: TuiState, size: Size, now: Date): string[] {
  const { columns, rows } = size;
  const out: string[] = [header(state, columns, now), tabs(state, columns), '─'.repeat(columns)];
  const listRows = rows - CHROME_ROWS;
  const items = rowsOf(state);
  if (items.length === 0) {
    const empty = state.tab === 'done' ? 'Nothing done yet.' : 'No reminders. Press p to push one.';
    out.push(line([part(` ${empty}`, 'dim')], [], columns));
    for (let i = 1; i < listRows; i++) out.push('');
  } else {
    for (let i = 0; i < listRows; i++) {
      const idx = state.scroll + i;
      out.push(idx < items.length ? row(items[idx], idx, idx === state.selected, columns, now) : '');
    }
  }
  out.push(state.message ? line([part(` ${clean(state.message.text)}`, state.message.tone)], [], columns) : '');
  out.push(...footer(state, columns));
  return out;
}

function header(state: TuiState, columns: number, now: Date): string {
  const left: Part[] = [part(' mokkan', 'bold'), part(` · ${state.email}`)];
  for (const seg of creditSegments(state.credits)) left.push(part(seg.text, seg.tone));
  left.push(part(` · ${state.host}`));
  return line(left, [status(state, now)], columns);
}

function status(state: TuiState, now: Date): Part {
  const age = state.fetchedAt ? formatAge(now.getTime() - state.fetchedAt.getTime()) : null;
  if (state.refreshing) return part('refreshing…', 'dim');
  if (state.error) {
    const what = state.error.kind === 'offline' ? 'offline' : `error: ${clean(state.error.message)}`;
    return part(age ? `${what} · data ${age} old` : what, 'red');
  }
  return part(age ? `refreshed ${age} ago` : 'loading…', 'dim');
}

function tabs(state: TuiState, columns: number): string {
  const active = state.reminders.filter((r) => ACTIVE_STATES.has(r.state)).length;
  const labels: [Tab, string][] = [
    ['active', `Active ${active}`], ['all', `All ${state.reminders.length}`], ['done', state.done ? `Done ${state.done.length}` : 'Done'],
  ];
  const parts: Part[] = [part(' ')];
  labels.forEach(([tab, label], i) => {
    if (i > 0) parts.push(part(' │ ', 'dim'));
    parts.push(part(label, tab === state.tab ? 'bold' : 'dim'));
  });
  return line(parts, [], columns);
}

/** The time column and the tone of the state column for one reminder. */
function timing(r: Reminder, now: Date): { when: string; tone: Tone } {
  const t = now.getTime();
  const due = r.due_at ? Date.parse(r.due_at) : NaN;
  const isDue = r.state === 'due' || (r.state === 'scheduled' && due <= t);
  if (isDue) {
    if (Number.isNaN(due)) return { when: '', tone: 'yellow' };
    if (t - due > GRACE_MS) return { when: `overdue ${formatAge(t - due)}`, tone: 'red' };
    return { when: `due ${formatWhen(new Date(due), now)}`, tone: 'yellow' };
  }
  if (r.state === 'scheduled') return { when: `@ ${formatWhen(new Date(due), now)}`, tone: 'dim' };
  if (r.state === 'done') return { when: r.done_at ? `done ${formatWhen(new Date(r.done_at), now)}` : '', tone: 'dim' };
  const when = Number.isNaN(due) ? '' : `due ${formatWhen(new Date(due), now)}`;
  return { when, tone: r.state === 'delivered' ? 'plain' : 'dim' };
}

function row(r: Reminder, index: number, selected: boolean, columns: number, now: Date): string {
  const { when, tone } = timing(r, now);
  const left = [
    part(`${selected ? '▸' : ' '}${padStart(String(index + 1), 3)}  `),
    part(padEnd(r.state, 12), tone),
    part(` ${clean(r.text)}`),
  ];
  const right = when === '' ? [] : [part(when, tone)];
  return line(left, right, columns, { minLeft: ROW_PREFIX_COLUMNS + MIN_TEXT_COLUMNS, rowStyle: selected ? 'reverse' : undefined });
}

function footer(state: TuiState, columns: number): string[] {
  const m = state.mode;
  if (m.kind === 'input') {
    const label = ` ${m.label} › `;
    const { text } = inputWindow(m.buffer, m.cursor, columns - displayWidth(label));
    return [line([part(label, 'bold'), part(text)], [], columns), line([part(` ${m.hint}`, 'dim')], [], columns)];
  }
  if (m.kind === 'confirm') return [line([part(` ${clean(m.prompt)}`, 'yellow')], [], columns), ''];
  return [
    line([part(' p push · i schedule · e edit · t time · a ack · A ack all', 'dim')], [], columns),
    line([part(' x pop · d dequeue · b buy · Tab view · r refresh · q quit · ↑↓ move', 'dim')], [], columns),
  ];
}

// ---- login ----

function loginLines(state: TuiState, size: Size): string[] {
  const { columns } = size;
  const l = state.login;
  const field = (label: string, value: string, active: boolean): string => {
    const { text } = inputWindow(value, active ? l.cursor : [...value].length, columns - LOGIN_FIELD_COLUMN);
    return line([part(` ${padEnd(label, 9)} › `, active ? 'bold' : 'dim'), part(text)], [], columns);
  };
  return [
    line([part(' mokkan', 'bold'), part(` · ${state.host}`)], [part('not logged in', 'dim')], columns),
    '',
    line([part(' Log in', 'bold')], [], columns),
    '',
    field('Email', l.email, l.field === 'email'),
    field('Password', '•'.repeat([...l.password].length), l.field === 'password'),
    '',
    l.error ? line([part(` ${l.error.text}`, l.error.tone)], [], columns) : '',
    '',
    line([part(' Enter next field / log in · Tab switch field · Esc quit', 'dim')], [], columns),
    line([part(' No account? Quit and run: mokkan register you@example.com', 'dim')], [], columns),
  ];
}
