/**
 * Memoria Dashboard — lightweight web UI for managing memory & data sources.
 *
 * Sections:
 *   - Overview: memory stats, collector status, recent daily log
 *   - Sources: list/enable/disable/configure data sources
 *   - Journal: daily journal entry for manual memory context
 *   - Settings: importance thresholds, poll intervals, buffer management
 *
 * Served at /dashboard. REST API at /api/*.
 * All API endpoints require the same Bearer auth as /mcp.
 */

import { Router } from "express";
import type { Response } from "express";
import { randomBytes, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { parseFrontmatter } from "./chunker.js";
import { utcTimeLabel } from "./daily-format.js";
import { createOrAppend } from "./atomic-fs.js";
import { MemoryStore } from "./store.js";
import {
  MEMORIES_DIR,
  getAllMemoryFiles,
  readMemoryFile,
  getRelativePath,
  resolveMemoryPath,
  isValidMemoryFilename,
  reindexFile,
  getCollector,
} from "./tools.js";
import {
  renderMemoryHtml,
  extractWikiLinks,
  normalizeRelated,
  resolveLink,
  type StoreEntry,
} from "./wiki.js";

// scanStore() reads + parses EVERY memory file, and the wiki link graph
// (outgoing edges + backlinks) is O(N²) to resolve. Both are computed once and
// cached for a short TTL so a wiki click is O(1) lookups instead of N FUSE reads
// + an O(N²) backlink sweep on every request (which degrades as the Orchestrator
// grows the store). After an in-app write (annotate/journal) the cache is busted
// the instant the file hits disk, so the next request reflects the change; an
// external change (git pull on another device) appears within the TTL.
const SCAN_TTL_MS = 15_000;

// The journal's mood picker offers exactly these (data-mood in the page).
const JOURNAL_MOODS: ReadonlySet<unknown> = new Set([
  "great",
  "good",
  "neutral",
  "tired",
  "stressed",
]);

// Return a generic 500 to the client while logging the real error server-side.
// Raw err.message routinely embeds absolute container paths (/data/memoria/...,
// /tmp/memoria/tokens.sqlite) and internal state; even behind auth that aids an
// attacker holding any valid credential. The client gets a correlation id to
// quote in a bug report; the details stay in the server log.
function sendServerError(res: Response, err: unknown): void {
  const correlationId = randomUUID();
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Memoria dashboard error [${correlationId}]: ${message}\n`);
  res.status(500).json({ error: "Internal server error", correlationId });
}

interface ScanGraph {
  entries: StoreEntry[];
  byFile: Map<string, StoreEntry>;
  /** source file → resolved outgoing links (related + [[wikilinks]]). */
  outgoing: Map<string, Array<{ file: string; name: string }>>;
  /** target file → memories that link to it (reverse of `outgoing`). */
  backlinks: Map<string, Array<{ file: string; name: string }>>;
}

let scanCache: { graph: ScanGraph; at: number } | null = null;

/** Invalidate the scanStore cache (call after any write to a memory file). */
function bustScanCache(): void {
  scanCache = null;
}

/** Read every file once and precompute the link graph. Cached for SCAN_TTL_MS. */
function scanGraph(): ScanGraph {
  const now = Date.now();
  if (scanCache && now - scanCache.at < SCAN_TTL_MS) return scanCache.graph;

  const entries: StoreEntry[] = [];
  for (const abs of getAllMemoryFiles()) {
    const { content } = readMemoryFile(abs);
    const { metadata, body } = parseFrontmatter(content);
    const file = getRelativePath(abs);
    entries.push({
      file,
      name: String(metadata.name || path.basename(file, ".md")),
      type: String(metadata.type || file.split("/")[0] || "memory"),
      importance: typeof metadata.importance === "number" ? metadata.importance : 5,
      related: normalizeRelated((metadata as any).related),
      wikilinks: extractWikiLinks(body),
    });
  }

  const byFile = new Map(entries.map((e) => [e.file, e]));
  const outgoing = new Map<string, Array<{ file: string; name: string }>>();
  const backlinks = new Map<string, Array<{ file: string; name: string }>>();
  for (const e of entries) {
    // Resolve this memory's outgoing edges once: frontmatter `related` (an
    // unresolved path is kept as a literal so it still shows) then body [[links]]
    // (kept only when they resolve to a real file).
    const targets = new Map<string, string>(); // target file/literal → label
    for (const p of e.related) {
      const t = resolveLink(p, entries) || p;
      targets.set(t, byFile.get(t)?.name || p);
    }
    for (const w of e.wikilinks) {
      const t = resolveLink(w, entries);
      if (t) targets.set(t, byFile.get(t)?.name || w);
    }
    outgoing.set(
      e.file,
      Array.from(targets, ([file, name]) => ({ file, name })),
    );
    // Reverse edges → backlinks. Only edges that resolve to a real store file
    // (and not the memory itself) produce a backlink.
    for (const t of targets.keys()) {
      if (t === e.file || !byFile.has(t)) continue;
      const list = backlinks.get(t) ?? [];
      list.push({ file: e.file, name: e.name });
      backlinks.set(t, list);
    }
  }

  scanCache = { graph: { entries, byFile, outgoing, backlinks }, at: now };
  return scanCache.graph;
}

/** Read every memory file once: relpath, frontmatter summary, related + [[links]]. Cached. */
function scanStore(): StoreEntry[] {
  return scanGraph().entries;
}

// The dashboard shares the SINGLE collector (registry + daemon + buffer)
// owned by tools.ts via getCollector(store). It must never construct its own —
// two registries over the same encrypted config file clobber each other, and
// two daemons double-poll every source. See getCollector() in tools.ts.

// ── Router factory ───────────────────────────────────────────

export function createDashboardRouter(store: MemoryStore): Router {
  const router = Router();

  // ── API: Memory stats ────────────────────────────────────

  router.get("/api/stats", async (_req, res) => {
    try {
      const stats = store.getStats();
      const fileCount = getAllMemoryFiles().length;
      res.json({ ...stats, fileCount });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── API: Memory list ─────────────────────────────────────

  router.get("/api/memories", (_req, res) => {
    try {
      const files = getAllMemoryFiles();
      const entries = files.map((f) => {
        const { content } = readMemoryFile(f);
        const { metadata } = parseFrontmatter(content);
        return {
          file: getRelativePath(f),
          name: (metadata.name as string) || path.basename(f, ".md"),
          type: (metadata.type as string) || "unknown",
          importance: (metadata.importance as number) || 5,
          updated: (metadata.updated as string) || "unknown",
          tags: (metadata.tags as string[]) || [],
          accessCount: (metadata.access_count as number) || 0,
        };
      });
      entries.sort((a, b) => b.importance - a.importance);
      res.json(entries);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── API: Memory search ───────────────────────────────────

  router.get("/api/search", async (req, res) => {
    const query = req.query.q as string;
    if (!query) {
      res.json([]);
      return;
    }
    try {
      const results = await store.search(query, 20);
      res.json(results);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── API: Wiki ─────────────────────────────────────────────

  // Read one memory rendered to safe HTML, with outgoing links + backlinks.
  router.get("/api/memory", (req, res) => {
    try {
      const file = String(req.query.file || "");
      if (!file || !isValidMemoryFilename(file)) {
        res.status(400).json({ error: "Invalid file path" });
        return;
      }
      let fullPath: string;
      try {
        fullPath = resolveMemoryPath(file);
      } catch {
        res.status(400).json({ error: "Invalid file path" });
        return;
      }
      const { content, exists } = readMemoryFile(fullPath);
      if (!exists) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }
      const rel = getRelativePath(fullPath);
      const { metadata, body } = parseFrontmatter(content);
      const graph = scanGraph();
      const html = renderMemoryHtml(body, graph.entries);

      // Outgoing links + backlinks come from the precomputed graph (O(1)). If the
      // file isn't in the cached scan yet (created within the current TTL window),
      // resolve its outgoing links on the fly; backlinks are simply empty until
      // the next scan, which is correct — a brand-new file has none.
      let related = graph.outgoing.get(rel);
      if (!related) {
        const outgoing = new Map<string, string>();
        for (const p of normalizeRelated((metadata as any).related)) {
          const t = resolveLink(p, graph.entries) || p;
          outgoing.set(t, graph.byFile.get(t)?.name || p);
        }
        related = Array.from(outgoing, ([file, name]) => ({ file, name }));
      }
      const backlinks = graph.backlinks.get(rel) ?? [];

      res.json({ file: rel, meta: metadata, html, related, backlinks });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // Wiki index: categories (by top-level folder) + daily-log calendar.
  router.get("/api/wiki/index", (_req, res) => {
    try {
      const store = scanStore();
      const categories: Record<
        string,
        Array<{ file: string; name: string; importance: number }>
      > = {};
      const daily: Array<{ date: string; file: string }> = [];
      for (const e of store) {
        if (e.file === "MEMORY_INDEX.md") continue;
        if (e.file.startsWith("daily/")) {
          daily.push({ date: path.basename(e.file, ".md"), file: e.file });
          continue;
        }
        const cat = e.file.includes("/") ? e.file.split("/")[0] : "root";
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push({ file: e.file, name: e.name, importance: e.importance });
      }
      for (const cat of Object.keys(categories)) {
        categories[cat].sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name));
      }
      daily.sort((a, b) => b.date.localeCompare(a.date));
      res.json({ categories, daily });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // Append-only "add context": append a timestamped note to any memory.
  router.post("/api/memory/annotate", async (req, res) => {
    try {
      const file = String(req.body?.file || "");
      const text = String(req.body?.text || "").trim();
      if (!file || !isValidMemoryFilename(file)) {
        res.status(400).json({ error: "Invalid file path" });
        return;
      }
      // MEMORY_INDEX.md is auto-generated (memory_index rebuilds it from
      // scratch), so a note appended there would be silently wiped — refuse it.
      if (file === "MEMORY_INDEX.md" || file.endsWith("/MEMORY_INDEX.md")) {
        res
          .status(400)
          .json({ error: "MEMORY_INDEX.md is auto-generated and cannot be annotated" });
        return;
      }
      if (!text) {
        res.status(400).json({ error: "Note text is required" });
        return;
      }
      if (Buffer.byteLength(text, "utf8") > 50 * 1024) {
        res.status(400).json({ error: "Note exceeds 50KB" });
        return;
      }
      let fullPath: string;
      try {
        fullPath = resolveMemoryPath(file);
      } catch {
        res.status(400).json({ error: "Invalid file path" });
        return;
      }
      const { exists } = readMemoryFile(fullPath);
      if (!exists) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }
      // Append-only: never rewrite existing content. Keep a multi-line note
      // inside the blockquote so it renders as a single annotation.
      const today = new Date().toISOString().slice(0, 10);
      const quoted = text.split("\n").join("\n> ");
      const block = `\n\n> **Note — ${today} (via dashboard):** ${quoted}\n`;
      createOrAppend(fullPath, block, block);
      bustScanCache(); // file changed on disk — invalidate now, before the index
      // rebuild (which can fail), so the wiki reflects the note
      await reindexFile(store, fullPath);
      res.json({ success: true });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── API: Data sources ────────────────────────────────────

  router.get("/api/sources", async (_req, res) => {
    try {
      const { registry } = await getCollector(store);
      const sources = registry.listSources();
      res.json(sources);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  router.post("/api/sources/:id/agree", async (req, res) => {
    try {
      const { registry } = await getCollector(store);
      registry.recordAgreement(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  router.post("/api/sources/:id/enable", async (req, res) => {
    try {
      const { registry, daemon } = await getCollector(store);
      const result = await registry.enableSource(req.params.id, req.body);
      if (result.success) daemon.syncPollTimers();
      res.json(result);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  router.post("/api/sources/:id/disable", async (req, res) => {
    try {
      const { registry, daemon } = await getCollector(store);
      const result = await registry.disableSource(req.params.id);
      if (result.success) daemon.syncPollTimers();
      res.json(result);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  router.post("/api/sources/:id/configure", async (req, res) => {
    try {
      const { registry } = await getCollector(store);
      const result = registry.updateSourceConfig(req.params.id, req.body);
      res.json(result);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  router.post("/api/sources/custom", async (req, res) => {
    try {
      const { registry } = await getCollector(store);
      const result = registry.addCustomSource(req.body);
      res.json(result);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  router.delete("/api/sources/custom/:id", async (req, res) => {
    try {
      const { registry, daemon } = await getCollector(store);
      const result = await registry.removeCustomSource(req.params.id);
      if (result.success) daemon.syncPollTimers();
      res.json(result);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── API: Collector status ────────────────────────────────

  router.get("/api/collector/status", async (_req, res) => {
    try {
      const { daemon } = await getCollector(store);
      const status = daemon.getStatus();
      res.json(status);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── API: Journal (daily log) ─────────────────────────────

  router.get("/api/journal", (_req, res) => {
    try {
      const dailyDir = path.join(MEMORIES_DIR, "daily");
      if (!fs.existsSync(dailyDir)) {
        res.json([]);
        return;
      }

      const files = fs
        .readdirSync(dailyDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 30);

      const logs = files.map((f) => {
        const content = fs.readFileSync(path.join(dailyDir, f), "utf-8");
        const { metadata, body } = parseFrontmatter(content);
        return {
          date: f.replace(".md", ""),
          name: metadata.name || f,
          content: body,
          importance: metadata.importance || 3,
        };
      });

      res.json(logs);
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  router.get("/api/journal/:date", (req, res) => {
    try {
      const dateStr = req.params.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        res.status(400).json({ error: "Invalid date format (YYYY-MM-DD)" });
        return;
      }
      const filePath = path.join(MEMORIES_DIR, "daily", `${dateStr}.md`);
      const { content, exists } = readMemoryFile(filePath);
      if (!exists) {
        res.json({ date: dateStr, content: "", exists: false });
        return;
      }
      const { metadata, body } = parseFrontmatter(content);
      res.json({ date: dateStr, content: body, metadata, exists: true });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  router.post("/api/journal", async (req, res) => {
    try {
      const { entry, date, mood, tags } = req.body;
      if (!entry || typeof entry !== "string" || entry.trim().length === 0) {
        res.status(400).json({ error: "Entry text is required" });
        return;
      }
      if (entry.length > 50000) {
        res.status(400).json({ error: "Entry too long (max 50,000 chars)" });
        return;
      }
      // mood and tags are written into the daily log's Markdown, so they are
      // held to what the page's own picker and tag box can produce. A newline
      // in either could forge a heading in the log; a non-array `tags` used to
      // reach .join() and throw.
      if (mood !== undefined && mood !== null && !JOURNAL_MOODS.has(mood)) {
        res.status(400).json({ error: "Invalid mood" });
        return;
      }
      if (
        tags !== undefined &&
        tags !== null &&
        !(
          Array.isArray(tags) &&
          tags.length <= 20 &&
          tags.every(
            (t: unknown) =>
              typeof t === "string" && t.length > 0 && t.length <= 50 && !/[\r\n]/.test(t),
          )
        )
      ) {
        res.status(400).json({ error: "Invalid tags (up to 20, each 1-50 chars, one line)" });
        return;
      }

      const today = date || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
        res.status(400).json({ error: "Invalid date format" });
        return;
      }

      const dailyDir = path.join(MEMORIES_DIR, "daily");
      fs.mkdirSync(dailyDir, { recursive: true });
      const dailyFile = path.join(dailyDir, `${today}.md`);

      // UTC, like the file's date: daily logs are UTC days everywhere in
      // Memoria. A server-local label made an evening entry west of UTC read
      // "09:00 PM" inside the NEXT day's log.
      const time = utcTimeLabel();

      // Format journal entry with optional mood and tags
      const moodTag = mood ? ` (${mood})` : "";
      const tagLine = tags?.length ? `\n*Tags: ${tags.join(", ")}*` : "";
      const journalEntry = `\n## ${time} — Journal${moodTag}\n\n${entry.trim()}${tagLine}\n`;

      const header = [
        "---",
        `name: Daily log ${today}`,
        `description: Journal and collected events for ${today}`,
        "type: session",
        "importance: 5",
        `created: ${today}`,
        `updated: ${today}`,
        `last_accessed: ${today}`,
        "access_count: 0",
        "tags: [daily, journal]",
        "origin: dashboard",
        "---",
        "",
        `# Daily Log — ${today}`,
        "",
      ].join("\n");
      // Created exclusively, else appended: the collector may be creating
      // today's log at the same moment (see createOrAppend).
      createOrAppend(dailyFile, header + journalEntry, journalEntry);

      // Daily log changed on disk — invalidate now, before the index rebuild
      // (which can fail), so the wiki index/calendar reflects the entry.
      bustScanCache();
      await reindexFile(store, dailyFile);

      res.json({ success: true, date: today, message: "Journal entry saved" });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── API: Reindex ─────────────────────────────────────────

  router.post("/api/reindex", async (_req, res) => {
    try {
      const files = getAllMemoryFiles();
      let totalChunks = 0;
      for (const f of files) {
        totalChunks += await reindexFile(store, f);
      }
      res.json({ files: files.length, chunks: totalChunks });
    } catch (err: any) {
      sendServerError(res, err);
    }
  });

  // ── Dashboard HTML ───────────────────────────────────────

  // The page's one inline <script> carries a fresh nonce per response, and
  // the CSP runs only that script: no inline on*= handlers, no injected
  // <script>, no javascript: URLs. It backs up escapeHtml rather than
  // replacing it, so a value that slips through unescaped still cannot
  // execute. Inline style attributes are everywhere in the page, so styles
  // stay 'unsafe-inline' — a far smaller risk than script.
  router.get("/", (_req, res) => {
    const nonce = randomBytes(16).toString("base64");
    res.set("Content-Security-Policy", dashboardCsp(nonce));
    res.type("html").send(DASHBOARD_HTML.replace("__CSP_NONCE__", nonce));
  });

  return router;
}

// ── Dashboard HTML (single-page app) ─────────────────────────

/** Content-Security-Policy for the dashboard page, given its script nonce. */
export function dashboardCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    // Memories can embed remote images in Markdown; keep them working.
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Link shown in the dashboard's About card. Forks/self-hosters can point it
// at their own repo or docs with MEMORIA_REPO_URL. Attribute-escaped because
// it is interpolated into an href.
const REPO_URL = (process.env.MEMORIA_REPO_URL || "https://github.com/Agripp87/memoria_mcp")
  .replace(/&/g, "&amp;")
  .replace(/"/g, "&quot;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Memoria Dashboard</title>
<style>
  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #232733;
    --border: #2e3347;
    --text: #e4e7f0;
    --text2: #8b90a5;
    --accent: #6c8cff;
    --accent2: #4a6bff;
    --green: #4ade80;
    --yellow: #fbbf24;
    --red: #f87171;
    --orange: #fb923c;
    --radius: 10px;
    --shadow: 0 2px 12px rgba(0,0,0,0.3);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Layout */
  .shell { display: flex; min-height: 100vh; }
  .sidebar {
    width: 220px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: 24px 0;
    flex-shrink: 0;
    position: sticky;
    top: 0;
    height: 100vh;
  }
  .sidebar h1 {
    font-size: 18px;
    font-weight: 700;
    padding: 0 20px 20px;
    letter-spacing: -0.3px;
    color: var(--accent);
  }
  .sidebar h1 span { color: var(--text2); font-weight: 400; font-size: 12px; display: block; margin-top: 2px; }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 20px;
    color: var(--text2);
    cursor: pointer;
    font-size: 14px;
    transition: all 0.15s;
    border-left: 3px solid transparent;
  }
  .nav-item:hover { color: var(--text); background: var(--surface2); }
  .nav-item.active {
    color: var(--accent);
    background: rgba(108,140,255,0.08);
    border-left-color: var(--accent);
    font-weight: 600;
  }
  .nav-item svg { width: 18px; height: 18px; flex-shrink: 0; }
  .main { flex: 1; padding: 32px; max-width: 960px; }
  .main h2 { font-size: 22px; font-weight: 700; margin-bottom: 20px; letter-spacing: -0.3px; }

  /* Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 16px;
  }
  .card h3 { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .stat-box { text-align: center; padding: 16px 8px; background: var(--surface2); border-radius: 8px; }
  .stat-box .num { font-size: 28px; font-weight: 700; color: var(--accent); }
  .stat-box .label { font-size: 12px; color: var(--text2); margin-top: 4px; }

  /* Source list */
  .source-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    background: var(--surface2);
    border-radius: 8px;
    margin-bottom: 8px;
    transition: all 0.15s;
  }
  .source-item:hover { border-color: var(--accent); }
  .source-info { flex: 1; }
  .source-name { font-weight: 600; font-size: 14px; }
  .source-desc { font-size: 12px; color: var(--text2); margin-top: 2px; }
  .source-meta { font-size: 11px; color: var(--text2); margin-top: 4px; display: flex; gap: 12px; flex-wrap: wrap; }
  .source-meta span { display: flex; align-items: center; gap: 3px; }

  /* Badges */
  .badge {
    display: inline-block;
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .badge-on { background: rgba(74,222,128,0.15); color: var(--green); }
  .badge-off { background: rgba(139,144,165,0.15); color: var(--text2); }
  .badge-err { background: rgba(248,113,113,0.15); color: var(--red); }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface2);
    color: var(--text);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn:hover { background: var(--border); }
  .btn-primary { background: var(--accent2); border-color: var(--accent2); color: #fff; }
  .btn-primary:hover { background: var(--accent); }
  .btn-danger { border-color: var(--red); color: var(--red); }
  .btn-danger:hover { background: rgba(248,113,113,0.15); }
  .btn-sm { padding: 5px 10px; font-size: 12px; }
  .btn-group { display: flex; gap: 6px; align-items: center; }

  /* Journal */
  .journal-editor {
    width: 100%;
    min-height: 180px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 14px;
    font-family: inherit;
    font-size: 14px;
    resize: vertical;
    outline: none;
    line-height: 1.6;
  }
  .journal-editor:focus { border-color: var(--accent); }
  .journal-editor::placeholder { color: var(--text2); }
  .journal-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 12px;
    flex-wrap: wrap;
    gap: 8px;
  }
  .mood-picker { display: flex; gap: 6px; }
  .mood-btn {
    width: 36px; height: 36px;
    border-radius: 50%;
    border: 2px solid var(--border);
    background: var(--surface2);
    font-size: 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }
  .mood-btn:hover { border-color: var(--accent); transform: scale(1.1); }
  .mood-btn.active { border-color: var(--accent); background: rgba(108,140,255,0.15); }
  .tag-input {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 6px 10px;
    font-size: 13px;
    outline: none;
    width: 200px;
  }
  .tag-input:focus { border-color: var(--accent); }

  /* Journal history */
  .journal-entry {
    padding: 14px 16px;
    background: var(--surface2);
    border-radius: 8px;
    margin-bottom: 8px;
  }
  .journal-entry-date { font-size: 12px; color: var(--accent); font-weight: 600; }
  .journal-entry-text { font-size: 14px; margin-top: 6px; line-height: 1.6; white-space: pre-wrap; }

  /* Config modal */
  .modal-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 24px;
    width: 500px;
    max-width: 90vw;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: var(--shadow);
  }
  .modal h3 { font-size: 16px; margin-bottom: 16px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; color: var(--text2); margin-bottom: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
  .field input, .field select, .field textarea {
    width: 100%;
    padding: 8px 10px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 13px;
    outline: none;
  }
  .field input:focus, .field select:focus, .field textarea:focus { border-color: var(--accent); }

  /* Toast */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    z-index: 200;
    animation: slideIn 0.3s;
    box-shadow: var(--shadow);
  }
  .toast-success { background: rgba(74,222,128,0.9); color: #000; }
  .toast-error { background: rgba(248,113,113,0.9); color: #fff; }
  @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

  /* Sections */
  .section { display: none; }
  .section.active { display: block; }

  /* Loading */
  .loading { text-align: center; padding: 40px; color: var(--text2); }
  .spin { animation: spin 1s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Responsive */
  @media (max-width: 768px) {
    .shell { flex-direction: column; }
    .sidebar { width: 100%; height: auto; position: static; display: flex; flex-wrap: wrap; padding: 12px; gap: 4px; border-right: none; border-bottom: 1px solid var(--border); }
    .sidebar h1 { width: 100%; padding: 0 8px 8px; }
    .nav-item { padding: 8px 14px; border-left: none; border-bottom: 2px solid transparent; }
    .nav-item.active { border-left-color: transparent; border-bottom-color: var(--accent); }
    .wiki-grid { grid-template-columns: 1fr !important; }
    .main { padding: 16px; }
  }
  /* Wiki */
  .wiki-grid { display:grid; grid-template-columns: 230px 1fr 230px; gap:16px; align-items:start; }
  .wiki-index, .wiki-meta { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:12px; font-size:13px; max-height:74vh; overflow:auto; }
  .wiki-page { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:20px 24px; min-height:320px; max-height:78vh; overflow:auto; line-height:1.6; }
  .wiki-empty { color:var(--text2); }
  .wiki-cat { font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text2); margin:12px 0 4px; }
  .wiki-link { display:block; padding:4px 6px; border-radius:6px; color:var(--text); cursor:pointer; text-decoration:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .wiki-link:hover { background:var(--surface2); }
  .wiki-link.active { background:var(--accent); color:#fff; }
  .wiki-search { width:100%; margin-bottom:8px; }
  .wiki-page h1,.wiki-page h2,.wiki-page h3,.wiki-page h4 { margin:0.8em 0 0.4em; line-height:1.3; }
  .wiki-page p { margin:0.6em 0; }
  .wiki-page ul,.wiki-page ol { margin:0.6em 0; padding-left:1.4em; }
  .wiki-page code { background:var(--surface2); padding:1px 5px; border-radius:4px; font-size:0.9em; }
  .wiki-page pre { background:var(--surface2); padding:12px; border-radius:8px; overflow:auto; }
  .wiki-page pre code { background:none; padding:0; }
  .wiki-page blockquote { border-left:3px solid var(--accent); margin:0.6em 0; padding:2px 12px; color:var(--text2); }
  .wiki-page a { color:var(--accent); }
  .wiki-page table { border-collapse:collapse; }
  .wiki-page th,.wiki-page td { border:1px solid var(--border); padding:4px 8px; }
  .wikilink { color:var(--accent); cursor:pointer; text-decoration:none; border-bottom:1px dotted var(--accent); }
  .wikilink-missing { color:var(--text2); border-bottom:1px dotted var(--text2); cursor:help; }
  .wiki-meta h4 { font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:var(--text2); margin:10px 0 6px; }
  .wiki-note-box { width:100%; min-height:64px; margin-top:6px; box-sizing:border-box; }
</style>
</head>
<body>
<div class="shell">
  <nav class="sidebar">
    <h1>Memoria <span>Memory Dashboard</span></h1>
    <div class="nav-item active" data-tab="overview">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      Overview
    </div>
    <div class="nav-item" data-tab="sources">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      Data Sources
    </div>
    <div class="nav-item" data-tab="journal">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
      Journal
    </div>
    <div class="nav-item" data-tab="memories">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      Memories
    </div>
    <div class="nav-item" data-tab="wiki">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2z"/><path d="M22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z"/></svg>
      Wiki
    </div>
    <div class="nav-item" data-tab="settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
      Settings
    </div>
  </nav>

  <main class="main">
    <!-- OVERVIEW -->
    <section id="tab-overview" class="section active">
      <h2>Overview</h2>
      <div class="stat-grid" id="stats-grid">
        <div class="stat-box"><div class="num" id="stat-files">-</div><div class="label">Memory Files</div></div>
        <div class="stat-box"><div class="num" id="stat-chunks">-</div><div class="label">Indexed Chunks</div></div>
        <div class="stat-box"><div class="num" id="stat-avg">-</div><div class="label">Avg Importance</div></div>
        <div class="stat-box"><div class="num" id="stat-stale">-</div><div class="label">Stale Files</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3>Collector Status</h3>
        <div id="collector-status"><span class="loading"><span class="spin">&#9696;</span> Loading...</span></div>
      </div>
      <div class="card">
        <h3>Recent Journal</h3>
        <div id="recent-journal"><span class="loading"><span class="spin">&#9696;</span> Loading...</span></div>
      </div>
    </section>

    <!-- SOURCES -->
    <section id="tab-sources" class="section">
      <h2>Data Sources</h2>
      <p style="color:var(--text2);font-size:13px;margin-bottom:16px">Enable data sources to collect memory context from your personal tools. All data is encrypted at rest.</p>
      <div id="sources-list"><span class="loading"><span class="spin">&#9696;</span> Loading...</span></div>
      <div style="margin-top:16px">
        <button class="btn btn-primary" data-action="show-add-custom">+ Add Custom Source</button>
      </div>
    </section>

    <!-- JOURNAL -->
    <section id="tab-journal" class="section">
      <h2>Daily Journal</h2>
      <p style="color:var(--text2);font-size:13px;margin-bottom:16px">Write journal entries to add personal context to your memory. These are stored in your daily log and used for reflection.</p>
      <textarea class="journal-editor" id="journal-input" placeholder="What's on your mind? Write about your day, thoughts, decisions, or anything you want to remember..."></textarea>
      <div class="journal-toolbar">
        <div style="display:flex;gap:12px;align-items:center">
          <div class="mood-picker">
            <button class="mood-btn" data-mood="great" title="Great">&#128513;</button>
            <button class="mood-btn" data-mood="good" title="Good">&#128578;</button>
            <button class="mood-btn" data-mood="neutral" title="Neutral">&#128528;</button>
            <button class="mood-btn" data-mood="tired" title="Tired">&#128564;</button>
            <button class="mood-btn" data-mood="stressed" title="Stressed">&#128556;</button>
          </div>
          <input class="tag-input" id="journal-tags" placeholder="Tags (comma-separated)">
        </div>
        <button class="btn btn-primary" data-action="save-journal">Save Entry</button>
      </div>
      <div style="margin-top:24px">
        <h3 style="font-size:14px;color:var(--text2);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px">Recent Entries</h3>
        <div id="journal-history"><span class="loading"><span class="spin">&#9696;</span> Loading...</span></div>
      </div>
    </section>

    <!-- MEMORIES -->
    <section id="tab-memories" class="section">
      <h2>Memories</h2>
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <input class="tag-input" style="flex:1;width:auto" id="search-input" placeholder="Search memories...">
        <button class="btn btn-primary" data-action="search-memories">Search</button>
        <button class="btn" data-action="load-memories">Show All</button>
      </div>
      <div id="memories-list"><span class="loading"><span class="spin">&#9696;</span> Loading...</span></div>
    </section>

    <!-- WIKI -->
    <section id="tab-wiki" class="section">
      <h2>Wiki</h2>
      <p style="color:var(--text2);font-size:13px;margin-bottom:12px">Browse the whole memory store as a cross-linked wiki. Click a memory to read it, follow related links &amp; backlinks, and add append-only notes for extra context.</p>
      <div class="wiki-grid">
        <aside class="wiki-index">
          <input class="tag-input wiki-search" id="wiki-search" placeholder="Search...">
          <div id="wiki-index-list"><span class="loading"><span class="spin">&#9696;</span> Loading...</span></div>
        </aside>
        <article class="wiki-page" id="wiki-page"><div class="wiki-empty">Select a memory on the left to start reading.</div></article>
        <aside class="wiki-meta" id="wiki-meta"></aside>
      </div>
    </section>

    <!-- SETTINGS -->
    <section id="tab-settings" class="section">
      <h2>Settings</h2>
      <div class="card">
        <h3>Index Management</h3>
        <p style="font-size:13px;color:var(--text2);margin-bottom:12px">Rebuild the search index from all memory files. Use after bulk edits or imports.</p>
        <button class="btn" id="reindex-btn" data-action="reindex">Rebuild Index</button>
      </div>
      <div class="card">
        <h3>Collector Buffer</h3>
        <div id="buffer-stats" style="font-size:13px;color:var(--text2)">Loading...</div>
      </div>
      <div class="card">
        <h3>About</h3>
        <p style="font-size:13px;color:var(--text2);line-height:1.6">
          Memoria is a persistent memory system for Claude AI.<br>
          13 MCP tools &middot; AES-256-GCM encryption &middot; Hybrid search<br>
          <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
        </p>
      </div>
    </section>
  </main>
</div>

<!-- Config Modal -->
<div class="modal-overlay" id="modal" style="display:none">
  <div class="modal" id="modal-content"></div>
</div>

<script nonce="__CSP_NONCE__">
const API = '/dashboard/api';
let currentMood = null;

// ── Navigation ─────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    item.classList.add('active');
    document.getElementById('tab-' + item.dataset.tab).classList.add('active');
    // Load data for tab
    const tab = item.dataset.tab;
    if (tab === 'overview') loadOverview();
    if (tab === 'sources') loadSources();
    if (tab === 'journal') loadJournal();
    if (tab === 'memories') loadMemories();
    if (tab === 'wiki') loadWiki();
    if (tab === 'settings') loadSettings();
  });
});

