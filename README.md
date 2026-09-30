# mokkan

Cross-session reminders for Claude Code, Codex and your terminal. Push a note from one session and it shows up in the next one, on any machine. Schedule a reminder and it comes back in a session, or by email if you are away. A one-line status bar shows your latest reminder and your credit balance.

```
mokkan push "check the flaky login test"
mokkan in 2h "ask Maria about the release notes"
mokkan                      # the list, top of the stack first
mokkan pop                  # remove the top one (dequeue removes the oldest)
```

Your reminders are stored on the mokkan server (`https://api.mokkan.dev`), so every session and machine you log in from sees the same list.

## Install

mokkan needs **Node.js 20.3 or later**. Choose the channel that matches the tools you use. All channels share the same account and the same local login (`~/.config/mokkan/`).

### Claude Code (plugin)

```
/plugin marketplace add vicmpen/mokkan
/plugin install mokkan@mokkan
```

From a shell, run `claude plugin marketplace add vicmpen/mokkan`, then `claude plugin install mokkan@mokkan`.

The plugin provides:
- **`/mokkan:mokkan <command>`**, for example `/mokkan:mokkan push call the bank` or `/mokkan:mokkan list`. Claude can also invoke it when you ask it to remember something.
- **Hooks**: reminders that are due appear when a session starts and after Claude replies.

The plugin includes its own copy of the CLI, so you don't need the npm package, but `node` (20.3 or later) must be on your PATH: the plugin's command and hooks run the CLI with it. To run `register`, `login` or `buy`, which ask for a password or open a browser, you need a terminal. Use `npx @vicmpen/mokkan-cli …` there, or install the npm package.

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

The npm package contains the same files under `$(npm root -g)/mokkan/codex`. Codex has no hooks, so the skill tells Codex to check for due reminders at the start and end of each task. To see mokkan while you use Codex, set up the tmux status line (see below) and run Codex inside tmux.

### A short `/mokkan` in Claude Code (optional)

Plugin skills are namespaced, so the plugin's command is `/mokkan:mokkan`, and this README writes it that way. If you installed the npm package, you can also get a plain `/mokkan` by copying `claude-command/mokkan.md` from the package or from this repository to `~/.claude/commands/mokkan.md`. That command runs `mokkan` from your PATH and takes the same arguments: `/mokkan list` is `/mokkan:mokkan list`.

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
mokkan pending | done                  due and not yet shown | finished reminders
mokkan balance | buy                   credits
mokkan statusline                      set up the status line (see below)
mokkan ui                              full-screen view with keyboard actions (see below)
```

Add `--json` for machine-readable output. `mokkan help` lists everything.

`mokkan edit` changes one reminder in place. Give it the number shown by `mokkan list` (with `--all`, the number shown by `mokkan list --all`) or an id prefix of at least 4 characters. The new text is the rest of the words: `mokkan edit 2 --in 2h call mom at 5`. `--at` needs a full ISO-8601 time with a zone (`2026-10-01T09:00:00Z`). Put all your changes in one call, because every call counts as one edit. A due time can be changed only while the reminder is still scheduled or due and its email has not been sent. If the list changed since you last read it, a numbered edit stops with "The list changed" and edits nothing.

## Terminal UI

`mokkan ui` opens a full-screen view of your stack in the terminal: the list with each reminder's state and due time, your credit balance, and key hints. It refreshes every 10 seconds and after every action.

| Key | Action |
|---|---|
| `↑` `↓` (or `k` `j`), `Home`, `End` | move the selection |
| `p` | push: type the text, `Enter` sends it (1 credit) |
| `i` | schedule: `2h call the bank`, the first word is a duration |
| `e` | edit the selected reminder's text (one edit) |
| `t` | change its due time: a duration, or `clear` (one edit) |
| `a` / `A` | acknowledge the selected reminder / all |
| `x` / `d` | pop the top / dequeue the bottom, after a `y/n` confirmation |
| `b` | buy credits (opens Stripe Checkout in your browser; if that fails, run `mokkan buy --no-open` for the link) |
| `Tab` | switch between Active, All (adds scheduled) and Done |
| `r` | refresh now |
| `q`, `Ctrl-C` | quit |

Reminders that are due while the view is open count as shown, exactly as when a Claude Code session shows them: acknowledge them with `a`, or their email goes out after the server's grace period. When you are not logged in, `mokkan ui` opens on a login screen; `mokkan register` stays a terminal command. The view needs a real terminal, so it does not work through `/mokkan:mokkan`. It has no mouse support, measures wide characters and emoji as well as it can, and is untested on Windows.

## Credits and pricing

mokkan uses prepaid credits. **€5 buys 500 credits** (1 credit = 1 cent). A new account starts with 50 free credits, and credits never expire.

| Action | Cost |
|---|---|
| `push` | 1 credit |
| `edit` | 1 credit per 3 edits (every 3rd edit is charged) |
| Scheduled reminder email | 1 credit, charged only when the email is actually sent |
| `pop`, `dequeue`, `ack`, `list`, `pending`, `done`, `status`, `balance` | free |

A reminder with a due time keeps 1 credit in reserve for its email until the email is sent or you acknowledge the reminder (`mokkan ack` releases it). So scheduling needs the push cost plus 1 credit for every reminder that is still waiting, plus 1 for the new one. When your balance is too low, a paid command exits with code 3 and tells you to run `mokkan buy`. Reading and acknowledging always stay free.

`mokkan buy` prints a Stripe Checkout link and opens it in your browser (only `https://…stripe.com` links are opened). After you pay, `mokkan balance` shows the new balance and your recent transactions.

