/**
 * Memory lint — proactive health checks inspired by Karpathy's LLM Wiki pattern.
 *
 * Checks:
 *   1. Contradiction scan: high-similarity memories in different files
 *   2. Orphan detection: unreferenced memories with low access
 *   3. Stale cross-references: broken `related` links
 *   4. Missing summaries: files without `description` in frontmatter
 *   5. Gap analysis: frequently discussed topics without core memories
 */

import fs from "fs";
import path from "path";
import { parseFrontmatter } from "./chunker.js";
import { getProvider } from "./embeddings.js";
import type { MemoryStore } from "./store.js";

/** True if a relative memory path is a daily log (separator-agnostic). */
function isDailyPath(relPath: string): boolean {
  return /(^|[\\/])daily[\\/]/.test(relPath);
}

/** True if a path is an auto-compiled entity page. These are derived rollups of
 * daily logs (like references), so they're excluded from contradiction and
 * orphan checks — they will always look similar to their source logs and are
 * never referenced via `related` (they're reached through the index). */
function isAutoCompiledPath(relPath: string): boolean {
  return /(^|[\\/])entities[\\/]/.test(relPath);
}

export interface LintResult {
  contradictions: Array<{ fileA: string; fileB: string; similarity: number }>;
  contradictionScanned: number; // how many files were actually scanned
  contradictionTotal: number; // total core files (helps explain coverage)
  orphans: Array<{ file: string; accessCount: number; importance: number }>;
  staleCrossRefs: Array<{ file: string; brokenRef: string }>;
  missingSummaries: string[];
  gapTopics: string[];
  // Karpathy rule VII: "the index has stopped reflecting the territory."
  indexDrift: { missingFromIndex: string[]; staleInIndex: string[] };
  // Karpathy rule VIII: entities that "drifted into two spellings".
  aliasCollisions: Array<{ normalized: string; variants: Array<{ file: string; name: string }> }>;
  // Karpathy rule VIII: surface low-confidence claims to verify.
  lowConfidence: Array<{ file: string; markers: string[] }>;
  // Files outside the documented directory layout. This is how the store
  // silently split into `reference/` and `references/` for three weeks in
  // July 2026: direct-to-disk writes bypass memory_write's type→dir mapping,
  // and nothing flagged the stray sibling directory.
  unknownDirs: Array<{ dir: string; files: string[] }>;
  totalIssues: number;
}

/**
 * Run all lint checks against the memory store.
 */
export async function runLint(
  store: MemoryStore,
  memoriesDir: string,
  getAllMemoryFiles: () => string[],
  getRelativePath: (abs: string) => string,
): Promise<LintResult> {
  const files = getAllMemoryFiles();

  const {
    pairs: contradictions,
    scanned: contradictionScanned,
    totalCore: contradictionTotal,
  } = await findContradictions(store, files, memoriesDir, getRelativePath);
  const orphans = findOrphans(store, files, memoriesDir, getRelativePath);
  const staleCrossRefs = findStaleCrossRefs(files, memoriesDir, getRelativePath);
  const missingSummaries = findMissingSummaries(files, getRelativePath);
  const gapTopics = await findGaps(store, memoriesDir);
  const indexDrift = findIndexDrift(files, memoriesDir, getRelativePath);
  const aliasCollisions = findAliasCollisions(files, getRelativePath);
  const lowConfidence = findLowConfidence(files, getRelativePath);
  const unknownDirs = findUnknownDirs(files, getRelativePath);

  const totalIssues =
    contradictions.length +
    orphans.length +
    staleCrossRefs.length +
    missingSummaries.length +
    gapTopics.length +
    indexDrift.missingFromIndex.length +
    indexDrift.staleInIndex.length +
    aliasCollisions.length +
    lowConfidence.length +
    unknownDirs.length;

  return {
    contradictions,
    contradictionScanned,
    contradictionTotal,
    orphans,
    staleCrossRefs,
    missingSummaries,
    gapTopics,
    indexDrift,
    aliasCollisions,
    lowConfidence,
    unknownDirs,
    totalIssues,
  };
}

