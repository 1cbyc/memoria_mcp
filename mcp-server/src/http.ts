#!/usr/bin/env node

/**
 * Memoria MCP Server — HTTP/SSE transport for remote access.
 * Run this instead of index.ts when exposing via ngrok for claude.ai.
 *
 * Security features:
 *  - Bearer token authentication (MEMORIA_API_KEY required) + OAuth2/PKCE
 *  - Rate limiting: /mcp 30/min, /token+/authorize+/register 20/min,
 *    /ingest+/dashboard/api 120/min (per client IP, behind one trusted proxy)
 *  - Request body size limit (5 MB — sized for batched /ingest payloads)
 *  - Session TTL (30 min) and max sessions (10)
 *  - Binds to 127.0.0.1 by default; set BIND_ALL=true for Docker/Cloud Run
 *
 * Usage:
 *   MEMORIA_API_KEY=<key> node dist/http.js
 *   PORT=8080 MEMORIA_API_KEY=<key> node dist/http.js
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS_CODES, type Server } from "node:http";
import express, { type ErrorRequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { MemoryStore } from "./store.js";
import {
  DB_PATH,
  DATA_DIR,
  MEMORIES_DIR,
  getAllMemoryFiles,
  reindexFile,
  setupPeriodicReindex,
  setupPeriodicOptimize,
  setupPeriodicCompile,
  enqueueCompileSources,
  registerTools,
  registerCollectorTools,
  destroyCollector,
  getCollectorPipeline,
  resumeCollectorIfConfigured,
  SERVER_DESCRIPTION,
} from "./tools.js";
import { createDashboardRouter } from "./dashboard.js";
import {
  isAllowedRedirect as isAllowedRedirectFn,
  safeEqual,
  validateClientCredentials as validateClientCredentialsFn,
} from "./oauth-helpers.js";

// ─── Configuration ──────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3100", 10);
const API_KEY = process.env.MEMORIA_API_KEY;
const OAUTH_CLIENT_ID = process.env.MEMORIA_OAUTH_CLIENT_ID || "memoria";
const OAUTH_CLIENT_SECRET = process.env.MEMORIA_OAUTH_CLIENT_SECRET || API_KEY;
const MAX_SESSIONS = 10;

// Hostnames permitted as OAuth redirect targets. The authorization code is
// delivered to redirect_uri, so an open list would let anyone exfiltrate codes.
// Override with MEMORIA_ALLOWED_REDIRECT_HOSTS (comma-separated). Subdomains of
// listed hosts are allowed (e.g. "claude.ai" also matches "www.claude.ai").
const ALLOWED_REDIRECT_HOSTS = (
  process.env.MEMORIA_ALLOWED_REDIRECT_HOSTS ||
  "claude.ai,claude.com,anthropic.com,localhost,127.0.0.1"
)
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

if (!API_KEY) {
  process.stderr.write(
    "FATAL: MEMORIA_API_KEY environment variable is required.\n" +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"\n" +
      "Then set it in your .env file.\n",
  );
  process.exit(1);
}

// ── Production posture: fail closed on insecure fallbacks ────
// BIND_ALL=true means the server is network-exposed (Docker/Cloud Run). In
// that posture, booting on the convenience fallbacks (OAuth secret = API key;
// auto-generated on-disk encryption key beside the ciphertext) silently
// downgrades security, so refuse to start instead of warning. Self-hosted
// setups that accept the risk can set MEMORIA_INSECURE_ALLOW_FALLBACKS=true.
// Localhost-only runs (BIND_ALL unset) keep the old warn-and-continue.
// Exported as a pure function so the gating is unit-testable.
export function prodPostureFatal(env: Record<string, string | undefined>): string | null {
  const prodPosture = env.BIND_ALL === "true" && env.MEMORIA_INSECURE_ALLOW_FALLBACKS !== "true";
  if (!prodPosture) return null;
  if (!env.MEMORIA_OAUTH_CLIENT_SECRET) {
    return (
      "FATAL: MEMORIA_OAUTH_CLIENT_SECRET is unset while BIND_ALL=true (network-exposed). " +
      "The OAuth client secret would silently default to MEMORIA_API_KEY, so one leaked value " +
      "would compromise both the static-auth and OAuth token-minting paths.\n" +
      "Set a distinct secret:  node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"\n" +
      "or (NOT recommended) set MEMORIA_INSECURE_ALLOW_FALLBACKS=true to accept the risk.\n"
    );
  }
  if (!env.MEMORIA_ENCRYPTION_KEY) {
    return (
      "FATAL: MEMORIA_ENCRYPTION_KEY is unset while BIND_ALL=true (network-exposed). " +
      "The auto-generated fallback key would live on the same volume as the ciphertext it protects " +
      "(and chmod 600 is often unenforceable on cloud mounts), making encryption-at-rest decorative.\n" +
      "Pin a key from your secret manager:  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"\n" +
      "or (NOT recommended) set MEMORIA_INSECURE_ALLOW_FALLBACKS=true to accept the risk.\n"
    );
  }
  if (!env.MEMORIA_PUBLIC_URL) {
    return (
      "FATAL: MEMORIA_PUBLIC_URL is unset while BIND_ALL=true (network-exposed). " +
      "The OAuth discovery documents (issuer, authorize/token/registration endpoints) would be " +
      "derived from the attacker-influenced Host / X-Forwarded-Host request header, letting a " +
      "crafted host poison the token_endpoint a discovering client trusts.\n" +
      "Set MEMORIA_PUBLIC_URL to the canonical external URL (e.g. https://memoria-xxxx.run.app)\n" +
      "or (NOT recommended) set MEMORIA_INSECURE_ALLOW_FALLBACKS=true to accept the risk.\n"
    );
  }
  return null;
}

{
  const fatal = prodPostureFatal(process.env);
  if (fatal) {
    process.stderr.write(fatal);
    process.exit(1);
  }
}

if (!process.env.MEMORIA_OAUTH_CLIENT_SECRET) {
  process.stderr.write(
    "Memoria: MEMORIA_OAUTH_CLIENT_SECRET unset — OAuth client secret is defaulting to MEMORIA_API_KEY. " +
      "Set a distinct secret so rotating one credential doesn't silently rotate the other.\n",
  );
}

// ─── OAuth client + redirect validation helpers ──────────────

/** Constant-time comparison of provided client credentials against config. */
function validateClientCredentials(clientId: unknown, clientSecret: unknown): boolean {
  return validateClientCredentialsFn(
    clientId,
    clientSecret,
    OAUTH_CLIENT_ID!,
    OAUTH_CLIENT_SECRET!,
  );
}

