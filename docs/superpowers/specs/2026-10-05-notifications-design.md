# Shell and desktop notifications

Date: 2026-10-05 (revised after review). Repo: `mokkan` (CLI). No server change: verified against
`mokkan-server` (`GET /reminders/pending` in `src/reminders/service.ts:231-240` has no side effects beyond an in-memory
rate-limit counter; the scheduler moves `scheduled` to `due` within 15 s, `src/delivery/scheduler.ts:86-87`).
This document is private (A42): `tools/export-public.sh` leaves out `docs/`.

## Goal

A scheduled reminder (`mokkan in …`) that has fired and is not yet acknowledged reaches the user wherever they are
working, without Claude Code open:

- **Shell:** every open interactive zsh, bash or fish shell prints fired, unacknowledged scheduled reminders at its next
  prompt, both locally and over SSH. This replaces the hand-written zsh `precmd` snippet with a supported,
  installable version.
- **Desktop:** on a machine with a graphical session (macOS, or Linux with a running notification service), a native
  notification pops up within about a minute of a reminder firing, even with no terminal open.
- **Over SSH (opt-in):** the remote shell sends a terminal notification escape (OSC 9/777/99) so the *local*
  terminal emulator shows a desktop notification on the user's laptop.
- Each channel can be turned off in a config file or with `mokkan notify off`, and `MOKKAN_NOTIFY=0` silences everything.
- Adding a new shell, desktop backend or service manager is a small, self-contained PR with a contract test.

## Decisions

| Decision | Choice |
|---|---|
| Delivery semantics **[user]** | Read-only. Notifications call `GET /reminders/pending` only: no heartbeat, no `deliver` (the rule A32 set for the status line, retired with it by A51). An unacknowledged scheduled reminder still escalates to email, so a notification nobody saw loses nothing |
| What to install **[user]** | `mokkan notify setup` detects the platform and whether a GUI session exists, then installs the best available setup: a launchd agent on macOS, a systemd `--user` timer on Linux with a GUI and systemd, XDG autostart on Linux with a GUI but no systemd, and only the shell hook on a headless machine |
| Shells **[user]** | zsh, bash (including macOS's bash 3.2) and fish. Each is one adapter file; other shells are left to contributors |
| SSH terminal escape **[user]** | Opt-in (`osc` setting), off by default. When on, the shell emits it only when `$SSH_CONNECTION` is set |
| Contributions **[user]** | Backends, shells and agents are registries of small modules with a shared contract test, plus a public `CONTRIBUTING.md` section, a PR template and `mokkan notify doctor` output for bug reports |
| Which reminders notify **[user]** | Only scheduled reminders (`due_at` set, i.e. made with `mokkan in` or `edit --in/--at`) whose time has passed and that are not acknowledged: `pending.due` ∪ `pending.awaiting_ack`, filtered to `due_at !== null && due_at <= now`. Plain `push` items never notify. A reminder already shown in a Claude session or emailed (`delivered`) still counts until it is acked. `mokkan ack` is the only thing that silences it |
| Which shells print **[user, recommended]** | Every open shell, once per change of the set: each shell remembers what it last printed in a shell variable, not a shared file. A new tab prints the current set at its first prompt; acking one makes every shell print the remaining set once |
| Poll rate | At most one `pending` call per machine per `interval` (default 60 s, minimum 30 s). The agent and every shell share one stamp, which records the time of the last *attempt* (A30 precedent), so a server that is down is retried once per interval, not on every prompt |
| Where state lives | `$XDG_CONFIG_HOME/mokkan/notify/`, directory 0700 and files 0600. It holds reminder text, so it sits next to the credentials rather than in `~/.cache`. `logout`, session expiry and `delete-account` remove the reminder text in it (`removeNotifyState`, also called by `removeAccountFiles`); the generated `init.<shell>` scripts stay, so the hook resumes after the next login |
| Shell cost | The prompt hook runs no `node` unless the stamp is older than `interval`, and then only in the background, detached from the terminal (`</dev/null`, `&!` / `( … & )` / `disown`). On other prompts it reads two small files |
| Shell install | The rc file gets a marked block (`# >>> mokkan notify >>>` … `<<<`) that sources a generated file `notify/init.<shell>`. fish gets `~/.config/fish/conf.d/mokkan.fish` and its rc is never edited. `mokkan shell init <shell>` prints the snippet for people who manage dotfiles by hand |
| A stable CLI path | The agent and the snippet bake in absolute `node` and `cli.js` paths. `setup` refuses when the running CLI lives in the Claude plugin cache (`…/plugins/cache/…`) or npm's `_npx` cache, which change on every update (the rule A45 had for the status line), and asks for `npm i -g @vicmpen/mokkan-cli` (or `install.sh`'s `~/.local/bin/mokkan`) |
| OS permission ("approved") | Two layers. (1) mokkan's own consent: `setup` asks y/N before enabling desktop notifications, and the answer is stored in the config. (2) The OS: on macOS, notifications from `osascript` are attributed to Script Editor, macOS can block them silently, and nothing can query that permission. `setup` and `notify test` therefore send a test notification through each available backend and ask "Did you see it?". On "no", they try the next backend, then print where to allow it (System Settings → Notifications → Script Editor, or install `terminal-notifier`). Linux has no permission layer |

