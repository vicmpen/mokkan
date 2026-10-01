#!/usr/bin/env bash
# Builds the mokkan CLI, puts `mokkan` on PATH, installs the Codex skill, and prints how to load the Claude Code plugin.
# Never replaces a file or directory it did not create: an existing path that is not a symlink into this checkout
# is left alone with a warning. MOKKAN_INSTALL_SKIP_BUILD=1 skips `npm ci` and the build (used by the tests).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$HERE"
if [ "${MOKKAN_INSTALL_SKIP_BUILD:-}" != "1" ]; then
  npm ci --no-audit --no-fund
  npm run build
fi
chmod +x "$HERE/claude-plugin/hooks/session-start.sh" "$HERE/claude-plugin/hooks/stop.sh" "$HERE/claude-plugin/scripts/mokkan.mjs"
if [ -f "$HERE/dist/cli.js" ]; then chmod +x "$HERE/dist/cli.js"; fi

# link_ours <target> <source>: create the symlink, or refresh it if it already points into this checkout.
link_ours() {
  local target="$1" source="$2" current
  if [ -L "$target" ]; then
    current="$(readlink "$target")"
    case "$current" in
      "$HERE" | "$HERE"/*) ;;
      *) echo "warning: $target exists and is not ours; skipped"; return 0 ;;
    esac
    ln -sfn "$source" "$target"
  elif [ -e "$target" ]; then
    echo "warning: $target exists and is not ours; skipped"
    return 0
  else
    ln -s "$source" "$target"
  fi
  echo "Linked $target -> $source"
}

mkdir -p "$HOME/.local/bin"
link_ours "$HOME/.local/bin/mokkan" "$HERE/dist/cli.js"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "NOTE: add $HOME/.local/bin to your PATH (e.g. export PATH=\"\$HOME/.local/bin:\$PATH\")" ;;
esac
FOUND="$(command -v mokkan 2>/dev/null || true)"
if [ "$FOUND" != "$HOME/.local/bin/mokkan" ]; then
  echo "warning: \`mokkan\` on your PATH resolves to ${FOUND:-nothing}, not $HOME/.local/bin/mokkan (put $HOME/.local/bin earlier in PATH)"
fi

mkdir -p "$HOME/.codex/skills"
link_ours "$HOME/.codex/skills/mokkan" "$HERE/codex"

# The plugin's skill is namespaced (/mokkan:mokkan) and runs its own bundle. A user-level command that runs `mokkan` from
# PATH gives the short /mokkan.
mkdir -p "$HOME/.claude/commands"
link_ours "$HOME/.claude/commands/mokkan.md" "$HERE/claude-command/mokkan.md"

cat <<MSG

Claude Code plugin (hooks):
  one session:   claude --plugin-dir "$HERE/claude-plugin"
  every session: export CLAUDE_CODE_PLUGIN_DIRS="$HERE/claude-plugin"   (add to your shell profile)
Slash command: /mokkan is available in every session via ~/.claude/commands/mokkan.md (the plugin's skill is /mokkan:mokkan).

Next: start the server (see the mokkan-server repo README), then run:  mokkan register you@example.com
MSG

