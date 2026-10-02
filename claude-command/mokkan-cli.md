---
description: mokkan from your PATH, through Claude — push, in, edit, ack, done, list, balance… (the mokkan plugin's /mokkan runs them directly and toggles the pane). Never pass --force, logout or buy unless the user typed them.
argument-hint: '[list | push <text> | pop | dequeue | in <duration> <text> | edit <n|id> [--all] [--in <duration> | --at <iso> | --clear-due] [new text] | ack <id|all> | done [<id>...] | undone <id>... | pending | status | balance | buy | register <email> | login <email> | logout]  (text must not contain $ ` " \ — use mokkan push in a terminal for those)'
allowed-tools: Bash(mokkan:*)
---
## Output of `mokkan $ARGUMENTS`

!`mokkan --argline "$ARGUMENTS" --exit-zero 2>&1`

Show the output above to the user verbatim, including the ids in square brackets. Do not run any other command and do not paraphrase. If the output asks the user to finish something in a terminal (registration or login need a hidden password prompt), tell them exactly that command; if `mokkan` is not installed in their terminal (for example they only have the Claude Code plugin), `npx @vicmpen/mokkan-cli <the same arguments>` runs it. Do not run `mokkan ui`, `mokkan watch`, `mokkan register` or `mokkan login` yourself, through this command or otherwise, beyond what the output above already shows (`mokkan ui` is the user's full-screen terminal view; if they ask for it, tell them to run `mokkan ui` in a terminal). If the output is empty, say "No output from mokkan."

## Credits (paid use)

Reminders run on prepaid credits: €5 buys 500 credits, and every new account starts with 50. Prices: `push` costs 1 credit; every 3rd edit costs 1 credit; a scheduled reminder's email costs 1 credit, charged only when it is actually sent (every reminder with a due time that has not been emailed and is not acknowledged, whether scheduled, due or shown but not yet acknowledged, keeps 1 credit in reserve; `mokkan ack` releases it; scheduling needs the push cost plus 1 × (those reminders + 1)). `pop`, `dequeue`, `done`, `undone`, `ack`, `list`, `pending` and `status` are free. `done <id>` finishes a reminder anywhere on the list (ack only silences it and keeps it); `undone <id>` reopens a finished one. `mokkan balance` shows the balance and recent transactions.

This section is for advising the user; it does not allow you to run anything beyond the command above.

- To change a reminder, suggest `/mokkan-cli edit <n|id> [--in 2h | --at <iso> | --clear-due] [new text]`, never `pop` followed by `push`. The new text is the words after the options, without quotes: `/mokkan-cli edit 2 --in 2h call mom at 5`. `n` is the number in `/mokkan-cli list`; add `--all` to use the numbering of `/mokkan-cli list --all` (scheduled reminders), or use the id in square brackets. Put every change to one reminder into a single `edit` call, because each call counts as an edit.
- If the output above says "Not enough credits" or mentions `mokkan buy`, tell the user to run `mokkan buy` (or `npx @vicmpen/mokkan-cli buy`) in a terminal to add credits. Do not retry the command and do not run `mokkan buy` yourself.