/** Whether a redirect_uri is permitted (https/localhost + allowlisted host). */
function isAllowedRedirect(uri: string): boolean {
  return isAllowedRedirectFn(uri, ALLOWED_REDIRECT_HOSTS);
}

// ─── Persistent token store (survives server restarts) ────────
// Tokens stored in SQLite so claude.ai doesn't lose auth on rebuild/restart.

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (was 1 hour)

// The token DB defaults to DATA_DIR, which is right for a local run on local
// disk. On GCS FUSE it is not: SQLite's WAL/locking is unreliable there — a
// stale -wal/-shm produces "disk I/O error" on writes, which breaks token
// issuance (observed in prod). The Docker image therefore sets
// MEMORIA_TOKEN_DB_DIR=/tmp/memoria (container-local, ephemeral). Tokens are
// short-lived (24h) and non-critical, so losing them on restart only forces a
// cheap re-auth. Any non-Docker deployment on a FUSE/network mount should set
// MEMORIA_TOKEN_DB_DIR the same way.
// Note: with >1 instance, tokens aren't shared across instances; the primary
// auth path (static API key) is unaffected, and OAuth re-auth is cheap.
const TOKEN_DB_DIR = process.env.MEMORIA_TOKEN_DB_DIR || DATA_DIR;
const TOKEN_DB_PATH = path.join(TOKEN_DB_DIR, "tokens.sqlite");

import DatabaseConstructor from "better-sqlite3";

fs.mkdirSync(TOKEN_DB_DIR, { recursive: true });
// Create the file owner-only BEFORE SQLite opens it. Opening first and
// chmod-ing afterwards left a window where it was created with the process
// umask (typically world-readable). SQLite gives the -wal/-shm files the same
// mode as the main file, so this covers them too.
if (!fs.existsSync(TOKEN_DB_PATH)) {
  fs.closeSync(fs.openSync(TOKEN_DB_PATH, "a", 0o600));
}
const tokenDb = new DatabaseConstructor(TOKEN_DB_PATH);
try {
  fs.chmodSync(TOKEN_DB_PATH, 0o600);
} catch (err) {
  // Common on cloud storage (GCS FUSE, etc.). Log so it's not silent.
  process.stderr.write(
    `Memoria: chmod 0600 on ${TOKEN_DB_PATH} failed (${(err as Error).message}). ` +
      `On cloud storage, ensure bucket-level ACLs restrict access.\n`,
  );
}
tokenDb.pragma("journal_mode = WAL");
tokenDb.pragma("busy_timeout = 5000");

tokenDb.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_codes (
    code TEXT PRIMARY KEY,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT,
    code_challenge_method TEXT,
    expires_at INTEGER NOT NULL
  );
