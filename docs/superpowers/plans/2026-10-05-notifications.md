# Shell and desktop notifications: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mokkan notify setup` installs a prompt hook (zsh, bash, fish) and, when a GUI session exists, a background agent (launchd, systemd `--user` or XDG autostart) that shows fired, unacknowledged scheduled reminders (`mokkan in …`) without ever marking them delivered.

**Spec:** `docs/superpowers/specs/2026-10-05-notifications-design.md` (revised after review). Both documents are private (A42).

## Global constraints

- Node `>=20.3.0`, no runtime dependencies, NodeNext `.js` imports. `npm run typecheck` and `npm test` pass after every task.
- Every process spawn goes through one injectable `Spawner` (`execFile`-shaped, argv array, timeout) on `CliIO`, so tests never run `osascript`, `notify-send`, `gdbus`, `busctl`, `launchctl` or `systemctl`.
- All filesystem paths are derived from `io.env` (`HOME`, `XDG_CONFIG_HOME`), and tests use a temp HOME.
- Read-only toward the server: the notify code path never calls `heartbeat` or `deliver` (a test asserts that the fake server sees neither).
- Rebuild `claude-plugin/scripts/mokkan.mjs` in the last task (`npm run check:bundle`).
- Version 0.8.0, with a CHANGELOG entry. The user decisions in the spec become U19 to U23 in `ASSUMPTIONS.md` (U18 is taken).
- New user-facing docs go in `README.md` and `CONTRIBUTING.md` (public). Nothing user-facing may point to `docs/` or `ASSUMPTIONS.md`, which are not exported.

## Review focus

1. **Hostile reminder text** (`\x1b]52;c;…\a`, `$(rm -rf ~)`, `"; do shell script "…`, `<b>&</b>`, RTL override, 10 kB of text) must arrive as inert text in `shell.txt`, `osc.txt` and every backend's argv. Tests in Tasks 2 and 3.
2. **N shells and the agent polling at once** must make exactly one `pending` call per interval, and a server that is down must not make every prompt start `node`. Task 4.
3. **The prompt must never block or print errors:** no credentials, a corrupt or too-open `credentials.json`, server down, corrupt config, a non-numeric stamp, the baked CLI path deleted. Task 6 runs each snippet in a real shell for each case.
4. **`remove` touches only what mokkan wrote:** an unmarked plist, unit or autostart file with the same name survives. Task 5.
5. **Existing `PROMPT_COMMAND` (string ending in `;` or a newline, or an array), bash-preexec and starship** keep working after the bash hook is added. Task 6.
6. **A popup that failed is retried, not lost** (notification daemon not up at boot), and gives up after 3 attempts. Task 4.

---

## Tasks

### Task 1: Config, state and account cleanup
- [x] `src/notify/config.ts`: `loadNotifyConfig(env)` returns defaults merged with the file; `saveNotifyConfig` writes atomically at 0600; `MOKKAN_NOTIFY=0` overrides everything; a corrupt file means everything is off, plus an hourly log line; `interval` below 30 is a usage error on write and clamped on read.
- [x] `src/notify/state.ts`: dir 0700; `tryLockPoll` (`O_EXCL`, stale after 30 s), `readStamp` (non-numeric → 0), `writeStamp` (temp + rename), atomic `writeShellFiles`, `notified.json` with per-id `{done, attempts}`, update and prune.
- [x] `removeNotifyState` (`src/credentials.ts`) removes everything in `notify/` except `init.*`; called by `removeAccountFiles`, `logout` (both paths) and on session expiry. `appendHookLogHourly` in `src/hooks.ts` for recurring problems.
- [x] Tests: `test/notify-config.test.ts`, `test/notify-state.test.ts` (including stale-lock recovery and `MOKKAN_NOTIFY=0`); extend the logout and delete-account tests.

### Task 2: Sanitizer and display format
- [x] `src/notify/sanitize.ts`: strip ESC, BEL, C0/C1 and bidi overrides; clamp length; `forOsc()` also drops `;`; `escapeMarkup()` for `&<>`.
- [x] `formatDueLocal(due, now)`: `HH:MM` today, `ddd HH:MM` within a week, otherwise a date. It never yields a relative time, so `shell.txt` is stable between polls.
- [x] Tests: the hostile text fixture, wide characters, length clamping, time format around midnight and across a week.

