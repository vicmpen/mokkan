# Pane keyboard: a `Client` refactor? (2026-10-02)

Status: decided, no `Client` refactor. A `prompt.edit` hook drops the keys that leak, see
"Decision" at the end.

## The problem

While the pane holds the keyboard (ctrl+x tab, `/mokkan-pane focus`, or a click), a key that
no pane `Button` binds gives the keyboard back to the prompt, and the key is typed there.
In practice the focus "jumps" to the session on a stray key, and the key ends up in Claude's
prompt. The user asked whether focus could move between pane and session by clicks only.

Two instances already seen:

- `b` (buy) was unbound in the pane, so it typed `b` into the prompt. Fixed by adding a
  `b · buy` Button.
- `0` has no row of its own: the `0: row 10, 20…` legend Button is what catches it. Without
  it, `1` `0` selects row 1 and types `0` into the prompt.

## What the engine allows (plugin API, build 2.1.287)

- A `Button` `hotkey` (one digit or lowercase letter) presses it while its site holds the
  keyboard. A key no Button binds leaves the pane. Esc always hands the keys back.
- `PaneOpenArgs` (`focus`, `closeOnEscape`, `holdToasts`, `rows`, `columns`) has no option to
  keep the keyboard.
- No event fires when the pane loses the keyboard. `ui.focus` is the ring moving among the
  pane's own elements, not the site losing the keys, so the mod cannot take them back.
- A digit only arms the hotkeys of Buttons in view: a hidden Button cannot catch a key.
- The one element that receives every key is `Client` (`surface.onKey`). Only Escape leaves
  it, and it takes the keys "while a click has given it the focus". There's no `Client` on
  `mobile` or `vscode`.

So from the mod there are two routes:

1. **Bind the keys people actually press.** Any letter a Button binds stays in the pane.
   Cheap, but it costs legend space, and an unbound key still escapes.
2. **Draw the pane body as a `Client`.** Every key is caught, and the click-only focus is
   close to what was asked. It's a rewrite of the input side, covered below.

## How a `Client` works

A `Client` is a surface module: `(props, surface) => tree`, run on the drawing thread.

- It has no `$`. It can't run the CLI, read `$.state` or use `$.clock`. It gets plain JSON
  `props` and has local `surface.state`/`setState`.
- `surface.onKey`, `surface.onPointer` and `surface.every` are its inputs.
- `surface.post(data)` reaches the hooks module as a `ui.message` event (`e.data`). A hook
  answering `{ props }` hands the instance its next props.
- It draws with `surface.elements`: the terminal element table, minus `Client`, `Raster` and
  `Image`.

## Can we reuse the code?

Mostly yes. All of the non-drawing code stays, and so does most of the layout. The input
side is what's rewritten, because the engine does it for free today.

### Stays as it is

- CLI and data: `cli`/`find`, `run`, `refresh`, `act`, `work`, `say`, the atoms, the
  `/mokkan-pane` command, the minute timer, auto-open and the `classic.SessionStart` reload.
  That's roughly the first 300 of `pane.tsx`'s ~700 lines.
- The actions: done/reopen, ack, push, in, edit, due, view switch, the confirms (pop,
  dequeue, logout), login/register and buy. Today they're closures in the render hook. They
  move to a `ui.message` handler that switches on `e.data`, with the same logic.
- The two-digit row typing (`typed`) moves with them.
- The text helpers: `graphemes`, `cells`, `fit`, `when`, `detail`, `mark`, `span`, `hm`, the
  legend wrapping and `HELP_TEXT`. There are two ways to reuse them:
  - The render hook computes the finished lines and passes them as props, so the `Client`
    only draws strings and the helpers don't move. (Preferred.)
  - A shared module imported by both. That depends on surface modules being allowed to
    import a sibling file, which is undocumented.
- The layout: `Box`/`Text` come from the same element table, so the tree mostly carries
  over.

### Rewritten

- **Key handling.** One `onKey` handler replaces what the engine does now:
  - letters map to actions;
  - ↑/↓ and Tab move the selection (today the focus ring does this, and `ui.focus` selects
    the row);
  - digits go to the row typing logic;
  - y/n answer the confirms;
  - help and back.
- **Text fields** (push, in, edit, due, email, OTP, masked password). Whether `Input` works
  inside a `Client` is undocumented. If it doesn't, the module needs a small line editor:
  insert, backspace, paste, Enter, and masking for the password. The password must still
  never reach `$.state` or the drawing.
- **Clicks on rows.** An `onPointer` handler maps `y` to a row, unless Buttons inside a
  `Client` still take clicks, which is also undocumented.
- **Scrolling.** `$.ui.scroll({ to: row })` (`reveal`) targets the pane's own elements. A
  `Client` that's taller than the pane probably needs its own windowing over the rows.
- **Tests.** The ~25 pane tests drive Buttons with `ui.press({ key })`. Those steps become
  `ui.key({ key, in })`. Assertions on drawn text mostly survive.

### Catches