`);

// Clean up expired entries on startup
tokenDb.prepare("DELETE FROM tokens WHERE expires_at < ?").run(Date.now());
tokenDb.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(Date.now());

// Access tokens and authorization codes are bearer secrets, so they are stored
// as SHA-256 hashes: a copied or leaked tokens.sqlite then yields nothing
// usable. SHA-256 without a salt is right here — the inputs are 122-bit random
// UUIDs, not passwords, so there is nothing for a dictionary attack to find.
// Rows written before this change hold plaintext and simply stop matching;
// affected OAuth clients re-authenticate once (tokens lived 24h anyway).
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

const tokenOps = {
  set(token: string, expiresAt: number) {
    tokenDb
      .prepare("INSERT OR REPLACE INTO tokens (token, expires_at) VALUES (?, ?)")
      .run(hashSecret(token), expiresAt);
  },
  get(token: string): number | undefined {
    const row = tokenDb
      .prepare("SELECT expires_at FROM tokens WHERE token = ?")
      .get(hashSecret(token)) as { expires_at: number } | undefined;
    return row?.expires_at;
  },
  delete(token: string) {
    tokenDb.prepare("DELETE FROM tokens WHERE token = ?").run(hashSecret(token));
  },
  cleanup() {
    tokenDb.prepare("DELETE FROM tokens WHERE expires_at < ?").run(Date.now());
  },
};

const codeOps = {
  set(code: string, entry: AuthCodeEntry) {
    tokenDb
      .prepare(
        "INSERT OR REPLACE INTO auth_codes (code, redirect_uri, code_challenge, code_challenge_method, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        hashSecret(code),
        entry.redirectUri,
        entry.codeChallenge ?? null,
        entry.codeChallengeMethod ?? null,
        entry.expiresAt,
      );
  },
  get(code: string): AuthCodeEntry | undefined {
    const row = tokenDb
      .prepare("SELECT * FROM auth_codes WHERE code = ?")
      .get(hashSecret(code)) as any;
    if (!row) return undefined;
    return {
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge ?? undefined,
      codeChallengeMethod: row.code_challenge_method ?? undefined,
      expiresAt: row.expires_at,
    };
  },
  delete(code: string) {
    tokenDb.prepare("DELETE FROM auth_codes WHERE code = ?").run(hashSecret(code));
  },
  cleanup() {
    tokenDb.prepare("DELETE FROM auth_codes WHERE expires_at < ?").run(Date.now());
  },
};

// Authorization codes for authorization_code grant (code → metadata)
interface AuthCodeEntry {
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

// ─── Store + Server factory ─────────────────────────────────

const store = new MemoryStore(DB_PATH);

function createServer(): McpServer {
  const server = new McpServer({
    name: "memoria",
    version: "0.3.0",
    description: SERVER_DESCRIPTION,
  });
  registerTools(server, store);
  registerCollectorTools(server, store);
  return server;
}

// ─── Express app ────────────────────────────────────────────

// Exported so integration tests (supertest) can drive the REAL app — incl. the
// /dashboard/api auth gate whose correctness depends on middleware mount order.
export const app = express();

// Behind the Cloud Run / ngrok front-end, the client IP is in X-Forwarded-For.
// Trust exactly one proxy hop so express-rate-limit keys per real client IP
// instead of lumping all traffic under the proxy's address (which would turn
// every per-IP limiter into a single global bucket).
// trust proxy = 1 assumes exactly one trusted hop (Cloud Run's front end or a
// single ngrok tunnel). On Cloud Run this is verified-safe against
// X-Forwarded-For padding: the platform APPENDS the real client IP as the
// rightmost entry, which is precisely the one this setting selects — client-
// supplied left-side entries are ignored. If you deploy behind a DIFFERENT
// proxy chain (e.g. a CDN in front of Cloud Run), update this to match the
// real hop count or the limiter keys on the wrong IP.
app.set("trust proxy", 1);

// Baseline limiter for EVERY route. The dedicated limiters below cover /mcp,
// the OAuth endpoints and the write/ingest paths, but the unauthenticated
// routes (GET /, GET /dashboard's inline SPA, and /.well-known/*) were
// otherwise unthrottled. Combined with --allow-unauthenticated and a hard
// max-instances=1 (SQLite single-writer constraint), a trivial request flood
// could starve the sole instance. This generous global cap backstops those
// routes; /health is skipped so the deploy smoke loop is never throttled.
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === "/health",
    message: { error: "Rate limit exceeded. Try again in a minute." },
  }),
);

// Body parsing
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false }));

// Rate limiting: 30 requests per minute per IP
app.use(
  "/mcp",
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Rate limit exceeded. Try again in a minute." },
  }),
);

// Stricter limiter for credential / OAuth endpoints. These accept the client
// secret (== API key by default) and mint tokens, so they are the brute-force
// surface — and, unlike /mcp, were previously unthrottled on the public
// service. 20/min/IP is ample for a real OAuth dance.
const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication requests. Try again in a minute." },
});
app.use(["/token", "/authorize", "/register"], authLimiter);

// Limiter for authenticated write/ingest endpoints. The Orchestrator flushes
// at most a couple of batched requests per minute, so 120/min/IP leaves huge
// headroom for legitimate callers while bounding abuse from a leaked key.
const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded. Try again in a minute." },
});

// ─── OAuth 2.0 endpoints (for claude.ai custom connector) ──

// The optional human-approval gate (review M5). Read per request so tests and
// operators can toggle it without restarting.
function approvalRequired(): boolean {
  return process.env.MEMORIA_AUTHORIZE_REQUIRE_APPROVAL === "true";
}

// client_credentials mints a token from the client secret alone, which is
// exactly what the approval gate exists to prevent, so it is withdrawn while
// the gate is on.
function supportedGrantTypes(): string[] {
  return approvalRequired() ? ["authorization_code"] : ["authorization_code", "client_credentials"];
}

// Token endpoint — client credentials grant
app.post("/token", (req, res) => {
  // No body (or a Content-Type no parser claims) leaves req.body undefined in
  // Express 5; dereferencing it was a 500 instead of an OAuth error.
  const body = (req.body ?? {}) as Record<string, unknown>;
  const grantType = body.grant_type;

  if (grantType === "authorization_code") {
    // Authorization code exchange. This is a confidential client
    // (token_endpoint_auth_method = client_secret_post), so the client MUST
    // authenticate AND prove PKCE. Without client auth the /authorize endpoint
    // would be an open token dispenser (anyone gets a code → trades for a token).
    // A JSON body can carry any type here; hashing or comparing a non-string
    // would throw. Absent parameters are handled below, so only reject the
    // present-but-wrong-type case up front.
    const { code, code_verifier: codeVerifier, redirect_uri: redirectUri } = body;
    if (
      typeof code !== "string" ||
      (codeVerifier !== undefined && typeof codeVerifier !== "string") ||
      (redirectUri !== undefined && typeof redirectUri !== "string")
    ) {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    // Authenticate the client.
    if (!validateClientCredentials(body.client_id, body.client_secret)) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    const entry = codeOps.get(code);
    if (!entry || Date.now() > entry.expiresAt) {
      codeOps.delete(code);
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    // OAuth 2.1 (draft §10.2) dropped redirect_uri from the token request:
    // PKCE binds the code to the client that started the flow, so a client
    // need not resend it. A server must still accept it and, if sent, check
    // it — which is exactly this. Optional here is deliberate, not a gap.
    if (redirectUri && redirectUri !== entry.redirectUri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }

    // PKCE is mandatory — every code is issued with a challenge (see /authorize).
    if (!entry.codeChallenge) {
      codeOps.delete(code);
      res.status(400).json({ error: "invalid_grant", error_description: "missing PKCE challenge" });
      return;
    }
    if (!codeVerifier) {
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
      return;
    }
    const expected = createHash("sha256").update(codeVerifier).digest("base64url");
    // Constant-time compare to avoid leaking the challenge via timing.
    const expectedBuf = Buffer.from(expected);
    const challengeBuf = Buffer.from(entry.codeChallenge);
    if (expectedBuf.length !== challengeBuf.length || !timingSafeEqual(expectedBuf, challengeBuf)) {
      res.status(400).json({ error: "invalid_grant", error_description: "code_verifier mismatch" });
      return;
    }

    // Consume the code (one-time use)
    codeOps.delete(code);

    // Issue access token (24-hour TTL, persisted to SQLite)
    const token = randomUUID();
    const expiresIn = TOKEN_TTL_MS / 1000;
    tokenOps.set(token, Date.now() + TOKEN_TTL_MS);

    // Log a prefix of the stored hash, never of the token itself: it matches
    // the tokens.sqlite row for debugging and gives a log reader nothing.
    process.stderr.write(
      `Memoria: issued OAuth token (auth_code) sha256:${hashSecret(token).slice(0, 8)}\n`,
    );
    res.json({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
    return;
  }

  if (grantType === "client_credentials") {
    if (approvalRequired()) {
      res.status(400).json({
        error: "unauthorized_client",
        error_description:
          "client_credentials is disabled while MEMORIA_AUTHORIZE_REQUIRE_APPROVAL=true; use the authorization_code flow.",
      });
      return;
    }
    if (!validateClientCredentials(body.client_id, body.client_secret)) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    // Issue access token (24-hour TTL, persisted to SQLite)
    const token = randomUUID();
    const expiresIn = TOKEN_TTL_MS / 1000;
    tokenOps.set(token, Date.now() + TOKEN_TTL_MS);

    process.stderr.write(
      `Memoria: issued OAuth token (client_creds) sha256:${hashSecret(token).slice(0, 8)}\n`,
    );
    res.json({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
    return;
  }

  res.status(400).json({ error: "unsupported_grant_type" });
});

// ─── URL helper ─────────────────────────────────────────────

// Pinned public URL for OAuth issuer/endpoint metadata. Without it, the base
// URL is derived from attacker-influenced request headers (Host /
// X-Forwarded-Host), which reflects a crafted host into the OAuth discovery
// document — a client that trusts discovery could be pointed at an attacker's
// token endpoint. Set MEMORIA_PUBLIC_URL in any network-exposed deployment;
// header derivation remains as the localhost/ngrok-dev fallback.
const PUBLIC_URL = (process.env.MEMORIA_PUBLIC_URL || "").trim().replace(/\/+$/, "");

function getBaseUrl(req: express.Request): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

// ─── OAuth / MCP metadata endpoints ────────────────────────

// Protected Resource Metadata (RFC 9728 — required by MCP 2025-03-26)
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/anthropics/claude-ai-mcp",
  });
});

// OAuth Authorization Server Metadata (RFC 8414 + MCP requirements)
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    grant_types_supported: supportedGrantTypes(),
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp:tools"],
  });
});

// Dynamic Client Registration (RFC 7591 — required by MCP spec)
app.post("/register", (_req, res) => {
  // Return a static client registration using our known credentials
  res.status(201).json({
    client_id: OAUTH_CLIENT_ID,
    client_name: "Memoria MCP Client",
    grant_types: supportedGrantTypes(),
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  });
});

// Authorization endpoint — auto-approves and redirects with code
// (needed for authorization_code flow that claude.ai may use)
app.get("/authorize", (req, res) => {
  // A repeated parameter (?state=a&state=b) arrives as an array; treat it as
  // absent rather than letting an array reach new URL() or a SQLite bind.
  const param = (name: string): string | undefined => {
    const v = req.query[name];
    return typeof v === "string" ? v : undefined;
  };
  const redirectUri = param("redirect_uri");
  const state = param("state");
  const codeChallenge = param("code_challenge");
  const codeChallengeMethod = param("code_challenge_method");

  if (!redirectUri) {
    res.status(400).json({ error: "missing redirect_uri" });
    return;
  }

  // Only deliver codes to allowlisted redirect targets (prevents code exfil).
  if (!isAllowedRedirect(redirectUri)) {
    res
      .status(400)
      .json({ error: "invalid_request", error_description: "redirect_uri not allowed" });
    return;
  }

  // Optional human approval (review M5): with
  // MEMORIA_AUTHORIZE_REQUIRE_APPROVAL=true, issuing a code additionally
  // requires a logged-in dashboard session or the API key, so a leaked
  // OAuth client secret alone is not sufficient to obtain a token.
  if (approvalRequired()) {
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : "";
    if (
      !hasValidDashboardSession(req, "memoria_approve") &&
      !(bearer && API_KEY && safeEqual(bearer, API_KEY))
    ) {
      res.status(401).json({
        error: "access_denied",
        error_description:
          "Authorization requires operator approval: log in to the Memoria dashboard first, or set MEMORIA_AUTHORIZE_REQUIRE_APPROVAL=false.",
      });
      return;
    }
  }

  // PKCE is mandatory and must be S256 — codes are useless without a verifier,
  // which (combined with client auth at /token) closes the open-dispenser hole.
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    res.status(400).json({
      error: "invalid_request",
      error_description: "code_challenge with code_challenge_method=S256 is required",
    });
    return;
  }

  // Generate an authorization code and store it with the PKCE challenge (persisted)
  const code = randomUUID();
  codeOps.set(code, {
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });

  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(url.toString());
});

// ─── Dashboard browser sessions (httpOnly cookie) ───────────
//
// The dashboard used to keep the raw API key in localStorage, where any XSS on
// the origin could read it. Instead the browser now exchanges the key ONCE at
// POST /dashboard/login for an opaque session token delivered as an httpOnly,
// SameSite=Strict cookie scoped to Path=/dashboard — unreadable from JS and
// never sent to /mcp or /ingest. Bearer auth is unchanged for API clients.
// In-memory store is correct here: max-instances=1 in prod, and a lost session
// just means one re-login.

const DASHBOARD_SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_DASHBOARD_SESSIONS = 20;
const dashboardSessions = new Map<string, number>(); // token -> expiry epoch ms

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

// memoria_approve carries the same session token as memoria_session, but is
// scoped Path=/authorize and honoured only there; memoria_session is honoured
// only on /dashboard. Each check names the one cookie it accepts.
function hasValidDashboardSession(
  req: express.Request,
  cookieName: "memoria_session" | "memoria_approve",
): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[cookieName];
  if (!token) return false;
  const expiry = dashboardSessions.get(token);
  if (expiry === undefined) return false;
  if (Date.now() > expiry) {
    dashboardSessions.delete(token);
    return false;
  }
  return true;
}

function issueDashboardSession(): string {
  // Lazy eviction: drop expired sessions, then oldest-expiry if still over cap.
  const now = Date.now();
  for (const [t, exp] of dashboardSessions) {
    if (now > exp) dashboardSessions.delete(t);
  }
  while (dashboardSessions.size >= MAX_DASHBOARD_SESSIONS) {
    let oldest: string | null = null;
    let oldestExp = Infinity;
    for (const [t, exp] of dashboardSessions) {
      if (exp < oldestExp) {
        oldestExp = exp;
        oldest = t;
      }
    }
    if (oldest === null) break;
    dashboardSessions.delete(oldest);
  }
  const token = randomUUID();
  dashboardSessions.set(token, now + DASHBOARD_SESSION_TTL_MS);
  return token;
}

// ─── Auth middleware ────────────────────────────────────────

function authenticate(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const baseUrl = getBaseUrl(req);
  const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    // Dashboard browser session fallback — ONLY honored on the /dashboard
    // subtree. The cookie is Path=/dashboard + SameSite=Strict, but that is
    // browser-side scoping only; the server must also refuse a manually
    // presented memoria_session cookie on /mcp and /ingest, or a leaked 7-day
    // dashboard session would grant full MCP tool (read/write) access rather
    // than just dashboard access.
    const reqPath = req.originalUrl.split("?")[0];
    const onDashboard = reqPath === "/dashboard" || reqPath.startsWith("/dashboard/");
    if (onDashboard && hasValidDashboardSession(req, "memoria_session")) {
      next();
      return;
    }
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`)
      .json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: Bearer token required" },
        id: null,
      });
    return;
  }

  const provided = authHeader.slice(7); // "Bearer ".length

  // Check 1: Is it a valid OAuth-issued token? (persisted in SQLite)
  const tokenExpiry = tokenOps.get(provided);
  if (tokenExpiry !== undefined) {
    if (Date.now() > tokenExpiry) {
      tokenOps.delete(provided);
      res
        .status(401)
        .set(
          "WWW-Authenticate",
          `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`,
        )
        .json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: token expired" },
          id: null,
        });
      return;
    }
    // Valid OAuth token
    next();
    return;
  }

  // Check 2: Is it the static API key? (for direct Bearer auth)
  if (!safeEqual(provided, API_KEY!)) {
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`,
      )
      .json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized: invalid token" },
        id: null,
      });
    return;
  }

  next();
}

// Apply auth to all /mcp routes
app.use("/mcp", authenticate);

// ─── Session management ─────────────────────────────────────

interface SessionInfo {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

const sessions: Record<string, SessionInfo> = {};

// Periodic session + token cleanup. unref so it never keeps the process alive
// (matters for tests that import this module without starting the server).
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sid, info] of Object.entries(sessions)) {
    if (now - info.lastActivity > SESSION_TTL_MS) {
      process.stderr.write(`Memoria: expiring idle session ${sid.slice(0, 8)}...\n`);
      void info.transport.close?.();
      delete sessions[sid];
    }
  }
  // Clean expired tokens and auth codes
  tokenOps.cleanup();
  codeOps.cleanup();
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

// ─── MCP endpoints ──────────────────────────────────────────

// POST /mcp — main MCP endpoint
app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && sessions[sessionId]) {
      sessions[sessionId].lastActivity = Date.now();
      transport = sessions[sessionId].transport;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Check session cap
      if (Object.keys(sessions).length >= MAX_SESSIONS) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Too many active sessions. Try again later." },
          id: null,
        });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions[sid] = { transport, lastActivity: Date.now() };
        },
      });

      transport.onclose = () => {
        const sid = Object.entries(sessions).find(([, s]) => s.transport === transport)?.[0];
        if (sid) delete sessions[sid];
      };

      const server = createServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad request: no valid session" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET /mcp — SSE stream
app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  sessions[sessionId].lastActivity = Date.now();
  await sessions[sessionId].transport.handleRequest(req, res, req.body);
});

// DELETE /mcp — session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await sessions[sessionId].transport.handleRequest(req, res, req.body);
});

// ─── Dashboard (web UI) ──────────────────────────────────────

const dashboardRouter = createDashboardRouter(store);

// The router serves the page at "/" and the JSON API at "/api/*". Gate the
// /dashboard/api subtree with rate-limit + auth as standalone middleware FIRST,
// then mount the router once at /dashboard so "/dashboard" -> page (unauth) and
// "/dashboard/api/*" -> "/api/*" (authed). The dashboard client calls
// "/dashboard/api/<x>", which strips to "/api/<x>" and matches the routes.
//
// (Previously the router was mounted AT "/dashboard/api" while its routes were
// named "/api/*", double-prefixing every endpoint to "/dashboard/api/api/*" —
// unreachable by the client — and the "app.get('/dashboard', router)" page
// passthrough never matched the router's "/" route. The whole dashboard 404'd.)
// Browser login: exchange the API key ONCE for an httpOnly session cookie so
// the key never persists in JS-readable storage (localStorage). Rate-limited
// like the other credential endpoints. Registered BEFORE the router mount so
// the router's catch-alls can't shadow it.
app.post("/dashboard/login", authLimiter, express.json(), (req, res) => {
  // Trim: keys copied from a terminal often carry surrounding whitespace or a
  // newline (the secret is stored without one, so the shell prompt renders
  // glued to it in scrollback), and timingSafeEqual is exact-length.
  const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  const expected = API_KEY as string;
  const keyBuf = Buffer.from(key);
  const expectedBuf = Buffer.from(expected);
  const ok = keyBuf.length === expectedBuf.length && timingSafeEqual(keyBuf, expectedBuf);
  if (!ok) {
    res.status(401).json({ error: "invalid key" });
    return;
  }
  const token = issueDashboardSession();
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  const attrs = `HttpOnly; Max-Age=${Math.floor(DASHBOARD_SESSION_TTL_MS / 1000)}${secure}`;
  res.setHeader("Set-Cookie", [
    `memoria_session=${token}; Path=/dashboard; SameSite=Strict; ${attrs}`,
    // Same session, scoped to /authorize only, so the approval gate there
    // (MEMORIA_AUTHORIZE_REQUIRE_APPROVAL) can see a dashboard login in a
    // real browser — the Path=/dashboard cookie is never sent to /authorize.
    // SameSite=Lax, not Strict: the OAuth flow reaches /authorize by a
    // top-level navigation from claude.ai, and browsers withhold Strict
    // cookies on cross-site navigations, so a Strict cookie could never
    // satisfy the gate. Lax is still withheld from cross-site subresource
    // and POST requests, and /authorize can only deliver a code to an
    // allow-listed redirect_uri. Neither cookie is honoured on /mcp or
    // /ingest (see authenticate()).
    `memoria_approve=${token}; Path=/authorize; SameSite=Lax; ${attrs}`,
  ]);
  res.json({ ok: true });
});

app.use("/dashboard/api", writeLimiter, authenticate); // gate API subtree only
app.use("/dashboard", dashboardRouter); // page "/" + API "/api/*"

// Root convenience redirect → the human-facing dashboard. (MCP clients use
// /mcp explicitly; a bare-URL visit otherwise 404s "Cannot GET /".)
app.get("/", (_req, res) => {
  res.redirect("/dashboard");
});

// Health check — minimal, no sensitive data
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ─── Sub-memory ingestion endpoint ───────────────────────────
// Direct HTTP endpoint for external sub-memory collectors to push events
// (e.g., a mobile companion app or remote collector)

/**
 * An event timestamp as ISO 8601, or `now` when it cannot be used. An
 * unparsable value becomes "now", as custom sources already do, rather than an
 * event that fails every ingest attempt and is dead-lettered while the caller
 * is told it was accepted. Years outside 1970–9999 are treated the same way:
 * epoch microseconds sent as milliseconds land around year 56,000, which is
 * no one's intent.
 */
/**
 * Sanitize an /ingest event's `meta` (review M6). Meta values are
 * interpolated into daily-log Markdown downstream, so a newline-bearing
 * string could forge a `## TIME — source` heading. Keep only scalar values,
 * strip control characters (including CR/LF) from strings, and bound sizes.
 */
export function sanitizeIngestMeta(meta: unknown): Record<string, string | number | boolean> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const stripControls = (s: string, replacement: string, max: number): string =>
    [...s]
      .map((c) => {
        const n = c.charCodeAt(0);
        return n < 32 || n === 127 ? replacement : c;
      })
      .join("")
      .slice(0, max);
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    const key = stripControls(k, "", 50);
    if (!key) continue;
    if (typeof v === "string") {
      out[key] = stripControls(v, " ", 500);
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[key] = v;
    }
  }
  return out;
}

