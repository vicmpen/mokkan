import { ApiError, NetworkError, PRIVACY_URL, apiErrorHint, type MokkanClient } from '../client.js';
import { EMAIL_RE } from '../commands/auth.js';
import { isTrustedCheckoutUrl } from '../commands/billing.js';
import { parseDuration } from '../duration.js';
import { SessionExpiredError } from '../errors.js';
import { formatRelative, shortId } from '../format.js';
import { EXIT_PRIVACY_REQUIRED, isPrivacyRequired, isPrivacyStale } from '../privacy.js';
import { cleanText } from '../text.js';
import type { CheckoutResponse, Reminder } from '../types.js';
import type { Key } from './keys.js';
import { render as renderScreen } from './screen.js';
import {
  initialState, rowsOf, emptyLogin, inTab, nextTab, tabLabel, ACTIVE_STATES, CHROME_ROWS, MAX_INPUT_CODE_POINTS,
  type ConfirmMode, type InputMode, type InputPurpose, type Size, type Tab, type Tone, type TuiState,
} from './state.js';

export const REFRESH_INTERVAL_MS = 10_000;

export interface TuiAppOptions {
  client: MokkanClient;
  /** null: start on the login screen. */
  email: string | null;
  host: string;
  now: () => Date;
  /** Returns whether a browser was started. */
  openUrl?: (url: string) => boolean;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The server refused a change made against an older list version. */
const isStale = (err: unknown): boolean => err instanceof ApiError && err.status === 409 && err.code === 'stale';

/** A reminder whose time has come and that nobody has acked yet. */
const isDue = (r: Reminder, now: Date): boolean => r.due_at !== null && r.state !== 'acknowledged' && Date.parse(r.due_at) <= now.getTime();

/**
 * Applies an editing key to a one-line buffer (cursor in code points). Returns false for keys it does not handle.
 * The buffer never grows past `MAX_INPUT_CODE_POINTS`: a character or the part of a paste beyond it is dropped.
 */
export function editLine(line: { buffer: string; cursor: number }, key: Key): boolean {
  const chars = [...line.buffer];
  const room = Math.max(0, MAX_INPUT_CODE_POINTS - chars.length);
  switch (key.name) {
    case 'left': line.cursor = Math.max(0, line.cursor - 1); break;
    case 'right': line.cursor = Math.min(chars.length, line.cursor + 1); break;
    case 'home': line.cursor = 0; break;
    case 'end': line.cursor = chars.length; break;
    case 'backspace': if (line.cursor > 0) { chars.splice(line.cursor - 1, 1); line.cursor -= 1; } break;
    case 'delete': chars.splice(line.cursor, 1); break;
    case 'ctrl-u': chars.length = 0; line.cursor = 0; break;
    case 'char': if (room > 0) { chars.splice(line.cursor, 0, key.ch); line.cursor += 1; } break;
    case 'paste': {
      // Only what fits is taken from the paste, one code point at a time, so a huge paste is never split whole.
      const added: string[] = [];
      for (const c of key.text) { if (added.length >= room) break; added.push(c); }
      chars.splice(line.cursor, 0, ...added);
      line.cursor += added.length;
      break;
    }
    default: return false;
  }
  line.buffer = chars.join('');
  return true;
}

/**
 * The dashboard's state machine. Every server call runs through one queue, so a timed refresh can never
 * interleave with a pop. Nothing thrown by the server escapes: it becomes the message line, or the login screen.
 */
export class TuiApp {
  readonly state: TuiState;
  /** Set when the app wants to quit; the driver resolves with it. */
  exitCode: number | null = null;
  /** Set with `d` in the acceptance view: `mokkan ui` leaves the full screen and runs the delete-account flow. */
  deleteRequested = false;
  /** Called after every state change; the driver redraws. */
  onChange: () => void = () => undefined;
  private size: Size = { columns: 80, rows: 24 };
  private queue: Promise<void> = Promise.resolve();
  /** The refresh that is queued or running; asking for another one joins it. */
  private pendingRefresh: Promise<void> | null = null;
  /** Ids already sent to /reminders/deliver, so a slow server never gets them twice. */
  private readonly delivered = new Set<string>();
  /** True until the first list picks the tab, unless a key picked one first; again after a lost session. */
  private landing = true;
  private readonly client: MokkanClient;
  private readonly now: () => Date;
  private readonly openUrl: ((url: string) => boolean) | undefined;

