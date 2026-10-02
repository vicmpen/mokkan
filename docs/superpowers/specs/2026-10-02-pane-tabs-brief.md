# Brief: split the stack into TODOs and Reminders; Done becomes Archived (2026-10-02)

Status: **implemented** (2026-10-02). Decisions: (1) the pane and `mokkan ui` both; (2) UI labels only, the CLI
and server unchanged; (3) it opens on Reminders while one is due (time come, not acked), else on TODOs; (4) `t`, `r`
and `w` stay on the current tab and the status line says where the item went; (5) the cyan/magenta bar stays;
(6) pop and dequeue still act on the whole stack (`mokkan ui`; they stay off in the pane). In `mokkan ui`, delivery
follows what is shown: the due rows on the current tab, none on Archived. It supersedes the "one stack" view in
`2026-10-02-pane-ia.md` ("the kind is carried by glyph and time column, not by a tab").

## What the user asked for

- Split the stack in two: a **TODOs** tab and a **Reminders** tab. Each tab lists only its own items.
- **Done** is renamed **Archived**. It works exactly as Done does today; only the name changes.

## Definitions (unchanged)

- **Todo**: `due_at === null` (made by `push`, the pane's `t`).
- **Reminder**: `due_at !== null` (made by `in`, the pane's `r`).
- The server, the API and the data model stay as they are. This is a client-side view change: filter
  `list --all` by `due_at`.

## Where it lives today

- **Pane** (`claude-plugin/hooks/pane.tsx`):
  - `MokkanTab = 'stack' | 'done'` (`claude-plugin/types/index.d.ts:26`), with the `tab` atom at `pane.tsx:15`.
  - The list is chosen at `pane.tsx:343`, and `switchView` is at `:355`.
  - The tab row `Stack N │ Done N` is at `:590`, and the `v` key ("view done / view stack") at `:451`.
  - The `d` key label is `done` or `reopen` (`:446`).
  - Empty states: "Nothing on the stack." and "Nothing finished yet. d marks a stack row done."
  - The help text mentions "Done".
- **`mokkan ui`** (`src/tui/state.ts:6`, `Tab = 'stack' | 'done'`, and `src/tui/screen.ts`) has the same two views.
- **Tests**: `claude-plugin/tests/pane.test.tsx` (`tab-stack` and `tab-done` keys, the `Stack 4` and `Done 1`
  labels, the `view done` label) and `test/tui-*.test.ts`.
- **Docs**: the README pane section ("`Stack │ Done`", "One stack and a done view"). The site's
  `#pane` mock already shows `[todo 3]  reminders 1  done 4`, close to this design.

## Target behaviour (proposal; confirm the open questions first)

- Tab row: `TODOs N │ Reminders N │ Archived N`. Each count is that tab's own rows.
- TODOs: open todos in stack order. Reminders: open reminders in stack order, scheduled ones included
  (as the stack shows them today).
- Archived: today's Done list, unchanged: the same `mokkan done` data, `d` reopens, and rows dim.
  Only the labels change.
- Row numbers (1–9 hotkeys, two digits for 10+) are per tab.
- `v` cycles TODOs → Reminders → Archived. A click on a tab label still jumps to it.
- `t` and `r` add a todo or a reminder from any tab. The new item lands in its own tab; switch to it, or
  say where it went in the status line (decide).
- `w` (set or clear a due time) moves an item between TODOs and Reminders. The selection follows it, or
  is cleared (decide).
- Toasts, delivery and heartbeat (the pane poll) are unaffected.
- Empty states per tab: "No todos. t adds one." / "No reminders. r schedules one." / "Nothing archived
  yet. d archives the selected row."
- Wording: `d` becomes "archive" (and "reopen" on Archived), status `archived · <text>`, help text
  "Archived" instead of "Done". Keep or drop the kind color bar in the gutter (cyan/magenta) now that each
  tab holds one kind (decide).

## Open questions (ask before implementing)

1. Scope: the pane only, or `mokkan ui` too? Earlier pane changes were pane-only. The IA spec says
   `mokkan ui` follows the pane's keymap.
2. Does the CLI rename too (`mokkan done` → `mokkan archive`, the `done` state name, list output), or only
   the UI labels? Recommendation: UI labels only, so the server and CLI stay as they are.
3. The default tab when the pane opens: TODOs, or the tab holding a due reminder?
4. Where a new item or a moved item (`t`, `r`, `w`) leaves the user: see above.
5. Keep the cyan/magenta bar inside single-kind tabs?
6. Pop and dequeue are commented out for now. If they return, do they act on the current tab or on the
   whole stack?

## Done when

- Each tab shows only its kind, the counts are right, `v` and the tab clicks switch, and Archived behaves
  as Done did.
- The pane tests are updated (tab keys and labels, empty states, `d` wording); `claude plugin test
  claude-plugin` and `claude plugin validate` pass.
- The README pane section is updated, and the site `#pane` mock is checked against the result.