// ── Mood picker ────────────────────────────────────────────
document.querySelectorAll('.mood-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('active'));
    if (currentMood === btn.dataset.mood) { currentMood = null; }
    else { btn.classList.add('active'); currentMood = btn.dataset.mood; }
  });
});

// ── API helpers ────────────────────────────────────────────
// Auth is an httpOnly session cookie (set by POST /dashboard/login), never a
// key in localStorage — an XSS on this origin can no longer read the API key.
// The key is entered once and exchanged for the cookie.
async function dashLogin(key, silent = false) {
  try {
    const res = await fetch('/dashboard/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Trim: keys copied from a terminal often carry a stray newline/space
      // (the server trims too; this keeps the request honest either way).
      body: JSON.stringify({ key: key.trim() }),
    });
    if (res.ok) return true;
    // A rate-limited attempt is NOT a wrong key — telling the user to retype
    // it would only burn more attempts against the same limiter window.
    if (!silent) {
      if (res.status === 429) {
        toast('Too many login attempts — wait a minute, then try again.', 'error');
      } else {
        toast('Invalid API key — paste the exact key with nothing before or after it.', 'error');
      }
    }
    return false;
  } catch (e) {
    if (!silent) toast('Login request failed — check your connection and retry.', 'error');
    return false;
  }
}

