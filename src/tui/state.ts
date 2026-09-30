import type { Tone } from '../statusline.js';
import type { Reminder } from '../types.js';

export type { Tone };
export type Tab = 'active' | 'all' | 'done';
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
/** `version`: the list version when the prompt opened, sent as expected_version. */
export interface ConfirmMode { kind: 'confirm'; action: 'pop' | 'dequeue'; prompt: string; version: number | null }
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
  /** Every non-done reminder, top of stack first (`list('all')`). */
  reminders: Reminder[];
  /** `list('done')`, loaded on the first visit to the Done tab. */
  done: Reminder[] | null;
  version: number | null;
  /** Index into the current tab's rows. */
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

/** The states `mokkan list` shows; `all` adds `scheduled`. */
export const ACTIVE_STATES: ReadonlySet<string> = new Set(['due', 'delivered', 'acknowledged']);

export function emptyLogin(): LoginState {
  return { field: 'email', email: '', password: '', cursor: 0, busy: false, error: null };
}

export function initialState(email: string | null, host: string): TuiState {
  return {
    screen: email === null ? 'login' : 'dashboard',
    login: emptyLogin(),
    tab: 'active', reminders: [], done: null, version: null, selected: 0, scroll: 0,
    email: email ?? '', host, credits: null,
    fetchedAt: null, refreshing: false, error: null, message: null, mode: { kind: 'normal' },
  };
}

/** The rows of the current tab, numbered as the matching CLI command numbers them. */
export function rowsOf(state: TuiState): Reminder[] {
  if (state.tab === 'done') return state.done ?? [];
  if (state.tab === 'all') return state.reminders;
  return state.reminders.filter((r) => ACTIVE_STATES.has(r.state));
}
