#!/usr/bin/env bash
# Vercel Ignored Build Step (vercel.json "ignoreCommand").
# Exit 0 = skip the build. Exit 1 = build.
# Skips only when every file changed since the last successful deploy
# is docs or agent config. Anything unclear falls back to building.
prev="${VERCEL_GIT_PREVIOUS_SHA:-}"
[ -n "$prev" ] || exit 1
git cat-file -e "${prev}^{commit}" 2>/dev/null || exit 1
files="$(git diff --name-only "$prev" HEAD 2>/dev/null)" || exit 1
[ -n "$files" ] || exit 1
while IFS= read -r f; do
  case "$f" in
    *.md|docs/*|.github/*|.cursor/*) ;;
    *) exit 1 ;;
  esac
done <<< "$files"
echo "Only docs/agent files changed since $prev; skipping build."
exit 0
