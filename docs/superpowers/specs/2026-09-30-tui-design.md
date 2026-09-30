# `mokkan ui`: a terminal UI for the reminder stack

Date: 2026-09-30. Status: approved design, awaiting implementation plan.

## Goal

Give the `mokkan` CLI a full-screen, keyboard-driven view of the reminder stack: a live dashboard that refreshes
from the server and lets the user push, schedule, edit, acknowledge, pop and dequeue without leaving the screen.

Decisions taken with the user in the design conversation:

- **Scope:** live dashboard with actions (not a prettier `list`, not only a watch view).
- **Entry point:** a new subcommand, `mokkan ui`. Bare `mokkan` keeps printing the list exactly as today.
- **Rendering:** hand-rolled on Node built-ins (raw mode, ANSI escapes, a pure render function). No runtime
  dependencies, so the committed plugin bundle stays small; the status line executes that same bundle every
  30 seconds.
- **Semantics:** every refresh sends a heartbeat (source `ui`), and reminders in state `due` that appear on screen are
  marked delivered, exactly as `mokkan watch` and the Claude Code hooks do when they show a reminder.
- **Editing:** `e` edits text, `t` edits the due time. They are separate PATCH calls and therefore separate edits.
- **Account:** `b` opens Stripe Checkout from the dashboard. When not logged in, `mokkan ui` shows a login screen
  instead of exiting. `register` stays a CLI command (once per account, a three-step one-time-code wizard).

Out of scope: mouse support, registration inside the TUI, reordering, a help overlay.

## Section 1: what the user sees

### Screen

Full-screen on the alternate screen buffer; the previous terminal contents come back on exit. Layout at 80x24:

```
 mokkan · a@example.com · 480 cr · api.mokkan.dev              refreshed 8s ago
 Active 3 │ All 5 │ Done
────────────────────────────────────────────────────────────────────────────────
▸  1  due          check the flaky login test                      overdue 20m
   2  delivered    ask Maria about the release notes                 due 17:00
   3  acknowledged buy milk

 Pushed [f3a9c1d2] check the flaky login test
 p push · i schedule · e edit · t time · a ack · A ack all
 x pop · d dequeue · b buy · Tab view · r refresh · q quit · ↑↓ move
```

(List rows 4 to 18 are blank at 24 rows.) Rows from top to bottom: header (1), tabs (1), rule (1), list
(`rows - 6`), message (1), footer (2). When the
terminal has fewer than 8 rows or 20 columns, the screen shows one line: `mokkan ui: terminal too small`.

**Header.** Left: ` mokkan · <email><credits> · <host>`. `<credits>` is the status line's credit segment
(` · 480 cr` dim; ` · ⚠ 12 cr — mokkan buy` yellow, red at 0 or below; nothing when the server reports no
balance). `<host>` is the `host` of the server URL (`api.mokkan.dev`, `127.0.0.1:8787`). Right, one of:

| Situation | Text | Tone |
|---|---|---|
| refresh in flight | `refreshing…` | dim |
| last refresh succeeded | `refreshed 8s ago` | dim |
| network error, data from an earlier refresh | `offline · data 45s old` | red |
| other error, data from an earlier refresh | `error: <message> · data 45s old` | red |
| error and never any data | `offline` / `error: <message>` | red |
| nothing fetched yet | `loading…` | dim |

**Tabs.** `Active <n> │ All <n> │ Done[ <n>]`. Active is `mokkan list` (states due, delivered, acknowledged),
All is `mokkan list --all` (adds scheduled), Done is `mokkan done`. Numbering in each tab matches the CLI's
numbering for that scope, so `mokkan edit 2` means the same reminder. The current tab is bold, the others dim.
The Done count appears once the done list has been loaded.

**Rows.** `▸` (or two spaces) at column 0, the number right-aligned to width 3, two spaces, the state padded to
12 (as `mokkan list` prints it), a space, the text, and a right-aligned time column separated by at least two
spaces. The text fills the remaining width and is truncated with `…`. When fewer than 10 columns remain for the
text, the time column is dropped. The selected row is drawn in reverse video.

