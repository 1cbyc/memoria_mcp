# Memoria

**Persistent, plain-text memory for Claude — as a Markdown repo you own.**

Memoria is an [MCP](https://modelcontextprotocol.io) server that gives Claude Code, claude.ai (Chat / CoWork) and any other MCP client a shared long-term memory. Memories are Markdown files with YAML frontmatter in a directory you control; a derived SQLite + FTS5 index provides hybrid semantic + keyword search; a set of agentic tools (reflect, lint, compact, compile) keeps the store healthy; and an optional collector daemon feeds in events from your own tools. It runs as a stdio server for Claude Code and as an OAuth 2.1 HTTP server for remote clients.

![The Memoria dashboard's wiki view: a memory rendered from Markdown, with its details, related memories and backlinks](docs/images/dashboard-wiki.png)

<sub>The dashboard's wiki view, showing the built-in demo data (`npm run demo`).</sub>

> **Status: early public release.** The server has run as the maintainer's daily driver since spring 2026 (hosted on Cloud Run, two adversarial security reviews and a full code review, a test suite CI runs on Ubuntu and Windows). It installs as a Claude Code plugin or from npm as [`@agrippa87/memoria-mcp`](https://www.npmjs.com/package/@agrippa87/memoria-mcp) — see [Roadmap](#roadmap). The sub-memory **collector** (iMessage / IMAP / Google ingestion) ships but should be treated as **experimental**; read [SECURITY.md](SECURITY.md) before enabling sources.

**Why Memoria instead of another memory layer?**

- **You own the data.** Plain Markdown in a folder — grep it, edit it, commit it, diff it. The SQLite index is derived and fully rebuildable. No hosted database, no proprietary format, no lock-in.
- **Multi-device without a service.** Keep the store in a private git repo; daily logs are append-only and merge with git's union driver, so two machines writing the same day never clobber each other ([Multi-device sync](#multi-device-sync)).
- **Agentic self-maintenance.** Write-time dedup, reflection, contradiction lint, decay/promotion, and a deterministic "compile, don't retrieve" loop that rolls the daily firehose into linked entity pages.
- **Spec-complete remote transport.** OAuth 2.1 with PKCE, client credentials, dynamic client registration and metadata discovery — works as a claude.ai custom connector out of the box.
- **Honest about search.** Three embedding providers (local MiniLM → n-gram fallback, plus OpenAI as an explicit opt-in), three-signal scoring, and every result reports its scan coverage.

## Recent updates — 0.3.0: security hardening and relevance-led search

A whole-repo review, and a critical re-review after it, hardened the
server, the collector, and the sync scripts. Full details are in
[CHANGELOG.md](CHANGELOG.md) (0.3.0) and [SECURITY.md](SECURITY.md). The
changes most likely to affect you:

- **Search ranks by relevance first.** Default weights are now
  `0.8·relevance + 0.1·recency + 0.1·importance` (were 0.5/0.2/0.3), and
  recency comes from each memory's own `updated` date rather than from when
  it was indexed. The index is rebuilt once on first start.
- **MCP callers can only change a source's schedule.** Hosts, credentials,
  paths and labels change in the dashboard, so a prompt-injected agent
  cannot point a consented source (and its stored password) elsewhere.

- **Collector consent is dashboard-only.** The `memory_sources` `agree`
  action was removed: an MCP caller (including a prompt-injected one) can
  no longer consent on your behalf. Grant consent in the dashboard's
  Sources tab, then enable the source as before.
- **Remote embeddings are opt-in.** Setting `OPENAI_API_KEY` no longer
  sends memory content and search queries to OpenAI by itself; only
  `MEMORIA_EMBEDDINGS=openai` does. `auto` now stays on this device.
- **One server per store.** A second process opening the same store now
  fails at startup with a clear message instead of racing the first
  (SQLite also waits on contention, and compile-queue drains are atomic).
- **Sync scripts are safer.** The pull hook executes a mirror script from
  inside the synced store only with `MEMORIA_SYNC_ALLOW_STORE_MIRROR=true`,
  and `sync-from-claude-memory.sh` overwrites only newer files, backing up
  whatever it replaces (`--dry-run` previews changes).
- **Pinned, bounded, encrypted.** On-demand adapter installs use exact
  pinned versions, tool inputs (`days`, `batch_size`, query length, …)
  are bounded, and the provenance archive stores content encrypted rather
  than plaintext. Optional: `MEMORIA_AUTHORIZE_REQUIRE_APPROVAL=true`
  requires a dashboard login or the API key before `/authorize` issues a
  code, and disables the `client_credentials` grant. docker-compose now
  also requires `MEMORIA_PUBLIC_URL` in `.env` (the `.env.example`
  localhost value covers purely local use).

Under the hood, the collector daemon gained a dedicated test suite (which
also caught that its first poll on startup never ran — now fixed), and
behavioural tests now cover the sync scripts and the Python ingestion hook.

## Architecture

```
 Claude Code          Claude Chat          CoWork
 (CLI)                (claude.ai)          (claude.ai)
      |                    |                    |
 Direct file           MCP Server          MCP Server
 read/write           (HTTP/OAuth)        (HTTP/OAuth)
      |                    |                    |
      +-------- $MEMORIA_DIR/memories/ ---------+
                   (canonical store)
                         |
              +----------+----------+
              |                     |
        SQLite + FTS5         Sub-Memory
      (search index)          Collector
                              (daemon)
                                 |
                   +------+------+------+
                   |      |      |      |
                iMessage Email Calendar Custom
                   |      |      |      |
                   +------+------+------+
                         |
                 Encrypted Ring Buffer
                         |
                 Ingestion Pipeline
                 (re-score, dedup,
                  rate-limit, fuse)
```

**Key principle**: Markdown files are the source of truth. The SQLite index is derived and fully rebuildable from the files.

## Features

- **17 MCP tools** for memory management, data collection, lint, knowledge compilation, entity-page compilation, and digest compaction
- **Sub-memory collector** with source adapters for iMessage, macOS Calendar, Email (IMAP), Gmail, Google Calendar, Google Drive, and user-defined custom sources
- **Three-signal retrieval**: `score = 0.8 x relevance + 0.1 x recency + 0.1 x importance` — relevance decides, recency and importance break ties ([eval](mcp-server/eval/README.md))
- **Hybrid search**: Vector cosine similarity (0.7) + FTS5 BM25 keyword scoring (0.3). Three embedding providers: local `all-MiniLM-L6-v2` via `@huggingface/transformers` by default (true semantic, fully offline after a one-time ~23MB download), n-gram hashing as the lexical fallback, and OpenAI `text-embedding-3-small` only when explicitly selected with `MEMORIA_EMBEDDINGS=openai` (an `OPENAI_API_KEY` alone never sends content off the device).
- **Cross-source temporal fusion**: Detects correlated activities across sources within configurable time windows
- **Write-time dedup**: Checks top-3 similar memories before every write, returns duplicates for agent review
- **Encrypted at rest**: All collector data encrypted with AES-256-GCM; master key auto-generated, owner-only (0600)
- **User agreement flow**: Sources cannot be enabled without explicit user consent
- **Auto-dependency installation**: A source's npm packages are installed when it is enabled — into the data directory, never the memory store, with install scripts disabled
- **Content hashing**: Skips re-embedding unchanged files during reindex (SHA-256)
- **Importance scoring** (1-10) with idempotent decay/boost and health monitoring
- **FTS5 full-text search** with automatic sync triggers
- **Bi-temporal metadata**: `valid_from` / `valid_until` for temporal reasoning
- **Memory linking**: Zettelkasten-style `related` field for graph-like traversal
- **Agentic behaviors**: Reflection, consolidation, self-assessment, promotion/demotion
- **OAuth 2.1 authentication**: Full MCP-spec auth with authorization_code + PKCE, client_credentials, dynamic client registration, and metadata discovery
- **Security hardening**: Rate limiting, body size limits, session caps, path traversal protection, timing-safe comparisons
- **Dual transport**: stdio (Claude Code) + Streamable HTTP / SSE (claude.ai and other remote MCP clients)
- **Docker-first deployment**: multi-stage image, non-root user, persistent volume; a reference Cloud Run + GCS FUSE template under [`deploy/gcp/`](deploy/gcp/README.md)
- **Spec-compliant YAML parser**: Uses `js-yaml` for frontmatter (handles quoted colons, multi-line strings, special chars in tags) — gracefully degrades on malformed YAML
- **Bounded lint operations**: Contradiction scan capped at top 30 memories by importance, batched 5-in-parallel to control embedding API cost
- **Buffer capacity reporting**: `/ingest` returns `bufferDropped` count and `bufferUsage` so callers know when events are dropped at capacity, and `failed` for events that could not be written this time (kept for retry)
- **Test suite**: covers atomic writes and key-file creation, non-ASCII keyword search, dashboard escaping and CSP, chunker, embeddings, store, optimizer, ingestion, path resolution (incl. symlink-leaf containment), file_watcher allowlisting, privacy-tier classification + sink-side redaction, AES-256-GCM crypto (round-trip/tamper/strict-key), YAML edge cases, access tracking, plus an **HTTP integration suite** (supertest over the real Express app: the `/dashboard/api` Bearer auth-gate, the full OAuth `authorization_code`+PKCE flow end-to-end, client-credential + API-key-decoupling checks, redirect allowlisting) and **wiki rendering** (code-safe `[[wikilink]]` resolution, stored-XSS escaping, link-label safety). CI fails on coverage regression via per-file floors, and checks the built Docker image as its runtime user.
- **File watcher**: Auto-reindex on change with 1.5s debounce, plus a periodic reindex sweep (default 5 min) as a fallback for mounts where `fs.watch` is inert (e.g. GCS FUSE on Cloud Run)

## Quick Start

### Prerequisites

- Node.js 20+ (`better-sqlite3` requires it; CI tests on 22, the Docker image runs 26)
- npm
- (Optional) an OpenAI API key for the highest-quality embeddings. Without one, a local `all-MiniLM-L6-v2` model provides semantic embeddings fully offline (one-time ~23 MB download).

### Option A: install the Claude Code plugin (fastest)

In Claude Code:

```
/plugin marketplace add Agripp87/memoria_mcp
/plugin install memoria@memoria
```

That registers the MCP server and — if your store is a git repo — wires up the
SessionStart/Stop sync hooks. The first launch installs dependencies and builds
from source, which takes a minute; after that it starts immediately.

Nothing else is required: the store defaults to `~/.memoria` and is created on
the first write. Skip to [Tell Claude how to use it](#tell-claude-how-to-use-it) — or read on for
a manual install.

### Option B: build from source

```bash
git clone https://github.com/Agripp87/memoria_mcp.git
cd memoria_mcp/mcp-server
npm install
npm run build
```

**From npm** (Node 20+):

```bash
npm install -g @agrippa87/memoria-mcp
claude mcp add memoria -s user -- memoria-mcp
# or, without a global install:
claude mcp add memoria -s user -- npx -y @agrippa87/memoria-mcp
```

### Try it on fake data (30 seconds)

```bash
npm run demo
# → generates a throwaway ./demo-store with ~29 cross-linked memories
# → open http://127.0.0.1:3110/dashboard   (key: demo-key-123)
```

### Register with Claude Code (manual install)

```bash
claude mcp add memoria -s user -- node /absolute/path/to/memoria_mcp/mcp-server/scripts/mcp-start.mjs
```

or add to `~/.claude.json` / your project's `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "memoria": {
      "command": "node",
      "args": ["/absolute/path/to/memoria_mcp/mcp-server/scripts/mcp-start.mjs"],
      "env": { "MEMORIA_DIR": "/path/to/your/memory-store" }
    }
  }
}
```

The store defaults to `~/.memoria` (`MEMORIA_DIR` overrides it). The first `memory_write` creates the directory layout. `OPENAI_API_KEY` in `env` switches to OpenAI embeddings.

> **Why `scripts/mcp-start.mjs` and not `dist/index.js`:** the wrapper runs
> `tsc` before serving (compiler output redirected to stderr — stdout is the
> JSON-RPC transport), so the server you talk to is always built from the
> checked-out source. If the build fails, it falls back to the previous
> `dist/` with a loud stderr warning rather than starting nothing.

### Tell Claude how to use it

Memoria works best with a short standing instruction in your `CLAUDE.md` — e.g. *"At session start, `memory_search` for context relevant to the task. Record decisions, solved bugs and preferences with `memory_daily` during the session, `memory_write` for durable facts. Do not capture transactional work."* The server's own MCP instructions suggest logging what is worth keeping; they no longer require an entry every session.

### Remote access (claude.ai, other devices) with Docker

```bash
cp .env.example .env
# fill in MEMORIA_API_KEY, MEMORIA_OAUTH_CLIENT_SECRET, MEMORIA_ENCRYPTION_KEY
# (generation one-liners are in the file) and MEMORIA_PUBLIC_URL
docker compose up -d
curl http://localhost:3100/health
```

The compose file publishes the port on loopback only and mounts a named volume at `/data` for the store. Put it behind your usual TLS ingress (Caddy, Cloudflare Tunnel, ngrok, a reverse proxy) and set `MEMORIA_PUBLIC_URL` to the external URL.

Then in **claude.ai → Settings → Connectors → Add custom connector**:

- **URL**: `https://<your-host>/mcp`
- **Advanced → OAuth Client ID**: `memoria`
- **Advanced → OAuth Client Secret**: your `MEMORIA_OAUTH_CLIENT_SECRET`

