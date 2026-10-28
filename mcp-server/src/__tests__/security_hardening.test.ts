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

  it("respects a fresh lock from another host, reclaims a stale one", async () => {
    const { acquireStoreLock } = await import("../store-lock.js");
    const db = path.join(ROOT, "data", "foreign.sqlite");
    const lock = path.join(ROOT, "data", ".foreign.sqlite.lock");
    // process.ppid is alive here, but on the other host it means nothing:
    // only the heartbeat (mtime) can say whether that holder is running.
    fs.writeFileSync(lock, `${process.ppid}\nsome-other-host`);
    expect(() => acquireStoreLock(db, { foreignWaitMs: 0 })).toThrow(/already in use/);
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lock, old, old);
    const release = acquireStoreLock(db, { foreignWaitMs: 0 });
    expect(fs.readFileSync(lock, "utf-8")).toMatch(
      new RegExp(`^${process.pid}\\n${os.hostname()}\\n\\d+$`),
    );
    release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("MEMORIA_LOCK_TAKEOVER takes a fresh foreign lock (Cloud Run rollouts)", async () => {
    const { acquireStoreLock } = await import("../store-lock.js");
    const db = path.join(ROOT, "data", "takeover.sqlite");
    const lock = path.join(ROOT, "data", ".takeover.sqlite.lock");
    fs.writeFileSync(lock, `${process.ppid}\nold-revision`);
    process.env.MEMORIA_LOCK_TAKEOVER = "true";
    try {
      const release = acquireStoreLock(db, { foreignWaitMs: 0 });
      release();
    } finally {
      delete process.env.MEMORIA_LOCK_TAKEOVER;
    }
  });

  it("release never deletes a successor's lock, even one with the same pid", async () => {
    // A rollout or recreated container: both node processes are often pid 7.
    const { acquireStoreLock } = await import("../store-lock.js");
    const db = path.join(ROOT, "data", "successor.sqlite");
    const lock = path.join(ROOT, "data", ".successor.sqlite.lock");
    const release = acquireStoreLock(db);
    fs.writeFileSync(lock, `${process.pid}\ncontainer-b`); // taken over
    release();
    expect(fs.readFileSync(lock, "utf-8")).toBe(`${process.pid}\ncontainer-b`);
    fs.rmSync(lock);
  });

  it("a live local holder is judged by its start time, never by a missed heartbeat", async () => {
    // A holder paused by SIGSTOP or a laptop's sleep misses beats while
    // still running; taking its lock would put two writers on one store.
    const { acquireStoreLock } = await import("../store-lock.js");
    const db = path.join(ROOT, "data", "reused.sqlite");
    const lock = path.join(ROOT, "data", ".reused.sqlite.lock");
    const old = new Date(Date.now() - 5 * 60_000);
    // No start time recorded (or not Linux): a live pid is the holder.
    fs.writeFileSync(lock, `${process.ppid}\n${os.hostname()}`);
    fs.utimesSync(lock, old, old);
    expect(() => acquireStoreLock(db)).toThrow(/already in use/);
    if (process.platform === "linux") {
      // A start time that does not match the live process: a reused pid.
      fs.writeFileSync(lock, `${process.ppid}\n${os.hostname()}\n1000`);
      fs.utimesSync(lock, old, old);
      acquireStoreLock(db)();
      // Our own lock records our real start time, so it would be honoured.
      const release = acquireStoreLock(db);
      const [, , start] = fs.readFileSync(lock, "utf-8").split("\n");
      expect(Math.abs(Number(start) - (Date.now() - process.uptime() * 1000))).toBeLessThan(2_000);
      release();
    } else {
      fs.rmSync(lock);
    }
  });

  it("two spellings of one directory are one lock", async () => {
    const { acquireStoreLock } = await import("../store-lock.js");
    const db = path.join(ROOT, "data", "spelling.sqlite");
    const release = acquireStoreLock(db);
    try {
      const alias = path.join(ROOT, "data-alias");
      try {
        fs.symlinkSync(path.join(ROOT, "data"), alias, "dir");
      } catch {
        return; // platform cannot symlink: nothing to test
      }
      expect(() => acquireStoreLock(path.join(alias, "spelling.sqlite"))).toThrow(/already in use/);
    } finally {
      release();
    }
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

describe("shared stores: concurrent sessions (review 2026-10)", () => {
  it("a second shared open runs as a secondary, and takes over when the primary closes", async () => {
    const { MemoryStore } = await import("../store.js");
    const { chunkMarkdown } = await import("../chunker.js");
    const db = path.join(ROOT, "data", "shared.sqlite");
    const first = new MemoryStore(db, { shared: true });
    const second = new MemoryStore(db, { shared: true });
    try {
      expect(first.isPrimary).toBe(true);
      expect(second.isPrimary).toBe(false);
      // Both read and write the one index.
      const c = "---\nname: s\n---\nzebra launch window decided";
      await second.indexChunks(chunkMarkdown(c, "s.md"), 5, c);
      expect((await first.search("zebra launch window", 1))[0].file).toBe("s.md");
      expect(second.tryBecomePrimary()).toBe(false);
      first.close();
      expect(second.tryBecomePrimary()).toBe(true);
      expect(second.isPrimary).toBe(true);
    } finally {
      second.close();
    }
  });

  it("without `shared` a second open still fails (tools and tests that must be alone)", async () => {
    const { MemoryStore } = await import("../store.js");
    const db = path.join(ROOT, "data", "exclusive.sqlite");
    const first = new MemoryStore(db);
    try {
      expect(() => new MemoryStore(db)).toThrow(/already in use/);
    } finally {
      first.close();
    }
  });
});