Reminder text passes through `cleanText` from `statusline.ts` (control characters replaced, whitespace
collapsed) so a reminder can never inject terminal escapes.

Tone of the state column and the time column:

| Reminder | Time column | Tone |
|---|---|---|
| `due` with `due_at`, unseen for more than 15 minutes (`now - due_at > 15 min`) | `overdue 20m` | red |
| `due` with `due_at`, within 15 minutes | `due 17:00` | yellow |
| `due` without `due_at` (a pushed item) | none | yellow |
| `scheduled` with `due_at` in the past (server has not flipped it yet) | as `due` above | as above |
| `scheduled`, `due_at` in the future | `@ Wed 17:00` | dim |
| `delivered` | `due 17:00` when it has a time | plain |
| `acknowledged` | `due 17:00` when it has a time | dim |
| `done` (Done tab) | `done Wed 17:00` | dim |

Times use `formatWhen` from `statusline.ts` (local time, `17:00` today, `Wed 17:00` within a week, `Oct 12
17:00` beyond) and `formatRelative`/age helpers already in the code base. The 15 minute grace is the status line's
`DEFAULT_GRACE_MINUTES`.

An empty Active or All tab shows `No reminders. Press p to push one.` (dim) on the first list row; an empty Done
tab shows `Nothing done yet.`

The list scrolls so the selected row is always visible; the scroll offset moves only when the selection leaves the
window. Selection follows the reminder id across refreshes; when that id is gone, the selection stays at the same
index, clamped to the list.

**Message line.** The outcome of the last action (`Pushed [f3a9c1d2] …`, `Acknowledged 2 reminder(s).`, an error
in red). It stays until the next action or until the user starts another input.

**Footer.** Two lines of key hints in normal mode:

```
 p push · i schedule · e edit · t time · a ack · A ack all
 x pop · d dequeue · b buy · Tab view · r refresh · q quit · ↑↓ move
```

Lines longer than the terminal are truncated with `…`.

### Keys (normal mode)

| Key | Action |
|---|---|
| `↑` / `↓`, `k` / `j` | move the selection |
| `Home` / `End` | first / last row |
| `p` | push: input mode with label `push` |
| `i` | schedule: input mode with label `in`; the first word is a duration as in `mokkan in` |
| `e` | edit the selected reminder's text: input mode with label `edit [id8]`, buffer prefilled with the current text, cursor at the end |
| `t` | change the selected reminder's due time: input mode with label `time [id8]`; accepts a duration (`30m`, `2h`, `1d`, `1h30m`) or `clear` |
| `a` | acknowledge the selected reminder |
| `A` | acknowledge all |
| `x` | pop the top of the active list, after confirmation |
| `d` | dequeue the bottom of the active list, after confirmation |
| `b` | buy credits: starts a Stripe Checkout, opens it in the browser, shows the link |
| `Tab` | next tab (Active → All → Done → Active) |
| `r` | refresh now |
| `q`, `Ctrl-C` | quit with exit code 0 |
| `Esc` | nothing in normal mode (a lone Esc must not quit by accident) |

`e`, `t` and `a` need a selected row that is not done: in the Done tab, or with an empty list, they only set the
message `Nothing selected.` / `Switch to Active or All to change reminders.` `x` and `d` act on the active list
regardless of the current tab; with an empty active list they set the message `List is empty.` without asking.

### Input mode

The footer's first line becomes `<label> › <buffer>` with a visible cursor; the second line is a hint:

| Label | Hint |
|---|---|
| `push` | `Enter to push (1 credit) · Esc to cancel` |
| `in` | `<duration> <text>, e.g. 2h call the bank · Enter to schedule · Esc to cancel` |
| `edit [id8]` | `Enter to save (counts as one edit) · Esc to cancel` |
| `time [id8]` | `30m, 2h, 1d, 1h30m, or "clear" · Enter to save (counts as one edit) · Esc to cancel` |

