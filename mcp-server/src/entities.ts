/**
 * Entity-page compilation — the "compile, don't retrieve" loop (Karpathy rule IV).
 *
 * The collector firehose lands in dated daily logs (a pile that grows). This
 * module compiles those scattered events into durable, linked **entity pages**:
 * one page per source/entity that always reflects the latest rollup at a stable
 * URL, links back to the daily logs it was built from (rule VI), and is listed
 * in the index (rule VII). Re-running regenerates in place, so knowledge
 * *compounds* instead of accumulating.
 *
 * Deterministic by design (no LLM): it groups by the `source` field, which is
 * the one reliable signal in a daily log. True semantic synthesis is still the
 * job of the agent via memory_compact -> memory_compile; this is the mechanical
 * compaction a background scheduler can do on its own.
 *
 * Privacy: entity pages are built only from daily-log content, which has already
 * been privacy-enforced at ingestion time. No raw/source data is read here.
 */

import { createHash } from "node:crypto";
import fs from "fs";
import path from "path";
import { parseFrontmatter } from "./chunker.js";
import { TIME_LABEL_SRC } from "./daily-format.js";
import { writeFileAtomic } from "./atomic-fs.js";
import { listDailyLogNames } from "./daily-paths.js";

/** Marker placed in entity-page frontmatter so we only ever overwrite our own
 * generated files — never something a human took over. */
export const GENERATED_MARKER = "auto-compiled";

export interface BuildEntitiesOptions {
  /** How many recent daily logs to roll up (default 30). */
  days?: number;
  /** Minimum events from a source before it earns a page (default 3). */
  minEvents?: number;
  /** If set, only (re)build pages for these source names — used by the
   * ingest-driven propagation queue so a new fact refreshes just the pages it
   * touches, not the whole store. */
  onlySources?: string[];
}

export interface BuildEntitiesResult {
  written: string[]; // relative paths of pages created/updated
  skipped: string[]; // pages skipped because a human took them over
  sourcesSeen: number; // distinct sources found in the window
  eventsScanned: number;
}

interface EntityEvent {
  date: string;
  time: string;
  source: string;
  content: string;
  importance: number;
}

interface EntityAgg {
  source: string;
  events: EntityEvent[];
  patterns: Map<string, number>; // first-100-chars fingerprint -> count
  days: Set<string>;
  maxImportance: number;
  firstSeen: string;
  lastSeen: string;
}

// Mirrors the daily-entry shape written by the collector / memory_daily:
//   ## TIME — SOURCE *(optional note)*
//   <body...>
//   *importance: N | privacy: ...*
const ENTRY_RE = new RegExp(
  String.raw`## (${TIME_LABEL_SRC}) — ([\w-]+)(?:\s*\*\([^)]+\)\*)?\s*\n([\s\S]*?)(?=\n## |$)`,
  "g",
);

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "source"
  );
}

/** Read recent daily logs and group their events by source. */
function aggregate(
  memoriesDir: string,
  days: number,
): {
  bySource: Map<string, EntityAgg>;
  eventsScanned: number;
} {
  const dailyDir = path.join(memoriesDir, "daily");
  const bySource = new Map<string, EntityAgg>();
  let eventsScanned = 0;
  if (!fs.existsSync(dailyDir)) return { bySource, eventsScanned };

  const files = listDailyLogNames(memoriesDir).sort().reverse().slice(0, days).reverse(); // chronological so firstSeen/lastSeen are correct

  for (const file of files) {
    const date = path.basename(file, ".md");
    const content = fs.readFileSync(path.join(dailyDir, file), "utf-8");
    let m: RegExpExecArray | null;
    ENTRY_RE.lastIndex = 0;
    while ((m = ENTRY_RE.exec(content)) !== null) {
      const [, time, source, rawBody] = m;
      const impMatch = rawBody.match(/\*importance:\s*(\d+)/);
      const importance = impMatch ? parseInt(impMatch[1], 10) : 5;
      const body = rawBody
        .replace(/\n>.*$/gm, "") // drop meta blockquote lines
        .replace(/\*importance:.*$/m, "")
        .trim();
      eventsScanned++;

      let agg = bySource.get(source);
      if (!agg) {
        agg = {
          source,
          events: [],
          patterns: new Map(),
          days: new Set(),
          maxImportance: 0,
          firstSeen: date,
          lastSeen: date,
        };
        bySource.set(source, agg);
      }
      agg.events.push({ date, time: time.trim(), source, content: body, importance });
      const fp = body.slice(0, 100);
      agg.patterns.set(fp, (agg.patterns.get(fp) || 0) + 1);
      agg.days.add(date);
      agg.maxImportance = Math.max(agg.maxImportance, importance);
      if (date < agg.firstSeen) agg.firstSeen = date;
      if (date > agg.lastSeen) agg.lastSeen = date;
    }
  }

  return { bySource, eventsScanned };
}