### Task 3: Detection and desktop backends
- [ ] `src/notify/detect.ts`: a pure function of `(env, platform, Probe)`, where `Probe` wraps `which`, `launchctl print gui/$UID`, `systemctl --user is-system-running`, the notification-service owner check (`busctl --user status org.freedesktop.Notifications`, else `gdbus … NameHasOwner`) and `loginctl list-sessions`.
- [ ] Backends: `macos-terminal-notifier`, `macos-osascript` (`on run argv`), `linux-notify-send` (`--app-name=mokkan --`, markup escaped), `linux-gdbus` (`org.freedesktop.Notifications.Notify`, markup escaped), `linux-kdialog`. Each lives in its own file and is registered in order in `index.ts`.
- [ ] Tests: a detection table where each case pins `gui`, `agent` and `backend`:
  - GNOME Wayland → systemd-user + notify-send;
  - KDE X11 → systemd-user + notify-send;
  - sway with no libnotify → gdbus;
  - Alpine + XFCE without systemd → xdg-autostart;
  - headless Debian over SSH (user manager running, no notification service) → agent **none**;
  - GNOME desktop reached over SSH (no `DISPLAY`, service owned) → systemd-user;
  - macOS console → launchd;
  - macOS over SSH with nobody logged in at the console → none;
  - WSL → none, shell + OSC.
- [ ] `test/notify-contract.test.ts`, backend part.

