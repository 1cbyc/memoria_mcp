import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore, headWithoutCutWord, toFtsQuery } from "../store.js";
import { chunkMarkdown } from "../chunker.js";
import os from "os";
import path from "path";
import fs from "fs";

let store: MemoryStore;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(
    os.tmpdir(),
    `memoria-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  store = new MemoryStore(dbPath);
});

afterEach(() => {
  store.close();
  try {
    fs.unlinkSync(dbPath);
  } catch {}
  try {
    fs.unlinkSync(dbPath + "-wal");
  } catch {}
  try {
    fs.unlinkSync(dbPath + "-shm");
  } catch {}
});

describe("MemoryStore", () => {
  const sampleContent = `---
name: Test
importance: 7
---

This is a test memory about TypeScript programming.`;

  it("indexes chunks and lists them in getIndexedFiles", async () => {
    const chunks = chunkMarkdown(sampleContent, "test/sample.md");
    await store.indexChunks(chunks, 7, sampleContent);
    const files = store.getIndexedFiles();
    expect(files).toContain("test/sample.md");
  });

  it("recency reflects last touch (read OR edit), not last edit alone (B6)", async () => {
    const content = "---\nname: Old note\nimportance: 5\n---\nA note about quantum widgets.";
    await store.indexChunks(chunkMarkdown(content, "old.md"), 5, content);
    // Edited two months ago, but read today.
    const monthsAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    const today = new Date().toISOString();
    (store as any).db
      .prepare("UPDATE chunks SET updated_at = ?, last_accessed = ? WHERE file = 'old.md'")
      .run(monthsAgo, today);

    const results = await store.search("quantum widgets", 1);
    // updated_at-only recency would give 0.5^(60/30) = 0.25; last-touched
    // semantics give ~1.0 because it was accessed today.
    expect(results[0].recencyScore).toBeGreaterThan(0.9);
  });

  it("search returns results sorted by score descending", async () => {
    const content1 =
      "---\nname: TS\nimportance: 8\n---\nTypeScript is a typed superset of JavaScript.";
    const content2 = "---\nname: Cooking\nimportance: 5\n---\nHow to cook pasta with tomato sauce.";

    const chunks1 = chunkMarkdown(content1, "ts.md");
    const chunks2 = chunkMarkdown(content2, "cooking.md");
    await store.indexChunks(chunks1, 8, content1);
    await store.indexChunks(chunks2, 5, content2);

    const results = await store.search("TypeScript programming", 5);
    expect(results.length).toBeGreaterThan(0);
    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("hasContentChanged returns false for same content, true for changed", async () => {
    const chunks = chunkMarkdown(sampleContent, "test.md");
    await store.indexChunks(chunks, 7, sampleContent);

    expect(store.hasContentChanged("test.md", sampleContent)).toBe(false);
    expect(store.hasContentChanged("test.md", sampleContent + " updated")).toBe(true);
  });

  it("trackAccess increments access count", async () => {
    const chunks = chunkMarkdown(sampleContent, "access.md");
    await store.indexChunks(chunks, 7, sampleContent);

    store.trackAccess("access.md");
    store.trackAccess("access.md");

    const stats = store.getStats();
    const accessed = stats.topAccessed.find((f) => f.file === "access.md");
    expect(accessed).toBeDefined();
    expect(accessed!.access_count).toBeGreaterThanOrEqual(2);
  });

  it("removeFile removes chunks and file_meta", async () => {
    const chunks = chunkMarkdown(sampleContent, "remove-me.md");
    await store.indexChunks(chunks, 7, sampleContent);
    expect(store.getIndexedFiles()).toContain("remove-me.md");

    store.removeFile("remove-me.md");
    expect(store.getIndexedFiles()).not.toContain("remove-me.md");
  });

  it("decayImportance is idempotent on same day", async () => {
    const chunks = chunkMarkdown(sampleContent, "decay.md");
    await store.indexChunks(chunks, 7, sampleContent);

    store.decayImportance(0); // first call: 0 days = all chunks eligible
    const second = store.decayImportance(0);
    // Second call on same day should return 0 (idempotent)
    expect(second).toBe(0);
  });

  it("boostImportance is idempotent on same day", async () => {
    const chunks = chunkMarkdown(sampleContent, "boost.md");
    await store.indexChunks(chunks, 7, sampleContent);

    store.boostImportance(0); // first call: threshold 0 = all eligible
    const second = store.boostImportance(0);
    expect(second).toBe(0);
  });

  it("getStats returns correct aggregate counts", async () => {
    const chunks = chunkMarkdown(sampleContent, "stats.md");
    await store.indexChunks(chunks, 7, sampleContent);

    const stats = store.getStats();
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.totalFiles).toBe(1);
    expect(stats.avgImportance).toBe(7);
  });

  it("findSimilar returns results with similarity scores", async () => {
    const chunks = chunkMarkdown(sampleContent, "similar.md");
    await store.indexChunks(chunks, 7, sampleContent);

    const results = await store.findSimilar("TypeScript test memory");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].similarity).toBeGreaterThan(0);
  });

  it("search with empty query returns results without error", async () => {
    const chunks = chunkMarkdown(sampleContent, "empty-query.md");
    await store.indexChunks(chunks, 7, sampleContent);

    const results = await store.search("", 5);
    // Should not throw; may return results based on recency/importance
    expect(Array.isArray(results)).toBe(true);
  });

  it("search on empty store returns empty array", async () => {
    const results = await store.search("anything", 5);
    expect(results).toEqual([]);
  });

  it("handles importance boundary values correctly", async () => {
    const low = "---\nname: Low\nimportance: 1\n---\nLow importance content.";
    const high = "---\nname: High\nimportance: 10\n---\nHigh importance content.";
    await store.indexChunks(chunkMarkdown(low, "low.md"), 1, low);
    await store.indexChunks(chunkMarkdown(high, "high.md"), 10, high);

    const stats = store.getStats();
    expect(stats.totalFiles).toBe(2);
    expect(stats.importanceDistribution[1]).toBeGreaterThan(0);
    expect(stats.importanceDistribution[10]).toBeGreaterThan(0);
  });

  it("getStats returns access_count as sum across chunks", async () => {
    // Index content that produces at least 1 chunk
    const chunks = chunkMarkdown(sampleContent, "sum-test.md");
    await store.indexChunks(chunks, 7, sampleContent);

    // Track access 3 times
    store.trackAccess("sum-test.md");
    store.trackAccess("sum-test.md");
    store.trackAccess("sum-test.md");

    const stats = store.getStats();
    const entry = stats.topAccessed.find((f) => f.file === "sum-test.md");
    expect(entry).toBeDefined();
    // SUM of access_count across all chunks for this file
    expect(entry!.access_count).toBeGreaterThanOrEqual(3);
  });

  it("getAccessCount returns live count from file_meta", async () => {
    const chunks = chunkMarkdown(sampleContent, "live-access.md");
    await store.indexChunks(chunks, 7, sampleContent);

    expect(store.getAccessCount("live-access.md")).toBe(0);
    store.trackAccess("live-access.md");
    expect(store.getAccessCount("live-access.md")).toBe(1);
    store.trackAccess("live-access.md");
    expect(store.getAccessCount("live-access.md")).toBe(2);
  });

  it("getAccessCount returns 0 for unknown files", () => {
    expect(store.getAccessCount("never-tracked.md")).toBe(0);
  });

  it("search with whitespace-only query falls back to recency", async () => {
    const chunks = chunkMarkdown(sampleContent, "fallback.md");
    await store.indexChunks(chunks, 7, sampleContent);

    const results = await store.search("   ", 5);
    expect(Array.isArray(results)).toBe(true);
    // The fallback returns up to maxResults entries
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

describe("keyword search across scripts and operators (2026-09 review, M2)", () => {
  const docs: Record<string, string> = {
    "de.md": "Meeting with Herr Müller in Zürich about the café budget.",
    "ja.md": "東京 タワー の 見学",
    "ops.md": "The plan and the budget were approved, not rejected.",
  };

  beforeEach(async () => {
    for (const [file, body] of Object.entries(docs)) {
      const content = `---\nname: ${file}\nimportance: 5\n---\n\n${body}`;
      await store.indexChunks(chunkMarkdown(content, file), 5, content);
    }
  });

  // What the FTS5 stage alone matches — the keyword signal the old sanitiser
  // destroyed. (search() also has recency and vector candidates, which can
  // hide a dead keyword stage in a store this small.)
  const ftsFiles = (q: string): string[] => {
    const expr = toFtsQuery(q);
    if (!expr) return [];
    const rows = (store as any).db
      .prepare("SELECT file FROM chunks_fts WHERE chunks_fts MATCH ?")
      .all(expr) as { file: string }[];
    return rows.map((r) => r.file);
  };

  it("toFtsQuery quotes every word, keeps non-ASCII, and caps the term count", () => {
    expect(toFtsQuery("Müller café")).toBe('"Müller" OR "café"');
    expect(toFtsQuery("plan AND budget")).toBe('"plan" OR "AND" OR "budget"');
    expect(toFtsQuery("東京タワー")).toBe('"東京タワー"');
    expect(toFtsQuery("?! -- ()")).toBe("");
    expect(toFtsQuery(Array(40).fill("w").join(" ")).split(" OR ")).toHaveLength(32);
  });

  it("finds words with diacritics, with or without the accent", () => {
    expect(ftsFiles("Müller")).toContain("de.md");
    expect(ftsFiles("Zürich")).toContain("de.md");
    expect(ftsFiles("café")).toContain("de.md");
    expect(ftsFiles("cafe")).toContain("de.md"); // unicode61 folds diacritics
  });

  it("finds CJK words (space-delimited; unicode61 does not segment CJK)", () => {
    expect(ftsFiles("東京")).toContain("ja.md");
  });

  it("treats AND / OR / NOT / NEAR as words, not operators or syntax errors", () => {
    expect(ftsFiles("plan AND budget")).toContain("ops.md");
    expect(ftsFiles("not rejected")).toContain("ops.md");
    expect(() => ftsFiles("NEAR OR")).not.toThrow();
    expect(() => ftsFiles('"unbalanced quote')).not.toThrow();
  });

  it("search() ranks the keyword match first for a non-ASCII query", async () => {
    const results = await store.search("Müller", 3);
    expect(results[0].file).toBe("de.md");
  });
});

describe("headWithoutCutWord (2026-09 re-review)", () => {
  it("drops a word the cut went through, keeps a whole one", () => {
    expect(headWithoutCutWord("meeting with Müller today", 17)).toBe("meeting with ");
    expect(headWithoutCutWord("meeting with Müller today", 19)).toBe("meeting with Müller");
    expect(headWithoutCutWord("short", 200)).toBe("short");
  });
});

describe("headWithoutCutWord outside the BMP (2026-09 re-review, round 4)", () => {
  it("drops a word whose cut falls inside a surrogate pair", () => {
    // U+20000 is a CJK Extension B letter: two UTF-16 units.
    const text = "note 𠀀𠀀𠀀 end";
    expect(headWithoutCutWord(text, 7)).toBe("note ");
    expect(headWithoutCutWord(text, 8)).toBe("note ");
  });
});

describe("recency comes from the memory, not from when it was indexed (review 2026-10)", () => {
  const DAY = 24 * 3600 * 1000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().split("T")[0];
  const note = (updated: string) =>
    `---\nname: Note\nimportance: 5\nupdated: ${updated}\n---\nA note about quantum widgets.`;

  it("a first index takes the frontmatter date, not today", async () => {
    const c = note(daysAgo(90));
    await store.indexChunks(chunkMarkdown(c, "n.md"), 5, c, {
      contentDate: daysAgo(90),
      mtimeMs: Date.now(),
    });
    const [r] = await store.search("quantum widgets", 1);
    // 0.5^(90/30) = 0.125. Index-time dating gave ~1.0 for every memory.
    expect(r.recencyScore).toBeLessThan(0.2);
    expect(r.recencyScore).toBeGreaterThan(0.08);
  });

  it("falls back to mtime when there is no frontmatter date, and never dates into the future", async () => {
    const c = "---\nname: N\n---\nA note about quantum widgets.";
    await store.indexChunks(chunkMarkdown(c, "a.md"), 5, c, { mtimeMs: Date.now() - 60 * DAY });
    const c2 = note("2999-01-01");
    await store.indexChunks(chunkMarkdown(c2, "b.md"), 5, c2, { contentDate: "2999-01-01" });
    const rows = (store as any).db
      .prepare("SELECT DISTINCT file, updated_at FROM chunks ORDER BY file")
      .all();
    expect(rows[0].updated_at).toBe(daysAgo(60));
    expect(rows[1].updated_at).toBe(daysAgo(0));
  });

  it("an edit to an indexed file is dated by its mtime, even with a stale frontmatter date", async () => {
    const c1 = note(daysAgo(200));
    await store.indexChunks(chunkMarkdown(c1, "e.md"), 5, c1, { contentDate: daysAgo(200) });
    const c2 = c1 + "\nAn edit made today.";
    await store.indexChunks(chunkMarkdown(c2, "e.md"), 5, c2, {
      contentDate: daysAgo(200),
      mtimeMs: Date.now(),
    });
    const [r] = await store.search("quantum widgets", 1);
    expect(r.recencyScore).toBeGreaterThan(0.95);
  });

  it("re-indexing keeps the access history instead of resetting it to now", async () => {
    const c1 = note(daysAgo(120));
    await store.indexChunks(chunkMarkdown(c1, "h.md"), 5, c1, { contentDate: daysAgo(120) });
    store.trackAccess("h.md");
    store.trackAccess("h.md");
    // Pretend those reads were 40 days ago.
    (store as any).db
      .prepare("UPDATE file_meta SET last_accessed = ? WHERE file = 'h.md'")
      .run(daysAgo(40));
    const c2 = c1 + "\nMore.";
    await store.indexChunks(chunkMarkdown(c2, "h.md"), 5, c2, { mtimeMs: Date.now() - 100 * DAY });
    const row = (store as any).db
      .prepare("SELECT updated_at, last_accessed, access_count FROM chunks WHERE file = 'h.md'")
      .get();
    expect(row.updated_at).toBe(daysAgo(100));
    expect(row.last_accessed).toBe(daysAgo(40));
    expect(row.access_count).toBe(2);
    expect(store.getAccessCount("h.md")).toBe(2);
  });

  it("a never-accessed memory is not stale-exempt just because it was indexed today", async () => {
    const c = note(daysAgo(200));
    await store.indexChunks(chunkMarkdown(c, "s.md"), 3, c, { contentDate: daysAgo(200) });
    expect(store.findStale(90, 5).map((s) => s.file)).toContain("s.md");
  });
});

describe("an emptied file leaves the index (review 2026-10)", () => {
  it("clearFile drops the chunks, and the unchanged empty file is then skipped", async () => {
    const c1 = "---\nname: Secret\n---\nlaunch codes zebra";
    await store.indexChunks(chunkMarkdown(c1, "r.md"), 5, c1);
    expect((await store.search("launch codes zebra", 5)).map((r) => r.file)).toContain("r.md");
    const c2 = "---\nname: Secret\n---\n";
    expect(chunkMarkdown(c2, "r.md")).toEqual([]);
    store.clearFile("r.md", c2);
    expect((await store.search("launch codes zebra", 5)).map((r) => r.file)).not.toContain("r.md");
    expect(store.hasContentChanged("r.md", c2)).toBe(false);
  });
});

describe("index format version (review 2026-10)", () => {
  it("rebuilds an index written by the previous version once", async () => {
    const c = "---\nname: N\n---\nA note about quantum widgets.";
    await store.indexChunks(chunkMarkdown(c, "v.md"), 5, c);
    (store as any).db.prepare("DELETE FROM store_meta WHERE key = 'index_version'").run();
    store.close();
    store = new MemoryStore(dbPath);
    expect(store.needsReindex).toBe(true);
    expect(store.getIndexedFiles()).toEqual([]);
    store.close();
    store = new MemoryStore(dbPath);
    expect(store.needsReindex).toBe(false);
  });
});

describe("access history survives rebuilds and edits count as touches (re-review 2026-10)", () => {
  const DAY = 24 * 3600 * 1000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().split("T")[0];
  const old = `---\nname: N\nimportance: 5\nupdated: ${daysAgo(400)}\n---\nA note about quantum widgets.`;

  it("a provider change or index-version rebuild keeps access counts and last read", async () => {
    await store.indexChunks(chunkMarkdown(old, "a.md"), 5, old, { contentDate: daysAgo(400) });
    for (let i = 0; i < 12; i++) store.trackAccess("a.md");
    (store as any).db.prepare("DELETE FROM store_meta WHERE key = 'index_version'").run();
    store.close();
    store = new MemoryStore(dbPath);
    expect(store.needsReindex).toBe(true);
    await store.indexChunks(chunkMarkdown(old, "a.md"), 5, old, { contentDate: daysAgo(400) });
    expect(store.getAccessCount("a.md")).toBe(12);
    const [r] = await store.search("quantum widgets", 1);
    expect(r.recencyScore).toBeGreaterThan(0.95); // read today
    expect(store.findStale(90, 5).map((s) => s.file)).not.toContain("a.md");
  });

  it("an edit refreshes last_accessed, so a just-edited memory is not stale", async () => {
    await store.indexChunks(chunkMarkdown(old, "e.md"), 3, old, { contentDate: daysAgo(400) });
    expect(store.findStale(90, 5).map((s) => s.file)).toContain("e.md");
    const edited = old + "\nEdited today.";
    await store.indexChunks(chunkMarkdown(edited, "e.md"), 3, edited, { mtimeMs: Date.now() });
    expect(store.findStale(90, 5).map((s) => s.file)).not.toContain("e.md");
  });

  it("an empty or non-ISO `updated` falls through to `created`", async () => {
    for (const [file, updated] of [
      ["x.md", ""],
      ["y.md", "January 5"],
      ["z.md", "1"],
    ] as const) {
      const c = `---\nname: N\n---\nA note about quantum widgets ${file}.`;
      await store.indexChunks(chunkMarkdown(c, file), 5, c, {
        contentDate: [updated, "2023-06-01"],
      });
    }
    const rows = (store as any).db
      .prepare("SELECT DISTINCT file, updated_at FROM chunks ORDER BY file")
      .all();
    expect(rows.map((r: { updated_at: string }) => r.updated_at)).toEqual([
      "2023-06-01",
      "2023-06-01",
      "2023-06-01",
    ]);
  });
});

describe("retainFiles (re-review 2026-10)", () => {
  it("drops index state for files that no longer exist, keeps the rest", async () => {
    const c = "---\nname: N\n---\nA note about quantum widgets.";
    await store.indexChunks(chunkMarkdown(c, "keep.md"), 5, c);
    await store.indexChunks(chunkMarkdown(c + " x", "gone.md"), 5, c + " x");
    store.trackAccess("gone.md");
    expect(store.retainFiles(["keep.md"])).toBe(1);
    expect(store.getAccessCount("gone.md")).toBe(0);
    expect(store.getIndexedFiles()).toEqual(["keep.md"]);
  });
});

describe("keyword search matches any query word (review 2026-10)", () => {
  it("finds a chunk for a natural-language query that shares only some words", async () => {
    const c = "---\nname: Q\n---\nWe moved the job queue to Redis streams.";
    await store.indexChunks(chunkMarkdown(c, "q.md"), 5, c);
    const [hit] = await store.search("what did we decide about the queue", 1);
    expect(hit.file).toBe("q.md");
    // ...through the BM25 path, not just the vector half or substring fallback.
    const ftsRows = (store as any).db
      .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?")
      .all(toFtsQuery("what did we decide about the queue"));
    expect(ftsRows.length).toBe(1);
  });
});