Editing keys: printable characters insert at the cursor (a pasted chunk inserts all its characters; `\r` and `\n`
inside a paste are dropped), `Backspace`, `Delete`, `←` / `→`, `Home` / `End`, `Ctrl-U` clears the buffer.
`Enter` submits, `Esc` cancels. Navigation keys and action keys are inactive while in input mode.

Submission rules:

- Empty or whitespace-only buffer: leave input mode, no request, no message.
- `push`: `client.push(text)`. Message `Pushed [id8] <text>`.
- `in`: split off the first word, `parseDuration` it; on error stay in input mode and show the parser's message in
  the message line (red). Otherwise `client.push(text, now + duration)`. Message `Scheduled [id8] "<text>" for
  <iso> (in 2h)` as the CLI prints it.
- `edit`: unchanged text: leave input mode with message `Unchanged.` and no request (no edit is charged). Otherwise
  `client.editReminder(id, { text }, version)`. Message `Edited [id8] <text>`.
- `time`: `clear` → `{ due_at: null }`; otherwise `parseDuration`, on error stay in input mode with the message.
  `client.editReminder(id, { due_at }, version)`. Message `Edited [id8] <text> (due <iso>, in 2h)` or `Edited
  [id8] <text> (time cleared)`.

### Confirm mode (`x`, `d`)

Footer line 1: `Pop "<text>"? y/n` or `Dequeue "<text>"? y/n`, where `<text>` is the top (bottom) reminder of the
active list truncated to fit. Footer line 2 is empty. `y` performs the action; any other key cancels with no
message. Messages: `Popped [id8] <text>` / `Dequeued [id8] <text>`.

### Login screen

Shown when `mokkan ui` starts without credentials, and after a session loss. Layout at 80x24:

```
 mokkan · api.mokkan.dev                                          not logged in

 Log in

 Email     › you@example.com
 Password  › ••••••••••

 Wrong email or password.

 Enter next field / log in · Tab switch field · Esc quit
 No account? Quit and run: mokkan register you@example.com
```

Two fields, email and password. The active field shows the cursor; the password is drawn as one `•` per
character. Keys: printable characters insert at the cursor; `Backspace`, `Delete`, `←` / `→`, `Home` / `End`,
`Ctrl-U` edit the active field; `Tab`, `↑`, `↓` switch fields; `Enter` on the email moves to the password, `Enter`
on the password submits; `Esc` and `Ctrl-C` quit with exit code 0 (`q` is a letter here, not a command).

Submission: the email must match the CLI's `EMAIL_RE` and the password must be non-empty, otherwise the error line
says `Enter an email address.` / `Enter your password.` During the request the error line reads `Logging in…` and
keys are ignored. `client.login(email, password)` saves the credentials through the client's `onCredentials`
callback exactly as `mokkan login` does. On success the app switches to the dashboard with the account's email and
refreshes. On failure the error line shows the server's message plus the CLI's retry hint for 429 (`try again in
about N seconds`), the password field is cleared and stays active.

### Behavior

- **Refresh:** on start, every 10 seconds, on `r`, after every successful mutation, and after a 409 stale.
- **Optimistic concurrency:** pop, dequeue, ack (ids) and edit send the list version of the data on screen. On 409
  stale the app refreshes and sets the message `The list changed, try again.`
- **Delivery:** after a successful list, reminders in state `due` that this app has not yet delivered are sent to
  `client.deliver(ids)`; on success they are shown as `delivered` at once and remembered so they are not sent
  again. `scheduled` reminders whose time has passed are not delivered (the server has not made them due yet).
- **Not a terminal:** `mokkan ui` with stdin or stdout not a TTY (this includes `/mokkan:mokkan ui`, which then
  prints the message on stdout and exits 0 through `--exit-zero`) prints `mokkan ui needs an interactive terminal.`
  and exits 1.