export function normalizeTimestamp(v: unknown, now: Date = new Date()): string {
  const d = new Date(typeof v === "string" || typeof v === "number" ? v : NaN);
  const year = d.getUTCFullYear();
  const plausible = !Number.isNaN(d.getTime()) && year >= 1970 && year <= 9999;
  return (plausible ? d : now).toISOString();
}

app.post("/ingest", writeLimiter, authenticate, async (req, res) => {
  const events = req.body?.events;
  if (!Array.isArray(events) || events.length === 0) {
    res.status(400).json({ error: "Request body must contain 'events' array" });
    return;
  }

  // Validate event shape — all three must be non-empty strings
  for (const event of events) {
    const id = typeof event.id === "string" ? event.id.trim() : "";
    const source = typeof event.source === "string" ? event.source.trim() : "";
    const content = typeof event.content === "string" ? event.content.trim() : "";
    if (!id || !source || !content) {
      res.status(400).json({
        error: "Each event must have non-empty string id, source, and content fields",
      });
      return;
    }
  }

  // Cap batch size
  if (events.length > 200) {
    res.status(400).json({ error: "Max 200 events per request" });
    return;
  }

  try {
    // Normalize events to RawEvent shape with defaults. Caller-supplied
    // importance and privacyTier are untrusted: clamp importance to [1,10] and
    // reject any privacyTier outside the known enum (the ingestion sink also
    // re-classifies content and takes the most-restrictive tier).
    const VALID_TIERS = new Set(["send", "summarize", "local-only"]);
    const clampImportance = (v: unknown): number => {
      const n = typeof v === "number" && Number.isFinite(v) ? v : 5;
      return Math.max(1, Math.min(10, Math.round(n)));
    };
    const normalized = events.map((e: any) => ({
      id: String(e.id),
      source: String(e.source),
      eventType: String(e.eventType || "external"),
      content: String(e.content),
      timestamp: normalizeTimestamp(e.timestamp),
      meta: sanitizeIngestMeta(e.meta),
      importanceEstimate: clampImportance(e.importance),
      privacyTier: VALID_TIERS.has(e.privacyTier) ? e.privacyTier : "send",
    }));

    // Buffer events and run ingestion
    const { buffer, ingestion } = await getCollectorPipeline(store);
    const { inserted: buffered, dropped: bufferDropped } = buffer.pushBatch(normalized);
    const result = await ingestion.ingest(normalized);

    // Reindex today's daily log so new events are searchable immediately
    if (result.written > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const dailyFile = path.join(MEMORIES_DIR, "daily", `${today}.md`);
      if (fs.existsSync(dailyFile)) {
        await reindexFile(store, dailyFile);
      }
      // Propagate to the entity pages these sources touch (rule V).
      enqueueCompileSources(result.writtenSources);
    }

    process.stderr.write(
      `Memoria: /ingest received ${events.length} events, buffered ${buffered}, ` +
        `written ${result.written}, deduped ${result.deduplicated}, failed ${result.errors.length}` +
        (bufferDropped > 0 ? `, BUFFER FULL: ${bufferDropped} dropped` : "") +
        "\n" +
        result.errors
          .slice(0, 5)
          .map((e) => `  failed: ${e}\n`)
          .join(""),
    );

    // Warn the caller if buffer is near capacity
    const total = buffer.totalCount();
    const cap = buffer.maxCapacity();
    const nearCapacity = total >= cap * 0.9;

    res.json({
      accepted: events.length,
      buffered,
      written: result.written,
      deduplicated: result.deduplicated,
      rateLimited: result.rateLimited,
      // Events that failed to write. They stay buffered and are retried; the
      // messages are logged server-side, not returned (they can hold paths).
      failed: result.errors.length,
      bufferDropped,
      bufferUsage: { current: total, max: cap, nearCapacity },
      ...(bufferDropped > 0 && {
        warning: `${bufferDropped} oldest events dropped due to buffer capacity`,
      }),
    });
  } catch (err: any) {
    process.stderr.write(`Memoria: /ingest error: ${err.message}\n`);
    res.status(500).json({ error: "Ingestion failed" });
  }
});

