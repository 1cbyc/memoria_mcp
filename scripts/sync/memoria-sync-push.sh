#!/usr/bin/env bash
# Memoria sync: push. Commit this session's memory changes and publish them.
# Intended for a Claude Code Stop hook (fires at the end of every assistant
# turn), so the common path has to be fast and quiet.
#
# See memoria-sync-pull.sh for the shared design notes. Same environment
# variables, plus:
#
#   MEMORIA_SYNC_INTERVAL_S  minimum seconds between pushes (default 900).
#                            The Stop hook fires constantly; without this the
#                            store would push on every turn. Local commits
#                            still happen every time — only the network round
#                            trip is rate-limited. Set 0 to push every time.
#                            A deferred push is not left for the next turn
#                            (there may be none: the session may be over): one
#                            background push is scheduled for when the
#                            interval ends.

set -uo pipefail

STORE="${MEMORIA_DIR:-$HOME/.memoria}"
REMOTE="${MEMORIA_SYNC_REMOTE:-origin}"
LOG_FILE="${MEMORIA_SYNC_LOG:-$STORE/.sync.log}"
MIRROR="${MEMORIA_SYNC_MIRROR:-$STORE/.memoria-mirror.sh}"
INTERVAL="${MEMORIA_SYNC_INTERVAL_S:-900}"
STAMP="$STORE/.last-sync"
PENDING="$STORE/.sync-push-pending"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

trap 'echo "{\"continue\": true}"' EXIT

log() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null
  echo "[$(date -Iseconds)] push: $*" >> "$LOG_FILE" 2>/dev/null
}

# Run this script again, detached, once the push interval has passed, so
# commits made in a session's last turns reach the remote even if no later
# turn fires the hook. At most one is pending at a time.
#
# Detached into its own session (setsid; perl's POSIX::setsid on macOS,
# which has no setsid binary), so the hook runner killing the hook's process
# group on exit or timeout does not take the pending push with it; nohup
# alone only survives SIGHUP. The marker holds "<pid> <expiry epoch>": a
# marker whose process is gone or whose time is up does not count, so a
# reused pid cannot block scheduling forever. The delayed run removes the
# marker BEFORE pushing, so a commit made while it pushes schedules its own.
schedule_deferred_push() {
  if [ -f "$PENDING" ]; then
    read -r PENDING_PID PENDING_UNTIL < "$PENDING" 2>/dev/null || true
    if [ -n "${PENDING_PID:-}" ] && [ "$(date +%s)" -lt "${PENDING_UNTIL:-0}" ] \
      && kill -0 "$PENDING_PID" 2>/dev/null; then
      return
    fi
  fi
  # shellcheck disable=SC2016 # expanded by the inner shell, on purpose
  RUNNER='sleep "$1"; rm -f "$3"; MEMORIA_SYNC_INTERVAL_S=0 bash "$2" >/dev/null 2>&1'
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c "$RUNNER" _ "$1" "$SELF" "$PENDING" </dev/null >/dev/null 2>&1 &
  elif command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' bash -c "$RUNNER" _ "$1" "$SELF" "$PENDING" \
      </dev/null >/dev/null 2>&1 &
  else
    nohup bash -c "$RUNNER" _ "$1" "$SELF" "$PENDING" </dev/null >/dev/null 2>&1 &
  fi
  echo "$! $(( $(date +%s) + $1 + 120 ))" > "$PENDING" 2>/dev/null
}

if [ ! -d "$STORE/.git" ]; then
  log "no git repo at $STORE — nothing to sync (see scripts/sync/README.md)"
  exit 0
fi

cd "$STORE" || { log "cannot cd to $STORE"; exit 0; }

BRANCH="${MEMORIA_SYNC_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  BRANCH="main"
fi

# 1. Commit this session's work. Always — a local commit costs nothing and is
#    what makes everything else recoverable.
COMMITTED=0
if [ -n "$(git status --porcelain -- memories/ 2>/dev/null)" ]; then
  git add memories/ 2>>"$LOG_FILE"
  if git commit -q -m "Memoria: memory updates from $(hostname 2>/dev/null || echo session)" 2>>"$LOG_FILE"; then
    COMMITTED=1
    log "committed session changes"
  fi
fi

# 2. Fast path. The Stop hook fires on every turn, so when there is nothing new
#    to publish and the last push was recent, exit before touching the network.
AHEAD="$(git rev-list --count "$REMOTE/$BRANCH..HEAD" 2>/dev/null || echo 0)"
if [ "$AHEAD" = "0" ] && [ "$COMMITTED" = "0" ]; then
  exit 0
fi

if [ "$INTERVAL" != "0" ] && [ -f "$STAMP" ]; then
  NOW="$(date +%s)"
  LAST="$(date -r "$STAMP" +%s 2>/dev/null || echo 0)"
  if [ "$((NOW - LAST))" -lt "$INTERVAL" ]; then
    WAIT="$((INTERVAL - (NOW - LAST)))"
    schedule_deferred_push "$WAIT"
    log "last push $((NOW - LAST))s ago (< ${INTERVAL}s) — committed locally, push scheduled in ${WAIT}s"
    exit 0
  fi
fi

# 3. Publish. Push can be rejected if another device pushed first; that is not
#    an error worth interrupting anyone over — the next pull will merge and the
#    next push will succeed.
if git push --quiet "$REMOTE" "$BRANCH" 2>>"$LOG_FILE"; then
  log "pushed to $REMOTE/$BRANCH"
  touch "$STAMP" 2>/dev/null
else
  log "push rejected or failed (diverged? offline?) — will retry next session"
fi

# 4. Optional object-storage mirror. Opt-in only, exactly as in the pull
#    hook (review M2/H-01): the default path is inside the synced store, so
#    executing it by default would let anyone who can land a file in the
#    store run code in your shell.
if [ "${MEMORIA_SYNC_ALLOW_STORE_MIRROR:-}" != "true" ] && [ -x "$MIRROR" ]; then
  log "mirror at $MIRROR not run: set MEMORIA_SYNC_ALLOW_STORE_MIRROR=true to allow executing a script from the synced store"
fi
if [ "${MEMORIA_SYNC_ALLOW_STORE_MIRROR:-}" = "true" ] && [ -x "$MIRROR" ]; then
  if "$MIRROR" push "$STORE" >>"$LOG_FILE" 2>&1; then
    log "mirror push OK"
  else
    log "mirror push failed — git remote still has the changes"
  fi
fi

exit 0
