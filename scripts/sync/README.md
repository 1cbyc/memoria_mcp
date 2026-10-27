# Syncing a Memoria store across devices

Memoria has no sync service and does not want one. The store is a directory of
Markdown files, so the sync problem is already solved — by git. This directory
holds two small hook scripts and a store template that make the git setup
correct rather than merely possible.

The one genuinely interesting problem is same-day conflicts, and it has a
mechanical answer: see [Why daily logs never conflict](#why-daily-logs-never-conflict).

## Setup (once per person)

```bash
# 1. Turn your store into a git repo. ~/.memoria is the default location;
#    use $MEMORIA_DIR if you put it elsewhere.
cd ~/.memoria
git init -b main

# 2. Take the template's .gitattributes and .gitignore. The .gitattributes is
#    the important half — it enables the union merge driver for daily logs.
cp /path/to/memoria_mcp/store-template/.gitattributes .
cp /path/to/memoria_mcp/store-template/.gitignore .

# 3. Commit and publish to a PRIVATE remote. This repo holds your memory.
git add -A && git commit -m "Initial memory store"
gh repo create my-memoria-store --private --source=. --push
```

Then on every other device:

```bash
git clone git@github.com:you/my-memoria-store.git ~/.memoria
```

## Setup (once per device)

Wire the two scripts into Claude Code so a session starts current and ends
published. In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/memoria_mcp/scripts/sync/memoria-sync-pull.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/memoria_mcp/scripts/sync/memoria-sync-push.sh"
          }
        ]
      }
    ]
  }
}
```

If you installed the Claude Code plugin, this is already done for you.

The scripts are plain shell — a cron job, a systemd timer, or running them by
hand works exactly as well. Neither one needs Claude Code.

## What the scripts do

| Script | When | What |
|--------|------|------|
| `memoria-sync-pull.sh` | Session start | Commits anything unflushed, optionally pulls an object-storage mirror, fetches and merges the git remote. On an unmergeable conflict it aborts the merge and writes a loud note into today's log. |
| `memoria-sync-push.sh` | Session end (every turn) | Commits the session's changes, then pushes — rate-limited to once every `MEMORIA_SYNC_INTERVAL_S` (default 900s) so the Stop hook does not hit the network on every turn. |

Both fail soft. Offline, no remote, no git repo at all: they log a line and let
the session proceed. A memory system that blocks your work when the network is
down has failed at its job.

### Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEMORIA_DIR` | `~/.memoria` | Store root (the git repo) |
| `MEMORIA_SYNC_REMOTE` | `origin` | Git remote name |
| `MEMORIA_SYNC_BRANCH` | current branch | Branch to sync |
| `MEMORIA_SYNC_INTERVAL_S` | `900` | Minimum seconds between pushes; `0` pushes every time. Local commits are never rate-limited. |
| `MEMORIA_SYNC_MIRROR` | `$MEMORIA_DIR/.memoria-mirror.sh` | Optional object-storage hook (below) |
| `MEMORIA_SYNC_ALLOW_STORE_MIRROR` | *(unset)* | Set to `true` to let either sync script execute the mirror above. The mirror lives inside the synced store, so it never runs by default. |
| `MEMORIA_SYNC_LOG` | `$MEMORIA_DIR/.sync.log` | Where the scripts log |

## Why daily logs never conflict

Two machines writing entries to the same day's log is the normal case, not an
edge case, and for an **append-only** file the resolution is mechanical: keep
both sides' lines. Nobody needs to be asked.

Git has had this built in for years as the `union` low-level merge driver, and
one line of `.gitattributes` turns it on:

```gitattributes
memories/daily/*.md merge=union
```

With that in place, a same-day edit from your laptop and your desktop merges
silently and both sets of entries survive. Without it, you get conflict markers
inside a memory file and — worse — a real chance of resolving them by picking
one side and quietly dropping an afternoon of context.

Core memories (`user/`, `project/`, `decisions/`, …) deliberately do **not**
get the union driver. Those files are edited rather than appended, so a
both-sides change is a genuine disagreement about a fact, and a human should
look at it.

> **Note on ordering.** Union merge concatenates the conflicting region; it
> does not sort by timestamp. Entries from both devices are kept, but their
> interleaving within the merged block may not be chronological. For an
> append-only log that has proven to be a non-issue in practice — everything is
> timestamped in the text — but it is worth knowing.

## Object storage (optional)

If you also run a hosted instance backed by a bucket (Cloud Run + GCS FUSE, a
VPS with S3, whatever), git alone will not see those writes. Drop an executable
at `$MEMORIA_DIR/.memoria-mirror.sh`. Neither script will execute it until
you opt in with `MEMORIA_SYNC_ALLOW_STORE_MIRROR=true` — the script lives
inside the synced store, so running it by default would let anyone who can
land a file in the store run code in your shell:

```bash
#!/usr/bin/env bash
# Called as: .memoria-mirror.sh <pull|push> <store-dir>
set -euo pipefail
BUCKET="gs://your-bucket/memoria/memories"
case "$1" in
  pull) gsutil -m -q rsync -r "$BUCKET" "$2/memories" ;;   # note: no -d
  push) gsutil -m -q rsync -r "$2/memories" "$BUCKET" ;;
esac
```

Two things matter here:

- **Never pass `-d`** (or `--delete`) on the pull. A delete-enabled sync will
  happily remove memories that exist only on this device.
- The pull runs **before** the git merge and its result is committed first, so
  bucket-side changes become ordinary commits and go through the same union
  merge as everything else.

`.memoria-mirror.sh` is git-ignored by the template, because it usually
contains bucket names and account details.

## The non-git case

Without git there is no merge driver, so nothing can combine two devices'
entries in the same daily log. A bucket-only or Syncthing-style setup does
whatever its transport does with a file changed on both sides: typically the
last writer wins, or the other copy is set aside as a conflict file. If more
than one device writes to the store, sync it with git.

(Earlier versions shipped `scripts/lib-union-merge.sh` and described it as the
answer for this case. It was not: it needed git itself, plus a hook that tagged
the last synced state, which never shipped. It was removed in 2026-09.)