- **Buy:** `b` calls `client.checkout()`; when the URL passes `isTrustedCheckoutUrl` it is opened with
  `io.openUrl` (same rules as `mokkan buy`). Message: `Checkout: <url> · opening in your browser` (or `· open it
  in your browser` when not opened, `· not opened: not a Stripe Checkout address` when untrusted), then `When the
  payment completes, the balance updates on the next refresh.` A 404 from the server gives `Billing is not enabled
  on this server.`
- **Not logged in:** `mokkan ui` opens on the login screen (above) instead of the dashboard. Nothing is fetched
  until the login succeeds.
- **Session lost** (`SessionExpiredError`, or an `ApiError` with code `no_credentials`) while on the dashboard: the
  client has already removed the local credentials; the TUI clears its data and switches to the login screen with
  the error `Session expired, log in again.` A successful login returns to the dashboard.

## Section 2: architecture

All new code lives in `src/tui/` plus one command file. Everything except the terminal driver is pure or takes an
injected client, so tests never need a real terminal.

### Modules

**`src/tui/keys.ts`** (pure)

```ts
export type Key =
  | { name: 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'enter' | 'escape' | 'tab'
          | 'backspace' | 'delete' | 'ctrl-c' | 'ctrl-u' }
  | { name: 'char'; ch: string };
export function decodeKeys(chunk: string): Key[];
```

Recognized byte sequences: `\x1b[A` `\x1b[B` `\x1b[C` `\x1b[D` (arrows), `\x1bOA`…`\x1bOD` (application mode
arrows), `\x1b[H` `\x1b[F` `\x1b[1~` `\x1b[4~` `\x1bOH` `\x1bOF` (home/end), `\x1b[3~` (delete), `\r` and `\n`
(enter), `\t` (tab), `\x7f` and `\x08` (backspace), `\x03` (ctrl-c), `\x15` (ctrl-u). A lone `\x1b`, or `\x1b`
followed by bytes that are not a recognized sequence, is `escape` (the unrecognized rest is dropped). Any other
code point of category "printable" (not a C0/C1 control) is a `char`. One chunk may yield many keys (a paste).

**`src/tui/text.ts`** (pure)

- `displayWidth(text)`: splits into graphemes with `Intl.Segmenter`; a grapheme counts 2 when any of its code
  points is in a wide range (Hangul Jamo, CJK and fullwidth blocks, emoji presentation blocks U+1F300–1F64F and
  U+1F900–1F9FF, U+20000–3FFFD), else 1. Best effort, documented as such.
- `fit(text, width)`: truncates to `width` columns, ending in `…` when cut.
- `padEnd(text, width)` / `padStart(text, width)` by display width.

**`src/tui/screen.ts`** (pure)

```ts
export interface Size { columns: number; rows: number }
export function render(state: TuiState, size: Size, now: Date): string[];  // exactly size.rows lines
export function cursorPosition(state: TuiState, size: Size): { row: number; column: number } | null; // login screen and input mode
```

`render` draws the login screen or the dashboard by `state.screen`. Colors are plain ANSI SGR (`31` red, `33`
yellow, `32` green, `2` dim, `1` bold, `7` reverse, `0` reset). Every line ends in a reset. `render` never emits a
line wider than `size.columns`. `cursorPosition` is non-null on the login screen and in input mode.

**`src/tui/app.ts`**

