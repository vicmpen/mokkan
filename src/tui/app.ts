import { ApiError, NetworkError, apiErrorHint, type MokkanClient } from '../client.js';
import { SessionExpiredError } from '../errors.js';
import type { DeliverResponse, Reminder } from '../types.js';
import type { Key } from './keys.js';
import { initialState, rowsOf, emptyLogin, type Size, type Tab, type Tone, type TuiState } from './state.js';

export const REFRESH_INTERVAL_MS = 10_000;
const TABS: Tab[] = ['active', 'all', 'done'];
/** Header, tabs, rule, message and two footer lines. */
const CHROME_ROWS = 6;

export interface TuiAppOptions {
  client: MokkanClient;
  /** null: start on the login screen. */
  email: string | null;
  host: string;
  now: () => Date;
  openUrl?: (url: string) => void;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  /** Ids already sent to /reminders/deliver, so a slow server never gets them twice. */
  private readonly delivered = new Set<string>();
  private readonly client: MokkanClient;
  private readonly now: () => Date;

  constructor(opts: TuiAppOptions) {
    this.client = opts.client;
    this.now = opts.now;
    this.state = initialState(opts.email, opts.host);
  }

  setSize(size: Size): void {
    this.size = size;
    this.clampSelection();
  }

  rows(): Reminder[] { return rowsOf(this.state); }

  refresh(): Promise<void> { return this.enqueue(() => this.doRefresh()); }

  handleKey(key: Key): Promise<void> {
    if (this.state.screen === 'login') return this.loginKey(key);
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
    return Promise.resolve();
  }

  private loginKey(key: Key): Promise<void> {
    if (key.name === 'escape' || key.name === 'ctrl-c') return this.quit();
    return Promise.resolve();
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
    const keep = this.rows()[s.selected]?.id;
    s.refreshing = true;
    this.changed();
    try {
      const [list, me] = await Promise.all([
        this.client.list('all'),
        this.client.me().catch(() => null),
        this.client.heartbeat('ui').catch(() => null),
      ]);
      s.reminders = list.reminders;
      s.version = list.version;
      s.fetchedAt = this.now();
      s.error = null;
      if (typeof me?.credit_balance === 'number') s.credits = me.credit_balance;
      if (s.tab === 'done') s.done = (await this.client.list('done')).reminders;
      const idx = keep === undefined ? -1 : this.rows().findIndex((r) => r.id === keep);
      if (idx !== -1) s.selected = idx;
      this.clampSelection();
      await this.deliverDue();
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

  /** Reminders shown here count as shown: due ones are marked delivered, like the hooks and `mokkan watch` do. */
  private async deliverDue(): Promise<void> {
    const s = this.state;
    const ids = s.reminders.filter((r) => r.state === 'due' && !this.delivered.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    for (const id of ids) this.delivered.add(id);
    let res: DeliverResponse;
    try {
      res = await this.client.deliver(ids);
    } catch (err) {
      if (this.sessionLost(err)) throw err;
      for (const id of ids) this.delivered.delete(id); // try again on the next refresh
      return;
    }
    s.version = res.version;
    const at = this.now().toISOString();
    for (const id of res.delivered) {
      const r = s.reminders.find((x) => x.id === id);
      if (r) { r.state = 'delivered'; r.delivered_at = at; }
    }
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
      if (err.status === 409 && err.code === 'stale') {
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