  constructor(opts: TuiAppOptions) {
    this.client = opts.client;
    this.now = opts.now;
    this.openUrl = opts.openUrl;
    this.state = initialState(opts.email, opts.host);
  }

  setSize(size: Size): void {
    this.size = size;
    this.clampSelection();
  }

  rows(): Reminder[] { return rowsOf(this.state); }

  render(size: Size, now: Date): string[] { return renderScreen(this.state, size, now); }

  refresh(): Promise<void> {
    this.pendingRefresh ??= this.enqueue(() => this.doRefresh()).finally(() => { this.pendingRefresh = null; });
    return this.pendingRefresh;
  }

  handleKey(key: Key): Promise<void> {
    const s = this.state;
    if (s.screen === 'login') return this.loginKey(key);
    if (s.screen === 'privacy') return this.privacyKey(key);
    if (s.mode.kind === 'input') return this.inputKey(s.mode, key);
    if (key.name === 'paste') return Promise.resolve(); // pasted text never runs commands
    if (s.mode.kind === 'confirm') return this.confirmKey(s.mode, key);
    return this.normalKey(key);
  }

  private normalKey(key: Key): Promise<void> {
    const ch = key.name === 'char' ? key.ch : '';
    if (ch === 'q' || key.name === 'ctrl-c') return this.quit();
    if (key.name === 'up') return this.move(-1);
    if (key.name === 'down') return this.move(1);
    if (key.name === 'home') return this.move(-Infinity);
    if (key.name === 'end') return this.move(Infinity);
    if (ch >= '1' && ch <= '9') return this.jump(Number(ch) - 1);
    // Each key is its label's first letter, as in the Claude Code pane.
    if (key.name === 'tab' || ch === 'v') return this.switchView();
    if (ch === 's') return this.refresh();
    if (ch === 't') return this.startInput('push', 'new todo', 'what to remember · 1 credit · Enter to add · Esc to cancel');
    if (ch === 'r') return this.startInput('in', 'new reminder', '2h call the bank · 1 credit, +1 held for the email · Enter to schedule · Esc to cancel');
    if (ch === 'e') {
      const r = this.selectedReminder();
      if (!r) return Promise.resolve();
      // Control characters from the server never reach the input line; Enter without changes stays "Unchanged."
      const text = cleanText(r.text, Number.MAX_SAFE_INTEGER);
      return this.startInput('edit', `edit [${shortId(r.id)}]`, 'Enter to save (every 3rd edit costs 1 credit) · Esc to cancel', { buffer: text, targetId: r.id, originalText: text, version: this.state.version });
    }
    if (ch === 'w') {
      const r = this.selectedReminder();
      if (!r) return Promise.resolve();
      return this.startInput('time', `due in [${shortId(r.id)}]`, '30m, 2h, 1d, or clear to make it a todo · Enter to save (every 3rd edit costs 1 credit) · Esc to cancel', { targetId: r.id, version: this.state.version });
    }
    if (key.name === 'enter') return this.confirmDone();
    if (ch === 'd') return this.toggleDone();
    if (ch === 'a') return this.ackSelected();
    if (ch === 'A') return this.ackAll();
    if (ch === 'p') return this.startConfirm('pop');
    if (ch === 'o') return this.startConfirm('dequeue');
    if (ch === 'b') return this.buy();
    return Promise.resolve();
  }