async function ensureSession() {
  // Migration: older dashboards stored the raw key in localStorage. Use it to
  // mint a cookie session once, then remove it from JS-readable storage
  // regardless of outcome. Silent: a stale legacy key failing is expected and
  // shouldn't flash an error before the user has even been prompted.
  const legacy = localStorage.getItem('memoria_token');
  if (legacy) {
    localStorage.removeItem('memoria_token');
    if (await dashLogin(legacy, true)) return true;
  }
  const key = prompt('Enter your Memoria API key (exchanged for a secure session cookie):');
  if (key) return dashLogin(key);
  return false;
}

async function api(endpoint, options = {}, retried = false) {
  const res = await fetch(API + endpoint, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (res.status === 401) {
    // Re-auth at most ONCE: a wrong key must not trap the user in an infinite
    // prompt loop / unbounded recursion.
    if (!retried && await ensureSession()) {
      return api(endpoint, options, true);
    }
    throw new Error('Unauthorized — check your API key');
  }
  return res.json();
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Overview ───────────────────────────────────────────────
async function loadOverview() {
  try {
    const stats = await api('/stats');
    document.getElementById('stat-files').textContent = stats.fileCount || 0;
    document.getElementById('stat-chunks').textContent = stats.totalChunks || 0;
    document.getElementById('stat-avg').textContent = stats.avgImportance || '-';
    document.getElementById('stat-stale').textContent = stats.staleCount || 0;
  } catch {}

  try {
    const status = await api('/collector/status');
    const el = document.getElementById('collector-status');
    const running = status.running ? '<span class="badge badge-on">Running</span>' : '<span class="badge badge-off">Stopped</span>';
    const timers = (status.pollTimers || []).map(t =>
      '<div style="font-size:12px;margin-top:4px;color:var(--text2)">' +
      escapeHtml(t.sourceId) + ': every ' + (t.intervalMs/1000) + 's' +
      (t.inBackoff ? ' <span class="badge badge-err">backoff</span>' : ' <span class="badge badge-on">ok</span>') +
      '</div>'
    ).join('');
    el.innerHTML = running + ' &middot; ' + escapeHtml(String(status.activeSources)) + ' active source(s)' + timers;
  } catch { document.getElementById('collector-status').innerHTML = '<span class="badge badge-off">Not running</span>'; }

  try {
    const logs = await api('/journal');
    const el = document.getElementById('recent-journal');
    if (!logs.length) { el.innerHTML = '<span style="color:var(--text2);font-size:13px">No journal entries yet. Go to Journal to write your first entry.</span>'; return; }
    el.innerHTML = logs.slice(0, 3).map(l =>
      '<div class="journal-entry"><div class="journal-entry-date">' + escapeHtml(l.date) + '</div>' +
      '<div class="journal-entry-text">' + escapeHtml(l.content.slice(0, 300)) + (l.content.length > 300 ? '...' : '') + '</div></div>'
    ).join('');
  } catch {}
}

// ── Sources ────────────────────────────────────────────────
async function loadSources() {
  try {
    const sources = await api('/sources');
    const el = document.getElementById('sources-list');
    if (!sources.length) { el.innerHTML = '<span style="color:var(--text2)">No sources registered.</span>'; return; }
    el.innerHTML = sources.map(s => {
      const badge = s.error ? '<span class="badge badge-err">Error</span>' :
                    s.enabled ? '<span class="badge badge-on">Enabled</span>' :
                    '<span class="badge badge-off">Disabled</span>';
      const actions = s.enabled
        ? '<button class="btn btn-sm btn-danger" data-action="disable-source" data-id="' + escapeHtml(s.id) + '">Disable</button>'
        : '<button class="btn btn-sm btn-primary" data-action="enable-source" data-id="' + escapeHtml(s.id) + '">Enable</button>';
      return '<div class="source-item">' +
        '<div class="source-info">' +
          '<div class="source-name">' + escapeHtml(s.name) + ' ' + badge + '</div>' +
          '<div class="source-desc">' + escapeHtml(s.description) + '</div>' +
          '<div class="source-meta">' +
            '<span>ID: ' + escapeHtml(s.id) + '</span>' +
            '<span>Events: ' + escapeHtml(String(s.eventCount)) + '</span>' +
            '<span>Platforms: ' + escapeHtml((s.platforms || []).join(', ')) + '</span>' +
            (s.lastPoll ? '<span>Last: ' + new Date(s.lastPoll).toLocaleTimeString() + '</span>' : '') +
            (s.error ? '<span style="color:var(--red)">' + escapeHtml(s.error) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="btn-group">' +
          '<button class="btn btn-sm" data-action="configure-source" data-id="' + escapeHtml(s.id) + '">Configure</button>' +
          actions +
        '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    document.getElementById('sources-list').innerHTML = '<span style="color:var(--red)">Failed to load sources: ' + escapeHtml(err && err.message) + '</span>';
  }
}

async function enableSource(id) {
  // First check agreement
  const sources = await api('/sources');
  const source = sources.find(s => s.id === id);
  if (!source) return;

  const agreed = confirm(
    'Enable "' + source.name + '"?\\n\\n' +
    'This source will collect: ' + source.description + '\\n' +
    'Permissions: ' + (source.requiredPermissions.join(', ') || 'none') + '\\n\\n' +
    'All collected data is encrypted (AES-256-GCM). Only you and the Memoria agent have access.\\n\\n' +
    'Click OK to agree and enable.'
  );
  if (!agreed) return;

  await api('/sources/' + id + '/agree', { method: 'POST' });

  // Check if it needs config (Google adapters, email)
  if (id.startsWith('google-') || id === 'email') {
    configureSource(id, true);
    return;
  }

  const result = await api('/sources/' + id + '/enable', { method: 'POST' });
  toast(result.message, result.success ? 'success' : 'error');
  loadSources();
}

async function toggleSource(id, enable) {
  const endpoint = enable ? '/enable' : '/disable';
  const result = await api('/sources/' + id + endpoint, { method: 'POST' });
  toast(result.message, result.success ? 'success' : 'error');
  loadSources();
}

function configureSource(id, enableAfter = false) {
  const isGoogle = id.startsWith('google-');
  const isEmail = id === 'email';

  let fields = '';
  if (isGoogle) {
    fields = \`
      <div class="field"><label>Google Client ID</label><input id="cfg-client-id" placeholder="xxx.apps.googleusercontent.com"></div>
      <div class="field"><label>Google Client Secret</label><input id="cfg-client-secret" type="password"></div>
      <div class="field"><label>Google Refresh Token</label><input id="cfg-refresh-token" type="password"></div>
    \`;
    if (id === 'google-gmail') {
      fields += '<div class="field"><label>Labels (comma-separated)</label><input id="cfg-labels" value="INBOX"></div>';
      fields += '<div class="field"><label>Exclude Labels</label><input id="cfg-exclude" value="SPAM,TRASH,PROMOTIONS"></div>';
    } else if (id === 'google-calendar') {
      fields += '<div class="field"><label>Calendar IDs (comma-separated)</label><input id="cfg-cal-ids" value="primary"></div>';
      fields += '<div class="field"><label>Look Ahead Days</label><input id="cfg-ahead" type="number" value="7"></div>';
    } else if (id === 'google-drive') {
      fields += '<div class="field"><label>Folder IDs (comma-separated)</label><input id="cfg-folder-ids" placeholder="Leave empty for all"></div>';
      fields += '<div class="field"><label>Include Content</label><select id="cfg-content"><option value="true">Yes</option><option value="false">No</option></select></div>';
    }
  } else if (isEmail) {
    fields = \`
      <div class="field"><label>IMAP Host</label><input id="cfg-host" placeholder="imap.gmail.com"></div>
      <div class="field"><label>Port</label><input id="cfg-port" type="number" value="993"></div>
      <div class="field"><label>Username / Email</label><input id="cfg-user"></div>
      <div class="field"><label>App Password</label><input id="cfg-pass" type="password"></div>
    \`;
  } else {
    fields = '<div class="field"><label>Poll Interval (seconds)</label><input id="cfg-interval" type="number" value="60"></div>';
    fields += '<div class="field"><label>Importance Threshold (1-10)</label><input id="cfg-threshold" type="number" value="3" min="1" max="10"></div>';
  }

  document.getElementById('modal-content').innerHTML = \`
    <h3>Configure: \${escapeHtml(id)}</h3>
    \${fields}
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn" data-action="close-modal">Cancel</button>
      <button class="btn btn-primary" data-action="save-config" data-id="\${escapeHtml(id)}" data-enable-after="\${enableAfter ? 'true' : 'false'}">Save\${enableAfter ? ' &amp; Enable' : ''}</button>
    </div>
  \`;
  document.getElementById('modal').style.display = 'flex';
}

async function saveConfig(id, enableAfter) {
  const config = {};
  const isGoogle = id.startsWith('google-');

  if (isGoogle) {
    config.google_client_id = document.getElementById('cfg-client-id')?.value || '';
    config.google_client_secret = document.getElementById('cfg-client-secret')?.value || '';
    config.google_refresh_token = document.getElementById('cfg-refresh-token')?.value || '';

    if (id === 'google-gmail') {
      config.labels = (document.getElementById('cfg-labels')?.value || 'INBOX').split(',').map(s => s.trim());
      config.excludeLabels = (document.getElementById('cfg-exclude')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    } else if (id === 'google-calendar') {
      config.calendarIds = (document.getElementById('cfg-cal-ids')?.value || 'primary').split(',').map(s => s.trim());
      config.lookAheadDays = parseInt(document.getElementById('cfg-ahead')?.value || '7');
    } else if (id === 'google-drive') {
      const ids = document.getElementById('cfg-folder-ids')?.value || '';
      config.folderIds = ids ? ids.split(',').map(s => s.trim()) : [];
      config.includeContent = document.getElementById('cfg-content')?.value === 'true';
    }
  } else if (id === 'email') {
    config.host = document.getElementById('cfg-host')?.value || '';
    config.port = parseInt(document.getElementById('cfg-port')?.value || '993');
    config.user = document.getElementById('cfg-user')?.value || '';
    config.password = document.getElementById('cfg-pass')?.value || '';
  } else {
    const interval = parseInt(document.getElementById('cfg-interval')?.value, 10);
    const threshold = parseInt(document.getElementById('cfg-threshold')?.value, 10);
    if (Number.isFinite(interval) && interval >= 10) config.pollIntervalSec = interval;
    if (Number.isFinite(threshold) && threshold >= 1 && threshold <= 10) config.importanceThreshold = threshold;
  }

  closeModal();

  if (enableAfter) {
    const result = await api('/sources/' + id + '/enable', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    toast(result.message, result.success ? 'success' : 'error');
  } else {
    const result = await api('/sources/' + id + '/configure', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    toast(result.message, result.success ? 'success' : 'error');
  }
  loadSources();
}

function showAddCustomModal() {
  document.getElementById('modal-content').innerHTML = \`
    <h3>Add Custom Source</h3>
    <div class="field"><label>Source ID</label><input id="custom-id" placeholder="my-source (lowercase, hyphens ok)"></div>
    <div class="field"><label>Name</label><input id="custom-name" placeholder="My Custom Source"></div>
    <div class="field"><label>Description</label><input id="custom-desc" placeholder="What does this source collect?"></div>
    <div class="field"><label>Mode</label>
      <select id="custom-mode">
        <option value="file_watcher">File Watcher</option>
        <option value="shell_command">Shell Command</option>
      </select>
    </div>
    <div id="custom-mode-fields"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="btn" data-action="close-modal">Cancel</button>
      <button class="btn btn-primary" data-action="add-custom-source">Add Source</button>
    </div>
  \`;
  updateCustomFields();
  document.getElementById('modal').style.display = 'flex';
}

function updateCustomFields() {
  const mode = document.getElementById('custom-mode').value;
  const el = document.getElementById('custom-mode-fields');
  if (mode === 'file_watcher') {
    el.innerHTML = \`
      <div class="field"><label>Watch Path</label><input id="custom-path" placeholder="/path/to/file.json"></div>
      <div class="field"><label>File Format</label><select id="custom-format"><option value="json">JSON</option><option value="csv">CSV</option><option value="lines">Plain Text (lines)</option></select></div>
      <div class="field"><label>JSON Path (optional)</label><input id="custom-jsonpath" placeholder="data.events"></div>
    \`;
  } else if (mode === 'shell_command') {
    el.innerHTML = '<div class="field"><label>Command</label><input id="custom-cmd" placeholder="curl -s https://api.example.com/data"></div>';
  } else {
    el.innerHTML = '<div class="field"><label>Webhook Path</label><input id="custom-webhook" placeholder="/webhook/my-source"></div>';
  }
}

async function addCustomSource() {
  const mode = document.getElementById('custom-mode').value;
  const def = {
    id: document.getElementById('custom-id').value.trim(),
    name: document.getElementById('custom-name').value.trim(),
    description: document.getElementById('custom-desc').value.trim(),
    mode,
  };
  if (mode === 'file_watcher') {
    def.watchPath = document.getElementById('custom-path')?.value;
    def.fileFormat = document.getElementById('custom-format')?.value;
    def.jsonPath = document.getElementById('custom-jsonpath')?.value || undefined;
  } else if (mode === 'shell_command') {
    def.command = document.getElementById('custom-cmd')?.value;
  } else {
    def.webhookPath = document.getElementById('custom-webhook')?.value;
  }

  closeModal();
  const result = await api('/sources/custom', { method: 'POST', body: JSON.stringify(def) });
  toast(result.message, result.success ? 'success' : 'error');
  loadSources();
}

// ── Journal ────────────────────────────────────────────────
async function loadJournal() {
  try {
    const logs = await api('/journal');
    const el = document.getElementById('journal-history');
    if (!logs.length) { el.innerHTML = '<span style="color:var(--text2);font-size:13px">No entries yet.</span>'; return; }
    el.innerHTML = logs.map(l =>
      '<div class="journal-entry">' +
        '<div class="journal-entry-date">' + escapeHtml(l.date) + '</div>' +
        '<div class="journal-entry-text">' + escapeHtml(l.content) + '</div>' +
      '</div>'
    ).join('');
  } catch {}
}

async function saveJournal() {
  const input = document.getElementById('journal-input');
  const tagsInput = document.getElementById('journal-tags');
  const entry = input.value.trim();
  if (!entry) { toast('Write something first', 'error'); return; }

  const tags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
  const result = await api('/journal', {
    method: 'POST',
    body: JSON.stringify({ entry, mood: currentMood, tags }),
  });

  if (result.success) {
    toast('Journal entry saved');
    input.value = '';
    tagsInput.value = '';
    currentMood = null;
    document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('active'));
    loadJournal();
  } else {
    toast(result.error || 'Failed to save', 'error');
  }
}

// ── Memories ───────────────────────────────────────────────
async function loadMemories() {
  try {
    const memories = await api('/memories');
    renderMemories(memories);
  } catch {}
}

async function searchMemories() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) { loadMemories(); return; }
  try {
    const results = await api('/search?q=' + encodeURIComponent(query));
    const el = document.getElementById('memories-list');
    if (!results.length) { el.innerHTML = '<span style="color:var(--text2)">No results found.</span>'; return; }
    el.innerHTML = results.map(r =>
      '<div class="source-item" style="flex-direction:column;align-items:flex-start">' +
        '<div class="source-name">' + escapeHtml(r.file) + ' <span style="color:var(--text2);font-size:12px">score: ' + r.score.toFixed(3) + '</span></div>' +
        '<div style="font-size:13px;margin-top:6px;color:var(--text2);white-space:pre-wrap">' + escapeHtml(r.text.slice(0, 300)) + '</div>' +
      '</div>'
    ).join('');
  } catch {}
}

function renderMemories(memories) {
  const el = document.getElementById('memories-list');
  if (!memories.length) { el.innerHTML = '<span style="color:var(--text2)">No memories stored yet.</span>'; return; }
  el.innerHTML = memories.map(m => {
    const imp = m.importance >= 7 ? 'color:var(--accent)' : m.importance >= 4 ? 'color:var(--yellow)' : 'color:var(--text2)';
    return '<div class="source-item">' +
      '<div class="source-info">' +
        '<div class="source-name">' + escapeHtml(m.name) + '</div>' +
        '<div class="source-meta">' +
          '<span style="' + imp + '">Importance: ' + escapeHtml(String(m.importance)) + '</span>' +
          '<span>Type: ' + escapeHtml(m.type) + '</span>' +
          '<span>Updated: ' + escapeHtml(m.updated) + '</span>' +
          (m.tags.length ? '<span>Tags: ' + escapeHtml(m.tags.join(', ')) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text2)">' + escapeHtml(m.file) + '</div>' +
    '</div>';
  }).join('');
}

// ── Settings ───────────────────────────────────────────────
async function loadSettings() {
  try {
    const status = await api('/collector/status');
    const bs = status.bufferStats || {};
    document.getElementById('buffer-stats').innerHTML =
      'Total: ' + (bs.totalEvents || 0) + ' events &middot; ' +
      'Unsynced: ' + (bs.unsyncedEvents || 0) + ' &middot; ' +
      'Size: ' + ((bs.bufferSizeBytes || 0) / 1024).toFixed(1) + ' KB';
  } catch {
    document.getElementById('buffer-stats').textContent = 'Collector not running';
  }
}

async function reindex() {
  const btn = document.getElementById('reindex-btn');
  btn.textContent = 'Rebuilding...';
  btn.disabled = true;
  try {
    const result = await api('/reindex', { method: 'POST' });
    toast('Indexed ' + result.files + ' files (' + result.chunks + ' chunks)');
  } catch (err) {
    toast('Reindex failed: ' + err.message, 'error');
  }
  btn.textContent = 'Rebuild Index';
  btn.disabled = false;
}

// ── Utils ──────────────────────────────────────────────────
function closeModal() { document.getElementById('modal').style.display = 'none'; }
// ── Wiki ───────────────────────────────────────────────────
async function loadWiki() {
  const el = document.getElementById('wiki-index-list');
  try {
    const idx = await api('/wiki/index');
    let h = '';
    const cats = idx.categories || {};
    for (const cat of Object.keys(cats).sort()) {
      h += '<div class="wiki-cat">' + escapeHtml(cat) + '</div>';
      for (const m of cats[cat]) {
        h += '<a class="wiki-link" data-file="' + escapeHtml(m.file) + '" data-action="open-wiki">' + escapeHtml(m.name) + '</a>';
      }
    }
    if ((idx.daily || []).length) {
      h += '<div class="wiki-cat">Daily logs</div>';
      for (const d of idx.daily.slice(0, 90)) {
        h += '<a class="wiki-link" data-file="' + escapeHtml(d.file) + '" data-action="open-wiki">' + escapeHtml(d.date) + '</a>';
      }
    }
    el.innerHTML = h;
  } catch (err) {
    el.innerHTML = '<span style="color:var(--red)">Failed to load index: ' + escapeHtml(err && err.message) + '</span>';
  }
}

async function wikiSearch() {
  const input = document.getElementById('wiki-search');
  const q = (input && input.value || '').trim();
  if (!q) { loadWiki(); return; }
  const el = document.getElementById('wiki-index-list');
  try {
    const results = await api('/search?q=' + encodeURIComponent(q));
    let h = '';
    h += '<div class="wiki-cat">Results</div>';
    const seen = {};
    for (const r of (results || [])) {
      if (!r.file || seen[r.file]) continue; seen[r.file] = 1;
      h += '<a class="wiki-link" data-file="' + escapeHtml(r.file) + '" data-action="open-wiki">' + escapeHtml(r.file) + '</a>';
    }
    if (!Object.keys(seen).length) h += '<div style="color:var(--text2);padding:4px 6px">No results</div>';
    el.innerHTML = h;
  } catch {}
}

async function openWikiPage(file) {
  const page = document.getElementById('wiki-page');
  const meta = document.getElementById('wiki-meta');
  page.innerHTML = '<span class="loading"><span class="spin">&#9696;</span> Loading...</span>';
  meta.innerHTML = '';
  try {
    const doc = await api('/memory?file=' + encodeURIComponent(file));
    if (!doc || doc.error) { page.innerHTML = '<div class="wiki-empty">' + escapeHtml((doc && doc.error) || 'Not found') + '</div>'; return; }
    document.querySelectorAll('.wiki-link').forEach(a => a.classList.toggle('active', a.dataset.file === doc.file));
    // doc.html is server-rendered with markdown-it html:false — safe to inject.
    page.innerHTML = '<div style="font-size:12px;color:var(--text2);margin-bottom:8px">' + escapeHtml(doc.file) + '</div>' + doc.html;
    const m = doc.meta || {};
    let mh = '<h4>Details</h4>';
    mh += wikiMetaRow('Name', m.name);
    mh += wikiMetaRow('Type', m.type);
    mh += wikiMetaRow('Importance', m.importance);
    mh += wikiMetaRow('Updated', m.updated);
    mh += wikiMetaRow('Tags', Array.isArray(m.tags) ? m.tags.join(', ') : m.tags);
    if (m.valid_from || m.valid_until) mh += wikiMetaRow('Valid', (m.valid_from || '') + ' -> ' + (m.valid_until || '(now)'));
    mh += '<h4>Related</h4>' + wikiLinkList(doc.related);
    mh += '<h4>Backlinks</h4>' + wikiLinkList(doc.backlinks);
    mh += '<h4>Add note (append-only)</h4>';
    mh += '<textarea class="tag-input wiki-note-box" id="wiki-note" placeholder="Add context... supports [[links]]"></textarea>';
    mh += '<button class="btn btn-primary" style="margin-top:6px;width:100%" data-file="' + escapeHtml(doc.file) + '" data-action="add-wiki-note">Append note</button>';
    meta.innerHTML = mh;
  } catch (err) {
    page.innerHTML = '<div class="wiki-empty">Failed to load: ' + escapeHtml(err && err.message) + '</div>';
  }
}

function wikiMetaRow(label, val) {
  if (val === undefined || val === null || val === '') return '';
  return '<div style="margin-bottom:4px"><span style="color:var(--text2)">' + escapeHtml(label) + ':</span> ' + escapeHtml(String(val)) + '</div>';
}

function wikiLinkList(items) {
  if (!items || !items.length) return '<div style="color:var(--text2);font-size:12px">None</div>';
  return items.map(it => '<a class="wiki-link" data-file="' + escapeHtml(it.file) + '" data-action="open-wiki">' + escapeHtml(it.name || it.file) + '</a>').join('');
}

async function addWikiNote(file) {
  const ta = document.getElementById('wiki-note');
  const text = (ta && ta.value || '').trim();
  if (!text) { toast('Note is empty', 'error'); return; }
  try {
    const r = await api('/memory/annotate', { method: 'POST', body: JSON.stringify({ file: file, text: text }) });
    if (r && r.success) { toast('Note appended'); openWikiPage(file); }
    else toast((r && r.error) || 'Failed to add note', 'error');
  } catch (err) { toast('Failed: ' + (err && err.message), 'error'); }
}

// In-wiki [[links]] are anchors carrying data-wikilink-file; intercept clicks.
document.addEventListener('click', function (e) {
  const a = e.target && e.target.closest && e.target.closest('a.wikilink[data-wikilink-file]');
  if (a) { e.preventDefault(); openWikiPage(a.getAttribute('data-wikilink-file')); }
});

// Every button and link declares data-action and gets its arguments from
// data-* attributes, dispatched here. There are no inline on*= handlers: the
// page's Content-Security-Policy forbids them, so an injected attribute cannot
// run script even if something slips past escapeHtml.
const ACTIONS = {
  'open-wiki': el => openWikiPage(el.dataset.file),
  'add-wiki-note': el => addWikiNote(el.dataset.file),
  'enable-source': el => enableSource(el.dataset.id),
  'disable-source': el => toggleSource(el.dataset.id, false),
  'configure-source': el => configureSource(el.dataset.id),
  'save-config': el => saveConfig(el.dataset.id, el.dataset.enableAfter === 'true'),
  'close-modal': () => closeModal(),
  'show-add-custom': () => showAddCustomModal(),
  'add-custom-source': () => addCustomSource(),
  'save-journal': () => saveJournal(),
  'search-memories': () => searchMemories(),
  'load-memories': () => loadMemories(),
  'reindex': () => reindex(),
};
document.addEventListener('click', function (e) {
  const el = e.target && e.target.closest && e.target.closest('[data-action]');
  if (!el || !Object.prototype.hasOwnProperty.call(ACTIONS, el.dataset.action)) return;
  e.preventDefault();
  ACTIONS[el.dataset.action](el);
});
document.addEventListener('change', function (e) {
  if (e.target && e.target.id === 'custom-mode') updateCustomFields();
});
document.getElementById('modal').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});
document.getElementById('search-input').addEventListener('keyup', function (e) {
  if (e.key === 'Enter') searchMemories();
});
document.getElementById('wiki-search').addEventListener('keyup', function (e) {
  if (e.key === 'Enter') wikiSearch();
});

// Escapes all five HTML-significant characters, so the result is safe in text
// AND in a quoted attribute. The previous DOM-based version (textContent in,
// innerHTML out) left quotes alone, and values from memory frontmatter went
// into data-file="..." attributes, so a crafted value could break out of one.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

// ── Init ───────────────────────────────────────────────────
loadOverview();
</script>
</body>
</html>`;