## Config

`$XDG_CONFIG_HOME/mokkan/config.json` (new, 0600; created only by `notify setup`, `notify on` or `notify off`):

```json
{
  "notifications": {
    "shell": true,
    "desktop": true,
    "osc": "off",
    "interval": 60
  }
}
```

- `osc`: `"off" | "auto" | "9" | "777" | "99"`. The choice and the tmux wrapping happen in the shell at print time,
  not in `poll` (which may run under launchd or systemd without `TERM` or `TMUX`). `auto` picks from the shell's own
  `$TERM`/`$TERM_PROGRAM` (`xterm-kitty` → 99, `foot*` → 777, otherwise 9). Over SSH `TERM_PROGRAM` is usually not
  forwarded, so `auto` mostly means OSC 9; the README's terminal table says so. Inside tmux the sequence is wrapped in
  DCS passthrough, and `doctor` warns when `allow-passthrough` is off.
- `interval` and `osc` are baked into the generated `init.<shell>`, which is regenerated by `setup`, `on`, `off`, and
  by `poll` when the version line differs.
- A missing file or key uses the defaults above, with `desktop` false until the user consents.
- A corrupt file is logged at most hourly (like `hook.log`) and everything falls back to off; the prompt never shows
  an error.
- `MOKKAN_NOTIFY=0` disables every channel: the snippet checks it before starting `node`, and `poll` checks it too.

## Commands

| Command | Does |
|---|---|
| `mokkan notify setup` | Terminal only: refused without a TTY and with `--exit-zero` (both checks, like `accept`, `src/commands/privacy.ts:61-63,80`), so `/mokkan` cannot run it. Refuses an unstable CLI path. Detects shell, OS and GUI; prints the plan; asks before each step: rc block, agent, desktop consent, test notification, OSC opt-in when `$SSH_CONNECTION` is set. Idempotent: an identical rc block or agent file is left untouched (no new backup); a loaded launchd agent is `bootout`-ed before `bootstrap` |
| `mokkan notify remove` | Same terminal-only rule. Removes the rc block (one backup), the fish conf.d file, the agent and the `notify/` state; files without mokkan's marker are left alone with a warning. Keeps `config.json` |
| `mokkan notify on\|off [shell\|desktop\|osc]` | Flips config keys and regenerates `init.<shell>`. With no channel it flips all of them. Installs and uninstalls nothing. Allowed from `/mokkan` |
| `mokkan notify status` | Config, what is installed, last poll time and result, the backend that would be used. `--json` (global flag) supported. Allowed from `/mokkan` |
| `mokkan notify test` | Sends "mokkan: test notification" through every enabled channel; on a TTY, asks per backend whether it appeared. Allowed from `/mokkan` (without the question) |
| `mokkan notify doctor` | `status` plus the detection inputs (OS, `XDG_SESSION_TYPE`, `DISPLAY`/`WAYLAND_DISPLAY`, session bus, whether `org.freedesktop.Notifications` is owned, `systemctl --user` reachability, notifier binaries, `TERM`/`TERM_PROGRAM`, tmux passthrough) and whether the node and cli paths baked into the agent and snippet still exist. User name, host name and home path are redacted. Formatted to paste into an issue. Allowed from `/mokkan` |
| `mokkan notify poll [--loop]` | Internal (agent and shell hook). Dispatched in `run()` before any credential loading or `reportError`, like `hook` (`src/cli.ts:305`): it never prints and always exits 0, logging failures through `safeAppendHookLog` |
| `mokkan shell init zsh\|bash\|fish` | Prints the hook snippet to stdout |

## Architecture