### Task 4: Poll
- [ ] `src/notify/poll.ts`: steps 1 to 8 from the spec, with the backend list injected (from Task 3's registry in production).
- [ ] `--loop` mode for xdg-autostart, which exits on SIGTERM.
- [ ] `notifiable()` unit tests:
  - a plain push (no `due_at`) is excluded;
  - a scheduled reminder that has not fired is excluded;
  - a fired `due` reminder and a fired `delivered` one (awaiting ack) are included;
  - an acked one is excluded;
  - an id in both sets appears once.
- [ ] Tests against `test/fake-server.ts`:
  - a reminder is notified, the second poll does not notify again, and the id is pruned after an ack;
  - more than 3 new reminders become one summary;
  - 10 concurrent polls make 1 request;
  - with the server down, the stamp still advances and the next poll inside the interval makes no request;
  - no heartbeat or deliver calls;
  - a failing backend is retried on the next poll and given up after 3 attempts;
  - `no_credentials` and session expiry empty the files;
  - `privacy_not_accepted` writes the accept line;
  - a 429 keeps the files;
  - the 10 s overall timeout and the 3 s notifier timeout hold (fake clock).

### Task 5: Agents
- [ ] `launchd.ts`, `systemd-user.ts` and `xdg-autostart.ts`, each with `install`, `remove` and `installed`. Markers: an XML comment for the plist, `# managed by mokkan` elsewhere. Each refuses to overwrite unmarked files and bakes in absolute node and cli paths plus `XDG_CONFIG_HOME` when it is set.
- [ ] launchd: `bootout` (tolerating "not loaded") before `bootstrap`.
- [ ] A second `install` with the same content writes nothing.
- [ ] The plist and unit contents are snapshot-tested. The contract test runs the round trip for every agent in a temp HOME with a fake `Spawner` that records `launchctl`/`systemctl` argv.

### Task 6: Shells and rc files
- [ ] Move `replaceFile` from `statusline-remove.ts` into `src/rcfile.ts` (exported), add marked-block insert and remove, and skip the write and the backup when the content would not change.
- [ ] `zsh.ts`, `bash.ts` and `fish.ts`: `snippet({ node, cli, version, interval, osc })`, `rcFile(env, platform)` (bash uses `~/.bash_profile` on macOS when it exists, `~/.bashrc` otherwise) and `installStyle`. Each snippet matches the spec:
  - numeric stamp guard;
  - quoted comparison;
  - `</dev/null` on the background poll;
  - the `MOKKAN_NOTIFY` check;
  - a per-shell `__mokkan_shown`;
  - OSC built and tmux-wrapped at print time, with `2>/dev/null` on `/dev/tty`.
- [ ] `poll` regenerates `init.<shell>` when its version line differs; test it.
- [ ] Integration test `test/notify-shells.test.ts`, skipped per shell if that shell is missing. It runs `zsh -i`, `bash -i` and `fish -i` with a stub CLI that writes the files, and covers:
  - the set prints once per shell, and two shells each print it;
  - the second prompt is silent;
  - an ack (the set shrinks) reprints the rest;
  - OSC goes out only with `SSH_CONNECTION` set, and is DCS-wrapped with `TMUX` set;
  - a failing stub, a deleted stub, and a stamp containing `a[$(touch pwned)]` all print nothing and run nothing;
  - `MOKKAN_NOTIFY=0` starts no poll;
  - fish conf.d does nothing in a non-interactive `fish -c`.
  The bash case also runs with bash-preexec loaded and with `PROMPT_COMMAND` set to `foo;`, to `foo` plus a newline, and to an array.
- [ ] CI: install `zsh fish` in `.github/workflows/ci.yml`, and add a `macos-latest` job that runs the bash 3.2 and zsh cases.

### Task 7: Commands
- [ ] `src/commands/notify.ts`:
  - `setup`: refuses without a TTY and with `--exit-zero`; refuses a CLI under a plugin cache or `_npx`; asks each question with `prompt`; runs the test notification per backend ("Did you see it? [Y/n]", falling back to the next backend, then the Script Editor / terminal-notifier hint).
  - `remove`: the same terminal-only checks.
  - `on`/`off`: regenerate `init.<shell>`.
  - `status`, `test`.
  - `doctor`: checks the baked paths exist and redacts the user name, host name and home path.
  - `poll`, and `shell init`.
- [ ] Wire into `src/cli.ts`: `notify poll` is dispatched before credential loading and `reportError`, like `hook` (`src/cli.ts:305`), and always exits 0. Add `notify` and `shell` to `dispatch` and `USAGE`, and `COMMAND_FLAGS` entries for `--loop` and `--yes` (`--json` is already global).
- [ ] Tests: `test/notify-command.test.ts` covers:
  - `setup` end to end in a temp HOME on a fake Linux GNOME, a fake macOS and a fake headless machine;
  - a second `setup` changes nothing;
  - the `/mokkan` path (`--argline … --exit-zero`) refuses `setup` and `remove` and allows `status`, `test`, `doctor`, `on` and `off`;
  - the `status --json` shape;
  - doctor redaction;
  - `poll` with a too-open `credentials.json` prints nothing and exits 0.

### Task 8: Contribution scaffolding, docs and release
- [ ] `CONTRIBUTING.md` (new, public) section "Notifications on your system", `.github/PULL_REQUEST_TEMPLATE/notify-platform.md` and `.github/ISSUE_TEMPLATE/notify-not-working.yml`. Check with a dry export that they are published and that `docs/` and `ASSUMPTIONS.md` are not.
- [ ] README: a "Notifications" section covering:
  - setup, and the stable-install requirement;
  - config keys;
  - the SSH/OSC terminal support table (`auto` mostly means OSC 9 over SSH; tmux needs `allow-passthrough on`);
  - the macOS permission note;
  - how to disable.
- [ ] Add `notify` to `claude-plugin/skills/mokkan/SKILL.md`, `claude-command/mokkan-cli.md` (kept in sync, `test/plugin.test.ts`) and `codex/SKILL.md`: what Claude or Codex may run (status, test, doctor, on, off) and that setup needs a terminal.
- [ ] CHANGELOG 0.8.0, `ASSUMPTIONS.md` U19 to U23, version bump in `package.json` and `plugin.json`, then `npm run bundle`.

## Manual test matrix (before release)

| System | Shell | Expect |
|---|---|---|
| macOS 15, Terminal.app | zsh | launchd agent; osascript permission flow; terminal-notifier if installed; prompt hook |
| macOS + iTerm2 → SSH to Ubuntu server | bash | remote hook prints; OSC 9 notification on the Mac; inside tmux with passthrough too |
| Ubuntu 24.04 GNOME (Wayland) | bash | systemd timer + notify-send; first popup after reboot arrives |
| Fedora KDE | zsh | systemd timer + notify-send |
| Arch + sway + mako | fish | systemd timer; gdbus fallback without libnotify |
| Alpine + XFCE (OpenRC) | bash | xdg-autostart loop |
| Debian headless over SSH | bash | shell hook only; setup explains why |
| Mac reached over SSH, nobody at the console | zsh | shell hook only |