// ── Check 10: Unknown top-level directories ─────────────────
// The documented layout (CLAUDE.md → Directory Layout) is a closed set. A file
// anywhere else usually means a direct-to-disk write bypassed memory_write's
// type→directory mapping — e.g. a `reference/` sibling of `references/`, which
// splits the store and hides memories from type-filtered listing.

const KNOWN_TOP_DIRS = new Set([
  "daily",
  "entities",
  "user",
  "project",
  "decisions",
  "feedback",
  "references",
  "sessions",
]);

function findUnknownDirs(
  files: string[],
  getRelativePath: (abs: string) => string,
): Array<{ dir: string; files: string[] }> {
  const byDir = new Map<string, string[]>();
  for (const file of files) {
    const relPath = getRelativePath(file);
    if (relPath === "MEMORY_INDEX.md") continue;
    const slash = relPath.indexOf("/");
    // Loose files at the memories/ root are grouped under "." — also a
    // deviation from the documented layout worth surfacing.
    const top = slash === -1 ? "." : relPath.slice(0, slash);
    if (KNOWN_TOP_DIRS.has(top)) continue;
    const group = byDir.get(top) || [];
    group.push(relPath);
    byDir.set(top, group);
  }
  return Array.from(byDir.entries())
    .map(([dir, f]) => ({ dir, files: f.sort() }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

// ── Check 7: Entity alias collisions ────────────────────────
// Rule VIII — flag entities whose names drifted into two spellings (case,
// punctuation, spacing, or singular/plural), e.g. "Talk & Play" vs
// "talk-and-play". Deterministic: group by a normalized key, report any key
// reached by more than one distinct raw name.

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/&/g, "and") // "Talk & Play" === "talk and play"
    .replace(/[^a-z0-9]+/g, "") // drop spaces, punctuation, - etc.
    .replace(/s$/, ""); // collapse trivial plural
}

function findAliasCollisions(
  files: string[],
  getRelativePath: (abs: string) => string,
): Array<{ normalized: string; variants: Array<{ file: string; name: string }> }> {
  const byKey = new Map<string, Array<{ file: string; name: string }>>();

  for (const file of files) {
    const relPath = getRelativePath(file);
    if (isDailyPath(relPath) || relPath === "MEMORY_INDEX.md") continue;
    const content = fs.readFileSync(file, "utf-8");
    const { metadata } = parseFrontmatter(content);
    const name = String(metadata.name || "").trim();
    if (!name) continue;
    const key = normalizeName(name);
    if (key.length < 4) continue; // ignore trivially-short keys
    const list = byKey.get(key) || [];
    list.push({ file: relPath, name });
    byKey.set(key, list);
  }

  const collisions: Array<{ normalized: string; variants: Array<{ file: string; name: string }> }> =
    [];
  for (const [key, variants] of byKey) {
    // Only a collision if the RAW names actually differ (same name in two files
    // is a contradiction/duplicate concern, handled elsewhere).
    const distinctNames = new Set(variants.map((v) => v.name));
    if (distinctNames.size > 1) {
      collisions.push({
        normalized: key,
        variants: variants.sort((a, b) => a.file.localeCompare(b.file)),
      });
    }
  }
  collisions.sort((a, b) => a.normalized.localeCompare(b.normalized));
  return collisions;
}

// ── Check 8: Low-confidence claims ──────────────────────────
// Rule VIII — surface hedged/unverified statements in curated memories so they
// can be confirmed or sourced rather than silently hardening into "fact".

// High-signal markers flag a file on their own; weak hedges ("probably",
// "maybe", "I think") need at least two DISTINCT hits before the file is
// flagged — ordinary prose hedges too often for a single weak marker to be
// signal (F5: measured false-positive reduction).
const STRONG_HEDGES: RegExp[] = [
  /\bnot sure\b/i,
  /\bunverified\b/i,
  /\bunconfirmed\b/i,
  /\bto be confirmed\b/i,
  /\btbd\b/i,
  /\btodo\b/i,
  /\bfixme\b/i,
  /\?\?+/,
];
const WEAK_HEDGES: RegExp[] = [
  /\bunsure\b/i,
  /\bi think\b/i,
  /\bi believe\b/i,
  /\bprobably\b/i,
  /\bpossibly\b/i,
  /\bpresumably\b/i,
  /\bmight be\b/i,
  /\bmaybe\b/i,
  /\bafaik\b/i,
  /\bguess(?:ing)?\b/i,
  /\bassum(?:e|ing|ption)\b/i,
];

/** Strip inline code and fenced blocks — "TODO" inside a code sample is not a
 * claim about the world. */
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

function findLowConfidence(
  files: string[],
  getRelativePath: (abs: string) => string,
): Array<{ file: string; markers: string[] }> {
  const results: Array<{ file: string; markers: string[] }> = [];

  for (const file of files) {
    const relPath = getRelativePath(file);
    // Only curated memories — daily logs and auto-compiled rollups are expected
    // to be raw/hedged and would just create noise.
    if (isDailyPath(relPath) || isAutoCompiledPath(relPath) || relPath === "MEMORY_INDEX.md")
      continue;
    const content = fs.readFileSync(file, "utf-8");
    const body = stripCode(parseFrontmatter(content).body);

    const strong = new Set<string>();
    for (const re of STRONG_HEDGES) {
      const m = body.match(re);
      if (m) strong.add(m[0].toLowerCase());
    }
    const weak = new Set<string>();
    for (const re of WEAK_HEDGES) {
      const m = body.match(re);
      if (m) weak.add(m[0].toLowerCase());
    }

    if (strong.size > 0 || weak.size >= 2) {
      results.push({ file: relPath, markers: [...strong, ...weak].sort() });
    }
  }

  results.sort((a, b) => a.file.localeCompare(b.file));
  return results;
}

// ── Check 6: Index drift ────────────────────────────────────
// Karpathy rule VII — if the index no longer reflects the territory, the model
// ends up brute-forcing the whole corpus instead of navigating. Flag core
// memories missing from MEMORY_INDEX.md, and index links to files that are gone.

function findIndexDrift(
  files: string[],
  memoriesDir: string,
  getRelativePath: (abs: string) => string,
): { missingFromIndex: string[]; staleInIndex: string[] } {
  const indexPath = path.join(memoriesDir, "MEMORY_INDEX.md");
  let indexText: string;
  try {
    indexText = fs.readFileSync(indexPath, "utf-8");
  } catch {
    // No index at all — every core file is "missing". Report the absence once
    // rather than listing the whole store.
    return { missingFromIndex: ["(MEMORY_INDEX.md does not exist)"], staleInIndex: [] };
  }

  // Core (non-daily) files that should appear in the catalog.
  const missingFromIndex: string[] = [];
  for (const file of files) {
    const relPath = getRelativePath(file);
    if (isDailyPath(relPath) || relPath === "MEMORY_INDEX.md") continue;
    // The generator links by relative path; a plain substring check is robust
    // to surrounding markdown ([name](path) | desc | ...).
    if (!indexText.includes(relPath)) missingFromIndex.push(relPath);
  }

  // Markdown links in the index pointing at files that no longer exist.
  const staleInIndex: string[] = [];
  const linkRe = /\]\(([^)]+\.md)(?:#[^)]*)?\)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(indexText)) !== null) {
    const ref = decodeURIComponent(m[1].replace(/%20/g, " ")).trim();
    if (!ref.endsWith(".md") || seen.has(ref)) continue;
    seen.add(ref);
    if (ref.includes("://")) continue; // external link
    const abs = path.resolve(memoriesDir, ref);
    if (!fs.existsSync(abs)) staleInIndex.push(ref);
  }

  return { missingFromIndex, staleInIndex };
}

