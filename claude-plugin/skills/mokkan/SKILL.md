---
name: mokkan
description: Type /mokkan alone to open or close the reminders pane, or /mokkan push|in|edit|ack|done|list|balance… to run a command at once. Use when the user asks to remember something for later, to add, list, change, schedule, acknowledge or archive a todo or reminder, or about their mokkan credits; Claude runs them through the plugin's mokkan tool, which leaves buy, logout, accept and delete-account to the user.
argument-hint: '[nothing: toggle the pane | list | push <text> | in <duration> <text> | edit <n|id> [--in <duration> | --clear-due] [new text] | ack <id|all> | done <id>... | undone <id>... | pending | balance | buy | logout]'
---
## Running mokkan

Run `mokkan $ARGUMENTS`: call the `mcp__mokkan__mokkan` tool (load it with tool search if it is not loaded yet) with `command` set to the mokkan command and `args` to its arguments, the reminder's text as one element. `in 2h call the bank` is `{ "command": "in", "args": ["2h", "call the bank"] }`. The tool runs mokkan without a shell, so quotes, `$` and backticks in the text reach it as typed.

Show the tool's output to the user verbatim, including the ids in square brackets. Do not paraphrase and do not run mokkan any other way (no Bash, no npx). If the output asks the user to finish something in a terminal (registration or login need a hidden password prompt), tell them exactly that command; if `mokkan` is not installed in their terminal (for example they only have the Claude Code plugin), `npx @vicmpen/mokkan-cli <the same arguments>` runs it. The tool refuses what only the user runs: `buy`, `logout`, `login`, `register`, `feedback` and `ui` (tell them to type `/mokkan <command>`, or for `ui` to run `mokkan ui` in a terminal), and `accept` and `delete-account` (only the user accepts the privacy policy, in a terminal or in the pane, or deletes their account, in a terminal: `mokkan accept` or `mokkan delete-account`, or `npx @vicmpen/mokkan-cli …` if mokkan isn't installed). If the output asks to accept the privacy policy, say that, and do not retry the command. If there is no output, say "No output from mokkan."

## Notifications

`mokkan notify status`, `mokkan notify test`, `mokkan notify doctor`, `mokkan notify on` and `mokkan notify off` (each of the last two optionally with `shell`, `desktop` or `osc`) may run through this command when the user asks. `mokkan notify setup` and `mokkan notify remove` edit the user's shell config and install or remove a background agent, so they only run in a terminal: tell the user to run them there (setup needs mokkan installed with `npm i -g @vicmpen/mokkan-cli`, not the plugin's copy or npx). Never run `mokkan notify poll`.

## Credits (paid use)

Reminders run on prepaid credits: €5 buys 500 credits, and every new account starts with 50. Prices: `push` costs 1 credit; every 3rd edit costs 1 credit; a scheduled reminder's email costs 1 credit, charged only when it is actually sent (every reminder with a due time that has not been emailed and is not acknowledged, whether scheduled, due or shown but not yet acknowledged, keeps 1 credit in reserve; `mokkan ack` releases it; scheduling needs the push cost plus 1 × (those reminders + 1)). `pop`, `dequeue`, `done`, `undone`, `ack`, `list`, `pending` and `status` are free. `done <id>` finishes a reminder anywhere on the list (ack only silences it and keeps it); `undone <id>` reopens a finished one. `mokkan balance` shows the balance and recent transactions.

This section is for advising the user; it does not allow you to run anything beyond the command above.

- To change a reminder, suggest `/mokkan edit <n|id> [--in 2h | --at <iso> | --clear-due] [new text]`, never `pop` followed by `push`. The new text is the words after the options, without quotes: `/mokkan edit 2 --in 2h call mom at 5`. `n` is the number in `/mokkan list`; add `--all` to use the numbering of `/mokkan list --all` (scheduled reminders), or use the id in square brackets. Put every change to one reminder into a single `edit` call, because each call counts as an edit.
- If the output above says "Not enough credits" or mentions `mokkan buy`, tell the user to run `mokkan buy` (or `npx @vicmpen/mokkan-cli buy`) in a terminal to add credits. Do not retry the command and do not run `mokkan buy` yourself.