  private loginKey(key: Key): Promise<void> {
    const l = this.state.login;
    if (key.name === 'escape' || key.name === 'ctrl-c') return this.quit();
    if (l.busy) return Promise.resolve();
    if (key.name === 'tab' || key.name === 'up' || key.name === 'down') {
      this.switchField(l.field === 'email' ? 'password' : 'email');
      return Promise.resolve();
    }
    if (key.name === 'enter') {
      if (l.field === 'email') { this.switchField('password'); return Promise.resolve(); }
      return this.submitLogin();
    }
    const line = { buffer: l[l.field], cursor: l.cursor };
    if (editLine(line, key)) {
      l[l.field] = line.buffer;
      l.cursor = line.cursor;
      this.changed();
    }
    return Promise.resolve();
  }

  /** The acceptance view: y accepts the version shown, n quits (exit 4), d quits into the delete-account flow. */
  private privacyKey(key: Key): Promise<void> {
    const ch = key.name === 'char' ? key.ch : '';
    if (ch === 'n' || ch === 'q' || key.name === 'escape' || key.name === 'ctrl-c') {
      this.exitCode = EXIT_PRIVACY_REQUIRED;
      this.changed();
      return Promise.resolve();
    }
    if (ch === 'd') {
      this.deleteRequested = true;
      return this.quit();
    }
    if (ch === 'y') return this.enqueue(() => this.acceptShown());
    return Promise.resolve();
  }

  /** Accepts exactly the version on screen; when it changed meanwhile (409), the new one is shown instead. */
  private async acceptShown(): Promise<void> {
    const s = this.state;
    const p = s.privacy;
    if (s.screen !== 'privacy' || p === null) return; // a second y queued behind the first
    if (p.summary === null || p.version === null) { await this.loadPolicy(); return; }
    try {
      await this.client.acceptPrivacy(p.version);
    } catch (err) {
      if (!isPrivacyStale(err)) throw err;
      await this.loadPolicy();
      this.say('The privacy policy has just changed: this is the new version.', 'yellow');
      return;
    }
    s.screen = 'dashboard';
    s.privacy = null;
    this.say('Privacy policy accepted.', 'green');
    await this.doRefresh();
  }

  /** Shows the acceptance view for a 403 privacy_not_accepted, then fetches the summary into it. */
  private async toPrivacy(err: ApiError): Promise<void> {
    const s = this.state;
    const body = (err.body ?? {}) as { version?: unknown; url?: unknown };
    s.screen = 'privacy';
    s.mode = { kind: 'normal' };
    s.message = null;
    s.privacy = { version: typeof body.version === 'string' ? body.version : null, url: typeof body.url === 'string' ? body.url : PRIVACY_URL, summary: null };
    this.changed();
    await this.loadPolicy();
  }

  /** GET /privacy into the acceptance view; a failure is shown on its message line (y tries again). */
  private async loadPolicy(): Promise<void> {
    try {
      const p = await this.client.privacy();
      this.state.privacy = { version: p.version, url: p.url, summary: p.summary };
      this.changed();
    } catch (err) {
      this.say(`${errorText(err)} (y tries again)`, 'red');
    }
  }

  private switchField(field: 'email' | 'password'): void {
    const l = this.state.login;
    l.field = field;
    l.cursor = [...l[field]].length;
    this.changed();
  }

  /** `client.login` saves the credentials through its onCredentials callback, exactly as `mokkan login` does. */
  private submitLogin(): Promise<void> {
    const l = this.state.login;
    const email = l.email.trim();
    if (!EMAIL_RE.test(email)) {
      l.error = { text: 'Enter an email address.', tone: 'red' };
      this.switchField('email');
      return Promise.resolve();
    }
    if (l.password === '') {
      l.error = { text: 'Enter your password.', tone: 'red' };
      this.changed();
      return Promise.resolve();
    }
    l.busy = true;
    l.error = { text: 'Logging in…', tone: 'dim' };
    this.changed();
    return this.enqueue(async () => {
      try {
        const creds = await this.client.login(email, l.password);
        this.state.email = creds.email;
        this.state.screen = 'dashboard';
        this.state.login = emptyLogin();
        this.changed();
        await this.doRefresh();
      } catch (err) {
        l.busy = false;
        l.password = '';
        l.field = 'password';
        l.cursor = 0;
        const hint = err instanceof ApiError ? apiErrorHint(err) : null;
        l.error = { text: hint ? `${errorText(err)} ${hint}` : errorText(err), tone: 'red' };
        this.changed();
      }
    });
  }