// ── Check 1: Contradiction scan ─────────────────────────────

// Cap to prevent runaway embedding API costs. Each file = 1 embedding call.
const MAX_CONTRADICTION_FILES = 30;

async function findContradictions(
  store: MemoryStore,
  files: string[],
  memoriesDir: string,
  getRelativePath: (abs: string) => string,
): Promise<{
  pairs: Array<{ fileA: string; fileB: string; similarity: number }>;
  scanned: number;
  totalCore: number;
}> {
  const seen = new Set<string>();

  // Only check core memories (not daily logs or auto-compiled rollups) to keep
  // it tractable and avoid derivation-relationship false positives.
  const coreFiles = files.filter((f) => !isDailyPath(f) && !isAutoCompiledPath(f));

  // Sample highest-importance files first to prioritize what matters. Stash the
  // parsed body here so the batch loop below doesn't read+parse each file again.
  const sampled: Array<{ file: string; importance: number; body: string }> = [];
  for (const file of coreFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const { metadata, body } = parseFrontmatter(content);
    if (body.trim().length < 50) continue;
    const importance = typeof metadata.importance === "number" ? metadata.importance : 5;
    sampled.push({ file, importance, body });
  }
  sampled.sort((a, b) => b.importance - a.importance);
  const toCheck = sampled.slice(0, MAX_CONTRADICTION_FILES);

  // Process in parallel batches of 5 to avoid rate limits but not be glacial
  const BATCH = 5;
  const pairs: Array<{ fileA: string; fileB: string; similarity: number }> = [];

  // Threshold is provider-dependent. The local n-gram fallback ("local") is a
  // fuzzy bag-of-words and inflates cosine similarity (topically-related docs
  // land at 0.80-0.90), so it needs a high 0.93 cut to avoid false positives.
  // Real semantic embeddings (OpenAI, and the default local MiniLM) have a
  // wider spread, so a lower cut is meaningful — without this branch, MiniLM
  // (the default deployment) used the 0.93 fallback cut and under-reported
  // real contradictions.
  const provider = getProvider();
  const threshold = provider === "openai" ? 0.85 : provider === "minilm" ? 0.86 : 0.93;

  for (let i = 0; i < toCheck.length; i += BATCH) {
    const batch = toCheck.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async ({ file, body }) => {
        const relPath = getRelativePath(file);
        try {
          // NOTE: discovery is best-effort, not exhaustive. findSimilar scans a
          // bounded, access-ordered candidate window, so on a large store WHICH
          // contradiction pairs surface can vary as access counts change. The
          // final pair ORDERING below is deterministic, but the discovered SET
          // is sampling-dependent — treat lint as a recurring sweep, not a proof.
          const similar = await store.findSimilar(body, 5);
          return { relPath, similar };
        } catch (err) {
          process.stderr.write(
            `Memoria lint: findSimilar failed for ${relPath}: ${(err as Error).message}\n`,
          );
          return { relPath, similar: [] };
        }
      }),
    );

    for (const { relPath, similar } of batchResults) {
      for (const match of similar) {
        if (match.file === relPath) continue;
        // Core-vs-core only. A reference doc is *derived from* daily logs, so
        // it will always look similar to them — that is a derivation
        // relationship, not a contradiction. Excluding daily matches removes
        // the dominant class of false positives.
        if (isDailyPath(match.file) || isAutoCompiledPath(match.file)) continue;
        if (match.similarity < threshold) continue;

        const pairKey = [relPath, match.file].sort().join("|");
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        // Always store pair in canonical order so output is deterministic
        const [fileA, fileB] = [relPath, match.file].sort();
        pairs.push({
          fileA,
          fileB,
          similarity: Math.round(match.similarity * 1000) / 1000,
        });
      }
    }
  }

  // Sort deterministically: highest similarity first, then alphabetical
  pairs.sort((a, b) => {
    if (a.similarity !== b.similarity) return b.similarity - a.similarity;
    if (a.fileA !== b.fileA) return a.fileA.localeCompare(b.fileA);
    return a.fileB.localeCompare(b.fileB);
  });

  return { pairs, scanned: toCheck.length, totalCore: coreFiles.length };
}