```ts
export type Tab = 'active' | 'all' | 'done';
export type Tone = 'red' | 'yellow' | 'green' | 'dim' | 'plain';
export type Mode =
  | { kind: 'normal' }
  | { kind: 'input'; purpose: 'push' | 'in' | 'edit' | 'time'; label: string; hint: string;
      buffer: string; cursor: number; targetId?: string; originalText?: string }
  | { kind: 'confirm'; action: 'pop' | 'dequeue'; prompt: string };

export interface LoginState {
  field: 'email' | 'password'; email: string; password: string; cursor: number;
  busy: boolean; error: { text: string; tone: Tone } | null;
}

export interface TuiState {
  screen: 'login' | 'dashboard';
  login: LoginState;            // used while screen === 'login'
  tab: Tab;
  reminders: Reminder[];        // every non-done reminder, top of stack first (list('all'))
  done: Reminder[] | null;      // list('done'), loaded on first visit to the Done tab
  version: number | null;       // version of `reminders`
  selected: number;             // index into the current tab's rows
  scroll: number;               // first visible row
  email: string; host: string; credits: number | null;   // email is '' before login
  fetchedAt: Date | null;       // last successful list
  refreshing: boolean;
  error: { kind: 'offline' | 'error'; message: string } | null;   // last refresh failure
  message: { text: string; tone: Tone } | null;
  mode: Mode;
}

export class TuiApp {
  constructor(opts: {
    client: MokkanClient; email: string | null; host: string; now: () => Date; onChange: () => void;
    openUrl?: (url: string) => void;
  });                           // email null = start on the login screen
  readonly state: TuiState;
  exitCode: number | null;      // set when the app wants to quit
  setSize(size: Size): void;    // the driver keeps it current (needed for scrolling)
  rows(): Reminder[];           // the current tab's rows
  refresh(): Promise<void>;
  handleKey(key: Key): Promise<void>;   // resolves when the resulting request (if any) has finished
  render(size: Size, now: Date): string[];
}
```

Rules:

- Every server call goes through one promise queue (`this.queue = this.queue.then(work)`), so a timed refresh never
  interleaves with a pop, and two quick `y` presses cannot pop twice (the second finds normal mode).
- `refresh()`: runs `client.heartbeat('ui')`, `client.list('all')` and `client.me()` in parallel. A heartbeat
  failure is ignored. A `/me` failure keeps the previous balance. A list failure sets `error` (`offline` for
  `NetworkError`, otherwise `error` with the message) and keeps `reminders`. Success clears `error`, sets
  `fetchedAt`, then delivers due reminders as described above. In the Done tab it also reloads `list('done')`.
- `handleKey` on the login screen edits the fields or submits; on the dashboard in normal mode it dispatches the
  table in section 1, in input mode edits the buffer or submits, in confirm mode performs or cancels. Navigation is
  synchronous; only actions enqueue work.
- Error mapping for any server call made by an action or refresh (nothing escapes the app except through
  `exitCode`):

| Failure | Result |
|---|---|
| `NetworkError` | during refresh: header offline; during an action: message `Server unreachable: <message>` (red) |
| `ApiError` 402 `insufficient_credits` | message `<server message> Run: mokkan buy` (red); with `required > cost`, the CLI's "(N credits are kept for pending reminder emails …)" note is appended |
| `ApiError` 409 `stale` | refresh, then message `The list changed, try again.` (yellow) |
| `ApiError` 409 `not_editable` | message `This reminder was already shown or emailed, so its time can no longer be changed.` (red) |
| `ApiError` 404 `empty` on pop/dequeue | message `List is empty.` |
| `ApiError` 404 on checkout | message `Billing is not enabled on this server.` |
| `ApiError` 429 | the server message plus the retry hint (`try again in about N seconds/minutes`) |
| `SessionExpiredError`, `ApiError` code `no_credentials` | clear data, `screen = 'login'`, login error `Session expired, log in again.` |
| anything else | message with the error's text (red) |

The 402 and 429 notes are the ones `reportError` in `cli.ts` prints today. They move into one exported helper,
`apiErrorHint(err: ApiError): string | null` next to `ApiError` in `client.ts`, used by both `reportError` and the
TUI, so the wording cannot drift.

**`src/tui/terminal.ts`**

```ts
export interface TerminalIO {
  size(): Size;
  setRawMode(on: boolean): void;
  onData(listener: (chunk: string) => void): () => void;     // returns unsubscribe; resumes/pauses stdin
  onResize(listener: () => void): () => void;
}
export async function runTerminal(app: TuiApp, io: CliIO, tty: TerminalIO): Promise<number>;
```

`runTerminal`:

1. Writes enter sequence `\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l`, sets raw mode, subscribes to data and resize,
   registers `process.once('exit', restoreSync)` (writes the leave sequence with `fs.writeSync(1, …)` if not yet
   restored) and `SIGTERM`/`SIGHUP` handlers that set `app.exitCode = 0` and wake the loop.