  private quit(): Promise<void> {
    this.exitCode = 0;
    this.changed();
    return Promise.resolve();
  }

  private move(delta: number): Promise<void> {
    const s = this.state;
    const n = this.rows().length;
    s.selected = delta === -Infinity ? 0 : delta === Infinity ? n - 1 : s.selected + delta;
    this.clampSelection();
    this.changed();
    return Promise.resolve();
  }

  /** Digits select a row of the current view; one that is not there is ignored. */
  private jump(index: number): Promise<void> {
    if (index >= this.rows().length) return Promise.resolve();
    this.state.selected = index;
    this.clampSelection();
    this.changed();
    return Promise.resolve();
  }

  private switchView(): Promise<void> {
    const s = this.state;
    s.tab = nextTab(s.tab);
    s.selected = 0;
    s.scroll = 0;
    this.landing = false;
    this.changed();
    if (s.tab !== 'archived' || s.done !== null) return Promise.resolve();
    return this.enqueue(async () => {
      s.done = (await this.client.list('done')).reminders;
      this.clampSelection();
      this.changed();
    });
  }

  private activeRows(): Reminder[] {
    return this.state.reminders.filter((r) => ACTIVE_STATES.has(r.state));
  }

  /**
   * The selected reminder for e, w, a (and, with `inArchived`, d and Enter); sets the message and returns null when
   * there is none to change.
   */
  private selectedReminder(inArchived = false): Reminder | null {
    const s = this.state;
    if (s.tab === 'archived' && !inArchived) { this.say('Archived ones cannot be changed; d reopens one.', 'yellow'); return null; }
    const r = this.rows()[s.selected];
    if (!r) { this.say('Nothing selected.', 'yellow'); return null; }
    return r;
  }

  private startInput(purpose: InputPurpose, label: string, hint: string, extra: Partial<InputMode> = {}): Promise<void> {
    const buffer = extra.buffer ?? '';
    this.state.message = null;
    this.state.mode = { kind: 'input', purpose, label, hint, buffer, cursor: [...buffer].length, ...extra };
    this.changed();
    return Promise.resolve();
  }

  private inputKey(mode: InputMode, key: Key): Promise<void> {
    if (key.name === 'ctrl-c') return this.quit();
    if (key.name === 'escape') { this.state.mode = { kind: 'normal' }; this.changed(); return Promise.resolve(); }
    if (key.name === 'enter') return this.submitInput(mode);
    if (editLine(mode, key)) this.changed();
    return Promise.resolve();
  }