## Status line

In Claude Code, run `/mokkan:mokkan statusline` and restart Claude Code. In a terminal, with the npm package installed globally:

```
mokkan statusline            # Claude Code, plus tmux if it is installed
mokkan statusline --dry-run  # show the changes, write nothing
mokkan statusline --remove   # undo
```

Set it up from the plugin or from a global install (`npm install -g @vicmpen/mokkan-cli`), not with `npx @vicmpen/mokkan-cli statusline`: npx runs mokkan from a temporary cache that npm may delete, so mokkan refuses to point a status line there.

- **Claude Code**: the command sets `statusLine` in `~/.claude/settings.json`, or in `$CLAUDE_CONFIG_DIR/settings.json` when that is set. All other settings stay as they are, and a backup `settings.json.mokkan-bak-<time>` is saved first. If you already have a status line that is not mokkan's, the command leaves it alone and shows how to combine the two. `--force` replaces it.
- **tmux and Codex**: Codex's own footer can only show built-in items, so mokkan appears in the tmux status bar. The command adds a marked block to `~/.tmux.conf`, after a backup. To see it, reload with `tmux source-file ~/.tmux.conf` and run Codex inside tmux. If your tmux config sets its own `status-right` or loads plugins through TPM (themes set `status-right` too), mokkan leaves it alone and prints the `#(…)` part to add to your own `status-right`; `mokkan statusline --tmux --force` adds the block anyway, and the block then wins. Use `--tmux` or `--claude` to set up only one of the two.
- From Claude Code (`/mokkan:mokkan statusline`), only Claude Code's status line is set up. Add `--tmux` for the tmux block.
- The status line runs `node` by name when the `node` on your PATH is the one that ran the setup, so a Node upgrade keeps working. Otherwise it runs the absolute path of that Node binary (for example a version-specific nvm path); run the setup again after removing that version.
- When the CLI comes from the Claude Code plugin, it is copied to `~/.local/share/mokkan/mokkan.mjs` and the status line points at that copy. This keeps the status line working when the plugin updates.