- **Focus by click only.** `/mokkan-pane focus` and the `focus` on open would likely stop
  giving the keys to the body. That's in line with the request, but the command's text and
  the help line must change.
- **Two drawing paths.** `mobile` and `vscode` have no `Client`, so the current Button tree
  stays as their fallback. Every layout change would then have to be made twice, unless the
  fallback is reduced to a read-only list.
- **Limits.** A surface module call has a one-second cap. A throw, an overrun or a tree past
  the bounds unmounts the instance. Three `setState` renders in a row with no input between
  them count as a render loop.

## Recommendation

Spike before deciding. Put a throwaway `Client` in the pane that logs keys and pointer
events, and answer:

1. Does ctrl+x tab, `/mokkan-pane focus` or `open({ focus })` give the `Client` the keys, or
   only a click?
2. Does an `Input` inside a `Client` take typing? Do Buttons inside it take clicks?
3. Can a surface module import a sibling file?
4. How does a `Client` taller than the pane scroll?

If `Input` and clicks work inside a `Client`, this is a moderate refactor: a new key
handler, and the actions moved to `ui.message`. If not, add the line editor and pointer
mapping on top. Until then, keep route 1 and bind the keys that actually leak.

## Spike results (2026-10-02)

The spike is `/mokkan-pane spike` on branch `pane-client-spike`: `hooks/spike-client.tsx` logs
keys and pointer events and holds an `Input`, a `z` Button and 60 filler rows;
`hooks/spike-import.tsx` imports `hooks/spike-shared.ts`. Tried by hand in a terminal, plus
`tests/spike.test.tsx`.

1. **Focus.** Once the `Client` has the keys, it gets every key, and Esc hands them back to the
   prompt. That is the behaviour asked for. A click on the body (left of the list) gives it the
   keys. A click on a Button inside it does not: the Button presses, the pointer events are
   logged, and the pane stays unfocused. ctrl+x tab and `/mokkan-pane focus` do not give the
   keys: the pane reports itself focused, but what you type goes to the prompt. A click is
   the only way in.
2. **`Input` and Buttons in a `Client`.** You can't type into an `Input` inside a `Client` in
   the terminal, so the module needs its own line editor (insert, backspace, paste, Enter,
   masking). Buttons do take clicks, but a click on one does not focus the `Client` (see 1).
   The test kit drives both by key, so a passing test does not prove the terminal does.
3. **Sibling import.** Works: the engine accepts the module and draws the imported text. The
   text helpers can live in a shared module, if passing finished lines as props turns out
   awkward.
4. **Scrolling a `Client` taller than the pane.** The pane scrolls it with the wheel, down to
   the last filler row. Not checked: keeping the selected row in view as ↑/↓ move it, since
   `$.ui.scroll({ to: { key } })` targets the pane's own elements, not rows a `Client` draws.

### What it changes

- The refactor is the larger variant: a line editor and the key handler, with actions moved
  to `ui.message`.
- Clicks: draw rows as plain `Text` and map `onPointer`'s `y` to a row, rather than Buttons.
  A Button click would leave the pane without the keys, which defeats the point. The same
  goes for the view tabs and the legend: map them too, or leave them as text.
- Focus is click-only. ctrl+x tab, `/mokkan-pane focus` and the `focus` on open would mark the
  pane focused while every key still goes to the prompt, which is worse than today. Either
  drop `focus` (the command, the open option, the "ctrl+x tab" hints and help line) and say
  "click the pane to use keys", or keep a Button-tree view for the focused-without-a-click case.
  Dropping it is simpler, and matches the ask.

## Decision: catch the leaked key in `prompt.edit` (built)

The `Client` route works, but it costs keyboard focus, `Input` (a line editor instead), Button
clicks, and a second tree for mobile and vscode. A smaller route closes the leak and keeps the
Button tree, keyboard focus and the tests:

- `prompt.edit` fires for a key the prompt's editor takes, with the key on `e.key`, and a hook
  answering `{ text: e.text, cursor: e.cursor }` without `next` consumes it (d.ts, build
  2.1.287; the online reference lists `prompt.edit` but doesn't spell out consuming).
- A key no Button binds leaves the pane and arrives there. Tried by hand: it did, the hook
  dropped it, and `$.ui.open({ focus: true })` from the hook gave the pane the keys back (`h`
  opened the help right after).
- Which key is the pane's: the engine already reports the pane unfocused when the key arrives
  (`$.ui.panes()`), so that can't tell. The pane's own last draw can: the redraw that says it
  let go comes just before or just after the leaked key. So the hook drops a single unmodified
  key while the pane last drew itself focused, or within 100 ms of the draw that saw it let
  go, and only while the pane is open. Typing after Esc comes later and passes.
- ctrl/cmd combinations and pastes always pass. The `b · buy` and `0: row 10, 20…` Buttons
  stay: they are real keys, and `1` then `0` needs the pane to see the `0`.

Not seen by hand yet: the order where the redraw comes first and the 100 ms window catches the
key. It's covered by a test only. Esc and a key typed within 100 ms of each other would lose that
key.