  private submitInput(mode: InputMode): Promise<void> {
    const s = this.state;
    const text = mode.buffer.trim();
    if (text === '' && mode.purpose === 'edit') { this.say('The text can’t be empty.', 'red'); return Promise.resolve(); }
    if (text === '') { s.mode = { kind: 'normal' }; this.changed(); return Promise.resolve(); }
    switch (mode.purpose) {
      case 'push':
        return this.action(async () => {
          const res = await this.client.push(text);
          this.say(`Added [${shortId(res.reminder.id)}] ${res.reminder.text}${this.landsIn('todos')}`, 'green');
        });
      case 'in': {
        const space = text.search(/\s/);
        const word = space === -1 ? text : text.slice(0, space);
        const rest = space === -1 ? '' : text.slice(space + 1).trim();
        const seconds = this.parseDurationOrSay(word);
        if (seconds === null) return Promise.resolve();
        if (rest === '') { this.say('Add the reminder text after the duration.', 'red'); return Promise.resolve(); }
        const now = this.now();
        const dueAt = new Date(now.getTime() + seconds * 1000);
        if (!Number.isFinite(dueAt.getTime())) { this.say('duration is too large', 'red'); return Promise.resolve(); }
        return this.action(async () => {
          const res = await this.client.push(rest, dueAt);
          this.say(`Scheduled [${shortId(res.reminder.id)}] "${res.reminder.text}" for ${dueAt.toISOString()} (${formatRelative(dueAt, now)})${this.landsIn('reminders')}`, 'green');
        });
      }
      case 'edit':
        if (text === mode.originalText) { s.mode = { kind: 'normal' }; this.say('Unchanged.', 'dim'); return Promise.resolve(); }
        return this.action(async () => {
          const res = await this.client.editReminder(mode.targetId!, { text }, mode.version ?? undefined);
          this.say(`Edited [${shortId(res.reminder.id)}] ${res.reminder.text}`, 'green');
        }, mode);
      case 'time': {
        let dueAt: Date | null = null;
        if (text !== 'clear') {
          const seconds = this.parseDurationOrSay(text);
          if (seconds === null) return Promise.resolve();
          dueAt = new Date(this.now().getTime() + seconds * 1000);
          if (!Number.isFinite(dueAt.getTime())) { this.say('duration is too large', 'red'); return Promise.resolve(); }
        }
        const now = this.now();
        return this.action(async () => {
          const res = await this.client.editReminder(mode.targetId!, { due_at: dueAt }, mode.version ?? undefined);
          const r = res.reminder;
          const when = r.due_at ? `(due ${r.due_at}, ${formatRelative(new Date(r.due_at), now)})` : '(time cleared)';
          this.say(`Edited [${shortId(r.id)}] ${r.text} ${when}${this.landsIn(r.due_at === null ? 'todos' : 'reminders')}`, 'green');
        }, mode);
      }
    }
  }

  /** The view stays put: a reminder that lands on another tab says which, ` → Reminders`. */
  private landsIn(tab: Tab): string {
    return tab === this.state.tab ? '' : ` → ${tabLabel(tab)}`;
  }

  /** `parseDuration`, with its error shown in the message line (the input stays open). */
  private parseDurationOrSay(word: string): number | null {
    try {
      return parseDuration(word);
    } catch (err) {
      this.say(errorText(err), 'red');
      return null;
    }
  }

  /**
   * Leaves input or confirm mode, runs one server call, then refreshes. Failures become messages through `fail`.
   * `reopen`: the edit or time input to bring back, typed text and all, when the list changed under it.
   */
  private action(work: () => Promise<void>, reopen?: InputMode): Promise<void> {
    this.state.mode = { kind: 'normal' };
    this.changed();
    return this.enqueue(async () => {
      try {
        await work();
      } catch (err) {
        await this.fail(err);
        const s = this.state;
        // fail() has refreshed; the retry is sent against the version just fetched.
        if (reopen && isStale(err) && s.screen === 'dashboard' && s.mode.kind === 'normal') {
          s.mode = { ...reopen, version: s.version };
          this.changed();
        }
        return;
      }
      await this.doRefresh();
    });
  }

  private startConfirm(action: 'pop' | 'dequeue'): Promise<void> {
    const list = this.activeRows();
    const target = action === 'pop' ? list[0] : list[list.length - 1];
    if (!target) { this.say('The stack is empty.'); return Promise.resolve(); }
    this.state.message = null;
    this.state.mode = { kind: 'confirm', action, text: target.text, version: this.state.version };
    this.changed();
    return Promise.resolve();
  }

  private confirmKey(mode: ConfirmMode, key: Key): Promise<void> {
    if (key.name === 'ctrl-c') return this.quit();
    if (key.name !== 'char' || key.ch !== 'y') { this.state.mode = { kind: 'normal' }; this.changed(); return Promise.resolve(); }
    const version = mode.version ?? undefined;
    if (mode.action === 'done' || mode.action === 'undone') return this.setDone(mode.targetId!, mode.action === 'done', version);
    return this.action(async () => {
      const res = mode.action === 'pop' ? await this.client.pop(version) : await this.client.dequeue(version);
      this.say(`Popped [${shortId(res.reminder.id)}] ${res.reminder.text}`, 'green');
    });
  }

