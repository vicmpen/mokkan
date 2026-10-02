# Changelog

## 0.5.0 — unreleased

- **`/mokkan` toggles the pane.** `/mokkan-pane` is gone. `/mokkan` on its own opens the pane, or closes it when it is open; `/mokkan push milk` (any command) runs it and prints the output straight away, with no model turn. A user-level `/mokkan` from `install.sh` keeps working, and where the plugin is loaded the plugin answers it. `/mokkan:mokkan` stays as the skill Claude runs.
- **No more session hooks.** The plugin's SessionStart and Stop hooks are gone: the pane polls every 15 seconds, toasts what comes due and tells the server a session is active, so nothing is put into the conversation any more.
- **TODOs, Reminders and Archived.** The pane and `mokkan ui` split the stack into a TODOs tab (no due time) and a Reminders tab (a due time), each with its own count and row numbers, and Done is renamed Archived (`d` archives, and reopens there). The view opens on Reminders while one is due. `t`, `r` and `w` leave you on your tab and say where the item went. In `mokkan ui`, only the due rows on the tab you are looking at count as shown.
- **Stray keys stay out of the prompt.** While the pane has the keyboard, a key it doesn't use does nothing; it used to leave the pane and land in Claude's prompt. ctrl/cmd combinations, pastes and typing after `Esc` reach the prompt as before.

## 0.4.0

- **The pane and `mokkan ui` share one layout.** One stack and a done view replace the todo / reminders / done tabs (and Active / All / Done in `mokkan ui`). Todos (`□`) and reminders (`◷ ● ○ ·`) look different; reminder times always say their direction (`in 40m`, `Wed 17:00`, `overdue 40m`, `2h ago`); the selected row shows its history. Keys match across both: `a` done, `k` acknowledge, `s` switch view (in `mokkan ui`, `a` used to acknowledge and `k`/`j` moved the selection; `K` now acknowledges all). Pop and dequeue name the reminder they will remove.
- **The pane is more honest about its state.** Errors show in every mode, including inside a field, and the typed text is kept. A running command blocks repeat presses (no more double pops). Every row can be reached. Going offline keeps the last list, marked as stale. The pane is drawn like `mokkan ui`: the same header, `Stack │ Done` views, selected row marked by `▸` and bold, and key footer.

## 0.3.1

- **A pane in Claude Code.** `/mokkan-pane` opens a live view of the stack inside Claude Code (docked beside the transcript in the fullscreen layout): tabs for todo, reminders and done, a pointer moved with the arrows or digits, Enter to mark done or reopen, one key per command, login and registration with a masked password. It is a mod: a hooks module the plugin ships next to its shell hooks.
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
