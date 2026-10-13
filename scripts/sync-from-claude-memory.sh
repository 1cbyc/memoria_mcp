#!/bin/bash
# Sync memories from Claude Code's built-in memory into Memoria's canonical store
# This is a one-way pull: ~/.claude/projects/<project>/memory/ → $MEMORIA_DIR/memories/
#
# Usage: scripts/sync-from-claude-memory.sh [--dry-run] [CLAUDE_MEMORY_DIR]
#
# An existing destination is only overwritten when the source is NEWER
# (mtime); a differing but older source is skipped, and every overwrite
# first copies the destination to <file>.bak-<timestamp> (review M3).
#
#   MEMORIA_DIR        the Memoria store. Defaults to ~/.memoria, like the
#                      server; set it if your store lives elsewhere.
#   CLAUDE_MEMORY_DIR  the auto-memory directory to import, as an argument or
#                      in the environment. Optional when only one Claude Code
#                      project has one; with several, the script lists them.

set -euo pipefail

# Until 2026-09 this used the script's own checkout as the store and imported
# the first project whose name matched *memoria*: right on the maintainer's
# machine, and wrong everywhere else.
MEMORIA_DIR="${MEMORIA_DIR:-$HOME/.memoria}"
MEMORIES_DIR="$MEMORIA_DIR/memories"
DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi
CLAUDE_MEMORY_DIR="${1:-${CLAUDE_MEMORY_DIR:-}}"

if [ ! -d "$MEMORIES_DIR" ]; then
  echo "No Memoria store at $MEMORIES_DIR. Set MEMORIA_DIR to your store's directory." >&2
  exit 1
fi

if [ -z "$CLAUDE_MEMORY_DIR" ]; then
  candidates=()
  for _cand in "$HOME"/.claude/projects/*/memory; do
    [ -d "$_cand" ] && candidates+=("$_cand")
  done
  case ${#candidates[@]} in
    0)
      echo "No Claude Code auto-memory found under $HOME/.claude/projects/."
      exit 0
      ;;
    1)
      CLAUDE_MEMORY_DIR="${candidates[0]}"
      ;;
    *)
      echo "Several Claude Code projects have auto-memory. Choose one:" >&2
      printf '  %s\n' "${candidates[@]}" >&2
      echo "Usage: $0 <CLAUDE_MEMORY_DIR>   (or set CLAUDE_MEMORY_DIR)" >&2
      exit 1
      ;;
  esac
fi

if [ ! -d "$CLAUDE_MEMORY_DIR" ]; then
  echo "Not a directory: $CLAUDE_MEMORY_DIR" >&2
  exit 1
fi

echo "Syncing from: $CLAUDE_MEMORY_DIR"
echo "         to: $MEMORIES_DIR"
echo ""

synced=0

for src_file in "$CLAUDE_MEMORY_DIR"/*.md; do
  [ -f "$src_file" ] || continue
  basename_file=$(basename "$src_file")

  # Skip MEMORY.md index file
  [ "$basename_file" = "MEMORY.md" ] && continue

  # Determine destination based on type in frontmatter
  type=$(sed -n 's/^type: *//p' "$src_file" | head -1)
  case "$type" in
    user)    dest_dir="$MEMORIES_DIR/user" ;;
    project) dest_dir="$MEMORIES_DIR/project" ;;
    feedback) dest_dir="$MEMORIES_DIR/feedback" ;;
    reference) dest_dir="$MEMORIES_DIR/references" ;;
    *)       dest_dir="$MEMORIES_DIR/project" ;; # default
  esac

  dest_file="$dest_dir/$basename_file"

  if [ -f "$dest_file" ]; then
    # Compare content (ignoring frontmatter differences)
    src_content=$(sed -n '/^---$/,/^---$/!p' "$src_file")
    dest_content=$(sed -n '/^---$/,/^---$/!p' "$dest_file")

    if [ "$src_content" = "$dest_content" ]; then
      echo "  SKIP (identical): $basename_file"
      continue
    fi
    # "Different" is not "newer": never let a stale machine destroy edits
    # made in Memoria since (M3). Equal mtimes count as not-newer.
    if [ ! "$src_file" -nt "$dest_file" ]; then
      echo "  SKIP (destination is newer or same age): $basename_file"
      continue
    fi
    echo "  UPDATE (source is newer): $basename_file → $dest_dir/"
    if [ "$DRY_RUN" -eq 0 ]; then
      cp "$dest_file" "$dest_file.bak-$(date +%Y%m%d%H%M%S)-$$"
    fi
  else
    echo "  ADD (new): $basename_file → $dest_dir/"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    (dry-run: not written)"
    continue
  fi
  mkdir -p "$dest_dir"
  cp "$src_file" "$dest_file"
  synced=$((synced + 1))
done

echo ""
echo "Synced $synced file(s)."
if [ "$synced" -gt 0 ]; then
  echo "Remember to update memories/MEMORY_INDEX.md if new files were added."
fi