```
src/notify/
  config.ts        load/save config.json, defaults, MOKKAN_NOTIFY
  state.ts         notify/ dir: stamp, poll.lock, shell.txt, osc.txt, notified.json (atomic writes, 0600)
  poll.ts          one poll: lock + stamp → client.pending() → notifiable() → shell files → desktop for new ids
  detect.ts        Platform facts (os, gui, systemd, ssh, wsl, tmux) from env + probes; pure given a Probe
  sanitize.ts      strip C0/C1 controls, ESC, BEL, bidi overrides; clamp length
  backends/        desktop notifiers  { name, platforms, available(p), argv(title, body) }
    macos-terminal-notifier.ts, macos-osascript.ts,
    linux-notify-send.ts, linux-gdbus.ts, linux-kdialog.ts, index.ts (ordered registry)
  agents/          background schedulers { name, applies(p), install(ctx), remove(ctx), installed(ctx) }
    launchd.ts, systemd-user.ts, xdg-autostart.ts, index.ts
  shells/          { name, rcFile(env, platform), snippet(opts): string, installStyle: 'rc-block' | 'drop-in' }
    zsh.ts, bash.ts, fish.ts, index.ts
src/rcfile.ts      marked-block insert/remove with backup (moved out of statusline-remove.ts; skips the write,
                   and the backup, when the content would not change)
src/commands/notify.ts  setup / remove / on / off / status / test / doctor / poll / shell init
```

### Poll (`poll.ts`)

1. If `MOKKAN_NOTIFY=0`, or every channel is off: empty `shell.txt` and `osc.txt`, then return.
2. Take `poll.lock` (`O_EXCL`; a lock older than 30 s is stale and removed). If another process holds it, return.
   Read `stamp`; if it is younger than `interval`, release the lock and return. Otherwise write the current epoch
   seconds to `stamp` atomically (temp file + rename) *before* any network call, so a slow or failing server
   cannot make every prompt start `node`.
3. Call `client.pending()`. On failure:
   - no credentials or session expired: empty `shell.txt`, `osc.txt` and `notified.json`, since the reminder text is no
     longer the user's to show;
   - `privacy_not_accepted`: `shell.txt` becomes the single line `privacy policy updated: run mokkan accept in a
     terminal` (printed once per shell), `osc.txt` is emptied, no desktop notification;
   - network error, 5xx or 429: keep the files as they are.
   Every failure is logged at most hourly through `safeAppendHookLog` (`src/hooks.ts:89-96`).
4. `notifiable(pending, now)` (pure): reminders from `due` and `awaiting_ack` with `due_at` set and `<= now`,
   deduplicated by id, ordered by `due_at`, oldest first.
5. Shell files, written atomically:
   - `shell.txt`: one line per reminder, `- [<short id>] <text> (due <local time>)`. The local time is `HH:MM` for
     today and `ddd HH:MM` or a date otherwise, so the file only changes when the set changes. A relative time
     ("5m ago") would change every poll and make every shell reprint every minute.
   - `osc.txt`: the sanitized reminder text only, one line per reminder. The shell builds the escape sequence.
   - Both files are empty when nothing is notifiable.