// ── Check 2: Orphan detection ───────────────────────────────

function findOrphans(
  store: MemoryStore,
  files: string[],
  memoriesDir: string,
  getRelativePath: (abs: string) => string,
): Array<{ file: string; accessCount: number; importance: number }> {
  // Build set of all referenced files
  const referenced = new Set<string>();

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const { metadata } = parseFrontmatter(content);
    const related = metadata.related;
    if (Array.isArray(related)) {
      for (const ref of related) {
        referenced.add(String(ref));
      }
    }
  }

  // Find unreferenced files (exclude daily logs and MEMORY_INDEX.md)
  const orphans: Array<{ file: string; accessCount: number; importance: number }> = [];

  for (const file of files) {
    const relPath = getRelativePath(file);
    if (isDailyPath(relPath) || isAutoCompiledPath(relPath) || relPath === "MEMORY_INDEX.md")
      continue;

    if (!referenced.has(relPath)) {
      const content = fs.readFileSync(file, "utf-8");
      const { metadata } = parseFrontmatter(content);
      const importance = typeof metadata.importance === "number" ? metadata.importance : 5;
      // Use live store access count (frontmatter access_count is stale — only
      // updated on writes, not on reads via memory_search).
      const accessCount = store.getAccessCount(relPath);

      // Only flag as orphan if low access AND low importance
      if (accessCount <= 2 && importance < 7) {
        orphans.push({ file: relPath, accessCount, importance });
      }
    }
  }

  return orphans;
}

