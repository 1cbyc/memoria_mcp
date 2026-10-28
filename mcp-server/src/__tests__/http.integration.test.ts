import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// http.ts reads MEMORIA_API_KEY + MEMORIA_DIR at module load and exits if the
// key is unset — set both BEFORE importing it. Importing does NOT start a
// server (the listen is guarded to the entry-point only).
const KEY = "test-key-abcdefghijklmnop";
// A DISTINCT OAuth client secret (≠ API key). This proves the two credentials
// are decoupled: rotating the API key must not silently rotate OAuth, and the
// API key must NOT be accepted as the OAuth client_secret (asserted below).
const OAUTH_SECRET = "oauth-client-secret-distinct-zyxwv";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-http-"));
process.env.MEMORIA_API_KEY = KEY;
process.env.MEMORIA_OAUTH_CLIENT_SECRET = OAUTH_SECRET;
process.env.MEMORIA_DIR = ROOT;
process.env.MEMORIA_EMBEDDINGS = "hash";
process.env.MEMORIA_TOKEN_DB_DIR = path.join(ROOT, "tok");

let request: any;
let app: any;
const auth = { Authorization: `Bearer ${KEY}` };

beforeAll(async () => {
  fs.mkdirSync(path.join(ROOT, "memories", "user"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "tok"), { recursive: true });
  fs.writeFileSync(
    path.join(ROOT, "memories", "user", "demo.md"),
    "---\nname: Demo\ntype: user\nimportance: 7\n---\n\n# Demo\nHello **world** and [[Demo]].\n",
  );
  request = (await import("supertest")).default;
  app = (await import("../http.js")).app;
});

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

describe("http app — smoke + routing", () => {
  it("GET /health -> 200", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok" });
  });

  it("GET / -> 302 redirect to /dashboard", async () => {
    const r = await request(app).get("/");
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/dashboard");
  });

  it("GET /dashboard -> 200 page with the Wiki tab (unauthenticated)", async () => {
    const r = await request(app).get("/dashboard");
    expect(r.status).toBe(200);
    expect(r.text).toContain('data-tab="wiki"');
  });
});

describe("http app — the /dashboard/api auth gate (the untested critical path)", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const r = await request(app).get("/dashboard/api/stats");
    expect(r.status).toBe(401);
  });

  it("rejects a wrong bearer token with 401", async () => {
    const r = await request(app).get("/dashboard/api/stats").set("Authorization", "Bearer nope");
    expect(r.status).toBe(401);
  });

  it("accepts the correct bearer token with 200", async () => {
    const r = await request(app).get("/dashboard/api/stats").set(auth);
    expect(r.status).toBe(200);
  });

  it("gates the write endpoints too (annotate 401 without auth)", async () => {
    const r = await request(app)
      .post("/dashboard/api/memory/annotate")
      .send({ file: "user/demo.md", text: "x" });
    expect(r.status).toBe(401);
  });
});

describe("http app — wiki endpoints (authenticated)", () => {
  it("GET /api/wiki/index returns categories", async () => {
    const r = await request(app).get("/dashboard/api/wiki/index").set(auth);
    expect(r.status).toBe(200);
    expect(r.body.categories).toBeTruthy();
    expect(Object.keys(r.body.categories)).toContain("user");
  });

  it("GET /api/memory renders a memory to sanitized HTML", async () => {
    const r = await request(app).get("/dashboard/api/memory?file=user/demo.md").set(auth);
    expect(r.status).toBe(200);
    expect(r.body.html).toContain("<strong>world</strong>");
  });

  it("GET /api/memory rejects path traversal with 400", async () => {
    const r = await request(app).get("/dashboard/api/memory?file=../../etc/passwd").set(auth);
    expect(r.status).toBe(400);
  });

  it("GET /api/memory returns 404 for a missing file", async () => {
    const r = await request(app).get("/dashboard/api/memory?file=user/nope.md").set(auth);
    expect(r.status).toBe(404);
  });

  it("POST /api/memory/annotate appends a note (append-only)", async () => {
    const before = fs.readFileSync(path.join(ROOT, "memories", "user", "demo.md"), "utf-8");
    const r = await request(app)
      .post("/dashboard/api/memory/annotate")
      .set(auth)
      .send({ file: "user/demo.md", text: "a smoke-test note" });
    expect(r.status).toBe(200);
    const after = fs.readFileSync(path.join(ROOT, "memories", "user", "demo.md"), "utf-8");
    expect(after.startsWith(before)).toBe(true); // append-only: never rewrites
    expect(after).toContain("a smoke-test note");
  });

  it("POST /api/memory/annotate refuses MEMORY_INDEX.md", async () => {
    const r = await request(app)
      .post("/dashboard/api/memory/annotate")
      .set(auth)
      .send({ file: "MEMORY_INDEX.md", text: "x" });
    expect(r.status).toBe(400);
  });
});

