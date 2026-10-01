#!/usr/bin/env bash
# Claude Code Stop hook: heartbeat + surface newly due reminders via a block decision.
# Never fails the session: the CLI exits 0 on every error and logs to ~/.config/mokkan/hook.log.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 1. The plugin's own bundle (always present in an installed plugin).
# 2. A dev checkout's build (dist/ next to claude-plugin/).
# 3. `mokkan` on PATH, last: it may be an unrelated program (e.g. Ubuntu's calendar program is `remind`, not ours).
if command -v node >/dev/null 2>&1; then
  if [ -f "$DIR/../scripts/mokkan.mjs" ]; then
    exec node "$DIR/../scripts/mokkan.mjs" hook stop
  fi
  if [ -f "$DIR/../../dist/cli.js" ]; then
    exec node "$DIR/../../dist/cli.js" hook stop
  fi
fi
if command -v mokkan >/dev/null 2>&1; then
  exec mokkan hook stop
fi
# No CLI at all: leave one line in hook.log (best effort) so a silent hook is diagnosable, and still exit 0.
(
  umask 077
  LOG_DIR="${XDG_CONFIG_HOME:-${HOME:-}/.config}/mokkan"
  mkdir -p -m 700 "$LOG_DIR" \
    && printf '%s hook: mokkan CLI not found (install node, or reinstall the mokkan plugin)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$LOG_DIR/hook.log"
) >/dev/null 2>&1 || true
exit 0