// ─── Error handler ──────────────────────────────────────────
//
// Last in the chain. Without it, Express's default handler answers a thrown
// error with the stack trace as HTML unless NODE_ENV=production — which only
// the Docker image sets, so an npm install of memoria-mcp-http leaked file
// paths and dependency versions to anyone who could reach it. A client error
// (malformed JSON 400, oversized body 413) keeps its status; anything else is
// a generic 500 with the detail logged here instead of sent.
const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const raw = typeof err?.status === "number" ? err.status : err?.statusCode;
  const status = typeof raw === "number" && raw >= 400 && raw < 500 ? raw : 500;
  if (status === 500) {
    process.stderr.write(`Memoria: unhandled error: ${err?.stack ?? String(err)}\n`);
  }
  res.status(status).json({ error: STATUS_CODES[status] ?? "Error" });
};
app.use(errorHandler);

// ─── Start ──────────────────────────────────────────────────

async function main(): Promise<void> {
  const files = getAllMemoryFiles();
  if (store.needsReindex) {
    process.stderr.write("Memoria: full reindex triggered by provider change...\n");
  }
  for (const f of files) {
    // A stop signal during a long first index: stop here, before shutdown()
    // closes the store under the next reindexFile.
    if (shuttingDown) return;
    await reindexFile(store, f);
  }
  if (shuttingDown) return;
  process.stderr.write(`Indexed ${files.length} memory files.\n`);

  // fs.watch is inert on the GCS FUSE / Cloud Run mount, so sweep periodically
  // to pick up memory files changed by `git pull` from other devices.
  setupPeriodicReindex(store);
  setupPeriodicOptimize(store); // no-op unless MEMORIA_AUTO_OPTIMIZE=true
  setupPeriodicCompile(store); // no-op unless MEMORIA_AUTO_COMPILE=true

  // Bind to 0.0.0.0 when BIND_ALL=true (for cloud/Docker), else localhost only
  const host = process.env.BIND_ALL === "true" ? "0.0.0.0" : "127.0.0.1";
  httpServer = app.listen(PORT, host, () => {
    process.stderr.write(`Memoria HTTP server listening on http://${host}:${PORT}/mcp\n`);
    // Resume enabled collector sources; errors are logged inside.
    void resumeCollectorIfConfigured(store);
  });
}