For a durable cloud deployment see [`deploy/gcp/README.md`](deploy/gcp/README.md) (Cloud Run + GCS FUSE + Secret Manager, with CI/CD and auto-rollback). The server itself only needs a directory at `MEMORIA_DIR`, so any host with a persistent volume works.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORIA_API_KEY` | *(required for HTTP)* | Bearer token for HTTP transport authentication (`/mcp`, `/ingest`, `/dashboard/api`). Distinct from the OAuth client secret below. |
| `OPENAI_API_KEY` | *(none)* | API key for OpenAI embeddings. On its own it does **not** enable remote embeddings (see `MEMORIA_EMBEDDINGS`); when remote embeddings are enabled, memory content and search queries are sent to OpenAI. |
| `MEMORIA_EMBEDDINGS` | `auto` | Embedding provider: `auto` (local MiniLM if installed, else hash — never remote), `openai` (explicit opt-in: sends content to OpenAI), `minilm` (local all-MiniLM-L6-v2, 384-dim, true semantic), or `hash` (n-gram lexical fallback, 384-dim). |
| `MEMORIA_AUTHORIZE_REQUIRE_APPROVAL` | `false` | When `true`, `/authorize` additionally requires a dashboard session (log in to the dashboard in the same browser first) or the API key, and the `client_credentials` grant is disabled, so a leaked OAuth client secret alone cannot obtain a token. |
| `MEMORIA_MODEL_CACHE` | *(package default)* | Directory for the cached MiniLM model. The Docker image pre-bakes it at `/app/mcp-server/.models`; the build fails if the download does, unless you pass `--build-arg PREFETCH_MODEL=false` (for OpenAI or hash embeddings, or offline builds). |
| `MEMORIA_MODEL_OFFLINE` | `false` | Set to `true` to forbid model downloads (use only the cached/pre-baked model). |
| `MEMORIA_OAUTH_CLIENT_SECRET` | *(required when `BIND_ALL=true`)* | OAuth client secret. Keep it distinct from the API key so rotating one doesn't rotate the other. Locally (loopback) it falls back to the API key with a warning. |
| `MEMORIA_ENCRYPTION_KEY` | *(required when `BIND_ALL=true`)* | AES-256-GCM master key (64 hex chars) for the collector's encrypted buffer and credential store. Locally, an on-disk key is auto-generated at `data/collector.key` unless `MEMORIA_REQUIRE_ENCRYPTION_KEY=true`. Rotating it makes existing ciphertext unreadable. |
| `MEMORIA_REQUIRE_ENCRYPTION_KEY` | `false` | Refuse to start without `MEMORIA_ENCRYPTION_KEY` (fail-closed; no on-disk key fallback). |
| `MEMORIA_OAUTH_CLIENT_ID` | `memoria` | OAuth client id the token endpoint expects (and `/register` hands out). |
| `MEMORIA_ALLOWED_REDIRECT_HOSTS` | `claude.ai,claude.com,anthropic.com,localhost,127.0.0.1` | Comma-separated hostnames permitted as OAuth `redirect_uri` targets (subdomains allowed). Must be `https`; plain `http` is accepted only for `localhost` / `127.0.0.1`. |
| `MEMORIA_TOKEN_DB_DIR` | the data directory | Where the OAuth token database (`tokens.sqlite`) lives. Set it to container-local disk when the data directory is a FUSE or network mount, where SQLite locking is unreliable — the Docker image sets `/tmp/memoria`. Tokens are stored hashed and live 24h, so an ephemeral location only costs a re-auth after restart. |
| `MEMORIA_ALLOW_SHELL_SOURCES` | `false` | Set to `true` (trusted local instances only) to permit `shell_command` custom sources, which execute arbitrary commands. Disabled by default. |
| `MEMORIA_FILE_WATCHER_ROOTS` | *(none — watchers disabled)* | Comma-separated directories that `file_watcher` collector sources may watch. Unset or empty refuses every watcher; a path inside the collector data directory (key and credentials) is refused regardless. |
| `MEMORIA_REINDEX_INTERVAL_MS` | `300000` | Interval for the periodic reindex sweep (fallback for inert `fs.watch`). |
| `MEMORIA_AUTO_OPTIMIZE` | `false` | Set to `true` to run the idempotent decay/promote/staleness passes on a timer (genuinely autonomous self-management), instead of only when an agent calls `memory_optimize`. |
| `MEMORIA_OPTIMIZE_INTERVAL_MS` | `86400000` | Interval for the auto-optimize pass (default 24h; only used when `MEMORIA_AUTO_OPTIMIZE=true`). |
| `MEMORIA_AUTO_COMPILE` | `false` | Set to `true` to autonomously roll the daily-log firehose up into linked entity pages on a timer (the "compile, don't retrieve" loop), instead of only when an agent calls `memory_entities`. Drains the ingest-driven compile queue so only sources touched since the last run are rebuilt. |
| `MEMORIA_COMPILE_INTERVAL_MS` | `86400000` | Interval for the auto-compile pass (default 24h; only used when `MEMORIA_AUTO_COMPILE=true`). |
| `MEMORIA_RAW_ARCHIVE` | `true` | Durable, immutable provenance archive of every ingested event under `data/raw/<source>/<YYYY-MM>.jsonl` (privacy-aware: `local-only` stores a hash only). **Batched** (one append per source per ingest cycle) and **rotated** (5MB parts), so it is safe on object-storage FUSE mounts. Set to `false` to disable. |
| `MEMORIA_RAW_ARCHIVE_BATCH` / `MEMORIA_RAW_ARCHIVE_FLUSH_MS` / `MEMORIA_RAW_ARCHIVE_ROTATE_BYTES` | `20` / `60000` / `5242880` | Raw-archive batching knobs: flush after N buffered records or T ms (also flushed every ingest cycle and on shutdown); rotate to a new `-pN.jsonl` part past the byte cap. |
| `MEMORIA_INGEST_MAX_ATTEMPTS` | `3` | Failed ingest attempts before a poison event is dead-lettered (metadata-only record in `data/.dead-letter.jsonl`; content never written). |
| `MEMORIA_BACKPRESSURE_THRESHOLD` | `0.8` | Fraction of buffer capacity at which source polling pauses so ingestion can drain the unsynced backlog instead of the buffer evicting unsynced (personal) events. |
| `MEMORIA_PUBLIC_URL` | *(none)* | Pins the OAuth issuer/endpoint metadata base URL. Without it, the base URL is derived from request headers (`Host`/`X-Forwarded-Host`), which reflects attacker-supplied hosts into the discovery document. **Set this in any network-exposed deployment.** |
| `MEMORIA_INSECURE_ALLOW_FALLBACKS` | `false` | **Escape hatch.** With `BIND_ALL=true` the server refuses to start unless `MEMORIA_OAUTH_CLIENT_SECRET`, `MEMORIA_ENCRYPTION_KEY` and `MEMORIA_PUBLIC_URL` are all set, rather than falling back to the API key, an on-disk key, or a base URL taken from request headers. Self-hosted setups that accept those risks can set this to `true`. |
| `MEMORIA_VECTOR_SCAN_CAP` | `5000` | Max chunks scanned per query for semantic candidate selection. |
| `MEMORIA_DIR` | Auto-detected | The root Memoria directory. Defaults to `/data/memoria` when `DOCKER=true` or a `/data` directory exists, otherwise `~/.memoria`. |
| `MEMORIA_REPO_URL` | `https://github.com/Agripp87/memoria_mcp` | Link shown in the dashboard's About card (forks: point it at your repo/docs). |
| `PORT` | `3100` | HTTP server port |
| `BIND_ALL` | `false` | Set to `true` to bind to `0.0.0.0` instead of `127.0.0.1` (required for Docker/Cloud Run) |
| `DOCKER` | `false` | Docker defaults: `MEMORIA_DIR` becomes `/data/memoria`, and auto-generating an on-disk encryption key logs a warning. The image sets it. |