describe("http app — OAuth token endpoint", () => {
  it("rejects client_credentials with a wrong client_secret", async () => {
    const r = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "client_credentials", client_id: "memoria", client_secret: "wrong" });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid_client");
  });

  it("accepts client_credentials with the configured OAuth secret", async () => {
    const r = await request(app).post("/token").type("form").send({
      grant_type: "client_credentials",
      client_id: "memoria",
      client_secret: OAUTH_SECRET,
    });
    expect(r.status).toBe(200);
    expect(r.body.access_token).toBeTruthy();
    expect(r.body.token_type).toBe("Bearer");
  });

  // Decoupling: the bearer API key is NOT the OAuth client_secret. Using the API
  // key where the OAuth secret belongs must be rejected — otherwise rotating one
  // credential silently rotates the other (the bug this guards against).
  it("REJECTS the API key used as the OAuth client_secret", async () => {
    const r = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "client_credentials", client_id: "memoria", client_secret: KEY });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid_client");
  });

  it("unsupported grant_type -> 400", async () => {
    const r = await request(app)
      .post("/token")
      .type("form")
      .send({ grant_type: "password", client_id: "memoria", client_secret: OAUTH_SECRET });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unsupported_grant_type");
  });
});

describe("http app — OAuth authorization_code + PKCE flow", () => {
  const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  // Pull a fresh authorization code out of the /authorize 302 redirect.
  async function getCode(): Promise<string> {
    const r = await request(app).get("/authorize").query({
      response_type: "code",
      client_id: "memoria",
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
    });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.location);
    expect(loc.searchParams.get("state")).toBe("xyz");
    const code = loc.searchParams.get("code");
    expect(code).toBeTruthy();
    return code!;
  }

  it("GET /authorize requires PKCE S256 (no challenge -> 400)", async () => {
    const r = await request(app).get("/authorize").query({
      response_type: "code",
      client_id: "memoria",
      redirect_uri: REDIRECT,
    });
    expect(r.status).toBe(400);
  });

  it("GET /authorize rejects a non-allowlisted redirect_uri -> 400", async () => {
    const r = await request(app).get("/authorize").query({
      response_type: "code",
      client_id: "memoria",
      redirect_uri: "https://evil.example.com/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    expect(r.status).toBe(400);
  });

  it("exchanges code+verifier for a token that actually authorizes the API", async () => {
    const code = await getCode();
    const r = await request(app).post("/token").type("form").send({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: "memoria",
      client_secret: OAUTH_SECRET,
    });
    expect(r.status).toBe(200);
    const token = r.body.access_token;
    expect(token).toBeTruthy();

    // The issued token must work as a Bearer credential on the gated API.
    const gated = await request(app)
      .get("/dashboard/api/stats")
      .set("Authorization", `Bearer ${token}`);
    expect(gated.status).toBe(200);
  });

  it("rejects the code exchange when the PKCE verifier is wrong -> 400", async () => {
    const code = await getCode();
    const r = await request(app)
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        code_verifier: randomBytes(32).toString("base64url"), // not the real verifier
        redirect_uri: REDIRECT,
        client_id: "memoria",
        client_secret: OAUTH_SECRET,
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_grant");
  });

  it("rejects the code exchange without client authentication -> 401", async () => {
    const code = await getCode();
    const r = await request(app).post("/token").type("form").send({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: "memoria",
      client_secret: "wrong",
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid_client");
  });
});

// ─── Phase 3 (critical-review remediation): security hardening ───

describe("prod-posture fail-closed gating (C2/C8)", () => {
  let prodPostureFatal: (env: Record<string, string | undefined>) => string | null;
  beforeAll(async () => {
    ({ prodPostureFatal } = await import("../http.js"));
  });

  it("refuses prod posture without a distinct OAuth client secret", () => {
    const fatal = prodPostureFatal({ BIND_ALL: "true", MEMORIA_ENCRYPTION_KEY: "x".repeat(64) });
    expect(fatal).toContain("MEMORIA_OAUTH_CLIENT_SECRET");
  });

  it("refuses prod posture without a pinned encryption key", () => {
    const fatal = prodPostureFatal({ BIND_ALL: "true", MEMORIA_OAUTH_CLIENT_SECRET: "s" });
    expect(fatal).toContain("MEMORIA_ENCRYPTION_KEY");
  });

  it("refuses prod posture without a pinned public URL", () => {
    const fatal = prodPostureFatal({
      BIND_ALL: "true",
      MEMORIA_OAUTH_CLIENT_SECRET: "s",
      MEMORIA_ENCRYPTION_KEY: "x".repeat(64),
    });
    expect(fatal).toContain("MEMORIA_PUBLIC_URL");
  });

  it("boots prod posture when both secrets and the public URL are pinned", () => {
    expect(
      prodPostureFatal({
        BIND_ALL: "true",
        MEMORIA_OAUTH_CLIENT_SECRET: "s",
        MEMORIA_ENCRYPTION_KEY: "x".repeat(64),
        MEMORIA_PUBLIC_URL: "https://memoria.example.run.app",
      }),
    ).toBeNull();
  });

  it("localhost posture keeps warn-and-continue (no fatal)", () => {
    expect(prodPostureFatal({})).toBeNull();
  });

  it("the explicit escape hatch disables the gate", () => {
    expect(
      prodPostureFatal({ BIND_ALL: "true", MEMORIA_INSECURE_ALLOW_FALLBACKS: "true" }),
    ).toBeNull();
  });
});

let approveCookie = "";

describe("dashboard httpOnly cookie session (C6)", () => {
  it("rejects a wrong key at /dashboard/login -> 401, no cookie", async () => {
    const r = await request(app).post("/dashboard/login").send({ key: "wrong" });
    expect(r.status).toBe(401);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("exchanges the API key for an httpOnly SameSite=Strict cookie scoped to /dashboard", async () => {
    const r = await request(app).post("/dashboard/login").send({ key: KEY });
    expect(r.status).toBe(200);
    const cookie = (r.headers["set-cookie"] || [])[0] || "";
    expect(cookie).toContain("memoria_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/dashboard");
  });

  it("the session cookie authorizes /dashboard/api without a bearer token", async () => {
    const login = await request(app).post("/dashboard/login").send({ key: KEY });
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    approveCookie = (login.headers["set-cookie"] as unknown as string[])
      .map((c: string) => c.split(";")[0])
      .find((c: string) => c.startsWith("memoria_approve="))!;
    expect(approveCookie).toBeTruthy();
    const r = await request(app).get("/dashboard/api/stats").set("Cookie", cookie);
    expect(r.status).toBe(200);
  });

  it("the dashboard session cookie does NOT authorize /mcp or /ingest (scope confinement)", async () => {
    // A leaked dashboard cookie must not grant MCP tool access. The cookie
    // fallback is honored only on the /dashboard subtree; /mcp and /ingest
    // require a real Bearer token.
    const login = await request(app).post("/dashboard/login").send({ key: KEY });
    const cookie = login.headers["set-cookie"][0].split(";")[0];
    const ingest = await request(app)
      .post("/ingest")
      .set("Cookie", cookie)
      .send({ events: [{ id: "a", source: "s", content: "c" }] });
    expect(ingest.status).toBe(401);
    const mcp = await request(app)
      .post("/mcp")
      .set("Cookie", cookie)
      .send({ jsonrpc: "2.0", method: "tools/list", id: 1 });
    expect(mcp.status).toBe(401);
  });

  it("a bogus session cookie is still 401", async () => {
    const r = await request(app)
      .get("/dashboard/api/stats")
      .set("Cookie", "memoria_session=not-a-real-session");
    expect(r.status).toBe(401);
  });

  it("trims surrounding whitespace on the submitted key (terminal copy-paste)", async () => {
    // The secret is stored without a trailing newline, so terminal copies
    // routinely pick up a stray newline/space. Login must tolerate that.
    const r = await request(app)
      .post("/dashboard/login")
      .send({ key: `  ${KEY}\n` });
    expect(r.status).toBe(200);
    expect((r.headers["set-cookie"] || [])[0] || "").toContain("memoria_session=");
  });

  it("does NOT accept a key with non-whitespace text glued on (only trims)", async () => {
    const r = await request(app)
      .post("/dashboard/login")
      .send({ key: `${KEY}alex@cloudshell:~$` });
    expect(r.status).toBe(401);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });
});

describe("pinned public URL (C7)", () => {
  it("derives issuer from headers only when MEMORIA_PUBLIC_URL is unset (test env)", async () => {
    // In this suite MEMORIA_PUBLIC_URL is unset, so the metadata reflects the
    // request host — the localhost/dev fallback. The pinning behavior itself
    // is a one-line guard (PUBLIC_URL short-circuit) exercised in prod config.
    const r = await request(app)
      .get("/.well-known/oauth-authorization-server")
      .set("Host", "example.test");
    expect(r.status).toBe(200);
    expect(r.body.issuer).toContain("example.test");
  });
});

// ─── 2026-09 review: malformed input must be a 4xx, never a 500 ───

// The suites above already spend most of the 20/min auth rate-limit budget of
// the default client address. Each request below presents its own address
// (the app trusts one proxy hop), so these exercise the real limiter config
// without depending on test order.
let clientIp = 0;
describe("request hardening (2026-09 review, M4)", () => {
  it("POST /token with no body -> 400 unsupported_grant_type (was a 500)", async () => {
    const r = await request(app).post("/token").set("X-Forwarded-For", `198.51.100.${++clientIp}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unsupported_grant_type");
  });

  it("POST /token with a non-string code -> 400 invalid_request", async () => {
    const r = await request(app)
      .post("/token")
      .set("X-Forwarded-For", `198.51.100.${++clientIp}`)
      .send({
        grant_type: "authorization_code",
        code: { toString: 1 },
        code_verifier: "v",
        client_id: "memoria",
        client_secret: OAUTH_SECRET,
      });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_request");
  });

  it("a non-ASCII client_secret of the right character length -> 401 (was a RangeError 500)", async () => {
    // Same number of characters as the real secret, twice the bytes: the old
    // character-length guard let it through to timingSafeEqual, which threw.
    const r = await request(app)
      .post("/token")
      .set("X-Forwarded-For", `198.51.100.${++clientIp}`)
      .type("form")
      .send({
        grant_type: "client_credentials",
        client_id: "memoria",
        client_secret: "é".repeat(OAUTH_SECRET.length),
      });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("invalid_client");
  });

  it("a non-ASCII bearer token of the API key's character length -> 401 (was a RangeError 500)", async () => {
    const r = await request(app)
      .get("/dashboard/api/stats")
      .set("Authorization", `Bearer ${"é".repeat(KEY.length)}`);
    expect(r.status).toBe(401);
  });

  it("malformed JSON -> generic JSON 400, no stack trace", async () => {
    const r = await request(app)
      .post("/token")
      .set("X-Forwarded-For", `198.51.100.${++clientIp}`)
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Bad Request" });
    expect(r.text).not.toMatch(/at \w|node_modules|SyntaxError/);
  });

  it("GET /authorize with a repeated redirect_uri -> 400, not a 500", async () => {
    const r = await request(app)
      .get(
        "/authorize?redirect_uri=https://claude.ai/cb&redirect_uri=https://claude.ai/x" +
          "&code_challenge=abc&code_challenge_method=S256",
      )
      .set("X-Forwarded-For", `198.51.100.${++clientIp}`)
      .redirects(0);
    expect(r.status).toBe(400);
  });

  it("GET /authorize rejects a non-http(s) scheme on a localhost redirect (L4)", async () => {
    const r = await request(app)
      .get("/authorize")
      .set("X-Forwarded-For", `198.51.100.${++clientIp}`)
      .query({
        redirect_uri: "javascript://localhost/%0Aalert(1)",
        code_challenge: "abc",
        code_challenge_method: "S256",
      });
    expect(r.status).toBe(400);
  });
});

describe("token store at rest (2026-09 review, L5/L6)", () => {
  const TOKEN_DB = path.join(ROOT, "tok", "tokens.sqlite");

  it("stores a SHA-256 hash of an issued token, never the token", async () => {
    const r = await request(app)
      .post("/token")
      .set("X-Forwarded-For", `198.51.100.${++clientIp}`)
      .type("form")
      .send({
        grant_type: "client_credentials",
        client_id: "memoria",
        client_secret: OAUTH_SECRET,
      });
    expect(r.status).toBe(200);
    const token: string = r.body.access_token;

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(TOKEN_DB, { readonly: true });
    try {
      const rows = db.prepare("SELECT token FROM tokens").all() as { token: string }[];
      const stored = rows.map((row) => row.token);
      expect(stored).not.toContain(token);
      expect(stored).toContain(createHash("sha256").update(token).digest("hex"));
    } finally {
      db.close();
    }

    // And the token still authenticates: lookups hash the presented value.
    const gated = await request(app)
      .get("/dashboard/api/stats")
      .set("Authorization", `Bearer ${token}`);
    expect(gated.status).toBe(200);
  });

  it.skipIf(process.platform === "win32")("creates tokens.sqlite owner-only (0600)", () => {
    expect(fs.statSync(TOKEN_DB).mode & 0o777).toBe(0o600);
  });
});

describe("entry-point detection (2026-09 review, H1)", () => {
  // A directory junction (Windows) / directory symlink (POSIX) reproduces what
  // `npm install -g` does on Linux and macOS: the bin is a symlink, so
  // process.argv[1] is not the real path of the module Node loaded.
  const DIST = path.resolve(__dirname, "..", "..", "dist");
  const LINK = path.join(ROOT, "linked-dist");
  const haveDist = fs.existsSync(path.join(DIST, "http.js"));

  beforeAll(() => {
    if (haveDist) fs.symlinkSync(DIST, LINK, "junction");
  });

  it("isEntryPoint matches through a symlinked path", async () => {
    const { isEntryPoint } = await import("../http.js");
    const real = path.join(ROOT, "real-entry.js");
    fs.writeFileSync(real, "");
    const linkDir = path.join(ROOT, "entry-link");
    fs.symlinkSync(ROOT, linkDir, "junction");
    const moduleUrl = pathToFileURL(real).href;

    expect(isEntryPoint(real, moduleUrl)).toBe(true);
    expect(isEntryPoint(path.join(linkDir, "real-entry.js"), moduleUrl)).toBe(true);
    expect(isEntryPoint(path.join(ROOT, "other.js"), moduleUrl)).toBe(false);
    expect(isEntryPoint(undefined, moduleUrl)).toBe(false);
  });

  it.skipIf(!haveDist)(
    "the built server starts when launched through a symlinked path",
    async () => {
      const store = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-entry-"));
      const child = spawn(process.execPath, [path.join(LINK, "http.js")], {
        env: {
          ...process.env,
          MEMORIA_API_KEY: KEY,
          MEMORIA_OAUTH_CLIENT_SECRET: OAUTH_SECRET,
          MEMORIA_DIR: store,
          MEMORIA_EMBEDDINGS: "hash",
          MEMORIA_TOKEN_DB_DIR: path.join(store, "tok"),
          PORT: "0",
          BIND_ALL: "",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));

      try {
        // Before the fix the process loaded, never called main(), and exited 0.
        const outcome = await Promise.race([
          new Promise<string>((resolve) => {
            const poll = setInterval(() => {
              if (stderr.includes("listening")) {
                clearInterval(poll);
                resolve("listening");
              }
            }, 50);
            exited.then(() => {
              clearInterval(poll);
              resolve("exited");
            });
          }),
          new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 20_000)),
        ]);
        expect(outcome, stderr).toBe("listening");

        // SIGTERM runs the graceful shutdown (M5). Windows has no signals —
        // kill() there is TerminateProcess — so only POSIX can assert on it.
        if (process.platform !== "win32") {
          child.kill("SIGTERM");
          expect(await exited).toBe(0);
          expect(stderr).toContain("SIGTERM received");
        }
      } finally {
        child.kill();
        await exited;
        fs.rmSync(store, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("/ingest timestamps (2026-09 re-review)", () => {
  it("writes events with unparsable or absurd timestamps, labelled at ingest time", async () => {
    const r = await request(app)
      .post("/ingest")
      .set(auth)
      .send({
        events: [
          {
            id: "bad-ts-1",
            source: "http-test",
            content: "An ingested event whose timestamp is day-first and unparsable by JS.",
            timestamp: "24/09/2026",
          },
          {
            id: "far-ts-1",
            source: "http-test",
            content: "A second event, sent with epoch microseconds where milliseconds belong.",
            timestamp: 1727186400000000,
          },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body.failed).toBe(0);
    expect(r.body.written).toBe(2);
    const today = new Date().toISOString().slice(0, 10);
    const log = fs.readFileSync(path.join(ROOT, "memories", "daily", `${today}.md`), "utf-8");
    expect(log.match(/## \d{2}:\d{2} UTC — http-test/g)).toHaveLength(2);
  });
});

describe("sanitizeIngestMeta (review M6)", () => {
  it("strips control characters and drops nested values", async () => {
    const { sanitizeIngestMeta } = await import("../http.js");
    const out = sanitizeIngestMeta({
      from: "mallory\n## 09:00 — forged",
      nested: { a: 1 },
      list: [1],
      count: 3,
      ok: true,
    });
    expect(out.from).not.toContain("\n");
    expect(out.nested).toBeUndefined();
    expect(out.list).toBeUndefined();
    expect(out.count).toBe(3);
    expect(out.ok).toBe(true);
    expect(sanitizeIngestMeta(null)).toEqual({});
    expect(sanitizeIngestMeta("x")).toEqual({});
  });

  it("/authorize refuses without approval when MEMORIA_AUTHORIZE_REQUIRE_APPROVAL=true (M5)", async () => {
    process.env.MEMORIA_AUTHORIZE_REQUIRE_APPROVAL = "true";
    const q = {
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "st-1",
    };
    try {
      const r = await request(app).get("/authorize").query(q);
      expect(r.status).toBe(401);
      // The API key approves programmatically.
      const ok = await request(app).get("/authorize").set(auth).query(q);
      expect(ok.status).toBe(302);
      // A dashboard login is NOT approval by itself: browsers send the Lax
      // cookie on any cross-site navigation, so a page could otherwise
      // trigger a code without the operator. It gets a consent page.
      expect(approveCookie).toMatch(/^memoria_approve=/);
      const page = await request(app)
        .get("/authorize")
        .set("Cookie", approveCookie)
        .set("X-Forwarded-For", "10.9.8.7")
        .query(q);
      expect(page.status).toBe(200);
      expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(page.text).toContain("https://claude.ai");
      const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(page.text)![1];

      const approve = (over: Record<string, string>, headers: Record<string, string> = {}) =>
        request(app)
          .post("/authorize")
          .set("Cookie", approveCookie)
          .set("X-Forwarded-For", "10.9.8.3")
          .set(headers)
          .type("form")
          .send({ ...q, csrf, ...over });

      // The page must not make browsers send `Origin: null` on its POST.
      expect(page.headers["referrer-policy"]).toBe("same-origin");
      // Cross-origin, missing or mismatched token, or tampered parameters fail.
      expect((await approve({}, { Origin: "https://evil.example" })).status).toBe(403);
      expect((await approve({ csrf: "" })).status).toBe(403);
      expect((await approve({ redirect_uri: "https://claude.ai/other" })).status).toBe(403);
      expect((await approve({ state: "attacker-state" })).status).toBe(403);
      const noCookie = await request(app)
        .post("/authorize")
        .set("X-Forwarded-For", "10.9.8.2")
        .type("form")
        .send({ ...q, csrf });
      expect(noCookie.status).toBe(403);

      // The operator's click issues the code. Its Origin is the host the
      // browser used, which need not be the configured public URL.
      const done = await approve(
        {},
        { Host: "memoria.example:8443", Origin: "http://memoria.example:8443" },
      );
      expect(done.status).toBe(303);
      const loc = new URL(done.headers.location);
      expect(loc.origin + loc.pathname).toBe(q.redirect_uri);
      expect(loc.searchParams.get("code")).toBeTruthy();
      expect(loc.searchParams.get("state")).toBe("st-1");

      // ...and the approve cookie must NOT authorize /mcp.
      const mcp = await request(app)
        .post("/mcp")
        .set("Cookie", approveCookie)
        .send({ jsonrpc: "2.0", method: "tools/list", id: 1 });
      expect(mcp.status).toBe(401);
      // ...nor the dashboard API: each cookie is honoured on its own path.
      const dash = await request(app).get("/dashboard/api/stats").set("Cookie", approveCookie);
      expect(dash.status).toBe(401);
    } finally {
      delete process.env.MEMORIA_AUTHORIZE_REQUIRE_APPROVAL;
    }
  });

  it("rejects a malformed PKCE challenge before storing anything", async () => {
    const r = await request(app)
      .get("/authorize")
      .set("X-Forwarded-For", "10.9.8.1")
      .query({
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_challenge: "x".repeat(10_000),
        code_challenge_method: "S256",
      });
    expect(r.status).toBe(400);
  });

  it("an OAuth token cannot change source consent or settings on the dashboard API", async () => {
    const tok = await request(app)
      .post("/token")
      .set("X-Forwarded-For", "10.9.7.1")
      .type("form")
      .send({
        grant_type: "client_credentials",
        client_id: "memoria",
        client_secret: OAUTH_SECRET,
      });
    const bearer = { Authorization: `Bearer ${tok.body.access_token}` };
    // Reading still works with the token...
    expect((await request(app).get("/dashboard/api/stats").set(bearer)).status).toBe(200);
    // ...but consent and credentials are the operator's.
    const agree = await request(app).post("/dashboard/api/sources/email/agree").set(bearer);
    expect(agree.status).toBe(403);
    const cfg = await request(app)
      .post("/dashboard/api/sources/email/configure")
      .set(bearer)
      .send({ host: "attacker.example", secure: false });
    expect(cfg.status).toBe(403);
  });

  it("the approval gate also closes client_credentials, and stops advertising it", async () => {
    // Without this the gate was decorative: the client secret alone minted a
    // token through the other grant type.
    process.env.MEMORIA_AUTHORIZE_REQUIRE_APPROVAL = "true";
    try {
      const r = await request(app)
        .post("/token")
        .set("X-Forwarded-For", "10.9.8.6")
        .type("form")
        .send({
          grant_type: "client_credentials",
          client_id: "memoria",
          client_secret: OAUTH_SECRET,
        });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("unauthorized_client");
      expect(r.body.access_token).toBeUndefined();
      const meta = await request(app).get("/.well-known/oauth-authorization-server");
      expect(meta.body.grant_types_supported).toEqual(["authorization_code"]);
      const reg = await request(app).post("/register").set("X-Forwarded-For", "10.9.8.4").send({});
      expect(reg.status).toBe(201);
      expect(reg.body.grant_types).toEqual(["authorization_code"]);
    } finally {
      delete process.env.MEMORIA_AUTHORIZE_REQUIRE_APPROVAL;
    }
    const meta = await request(app).get("/.well-known/oauth-authorization-server");
    expect(meta.body.grant_types_supported).toContain("client_credentials");
  });

  it("the approval cookie is SameSite=Lax so a cross-site OAuth navigation carries it", async () => {
    // Browsers withhold SameSite=Strict cookies on the top-level navigation
    // from claude.ai to /authorize, so a Strict approve cookie could never
    // satisfy the gate in a real flow. The dashboard cookie stays Strict.
    const login = await request(app)
      .post("/dashboard/login")
      .set("X-Forwarded-For", "10.9.8.5")
      .send({ key: KEY });
    const cookies = login.headers["set-cookie"] as unknown as string[];
    const approve = cookies.find((c) => c.startsWith("memoria_approve="))!;
    const session = cookies.find((c) => c.startsWith("memoria_session="))!;
    expect(approve).toContain("SameSite=Lax");
    expect(approve).toContain("Path=/authorize");
    expect(approve).toContain("HttpOnly");
    expect(session).toContain("SameSite=Strict");
  });
});

describe("normalizeTimestamp (2026-09 re-review, round 4)", () => {
  it("keeps a usable timestamp and replaces the rest with now", async () => {
    const { normalizeTimestamp } = await import("../http.js");
    const now = new Date("2026-09-24T12:00:00Z");
    expect(normalizeTimestamp("2026-09-24T14:05:00+02:00", now)).toBe("2026-09-24T12:05:00.000Z");
    expect(normalizeTimestamp(Date.UTC(2026, 0, 2), now)).toBe("2026-01-02T00:00:00.000Z");
    for (const bad of ["24/09/2026", 1727186400000000, {}, [], null, undefined, true]) {
      expect(normalizeTimestamp(bad, now), String(bad)).toBe(now.toISOString());
    }
  });
});

describe("Streamable HTTP sessions and body parsing (review 2026-10)", () => {
  const init = (ip: string) =>
    request(app)
      .post("/mcp")
      .set(auth)
      .set("X-Forwarded-For", ip)
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      });

  it("an unknown or expired session is 404 (the client's cue to re-initialize)", async () => {
    const h = { ...auth, "mcp-session-id": "no-such-session" };
    const post = await request(app)
      .post("/mcp")
      .set(h)
      .set("X-Forwarded-For", "10.8.0.1")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(post.status).toBe(404);
    expect((await request(app).get("/mcp").set(h).set("X-Forwarded-For", "10.8.0.1")).status).toBe(
      404,
    );
    expect(
      (await request(app).delete("/mcp").set(h).set("X-Forwarded-For", "10.8.0.1")).status,
    ).toBe(404);
    // No session id and not an initialize request is still a bad request.
    const bare = await request(app)
      .post("/mcp")
      .set(auth)
      .set("X-Forwarded-For", "10.8.0.1")
      .send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(bare.status).toBe(400);
  });

  it("at the session cap the idlest session is closed instead of refusing everyone", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) {
      const r = await init(`10.8.1.${i}`);
      expect(r.status).toBe(200);
      ids.push(r.headers["mcp-session-id"]);
    }
    // The first session was the idlest; it was closed to make room.
    const first = await request(app)
      .post("/mcp")
      .set({ ...auth, "mcp-session-id": ids[0] })
      .set("X-Forwarded-For", "10.8.2.1")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(first.status).toBe(404);
    for (const id of ids.slice(1)) {
      await request(app)
        .delete("/mcp")
        .set({ ...auth, "mcp-session-id": id })
        .set("X-Forwarded-For", "10.8.2.2");
    }
  });

  it("does not parse a large body before authentication", async () => {
    // 2MB of JSON: rejected by auth (401), not parsed (413/400) first.
    const big = JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) });
    for (const route of ["/mcp", "/ingest", "/dashboard/api/stats"]) {
      const r = await request(app)
        .post(route)
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", "10.8.3.1")
        .send(big);
      expect(r.status).toBe(401);
    }
    // Unauthenticated routes only take small bodies.
    const reg = await request(app)
      .post("/register")
      .set("Content-Type", "application/json")
      .set("X-Forwarded-For", "10.8.3.2")
      .send(JSON.stringify({ pad: "x".repeat(100 * 1024) }));
    expect(reg.status).toBe(413);
  });

  it("an authenticated /ingest still takes a multi-megabyte batch", async () => {
    const events = Array.from({ length: 30 }, (_, i) => ({
      id: `big-${i}`,
      source: "bulk-test",
      content: `Event ${i} ` + "y".repeat(100 * 1024),
    }));
    const r = await request(app)
      .post("/ingest")
      .set(auth)
      .set("X-Forwarded-For", "10.8.3.3")
      .send({ events });
    expect(r.status).not.toBe(413);
  });
});

describe("sessions re-review (2026-10)", () => {
  it("a session id like __proto__ is an unknown session (404), not a 500", async () => {
    for (const id of ["__proto__", "constructor", "toString"]) {
      const r = await request(app)
        .post("/mcp")
        .set({ ...auth, "mcp-session-id": id })
        .set("X-Forwarded-For", "10.7.0.1")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(r.status).toBe(404);
    }
    expect(({} as Record<string, unknown>).lastActivity).toBeUndefined();
  });

  it("an initialize the SDK rejects does not evict a live session", async () => {
    const init = (ip: string, accept = "application/json, text/event-stream") =>
      request(app)
        .post("/mcp")
        .set(auth)
        .set("X-Forwarded-For", ip)
        .set("Accept", accept)
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "t", version: "1" },
          },
        });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await init(`10.7.1.${i}`)).headers["mcp-session-id"]);
    const rejected = await init("10.7.2.1", "text/plain"); // the SDK answers 406
    expect(rejected.status).toBe(406);
    const first = await request(app)
      .delete("/mcp")
      .set({ ...auth, "mcp-session-id": ids[0] })
      .set("X-Forwarded-For", "10.7.2.2");
    expect(first.status).not.toBe(404); // still alive
    for (const id of ids.slice(1)) {
      await request(app)
        .delete("/mcp")
        .set({ ...auth, "mcp-session-id": id })
        .set("X-Forwarded-For", "10.7.2.3");
    }
  });
});
