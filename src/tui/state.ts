import type { Tone } from '../text.js';
import type { Reminder } from '../types.js';

export type { Tone };
/** `stack`: every open reminder (`list('all')`); `done`: the finished ones. */
export type Tab = 'stack' | 'done';
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

export interface TuiState {
  screen: 'login' | 'dashboard';
  login: LoginState;
  tab: Tab;
  /** Every non-done reminder, top of stack first (`list('all')`): the stack view. */
  reminders: Reminder[];
  /** `list('done')`, loaded on the first visit to the done view and kept fresh after it. */
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

/** Longest text an input line or login field accepts, in code points (the server's limit for reminder text). */
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
    tab: 'stack', reminders: [], done: null, version: null, selected: 0, scroll: 0,
    email: email ?? '', host, credits: null,
    fetchedAt: null, refreshing: false, error: null, message: null, mode: { kind: 'normal' },
  };
}

/** The rows of the current view, numbered as `mokkan list --all` / `mokkan done` number them. */
export function rowsOf(state: TuiState): Reminder[] {
  return state.tab === 'done' ? state.done ?? [] : state.reminders;
}