## MCP Tools

### Core Memory Tools (13)

| Tool | Description |
|------|-------------|
| `memory_search` | Semantic + keyword hybrid search with three-signal scoring |
| `memory_read` | Read a specific memory file (returns empty if missing, not error) |
| `memory_write` | Create/update memory with dedup check (top-3 similar). Use `force: true` to skip. |
| `memory_list` | List all memories, filter by type or tag |
| `memory_index` | Rebuild vector + FTS5 search index and MEMORY_INDEX.md catalog |
| `memory_daily` | Append an entry (up to 50,000 characters) to today's daily log. Daily logs are UTC days, and entry times in them are UTC. |
| `memory_optimize` | Run `decay`, `promote`, `detect_stale`, or `find_duplicates` |
| `memory_reflect` | Read recent daily logs for agent reflection/synthesis |
| `memory_stats` | Health metrics: importance distribution, stale count, access patterns, warnings |
| `memory_lint` | Proactive health checks: contradiction scan, orphan detection, stale cross-refs, missing descriptions, gap analysis, **index drift** (rule VII), **entity-alias collisions** and **low-confidence claims** (rule VIII), **unknown directories** (files outside the documented layout — how the store once silently split into `reference/` + `references/`) |
| `memory_compile` | Compile analysis results into structured core memories with auto-generated frontmatter and index update |
| `memory_compact` | Read recent daily logs, deduplicate by source+content, surface high-importance events. Output is designed to be summarized into a reflection memory via `memory_compile`. |
| `memory_entities` | Compile the daily-log firehose into durable, linked per-source **entity pages** under `entities/` — the "compile, don't retrieve" loop (Karpathy rule IV). Deterministic (no LLM), idempotent, and never overwrites a page a human has taken over. Runs on demand, or autonomously via `MEMORIA_AUTO_COMPILE=true`. |

### Sub-Memory Collector Tools (4)

| Tool | Description |
|------|-------------|
| `memory_sources` | List, enable, disable, add custom, remove, or configure data sources. Includes user agreement flow. |
| `memory_ingest` | Manually trigger ingestion of buffered events into core memory |
| `memory_fuse` | Run cross-source temporal fusion to detect correlated activities |
| `memory_priority` | View collector status, adjust importance thresholds, flush buffer |

## Sub-Memory Collector

The collector is an autonomous sub-agent that gathers data from personal tools and feeds it into core memory through an encrypted pipeline.

### Built-in Sources

| Source | ID | Platform | Description |
|--------|----|----------|-------------|
| **iMessage** | `imessage` | macOS | Reads `~/Library/Messages/chat.db`. Requires Full Disk Access. |
| **Calendar** | `calendar` | macOS | Reads `~/Library/Calendars/Calendar Cache`. Configurable look-ahead/behind. |
| **Email (IMAP)** | `email` | All | Connects to any IMAP server (Gmail, Outlook, iCloud). Auto-installs `imapflow`. |
| **Gmail** | `google-gmail` | All | Google Gmail via API. Label filtering, importance markers, history-based incremental sync. |
| **Google Calendar** | `google-calendar` | All | Google Calendar via API. Multi-calendar, attendees, meeting links, syncToken incremental sync. |
| **Google Drive** | `google-drive` | All | Monitors selected Drive folders. Extracts text from Docs, Sheets, plain text files. |

### Google Account Setup

The three Google adapters share a single set of OAuth 2.0 credentials:

**1. Create Google Cloud credentials:**

```bash
# Go to https://console.cloud.google.com
# 1. Create a new project (or use existing)
# 2. Enable these APIs:
#    - Gmail API
#    - Google Calendar API
#    - Google Drive API
# 3. Go to Credentials > Create Credentials > OAuth client ID
#    - Application type: Desktop app
#    - Download the JSON file
```