function escapeYaml(s: string): string {
  // Quote if it contains YAML-significant chars; escape embedded quotes.
  if (/[:#[\]{}&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function renderPage(agg: EntityAgg, today: string): string {
  const importance = Math.max(4, Math.min(7, agg.maxImportance || 4));
  const distinctPatterns = agg.patterns.size;
  const dedupRatio =
    agg.events.length > 0 ? Math.round((1 - distinctPatterns / agg.events.length) * 100) : 0;

  const fm = [
    "---",
    `name: ${escapeYaml(`${agg.source} — activity rollup`)}`,
    `description: ${escapeYaml(
      `Auto-compiled rollup of ${agg.events.length} events from "${agg.source}" (${agg.firstSeen}→${agg.lastSeen}).`,
    )}`,
    "type: source-rollup",
    `source: ${escapeYaml(agg.source)}`,
    `importance: ${importance}`,
    `created: ${today}`,
    `updated: ${today}`,
    `last_accessed: ${today}`,
    "access_count: 0",
    `tags: [source-rollup, ${GENERATED_MARKER}, ${slugify(agg.source)}]`,
    "origin: compiled",
    `generated: ${GENERATED_MARKER}`,
    "---",
    "",
  ];

  const lines: string[] = [];
  lines.push(`# ${agg.source} — activity rollup`);
  lines.push("");
  lines.push(
    `> Auto-compiled from daily logs. Do not edit by hand — regenerated by ` +
      `\`memory_entities\`. Remove the \`generated\` frontmatter field to take ownership.`,
  );
  lines.push("");
  lines.push(
    `**${agg.events.length}** events over **${agg.days.size}** day(s) ` +
      `(${agg.firstSeen} → ${agg.lastSeen}) · ${distinctPatterns} distinct patterns · ${dedupRatio}% repetitive.`,
  );
  lines.push("");

  // High-importance events listed individually (the signal worth keeping).
  const high = agg.events.filter((e) => e.importance >= 7).reverse();
  if (high.length > 0) {
    lines.push(`## Notable events (${high.length})`);
    lines.push("");
    for (const e of high.slice(0, 20)) {
      const snippet = e.content.replace(/\s+/g, " ").slice(0, 200);
      lines.push(`- **${e.date} ${e.time}** (importance ${e.importance}): ${snippet}`);
    }
    lines.push("");
  }

  // Top recurring patterns (the noise, compressed).
  const topPatterns = Array.from(agg.patterns.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .filter(([, n]) => n > 1);
  if (topPatterns.length > 0) {
    lines.push(`## Recurring patterns`);
    lines.push("");
    for (const [fp, n] of topPatterns) {
      lines.push(`- ${n}× ${fp.replace(/\s+/g, " ").slice(0, 90)}…`);
    }
    lines.push("");
  }

  // Backlinks to the daily logs this page was built from (graph edges, rule VI).
  lines.push(`## Source daily logs`);
  lines.push("");
  const sortedDays = Array.from(agg.days).sort().reverse();
  lines.push(sortedDays.map((d) => `[[daily/${d}]]`).join(" · "));
  lines.push("");

  return fm.join("\n") + lines.join("\n") + "\n";
}

/** True if an existing entity file is ours to regenerate (carries the marker). */
/**
 * The source a rollup page belongs to: its `source:` field, or for an older
 * generated page its name. A page a human took over (marker removed) with
 * no `source:` is not claimed for anyone else (null): it is skipped as
 * before, not treated as another source's page.
 */
function pageSource(absPath: string): string | null {
  try {
    const { metadata } = parseFrontmatter(fs.readFileSync(absPath, "utf-8"));
    if (typeof metadata.source === "string") return metadata.source;
    if (metadata.generated === GENERATED_MARKER && typeof metadata.name === "string") {
      return metadata.name.replace(/ — activity rollup$/, "");
    }
  } catch {
    // unreadable: unknown owner
  }
  return null;
}

/**
 * The page slug for a source. Sources whose names slugify alike ("my_source"
 * and "my-source", or "Foo" and "foo") used to share one page and overwrite
 * each other on every run. The page at the plain slug stays with whichever
 * source owns it, so no existing page is renamed; another source gets a
 * short, stable hash suffix.
 */
function slugFor(source: string, entitiesDir: string): string {
  const base = slugify(source);
  const abs = path.join(entitiesDir, `${base}.md`);
  if (!fs.existsSync(abs)) return base;
  const owner = pageSource(abs);
  if (owner === null || owner === source) return base;
  return `${base}-${createHash("sha256").update(source).digest("hex").slice(0, 6)}`;
}

function isGenerated(absPath: string): boolean {
  try {
    const { metadata } = parseFrontmatter(fs.readFileSync(absPath, "utf-8"));
    return metadata.generated === GENERATED_MARKER;
  } catch {
    return false;
  }
}

/**
 * Compile recent daily-log events into per-source entity pages under
 * `entities/`. Idempotent: only writes when the rendered page differs, and
 * never overwrites a page a human has taken over (marker removed).
 */
export function buildEntityPages(
  memoriesDir: string,
  opts: BuildEntitiesOptions = {},
): BuildEntitiesResult {
  const days = opts.days ?? 30;
  const minEvents = opts.minEvents ?? 3;
  const only = opts.onlySources ? new Set(opts.onlySources) : null;
  const today = new Date().toISOString().slice(0, 10);

  const { bySource, eventsScanned } = aggregate(memoriesDir, days);
  const result: BuildEntitiesResult = {
    written: [],
    skipped: [],
    sourcesSeen: bySource.size,
    eventsScanned,
  };

  const entitiesDir = path.join(memoriesDir, "entities");

  for (const agg of bySource.values()) {
    if (only && !only.has(agg.source)) continue;
    if (agg.events.length < minEvents) continue;

    const slug = slugFor(agg.source, entitiesDir);
    const rel = `entities/${slug}.md`;
    const abs = path.join(entitiesDir, `${slug}.md`);

    // Don't clobber a page a human has taken ownership of.
    if (fs.existsSync(abs) && !isGenerated(abs)) {
      result.skipped.push(rel);
      continue;
    }

    const page = renderPage(agg, today);

    // Idempotent: compare ignoring the volatile date lines so an unchanged
    // rollup doesn't rewrite the file (and churn git / the watcher) every run.
    let changed: boolean;
    let existingBefore: string | null = null;
    try {
      existingBefore = fs.readFileSync(abs, "utf-8");
      changed = stripVolatile(existingBefore) !== stripVolatile(page);
    } catch {
      changed = true;
    }
    if (changed) {
      fs.mkdirSync(entitiesDir, { recursive: true });
      // Re-check at rename time: a human edit (or takeover) landing between
      // the check above and the write must win, not be overwritten (L3).
      const wrote = writeFileAtomic(abs, page, {
        precondition: () => {
          try {
            const now = fs.readFileSync(abs, "utf-8");
            if (!isGenerated(abs)) return false;
            return existingBefore === null || now === existingBefore;
          } catch {
            return existingBefore === null;
          }
        },
      });
      if (wrote) result.written.push(rel);
      else result.skipped.push(rel);
    }
  }

  return result;
}

/** Drop the date-only frontmatter lines so idempotency isn't broken by the
 * created/updated/last_accessed stamps changing each day. */
function stripVolatile(s: string): string {
  return s.replace(/^(created|updated|last_accessed):.*$/gm, "");
}