6. Desktop: for each notifiable id not marked done in `notified.json`, call the first available backend with
   (`mokkan`, text, `due <local time>`). More than 3 new ids become one summary notification ("4 reminders due").
   An id is marked done only when the backend exits 0. A failure increments its attempt count, and it is given up
   after 3 attempts, so a notification daemon that is not up yet (for example the timer's first run at boot) does
   not lose the popup. Ids that are no longer notifiable are pruned.
7. Never send a heartbeat and never call `deliver`.
8. Overall timeout 10 s; a notifier is killed after 3 s. The lock is released in `finally`.

### Shell snippet (zsh shown; bash and fish follow the same steps)

Generated from `shells/zsh.ts` with the absolute paths and settings baked in. Shown with `osc: "9"`; with
`osc: "off"` the OSC part is not generated at all.

```zsh
# generated by mokkan 0.8.0 (interval 60, osc 9); regenerate with: mokkan notify setup
[[ -o interactive ]] || return 0
zmodload zsh/datetime
typeset -g __mokkan_dir=${XDG_CONFIG_HOME:-$HOME/.config}/mokkan/notify __mokkan_shown=
__mokkan_precmd() {
  [[ ${MOKKAN_NOTIFY-} == 0 ]] && return
  local last= cur= line
  [[ -r $__mokkan_dir/stamp ]] && last=$(<$__mokkan_dir/stamp)
  [[ $last == <-> ]] || last=0
  (( EPOCHSECONDS - last >= 60 )) && { '/usr/bin/node' '/usr/lib/node_modules/@vicmpen/mokkan-cli/dist/cli.js' notify poll </dev/null >/dev/null 2>&1 &! }
  [[ -r $__mokkan_dir/shell.txt ]] && cur=$(<$__mokkan_dir/shell.txt)
  [[ $cur == "$__mokkan_shown" ]] && return
  __mokkan_shown=$cur
  [[ -n $cur ]] || return
  print -P '%F{magenta}mokkan:%f'; print -r -- "$cur"
  if [[ -n $SSH_CONNECTION && -r $__mokkan_dir/osc.txt ]]; then
    while IFS= read -r line; do
      if [[ -n $TMUX ]]; then printf '\ePtmux;\e\e]9;%s\a\e\\' "$line"; else printf '\e]9;%s\a' "$line"; fi
    done < $__mokkan_dir/osc.txt >/dev/tty 2>/dev/null
  fi
}
autoload -Uz add-zsh-hook; add-zsh-hook precmd __mokkan_precmd
```

- The stamp is checked to be all digits before any arithmetic: in bash and zsh, `(( … ))` on a crafted value runs
  command substitutions. bash uses `case $last in ''|*[!0-9]*) last=0;; esac`, which works in bash 3.2.
- The comparison quotes the right-hand side: unquoted, zsh and bash treat it as a glob pattern.
- Reminder text goes through `print -r`/`printf '%s'`, never `print -P` or `echo -e`.
- **bash:** `${EPOCHSECONDS:-$(date +%s)}` for bash < 5. When bash-preexec is loaded, the hook goes into
  `precmd_functions`. Otherwise, on bash ≥ 5.1 with an array `PROMPT_COMMAND` it is appended to the array; else it is
  appended to the string with a newline separator (not `;`, which breaks a value ending in `;` or a newline). The
  background job is `( … </dev/null >/dev/null 2>&1 & )`, so it never shows up in `jobs`.
- **fish:** the file starts with `status is-interactive; or exit` (conf.d also loads in non-interactive shells), and
  uses `function __mokkan_prompt --on-event fish_prompt`, `date +%s`, `string match -qr '^[0-9]+$'` and
  `command … </dev/null >/dev/null 2>&1 &; disown`.
- The rc block is one line that also works when mokkan is uninstalled:
  `[ -r "${XDG_CONFIG_HOME:-$HOME/.config}/mokkan/notify/init.zsh" ] && . "${XDG_CONFIG_HOME:-$HOME/.config}/mokkan/notify/init.zsh"`.

### Detection (`detect.ts`)

| Fact | macOS | Linux |
|---|---|---|
| GUI session | `launchctl print gui/$UID` succeeds (a console login exists) | A session bus exists (`DBUS_SESSION_BUS_ADDRESS` or `/run/user/$UID/bus`) **and** `org.freedesktop.Notifications` is owned on it (`busctl --user status org.freedesktop.Notifications` or `gdbus call … NameHasOwner`), or `loginctl list-sessions` shows an `x11`/`wayland` session for `$UID`. `DISPLAY`/`WAYLAND_DISPLAY` are not required, so a desktop reached over SSH is detected |
| Agent | launchd | GUI and `systemctl --user` reachable → systemd-user; GUI only → xdg-autostart; no GUI → none (a headless box over SSH still has a user manager, which is not a reason to install a timer) |
| Backend order | terminal-notifier → osascript | notify-send → gdbus → kdialog |
| SSH | `SSH_CONNECTION`/`SSH_TTY` | same |
| WSL | n/a | `/proc/version` contains `microsoft`: no backend in core, shell + OSC only. Listed as a contribution target (PowerShell toast) |

When setup runs over SSH on a machine with a GUI login (a Linux desktop or a Mac reached from a laptop), it still
offers the agent and says the notifications appear on *that* machine's screen; OSC is what reaches the laptop.

### Agents

All agents run the same absolute `node` and `cli.js` as the snippet, and pass `XDG_CONFIG_HOME` when it was set at
setup time, so the agent, the shells and the hooks share one config dir (and with it one `credentials.json.lock`,
which keeps refresh-token rotation safe, A28).

- **launchd:** `~/Library/LaunchAgents/dev.mokkan.notify.plist` with an XML comment `<!-- managed by mokkan -->`,
  `ProgramArguments=[node, cli.js, notify, poll]`, `StartInterval=interval`, `RunAtLoad`, `EnvironmentVariables`,
  stdout/stderr to `/dev/null`. Install: `launchctl bootout gui/$UID/dev.mokkan.notify` (ignore "not loaded"), then
  `launchctl bootstrap gui/$UID <plist>`. Remove: `bootout`, then delete the file.
- **systemd-user:** `~/.config/systemd/user/mokkan-notify.{service,timer}` with `# managed by mokkan`. A
  `Type=oneshot` service with `Environment=` lines; a timer with `OnBootSec=1min`, `OnUnitActiveSec=<interval>s`,
  `AccuracySec=10s`, `WantedBy=timers.target`. `notify-send` needs only the session bus, which the user manager has.
  If the notification daemon is not up yet at the first run, step 6's retry covers it. Enabled with
  `systemctl --user daemon-reload`, `enable mokkan-notify.timer`, then `restart` (an already running timer keeps its
  old interval until restarted).
- **xdg-autostart:** `~/.config/autostart/mokkan-notify.desktop` (`# managed by mokkan`) runs `notify poll --loop`, a
  foreground loop that sleeps for `interval` and exits on SIGTERM when the session ends. Used on Alpine/OpenRC,
  Void/runit and similar systems.
- `remove` deletes only files carrying the marker, and `setup` refuses to overwrite a file without it (the same rule
  as `install.sh`'s `link_ours`).

### Safety

- **Reminder text is untrusted** in every sink: it may have been pushed from another machine, or by Claude.
  - `sanitize.ts` strips ESC, BEL, all other C0/C1 controls and bidi overrides before text reaches `shell.txt`,
    `osc.txt` or a backend, so text like `\e]52;c;…\a` (clipboard write) arrives inert.
  - `osc.txt` also drops `;`, which separates OSC 777 fields.
  - notify-send and gdbus bodies are Pango markup on GNOME and KDE: the backends escape `&`, `<` and `>` (only
    there, not in `shell.txt`).
- **No shell or AppleScript interpolation:** backends run `execFile` with an argv array, and every backend has a test
  that asserts this.
  - osascript uses `on run argv … display notification (item 1 of argv)`.
  - notify-send uses `--` before positional arguments.
- The background poll never inherits the terminal (`</dev/null`, output to `/dev/null`), and the OSC write to
  `/dev/tty` discards errors for shells without a controlling terminal.

## Contributing a platform

- `CONTRIBUTING.md` (new, public; the design docs are private, A42), section "Notifications on your system":
  - the three interfaces and the registries in `index.ts`;
  - running `npm test -- notify`;
  - attaching `mokkan notify doctor` output to the PR.
- `.github/PULL_REQUEST_TEMPLATE/notify-platform.md` is a checklist: tested on (distro and version, DE, shell),
  doctor output, argv-only, sanitized, `remove` cleans up. `.github/` is already exported.
- `.github/ISSUE_TEMPLATE/notify-not-working.yml` asks for doctor output.
- `test/notify-contract.test.ts` iterates over every registered backend, agent and shell and runs the same assertions:
  - backends: argv only, the hostile text fixture survives as one argument, markup is escaped where the backend
    needs it, `available()` is pure given a fake probe;
  - agents: `install` → `installed` → `remove` round trip in a temp HOME, marker present, a second `install` changes
    nothing, an unmarked file survives `remove`;
  - shells: no placeholder left in the snippet, it does nothing when not interactive, and it checks `MOKKAN_NOTIFY`.
  A contributor gets most of their tests for free.

## Verify during implementation

These could not be checked without the hardware; Task 4 and the manual matrix confirm them.

- How macOS 14/15 treats `osascript display notification` started by launchd, and whether `terminal-notifier` still
  works on Sequoia.
- Whether `launchctl print gui/$UID` fails over SSH when nobody is logged in at the console.
- ~~How `gdbus call` parses string arguments that look quoted (`'x'`)~~: verified in Task 3 (typed GVariant literals,
  run against a fake notification service under `dbus-run-session`).
- osascript: `item -1`/`item -2 of argv` and whether `--` reaches the script (the backend works either way).
- launchd: whether `bootstrap` right after `bootout` can fail with "5: Input/output error" while the old job stops,
  and whether `launchctl print gui/$UID/dev.mokkan.notify` is the right "loaded" check.
- systemd: whether `OnBootSec=1min` fires promptly when the timer is started after login.
- XDG autostart: how GNOME, KDE and minimal sessions parse `Exec=env XDG_CONFIG_HOME=…` with escaped paths.
- terminal-notifier: the U+2060 prefix that keeps a message starting with `-`, `[`, `{`, `\` … literal.

## Out of scope

- Windows-native and WSL toasts (a contribution target).
- Clicking a notification to acknowledge.
- Notification sounds and do-not-disturb handling.
- Per-reminder snoozing.
- Changing email escalation.