// Only start the server when run as the entry point (node dist/http.js).
// When imported (e.g. by integration tests), do NOT reindex/listen.
//
// Compare REAL paths on both sides. Node resolves symlinks when it loads the
// main module, so import.meta.url is always the real file — but process.argv[1]
// keeps the path it was invoked by. `npm install -g` on Linux/macOS installs
// `memoria-mcp-http` as a symlink to this file, so a plain URL comparison was
// false there: the module loaded, never called main(), and the process exited 0
// with no server and no error. Windows .cmd shims and Docker (`node
// dist/http.js`) pass the real path, which is why nothing caught it.
export function isEntryPoint(invokedPath: string | undefined, moduleUrl: string): boolean {
  if (!invokedPath) return false;
  try {
    return fs.realpathSync(invokedPath) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

let httpServer: Server | undefined;
let shuttingDown = false;

// Graceful shutdown on SIGINT (Ctrl-C) AND SIGTERM. Only SIGINT used to be
// handled, but SIGTERM is what `docker stop`, Cloud Run and systemd send: the
// process died without closing SQLite or flushing the collector, and every
// deploy ended in a hard kill. A second signal while shutting down forces the
// exit, and so does the timer if a close hangs — platforms SIGKILL ~10s after
// SIGTERM anyway, and exiting ourselves first keeps the exit code honest.
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  process.stderr.write(`Memoria: ${signal} received, shutting down\n`);
  setTimeout(() => process.exit(1), 8_000).unref();
  httpServer?.close(); // stop accepting; in-flight requests finish or are cut at exit
  clearInterval(cleanupTimer);
  let exitCode = 0;
  try {
    await destroyCollector();
    for (const sid in sessions) {
      await sessions[sid].transport.close?.();
    }
  } catch (err) {
    process.stderr.write(`Memoria: error during shutdown: ${err}\n`);
    exitCode = 1;
  } finally {
    tokenDb.close();
    store.close();
  }
  process.exit(exitCode);
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  // Registered only when running as the server, so importing this module (the
  // integration tests do) leaves the importer's own signal handling alone.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  main().catch((err) => {
    // Once shutting down, an error from work cut short is expected; exiting 1
    // here would pre-empt shutdown()'s clean exit(0).
    if (shuttingDown) return;
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
  });
}
