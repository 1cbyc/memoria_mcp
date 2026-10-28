# Security

This document is deliberately blunt. Memoria stores personal data, and the
collector can pull in messages, mail and calendars. You should understand the
trust model before you expose an instance to a network or enable a source.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use
[GitHub private vulnerability reporting](https://github.com/Agripp87/memoria_mcp/security/advisories/new)
on this repository. You will get an acknowledgement within a few days (solo
maintainer, spare time); fixes for confirmed issues are prioritized over
everything else and credited in the release notes unless you prefer otherwise.

## Trust model in one paragraph

Memoria is a **single-tenant, single-user** system. One deployment = one
person's memory. There is **no per-user isolation**, no roles, and no
per-client scoping: anyone who holds the bearer API key (or can complete the
OAuth flow with the client secret) can read and write *everything* in the
store, enable collector sources, and pull the dashboard. Treat the API key and
the OAuth client secret like a password to your private notes, because that is
what they are.

## What the HTTP transport does and does not protect

| Area | Reality |
|------|---------|
| **Network perimeter** | By default the HTTP server binds to `127.0.0.1`. Every shipped Docker / Cloud Run config sets `BIND_ALL=true` and the reference Cloud Run service is `--allow-unauthenticated` at the platform level — so in those deployments **the network is open and bearer auth is the only access control**. |
| **Authentication** | Static bearer token (`MEMORIA_API_KEY`) on `/mcp`, `/ingest`, `/dashboard/api`; OAuth 2.1 (`authorization_code` + mandatory PKCE S256, `client_credentials`) minting 24 h tokens. Token comparison is timing-safe. Issued tokens and authorization codes are stored only as SHA-256 hashes, in an owner-only (`0600`) `tokens.sqlite`. |
| **`/authorize` auto-approves** | There is **no consent screen and no user login**. `/authorize` issues a code to any *allow-listed* `redirect_uri` (`MEMORIA_ALLOWED_REDIRECT_HOSTS`, default claude.ai / claude.com / anthropic.com / localhost) as long as a PKCE challenge is present. The code is only useful to a client that can then present the **client secret** at `/token` — so secrecy of `MEMORIA_OAUTH_CLIENT_SECRET` is what gates access, not the authorize step. Keep it distinct from the API key; rotating one must not rotate the other. Set `MEMORIA_AUTHORIZE_REQUIRE_APPROVAL=true` to additionally require the operator before a code is issued (the API key, or a dashboard login plus a click on a same-origin consent page); this also disables the `client_credentials` grant (which would otherwise mint a token from the secret alone), so a leaked client secret alone is not sufficient. |
| **Dynamic registration** | `/register` (RFC 7591) returns the single static client. It does not create new principals. |
| **Discovery metadata** | Derived from `MEMORIA_PUBLIC_URL` when set. **Set it** in any network-exposed deployment (the server refuses to start with `BIND_ALL=true` without it); otherwise the issuer URL is derived from request headers, which an attacker can influence. |
| **Rate limits** | Per client IP: `/mcp` 30/min, auth endpoints 20/min, `/ingest` + `/dashboard/api` 120/min, global 300/min. Trusts one proxy hop for the client IP. |
| **Request limits** | 5 MB body cap, max 10 concurrent MCP sessions, 30 min idle TTL. |
| **Dashboard** | Browser exchanges the API key once at `POST /dashboard/login` for an httpOnly, SameSite=Strict, `Path=/dashboard` cookie. All store-derived fields are HTML-escaped, quotes included, so they are safe inside attributes too; the wiki renderer blocks `javascript:` URLs and never resolves `[[wikilinks]]` inside code. The page sends a Content-Security-Policy that runs only its own nonce-tagged script, with no inline event handlers and no framing, so markup that slipped past escaping still could not execute. Still: treat it as a trusted-network tool, not a hardened public web app. |
| **Path containment** | Memory paths are validated (allow-listed characters, no traversal) and resolved through symlinks to stay under `memories/`. |
| **Encryption at rest** | Collector ring buffer, source credentials and config are AES-256-GCM encrypted under `MEMORIA_ENCRYPTION_KEY` (64 hex). Required with `BIND_ALL=true`; locally an on-disk `data/collector.key` is auto-generated, created owner-only (0600 on Linux and macOS, with a warning if the filesystem ignores the mode; on Windows the file inherits the data folder's permissions), unless `MEMORIA_REQUIRE_ENCRYPTION_KEY=true`. **Memory files themselves (`memories/**/*.md`) are plain text** — protect the directory / bucket / repo with filesystem and IAM controls. |
| **Secrets in logs / errors** | Internal errors go to stderr, not to tool output. |

Things that are **not** implemented (tracked in the [roadmap](README.md#roadmap)):
per-client keys or scopes, key expiry/rotation automation, audit logging of
reads, IP allow-listing, a consent UI, MFA. If you need any of these today,
put Memoria behind an identity-aware proxy or a private network.

## The collector (experimental)

The sub-memory collector reads from sources that are about as sensitive as
personal data gets: iMessage (`chat.db`), macOS Calendar, IMAP mail, Gmail,
Google Calendar, Google Drive, arbitrary files, and — opt-in only — shell
commands. It is shipped because it is the feature that makes Memoria more than
a notes folder, but it has had **far less adversarial testing** than the
server core. Concretely:

- **Consent is enforced in code, and granted only in the dashboard**: a
  source cannot be enabled until consent has been recorded for it through
  the authenticated dashboard (Sources tab). The MCP tool surface cannot
  grant consent — an earlier design let the same agent that enables a
  source also record the agreement, so a prompt injection could consent
  on your behalf. That action was removed from `memory_sources`. Consent
  is also bound to what you agreed to: through MCP an agent can change only
  a source's schedule (poll interval, importance threshold), never its
  hosts, credentials, paths or labels; removing a custom source, or
  disabling a source in the dashboard, withdraws its consent; and the
  dashboard's consent and settings routes refuse OAuth tokens issued to
  MCP clients (a dashboard login or the API key is required).
- **Privacy tiers** (`send` / `summarize` / `local-only`) are applied before
  content leaves the device, with value-pattern detection for secrets (Luhn,
  SSN, `sk-`/`AKIA`/JWT/PEM) and re-enforced at the write sink. Pattern
  matching is inherently incomplete. Assume some sensitive content will reach
  the daily log and the search index; protect those like the source data.
- **`shell_command` custom sources execute arbitrary commands** as the server
  user. They are disabled unless `MEMORIA_ALLOW_SHELL_SOURCES=true`, which
  should only ever be set on a trusted local instance. A `file_watcher` source
  is contained to its configured path and cannot read the collector key or
  credential store.
- **Google adapters** require a refresh token with read-only scopes; store
  credentials only through `memory_sources` (they are encrypted) and revoke the
  token at <https://myaccount.google.com/permissions> when you stop using
  them.
- **A compromised Memoria instance = compromised source credentials** (IMAP
  password, Google refresh token). Use app-specific passwords and read-only
  scopes; never reuse a primary password.
- The provenance archive (`data/raw/`, on by default) stores ingested events
  durably (`local-only` events as hashes only; other tiers encrypted under
  the collector master key, never plaintext). It is runtime state; keep it
  out of version control (the shipped `.gitignore` does).
- **Embeddings**: remote embeddings are opt-in only. Setting
  `OPENAI_API_KEY` alone never sends anything anywhere; only
  `MEMORIA_EMBEDDINGS=openai` selects OpenAI, and then memory content and
  search queries leave the device regardless of collector privacy tiers.

If you are unsure, run the server without enabling any sources. Everything
else (MCP tools, dashboard, daily logs, search) works without the collector.

## Deployment checklist

- [ ] `MEMORIA_API_KEY`, `MEMORIA_OAUTH_CLIENT_SECRET`, `MEMORIA_ENCRYPTION_KEY` set, all distinct, generated with a CSPRNG, injected from a secret manager — never committed, never on a command line.
- [ ] `MEMORIA_PUBLIC_URL` pinned to the external URL.
- [ ] TLS terminated in front of the server; `HOST_BIND` left on loopback unless LAN exposure is intended.
- [ ] The store directory / bucket / private repo is access-controlled; `data/` and `memories/` are **not** in the code repo.
- [ ] `MEMORIA_ALLOW_SHELL_SOURCES` unset.
- [ ] Secret scanning (gitleaks) on any repo that holds your store, if you version it.
- [ ] If you run the reference Cloud Run template: single instance, resource-scoped runtime service account, encryption key in Secret Manager (not on the bucket).

## Supported versions

Only the latest release on `main` receives fixes.