**2. Get a refresh token:**

```bash
# Use the OAuth playground or run this one-time script:
# https://developers.google.com/oauthplayground/
#
# Select scopes:
#   - Gmail: https://www.googleapis.com/auth/gmail.readonly
#   - Calendar: https://www.googleapis.com/auth/calendar.readonly
#   - Drive: https://www.googleapis.com/auth/drive.readonly
#
# Exchange authorization code for tokens
# Copy the refresh_token
```

**3. Enable the adapters:**

```
# First grant consent in the Memoria dashboard (Sources tab) — consent
# cannot be granted through the MCP tool surface.
memory_sources action="enable" source="google-gmail" config={
  "google_client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "google_client_secret": "YOUR_CLIENT_SECRET",
  "google_refresh_token": "YOUR_REFRESH_TOKEN",
  "labels": ["INBOX"],
  "excludeLabels": ["SPAM", "TRASH", "PROMOTIONS"]
}
```

The same credentials work for all three Google adapters. Credentials are stored encrypted (AES-256-GCM).

**4. Google Drive folder selection:**

```
memory_sources action="enable" source="google-drive" config={
  "google_client_id": "...",
  "google_client_secret": "...",
  "google_refresh_token": "...",
  "folderIds": ["FOLDER_ID_1", "FOLDER_ID_2"],
  "includeContent": true
}
```

To find folder IDs, open the folder in Google Drive — the ID is in the URL after `/folders/`.

### Custom Sources

Users can add their own data sources in three modes:

| Mode | Use Case | Example |
|------|----------|---------|
| `file_watcher` | Monitor a file/directory for changes | Fitness app JSON exports, chat logs |
| `shell_command` | Periodically run a command and parse output | Custom scripts, API calls via curl |
| `webhook` | Receive HTTP POST with event data *(not yet implemented — push to the authenticated `/ingest` endpoint instead)* | Smart home systems, IFTTT triggers |

Custom sources support JSON, CSV, and plain text formats with configurable field mappings.

### Collector Pipeline

```
Source Adapters (poll on interval; PAUSED under backpressure)
        |
   Edge Filtering (importance threshold + privacy tier)
        |
   Encrypted Ring Buffer (SQLite, AES-256-GCM, max 10K events)
        |
   Ingestion Pipeline (per-source-fair batches)
   ├── Re-score importance (boost personal, penalize automated)
   ├── Rate limit (20 events/source/minute — over-budget events are
   │   DEFERRED and retried next cycle, never dropped)
   ├── Content-hash dedup (SHA-256; recorded only after a successful write)
   ├── Consolidation (search existing → ADD/UPDATE/SKIP)
   └── Write to daily logs
        |
   Per-event outcomes → only durably-handled events marked synced;
   errored events retry up to MEMORIA_INGEST_MAX_ATTEMPTS, then are
   dead-lettered (metadata-only) to data/.dead-letter.jsonl
        |
   Temporal Fusion (±30 min window)
   └── Cross-source activity detection → fused activity records
```

**No-silent-loss guarantees** (2026-07 hardening): the daemon marks **only
durably-handled** events as synced (written / duplicate / below-threshold);
rate-limited events stay buffered and retry when the budget refills; a write
failure does not consume the event's dedup slot (retries aren't mistaken for
duplicates); always-failing (poison) events stop retrying after
`MEMORIA_INGEST_MAX_ATTEMPTS` and leave a metadata-only dead-letter record;
ingestion batches are split fairly across sources so one backlogged source
can't starve the rest; and polling pauses at `MEMORIA_BACKPRESSURE_THRESHOLD`
of buffer capacity so the ring buffer never has to evict unsynced personal
events while ingestion catches up.

### Privacy Tiers

All events are classified into privacy tiers before leaving the device:

| Tier | Behavior | Example |
|------|----------|---------|
| `send` | Transmit content as-is | Calendar event titles |
| `summarize` | Truncate/redact before sending | Long email content |
| `local-only` | Never leaves the device | Messages containing passwords, credit cards, SSNs |

### Encryption