// ── Check 3: Stale cross-references ─────────────────────────

function findStaleCrossRefs(
  files: string[],
  memoriesDir: string,
  getRelativePath: (abs: string) => string,
): Array<{ file: string; brokenRef: string }> {
  const results: Array<{ file: string; brokenRef: string }> = [];

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const { metadata } = parseFrontmatter(content);
    const related = metadata.related;
    if (!Array.isArray(related)) continue;

    const relPath = getRelativePath(file);
    for (const ref of related) {
      const refPath = path.resolve(memoriesDir, String(ref));
      if (!fs.existsSync(refPath)) {
        results.push({ file: relPath, brokenRef: String(ref) });
      }
    }
  }

  return results;
}

// ── Check 4: Missing summaries ──────────────────────────────

function findMissingSummaries(files: string[], getRelativePath: (abs: string) => string): string[] {
  const results: string[] = [];

  for (const file of files) {
    const relPath = getRelativePath(file);
    if (isDailyPath(relPath)) continue; // daily logs don't need descriptions
    // The generated index carries no frontmatter by design — flagging it
    // produced a permanent false positive on every real-store run.
    if (relPath === "MEMORY_INDEX.md") continue;

    const content = fs.readFileSync(file, "utf-8");
    const { metadata } = parseFrontmatter(content);

    if (!metadata.description || String(metadata.description).trim() === "") {
      results.push(relPath);
    }
  }

  return results;
}

// ── Check 5: Gap analysis ───────────────────────────────────

/** A core page this relevant to a frequent daily-log term covers it. */
const KNOWLEDGE_GAP_MIN_RELEVANCE = 0.25;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "up",
  "down",
  "and",
  "but",
  "or",
  "nor",
  "not",
  "so",
  "yet",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "only",
  "own",
  "same",
  "than",
  "too",
  "very",
  "just",
  "about",
  "also",
  "then",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "them",
  "their",
  "what",
  "which",
  "who",
  "when",
  "where",
  "how",
  "all",
  "if",
  "there",
  "here",
  "new",
  "one",
  "two",
  "like",
  "time",
  "make",
  "made",
  "get",
  "got",
  "log",
  "daily",
  "session",
  "importance",
  "privacy",
  "send",
  "pm",
  "am",
  "agent",
  "orchestrator",
  "memory",
  "memories",
  // Collector metric-line vocabulary ("Agent X: success | 553ms | $0.0000").
  // The first real-store lint run (2026-07-25) surfaced these as top "gap
  // topics" with thousands of mentions — they are pipeline framing, not
  // knowledge the user is missing.
  "success",
  "status",
  "task",
  "result",
  "error",
  "failed",
  "correct",
  "cost",
  "duration",
  "true",
  "false",
  "none",
  "null",
]);