`mokkan statusline --render [--format ansi|tmux|plain]` prints the line itself. This is what the status bar runs. Plain `mokkan statusline` sets things up only when stdin is a terminal (or through `/mokkan:mokkan`, or with `--claude`/`--tmux`); a status bar still running an old `mokkan statusline` command gets migrated to `--render`, or shows a one-line hint to run the setup in a terminal.

## Uninstall

Remove the status line first, because it runs mokkan: `/mokkan:mokkan statusline --remove` in Claude Code, or `mokkan statusline --remove` in a terminal. This takes mokkan out of `settings.json` and `~/.tmux.conf` (after backups) and deletes the copy in `~/.local/share/mokkan/`. Then:

- Claude Code plugin: `/plugin uninstall mokkan@mokkan`.
- npm: `npm uninstall -g @vicmpen/mokkan-cli`.
- Your login stays in `~/.config/mokkan/`; `mokkan logout` (or deleting that directory) removes it.

## Privacy

- Your email address, your reminders and your credit transactions are stored on the mokkan server (`api.mokkan.dev`). This lets them sync between sessions and lets scheduled reminders be emailed to you.
- Payments go through Stripe Checkout. mokkan never sees your card details.
- On your machine, mokkan keeps your login tokens in `~/.config/mokkan/credentials.json` (mode 0600) and a short-lived status cache next to it. Hook errors are logged to `hook.log` in the same directory.
- `MOKKAN_SERVER_URL` points the CLI at a different server.

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
  - `hooks/` has the `SessionStart` and `Stop` hooks. They run the plugin's bundle first, then a dev checkout's `dist/cli.js`, then `mokkan` from PATH.
  - `skills/mokkan/SKILL.md` is `/mokkan:mokkan`. It runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/mokkan.mjs"` through `!` bash expansion (quoted, so a plugin path with spaces works; the `allowed-tools` rule carries the same quotes).
  - `scripts/mokkan.mjs` is the bundled CLI. It is committed because plugins are installed straight from git.
  - Check the plugin with `claude plugin validate .` and `claude plugin validate claude-plugin`.
- `claude-command/mokkan.md` is the same command as a user-level `/mokkan` that runs `mokkan` from PATH. A test checks that its instructions match the plugin skill's.
- `codex/SKILL.md` is the Codex skill.
- `install.sh` sets up a dev checkout. It runs `npm ci` and the build, then links `~/.local/bin/mokkan`, `~/.codex/skills/mokkan` and `~/.claude/commands/mokkan.md`, and prints the `claude --plugin-dir` command.
  - It only creates or refreshes symlinks that point into this checkout. Any other file at those paths is left alone with a `warning: ... is not ours; skipped` line.
  - `MOKKAN_INSTALL_SKIP_BUILD=1` skips the install and build steps.
- `ASSUMPTIONS.md` records every decision and the reason for it.

Releases: keep `version` in `package.json` equal to the one in `claude-plugin/.claude-plugin/plugin.json`, because plugin users stay on a version until it changes. A test checks this. `npm publish` runs the build, typecheck, tests and bundle check first.

### `/mokkan` and shell quoting

The slash command runs `mokkan --argline "$ARGUMENTS" --exit-zero 2>&1`. Claude Code pastes the arguments into that line as text, so they end up inside double quotes. That means `'`, `#`, `*`, `>`, `&`, `;`, `|` and parentheses pass through literally, and the CLI splits the string on whitespace itself (runs of spaces become one space). Inside double quotes the shell still interprets four characters: `$`, `` ` ``, `"` and `\`. Don't use them in `/mokkan` text. For reminders that need them, use `mokkan push ...` in a terminal.

`--exit-zero` makes every failure print on stdout and exit 0, because Claude Code aborts a slash command whose `!` command exits non-zero. This covers an empty `pop`, being logged out and the server being down. Hooks always exit 0, so they can never block a session.

For a local dev server, set `MOKKAN_SERVER_URL=http://127.0.0.1:8787`.
