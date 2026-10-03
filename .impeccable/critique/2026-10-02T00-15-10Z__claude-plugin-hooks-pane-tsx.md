---
target: the mokkan pane ui
total_score: 18
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/Users/vic/dev/mokkan/claude-plugin/hooks/pane.tsx"
target_fingerprint: "sha256:30f907d5ef8870f0c4da9e60d190fdc41334a66bbfae89194ffe5cbd7d83b6fa"
target_path: /Users/vic/dev/mokkan/claude-plugin/hooks/pane.tsx
timestamp: 2026-10-02T00-15-10Z
slug: claude-plugin-hooks-pane-tsx
closed: true
---
# Critique: mokkan pane (claude-plugin/hooks/pane.tsx)
Method: dual-agent. Score 18/40 (Poor). Detector: 0 findings (web-CSS rules; blind to terminal surface).

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 1 | No in-flight/freshness state; isFocused never read; errors hidden outside normal mode |
| 2 | Match system / real world | 2 | todo vs reminders; -40m; cr/dequeue/ack unexplained |
| 3 | User control and freedom | 2 | Cancel = Tab then Enter; Esc yields focus; logout unconfirmed |
| 4 | Consistency and standards | 1 | Keymap drifts from mokkan ui; double row digits; dead variant=primary |
| 5 | Error prevention | 1 | Confirm doesn't name target; likely y y double-pop |
| 6 | Recognition rather than recall | 3 | Legend visible; glyphs unexplained |
| 7 | Flexibility and efficiency | 3 | One-key actions; no j/k; unreachable rows |
| 8 | Aesthetic and minimalist | 2 | 12-item legend eats 4 of ~15 rows |
| 9 | Error recovery | 1 | Swallowed errors; raw CLI text; offline wipes list |
| 10 | Help and documentation | 2 | Cost hints good; no glyph key or focus hint |

## Priority issues
- [P1] Errors invisible outside normal mode (pane.tsx:359; :231,:232,:243,:262). Render message line in every mode; keep typed value on failure. → harden
- [P1] No in-flight state; confirm stays live during act (:71-75), likely double pop; confirm doesn't name target; open blocks on refresh (:79). → harden
- [P1] Rows beyond room unreachable (INLINE_ROWS=6, "… N more" dead end; rows 10+ no hotkey). Scroll offset following selection. → layout
- [P2] Layout breaks at 44 cols: double digit (:315/:317), textWidth ignores 3-col prefix (:309), legend cell 11 cols collides (:215), fit counts code points, ambiguous-width glyphs. → layout, typeset
- [P2] Urgency meaningless (every push yellow ●, dim -40m, balance yellow 9 vs -3); keymap/tab names drift from mokkan ui; legend ignores isFocused. → clarify, colorize

## Persona red flags
Alex: a=done vs ack in TUI; Esc yields focus; no j/k/ack-all; double digit marks done; rows 10+ unreachable.
Sam: state glyph only; error = red only; yellow balance on light theme; digits read twice; cr unexpanded.
Riley: offline blip wipes list (:52-56); /log ?in|logged/ regex (:107); paste/mid-edit corrupts password; pop on empty asks confirm; refresh races.

## Minor
Status never clears; "bold row" comment vs code (:313); label/submit duplication; logout no hotkey/confirm; empty states lack next step; mobile hint for filtered keys; self-push likely toasts.

## Questions
Row provenance ("from repo-x · 2h ago")? Four removal verbs in 44 cols? One stack with time column? Unfocused pane as read-only tablet?
