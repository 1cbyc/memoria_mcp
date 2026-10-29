import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { IngestionPipeline } from "../collector/ingestion.js";
import type { RawEvent } from "../collector/adapters/base.js";

let root: string; // temp Memoria root
let memoriesDir: string;

function ev(over: Partial<RawEvent> = {}): RawEvent {
  return {
    id: over.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    source: over.source ?? "orchestrator-test",
    eventType: over.eventType ?? "agent_result",
    content: over.content ?? "A reasonably detailed event body well over twenty characters long.",
    timestamp: over.timestamp ?? new Date().toISOString(),
    meta: over.meta ?? {},
    importanceEstimate: over.importanceEstimate ?? 5,
    privacyTier: over.privacyTier ?? "send",
  };
}

function todayDailyPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(memoriesDir, "daily", `${today}.md`);
}

beforeEach(() => {
  // Pin the clock so the test's `today` and the pipeline's internally-computed
  // daily-log date can never disagree across a UTC midnight boundary.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-ingest-"));
  memoriesDir = path.join(root, "memories");
  fs.mkdirSync(memoriesDir, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
});

describe("IngestionPipeline — H1: never writes into core memories", () => {
  it("does not modify a curated core file even on a moderate similarity match", async () => {
    // A curated core memory exists.
    const coreDir = path.join(memoriesDir, "references");
    fs.mkdirSync(coreDir, { recursive: true });
    const corePath = path.join(coreDir, "curated.md");
    const original = "---\nname: Curated\nimportance: 8\n---\n\nHand-written knowledge.";
    fs.writeFileSync(corePath, original, "utf-8");

    // searchMemories reports a MODERATE match (0.7) to that core file —
    // the old code would have appended an "### Update" block to it.
    const pipeline = new IngestionPipeline({
      memoriesDir,
      searchMemories: async () => [
        { file: "references/curated.md", content: "Hand-written knowledge.", score: 0.7 },
      ],
    });

    const result = await pipeline.ingest([
      ev({ content: "Some automated collector event body that is long enough." }),
    ]);

    // The event is written (to the daily log), and the core file is untouched.
    expect(result.written).toBe(1);
    expect(fs.readFileSync(corePath, "utf-8")).toBe(original);
    expect(fs.existsSync(todayDailyPath())).toBe(true);
  });

  it("reports the distinct sources it wrote (P2 propagation hint)", async () => {
    const pipeline = new IngestionPipeline({ memoriesDir });
    const result = await pipeline.ingest([
      ev({ source: "agent-alpha", content: "First detailed event body, well over twenty chars." }),
      ev({
        source: "agent-alpha",
        content: "Second detailed event body, distinct from the first.",
      }),
      ev({ source: "agent-beta", content: "A beta event body that is also nice and long here." }),
    ]);
    expect(result.written).toBe(3);
    expect([...result.writtenSources].sort()).toEqual(["agent-alpha", "agent-beta"]);
  });

  it("skips an event that is near-identical to an existing memory", async () => {
    const pipeline = new IngestionPipeline({
      memoriesDir,
      searchMemories: async () => [{ file: "daily/2026-01-01.md", content: "dup", score: 0.95 }],
    });
    const result = await pipeline.ingest([ev()]);
    expect(result.written).toBe(0);
    expect(result.deduplicated).toBe(1);
  });
});

describe("IngestionPipeline — M1: dedup survives restart", () => {
  it("deduplicates identical content across pipeline instances", async () => {
    const sharedContent = "Hourly health check: all systems nominal, nothing to report here.";

    const a = new IngestionPipeline({ memoriesDir });
    const r1 = await a.ingest([ev({ id: "a", content: sharedContent })]);
    expect(r1.written).toBe(1);

    // New instance == simulated restart. The persisted sidecar should make
    // the identical content (different event id) dedupe.
    const b = new IngestionPipeline({ memoriesDir });
    const r2 = await b.ingest([ev({ id: "b", content: sharedContent })]);
    expect(r2.written).toBe(0);
    expect(r2.deduplicated).toBe(1);
  });
});

describe("IngestionPipeline — M3: daily-log importance only bumps for high-signal", () => {
  it("keeps importance at 5 for routine events but raises it for >=7 events", async () => {
    const pipeline = new IngestionPipeline({ memoriesDir });

    // Routine event (rescores to ~5-6) should not push the file above 5.
    await pipeline.ingest([ev({ id: "r1", importanceEstimate: 5 })]);
    let fm = fs.readFileSync(todayDailyPath(), "utf-8");
    expect(fm).toMatch(/^importance: 5$/m);

    // High-signal event (>=7) bumps the file.
    await pipeline.ingest([
      ev({
        id: "h1",
        importanceEstimate: 9,
        content: "Critical: production outage decision recorded here.",
      }),
    ]);
    fm = fs.readFileSync(todayDailyPath(), "utf-8");
    expect(fm).toMatch(/^importance: 9$/m);
  });
});

describe("IngestionPipeline — H-05: concurrent ingest() calls cannot both write", () => {
  it("writes an identical event once when two ingest() calls overlap", async () => {
    const sharedContent = "Concurrent health check body that must be written exactly once.";
    const pipeline = new IngestionPipeline({
      memoriesDir,
      // Async search is the window where the second call used to check the
      // dedup map before the first call recorded the hash.
      searchMemories: async () => {
        await Promise.resolve();
        return [];
      },
    });
    const event = ev({ id: "conc-1", content: sharedContent });
    const [r1, r2] = await Promise.all([
      pipeline.ingest([event]),
      pipeline.ingest([{ ...event, id: "conc-2" }]),
    ]);
    expect(r1.written + r2.written).toBe(1);
    expect(r1.deduplicated + r2.deduplicated).toBe(1);
    const daily = fs.readFileSync(todayDailyPath(), "utf-8");
    expect(daily.split(sharedContent).length - 1).toBe(1);
  });
});

describe("IngestionPipeline — an unparsable timestamp (2026-09 re-review)", () => {
  it("still writes the event, labelled with the ingest time", async () => {
    // utcTimeLabel threw on an Invalid Date, so the event failed every ingest
    // attempt and was dead-lettered while /ingest reported it accepted.
    const pipeline = new IngestionPipeline({ memoriesDir });
    const r = await pipeline.ingest([
      ev({
        id: "bad-ts",
        timestamp: "24/09/2026",
        content: "Event with a day-first timestamp that JS cannot parse.",
      }),
    ]);
    expect(r.errors).toEqual([]);
    expect(r.written).toBe(1);
    expect(fs.readFileSync(todayDailyPath(), "utf-8")).toContain("## 12:00 UTC");
  });
});

describe("IngestionPipeline — the dedup search never sees unredacted content (review 2026-10)", () => {
  // The similarity search embeds its query, which leaves the device under
  // MEMORIA_EMBEDDINGS=openai. It must only ever see what the write path
  // would persist.
  it("skips the similarity search for local-only events, by tier or by content", async () => {
    const queries: string[] = [];
    const pipeline = new IngestionPipeline({
      memoriesDir,
      searchMemories: async (q: string) => {
        queries.push(q);
        return [];
      },
    });
    const result = await pipeline.ingest([
      ev({
        content: "Dentist appointment, bring the insurance card please.",
        privacyTier: "local-only",
      }),
      // Mislabelled "send", but the content reclassifies as local-only.
      ev({ content: "Wire transfer: routing number 021000021, account 12345678." }),
    ]);
    expect(result.written).toBe(2);
    expect(queries).toEqual([]);
    const log = fs.readFileSync(todayDailyPath(), "utf-8");
    expect(log).not.toContain("021000021");
    expect(log).not.toContain("Dentist");
  });

  it("distinct local-only events are all written, not deduped against each other's placeholder", async () => {
    // Every local-only event is redacted to the same placeholder; if the
    // search ran on it, the second would "match" the first and be skipped.
    const pipeline = new IngestionPipeline({
      memoriesDir,
      searchMemories: async () => [{ file: "daily/x.md", content: "[redacted]", score: 0.99 }],
    });
    const result = await pipeline.ingest([
      ev({
        content: "First private calendar note with plenty of detail.",
        privacyTier: "local-only",
      }),
      ev({
        content: "Second private calendar note, entirely different.",
        privacyTier: "local-only",
      }),
    ]);
    expect(result.written).toBe(2);
    expect(result.deduplicated).toBe(0);
  });

  it("searches summarize-tier events by their truncated, persisted form", async () => {
    const queries: string[] = [];
    const pipeline = new IngestionPipeline({
      memoriesDir,
      searchMemories: async (q: string) => {
        queries.push(q);
        return [];
      },
    });
    const long = "Meeting notes. " + "x".repeat(600) + " TAIL-MARKER";
    await pipeline.ingest([ev({ content: long, privacyTier: "summarize" })]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("TAIL-MARKER");
    expect(queries[0].length).toBeLessThanOrEqual(200);
  });
});

describe("IngestionPipeline — the dedup sidecar holds keyed fingerprints only (review 2026-10)", () => {
  it("writes v2 keyed entries and drops a v1 sidecar of bare hashes", async () => {
    const { contentHash } = await import("../collector/crypto.js");
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const sidecar =
      fs.readdirSync(dataDir).find((f) => f.includes("dedup")) ?? ".ingest-dedup.json";
    const sidecarPath = path.join(dataDir, sidecar);
    const content = "Wire transfer: routing number 021000021, account 12345678.";
    // A v1 sidecar: bare SHA-256 keys.
    fs.writeFileSync(
      sidecarPath,
      JSON.stringify({ [`orchestrator-test:${contentHash("old secret")}`]: Date.now() }),
    );
    const pipeline = new IngestionPipeline({ memoriesDir });
    await pipeline.ingest([ev({ content })]);
    const saved = fs.readFileSync(sidecarPath, "utf-8");
    const parsed = JSON.parse(saved);
    expect(parsed.v).toBe(2);
    expect(saved).not.toContain(contentHash("old secret"));
    expect(saved).not.toContain(contentHash(content));
    expect(Object.keys(parsed.entries)).toHaveLength(1);
    // ...and dedup still works across a restart.
    const again = await new IngestionPipeline({ memoriesDir }).ingest([ev({ content })]);
    expect(again.deduplicated).toBe(1);
  });
});