- **Master key**: AES-256-GCM. Sourced from `MEMORIA_ENCRYPTION_KEY` (recommended — pin from a secret manager), else auto-generated on first run at `data/collector.key`, created owner-only (0600 on Linux and macOS, with a warning when the filesystem ignores the mode; on Windows it inherits the data folder's permissions). Set `MEMORIA_REQUIRE_ENCRYPTION_KEY=true` to require the env var and refuse the on-disk fallback.
- **Ring buffer**: All event content encrypted before SQLite storage
- **Config**: Source configurations (including IMAP credentials) encrypted at `data/collector-config.enc`
- **Access**: Only the Memoria agent and the user have access to decrypted data

### Enabling a Source

```
1. memory_sources action="list"                    # See available sources
2. In the Memoria dashboard (Sources tab), grant consent for "imessage"
   # Consent is dashboard-only by design: an MCP caller cannot grant it.
3. memory_sources action="enable" source="imessage" # Enable + auto-install deps
4. memory_priority action="status"                 # Verify it's collecting
```

### Adding a Custom Source

```
memory_sources action="add_custom" custom_definition={
  "id": "fitbit-sleep",
  "name": "Fitbit Sleep Data",
  "description": "Daily sleep quality from Fitbit JSON export",
  "mode": "file_watcher",
  "watchPath": "/path/to/fitbit-export.json",
  "fileFormat": "json",
  "jsonPath": "sleep.data",
  "fieldMap": {
    "content": "summary",
    "timestamp": "dateOfSleep",
    "id": "logId"
  }
}
```

## HTTP Ingestion (external agents & systems)

Any external system can push events to Memoria's authenticated `/ingest` endpoint — agent frameworks, cron jobs, webhooks, other assistants. Events flow through the same pipeline as collector sources (re-score, rate-limit, dedup, consolidate, write to the daily log, index).

```bash
curl -X POST https://<your-host>/ingest \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [{
      "id": "unique-id",
      "source": "my-agent",
      "content": "Agent completed task X",
      "timestamp": "2026-04-03T15:30:00Z",
      "importance": 6,
      "meta": {"agent_id": "research-agent"}
    }]
  }'
```

Response: `{ "accepted": 1, "buffered": 1, "written": 1, "deduplicated": 0, "rateLimited": 0, "failed": 0, "bufferDropped": 0, "bufferUsage": { … } }`


**Python hook.** [`integrations/orchestrator_hook.py`](integrations/orchestrator_hook.py) is a dependency-light (`httpx` or `requests`) client that buffers events and flushes them every 30 s in the background — originally written for a multi-agent orchestrator, but generic: `record_agent_result`, `record_metric`, `record_conversation`, `record_training_eval`, plus raw `record(...)`. All calls are best-effort; a Memoria outage never breaks the caller.

```python
from integrations.orchestrator_hook import MemoriaHook
hook = MemoriaHook(memoria_url="https://<your-host>/ingest", api_key=os.environ["MEMORIA_API_KEY"])
hook.record_agent_result("research-agent", task, result, metrics)
hook.flush()  # on shutdown
```

**Close the loop.** Ingestion makes Memoria write-heavy; to make it useful, have your agents call `memory_search` (or `GET /dashboard/api/search` with the bearer key) before a run and prepend the top results to their context. That is what turned the maintainer's setup from write-only into a memory that compounds.

## Dashboard (Web UI)

Memoria includes a built-in web dashboard for managing memory, data sources, and journaling — no CLI required.

**Access**: `http://127.0.0.1:3100/dashboard` (or your public URL)

On first visit, the dashboard asks for your `MEMORIA_API_KEY` once and exchanges it for an httpOnly session cookie; the key itself is not stored in the browser.

### Demo mode (fake data)

Showcase the dashboard — including the **Wiki** — with realistic made-up data, without touching your real memories.

**Hosted demo:** [`https://memoria-demo-hpb4luig7q-uc.a.run.app/dashboard`](https://memoria-demo-hpb4luig7q-uc.a.run.app/dashboard) (key: `memoria-demo`). The demo runs as a **separate Cloud Run service** under a **zero-privilege service account** (no Secret Manager, no real bucket) on ephemeral data regenerated on every cold start — a demo compromise can't reach the real service's secrets or memories. Deployed via [`deploy/gcp/deploy-demo.sh`](deploy/gcp/deploy-demo.sh).

**Locally:**

```bash
cd mcp-server
npm run demo
# → generates a throwaway ./demo-store and launches the dashboard
# → open http://127.0.0.1:3110/dashboard   (key: demo-key-123)
```

`npm run demo` builds (if needed), writes ~29 cross-linked fake memories (an "Alex Rivera" indie-dev persona: profile, projects, decisions, reflections, and 16 collector-style daily logs), and serves them on a local-only port. The demo store is git-ignored and your real `MEMORIA_DIR` is never touched. Use `npm run demo:gen -- --out <dir>` to just generate the data. Override the port/key with `PORT=…` / `MEMORIA_API_KEY=…`.

> **Security note:** the dashboard authenticates via an httpOnly, SameSite=Strict session cookie minted at `POST /dashboard/login` (Phase 3, 2026-07) — the API key is no longer stored in `localStorage`, so origin XSS cannot exfiltrate it. All memory/source-derived fields remain HTML-escaped against stored XSS; still treat the dashboard as a trusted-network tool.

### Sections

| Tab | What it does |
|-----|-------------|
| **Overview** | Memory stats (file count, chunks, avg importance, stale), collector status, recent journal entries |
| **Data Sources** | List all sources with status badges. Enable/disable with one click. Configure credentials via modal forms. Add custom sources (file watcher, shell command). |
| **Journal** | Write daily journal entries with optional mood tracking and tags. Entries are saved to the daily log and indexed for search. View recent entries. |
| **Memories** | Browse all memory files sorted by importance. Full-text search across all memories. |
| **Wiki** | Browse the whole memory store as a cross-linked wiki: rendered markdown, an index by category + a daily-log calendar, `related` links + `[[wiki links]]` + computed backlinks, and **append-only** "add note" annotations on any memory (provenance preserved). |
| **Settings** | Rebuild search index, view buffer stats, links. |

### Journal

The journal provides a way to manually add context that automated collectors can't capture — thoughts, decisions, reflections, plans. Entries support:

- **Mood tracking**: Select from 5 mood states per entry
- **Tags**: Comma-separated tags for categorization
- **Full indexing**: Journal entries are immediately indexed for semantic search

Journal entries are stored in `memories/daily/YYYY-MM-DD.md` alongside auto-collected events, creating a unified timeline.

## Memory File Format

Every memory file uses Markdown with YAML frontmatter:

```markdown
---
name: Nightjar project status
description: Overview of the offline-first notes app
type: project
importance: 8
created: 2026-03-27
updated: 2026-03-27
tags: [app, react-native]
related: [user/profile.md]
valid_from: 2026-03-27
valid_until:
---

Content in plain markdown...
```

### Types

`user` | `project` | `decision` | `feedback` | `reference` | `session` | `reflection` | `pattern` | `source-rollup` (auto-compiled per-source pages under `entities/`; renamed from `entity` in Phase 5 — they are activity rollups keyed by collector source, not extracted entities)

### Importance Scale

| Score | Meaning | Example |
|-------|---------|---------|
| 1-2 | Mundane | "ran npm install" |
| 3-4 | Routine | "built feature Y" |
| 5-6 | Notable | "chose Zustand over Redux" |
| 7-8 | Important | "user prefers terse responses" |
| 9-10 | Critical | "app must be offline-first" |

## Directory Structure

**Code repo** (this repository):

```
memoria_mcp/
├── README.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md                # Trust model + disclosure
├── LICENSE                    # Apache-2.0
├── Dockerfile                 # Multi-stage build (Node 26, Debian slim, non-root)
├── docker-compose.yml         # Local/VPS deployment with a persistent volume
├── .env.example
├── .claude-plugin/            # Claude Code plugin + marketplace manifests
├── hooks/                     # Plugin hooks (SessionStart/Stop sync)
├── .github/workflows/
│   ├── ci.yml                 # Builds + tests (ubuntu & windows), coverage gate, lint, shellcheck,
│   │                          # gitleaks, and checks on the built Docker image
│   └── release.yml            # Tag → checks → staged npm release with provenance
├── deploy/gcp/                # Reference Cloud Run deployment (template, CI/CD example, demo)
├── integrations/
│   └── orchestrator_hook.py   # Python /ingest client (buffered, best-effort)
├── pypi/                      # The reserved memoria-mcp PyPI package
├── scripts/
│   ├── sync/                  # Git sync hooks for a multi-device store
│   └── sync-from-claude-memory.sh  # One-way pull from Claude Code's built-in memory
├── store-template/            # .gitattributes + .gitignore for a memory-store repo
└── mcp-server/
    ├── package.json
    ├── tsconfig.json
    ├── vitest.config.ts       # Coverage floors enforced in CI
    ├── eval/                  # Retrieval evaluation harness and gold set
    ├── scripts/               # plugin + mcp start wrappers, demo, model prefetch, vector-space guard
    └── src/
        ├── index.ts           # Stdio transport entry point
        ├── http.ts            # HTTP/SSE transport entry point
        ├── oauth-helpers.ts   # Redirect allowlist + constant-time credential checks
        ├── dashboard.ts       # Web UI + REST API router
        ├── wiki.ts            # Markdown rendering + [[wikilinks]] for the dashboard wiki
        ├── tools.ts           # Shared tool registration (17 tools)
        ├── store.ts           # SQLite + FTS5 storage, vector search
        ├── embeddings.ts      # OpenAI / local MiniLM / n-gram provider
        ├── chunker.ts         # Markdown -> overlapping chunks
        ├── atomic-fs.ts       # Atomic writes + exclusive create-or-append
        ├── daily-format.ts    # Daily-log headers and UTC time labels
        ├── optimize.ts        # Decay, promotion, staleness, dedup
        ├── entities.ts        # Entity-page compilation (compile-don't-retrieve loop)
        ├── lint.ts            # Contradictions, orphans, gaps, stale refs, index drift, alias/low-confidence
        ├── __tests__/         # Vitest test suite (incl. HTTP integration)
        └── collector/
            ├── crypto.ts      # AES-256-GCM encryption + master key
            ├── provenance.ts  # Durable append-only raw/provenance archive (data/raw/)
            ├── registry.ts    # Source registry (enable/disable/agree/custom)
            ├── deps.ts        # On-demand adapter dependencies (data/adapter-modules)
            ├── buffer.ts      # Encrypted ring buffer (SQLite)
            ├── daemon.ts      # Poll loop orchestrator with backoff
            ├── ingestion.ts   # 5-stage core ingestion pipeline
            ├── fusion.ts      # Cross-source temporal pattern detection
            └── adapters/
                ├── base.ts            # SourceAdapter interface + helpers
                ├── imessage.ts        # macOS iMessage/SMS adapter
                ├── calendar.ts        # macOS Calendar adapter
                ├── email.ts           # IMAP email adapter (cross-platform)
                ├── google-auth.ts     # Shared Google OAuth 2.0 helper
                ├── google-gmail.ts    # Gmail API adapter
                ├── google-calendar.ts # Google Calendar API adapter
                ├── google-drive.ts    # Google Drive folder watcher
                └── custom.ts          # User-defined source adapter
```

**Memory store** (`MEMORIA_DIR`, default `~/.memoria` — keep it *outside* the code repo, ideally as its own private git repo):

```
$MEMORIA_DIR/
├── memories/
│   ├── MEMORY_INDEX.md        # Master index (auto-refreshed; preserves a curated appendix below the MEMORIA:MANUAL sentinel)
│   ├── daily/                 # Append-only daily session logs
│   ├── entities/              # Auto-compiled per-source rollup pages (memory_entities)
│   ├── user/                  # User identity, preferences
│   ├── project/               # Project overviews, status
│   ├── decisions/             # Architectural/product decisions
│   ├── feedback/              # How Claude should behave
│   ├── references/            # Pointers to external resources
│   └── sessions/              # Session summaries and reviews
└── data/                      # Derived + runtime state (git-ignore this)
    ├── memoria.sqlite         # FTS5 + vector index (rebuildable)
    ├── event-buffer.sqlite    # Encrypted collector ring buffer
    ├── tokens.sqlite          # OAuth tokens, stored as SHA-256 hashes
    ├── collector-config.enc   # Encrypted source credentials
    ├── collector.key          # AES-256 master key (if not supplied via env)
    ├── adapter-modules/       # npm packages installed when a source is enabled
    └── raw/<source>/*.jsonl   # Append-only provenance archive
```

## Three-Tier Memory Architecture

| Tier | Content | Lifespan | Location |
|------|---------|----------|----------|
| **Working** | Current session context | Single session | In-context (not persisted) |
| **Core** | Essential facts, preferences, decisions | Long-term, curated | `memories/user/`, `project/`, `decisions/`, `feedback/` |
| **Archival** | Daily logs, session summaries | Retained, lower priority | `memories/daily/`, `sessions/` |

## Agentic Behaviors

Memoria is designed for self-managing memory, inspired by research from Generative Agents, Mem0, MemGPT/Letta, and Zep.

> **How "autonomous" works in practice:** most behaviors below are *agent-driven*, not background loops — they are MCP tools (`memory_optimize`, `memory_reflect`, `memory_lint`, `memory_compact`, write-time dedup) that the Claude agent invokes following the cadence in `CLAUDE.md` (e.g. reflect every ~20 entries, self-assess every 5th session). Truly background processes are the collector daemon (polling sources), the periodic reindex sweep (which now also keeps `MEMORY_INDEX.md` fresh), and — when enabled — a daily decay/promote/staleness pass (`MEMORIA_AUTO_OPTIMIZE=true`) and a daily entity-page compile pass (`MEMORIA_AUTO_COMPILE=true`, draining the ingest→compile queue). With both off (the default), they run only when `memory_optimize` / `memory_entities` are called.

- **Consolidation**: Before every write, search for existing memories on the same topic. Decide: ADD, UPDATE, DELETE, or NOOP.
- **Reflection**: After ~20 daily log entries or 3+ days on the same topic, synthesize higher-level insights as `reflection` type memories.
- **Self-Assessment**: Every 5th session, review the store for duplicates, stale memories, patterns worth promoting, and gaps.
- **Promotion/Demotion**: Memories accessed 10+ times get boosted. Memories not accessed in 60+ days get decayed. Both are idempotent *within a day* (a last-run-date guard prevents double-application), but decay still accumulates across distinct run-days — i.e. importance keeps drifting down the longer a memory stays untouched, by design.
- **Write-time dedup**: The `memory_write` tool checks for similar existing memories before writing, preventing duplicates at the source.
- **Temporal fusion**: The collector correlates events across data sources within time windows to detect higher-level activities.

## Search Algorithm

```
retrieval_score = 0.8 * relevance + 0.1 * recency + 0.1 * importance
```

Where:
- **recency** = exponential decay, 30-day half-life from whichever is newer of `updated_at` and `last_accessed` — i.e. time since the memory was last *touched* (edited **or** read). A heavily-consulted old memory no longer ranks as permanently stale. `updated_at` comes from the memory itself: frontmatter `updated` (else `created`, else the file's mtime) when it is first indexed, and the file's mtime when an indexed file is edited — never the time it was indexed, so a rebuild does not make everything look new.
- **Why 0.8 / 0.1 / 0.1:** relevance scores fall in a narrow band while the priors span 0–1, so the previous 0.2 / 0.3 / 0.5 let recency and importance decide most rankings; the [retrieval eval](mcp-server/eval/README.md) measured it far below relevance alone.
- **importance** = normalized 1-10 score from frontmatter. Importance is a ranking *prior only* — it is deliberately **not** used to pre-filter candidates (that triple-counted it via filter + weight + access-boost feedback and made the low-importance long tail unreachable).
- **relevance** = 0.7 * vector_cosine_similarity + 0.3 * keyword_score, where keyword_score is a **fixed saturating transform of the FTS5 BM25 rank** (`-rank / (-rank + 10)`) — an absolute magnitude, comparable across queries (not a per-query rank position). Candidates that FTS didn't match get a capped substring-match fallback so scoring is uniform across the candidate pool.

**Semantic-scan coverage is never silent:** every result carries `scannedChunks/totalChunks`. Under `MEMORIA_VECTOR_SCAN_CAP` (default 5000) the whole store is scanned; past it, an even sample of **exactly cap** rows spans the entire id range — coverage degrades continuously as the store grows (no recall cliff at cap+1), and the sample's offset is derived from the query text, so different queries reach different residues of the store and no row is permanently invisible to the vector path (the same query stays deterministic). `memory_search` appends a coverage note whenever the scan was partial.

Results are position-optimized: high-importance memories placed at the start and end of output to leverage the primacy/recency effect in LLM attention.
> **Provider caveat:** with the `hash` n-gram provider, `vector_cosine_similarity` is only a lexical approximation — the vector and FTS terms largely measure the same thing, so treat a `hash` deployment as keyword search with extra steps, not semantic search. Use `minilm` (local, the default) or `openai` for true semantic retrieval; the Docker image pre-bakes the MiniLM model.

## Multi-device sync

Memoria deliberately has **no sync service**. The store is a directory of Markdown files, so git already solves this — [`scripts/sync/`](scripts/sync/README.md) just makes the setup correct rather than merely possible.

```bash
cd ~/.memoria                                   # your MEMORIA_DIR
git init -b main
cp /path/to/memoria_mcp/store-template/.gitattributes .   # <- the important bit
cp /path/to/memoria_mcp/store-template/.gitignore .
git add -A && git commit -m "Initial memory store"
gh repo create my-memoria-store --private --source=. --push
```

Then wire [`memoria-sync-pull.sh`](scripts/sync/memoria-sync-pull.sh) into a Claude Code `SessionStart` hook and [`memoria-sync-push.sh`](scripts/sync/memoria-sync-push.sh) into `Stop` — the plugin does this for you. Both fail soft: offline, no remote, or no git repo at all, they log a line and let the session proceed. The push is rate-limited (default 15 min) so the Stop hook does not hit the network on every turn; local commits are never rate-limited.

**Same-day conflicts solve themselves.** Two machines appending to the same daily log is the normal case, and for an append-only file the resolution is mechanical — keep both sides' lines. That is exactly git's built-in `union` merge driver, enabled by one line in the store template's `.gitattributes`:

```gitattributes
memories/daily/*.md merge=union
```

With that in place, same-day entries from two devices merge silently and none are lost. Core memories (`user/`, `project/`, `decisions/`, …) deliberately keep the normal three-way merge: those files are edited rather than appended, so a both-sides change is a real disagreement that deserves a human. (Union merge keeps every entry but does not reorder them chronologically — see the [sync guide](scripts/sync/README.md#why-daily-logs-never-conflict).)

**Object storage is optional.** If you also run a hosted instance backed by a bucket, drop an executable at `$MEMORIA_DIR/.memoria-mirror.sh` and both scripts will call it with `pull` / `push` around the git sync.

**From Claude Code's built-in memory.** [`scripts/sync-from-claude-memory.sh`](scripts/sync-from-claude-memory.sh) one-way-pulls a project's `~/.claude/projects/<project>/memory/*.md` into the store (`MEMORIA_DIR`, default `~/.memoria`) so existing auto-memory is not lost. Pass the memory directory as an argument when more than one project has one.

## Security

See [SECURITY.md](SECURITY.md) for the trust model (single-tenant, one static key perimeter, auto-approving `/authorize`) and how to report a vulnerability. The HTTP transport includes multiple security layers:

| Feature | Detail |
|---------|--------|
| **Authentication** | OAuth 2.1 (authorization_code + PKCE, client_credentials) and static Bearer token. 24h token TTL. |
| **Persistent tokens** | OAuth tokens and codes stored in SQLite as SHA-256 hashes, so a copied database holds no usable credential. They survive restarts when the database is on persistent disk; the Docker image keeps it on container-local `/tmp` (see `MEMORIA_TOKEN_DB_DIR`), so a restart there means one re-auth |
| **Encryption at rest** | AES-256-GCM for all collector data, configs, and the ring buffer |
| **Rate limiting** | Per client IP: `/mcp` 30/min, `/token`+`/authorize`+`/register` 20/min, `/ingest`+`/dashboard/api` 120/min (trusts one proxy hop for the real client IP) |
| **Body size limit** | 5 MB max request body (sized for batched `/ingest` payloads) |
| **Session management** | Max 10 concurrent sessions, 30-minute idle TTL |
| **Localhost binding** | HTTP server binds to `127.0.0.1` by default; set `BIND_ALL=true` for Docker/cloud. NOTE: every shipped Docker/Cloud Run config sets `BIND_ALL=true`, so in production the network is open and Bearer auth is the only access control. |
| **Non-root container** | Docker image runs as unprivileged `memoria` user (UID 1001), which owns only its data and the model cache; the application code is root-owned |
| **Dashboard hardening** | A per-response nonce Content-Security-Policy runs only the page's own script: no inline handlers, no framing. All store-derived values are escaped, quotes included |
| **Object-storage FUSE compatible** | All file permission calls gracefully degrade on cloud storage mounts |
| **Platform validation** | Source adapters are checked for OS compatibility before enabling |
| **Path traversal** | Trailing-separator check + symlink resolution blocks escape from `memories/` |
| **Timing-safe auth** | `crypto.timingSafeEqual` on byte-length-checked buffers for every key and secret comparison |
| **Filename validation** | Rejects filenames with special characters; 100 KB content limit |
| **Error sanitization** | Internal errors logged to stderr, not returned in tool output |
| **Privacy filtering** | Passwords, credit cards, SSNs, API keys auto-classified as `local-only` |
| **User consent** | Sources require explicit agreement before enabling |

### OAuth Endpoints

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/oauth-protected-resource` | RFC 9728 resource metadata |
| `/.well-known/oauth-authorization-server` | RFC 8414 auth server metadata |
| `/authorize` | Authorization endpoint (auto-approves, redirects with code) |
| `/token` | Token exchange (authorization_code with PKCE, client_credentials) |
| `/register` | RFC 7591 dynamic client registration |

### HTTP API

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/mcp` | POST/GET/DELETE | Bearer | MCP protocol (tools, SSE, sessions) |
| `/` | GET | None | Redirects to `/dashboard` |
| `/dashboard` | GET | None | Web UI (asks for the API key once) |
| `/dashboard/login` | POST | API key in body | Exchanges the key for an httpOnly session cookie |
| `/dashboard/api/*` | GET/POST/DELETE | Bearer or session cookie | REST API for the dashboard |
| `/ingest` | POST | Bearer | External sub-memory collectors push events |
| `/health` | GET | None | Health check |

## Testing

```bash
cd mcp-server
npm test            # Run the whole suite (CI runs it on ubuntu AND windows)
npm run test:coverage  # Run with coverage (CI gate; per-file floors fail on regression)
npm run test:watch  # Watch mode for development
```

Tests cover:
- **Chunker**: Frontmatter parsing (YAML types, BOM, CRLF), markdown chunking with overlap
- **Embeddings**: Local n-gram vectors, cosine similarity, batch processing, Unicode text
- **Store**: Indexing, search (including empty queries/stores), content hashing, access tracking, importance decay/boost idempotency, stats aggregation
- **Optimizer**: Decay, promotion, stale detection, duplicate finding
- **Path resolution**: Filename validation, traversal rejection, special character rejection
- **HTTP integration** (supertest over the real Express `app`): `/health`, the `/` → `/dashboard` redirect, the `/dashboard/api` Bearer auth-gate (401 without/with a wrong key, 200 with the right key), the wiki endpoints (index, render-to-sanitized-HTML, traversal → 400, missing → 404), append-only annotate (+ `MEMORY_INDEX.md` refusal), and the full OAuth flow: `client_credentials`, the `authorization_code`+PKCE exchange end-to-end (issued token actually authorizes the API), PKCE-verifier-mismatch → 400, and a decoupling check that the **API key is rejected as the OAuth client secret**
- **Wiki rendering**: code-safe `[[wikilink]]` resolution (never fires inside code spans/fences or markdown link labels), stored-XSS escaping, `javascript:` URL blocking
- **Dashboard**: the generated browser script parses; the page's own escaper escapes quotes; the CSP nonce matches the script and changes per response; no inline handlers remain; every `data-action` has a handler; journal input validation
- **Files and keys**: atomic writes survive failure and leave no temp files; two writers creating one daily log keep both entries; the importance bump works byte-exactly; the encryption key file is created once, owner-only, and a corrupt one is refused
- **Search**: non-ASCII words (Müller, café/cafe, CJK) and FTS5 operator words against a real FTS5 table
- **Collector dependencies**: resolution only from the data directory's `adapter-modules`, and the npm invocation (no shell, no command lookup)
- **Launch and shutdown**: the built server starts when run through a symlink (as `npm install -g` installs it) and exits 0 on SIGTERM
- **CI on the Docker image**: runtime user and permissions, no dev dependencies, the embedding model loading offline, and an on-demand adapter install

All tests use the local n-gram embedding provider (no API keys or network required).

## Robustness & Audit Trail

Memoria has been through a critical code review with all findings tracked and fixed. Key hardening:

> **2026-06 multi-agent security review**: a 13-dimension adversarially-verified review produced 79 confirmed findings; all 10 high + 17 medium + 30/31 low were fixed (test suite 57 → 115). Highlights: closed a symlink-leaf arbitrary-read in `resolveMemoryPath`; contained `file_watcher` custom sources so they can't read the collector key/credentials; added **sink-side privacy enforcement** (re-classify + redact `local-only`/truncate `summarize` before any synced/embedded write) with value-pattern secret detection (Luhn, SSN, `sk-`/`AKIA`/JWT/PEM); pinned `MEMORIA_ENCRYPTION_KEY` from Secret Manager with a fail-closed mode; mounted the GCS-FUSE volume + `max-instances 1`; rate-limited `/token`/`/authorize`/`/register`/`/ingest`/`/dashboard/api`; unified the dashboard onto the single collector and escaped all dashboard `innerHTML` sinks; and added an opt-in autonomous decay/promote/staleness scheduler (`MEMORIA_AUTO_OPTIMIZE`).

> **2026-06 ops/security hardening + Wiki**: shipped the dashboard **Wiki** (cross-linked rendered markdown, category/calendar index, `related` + `[[wikilink]]` + computed backlinks, append-only annotations) and a hosted **demo** under a zero-privilege service account. A follow-up critical re-review then drove: an **API-key rotation** after a key was exposed, and **decoupling** the OAuth client secret from the API key (distinct `MEMORIA_OAUTH_CLIENT_SECRET`, asserted by tests) so rotating one no longer rotates the other; GCS object **versioning** on the persistent bucket; the **HTTP integration suite** that finally covers the previously-untested internet-facing surface (the `/dashboard/api` auth gate and the OAuth `authorization_code`+PKCE flow end-to-end); a **CI coverage gate** (`npm run test:coverage`, per-file floors) and a stronger **deploy smoke gate** (redirect + dashboard markup + auth-gate 401, not just `/health`); and a code-safe `[[wikilink]]` renderer (a markdown-it inline rule that never fires inside code spans/fences or markdown link labels, replacing a pre-pass regex that corrupted code). Test suite 115 → 153. See [Known Limitations](#known-limitations) for what remains open.

> **2026-09 full review (released in 0.2.1)**: a full review of the published 0.2.0 found 17 issues, among them a silent exit when the HTTP server was installed with `npm install -g`, an attribute injection in the dashboard wiki, non-atomic writes, keyword search that ignored non-ASCII words, and collector dependencies that could not install. All were fixed, and five independent re-reviews of the fixes found 15 more, all fixed. The worst of those: the Docker image, then built on Alpine, could never load its default embedding model. See the [0.2.1 entry in the CHANGELOG](CHANGELOG.md) for the full list. Test suite 301 → 370.

| Area | What was fixed |
|------|---------------|
| **YAML parsing** | Replaced naive `split(":")` parser with `js-yaml`. Now handles quoted strings with colons, multi-line values, special chars in tags, and gracefully recovers from malformed YAML. |
| **Filename collisions** | `memory_compile` auto-appends `-2`, `-3`, etc. when a slug is taken — was silently overwriting before. |
| **Embedding API cost** | `memory_lint` contradiction scan capped at top 30 memories by importance, batched 5-in-parallel. Reports coverage in output. |
| **Silent failures** | All empty `catch {}` blocks in Google adapters now log to stderr. Auth/network errors no longer disappear. |
| **Ingestion atomicity** | Fusion writes wrapped in try/catch (failure won't poison ingestion). Ingestion errors re-thrown so daemon doesn't mark events synced when the pipeline failed. |
| **Cloud security** | The key file and token database are created owner-only (0600); when the filesystem ignores the mode (common on GCS FUSE) a security warning says to rely on bucket ACLs. |
| **Search correctness** | Importance score clamped to `[0, 1]` to prevent weight inflation. Empty/symbol-only queries fall back to recency+importance ranking instead of slow full scan. |
| **Markdown safety** | `MEMORY_INDEX.md` escapes special characters (`]`, `[`, `\`) in link text and encodes spaces/parens in URLs. |
| **Capacity feedback** | `/ingest` reports `bufferDropped` count when events are dropped at capacity, plus a `nearCapacity` flag at 90% utilization. |
| **YAML date normalization** | js-yaml auto-parses ISO dates into `Date` objects; we normalize them back to strings so frontmatter round-trips cleanly. |
| **Concurrent compile safety** | Per-directory locks serialize `memory_compile` calls — no slug collision races even under concurrent requests. |
| **Strict input validation** | `/ingest` rejects empty/whitespace-only id, source, or content. `memory_compile` enforces a 100KB body limit. |
| **Markdown safety in links** | Index escapes backticks, asterisks, underscores, tildes (in addition to brackets/backslash) so memory names with markdown syntax don't break links. |
| **Live access counts** | Lint orphan detection queries the SQLite `file_meta` table instead of stale frontmatter. |
| **Smart positional ordering** | Search results only reorder for primacy/recency effect when scores are tightly clustered (< 0.15 spread); pure score-ranking otherwise. Reordering is announced in the output. |
| **Singleton init lock** | Concurrent `ensureCollector()` calls share a single init promise — no duplicate registries, buffers, or daemons. |
| **Corrupt checkpoint recovery** | Google adapters reset corrupted JSON checkpoints to start fresh instead of looping on the same parse error. |
| **Deterministic lint output** | Contradiction pairs sorted by similarity then alphabetically — stable across runs and parallel batches. |
| **Smart fusion** | Cross-source fusion skips clusters where every event shares the same `meta.agent_id` — those are the same execution recorded twice (result + metric), not independent observations. Eliminates ~90% of useless "Activity at X" entries. |
| **Per-source recent dedup** | Ingestion pipeline drops scheduled-job spam: identical content from the same source within a 26-hour window is deduplicated, and the window survives restarts. Prevents 24 identical "marketing-agent: success" entries per day. |
| **Importance bump** | When a high-importance event lands in a daily log, the file's frontmatter `importance` is bumped to `max(current, event)` so the chunk is properly weighted in search instead of being flattened to 5. |
| **Source-aware stats** | `memory_stats` now shows event count by source over the last 7 days and warns when (a) sources flood >50 events/week, (b) all chunks have flat importance, (c) memory is being written but never queried. |
| **Karpathy compounding** | `memory_compact` reads recent daily logs, deduplicates by source+content fingerprint, and surfaces high-importance events. The agent then synthesizes a reflection via `memory_compile`. Compresses the firehose into compounding knowledge. |

## Known Limitations

Honest accounting of what is *not* hardened or covered yet — tracked for follow-up:

- **Single static key, public ingress.** The reference hosted deployment is `--allow-unauthenticated` with `BIND_ALL=true`, so the network is open and a single static Bearer token (`MEMORIA_API_KEY`) is the only access control on `/mcp`, `/ingest`, and `/dashboard/api`. There is no per-user/per-agent scoping, no IP allowlist, and no key-expiry/rotation automation — rotating the key is a manual Secret Manager + redeploy step. Treat the key as a high-value secret (it leaked once during development and had to be rotated). The OAuth path is now decoupled (`MEMORIA_OAUTH_CLIENT_SECRET`), but OAuth tokens are not shared across instances (moot at `max-instances 1`).
- **Coverage is partial (about 60% of lines).** The HTTP surface, storage, search and ingestion are well covered, but the **MCP tool handlers in `tools.ts` (about 58%)** and the **dashboard's browser-side JavaScript** have gaps: the browser script is tested for escaping, CSP and wiring, not by DOM tests. The collector adapters (Google/iMessage/email, about 14%) are tested at their edges, not against live services. Per-file coverage floors prevent regressions but don't fill these gaps.
- **No staging environment.** The example deploy workflow goes straight from `main` to production Cloud Run after CI, then smoke-tests the live revision (redirect, dashboard markup, auth-gate 401) and rolls traffic back if it fails. There is no canary or staging, so a bad deploy is caught and reverted, not prevented.
- **Collector corners.** Packages installed for a source resolve their own dependencies the usual way, including from a `node_modules` in the data or Memoria directory; the server warns at startup when one exists. Journal entries that carry a mood, and free-text `memory_daily` entries, are not split out as separate entries by the entity compiler or `memory_compact`.
- **Single-writer scaling ceiling.** `max-instances 1` is mandatory because the derived SQLite/FTS5 index lives on the GCS-FUSE volume and concurrent writers across instances corrupt the WAL ("disk I/O error", observed in prod). Horizontal scale requires moving the index off FUSE to a real single-writer or networked store.
- **~~Hosted search is lexical, not semantic~~ — fixed in Phase 2 (2026-07):** the reference deployment now runs `MEMORIA_EMBEDDINGS=minilm` at 2Gi (true semantic embeddings). Residual caveat: the first startup after the provider switch re-embeds the whole store (one slow cold start), and `hash`-provider deployments remain lexical-only by nature.
- **~~Dashboard key in `localStorage`~~ — fixed in Phase 3 (2026-07):** the dashboard now exchanges the API key once at `POST /dashboard/login` for an **httpOnly, SameSite=Strict session cookie** scoped to `Path=/dashboard` (never sent to `/mcp`//`/ingest`, unreadable from JS). A legacy key found in localStorage is migrated to a cookie session and removed. Bearer auth is unchanged for API clients.
- **Wiki edge cases.** `[[wikilinks]]` resolve by name/path/basename; ambiguous names resolve to the first match. A `[[link]]` inside a markdown link label renders as literal text (markdown-it can't nest anchors) rather than a navigable link — by design, to avoid producing invalid HTML.

These are the known open items after the September 2026 review; [issues](https://github.com/Agripp87/memoria_mcp/issues) are welcome for anything missing here.

## Design Decisions

- **File-based over database-first**: Markdown files are human-readable, git-friendly, and survive tool changes. SQLite is a derived index.
- **Hybrid search over keyword-only**: Vector embeddings capture semantic meaning; FTS5 BM25 captures exact terms. Combined they outperform either alone.
- **Encrypted ring buffer**: Events are encrypted before touching SQLite, so even if the database file is accessed, content remains protected.
- **User agreement before collection**: No source can be enabled without explicit consent. This is enforced at the registry level, not just the UI.
- **Auto-install dependencies**: Reduces friction for enabling sources. The user agrees, and the system handles npm installs automatically.
- **Per-source isolation**: One failing adapter doesn't affect others. Exponential backoff prevents runaway polling.
- **Idempotent operations**: Decay and boost track their last run date, preventing double-application.
- **Content hashing**: SHA-256 hash stored per file means reindex only re-embeds changed files, saving API calls and time.
- **No graph database**: Flat files with vector search and a `related` field provide 90% of graph benefits at 10% of the complexity.
- **Compiled knowledge** (inspired by [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)): Good query results are filed back as core memories via `memory_compile`, so investigations compound rather than disappearing into chat history. The `memory_lint` tool proactively catches contradictions, orphans, and knowledge gaps — maintaining the memory store like a wiki, not a write-only log.
- **Dual transport**: stdio for Claude Code (zero latency), Streamable HTTP/SSE with OAuth 2.1 for claude.ai and other remote clients.

## Roadmap

Near-term, roughly in order:

- [x] Publish to npm as `@agrippa87/memoria-mcp` (`npx -y @agrippa87/memoria-mcp`); `memoria-mcp` reserved on PyPI
- [x] Staged npm releases from GitHub Actions with signed provenance (first: 0.2.1)
- [ ] `server.json` + listing in the official MCP Registry; Docker MCP Catalog
- [ ] Raise tool-handler and dashboard-JS coverage
- [ ] Per-client API keys / scoped tokens (replace the single-key perimeter)
- [ ] Move the derived index off FUSE so hosted instances can scale past one writer

## Contributing

Issues and PRs are welcome. This is a solo-maintained project run in spare time, so expect asynchronous review. Please:

- open an issue before a large change so we can agree on direction;
- keep the test suite green (`npm test`) and add tests for behavior changes — coverage floors are enforced in CI;
- sign off your commits (`git commit -s`) — contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/);
- never include real memory files, keys or personal data in issues, PRs or fixtures (use `npm run demo:gen` to produce realistic fake data).

Security issues: see [SECURITY.md](SECURITY.md) — please do not open public issues for vulnerabilities.

## License

[Apache-2.0](LICENSE). Copyright the Memoria contributors.
