## What this adds

<!-- A shell, a desktop backend or a background agent for mokkan notify, or a fix to one. Say which, and for which system. -->

## Tested on

- System and version (distro, macOS version):
- Desktop or window manager, and notification daemon:
- Shell and version:
- Terminal (and tmux, if used):

## `mokkan notify doctor` output

```text
(paste here)
```

## Checklist

- [ ] Tested on the system above: `mokkan notify setup`, a reminder from `mokkan in 1m …` shown, `mokkan notify status`.
- [ ] `mokkan notify doctor` output pasted above.
- [ ] Reminder text is passed as argv elements only, never interpolated into a script or a shell string.
- [ ] The module is registered, and `test/notify-contract.test.ts` passes (for a backend: one `BACKEND_TEXT` line added).
- [ ] `npm test`, `npm run typecheck` and `npm run bundle` run; the updated bundle is committed.
- [ ] `mokkan notify remove` cleans up everything this adds, and leaves files without the "managed by mokkan" marker alone.
- [ ] README updated (the setup table, the terminal table or the backend list), if users see a difference.
