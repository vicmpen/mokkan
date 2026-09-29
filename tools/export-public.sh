#!/usr/bin/env bash
# Exports the committed HEAD of this (private) repository into a separate public repository checkout,
# leaving out internal material, and records it as one release commit there.
#
#   tools/export-public.sh <public-repo-dir> [commit message]   (default: "mokkan <version>")
#
# The first run creates <public-repo-dir> with a fresh history; later runs add one commit per release on top.
# The commit is authored with the GitHub noreply address. Nothing is pushed.
set -euo pipefail

EXCLUDE=(.claude docs/internal .superpowers)
AUTHOR_NAME="Victor Benetatos"
AUTHOR_EMAIL="14978603+vicmpen@users.noreply.github.com"

DEST="${1:?usage: tools/export-public.sh <public-repo-dir>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean; commit first (the export uses HEAD)" >&2
  exit 1
fi
VERSION="$(node -p "require('./package.json').version")"

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd)"
case "$DEST" in "$HERE" | "$HERE"/*) echo "error: destination must be outside this repository" >&2; exit 1 ;; esac
if [ ! -d "$DEST/.git" ]; then
  git -C "$DEST" init -q -b main
fi

# Replace the tracked tree with HEAD's files (keeps $DEST/.git).
git -C "$DEST" rm -rq --ignore-unmatch . >/dev/null
find "$DEST" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive --format=tar HEAD | tar -x -C "$DEST"
for p in "${EXCLUDE[@]}"; do rm -rf "${DEST:?}/$p"; done

git -C "$DEST" add -A
if git -C "$DEST" diff --cached --quiet; then
  echo "Nothing changed since the last export."
  exit 0
fi
GIT_AUTHOR_NAME="$AUTHOR_NAME" GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" \
GIT_COMMITTER_NAME="$AUTHOR_NAME" GIT_COMMITTER_EMAIL="$AUTHOR_EMAIL" \
  git -C "$DEST" commit -q -m "${2:-mokkan $VERSION}"
echo "Exported $(git rev-parse --short HEAD) as \"${2:-mokkan $VERSION}\" into $DEST ($(git -C "$DEST" rev-parse --short HEAD)). Not pushed."
