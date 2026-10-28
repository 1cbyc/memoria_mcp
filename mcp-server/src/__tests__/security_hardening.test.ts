/**
 * Regression tests for the 2026-10 whole-repo review fixes (H1-H4, M1-M6,
 * L1-L5). Each test names the finding it pins.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { z } from "zod";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-hardening-"));
process.env.MEMORIA_DIR = ROOT;

type Handler = (
  args: Record<string, unknown>,
) => Promise<{ content: Array<{ type: string; text: string }> }>;
const handlers = new Map<string, Handler>();
const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
let store: any;

function capture(name: string, _d: string, schema: unknown, handler: Handler) {
  handlers.set(name, handler);
  schemas.set(name, schema as Record<string, z.ZodTypeAny>);
}
function parseOk(tool: string, args: Record<string, unknown>): boolean {
  return z.object(schemas.get(tool)!).safeParse(args).success;
}
function text(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

beforeAll(async () => {
  fs.mkdirSync(path.join(ROOT, "memories", "daily"), { recursive: true });
  const tools = await import("../tools.js");
  const { MemoryStore } = await import("../store.js");
  store = new MemoryStore(path.join(ROOT, "data", "hardening.sqlite"));
  const fakeServer = { tool: capture };
  tools.registerTools(fakeServer as any, store);
  tools.registerCollectorTools(fakeServer as any, store);
});

afterAll(() => {
  try {
    store?.close();
  } catch {}
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

describe("H1: consent is not grantable through MCP", () => {
  it("memory_sources no longer accepts the agree action", () => {
    expect(parseOk("memory_sources", { action: "agree", source: "email" })).toBe(false);
    expect(parseOk("memory_sources", { action: "list" })).toBe(true);
  });
});

describe("H2/L1: tool inputs are bounded at the schema", () => {
  it("rejects unbounded reflect/compact/ingest/search/compile inputs", () => {
    expect(parseOk("memory_reflect", { days: 100000 })).toBe(false);
    expect(parseOk("memory_reflect", { days: 7 })).toBe(true);
    expect(parseOk("memory_compact", { days: 100000 })).toBe(false);
    expect(parseOk("memory_compact", { max_chars: 100000000 })).toBe(false);
    expect(parseOk("memory_ingest", { batch_size: 100000000 })).toBe(false);
    expect(parseOk("memory_ingest", { batch_size: 50 })).toBe(true);
    expect(parseOk("memory_search", { query: "x".repeat(3000) })).toBe(false);
    expect(parseOk("memory_fuse", { hours: 10000 })).toBe(false);
    expect(parseOk("memory_fuse", { window_minutes: 100000 })).toBe(false);
    expect(parseOk("memory_fuse", { hours: 24, window_minutes: 30 })).toBe(true);
    expect(
      parseOk("memory_compile", {
        content: "c",
        name: "n",
        type: "project",
        tags: Array.from({ length: 51 }, (_, i) => `t${i}`),
      }),
    ).toBe(false);
  });

  it("memory_compile's 100KB cap measures bytes, not characters (L1)", async () => {
    const r = await handlers.get("memory_compile")!({
      content: "é".repeat(60000), // 60000 chars, 120000 bytes
      name: "Bytes",
      type: "project",
      tags: [],
    });
    expect(text(r)).toContain("exceeds 100KB");
  });
});

describe("H4: a remote embedding provider requires explicit opt-in", () => {
  it("OPENAI_API_KEY alone never selects OpenAI", async () => {
    const { selectProvider } = await import("../embeddings.js");
    expect(selectProvider("auto", true, true)).toBe("minilm");
    expect(selectProvider("auto", true, false)).toBe("local");
    expect(selectProvider(undefined, true, false)).toBe("local");
    expect(selectProvider("openai", true, false)).toBe("openai");
    expect(selectProvider("hash", true, true)).toBe("local");
  });
});

describe("H3: one process per store directory", () => {
  it("a second MemoryStore on the same file fails, and succeeds after close", async () => {
    const { MemoryStore } = await import("../store.js");
    const db = path.join(ROOT, "data", "lock-test.sqlite");
    const first = new MemoryStore(db);
    try {
      expect(() => new MemoryStore(db)).toThrow(/already in use/);
    } finally {
      first.close();
    }
    const second = new MemoryStore(db);
    second.close();
  });

  it("reclaims a lock left by a dead pid, but not a live one", async () => {
    const { MemoryStore } = await import("../store.js");
    const db = path.join(ROOT, "data", "stale-test.sqlite");
    const lock = path.join(ROOT, "data", ".stale-test.sqlite.lock");
    fs.writeFileSync(lock, "999999"); // no such process -> ESRCH -> stale
    const s = new MemoryStore(db);
    s.close();
    // A lock naming another live local process must block, never be reclaimed.
    fs.writeFileSync(lock, `${process.ppid}\n${os.hostname()}`);
    expect(() => new MemoryStore(db)).toThrow(/already in use/);
    fs.rmSync(lock, { force: true });
  });

  it("reclaims a leftover lock that names this pid but is not held (container restart)", async () => {
    // A restarted container usually gives node the same pid as the crashed
    // process. Its lock then named a live process (us), and the server
    // refused to start forever.
    const { MemoryStore } = await import("../store.js");
    const db = path.join(ROOT, "data", "pid-reuse.sqlite");
    const lock = path.join(ROOT, "data", ".pid-reuse.sqlite.lock");
    for (const contents of [String(process.pid), `${process.pid}\n${os.hostname()}`]) {
      fs.writeFileSync(lock, contents);
      const s = new MemoryStore(db);
      // ...while a lock this process actually holds still blocks a second open.
      expect(() => new MemoryStore(db)).toThrow(/already in use/);
      s.close();
      expect(fs.existsSync(lock)).toBe(false);
    }
  });

  it("does not check a lock written on another host against local pids", async () => {
    const { MemoryStore } = await import("../store.js");
    const db = path.join(ROOT, "data", "foreign.sqlite");
    const lock = path.join(ROOT, "data", ".foreign.sqlite.lock");
    // process.ppid is alive here, but on the other host it means nothing.
    fs.writeFileSync(lock, `${process.ppid}\nsome-other-host`);
    const s = new MemoryStore(db);
    expect(fs.readFileSync(lock, "utf-8")).toBe(`${process.pid}\n${os.hostname()}`);
    s.close();
  });
});

describe("M4: adapter installs are pinned", () => {
  it("known adapters resolve to exact versions, unknown names are refused", async () => {
    const { pinnedInstallSpec, installDependencies } = await import("../collector/deps.js");
    expect(pinnedInstallSpec("imapflow")).toBe("imapflow@2.4.0");
    expect(pinnedInstallSpec("googleapis")).toBe("googleapis@185.0.0");
    expect(pinnedInstallSpec("some-unpinned-package")).toBeNull();
    const r = await installDependencies(["some-unpinned-package"]);
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/unpinned/);
  });
});

describe("M1: provenance archive stores no plaintext content", () => {
  it("send-tier content is encrypted on disk but round-trips on read", async () => {
    const prov = await import("../collector/provenance.js");
    const dataDir = path.join(ROOT, "prov-data");
    const secret = "plaintext-provenance-body-12345";
    prov.appendRawArchive(
      dataDir,
      {
        id: "evt-enc",
        source: "test-src",
        eventType: "agent_result",
        content: secret,
        timestamp: "2026-06-15T12:00:00Z",
        meta: {},
        importanceEstimate: 5,
        privacyTier: "send",
      } as any,
      secret,
    );
    prov.flushRawArchive();
    const file = fs.readFileSync(
      path.join(prov.rawArchiveDir(dataDir), "test-src", "2026-06.jsonl"),
      "utf-8",
    );
    expect(file).not.toContain(secret);
    const recs = prov.readRawArchive(dataDir, "test-src");
    expect(recs.find((r) => r.id === "evt-enc")?.content).toBe(secret);
  });
});
