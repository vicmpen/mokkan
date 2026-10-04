import type { Tone } from '../text.js';
import type { Reminder } from '../types.js';

export type { Tone };
/** `todos` and `reminders`: the open ones (`list('all')`) without and with a due time; `archived`: the finished ones. */
export type Tab = 'todos' | 'reminders' | 'archived';
/** The tabs in `v` order, with their labels. */
export const TABS: readonly (readonly [Tab, string])[] = [['todos', 'TODOs'], ['reminders', 'Reminders'], ['archived', 'Archived']];
export const tabLabel = (tab: Tab): string => TABS.find(([t]) => t === tab)![1];
/** The tab `v` goes to next. */
export const nextTab = (tab: Tab): Tab => TABS[(TABS.findIndex(([t]) => t === tab) + 1) % TABS.length][0];
export interface Size { columns: number; rows: number }

export type InputPurpose = 'push' | 'in' | 'edit' | 'time';
export interface InputMode {
  kind: 'input';
  purpose: InputPurpose;
  /** Shown before ` › `, e.g. `push` or `edit [bbbb2222]`. */
  label: string;
  hint: string;
  buffer: string;
  /** Cursor position in code points. */
  cursor: number;
  targetId?: string;
  originalText?: string;
  /** For edit and time: the list version when the input opened, sent as expected_version. */
  version?: number | null;
}
/**
 * `text`: the reminder's text as the server sent it (the renderer cleans and shortens it). `version`: the list
 * version when the prompt opened, sent as expected_version. `targetId`: for done and undone, the reminder they change.
 */
export interface ConfirmMode { kind: 'confirm'; action: 'pop' | 'dequeue' | 'done' | 'undone'; text: string; version: number | null; targetId?: string }
export type Mode = { kind: 'normal' } | InputMode | ConfirmMode;

export interface LoginState {
  field: 'email' | 'password';
  email: string;
  password: string;
  cursor: number;
  busy: boolean;
  error: { text: string; tone: Tone } | null;
}

/**
 * The acceptance view, shown when the server answers 403 privacy_not_accepted. `version` and `url` come from the 403
 * until GET /privacy answers; `summary` is null until then.
 */
export interface PrivacyState { version: string | null; url: string; summary: string[] | null }

export interface TuiState {
  screen: 'login' | 'dashboard' | 'privacy';
  login: LoginState;
  /** Set while `screen` is `privacy`. */
  privacy: PrivacyState | null;
  tab: Tab;
  /** Every non-done reminder, top of stack first (`list('all')`): the todos and reminders views. */
  reminders: Reminder[];
  /** `list('done')`, loaded on the first visit to the archived view and kept fresh after it. */
  done: Reminder[] | null;
  version: number | null;
  /** Index into the current view's rows. */
  selected: number;
  /** First visible row. */
  scroll: number;
  /** '' before login. */
  email: string;
  host: string;
  credits: number | null;
  fetchedAt: Date | null;
  refreshing: boolean;
  error: { kind: 'offline' | 'error'; message: string } | null;
  message: { text: string; tone: Tone } | null;
  mode: Mode;
}

/** Screen rows that are not list rows: header, tabs, rule, the selected row's detail, message and two footer lines. */
export const CHROME_ROWS = 7;

/** Longest text an input line or login field accepts, in code points (reminder text itself is capped at `MAX_TEXT`). */
export const MAX_INPUT_CODE_POINTS = 2000;

/** The states `mokkan list` shows, which pop and dequeue take from; the stack view adds `scheduled`. */
export const ACTIVE_STATES: ReadonlySet<string> = new Set(['due', 'delivered', 'acknowledged']);

export function emptyLogin(): LoginState {
  return { field: 'email', email: '', password: '', cursor: 0, busy: false, error: null };
}

export function initialState(email: string | null, host: string): TuiState {
  return {
    screen: email === null ? 'login' : 'dashboard',
    login: emptyLogin(),
    privacy: null,
    tab: 'todos', reminders: [], done: null, version: null, selected: 0, scroll: 0,
    email: email ?? '', host, credits: null,
    fetchedAt: null, refreshing: false, error: null, message: null, mode: { kind: 'normal' },
  };
}

/** Whether an open reminder belongs on `tab`: a todo has no due time, a reminder has one. */
export const inTab = (r: Reminder, tab: Tab): boolean => tab !== 'archived' && (r.due_at === null) === (tab === 'todos');

/** The rows of the current view, in `mokkan list --all` / `mokkan done` order. */
export function rowsOf(state: TuiState): Reminder[] {
  return state.tab === 'archived' ? state.done ?? [] : state.reminders.filter((r) => inTab(r, state.tab));
}