2. Redraws on every `onChange`, coalesced with a `setTimeout(0)`: writes `\x1b[H`, each line followed by `\x1b[K`,
   lines joined with `\r\n`, no newline after the last line (no scroll). In input mode it then positions and shows
   the cursor; otherwise the cursor stays hidden.
3. Starts `app.refresh()` and a `setInterval` of 10 s that calls it; key chunks are decoded and passed to
   `app.handleKey` with errors caught into `app.state.message` (defensive; the app already catches).
4. Resolves with `app.exitCode` once it is set. In `finally`: clears the interval, unsubscribes, raw mode off,
   writes `\x1b[0m\x1b[?25h\x1b[?1049l`, removes the exit handler. Any exception propagates after restoration, so
   `cli.ts`'s `reportError` prints it (exit 2).

**`src/commands/ui.ts`**

```ts
export async function uiCommand(ctx: Ctx): Promise<number>
```

Throws `UserError('mokkan ui needs an interactive terminal.')` when `!ctx.io.isTTY || !ctx.io.tty`. Otherwise
builds `TuiApp` (email from the loaded credentials, or `null` to start on the login screen; host from
`new URL(client.baseUrl).host`; `openUrl` from `ctx.io`), runs `runTerminal` and returns its exit code. The
`Ctx.client` built by `cli.ts` already saves credentials on login and clears them on session expiry, so the TUI
needs no credential handling of its own. A corrupt credentials file is reported exactly as for `mokkan list`.

### Changes to existing files

- `src/cli.ts`: `CliIO` gains `tty?: TerminalIO`; `defaultIO()` builds it from `process.stdin`/`process.stdout`
  (`setRawMode`, `resume`/`pause`, `columns`/`rows` with a 80x24 fallback, the stdout `resize` event); `run()` gets
  `case 'ui'`; `USAGE` gets `mokkan ui  interactive terminal view (needs a terminal)`.
- `src/statusline.ts`: `creditSegments` becomes exported (one-word change); the header reuses it.
- `src/commands/auth.ts`: `EMAIL_RE` becomes exported; the login screen reuses it.
- `src/client.ts` and `src/cli.ts`: the 402 and 429 notes move from `reportError` into the exported
  `apiErrorHint`; `reportError` calls it and prints the same text as before.
- `test/cli-harness.ts`: `RunOptions.tty?: FakeTerminal`; a `FakeTerminal` class implementing `TerminalIO` with
  `type(text)` (buffers until a listener subscribes), `resize(columns, rows)`, and a log of `setRawMode` calls.
- `test/fake-server.ts`: `withAccount` gains `POST /heartbeat`, `GET /reminders/pending`, `POST /reminders/deliver`,
  `POST /reminders/pop`, `POST /reminders/dequeue`, `POST /reminders/ack`, all reading and bumping `acct.version`
  and answering 409 `stale` when `expected_version` mismatches, 404 `empty` when nothing can be popped. Existing
  tests that register their own handlers keep overriding them (`on` replaces by method and path).

### Data flow

```
key bytes ──decodeKeys──▶ Key ──TuiApp.handleKey──▶ state change (+ queued server call)
timer / r ─────────────────────▶ TuiApp.refresh ─▶ heartbeat ∥ list('all') ∥ me ─▶ deliver(due ids)
state change ──onChange──▶ runTerminal redraw ──render(state, size, now)──▶ frame on stdout
```

## Testing

- `test/tui-keys.test.ts`: each recognized sequence, a paste chunk with mixed keys, lone Esc, Esc + unknown bytes,
  control characters dropped.
- `test/tui-text.test.ts`: widths for ASCII, CJK, an emoji with a variation selector, a ZWJ sequence; `fit` and
  padding by width.
- `test/tui-screen.test.ts` (ANSI stripped where content is asserted, kept where tone is asserted): the 80x24
  frame from section 1 line by line; header variants (refreshing, offline with age, low credits); tabs with
  counts; scrolling when the selection passes the window; truncation of text and dropping of the time column on
  a narrow terminal; input mode line and cursor position; confirm line; empty tabs; the too-small screen; that no
  line exceeds the width and the frame has exactly `rows` lines.
