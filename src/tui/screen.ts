import { cleanText, formatAge, type Tone } from '../text.js';
import type { Reminder } from '../types.js';
import { CHROME_ROWS, TABS, inTab, nextTab, rowsOf, tabLabel, type Size, type TuiState } from './state.js';
import { displayWidth, fit, graphemeWidth, graphemes, padEnd, padStart, wrap } from './text.js';

export type { Size };

const MIN_COLUMNS = 20;
const MIN_ROWS = 8;
/** Below this many columns for the text, a row drops its time column. */
const MIN_TEXT_COLUMNS = 10;
/** A row's time column is separated from its text by at least this many columns. */
const TIME_GAP_COLUMNS = 2;
/** Under this many credits the header warns. */
const LOW_CREDITS = 10;
/** Columns the header keeps for its left side when a long error message is shortened. */
const HEADER_LEFT_MIN = 24;
/** ` Email     › ` and ` Password  › ` are this wide. */
export const LOGIN_FIELD_COLUMN = 13;

type Style = Tone | 'bold';
const SGR: Record<Style, string> = { red: '31', yellow: '33', green: '32', dim: '2', plain: '', bold: '1' };

export function paint(text: string, ...styles: Style[]): string {
  const codes = styles.map((s) => SGR[s]).filter((c) => c !== '');
  return codes.length === 0 || text === '' ? text : `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

interface Part { text: string; styles: Style[] }
const part = (text: string, ...styles: Style[]): Part => ({ text, styles });
const partsWidth = (parts: Part[]): number => parts.reduce((n, p) => n + displayWidth(p.text), 0);
/** Strips control characters from anything that came from the server. */
const clean = (text: string): string => cleanText(text, Number.MAX_SAFE_INTEGER);
/**
 * Replaces each control character with one space, so code-point positions (and the cursor) stay put. Applied to
 * the whole buffer before windowing, so the cursor is placed by the width that is drawn (`\r\n` is one grapheme).
 */
// eslint-disable-next-line no-control-regex
const blankControls = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

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
 * One line of exactly `columns` columns: `left`, padding of at least `minGap` columns, `right`. The left side is
 * shortened first; the right side is dropped when keeping it would leave the left fewer than `minLeft` columns.
 */
function line(left: Part[], right: Part[], columns: number, opts: { minLeft?: number; minGap?: number; rowStyle?: Style } = {}): string {
  const rw = partsWidth(right);
  const reserved = rw + (opts.minGap ?? 1);
  const keepRight = rw > 0 && columns - reserved >= (opts.minLeft ?? 8);
  const l = cut(left, keepRight ? columns - reserved : columns);
  const r = keepRight ? right : [];
  const gap = ' '.repeat(Math.max(0, columns - partsWidth(l) - partsWidth(r)));
  const extra: Style[] = opts.rowStyle ? [opts.rowStyle] : [];
  return paintParts(l, extra) + (opts.rowStyle ? paint(gap, opts.rowStyle) : gap) + paintParts(r, extra);
}

/**
 * The part of a one-line buffer that fits `width` columns with the cursor visible, and the cursor's column in it.
 * Linear in the buffer: grapheme widths are measured once and the window slides over their prefix sums. A cursor
 * inside a grapheme (in code points) stands after it.
 */
export function inputWindow(buffer: string, cursor: number, width: number): { text: string; cursorColumn: number } {
  const gs = graphemes(buffer);
  /** before[i]: columns taken by the graphemes ahead of grapheme i. */
  const before = [0];
  for (const g of gs) before.push(before[before.length - 1] + graphemeWidth(g));
  let at = 0; // the grapheme the cursor stands before
  for (let seen = 0; at < gs.length && seen < cursor; at++) seen += [...gs[at]].length;
  let start = 0;
  while (start < at && before[at] - before[start] >= width) start++;
  let end = at;
  while (end < gs.length && before[end + 1] - before[start] <= width) end++;
  return { text: gs.slice(start, end).join(''), cursorColumn: before[at] - before[start] };
}

/**
 * Everything is drawn one column narrower than the terminal: xterm-family terminals erase a character written in
 * the last column when the next line is cleared, so that column stays blank.
 */
const drawable = (size: Size): Size => ({ columns: size.columns - 1, rows: size.rows });

export function render(state: TuiState, size: Size, now: Date): string[] {
  const { columns, rows } = size;
  let lines: string[];
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    lines = [fit('mokkan ui: terminal too small', columns - 1)];
  } else if (state.screen === 'login') {
    lines = loginLines(state, drawable(size));
  } else {
    lines = dashboardLines(state, drawable(size), now);
  }
  while (lines.length < rows) lines.push('');
  return lines.slice(0, rows).map((l) => `${l}\x1b[0m`);
}

/** Where the terminal cursor goes (1-based), or null to keep it hidden. */
export function cursorPosition(state: TuiState, size: Size): { row: number; column: number } | null {
  if (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS) return null;
  const { columns } = drawable(size);
  if (state.screen === 'login') {
    const l = state.login;
    const value = l.field === 'email' ? l.email : '•'.repeat([...l.password].length);
    const { cursorColumn } = inputWindow(value, l.cursor, columns - LOGIN_FIELD_COLUMN);
    return { row: l.field === 'email' ? 5 : 6, column: LOGIN_FIELD_COLUMN + cursorColumn + 1 };
  }
  if (state.mode.kind !== 'input') return null;
  const labelWidth = displayWidth(` ${clean(state.mode.label)} › `);
  const { cursorColumn } = inputWindow(blankControls(state.mode.buffer), state.mode.cursor, columns - labelWidth);
  return { row: size.rows - 1, column: labelWidth + cursorColumn + 1 };
}

// ---- dashboard ----

function dashboardLines(state: TuiState, size: Size, now: Date): string[] {
  const { columns, rows } = size;
  const out: string[] = [header(state, columns, now), tabs(state, columns), '─'.repeat(columns)];
  const listRows = rows - CHROME_ROWS;
  const items = rowsOf(state);
  const list: string[] = [];
  if (items.length === 0) {
    const empty = state.tab === 'archived' ? ['Nothing archived yet. d archives the selected row.']
      : state.tab === 'todos' ? ['No todos. t adds one.'] : ['No reminders. r schedules one.'];
    for (const text of empty) list.push(line([part(` ${text}`, 'dim')], [], columns));
  } else {
    const numberWidth = String(items.length).length;
    // The selected row's detail line takes the row kept for it in CHROME_ROWS.
    const room = listRows + 1;
    const sel = items[state.selected] ? selectedRow(items[state.selected], state.selected, numberWidth, columns, now, room) : [];
    // The window starts at state.scroll, or lower when the selected row's wrapped text would run past the bottom.
    let start = state.scroll;
    while (start < state.selected && state.selected - start + sel.length > room) start++;
    for (let idx = start; idx < items.length && list.length < room; idx++) {
      list.push(...(idx === state.selected ? sel : [row(items[idx], idx, numberWidth, false, columns, now)]));
    }
    list.splice(room);
  }
  while (list.length < listRows + 1) list.push('');
  out.push(...list);
  const m = state.message;
  out.push(m ? line([part(` ${m.tone === 'red' ? 'error: ' : ''}${clean(m.text)}`, m.tone)], [], columns) : '');
  out.push(...footer(state, columns));
  return out;
}

function header(state: TuiState, columns: number, now: Date): string {
  const left: Part[] = [part(' mokkan', 'bold'), part(` · ${clean(state.email)}`)];
  const c = state.credits;
  if (typeof c === 'number' && Number.isFinite(c)) {
    const credits = ` · ${c} ${Math.abs(c) === 1 ? 'credit' : 'credits'}`;
    left.push(c <= 0 ? part(`${credits} · buy`, 'red') : c < LOW_CREDITS ? part(`${credits} · low`, 'yellow') : part(credits, 'dim'));
  }
  left.push(part(` · ${state.host}`));
  return line(left, [status(state, now, Math.max(8, columns - 2 - HEADER_LEFT_MIN))], columns);
}

/** The header's right side. A long error message is shortened so the whole part fits `maxWidth`. */
function status(state: TuiState, now: Date, maxWidth: number): Part {
  // The clock time of the last good fetch, as the pane shows it.
  const age = state.fetchedAt ? `synced ${state.fetchedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}` : null;
  if (state.refreshing) return part('syncing…', 'dim');
  if (state.error) {
    const suffix = age ? ` · ${age}` : '';
    if (state.error.kind === 'offline') return part(`offline${suffix}`, 'yellow');
    const msg = fit(clean(state.error.message), Math.max(1, maxWidth - displayWidth('error: ') - displayWidth(suffix)));
    return part(`error: ${msg}${suffix}`, 'red');
  }
  return part(age ?? 'loading…', 'dim');
}

function tabs(state: TuiState, columns: number): string {
  const parts: Part[] = [part(' ')];
  TABS.forEach(([tab, label], i) => {
    // The archived count is known once the view has been loaded.
    const count = tab === 'archived' ? state.done?.length : state.reminders.filter((r) => inTab(r, tab)).length;
    if (i > 0) parts.push(part(' │ ', 'dim'));
    parts.push(part(count === undefined ? label : `${label} ${count}`, tab === state.tab ? 'bold' : 'dim'));
  });
  return line(parts, [], columns);
}

/** A todo has no due time (`push`); a reminder has one (`in`, or `t` on a todo). */
const isTodo = (r: Reminder): boolean => r.due_at === null;

/** The glyph: its shape is the kind (□ todo, the rest reminders), its variant and tone the state. */
function glyph(r: Reminder, now: Date): Part {
  if (r.state === 'done') return part('✓', 'dim');
  if (isTodo(r)) return part('□', r.state === 'acknowledged' ? 'dim' : 'plain');
  if (r.state === 'due' || (r.state === 'scheduled' && Date.parse(r.due_at!) <= now.getTime())) return part('●', 'yellow');
  if (r.state === 'scheduled') return part('◷', 'dim');
  if (r.state === 'delivered') return part('○');
  return part('·', 'dim');
}

/** `17:00` today, `Wed 17:00` within a week, `12 Oct` beyond. Local time. */
function formatAhead(at: Date, now: Date): string {
  const time = at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (at.toDateString() === now.toDateString()) return time;
  if (at.getTime() - now.getTime() < 7 * 86400_000) return `${at.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The time column, reminders only. Always says its direction: `in 40m` / `17:00`, `overdue 40m`, `40m ago`. */
function timing(r: Reminder, now: Date): Part | null {
  if (isTodo(r)) return null;
  const due = Date.parse(r.due_at!);
  if (Number.isNaN(due)) return null;
  const t = now.getTime();
  if (due > t) return part(due - t < 3_600_000 ? `in ${formatAge(due - t)}` : formatAhead(new Date(due), now), 'dim');
  if (r.state === 'due' || r.state === 'scheduled') return part(`overdue ${formatAge(t - due)}`, 'red');
  return part(`${formatAge(t - due)} ago`, 'dim');
}

/** `▸ □ 1: `: marker, glyph, number. */
const rowPrefixWidth = (numberWidth: number): number => 4 + numberWidth + 2;

function row(r: Reminder, index: number, numberWidth: number, selected: boolean, columns: number, now: Date, text = clean(r.text)): string {
  const when = timing(r, now);
  const left = [part(`${selected ? '▸' : ' '} `), glyph(r, now), part(` ${padStart(String(index + 1), numberWidth)}: ${text}`)];
  return line(left, when ? [when] : [], columns, {
    minLeft: rowPrefixWidth(numberWidth) + MIN_TEXT_COLUMNS, minGap: TIME_GAP_COLUMNS, rowStyle: selected ? 'bold' : undefined,
  });
}

/**
 * The selected row, at most `max` lines: its whole text wrapped under the text column, bold, then its detail line.
 * Text taller than that is cut with `…` on its last line.
 */
function selectedRow(r: Reminder, index: number, numberWidth: number, columns: number, now: Date, max: number): string[] {
  const prefix = rowPrefixWidth(numberWidth);
  const when = timing(r, now);
  const time = when ? displayWidth(when.text) + TIME_GAP_COLUMNS : 0;
  // The first line keeps the time column on the same terms as `line`.
  const first = columns - prefix - (time > 0 && columns - time >= prefix + MIN_TEXT_COLUMNS ? time : 0);
  const text = wrap(clean(r.text), first, columns - prefix);
  const shown = text.slice(0, max - 1);
  const last = shown.length - 1;
  if (shown.length < text.length) shown[last] = fit(`${shown[last]} ${text[last + 1]}`, last === 0 ? first : columns - prefix);
  return [
    row(r, index, numberWidth, true, columns, now, shown[0]),
    ...shown.slice(1).map((t) => line([part(' '.repeat(prefix)), part(t)], [], columns, { rowStyle: 'bold' })),
    line([part(' '.repeat(prefix)), part(detail(r, now), 'dim')], [], columns),
  ];
}

/** The line under the selected row: `todo · added 3h ago · shown 1h ago · acked 5m ago`, or `archived 2h ago · added 1d ago`. */
function detail(r: Reminder, now: Date): string {
  const ago = (at: string): string => `${formatAge(now.getTime() - Date.parse(at))} ago`;
  const added = `added ${ago(r.created_at)}`;
  if (r.state === 'done') return r.done_at ? `archived ${ago(r.done_at)} · ${added}` : `archived · ${added}`;
  const parts = [isTodo(r) ? 'todo' : 'reminder', added];
  if (r.delivered_at) parts.push(`shown ${ago(r.delivered_at)}`);
  if (r.acknowledged_at) parts.push(`acked ${ago(r.acknowledged_at)}`);
  return parts.join(' · ');
}

function footer(state: TuiState, columns: number): string[] {
  const m = state.mode;
  if (m.kind === 'input') {
    const label = ` ${clean(m.label)} › `;
    const { text } = inputWindow(blankControls(m.buffer), m.cursor, columns - displayWidth(label));
    return [line([part(label, 'bold'), part(text)], [], columns), line([part(` ${m.hint}`, 'dim')], [], columns)];
  }
  if (m.kind === 'confirm') {
    // The reminder is shortened, never the answers; the answers name their outcome.
    const [before, after, yes] = m.action === 'done' ? ['archive ', '', 'archive'] : m.action === 'undone' ? ['reopen ', '', 'reopen'] : ['pop ', '', 'pop'];
    const room = columns - displayWidth(` ${before}""${after}?  y: ${yes}  n: keep`);
    return [line([part(` ${before}"${fit(clean(m.text), room)}"${after}?  y: ${yes}  n: keep`, 'yellow')], [], columns), ''];
  }
  const archived = state.tab === 'archived';
  return [
    line([part(` t todo · r reminder · e edit · w when · d ${archived ? 'reopen' : 'archive'} · a ack · v view ${tabLabel(nextTab(state.tab)).toLowerCase()}`, 'dim')], [], columns),
    line([part(' p pop top · o pop oldest · A ack all · s sync · b buy · ↑↓ 1-9 move · q quit', 'dim')], [], columns),
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
    l.error ? line([part(` ${clean(l.error.text)}`, l.error.tone)], [], columns) : '',
    '',
    line([part(' Enter next field / log in · Tab switch field · Esc quit', 'dim')], [], columns),
    line([part(' No account? Quit and run: mokkan register you@example.com', 'dim')], [], columns),
  ];
}
