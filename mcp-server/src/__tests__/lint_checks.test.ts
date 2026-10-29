import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-lint-"));
process.env.MEMORIA_DIR = ROOT;
const MEM = path.join(ROOT, "memories");

let runLint: typeof import("../lint.js").runLint;
let tools: typeof import("../tools.js");
let store: any;

function writeMemory(rel: string, fm: Record<string, unknown>, body: string) {
  const yaml = Object.entries(fm)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`)
    .join("\n");
  const full = path.join(MEM, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `---\n${yaml}\n---\n\n${body}\n`, "utf-8");
}

beforeAll(async () => {
  fs.mkdirSync(MEM, { recursive: true });
  // Two spellings of the same entity (rule VIII alias drift).
  writeMemory(
    "project/tap.md",
    {
      name: "Talk & Play",
      description: "app",
      type: "project",
      importance: 7,
      updated: "2026-06-01",
    },
    "The flagship app.",
  );
  writeMemory(
    "project/tap2.md",
    {
      name: "talk-and-play",
      description: "app dup",
      type: "project",
      importance: 6,
      updated: "2026-06-02",
    },
    "Same app, different file.",
  );
  // A hedged / low-confidence curated memory.
  writeMemory(
    "decisions/db.md",
    {
      name: "Datastore choice",
      description: "db",
      type: "decision",
      importance: 7,
      updated: "2026-06-03",
    },
    "We probably want SQLite, but TODO: confirm with the team. Not sure about scaling.",
  );
  // A clean memory with no hedges and a unique name.
  writeMemory(
    "user/profile.md",
    {
      name: "User profile",
      description: "who",
      type: "user",
      importance: 9,
      updated: "2026-06-04",
    },
    "The user is Alex. Offline-first is required.",
  );
  // A daily log — must be ignored by both new checks.
  writeMemory(
    "daily/2026-06-05.md",
    { name: "Daily", description: "d", type: "session", importance: 3, updated: "2026-06-05" },
    "## 10:00 — agent\n\nmaybe did a thing, probably",
  );
  // A stray sibling directory (the real reference/-vs-references/ split) and a
  // loose file at the memories root — both outside the documented layout.
  writeMemory(
    "reference/stray.md",
    {
      name: "Stray runbook",
      description: "misfiled",
      type: "reference",
      importance: 6,
      updated: "2026-06-06",
    },
    "Written directly to disk, wrong directory.",
  );
  writeMemory(
    "loose-note.md",
    {
      name: "Loose note",
      description: "rootfile",
      type: "reference",
      importance: 4,
      updated: "2026-06-07",
    },
    "A file at the memories root.",
  );
  // Where memory_compile files a `type: pattern` memory — documented, not stray.
  writeMemory(
    "patterns/retry.md",
    {
      name: "Retry with backoff",
      description: "pattern",
      type: "pattern",
      importance: 5,
      updated: "2026-06-08",
    },
    "Retry transient failures with exponential backoff.",
  );

  tools = await import("../tools.js");
  ({ runLint } = await import("../lint.js"));
  const s = await import("../store.js");
  store = new s.MemoryStore(path.join(ROOT, "data", "lint.sqlite"));
  for (const f of tools.getAllMemoryFiles()) await tools.reindexFile(store, f);
});

afterAll(() => {
  try {
    store?.close();
  } catch {}
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

describe("lint: entity alias collisions (P4)", () => {
  it("flags two spellings of the same entity name", async () => {
    const r = await runLint(store, MEM, tools.getAllMemoryFiles, tools.getRelativePath);
    const collision = r.aliasCollisions.find((c) => c.normalized === "talkandplay");
    expect(collision).toBeDefined();
    const files = collision!.variants.map((v) => v.file).sort();
    expect(files).toEqual(["project/tap.md", "project/tap2.md"]);
  });

  it("does not flag a uniquely-named memory", async () => {
    const r = await runLint(store, MEM, tools.getAllMemoryFiles, tools.getRelativePath);
    const hit = r.aliasCollisions.find((c) => c.variants.some((v) => v.file === "user/profile.md"));
    expect(hit).toBeUndefined();
  });
});

describe("lint: unknown directories", () => {
  it("flags files in undocumented directories and at the memories root", async () => {
    const r = await runLint(store, MEM, tools.getAllMemoryFiles, tools.getRelativePath);
    const stray = r.unknownDirs.find((u) => u.dir === "reference");
    expect(stray).toBeDefined();
    expect(stray!.files).toEqual(["reference/stray.md"]);
    const root = r.unknownDirs.find((u) => u.dir === ".");
    expect(root).toBeDefined();
    expect(root!.files).toEqual(["loose-note.md"]);
  });

  it("does not flag documented directories", async () => {
    const r = await runLint(store, MEM, tools.getAllMemoryFiles, tools.getRelativePath);
    const dirs = r.unknownDirs.map((u) => u.dir);
    for (const known of ["daily", "project", "decisions", "user", "patterns"]) {
      expect(dirs).not.toContain(known);
    }
  });
});

describe("lint: low-confidence claims (P4)", () => {
  it("flags hedged curated memories with the matched markers", async () => {
    const r = await runLint(store, MEM, tools.getAllMemoryFiles, tools.getRelativePath);
    const lc = r.lowConfidence.find((x) => x.file === "decisions/db.md");
    expect(lc).toBeDefined();
    expect(lc!.markers).toEqual(expect.arrayContaining(["probably", "todo", "not sure"]));
  });

  it("ignores daily logs and clean curated memories", async () => {
    const r = await runLint(store, MEM, tools.getAllMemoryFiles, tools.getRelativePath);
    expect(r.lowConfidence.some((x) => x.file.startsWith("daily/"))).toBe(false);
    expect(r.lowConfidence.some((x) => x.file === "user/profile.md")).toBe(false);
  });
});