  /** Enter: asks before `d` would archive the selected reminder, or in the archived view reopen it. */
  private confirmDone(): Promise<void> {
    const r = this.selectedReminder(true);
    if (!r) return Promise.resolve();
    this.state.message = null;
    this.state.mode = { kind: 'confirm', action: this.state.tab === 'archived' ? 'undone' : 'done', text: r.text, version: this.state.version, targetId: r.id };
    this.changed();
    return Promise.resolve();
  }

  /** `d`: archives the selected reminder, or in the archived view reopens it, as `mokkan done` / `mokkan undone` do. */
  private toggleDone(): Promise<void> {
    const r = this.selectedReminder(true);
    if (!r) return Promise.resolve();
    return this.setDone(r.id, this.state.tab !== 'archived', this.state.version ?? undefined);
  }

  private setDone(id: string, done: boolean, version: number | undefined): Promise<void> {
    return this.action(async () => {
      const res = await this.client.setDone(id, done, version);
      this.say(`${done ? 'Archived' : 'Reopened'} [${shortId(res.reminder.id)}] ${res.reminder.text}`, 'green');
    });
  }

  private ackSelected(): Promise<void> {
    const r = this.selectedReminder();
    if (!r) return Promise.resolve();
    const version = this.state.version ?? undefined;
    return this.action(async () => {
      const res = await this.client.ack([r.id], version);
      this.say(`Acknowledged ${res.acknowledged.length} reminder(s).`, 'green');
    });
  }

  private ackAll(): Promise<void> {
    return this.action(async () => {
      const res = await this.client.ack('all');
      this.say(`Acknowledged ${res.acknowledged.length} reminder(s).`, 'green');
    });
  }

  /**
   * Same rules as `mokkan buy`: only a Stripe Checkout address is opened. The link does not fit the message line,
   * so when it cannot be opened the message points to `mokkan buy --no-open`, which prints it.
   */
  private buy(): Promise<void> {
    return this.action(async () => {
      let res: CheckoutResponse;
      try {
        res = await this.client.checkout();
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) { this.say('Billing is not enabled on this server.', 'red'); return; }
        throw err;
      }
      if (!isTrustedCheckoutUrl(res.url)) {
        this.say('Checkout link is not a Stripe address. Run: mokkan buy --no-open to see it.');
        return;
      }
      let opened = false;
      try { opened = this.openUrl?.(res.url) ?? false; } catch { /* no opener: reported below */ }
      this.say(opened
        ? 'Opened Stripe Checkout in your browser; the balance updates after payment.'
        : 'Could not open a browser here. Run: mokkan buy --no-open (prints the link).');
    });
  }

  private listHeight(): number { return Math.max(1, this.size.rows - CHROME_ROWS); }

  private clampSelection(): void {
    const s = this.state;
    const n = this.rows().length;
    const h = this.listHeight();
    s.selected = n === 0 ? 0 : Math.min(Math.max(0, s.selected), n - 1);
    if (s.selected < s.scroll) s.scroll = s.selected;
    if (s.selected >= s.scroll + h) s.scroll = s.selected - h + 1;
    s.scroll = Math.max(0, Math.min(s.scroll, Math.max(0, n - h)));
  }

  private changed(): void { this.onChange(); }

  private say(text: string, tone: Tone = 'plain'): void {
    this.state.message = { text, tone };
    this.changed();
  }

