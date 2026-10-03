# Brief: notes, a third kind of item (2026-10-02)

Status: **investigated, not started**. The first step is a spike of the pane's composer handoff (see "Spike"); the
spec follows from its result.

## What the user asked for

- A **note**: something to keep and look up later (a command, a snippet, context). It never comes due, is never
  toasted or emailed, and takes no ack. It stays until it is archived.
- Notes live in the **pane** and **`mokkan ui`** only.

## Decisions

1. A note is a third item kind, with its own **Notes** tab: `TODOs │ Reminders │ Notes │ Archived`.
2. Price by size, in UTF-8 bytes after trimming, each bound included: ≤ 200 B costs 1 credit, ≤ 500 B 3,
   ≤ 1000 B 5, ≤ 10000 B 10. 10000 B is a hard cap the server enforces (400 above it).
3. An edit costs the tier of the note's new size. Note edits do not count toward the every-3rd-edit rule.
4. A note never changes kind: no `w` (due time) on a note, and a todo or reminder never becomes a note.
5. Notes can have line breaks. In `mokkan ui` through its own multi-line editor; in the pane through Claude Code's
   prompt box (option B below).
6. The CLI support is hidden flags (`push --note`, `--notes` on `list --all` and `done`), left out of help, the
   README and both skills. The pane needs them because it runs every action through the CLI (`pane.tsx:71`).
7. `d` archives a note into the shared Archived tab, marked as a note; reopening sends it back to Notes.

## Why the pane needs a workaround

The mods API has one text field, `Input`, and it is single-line: Enter submits (`claude-code.d.ts:4573`). Two ways
to get line breaks were weighed:

- **A. A `Client` element** drawing a custom editor (`surface.onKey`, `post` → `ui.message`). Rejected: it only gets
  keys after a click focuses it (no `autoFocus` on `ClientProps`), Esc takes the focus back, and the cursor,
  wrapping, scrolling and paste handling would all be written by hand.
- **B. Claude Code's own prompt box** (chosen). The prompt box already does line breaks, paste, wrap and cursor
  movement:
  1. `n` in the pane runs `$.prompt.fill({ text: '/mokkan note ', mode: 'replace' })`; `e` on a note fills
     `/mokkan note-edit <id> <current text>`. If the prompt box already holds a draft, the pane refuses and says so
     rather than overwrite it.
  2. The user writes the note and presses Enter.
  3. The pane's `command.run` hook (`pane.tsx:327`) catches `note` / `note-edit` and runs
     `run($, ['push', '--note', text])` (or `edit`), not `runLine`, which splits on whitespace and would lose the
     line breaks. No model turn, as for `/mokkan push` today.
  4. A `prompt.edit` hook watches a draft that starts with `/mokkan note` and shows the live size and cost on the
     pane's status line (`412 B · 3 credits`).

## Spike (before implementation)

A throwaway hooks module, loaded with `--plugin-dir`, that answers three questions:

1. Does `e.args` at `command.run` keep the line breaks of a multi-line `/mokkan note …`? If not, can a
   `prompt.submit` hook read the full text, save it, and `{ drop }` the prompt?
2. Does a draft of about 10000 bytes pass through `$.prompt.fill` and the command unchanged?
3. Is a `/mokkan note …` typed in the prompt box guaranteed never to reach the model?

If any answer is no, come back to option A or a pane limited to single-line notes before writing the spec.

## What changes

**Server (`mokkan-server`), released first**

- `sql/004_notes.sql`: `kind text NOT NULL DEFAULT 'item' CHECK (kind IN ('item', 'note'))` on `reminders`.
- `POST /reminders`: accepts `kind: 'note'`; refuses `due_at` with a note; checks the 10000 B cap; debits the tier.
- `PATCH /reminders/:id`: the 200-character check moves from the route (`MAX_TEXT`) into the service, which knows
  the row's kind; `due_at` on a note is refused; a note edit debits its new tier and leaves `edit_count` alone.
- `listReminders`: notes only when the client asks (`notes=1`), for every scope. Older clients (CLI 0.6.0, the
  installed plugin bundle, Codex) then never see a note as a todo.
- `pendingReminders`, `takeReminder` (pop/dequeue), `ackReminders`, `deliverReminders`: `AND kind = 'item'`.
- `toReminder` returns `kind`; older clients ignore the field.
- Unchanged: the scheduler and `emailReserve` already need `due_at`; `setDone` reopens a note to `due` (no due time).
- An open note stays in state `due`, an archived one `done`; the `kind` filters keep it out of delivery.
- Tests: routes, the tiers and their bounds, every filter above.

**CLI (`src/`)**

- `types.ts`: `kind` on `Reminder`. `client.ts`: `kind` on `push`, the `notes` option on `list`.
- Hidden flags: `push --note`, `--notes` on `list --all` and `done`.
- `done`, `undone` and `edit` resolve ids against a list (`resolvePrefixes`, `mutate.ts:52`); that list must include
  notes, or the pane's actions on a note fail with "No reminder matches".
- A copy of the tier table, for showing the cost before submitting; the server stays the authority.

**Pane (`claude-plugin/hooks/pane.tsx`, `types/index.d.ts`)**

- `MokkanTab` gains `notes`; `v` cycles four tabs. `rowsOf` (`:31`) must keep notes out of TODOs (they have no
  due time either).
- `n` and `e` as in option B; `w` and `a` hidden on a note; a note mark in Archived.
- The empty state ("No notes. n adds one."), the help view (what a note is, the tiers), the field hints.
- Polls pass the hidden flags.

**`mokkan ui` (`src/tui/`)**: the largest piece.

- The same tab and `n` key.
- A multi-line editor: line breaks, up/down cursor movement, wrapping, a scrolling area, the 10000 B cap. Today's
  input is one line capped at 2000 code points (`state.ts:73`) inside a fixed frame (`CHROME_ROWS = 7`).
- Pastes keep their newlines inside the note editor (`keys.ts:26` flattens them now).
- A view that shows a note with its line breaks: `cleanText` (`src/text.ts`) flattens to one line; this needs a
  variant that keeps `\n` and still strips terminal escapes.

**Tests, build, docs**

- `test/fake-server.ts`, client, edit and `tui-*` tests; `claude-plugin/tests/pane.test.tsx`.
- Rebuild the plugin bundle (`npm run check:bundle`).
- README (pane and `mokkan ui` sections), ASSUMPTIONS entries, CHANGELOG, the site's `#pane` mock. The skills stay
  as they are.

## Risks

- **Release order.** An older server ignores the unknown `kind` field: a new client would create a plain todo and
  charge 1 credit. Deploy the server before CLI 0.7.0; self-hosters update their server first.
- **The composer handoff borrows the prompt box.** The note is typed there, not in the pane, and a draft in the
  box blocks `n` / `e` until it is cleared.

## Open questions (ask before the spec)

1. Reading a note in the pane: show the selected note wrapped under its row, up to about 8 lines, then
   `… N more lines`? (Recommended.)
2. Saving in the `mokkan ui` editor: Enter a line break, Ctrl-S save, Esc asks before throwing away unsaved text?
   (Recommended.)
3. Balance history: note charges as `push` / `edit` (no migration), or a new `note` ledger reason (changes the
   ledger's CHECK constraint and its insert policy)?

## Done when

- Notes can be added, edited (line breaks included), read, archived and reopened from the pane and `mokkan ui`,
  charged by tier, and refused above 10000 B.
- Older clients and Codex never see a note; pending, pop, dequeue and ack never touch one.
- Server and client tests pass; `claude plugin test claude-plugin` and `claude plugin validate` pass.
