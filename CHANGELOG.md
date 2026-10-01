# Changelog

## 0.3.1 — unreleased

- **A pane in Claude Code.** `/mokkan-pane` opens a live view of the stack inside Claude Code (docked beside the transcript in the fullscreen layout): tabs for todo, reminders and done, a pointer moved with the arrows or digits, Enter to mark done or reopen, one key per command, login and registration with a masked password. The plugin ships it as a hooks module next to the shell hooks.
- **The status line is gone.** `mokkan statusline` no longer renders or configures anything. It stays for this release so that an earlier setup keeps working silently and can be undone: `mokkan statusline --remove` takes the 0.2.0 status line out of Claude Code's `settings.json` and `~/.tmux.conf` (backups first) and deletes the CLI copy in `~/.local/share/mokkan/`. The command disappears in the next release.

## 0.3.0

- **`mokkan done <id…>` and `mokkan undone <id…>`.** Finish a reminder anywhere on the list (like `pop`, by id) and reopen a finished one at its old position; a reopened reminder with a due time comes back acknowledged and is never emailed again. Bare `mokkan done` still lists the history. Needs server `POST /reminders/:id/done`.

## 0.2.0

First public release.

- **Distribution.** Three ways to install:
  - The Claude Code plugin, from this repository's marketplace (`/plugin marketplace add vicmpen/mokkan`, then `/plugin install mokkan@mokkan`). The plugin ships its own single-file CLI.
  - The npm package `@vicmpen/mokkan-cli` (installs the `mokkan` command).
  - The Codex skill in `codex/`.
- **`mokkan statusline` sets up the status line.** It configures Claude Code's `statusLine` and a marked tmux block (Codex shows mokkan inside tmux), keeping backups. It leaves a tmux config with its own `status-right` or TPM alone unless `--force` is given, and from Claude Code it sets up only Claude Code's status line unless `--tmux` is given. `--dry-run` previews the changes and `--remove` undoes them. Rendering moved to `mokkan statusline --render`. Old configs are migrated.
- **Plugin.** `/mokkan:mokkan` is now a skill that runs the bundled CLI. The hooks prefer the bundle. The status line uses a stable copy of the CLI outside the plugin cache.
- **Credits.** The CLI supports prepaid credits (`balance`, `buy`, exit code 3 when credits run out) and `mokkan edit`.
- **`mokkan ui`.** A full-screen terminal view of the stack with keyboard actions (push, schedule, edit, acknowledge, pop, dequeue, buy) and a login screen. Reminders shown there count as delivered, like the hooks and `mokkan watch`.
- MIT license.

## 0.1.0

Internal version: the CLI, the Claude Code hooks and `/mokkan` command, and the Codex skill.
