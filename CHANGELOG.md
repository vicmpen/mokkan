# Changelog

## 0.2.0 — unreleased

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