  /** Every server call runs here, one after another. `work` failures become messages through `fail`. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(() => work().catch((err) => this.fail(err)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doRefresh(): Promise<void> {
    const s = this.state;
    if (s.screen !== 'dashboard' || this.exitCode !== null) return;
    s.refreshing = true;
    this.changed();
    try {
      const [first, me, , done] = await Promise.all([
        this.client.list('all'),
        this.client.me().catch(() => null),
        this.client.heartbeat('ui').catch(() => null),
        s.tab === 'archived' || s.done !== null ? this.client.list('done') : null,
      ]);
      // The first list picks the tab: Reminders while one is due, else TODOs.
      if (this.landing) {
        this.landing = false;
        s.tab = first.reminders.some((r) => isDue(r, this.now())) ? 'reminders' : 'todos';
      }
      // Delivery changes the list and its version, and another session may have changed it since: list again.
      const list = await this.deliverDue(first.reminders) ? await this.client.list('all') : first;
      // No await from here to the selection restore, so keys pressed while the requests ran are kept.
      const keep = this.rows()[s.selected]?.id;
      s.reminders = list.reminders;
      s.version = list.version;
      s.fetchedAt = this.now();
      s.error = null;
      if (typeof me?.credit_balance === 'number') s.credits = me.credit_balance;
      if (done) s.done = done.reminders;
      const idx = keep === undefined ? -1 : this.rows().findIndex((r) => r.id === keep);
      if (idx !== -1) s.selected = idx;
      this.clampSelection();
    } catch (err) {
      if (this.sessionLost(err)) { this.toLogin('Session expired, log in again.'); return; }
      if (isPrivacyRequired(err)) { await this.toPrivacy(err as ApiError); return; }
      s.error = err instanceof NetworkError
        ? { kind: 'offline', message: err.message }
        : { kind: 'error', message: errorText(err) };
    } finally {
      s.refreshing = false;
      this.changed();
    }
  }

  /**
   * Reminders shown here count as shown: the due ones the current tab lists are marked delivered, like the hooks and
   * `mokkan watch` do. None in the archived view, which shows no open ones. Returns whether the server took the call.
   */
  private async deliverDue(reminders: Reminder[]): Promise<boolean> {
    const ids = reminders.filter((r) => inTab(r, this.state.tab) && r.state === 'due' && !this.delivered.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return false;
    for (const id of ids) this.delivered.add(id);
    try {
      await this.client.deliver(ids);
    } catch (err) {
      if (this.sessionLost(err)) throw err;
      for (const id of ids) this.delivered.delete(id); // try again on the next refresh
      return false;
    }
    return true;
  }

  private sessionLost(err: unknown): boolean {
    return err instanceof SessionExpiredError || (err instanceof ApiError && err.code === 'no_credentials');
  }

  /** The client has already removed the dead credentials; show the login screen with a clean slate. */
  private toLogin(message: string): void {
    const s = this.state;
    s.screen = 'login';
    s.privacy = null;
    s.login = emptyLogin();
    s.login.error = { text: message, tone: 'red' };
    s.reminders = []; s.done = null; s.version = null; s.selected = 0; s.scroll = 0;
    s.email = ''; s.credits = null; s.fetchedAt = null; s.error = null; s.message = null;
    s.mode = { kind: 'normal' };
    this.delivered.clear();
    this.landing = true;
    this.changed();
  }

  /** Maps a failed server call to the message line; only a lost session changes the screen. */
  private async fail(err: unknown): Promise<void> {
    if (this.sessionLost(err)) { this.toLogin('Session expired, log in again.'); return; }
    if (isPrivacyRequired(err)) { await this.toPrivacy(err as ApiError); return; }
    if (err instanceof NetworkError) { this.say(`Server unreachable: ${err.message}`, 'red'); return; }
    if (err instanceof ApiError) {
      if (isStale(err)) {
        await this.doRefresh();
        this.say('The list changed, try again.', 'yellow');
        return;
      }
      if (err.status === 409 && err.code === 'not_editable') {
        this.say('This reminder was already shown or emailed, so its time can no longer be changed.', 'red');
        return;
      }
      if (err.status === 404 && err.code === 'empty') { this.say('The stack is empty.'); return; }
      const hint = apiErrorHint(err);
      let text = hint ? `${err.message} ${hint}` : err.message;
      if (err.status === 402 && err.code === 'insufficient_credits' && !text.includes('mokkan buy')) text += ' Run: mokkan buy';
      this.say(text, 'red');
      return;
    }
    this.say(errorText(err), 'red');
  }
}