async function findGaps(store: MemoryStore, memoriesDir: string): Promise<string[]> {
  const dailyDir = path.join(memoriesDir, "daily");
  if (!fs.existsSync(dailyDir)) return [];

  // Read recent daily logs
  const dailyFiles = fs
    .readdirSync(dailyDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .slice(0, 14); // last 2 weeks

  if (dailyFiles.length === 0) return [];

  // Count word frequency across all daily logs
  const wordCounts = new Map<string, number>();

  for (const file of dailyFiles) {
    const content = fs.readFileSync(path.join(dailyDir, file), "utf-8");
    const { body } = parseFrontmatter(content);
    const words = body
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      // Digit-led tokens ("0000" from $0.0000 cost fields, "553ms" timings)
      // are measurements, never gap topics.
      .filter((w) => w.length > 3 && !/^\d/.test(w) && !STOP_WORDS.has(w));

    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
  }

  // Get top frequent terms (counted by RAW occurrences — a term appearing 5+
  // times total across recent daily-log bodies, not document frequency).
  const topTerms = Array.from(wordCounts.entries())
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([term]) => term);

  // A term is covered if a non-daily memory's file basename contains it.
  // This is checked BEFORE search because on a firehose-dominated store the
  // top search hits for a source name are the thousands of daily-log chunks
  // mentioning it — the first real-store run flagged "orchestrator-metrics"
  // as a gap while entities/orchestrator-metrics.md sat right there.
  // (Basename only — frontmatter `name:` is deliberately not read here to
  // keep this a filesystem-only pass; the search fallback below covers pages
  // whose filename and name diverge.)
  const coreBasenames: string[] = [];
  for (const file of fs.readdirSync(memoriesDir, { recursive: true, encoding: "utf-8" })) {
    const rel = String(file).split(path.sep).join("/");
    if (!rel.endsWith(".md") || isDailyPath(rel) || rel === "MEMORY_INDEX.md") continue;
    coreBasenames.push(path.basename(rel, ".md").toLowerCase());
  }
  const coveredByName = (term: string): boolean => coreBasenames.some((b) => b.includes(term));

  // Check which terms have no corresponding core memory
  const gaps: string[] = [];
  for (const term of topTerms) {
    if (coveredByName(term)) continue;
    // Wider window than the old top-3: on a store that is ~98% daily-log
    // chunks, the covering core page routinely ranks below a page of daily
    // hits without being absent.
    const results = await store.search(term, 10);
    // Gate on relevance, not the blended score: the blend depends on the
    // ranking weights and on each page's recency/importance, so a fixed cut
    // on it silently moved when the weights changed (0.4 under the old
    // 0.2/0.3/0.5, which corresponds to roughly 0.25 relevance).
    const hasCoreMemory = results.some(
      (r) => !isDailyPath(r.file) && r.relevanceScore >= KNOWLEDGE_GAP_MIN_RELEVANCE,
    );
    if (!hasCoreMemory) {
      gaps.push(`"${term}" (${wordCounts.get(term)} mentions in daily logs, no core memory)`);
    }
  }

  return gaps;
}

/**
 * Format lint results as human-readable text.
 */
