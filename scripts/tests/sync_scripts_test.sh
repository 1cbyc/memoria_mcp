#!/usr/bin/env bash
# Behavioural tests for the sync scripts (review M2/M3).
# Run: bash scripts/tests/sync_scripts_test.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0
check() { # check <label> <condition...>
  local label="$1"; shift
  if "$@"; then echo "ok - $label"; else echo "FAIL - $label"; fail=1; fi
}

# ── M3: sync-from-claude-memory never overwrites a newer destination ──
SRC="$TMP/claude"; DEST="$TMP/memoria"
mkdir -p "$SRC" "$DEST/memories/project"
printf -- '---\ntype: project\n---\n\nnewer memoria body\n' > "$DEST/memories/project/note.md"
printf -- '---\ntype: project\n---\n\nstale claude body\n' > "$SRC/note.md"
touch -d '2020-01-01' "$SRC/note.md"
touch -d '2026-01-01' "$DEST/memories/project/note.md"
MEMORIA_DIR="$DEST" bash "$REPO_ROOT/scripts/sync-from-claude-memory.sh" "$SRC" >"$TMP/out1" 2>&1
grep -q 'newer memoria body' "$DEST/memories/project/note.md"
check "M3: newer destination preserved" test $? -eq 0

# Newer source DOES overwrite, and leaves a backup of the old destination.
printf -- '---\ntype: project\n---\n\nfresh claude body\n' > "$SRC/note.md"
touch -d '2027-01-01' "$SRC/note.md"
MEMORIA_DIR="$DEST" bash "$REPO_ROOT/scripts/sync-from-claude-memory.sh" "$SRC" >"$TMP/out2" 2>&1
grep -q 'fresh claude body' "$DEST/memories/project/note.md"
check "M3: newer source wins" test $? -eq 0
ls "$DEST/memories/project/"note.md.bak-* >/dev/null 2>&1
check "M3: backup of overwritten file exists" test $? -eq 0

# Dry-run writes nothing.
printf -- '---\ntype: project\n---\n\ndry run body\n' > "$SRC/dry.md"
touch -d '2027-01-01' "$SRC/dry.md"
MEMORIA_DIR="$DEST" bash "$REPO_ROOT/scripts/sync-from-claude-memory.sh" --dry-run "$SRC" >"$TMP/out3" 2>&1
check "M3: dry-run does not write" test ! -f "$DEST/memories/project/dry.md"

# ── M2: the pull hook must not execute a mirror from the synced store ──
STORE="$TMP/store"
mkdir -p "$STORE"
git -C "$STORE" init -q
git -C "$STORE" config user.email t@t; git -C "$STORE" config user.name t
mkdir -p "$STORE/memories"
echo x > "$STORE/memories/a.md"
git -C "$STORE" add -A; git -C "$STORE" commit -qm init
printf '#!/bin/sh\necho ran >> "%s/mirror-ran"\n' "$STORE" > "$STORE/.memoria-mirror.sh"
chmod +x "$STORE/.memoria-mirror.sh"
MEMORIA_DIR="$STORE" bash "$REPO_ROOT/scripts/sync/memoria-sync-pull.sh" >"$TMP/out4" 2>&1
check "M2: store mirror not executed by default" test ! -f "$STORE/mirror-ran"
MEMORIA_DIR="$STORE" MEMORIA_SYNC_ALLOW_STORE_MIRROR=true bash "$REPO_ROOT/scripts/sync/memoria-sync-pull.sh" >"$TMP/out5" 2>&1
check "M2: store mirror runs only with explicit opt-in" test -f "$STORE/mirror-ran"

# ── H-01: the push hook must apply the same mirror gate as pull ──
# Push reaches the mirror step when it has committed something (no remote
# is configured here, so the git push itself fails soft and step 4 runs).
rm -f "$STORE/mirror-ran"
echo y >> "$STORE/memories/a.md"
MEMORIA_DIR="$STORE" MEMORIA_SYNC_INTERVAL_S=0 bash "$REPO_ROOT/scripts/sync/memoria-sync-push.sh" >"$TMP/out6" 2>&1
check "H-01: store mirror not executed by push by default" test ! -f "$STORE/mirror-ran"
echo z >> "$STORE/memories/a.md"
MEMORIA_DIR="$STORE" MEMORIA_SYNC_INTERVAL_S=0 MEMORIA_SYNC_ALLOW_STORE_MIRROR=true bash "$REPO_ROOT/scripts/sync/memoria-sync-push.sh" >"$TMP/out7" 2>&1
check "H-01: store mirror runs on push only with explicit opt-in" test -f "$STORE/mirror-ran"

if [ "$fail" -eq 0 ]; then echo "all sync script tests passed"; else echo "FAILURES"; exit 1; fi
