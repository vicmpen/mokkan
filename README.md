<h1><img src="assets/banner.svg" width="960" alt="mokkan"></h1>

**A [Claude Code mod](https://claude.dev/blog/getting-started-with-claude-code-mods/#four-habits-worth-keeping) for reminders that follow you between agent sessions.** mokkan docks your reminder stack in a pane beside the Claude Code transcript, and the same list reaches every other session you open: Claude Code, Codex and any terminal, on any machine. Push a note in one session; it surfaces in the next one and stays there until you say you've seen it.

```
/plugin marketplace add vicmpen/mokkan
/plugin install mokkan@mokkan
```

Then `/mokkan` opens the pane, and closes it again; `/mokkan push call the bank` runs a command straight away. New to mods? Read [Getting started with Claude Code mods](https://claude.dev/blog/getting-started-with-claude-code-mods/).

## One push. Every session.

The server (`https://api.mokkan.dev`) keeps the only copy of your list. Each session asks it what's due, not the model remembering to check, so a note pushed on your laptop shows up on your desktop within seconds:

- **The pane** (`/mokkan`) in Claude Code lists it on its next refresh, every 15 seconds while it's open, and a scheduled reminder that comes due while it's open arrives as a toast. Nothing is injected into the conversation.
- **Codex** checks at the start and end of every task, through the mokkan skill.
- **Any terminal** has the same list: `mokkan` prints it, `mokkan ui` opens it full-screen.

```
mokkan push "check the flaky login test"
mokkan in 2h "ask Maria about the release notes"
mokkan                      # the list, top of the stack first
mokkan pop                  # remove the top one (dequeue removes the oldest)
```

Acknowledge once, from any session, and every session knows. A pop is a single atomic step on the server, so two sessions can never take the same item, and a popped item moves to `done` instead of disappearing.

## Nothing closes until you say so.

Showing a reminder doesn't mean you saw it. mokkan keeps it lit until you acknowledge it, and a scheduled reminder that nobody acknowledges, or that comes due while no pane is open, is emailed to you. Todos (no due time) are never toasted or emailed.

| State | What it means |
|---|---|
| scheduled | `mokkan in 1h30m …` waits on the server, off the list, until its time comes. |
| due | On the list and unseen. An open pane shows it as a toast within 15 seconds. With no pane open, it goes out by email. |
| delivered | Shown as a toast in the pane. If no ack comes, the email goes out anyway. |
| acknowledged | You've seen it. It stays on the stack until you pop, dequeue or finish it. |

### When is a reminder emailed?

Only a reminder with a due time is ever emailed, and at most once. An open pane tells the server that a session is active each time it refreshes.

| When it comes due | What happens |
|---|---|
| A pane is open | The pane shows it as a toast within 15 seconds. If you haven't acknowledged it 3 minutes after the toast, it is emailed. |
| No pane has been open in the last 5 minutes | The server waits 5 minutes after the due time. If a pane opens in that window, it shows the toast and the case above applies. Otherwise it is emailed 5 minutes after the due time. |
| You acknowledge it first (pane `a`, `mokkan ack`, Codex) | No email, and the credit held for it is given back. |

The timings are the server's defaults. If you run your own server, they are `ACK_GRACE_SECONDS` (180), `HEARTBEAT_ACTIVE_SECONDS` (300) and `NO_SESSION_EMAIL_DELAY_SECONDS` (300). Codex and the terminal (`mokkan`, `mokkan ui`) read the same list; Codex checks at the start and end of each task through its skill.

## The mod: a pane in Claude Code

The plugin ships a [mod](https://claude.dev/blog/getting-started-with-claude-code-mods/): a small TypeScript module that runs inside your Claude Code session, sees its events as they happen, and draws a pane. `/mokkan` opens it, and closes it when it is open. In the fullscreen layout (`/tui fullscreen`, the default in most terminals) the pane docks beside the transcript from 110 columns and opens by itself when a session starts; on the main-screen layout it sits above the prompt. `Esc` hands the keyboard back and `ctrl+x tab` takes it again. While the pane has the keyboard, a key it doesn't use does nothing instead of landing in the prompt.

It is laid out like `mokkan ui`: the header with your credits, `TODOs 2 │ Reminders 3 │ Archived 4`, the list, the last result, the keys, and the sync state on the bottom line. The pane draws its own rounded border, pale green while it has the keyboard and grey while it doesn't. Three tabs, each with its own count: TODOs holds the open todos (no due time), Reminders the open reminders (a due time, scheduled ones included), both in stack order, and Archived the finished ones. The pane opens on Reminders while one is due, and on TODOs otherwise. A row's bar is cyan for a todo and magenta for a reminder; `·` marks an acknowledged one and `✓` an archived one. Rows are numbered within their tab. A reminder's time sits on the right and always says which way it points: `in 40m`, `Wed 17:00`, `overdue 40m` (red), `2h ago`. The selected row gets its history underneath (`todo · added 3h ago · shown 1h ago · acked 5m ago`). `↑` `↓` and `Tab` walk the pane's buttons, and the row they land on is selected, marked with `▸` and bold; a click or a row's number selects it directly. Rows past the ninth are typed as two digits within a second (`1` then `2` is row 12), and with ten or more rows `0` joins the keys for rows 10, 20 and so on. Selecting never changes anything. While the pane doesn't have the keyboard it shows `ctrl+x tab to use keys` in place of the commands:

| Key | Label | Action |
|---|---|---|
| `t` | `todo` | add a todo: type what to remember (1 credit) |
| `r` | `reminder` | schedule a reminder: `2h call the bank`, the first word is a duration (1 credit, +1 held for the email) |
| `e` | `edit` | edit the selected one's text (every 3rd edit costs 1 credit) |
| `w` | `when` | set its due time (`2h`), or `clear` it to make it a todo again |
| `d` | `archive` / `reopen` | archive it (`mokkan done`); in Archived, reopen it |
| `a` | `ack` | acknowledge it: you've seen it, so its email stops |
| `v` | `view reminders` / `view archived` / `view todos` | go to the next tab, TODOs → Reminders → Archived; a click on a tab goes straight to it |
| `b` | `buy` | open Stripe Checkout in your browser to add credits (not on mobile) |
| `s` / `l` / `q` | `sync` / `log out` / `close` | sync now / log out / close the pane |
| `h` | `help` / `back` | show what mokkan is, the glyphs, ack vs archive, and the costs in place of the list; `h` again goes back |
| `l` / `r` | `log in` / `register` | when logged out (the password is masked) |

Archiving with `Enter` and logging out ask first, naming what they act on and what each answer does: `archive "call the bank"?`, with `y: archive · n: keep` underneath. While a command runs, other keys wait. The line above the commands shows each result with the reminder it touched (`added · call mom`, `due in 2h · call the bank`). The pane stays on its tab: a new or changed one that belongs on another tab says where it went (`added to TODOs · call mom`, `moved to Reminders, due in 2h · renew the cert`), errors start with `error:` in red and wrap so the fix at their end (`Run: mokkan buy`) stays readable, and the line clears itself after 15 seconds. The header's balance turns yellow under 10 credits (`· 7 credits · low`) and red at 0; `b` opens Stripe Checkout to add more. When the server can't be reached the pane keeps the last list and marks it `offline · synced 12:04`, the time of the last good sync; online the bottom line reads `synced 12:04`, and while a command runs it names it (`archiving…`).

The mod runs the plugin's own copy of the CLI and polls the server every 15 seconds while it is open and after every action. Each poll tells the server a session is active, and every reminder with a due time that has come due is shown as a toast and marked delivered. Todos are never toasted. Mods ship inside plugins, so there is nothing extra to install: the plugin's `hooks/hooks.json` names the module under `modules`, and that is all it holds.

## Install

mokkan needs **Node.js 20.3 or later**. Choose the channel that matches the tools you use. All channels share the same account and the same local login (`~/.config/mokkan/`).

### Claude Code (plugin)

```
/plugin marketplace add vicmpen/mokkan
/plugin install mokkan@mokkan
```

From a shell, run `claude plugin marketplace add vicmpen/mokkan`, then `claude plugin install mokkan@mokkan`.

The plugin provides:
- **`/mokkan`**: on its own it opens the pane (see below), and closes it when it is open. With a command it runs it and prints the output straight away, without a model turn: `/mokkan push call the bank`, `/mokkan in 2h stretch`, `/mokkan list`. `ui` and `watch` need a terminal, and `login` and `register` are done in the pane (`l`, `r`) or a terminal.
- **The mokkan skill**: Claude uses it when you ask it in words to remember something or to change a reminder. The slash-command menu lists `/mokkan` under the skill's full name, `/mokkan:mokkan`; typed, the two are the same.
- **A mod**: the pane, with your stack beside the transcript and the same actions as `mokkan ui` (see below).

The plugin includes its own copy of the CLI, so you don't need the npm package, but `node` (20.3 or later) must be on your PATH: the plugin's command and pane run the CLI with it. To run `register`, `login` or `buy`, which ask for a password or open a browser, you need a terminal. Use `npx @vicmpen/mokkan-cli …` there, or install the npm package.

### Terminal (npm)

```
npm install -g @vicmpen/mokkan-cli
mokkan help
```

### Codex (skill)

Install the CLI with `npm install -g @vicmpen/mokkan-cli`, then copy or link the skill directory from this repository:

```
git clone https://github.com/vicmpen/mokkan
mkdir -p ~/.codex/skills
cp -r mokkan/codex ~/.codex/skills/mokkan
```

The npm package contains the same files under `$(npm root -g)/mokkan/codex`. Codex has no hooks, so the skill tells Codex to check for due reminders at the start and end of each task.

### `/mokkan-cli` without the plugin (optional)

`/mokkan` is the plugin's. In sessions that don't load the plugin, the npm package gives you `/mokkan-cli`: copy `claude-command/mokkan-cli.md` from the package or from this repository to `~/.claude/commands/mokkan-cli.md`. It runs `mokkan` from your PATH through Claude and takes the same arguments as `/mokkan`: `/mokkan-cli push call the bank`. Don't name it `mokkan.md`: a user-level `/mokkan` hides the plugin's from the slash-command menu.

## Account

```
mokkan register you@example.com     # emails you a code, then asks for a password (10+ characters)
mokkan login you@example.com
mokkan logout
mokkan status                       # who you are, server, balance
```

Registration and login ask for a password without showing it, so run them in a terminal. When you try them from Claude Code, the command only prints the terminal command you need.

## Commands

```
mokkan [list] [--all]                  active list, top first (--all adds scheduled reminders)
mokkan push <text>                     add to the top
mokkan pop | dequeue                   remove from the top (LIFO) | from the bottom (FIFO)
mokkan in <duration> <text>            schedule: 30s, 10m, 2h, 1d, 1h30m
mokkan edit <n|id> [--all] [--in 2h | --at <iso> | --clear-due] [new text...]
mokkan ack <id...> | all               acknowledge reminders you have seen
mokkan done <id...> | undone <id...>   finish reminders anywhere on the list (like pop, by id) | reopen finished ones
mokkan pending | done                  due and not yet shown | finished reminders
mokkan balance | buy                   credits
mokkan feedback <text>                 send feedback to the mokkan developer (free)
mokkan ui                              full-screen view with keyboard actions (see below)
```

Add `--json` for machine-readable output. `mokkan help` lists everything.

Acknowledging and finishing are different acts. `mokkan ack` says "seen": it stops the email for a due reminder and releases its reserved credit, but the reminder stays on the list. `mokkan done <id>` finishes a reminder anywhere on the list, exactly as `pop` finishes the top one; it moves to the history that `mokkan done` shows. `mokkan undone <id>` puts a finished reminder back where it was. A reopened reminder that had a due time comes back acknowledged, so it is never emailed again. Both are free.

`mokkan edit` changes one reminder in place. Give it the number shown by `mokkan list` (with `--all`, the number shown by `mokkan list --all`) or an id prefix of at least 4 characters. The new text is the rest of the words: `mokkan edit 2 --in 2h call mom at 5`. `--at` needs a full ISO-8601 time with a zone (`2026-10-01T09:00:00Z`). Put all your changes in one call, because every call counts as one edit. A due time can be changed only while the reminder is still scheduled or due and its email has not been sent. If the list changed since you last read it, a numbered edit stops with "The list changed" and edits nothing.

## Terminal UI

`mokkan ui` opens a full-screen view of your stack in the terminal: the same three tabs as the pane (`TODOs │ Reminders │ Archived`; Reminders includes scheduled ones, and it opens on Reminders while one is due), your credit balance, and key hints. Todos (pushed, no due time) show `□`; reminders with a due time show `◷` scheduled, `●` due (yellow), `○` shown, `·` acknowledged, with the time on the right (`in 40m`, `17:00`, `Wed 17:00`, `12 Oct`, `overdue 40m` in red, `40m ago`). The selected row has a detail line under it (`todo · added 3h ago · shown 1h ago · acked 5m ago`). It refreshes every 10 seconds and after every action. The footer uses the pane's labels (`t todo · r reminder · … · p pop top · o pop oldest`).

| Key | Action |
|---|---|
| `↑` `↓`, `Home`, `End`, `1`–`9` | move the selection (selecting never changes anything) |
| `t` | add a todo: type what to remember, `Enter` adds it (1 credit) |
| `r` | schedule a reminder: `2h call the bank`, the first word is a duration |
| `e` | edit the selected one's text (every 3rd edit costs 1 credit) |
| `w` | set its due time: a duration (turns a todo into a reminder), or `clear` to make it a todo again |
| `d` | archive the selected one (`mokkan done`); in Archived, reopen it (the footer says `reopen` there) |
| `a` / `A` | acknowledge the selected one / all |
| `v`, `Tab` | go to the next tab: TODOs → Reminders → Archived. `t`, `r` and `w` leave you where you are; the message says when the item went to another tab (`→ Reminders`) |
| `p` / `o` | pop top / pop oldest (`mokkan pop` / `mokkan dequeue`), after a confirmation that names the reminder: `y: pop  n: keep` |
| `s` | sync now |
| `b` | buy credits (opens Stripe Checkout in your browser; if that fails, run `mokkan buy --no-open` for the link) |
| `q`, `Ctrl-C` | quit |

Due ones on the tab you are looking at count as shown: acknowledge them with `a`, or their email goes out after the server's grace period. When you are not logged in, `mokkan ui` opens on a login screen; `mokkan register` and `mokkan logout` stay terminal commands. The view needs a real terminal, so it does not work through `/mokkan:mokkan`. It has no mouse support, measures wide characters and emoji as well as it can, and is untested on Windows.

## Credits and pricing

mokkan uses prepaid credits. **€5 buys 500 credits** (1 credit = 1 cent). A new account starts with 50 free credits, and credits never expire.

| Action | Cost |
|---|---|
| `push` | 1 credit |
| `edit` | 1 credit per 3 edits (every 3rd edit is charged) |
| Scheduled reminder email | 1 credit, charged only when the email is actually sent |
| `pop`, `dequeue`, `done`, `undone`, `ack`, `list`, `pending`, `status`, `balance` | free |

A reminder with a due time keeps 1 credit in reserve for its email until the email is sent or you acknowledge the reminder (`mokkan ack` releases it). So scheduling needs the push cost plus 1 credit for every reminder that is still waiting, plus 1 for the new one. When your balance is too low, a paid command exits with code 3 and tells you to run `mokkan buy`. Reading and acknowledging always stay free.

`mokkan buy` prints a Stripe Checkout link and opens it in your browser (only `https://…stripe.com` links are opened). After you pay, `mokkan balance` shows the new balance and your recent transactions.

## Uninstall

If you set up the status line that 0.2.0 offered, remove it first, because it runs mokkan: `mokkan statusline --remove` in a terminal (or `/mokkan statusline --remove`). This takes it out of `settings.json` and `~/.tmux.conf` after backups and deletes the copy in `~/.local/share/mokkan/`. Then:

- Claude Code plugin: `/plugin uninstall mokkan@mokkan`.
- npm: `npm uninstall -g @vicmpen/mokkan-cli`.
- Your login stays in `~/.config/mokkan/`; `mokkan logout` (or deleting that directory) removes it.

## Privacy

- Your email address, your reminders and your credit transactions are stored on the mokkan server (`api.mokkan.dev`). This lets them sync between sessions and lets scheduled reminders be emailed to you.
- Payments go through Stripe Checkout. mokkan never sees your card details.
- On your machine, mokkan keeps your login tokens in `~/.config/mokkan/credentials.json` (mode 0600). Hook errors are logged to `hook.log` in the same directory.
- `MOKKAN_SERVER_URL` points the CLI at a different server.

## Why "mokkan"

[*Mokkan*](https://en.wikipedia.org/wiki/Mokkan) (木簡) are the thin wooden slips that clerks in 7th- and 8th-century Japan used for notes, labels and records. When a slip had done its job, they shaved the surface clean and wrote the next note on the same wood.

The terminal has kept that habit for fifty years: small plain-text tools that do one job and stay out of the way. mokkan is a slip for the age of agents. One line of text, an id in square brackets, and gone when you're done with it.

## Support

Contact and support: <info@mokkan.dev>. You can also open an issue at https://github.com/vicmpen/mokkan/issues.

## License

MIT. See [LICENSE](LICENSE).

---

## Development

```
npm ci
npm test               # vitest
npm run typecheck
npm run build          # tsc -> dist/ (the npm package's bin)
npm run bundle         # esbuild -> claude-plugin/scripts/mokkan.mjs (commit it)
npm run check:bundle   # fails if the committed bundle is stale (also a test)
```

- `src/` holds the `mokkan` CLI, written in TypeScript with no runtime dependencies.
- `claude-plugin/` is the Claude Code plugin, and `.claude-plugin/marketplace.json` makes this repository its marketplace.
  - `hooks/pane.tsx` is the mod: a hooks module exporting `register(on, options)`, named under `modules` in `hooks/hooks.json`. It answers `/mokkan`: the engine keeps that bare name for the plugin's skill and runs a typed `/mokkan` as `/mokkan:mokkan`, so the mod registers no command and hooks `command.run` on the skill's name instead (and on a user-level `/mokkan`, should one exist). It hooks `session.start`, `command.run`, `ui.render`, `ui.focus` and `prompt.edit` (to drop a key that leaves the focused pane), keeps its values in `$.state` under the contract in `types/index.d.ts`, and runs the CLI through `$.process.run`. `npm run test:plugin` runs `claude plugin validate` and `claude plugin test` on it (`tests/pane.test.tsx`); vitest does not load it. While developing, `claude --plugin-dir claude-plugin` loads it with hot reloading: every save reloads the module in place.
  - `skills/mokkan/SKILL.md` is the skill. A typed `/mokkan` never reaches its text (the mod answers it), so it runs only when Claude invokes it. It runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/mokkan.mjs"` through `!` bash expansion (quoted, so a plugin path with spaces works; the `allowed-tools` rule carries the same quotes).
  - `scripts/mokkan.mjs` is the bundled CLI. It is committed because plugins are installed straight from git.
  - Check the plugin with `claude plugin validate .` and `claude plugin validate claude-plugin`.
- `claude-command/mokkan-cli.md` is the skill's command as a user-level `/mokkan-cli` that runs `mokkan` from PATH, for sessions without the plugin. A test checks that its instructions match the plugin skill's.
- `codex/SKILL.md` is the Codex skill.
- `install.sh` sets up a dev checkout. It runs `npm ci` and the build, then links `~/.local/bin/mokkan`, `~/.codex/skills/mokkan` and `~/.claude/commands/mokkan-cli.md` (removing its old `~/.claude/commands/mokkan.md` link), and prints the `claude --plugin-dir` command.
  - It only creates or refreshes symlinks that point into this checkout. Any other file at those paths is left alone with a `warning: ... is not ours; skipped` line.
  - `MOKKAN_INSTALL_SKIP_BUILD=1` skips the install and build steps.
- `ASSUMPTIONS.md` records every decision and the reason for it.

Releases: keep `version` in `package.json` equal to the one in `claude-plugin/.claude-plugin/plugin.json`, because plugin users stay on a version until it changes. A test checks this. `npm publish` runs the build, typecheck, tests and bundle check first.

### Shell quoting

A typed `/mokkan` hands its text to the CLI as one argument, with no shell in between, so any text works there. When Claude runs the skill, and with `/mokkan-cli`, the command runs `mokkan --argline "$ARGUMENTS" --exit-zero 2>&1`. Claude Code pastes the arguments into that line as text, so they end up inside double quotes. That means `'`, `#`, `*`, `>`, `&`, `;`, `|` and parentheses pass through literally, and the CLI splits the string on whitespace itself (runs of spaces become one space). Inside double quotes the shell still interprets four characters: `$`, `` ` ``, `"` and `\`. Don't use them in `/mokkan` text. For reminders that need them, use `mokkan push ...` in a terminal.

`--exit-zero` makes every failure print on stdout and exit 0, because Claude Code aborts a slash command whose `!` command exits non-zero. This covers an empty `pop`, being logged out and the server being down.

For a local dev server, set `MOKKAN_SERVER_URL=http://127.0.0.1:8787`.