export function formatLintReport(result: LintResult): string {
  const sections: string[] = [];

  sections.push(`**Memory Lint Report** — ${result.totalIssues} issue(s) found\n`);

  // Contradictions
  if (result.contradictions.length > 0) {
    sections.push(`### Potential Contradictions (${result.contradictions.length})`);
    sections.push(
      `*Scanned top ${result.contradictionScanned} of ${result.contradictionTotal} core memories by importance.*\n`,
    );
    for (const c of result.contradictions) {
      sections.push(
        `- **${c.fileA}** ↔ **${c.fileB}** (${(c.similarity * 100).toFixed(1)}% similar)`,
      );
    }
    sections.push(
      "*Review these pairs for conflicting information. Consider merging or adding `supersedes` metadata.*\n",
    );
  } else if (result.contradictionScanned < result.contradictionTotal) {
    sections.push(
      `*(Contradiction scan covered ${result.contradictionScanned}/${result.contradictionTotal} core memories — top by importance.)*\n`,
    );
  }

  // Orphans
  if (result.orphans.length > 0) {
    sections.push(`### Orphaned Memories (${result.orphans.length})`);
    for (const o of result.orphans) {
      sections.push(`- **${o.file}** (importance: ${o.importance}, accesses: ${o.accessCount})`);
    }
    sections.push(
      "*These memories are never referenced by other memories. Consider adding `related` links or archiving if obsolete.*\n",
    );
  }

  // Stale cross-refs
  if (result.staleCrossRefs.length > 0) {
    sections.push(`### Broken Cross-References (${result.staleCrossRefs.length})`);
    for (const s of result.staleCrossRefs) {
      sections.push(`- **${s.file}** → \`${s.brokenRef}\` (not found)`);
    }
    sections.push("*Remove or update these `related` entries.*\n");
  }

  // Missing summaries
  if (result.missingSummaries.length > 0) {
    sections.push(`### Missing Descriptions (${result.missingSummaries.length})`);
    for (const m of result.missingSummaries) {
      sections.push(`- **${m}**`);
    }
    sections.push(
      "*Add a `description` to the frontmatter for better search and index quality.*\n",
    );
  }

  // Gap topics
  if (result.gapTopics.length > 0) {
    sections.push(`### Knowledge Gaps (${result.gapTopics.length})`);
    for (const g of result.gapTopics) {
      sections.push(`- ${g}`);
    }
    sections.push(
      "*These topics appear frequently in daily logs but have no dedicated core memory. Consider using `memory_compile` to create one.*\n",
    );
  }

  // Index drift
  const drift = result.indexDrift;
  if (drift.missingFromIndex.length > 0 || drift.staleInIndex.length > 0) {
    sections.push(`### Index Drift (${drift.missingFromIndex.length + drift.staleInIndex.length})`);
    if (drift.missingFromIndex.length > 0) {
      sections.push(
        `*Core memories missing from MEMORY_INDEX.md (${drift.missingFromIndex.length}):*`,
      );
      for (const f of drift.missingFromIndex) sections.push(`- **${f}**`);
    }
    if (drift.staleInIndex.length > 0) {
      sections.push(`*Index links to files that no longer exist (${drift.staleInIndex.length}):*`);
      for (const f of drift.staleInIndex) sections.push(`- \`${f}\``);
    }
    sections.push(
      "*The index has drifted from the territory (Karpathy rule VII). Run `memory_index` to rebuild it.*\n",
    );
  }

  // Alias collisions
  if (result.aliasCollisions.length > 0) {
    sections.push(`### Entity Alias Collisions (${result.aliasCollisions.length})`);
    for (const c of result.aliasCollisions) {
      const variants = c.variants.map((v) => `"${v.name}" (${v.file})`).join(" ↔ ");
      sections.push(`- ${variants}`);
    }
    sections.push(
      "*The same entity drifted into multiple spellings (Karpathy rule VIII). Pick one canonical name and `supersedes` the rest.*\n",
    );
  }

  // Low-confidence claims
  if (result.lowConfidence.length > 0) {
    sections.push(`### Low-Confidence Claims (${result.lowConfidence.length})`);
    for (const lc of result.lowConfidence) {
      sections.push(`- **${lc.file}** — ${lc.markers.map((m) => `\`${m}\``).join(", ")}`);
    }
    sections.push(
      "*These curated memories hedge or flag uncertainty. Verify and source them, or remove the hedge.*\n",
    );
  }

  // Unknown directories
  if (result.unknownDirs.length > 0) {
    sections.push(`### Unknown Directories (${result.unknownDirs.length})`);
    for (const u of result.unknownDirs) {
      const label = u.dir === "." ? "(memories root)" : `${u.dir}/`;
      sections.push(
        `- **${label}** — ${u.files.length} file(s): ${u.files.map((f) => `\`${f}\``).join(", ")}`,
      );
    }
    sections.push(
      "*These files sit outside the documented layout (usually a direct-to-disk write that bypassed `memory_write`). Move them into a known directory.*\n",
    );
  }

  if (result.totalIssues === 0) {
    sections.push("No issues found. Memory store is healthy.");
  }

  return sections.join("\n");
}
