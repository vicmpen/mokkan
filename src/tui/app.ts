import { ApiError, NetworkError, apiErrorHint, type MokkanClient } from '../client.js';
import { EMAIL_RE } from '../commands/auth.js';
import { isTrustedCheckoutUrl } from '../commands/billing.js';
import { parseDuration } from '../duration.js';
import { SessionExpiredError } from '../errors.js';
import { formatRelative, shortId } from '../format.js';
import { cleanText } from '../statusline.js';
import type { CheckoutResponse, Reminder } from '../types.js';
import type { Key } from './keys.js';
import { render as renderScreen } from './screen.js';
import {
  initialState, rowsOf, emptyLogin, ACTIVE_STATES, CHROME_ROWS, MAX_INPUT_CODE_POINTS,
  type ConfirmMode, type InputMode, type InputPurpose, type Size, type Tab, type Tone, type TuiState,
} from './state.js';

export const REFRESH_INTERVAL_MS = 10_000;
const TABS: Tab[] = ['active', 'all', 'done'];

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
  /** Called after every state change; the driver redraws. */
  onChange: () => void = () => undefined;
  private size: Size = { columns: 80, rows: 24 };
  private queue: Promise<void> = Promise.resolve();
  /** The refresh that is queued or running; asking for another one joins it. */
  private pendingRefresh: Promise<void> | null = null;
  /** Ids already sent to /reminders/deliver, so a slow server never gets them twice. */
  private readonly delivered = new Set<string>();
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
    if (s.mode.kind === 'input') return this.inputKey(s.mode, key);
    if (key.name === 'paste') return Promise.resolve(); // pasted text never runs commands
    if (s.mode.kind === 'confirm') return this.confirmKey(s.mode, key);
    return this.normalKey(key);
  }

  private normalKey(key: Key): Promise<void> {
    const ch = key.name === 'char' ? key.ch : '';
    if (ch === 'q' || key.name === 'ctrl-c') return this.quit();
    if (key.name === 'up' || ch === 'k') return this.move(-1);
    if (key.name === 'down' || ch === 'j') return this.move(1);
    if (key.name === 'home') return this.move(-Infinity);
    if (key.name === 'end') return this.move(Infinity);
    if (key.name === 'tab') return this.nextTab();
    if (ch === 'r') return this.refresh();
    if (ch === 'p') return this.startInput('push', 'push', 'Enter to push (1 credit) · Esc to cancel');
    if (ch === 'i') return this.startInput('in', 'in', '<duration> <text>, e.g. 2h call the bank · Enter to schedule · Esc to cancel');
    if (ch === 'e') {
      const r = this.selectedReminder();
      if (!r) return Promise.resolve();
      // Control characters from the server never reach the input line; Enter without changes stays "Unchanged."
      const text = cleanText(r.text, Number.MAX_SAFE_INTEGER);
      return this.startInput('edit', `edit [${shortId(r.id)}]`, 'Enter to save (counts as one edit) · Esc to cancel', { buffer: text, targetId: r.id, originalText: text, version: this.state.version });
    }
    if (ch === 't') {
      const r = this.selectedReminder();
      if (!r) return Promise.resolve();
      return this.startInput('time', `time [${shortId(r.id)}]`, '30m, 2h, 1d, 1h30m, or "clear" · Enter to save (counts as one edit) · Esc to cancel', { targetId: r.id, version: this.state.version });
    }
    if (ch === 'a') return this.ackSelected();
    if (ch === 'A') return this.ackAll();
    if (ch === 'x') return this.startConfirm('pop');
    if (ch === 'd') return this.startConfirm('dequeue');
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

  private nextTab(): Promise<void> {
    const s = this.state;
    s.tab = TABS[(TABS.indexOf(s.tab) + 1) % TABS.length];
    s.selected = 0;
    s.scroll = 0;
    this.changed();
    if (s.tab !== 'done' || s.done !== null) return Promise.resolve();
    return this.enqueue(async () => {
      s.done = (await this.client.list('done')).reminders;
      this.clampSelection();
      this.changed();
    });
  }

  private activeRows(): Reminder[] {
    return this.state.reminders.filter((r) => ACTIVE_STATES.has(r.state));
  }

  /** The selected reminder for e, t and a; sets the message and returns null when there is none to change. */
  private selectedReminder(): Reminder | null {
    const s = this.state;
    if (s.tab === 'done') { this.say('Switch to Active or All to change reminders.', 'yellow'); return null; }
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
    if (text === '') { s.mode = { kind: 'normal' }; this.changed(); return Promise.resolve(); }
    switch (mode.purpose) {
      case 'push':
        return this.action(async () => {
          const res = await this.client.push(text);
          this.say(`Pushed [${shortId(res.reminder.id)}] ${res.reminder.text}`, 'green');
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
          this.say(`Scheduled [${shortId(res.reminder.id)}] "${res.reminder.text}" for ${dueAt.toISOString()} (${formatRelative(dueAt, now)})`, 'green');
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
          this.say(`Edited [${shortId(r.id)}] ${r.text} ${when}`, 'green');
        }, mode);
      }
    }
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
    if (!target) { this.say('List is empty.'); return Promise.resolve(); }
    this.state.message = null;
    this.state.mode = { kind: 'confirm', action, text: target.text, version: this.state.version };
    this.changed();
    return Promise.resolve();
  }

  private confirmKey(mode: ConfirmMode, key: Key): Promise<void> {
    if (key.name === 'ctrl-c') return this.quit();
    if (key.name !== 'char' || key.ch !== 'y') { this.state.mode = { kind: 'normal' }; this.changed(); return Promise.resolve(); }
    const version = mode.version ?? undefined;
    return this.action(async () => {
      const res = mode.action === 'pop' ? await this.client.pop(version) : await this.client.dequeue(version);
      this.say(`${mode.action === 'pop' ? 'Popped' : 'Dequeued'} [${shortId(res.reminder.id)}] ${res.reminder.text}`, 'green');
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
        s.tab === 'done' ? this.client.list('done') : null,
      ]);
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
      s.error = err instanceof NetworkError
        ? { kind: 'offline', message: err.message }
        : { kind: 'error', message: errorText(err) };
    } finally {
      s.refreshing = false;
      this.changed();
    }
  }

  /**
   * Reminders shown here count as shown: due ones in `reminders` are marked delivered, like the hooks and
   * `mokkan watch` do. Not on the Done tab, which does not show them. Returns whether the server took the call.
   */
  private async deliverDue(reminders: Reminder[]): Promise<boolean> {
    if (this.state.tab === 'done') return false;
    const ids = reminders.filter((r) => r.state === 'due' && !this.delivered.has(r.id)).map((r) => r.id);
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
    s.login = emptyLogin();
    s.login.error = { text: message, tone: 'red' };
    s.reminders = []; s.done = null; s.version = null; s.selected = 0; s.scroll = 0;
    s.email = ''; s.credits = null; s.fetchedAt = null; s.error = null; s.message = null;
    s.mode = { kind: 'normal' };
    this.delivered.clear();
    this.changed();
  }

  /** Maps a failed server call to the message line; only a lost session changes the screen. */
  private async fail(err: unknown): Promise<void> {
    if (this.sessionLost(err)) { this.toLogin('Session expired, log in again.'); return; }
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
      if (err.status === 404 && err.code === 'empty') { this.say('List is empty.'); return; }
      const hint = apiErrorHint(err);
      let text = hint ? `${err.message} ${hint}` : err.message;
      if (err.status === 402 && err.code === 'insufficient_credits' && !text.includes('mokkan buy')) text += ' Run: mokkan buy';
      this.say(text, 'red');
      return;
    }
    this.say(errorText(err), 'red');
  }
}
