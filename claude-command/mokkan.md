---
description: Cross-session reminders — list, push, pop, dequeue, schedule (in), edit, ack, pending, done, status, balance, buy, register, login, logout, statusline (set up the mokkan status line). Never pass --force, logout or buy unless the user typed them.
argument-hint: '[list | push <text> | pop | dequeue | in <duration> <text> | edit <n|id> [--all] [--in <duration> | --at <iso> | --clear-due] [new text] | ack <id|all> | pending | done | status | balance | buy | register <email> | login <email> | logout | statusline [--dry-run | --remove]]  (text must not contain $ ` " \ — use mokkan push in a terminal for those)'
allowed-tools: Bash(mokkan:*)
---
## Output of `mokkan $ARGUMENTS`

!`mokkan --argline "$ARGUMENTS" --exit-zero 2>&1`

Show the output above to the user verbatim, including the ids in square brackets. Do not run any other command and do not paraphrase. If the output asks the user to finish something in a terminal (registration or login need a hidden password prompt), tell them exactly that command; if `mokkan` is not installed in their terminal (for example they only have the Claude Code plugin), `npx mokkan <the same arguments>` runs it. Do not run `mokkan watch`, `mokkan register` or `mokkan login` yourself, through this command or otherwise, beyond what the output above already shows. If the output is empty, say "No output from mokkan."

## Status line

When the user asks to show, add or set up the mokkan status line, the command is `/mokkan statusline` (`--dry-run` previews, `--remove` undoes; before uninstalling mokkan, run `/mokkan statusline --remove`). From here it writes only Claude Code's `statusLine` in `~/.claude/settings.json`, keeping a `.mokkan-bak-<time>` backup. `/mokkan statusline --tmux` also adds a marked block to `~/.tmux.conf` (Codex shows mokkan only inside tmux); it leaves a tmux config that sets its own `status-right` or uses TPM alone and prints the `#(…)` part to add to the user's own `status-right` instead. It never replaces a status line that is not mokkan's: if the output above says so, show the user their current command and ask whether they want to combine it (their script also prints the output of the command shown) or replace it with `/mokkan statusline --claude --force`; never add `--force` on your own. After a change, tell the user to restart Claude Code (and to reload tmux if the output says so).

## Credits (paid use)

Reminders run on prepaid credits: €5 buys 500 credits, and every new account starts with 50. Prices: `push` costs 1 credit; every 3rd edit costs 1 credit; a scheduled reminder's email costs 1 credit, charged only when it is actually sent (every reminder with a due time that has not been emailed and is not acknowledged, whether scheduled, due or shown but not yet acknowledged, keeps 1 credit in reserve; `mokkan ack` releases it; scheduling needs the push cost plus 1 × (those reminders + 1)). `pop`, `dequeue`, `ack`, `list`, `pending`, `done` and `status` are free. `mokkan balance` shows the balance and recent transactions.

This section is for advising the user; it does not allow you to run anything beyond the command above.

- To change a reminder, suggest `/mokkan edit <n|id> [--in 2h | --at <iso> | --clear-due] [new text]`, never `pop` followed by `push`. The new text is the words after the options, without quotes: `/mokkan edit 2 --in 2h call mom at 5`. `n` is the number in `/mokkan list`; add `--all` to use the numbering of `/mokkan list --all` (scheduled reminders), or use the id in square brackets. Put every change to one reminder into a single `edit` call, because each call counts as an edit.
- If the output above says "Not enough credits" or mentions `mokkan buy`, tell the user to run `mokkan buy` (or `npx mokkan buy`) in a terminal to add credits. Do not retry the command and do not run `mokkan buy` yourself.
