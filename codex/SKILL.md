---
name: mokkan
description: Cross-session reminders through the `mokkan` CLI. Use at the start and end of every task, and whenever the user mentions reminders, remembering something, a todo stack, or scheduling something for later.
---

# mokkan — cross-session reminders

The `mokkan` CLI talks to the user's reminder server. Codex has no lifecycle hooks, so this skill replaces them. If `mokkan` is not found, tell the user to install it with `npm i -g @vicmpen/mokkan-cli` (Node.js 20.3 or later) and stop there:

1. **At the start of a task**, run `mokkan heartbeat --source codex` and then `mokkan pending`. If `mokkan pending` prints reminders, show them to the user verbatim (keep the `[id]` tags) and tell them they can acknowledge with `mokkan ack <id>` or `mokkan ack all`.
2. **Before finishing a task**, run `mokkan heartbeat --source codex && mokkan pending` again and relay anything new.
3. **When the user asks** to remember, push, pop, dequeue, schedule, list, or acknowledge a reminder, run the matching command and relay the output verbatim:
   - `mokkan push <text>` — add to the top of the list
   - `mokkan pop` — remove from the top (LIFO) · `mokkan dequeue` — remove from the bottom (FIFO)
   - `mokkan in <duration> <text>` — schedule (`30s`, `10m`, `2h`, `1d`, `1h30m`)
   - `mokkan edit <n|id> [--all] [--in <duration> | --at <iso> | --clear-due] [new text...]` — change a reminder in place; the new text is the remaining words (`mokkan edit 2 --in 2h call mom at 5`). `n` is the number in `mokkan list` (with `--all`: in `mokkan list --all`, which includes scheduled reminders); an id prefix matches any open reminder. `--at` needs an ISO time with a zone (`2026-10-01T09:00:00Z`)
   - `mokkan balance` — credit balance and recent transactions
   - `mokkan ack <id-prefix>... | all` — acknowledge reminders the user has seen
   - `mokkan done <id-prefix>...` — finish reminders anywhere on the list (ack only silences one and keeps it) · `mokkan undone <id-prefix>...` — reopen finished ones
   - `mokkan` / `mokkan list --all` / `mokkan done` / `mokkan status`
4. Never run `mokkan register`, `mokkan login` or `mokkan ui` yourself: the first two need a hidden password prompt and `mokkan ui` is the user's full-screen terminal view. Tell the user to run them in a terminal (`mokkan register you@example.com`, `mokkan ui`).
   - Never run `mokkan accept` or `mokkan delete-account` yourself, in any form (with or without `--yes`, or through `npx @vicmpen/mokkan-cli`): only the user accepts the privacy policy (in a terminal or in the Claude Code pane) or deletes their account (in a terminal). If the output asks to accept the privacy policy, tell the user to run `mokkan accept` in a terminal.
   - If a command exits with code 4, the user must accept the updated privacy policy in a terminal (`mokkan accept`): tell them so and stop using mokkan for this task.
5. If a command exits with code 2, the server is unreachable or failing: say so and continue the task; do not retry in a loop.
6. **Credits.** Reminders run on prepaid credits: €5 = 500 credits, and a new account starts with 50. `mokkan push` costs 1 credit; every 3rd edit costs 1 credit; a scheduled reminder's email costs 1 credit, charged only when it is actually sent (every reminder with a due time that has not been emailed and is not acknowledged, whether scheduled, due or shown but not yet acknowledged, keeps 1 credit in reserve; `mokkan ack` releases it; scheduling needs the push cost plus 1 × (those reminders + 1)). `pop`, `dequeue`, `done`, `undone`, `ack`, `list`, `pending` and `done` are free.
   - To change a reminder use `mokkan edit`, never `pop` followed by `push`, and batch all changes to one reminder into a single `edit` call (each call counts as an edit).
   - If a command exits with code 3 (not enough credits; the message mentions `mokkan buy`), tell the user to run `mokkan buy` and stop: do not retry. Do not run `mokkan buy` yourself. `mokkan balance` shows what is left.
