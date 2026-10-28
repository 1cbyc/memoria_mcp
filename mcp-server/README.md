# @agrippa87/memoria-mcp

**Persistent, plain-text memory for Claude over MCP — a Markdown repo you own.**

Memoria is an [MCP](https://modelcontextprotocol.io) server that gives Claude
Code, claude.ai and any other MCP client a shared long-term memory. Memories are
Markdown files with YAML frontmatter in a directory you control; a derived
SQLite + FTS5 index provides hybrid semantic + keyword search; agentic tools
(reflect, lint, compact, compile) keep the store healthy.

Full documentation, deployment guides and the multi-device sync setup live in
the repository: **<https://github.com/Agripp87/memoria_mcp>**

## Install

Requires Node 20 or newer (`better-sqlite3` is a native module).

```bash
npm install -g @agrippa87/memoria-mcp
```

## Use with Claude Code

```bash
claude mcp add memoria -s user -- memoria-mcp
```

Or without a global install:

```bash
claude mcp add memoria -s user -- npx -y @agrippa87/memoria-mcp
```

The store defaults to `~/.memoria` and is created on first write. Point
`MEMORIA_DIR` somewhere else if you prefer.

## Use over HTTP (claude.ai, other devices)

```bash
MEMORIA_API_KEY=… \
MEMORIA_OAUTH_CLIENT_SECRET=… \
MEMORIA_ENCRYPTION_KEY=… \
MEMORIA_PUBLIC_URL=https://your-host \
BIND_ALL=true memoria-mcp-http
```

Serves MCP at `/mcp` with OAuth 2.1 (PKCE, client credentials, dynamic
registration) plus a web dashboard at `/dashboard`. Put it behind TLS. See
[SECURITY.md](https://github.com/Agripp87/memoria_mcp/blob/main/SECURITY.md) for the
trust model before exposing it — Memoria is single-tenant, and the bearer key is
the only access control.

## What you get

- 17 MCP tools: search, read, write (with write-time dedup), daily logs, index
  rebuild, reflection, lint, compaction, entity compilation, and collector
  controls
- Three-signal retrieval: `0.8 × relevance + 0.1 × recency + 0.1 × importance`,
  where relevance is `0.7 × vector cosine + 0.3 × FTS5 BM25`
- Three embedding providers: local `all-MiniLM-L6-v2` by default (offline,
  one-time ~23 MB download), n-gram hashing as the fallback, and OpenAI
  `text-embedding-3-small` only with `MEMORIA_EMBEDDINGS=openai`
- An optional collector daemon for iMessage, IMAP, Gmail, Google Calendar and
  Drive, with consent gating, privacy tiers and AES-256-GCM encryption at rest
  (**experimental** — read SECURITY.md first)

## Configuration

Every knob is an environment variable; the full table is in the
[repository README](https://github.com/Agripp87/memoria_mcp#environment-variables).
The ones that matter most: `MEMORIA_DIR`, `MEMORIA_EMBEDDINGS`,
`OPENAI_API_KEY`, and — for any network-exposed deployment —
`MEMORIA_API_KEY`, `MEMORIA_OAUTH_CLIENT_SECRET`, `MEMORIA_ENCRYPTION_KEY` and
`MEMORIA_PUBLIC_URL`.

## License

[Apache-2.0](https://github.com/Agripp87/memoria_mcp/blob/main/LICENSE)