- `test/tui-app.test.ts` against `FakeServer.withAccount()`: initial refresh (heartbeat source `ui`, list, me,
  credits in state); push flow; schedule with a bad then a good duration; edit prefilled, unchanged text sends no
  PATCH, changed text sends one with `expected_version`; time change and `clear`; pop and dequeue with `y` and
  with cancel; ack one and all; Tab cycling loads done once; due reminders delivered once and shown as delivered;
  402 message; offline keeps data and sets the header; stale pop refreshes with the message; session expiry clears
  the data and shows the login screen with its message; selection follows the id across a refresh; `b` posts to
  checkout, passes the URL to `openUrl` and shows the link, an untrusted URL is shown but not opened, a 404 gives
  the billing message; the login screen: typing, `Tab` between fields, the password rendered as bullets, an empty
  email or password rejected locally, a wrong password showing the server message and clearing the password, a
  successful login saving credentials (the harness's credentials file exists afterwards), switching to the
  dashboard and refreshing.
- `test/tui-command.test.ts` through `CliHarness`: not a TTY → exit 1 and the message (also via `--exit-zero` on
  stdout, exit 0); logged in with a `FakeTerminal`, typing `q` → exit 0, stdout starts with the enter sequence and
  ends with the leave sequence, raw mode was set on then off; not logged in with a `FakeTerminal` → the first
  frame contains `Log in`, and `Esc` → exit 0 with no request made.
- Existing suites keep passing; `npm run bundle` is rerun so `check:bundle` passes; `npm run typecheck` passes.

## Documentation and packaging

- `README.md`: `mokkan ui` in the Commands block, plus a "Terminal UI" subsection (what it shows, the key table,
  the delivery rule, the login screen, the known limits: no mouse, `register` stays a CLI command, wide-character
  width is best effort, Windows untested).
- `CHANGELOG.md`: a bullet under `0.2.0 — unreleased`.
- `ASSUMPTIONS.md`: entries for the decisions in this spec (subcommand only, hand-rolled rendering, deliver on show,
  10 s refresh, separate `e`/`t` edits, 15 minute overdue rule shared with the status line, login and buy inside
  the TUI with register left to the CLI).
- `claude-plugin/skills/mokkan/SKILL.md` and `claude-command/mokkan.md`: add `mokkan ui` to the commands Claude must
  never run itself (it needs a terminal), keeping both bodies identical except for the run line, as the existing
  test requires. `codex/SKILL.md`: the same one-line note.
- No new dependencies. No version bump (0.2.0 is unreleased). `claude-plugin/scripts/mokkan.mjs` is rebuilt and
  committed.

## Amendments (2026-10-01, after the whole-branch review)

- Pasted text arrives as one `paste` key. Only input fields and the login fields accept it (inserted at the cursor);
  normal mode and confirm mode ignore it.
- A complete escape sequence that is not recognized produces no key; it is not `Esc`.
- The renderer draws into `columns - 1` columns, and the driver clears each line (`\x1b[2K`) before writing it.
- The confirm prompt shortens the reminder text to fit, so `y/n` always shows.
- After a successful `deliver` the list is fetched again and adopted with its version (the version returned by
  `deliver` is not adopted on its own). Nothing is delivered while the Done tab is shown.
- On a stale edit or time change, the input reopens with the typed text.
- Refreshes are deduplicated: a refresh requested while one is queued or running joins it.
- `b` no longer prints the URL on the message line. The messages are `Opened Stripe Checkout in your browser; the
  balance updates after payment.`, `Could not open a browser here. Run: mokkan buy --no-open (prints the link).` and
  `Checkout link is not a Stripe address. Run: mokkan buy --no-open to see it.`; `mokkan buy --no-open` prints the link.
- Input buffers are capped at 2000 code points.
- The flush timer keeps the held text while inside a paste.
