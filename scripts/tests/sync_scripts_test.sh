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

# ── A deferred push is not stranded until a later turn ──
# A push inside the interval used to wait for the next Stop hook, which may
# never come (the session ended), leaving the last commits on this device.
REMOTE="$TMP/remote.git"
git init -q --bare "$REMOTE"
git -C "$STORE" remote add origin "$REMOTE"
BR="$(git -C "$STORE" rev-parse --abbrev-ref HEAD)"
git -C "$STORE" push -q origin "$BR"
# A push 27s ago with a 30s interval: deferred, with ~3s to spare for the
# "not pushed yet" check (whole-second clocks made a 2s interval flaky).
touch -d "@$(( $(date +%s) - 27 ))" "$STORE/.last-sync"
echo deferred >> "$STORE/memories/a.md"
MEMORIA_DIR="$STORE" MEMORIA_SYNC_INTERVAL_S=30 bash "$REPO_ROOT/scripts/sync/memoria-sync-push.sh" >"$TMP/out8" 2>&1
LOCAL_HEAD="$(git -C "$STORE" rev-parse HEAD)"
check "deferral: not pushed inside the interval" test "$(git -C "$REMOTE" rev-parse "$BR")" != "$LOCAL_HEAD"
check "deferral: one background push scheduled" test -f "$STORE/.sync-push-pending"
for _ in $(seq 1 15); do
  [ "$(git -C "$REMOTE" rev-parse "$BR")" = "$LOCAL_HEAD" ] && break
  sleep 1
done
check "deferral: the scheduled push reached the remote" test "$(git -C "$REMOTE" rev-parse "$BR")" = "$LOCAL_HEAD"
for _ in 1 2 3; do [ -f "$STORE/.sync-push-pending" ] || break; sleep 1; done
check "deferral: the pending marker is cleared" test ! -f "$STORE/.sync-push-pending"

# ── Conflicts only in generated files resolve themselves ──
# Two devices both regenerate MEMORY_INDEX.md (a store set up without the
# union line for it): the pull used to abort the merge on every run.
ORIGIN="$TMP/gen-origin.git"; DEV_A="$TMP/dev-a"; DEV_B="$TMP/dev-b"
git init -q --bare "$ORIGIN"
git clone -q "$ORIGIN" "$DEV_A" 2>/dev/null
git -C "$DEV_A" config user.email t@t; git -C "$DEV_A" config user.name t
mkdir -p "$DEV_A/memories/project"
printf 'index v0\n' > "$DEV_A/memories/MEMORY_INDEX.md"
printf 'core v0\n' > "$DEV_A/memories/project/core.md"
git -C "$DEV_A" add -A; git -C "$DEV_A" commit -qm base; git -C "$DEV_A" push -q origin HEAD 2>/dev/null
GBR="$(git -C "$DEV_A" rev-parse --abbrev-ref HEAD)"
git clone -q "$ORIGIN" "$DEV_B" 2>/dev/null
git -C "$DEV_B" config user.email t@t; git -C "$DEV_B" config user.name t
printf 'index from A\n' > "$DEV_A/memories/MEMORY_INDEX.md"
git -C "$DEV_A" commit -qam "A"; git -C "$DEV_A" push -q origin HEAD 2>/dev/null
printf 'index from B\n' > "$DEV_B/memories/MEMORY_INDEX.md"
git -C "$DEV_B" commit -qam "B"
MEMORIA_DIR="$DEV_B" bash "$REPO_ROOT/scripts/sync/memoria-sync-pull.sh" >/dev/null 2>&1
check "generated: merge completed" test "$(git -C "$DEV_B" rev-list --count "HEAD..origin/$GBR")" = "0"
check "generated: no merge left in progress" test ! -f "$DEV_B/.git/MERGE_HEAD"

# A page a human took over on one device (marker removed), or a note that
# only mentions the marker in its body, is a real conflict: never resolved
# by keeping one side.
mkdir -p "$DEV_A/memories/entities" "$DEV_A/memories/notes"
printf -- '---\nname: x\ngenerated: auto-compiled\n---\nv0\n' > "$DEV_A/memories/entities/x.md"
printf -- '---\nname: n\n---\n```\ngenerated: auto-compiled\n```\nv0\n' > "$DEV_A/memories/notes/n.md"
git -C "$DEV_A" add -A; git -C "$DEV_A" commit -qm pages; git -C "$DEV_A" push -q origin HEAD 2>/dev/null
MEMORIA_DIR="$DEV_B" bash "$REPO_ROOT/scripts/sync/memoria-sync-pull.sh" >/dev/null 2>&1
# A takes the page over and curates it; B (the pulling device) regenerates
# it. Keeping B's side would silently drop A's curation.
printf -- '---\nname: x\n---\ncurated by a human on A\n' > "$DEV_A/memories/entities/x.md"
printf -- '---\nname: n\n---\n```\ngenerated: auto-compiled\n```\nA edit\n' > "$DEV_A/memories/notes/n.md"
git -C "$DEV_A" commit -qam "A pages"; git -C "$DEV_A" push -q origin HEAD 2>/dev/null
printf -- '---\nname: x\ngenerated: auto-compiled\n---\nregenerated on B\n' > "$DEV_B/memories/entities/x.md"
printf -- '---\nname: n\n---\n```\ngenerated: auto-compiled\n```\nB edit\n' > "$DEV_B/memories/notes/n.md"
git -C "$DEV_B" commit -qam "B pages"
MEMORIA_DIR="$DEV_B" bash "$REPO_ROOT/scripts/sync/memoria-sync-pull.sh" >/dev/null 2>&1
check "human edits elsewhere: not auto-resolved away (merge aborted)" \
  test "$(git -C "$DEV_B" merge-base --is-ancestor "origin/$GBR" HEAD && echo merged)" != "merged"
check "human edits elsewhere: no merge left in progress" test ! -f "$DEV_B/.git/MERGE_HEAD"
git -C "$DEV_B" reset -q --hard "origin/$GBR" # start the next case from the remote

# A conflict in a real memory still stops for a human.
printf 'core from A\n' > "$DEV_A/memories/project/core.md"
git -C "$DEV_A" commit -qam "A core"; git -C "$DEV_A" push -q origin HEAD 2>/dev/null
printf 'core from B\n' > "$DEV_B/memories/project/core.md"
git -C "$DEV_B" commit -qam "B core"
MEMORIA_DIR="$DEV_B" bash "$REPO_ROOT/scripts/sync/memoria-sync-pull.sh" >/dev/null 2>&1
check "core conflict: merge aborted, local version kept" grep -q 'core from B' "$DEV_B/memories/project/core.md"
check "core conflict: logged" grep -q 'SYNC CONFLICT' "$DEV_B/.sync.log"

if [ "$fail" -eq 0 ]; then echo "all sync script tests passed"; else echo "FAILURES"; exit 1; fi
