import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dailyLogPath, existingDailyLogPath, listDailyLogNames } from "../daily-paths.js";
import { parseFrontmatter } from "../chunker.js";
import { IngestionPipeline } from "../collector/ingestion.js";

let root: string;
let mem: string;
let outside: string;

function trySymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-daily-"));
  mem = path.join(root, "memories");
  outside = path.join(root, "outside.txt");
  fs.mkdirSync(path.join(mem, "daily"), { recursive: true });
  fs.writeFileSync(outside, "secret outside the store\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("daily-log paths refuse symlinks (review 2026-10)", () => {
  it("writers refuse a symlinked log, existing or dangling", () => {
    const today = "2026-10-28";
    if (!trySymlink(outside, path.join(mem, "daily", `${today}.md`))) return;
    expect(() => dailyLogPath(mem, today)).toThrow(/not a regular file/);
    if (!trySymlink(path.join(root, "nowhere.txt"), path.join(mem, "daily", "2026-10-29.md"))) {
      return;
    }
    expect(() => dailyLogPath(mem, "2026-10-29")).toThrow(/not a regular file/);
    expect(fs.existsSync(path.join(root, "nowhere.txt"))).toBe(false);
  });

  it("writers refuse a symlinked daily/ directory", () => {
    fs.rmSync(path.join(mem, "daily"), { recursive: true });
    fs.mkdirSync(path.join(root, "elsewhere"));
    if (!trySymlink(path.join(root, "elsewhere"), path.join(mem, "daily"))) return;
    expect(() => dailyLogPath(mem, "2026-10-28")).toThrow(/symlinked/);
    expect(listDailyLogNames(mem)).toEqual([]);
  });

  it("readers list and open regular logs only", () => {
    fs.writeFileSync(path.join(mem, "daily", "2026-10-27.md"), "real\n");
    if (!trySymlink(outside, path.join(mem, "daily", "2099-01-01.md"))) return;
    expect(listDailyLogNames(mem)).toEqual(["2026-10-27.md"]);
    expect(existingDailyLogPath(mem, "2099-01-01")).toBeNull();
    expect(existingDailyLogPath(mem, "2026-10-27")).toBe(path.join(mem, "daily", "2026-10-27.md"));
  });

  it("the collector does not append through a planted link", async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (!trySymlink(outside, path.join(mem, "daily", `${today}.md`))) return;
    const pipeline = new IngestionPipeline({ memoriesDir: mem });
    const r = await pipeline.ingest([
      {
        id: "e1",
        source: "test",
        eventType: "x",
        content: "Decided to migrate the queue to Redis streams this week.",
        timestamp: new Date().toISOString(),
        meta: {},
        importanceEstimate: 6,
        privacyTier: "send",
      },
    ]);
    expect(r.written).toBe(0);
    expect(fs.readFileSync(outside, "utf-8")).toBe("secret outside the store\n");
  });
});

describe("union-merged daily logs keep their frontmatter (review 2026-10)", () => {
  it("a repeated key takes its last value instead of dropping every field", () => {
    const merged =
      "---\nname: Daily log 2026-10-28\ntype: session\nimportance: 3\nimportance: 5\n---\n\nbody\n";
    const { metadata } = parseFrontmatter(merged);
    expect(metadata.name).toBe("Daily log 2026-10-28");
    expect(metadata.type).toBe("session");
    expect(metadata.importance).toBe(5);
  });
});
