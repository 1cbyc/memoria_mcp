import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// resolveMemoryPath reads MEMORIA_DIR at module-load time, so point it at an
// isolated temp dir BEFORE importing tools.js. This exercises the REAL
// validator (not a duplicated regex copy), including the symlink-leaf defense.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-pathsafety-"));
process.env.MEMORIA_DIR = ROOT;

let resolveMemoryPath: (file: string) => string;
let isValidMemoryFilename: (file: string) => boolean;
let MEMORIES_DIR: string;

beforeAll(async () => {
  fs.mkdirSync(path.join(ROOT, "memories", "project"), { recursive: true });
  const mod = await import("../tools.js");
  resolveMemoryPath = mod.resolveMemoryPath;
  isValidMemoryFilename = mod.isValidMemoryFilename;
  MEMORIES_DIR = mod.MEMORIES_DIR;
});

afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

/** Try to create a symlink; return false if the platform forbids it (e.g.
 *  Windows without Developer Mode) so the test skips rather than flakes. */
function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

describe("resolveMemoryPath (real validator)", () => {
  it("resolves a normal in-tree path inside memories/", () => {
    const p = resolveMemoryPath("project/notes.md");
    expect(p).toBe(path.join(MEMORIES_DIR, "project", "notes.md"));
  });

  it("allows a regular existing leaf file", () => {
    const rel = "project/regular.md";
    fs.writeFileSync(path.join(MEMORIES_DIR, rel), "# hi");
    expect(() => resolveMemoryPath(rel)).not.toThrow();
  });

  it("rejects ../ path traversal", () => {
    expect(() => resolveMemoryPath("../escape.md")).toThrow(/traversal/i);
    expect(() => resolveMemoryPath("../../etc/passwd")).toThrow(/traversal/i);
    expect(() => resolveMemoryPath("project/../../escape.md")).toThrow(/traversal/i);
  });

  it("rejects absolute paths that escape memories/", () => {
    const outside = process.platform === "win32" ? "C:/Windows/win.ini" : "/etc/passwd";
    expect(() => resolveMemoryPath(outside)).toThrow(/traversal/i);
  });

  it("rejects a symlinked leaf pointing outside memories/ (the leaf-gap fix)", () => {
    const secret = path.join(ROOT, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET CONTENTS");
    const link = path.join(MEMORIES_DIR, "leak.md");
    if (!trySymlink(secret, link)) return; // platform can't symlink — skip
    try {
      expect(() => resolveMemoryPath("leak.md")).toThrow(/symlink/i);
    } finally {
      try {
        fs.unlinkSync(link);
      } catch {}
    }
  });

  it("rejects a dangling symlinked leaf (would otherwise materialize off-tree on write)", () => {
    const danglingTarget = path.join(ROOT, "does-not-exist.txt");
    const link = path.join(MEMORIES_DIR, "dangling.md");
    if (!trySymlink(danglingTarget, link)) return; // platform can't symlink — skip
    try {
      expect(() => resolveMemoryPath("dangling.md")).toThrow(/symlink/i);
    } finally {
      try {
        fs.unlinkSync(link);
      } catch {}
    }
  });
});

describe("isValidMemoryFilename (real validator — shape only)", () => {
  it("accepts well-formed memory paths", () => {
    expect(isValidMemoryFilename("project/notes.md")).toBe(true);
    expect(isValidMemoryFilename("daily/2026-06-03.md")).toBe(true);
    expect(isValidMemoryFilename("simple.md")).toBe(true);
  });

  it("rejects wrong extensions, spaces, and shell metacharacters", () => {
    expect(isValidMemoryFilename("notes.txt")).toBe(false);
    expect(isValidMemoryFilename("file with spaces.md")).toBe(false);
    expect(isValidMemoryFilename("file;rm -rf.md")).toBe(false);
    expect(isValidMemoryFilename("C:\\Windows\\file.md")).toBe(false);
    expect(isValidMemoryFilename("")).toBe(false);
  });

  it("rejects traversal/normalization tricks at the input layer (defense in depth)", () => {
    expect(isValidMemoryFilename("../../etc/passwd.md")).toBe(false); // .. segment
    expect(isValidMemoryFilename("a/./b.md")).toBe(false); // . segment
    expect(isValidMemoryFilename("a//b.md")).toBe(false); // empty segment
    expect(isValidMemoryFilename("/etc/passwd.md")).toBe(false); // absolute
    // resolveMemoryPath is still the authoritative containment guard:
    expect(() => resolveMemoryPath("../../etc/passwd.md")).toThrow(/traversal/i);
  });
});

describe("indexing skips symlinked memory files (2026-09 review, L1)", () => {
  it("getAllMemoryFiles and reindexFile ignore a symlink pointing outside the store", async () => {
    const { getAllMemoryFiles, reindexFile } = await import("../tools.js");
    const { MemoryStore } = await import("../store.js");
    const outside = path.join(ROOT, "outside-secret.md");
    fs.writeFileSync(outside, "---\nname: secret\n---\nsecret-outside-content\n");
    const link = path.join(MEMORIES_DIR, "project", "linked-secret.md");
    if (!trySymlink(outside, link)) return; // platform can't symlink — skip
    const regular = path.join(MEMORIES_DIR, "project", "regular-note.md");
    fs.writeFileSync(regular, "---\nname: note\n---\nregular content\n");

    const files = getAllMemoryFiles();
    expect(files).toContain(regular);
    expect(files).not.toContain(link);

    const store = new MemoryStore(path.join(ROOT, "l1.sqlite"));
    try {
      expect(await reindexFile(store, link)).toBe(0);
      expect(await reindexFile(store, regular)).toBeGreaterThan(0);
      expect(store.getIndexedFiles()).not.toContain("project/linked-secret.md");
    } finally {
      store.close();
      fs.unlinkSync(link);
    }
  });
});

describe("reindexFile dates and emptied bodies (review 2026-10)", () => {
  it("indexes with the frontmatter date and drops a body that was emptied", async () => {
    const { reindexFile } = await import("../tools.js");
    const { MemoryStore } = await import("../store.js");
    const file = path.join(MEMORIES_DIR, "project", "dated.md");
    fs.writeFileSync(file, "---\nname: d\nupdated: 2020-01-15\n---\nlaunch codes zebra\n");
    const store = new MemoryStore(path.join(ROOT, "dates.sqlite"));
    try {
      expect(await reindexFile(store, file)).toBeGreaterThan(0);
      const [hit] = await store.search("launch codes zebra", 1);
      expect(hit.file).toBe("project/dated.md");
      expect(hit.recencyScore).toBeLessThan(0.01);

      fs.writeFileSync(file, "---\nname: d\nupdated: 2020-01-15\n---\n");
      expect(await reindexFile(store, file)).toBe(0);
      const after = await store.search("launch codes zebra", 5);
      expect(after.map((r) => r.file)).not.toContain("project/dated.md");
    } finally {
      store.close();
    }
  });
});

describe("reindexAll (review 2026-10)", () => {
  it("one failing file does not stop the pass, and deleted files are dropped", async () => {
    const { reindexAll } = await import("../tools.js");
    const { MemoryStore } = await import("../store.js");
    const good = path.join(MEMORIES_DIR, "project", "good-note.md");
    const bad = path.join(MEMORIES_DIR, "project", "bad-note.md");
    const gone = path.join(MEMORIES_DIR, "project", "gone-note.md");
    fs.writeFileSync(good, "---\nname: g\n---\nalpha bravo charlie\n");
    fs.writeFileSync(bad, "---\nname: b\n---\ndelta echo foxtrot\n");
    fs.writeFileSync(gone, "---\nname: x\n---\ngolf hotel india\n");
    const store = new MemoryStore(path.join(ROOT, "reindexall.sqlite"));
    try {
      await reindexAll(store);
      expect(store.getIndexedFiles()).toContain("project/gone-note.md");
      fs.unlinkSync(gone);
      fs.writeFileSync(good, "---\nname: g\n---\nalpha bravo charlie, edited\n");
      fs.writeFileSync(bad, "---\nname: b\n---\ndelta echo foxtrot, edited\n");
      const realIndex = store.indexChunks.bind(store);
      store.indexChunks = async (chunks, ...rest) => {
        if (chunks[0]?.file === "project/bad-note.md") throw new Error("embedding API 429");
        return realIndex(chunks, ...rest);
      };
      const r = await reindexAll(store);
      expect(r.failed).toEqual(["project/bad-note.md"]);
      const hits = await store.search("alpha bravo charlie edited", 3);
      expect(hits[0].text).toContain("edited");
      expect(store.getIndexedFiles()).not.toContain("project/gone-note.md");
    } finally {
      store.close();
      for (const f of [good, bad]) fs.rmSync(f, { force: true });
    }
  });

  it("forgetContentHashes makes every file re-embed (memory_index force)", async () => {
    const { MemoryStore } = await import("../store.js");
    const { chunkMarkdown } = await import("../chunker.js");
    const store = new MemoryStore(path.join(ROOT, "force.sqlite"));
    try {
      const c = "---\nname: f\n---\nkilo lima mike\n";
      await store.indexChunks(chunkMarkdown(c, "f.md"), 5, c);
      expect(store.hasContentChanged("f.md", c)).toBe(false);
      store.forgetContentHashes();
      expect(store.hasContentChanged("f.md", c)).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("writeFusedActivities (review 2026-10)", () => {
  it("writes an activity once, even when its events are fused again later", async () => {
    const { writeFusedActivities } = await import("../tools.js");
    const activity = (ids: string[], label: string) => ({
      id: label,
      label,
      description: "fused activity",
      startTime: "2026-10-28T10:00:00.000Z",
      endTime: "2026-10-28T10:30:00.000Z",
      sourceEvents: ids.map((id) => ({
        source: id.split(":")[0],
        id: id.split(":")[1],
        content: "x",
        timestamp: "2026-10-28T10:00:00.000Z",
      })),
      sourceCount: 2,
      importance: 6,
      tags: ["meeting"],
    });
    const a = activity(["calendar:c1", "email:m1"], "Fused standup A");
    expect(writeFusedActivities([a] as never)).toHaveLength(1);
    // memory_fuse then the daemon (or a re-fused retry) see the same events.
    expect(writeFusedActivities([activity(["calendar:c1", "email:m1"], "again")] as never)).toEqual(
      [],
    );
    // An activity with any new event is still written.
    expect(
      writeFusedActivities([activity(["calendar:c1", "email:m2"], "Fused standup B")] as never),
    ).toHaveLength(1);
    const today = new Date().toISOString().slice(0, 10);
    const log = fs.readFileSync(path.join(MEMORIES_DIR, "daily", `${today}.md`), "utf-8");
    expect(log.match(/Fused standup A/g)).toHaveLength(1);
  });
});

describe("unfusedEvents (re-review 2026-10)", () => {
  it("an overlapping cluster is not written again through its shared events", async () => {
    const { writeFusedActivities, unfusedEvents } = await import("../tools.js");
    const ev = (key: string) => ({ source: key.split(":")[0], id: key.split(":")[1] });
    const activity = {
      id: "x",
      label: "Fused review C",
      description: "fused activity",
      startTime: "2026-10-28T10:00:00.000Z",
      endTime: "2026-10-28T10:30:00.000Z",
      sourceEvents: ["calendar:o1", "email:o2", "slack:o3"].map((k) => ({
        ...ev(k),
        content: "x",
        timestamp: "2026-10-28T10:00:00.000Z",
      })),
      sourceCount: 3,
      importance: 6,
      tags: [],
    };
    writeFusedActivities([activity] as never);
    // The daemon later sees two of those events plus a new one.
    const next = unfusedEvents([ev("calendar:o1"), ev("email:o2"), ev("chat:o4")]);
    expect(next).toEqual([ev("chat:o4")]); // one event left: nothing to fuse
  });
});
