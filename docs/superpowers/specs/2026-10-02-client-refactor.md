# Pane keyboard: a `Client` refactor? (2026-10-02)

Status: proposal, nothing built. Next step is the spike at the end.

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
