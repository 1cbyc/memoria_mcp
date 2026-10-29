#!/usr/bin/env node
/**
 * Retrieval evaluation harness.
 *
 * Answers one question Memoria could not previously answer about itself: does
 * the shipped ranking formula actually retrieve well, and is each of its five
 * hand-chosen constants earning its place?
 *
 *   score     = 0.1 * recency + 0.1 * importance + 0.8 * relevance
 *   relevance = 0.7 * vectorCosine + 0.3 * FTS5 BM25
 *
 * Usage:
 *   npm run build && node eval/run.mjs              # default: local MiniLM
 *   node eval/run.mjs --hash                        # no model download
 *   node eval/run.mjs --json                        # machine-readable
 *
 * Notes on method, because a benchmark's credibility is its method:
 *
 *   * The store is built fresh in a temp directory on every run and deleted
 *     afterwards, so runs cannot contaminate each other.
 *   * It calls MemoryStore.search() directly rather than the MCP tool. The
 *     tool layer bumps last_accessed on every returned file, which feeds the
 *     recency signal — benchmarking through it would let each query alter the
 *     ranking seen by the next one.
 *   * Document dates are set relative to the run, not to fixed calendar dates,
 *     so the recency signal behaves identically whenever this is run.
 *   * The embedding provider is printed with the results. Scores from
 *     different providers are not comparable and should never be pasted into
 *     the same table.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CORPUS } from "./corpus.mjs";
import { GOLD, ANSWERABLE, UNANSWERABLE } from "./gold.mjs";

const AS_JSON = process.argv.includes("--json");

// Default to the local model: deterministic, needs no API key, and unlike the
// hash fallback it actually exercises the vector half of the formula.
// --hash swaps in the n-gram fallback, which needs no download but changes
// WHAT is being measured rather than merely making it cheaper. A flag rather
// than an env var in the npm script, because `VAR=x cmd` is not portable to
// Windows shells and this repo tests on both.
process.env.MEMORIA_EMBEDDINGS = process.argv.includes("--hash")
  ? "hash"
  : (process.env.MEMORIA_EMBEDDINGS ?? "minilm");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-eval-"));
process.env.MEMORIA_DIR = ROOT;

// ─── Build the store ──────────────────────────────────────────────────────
const MEM = path.join(ROOT, "memories");
const DAY_MS = 86_400_000;

function isoDaysAgo(days) {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

function relPathFor(m) {
  // Mirror the real store layout: type directories under memories/.
  return `${m.type}/${m.id}.md`;
}

for (const m of CORPUS) {
  const rel = relPathFor(m);
  const full = path.join(MEM, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  // importance is stored on a 0-10 scale in frontmatter.
  const frontmatter = [
    `name: ${m.id}`,
    `description: ${m.title}`,
    `type: ${m.type}`,
    `importance: ${Math.round(m.importance * 10)}`,
    `updated: ${isoDaysAgo(m.day)}`,
  ].join("\n");
  fs.writeFileSync(full, `---\n${frontmatter}\n---\n\n# ${m.title}\n\n${m.body}\n`, "utf-8");
}

const tools = await import("../dist/tools.js");
const { MemoryStore } = await import("../dist/store.js");
const { getProvider, getDimension } = await import("../dist/embeddings.js");

const store = new MemoryStore(path.join(ROOT, "data", "eval.sqlite"));
for (const m of CORPUS) {
  await tools.reindexFile(store, path.join(MEM, relPathFor(m)));
}

// Map a returned file path back to the corpus id the gold set refers to.
const idFromFile = (file) => path.basename(String(file ?? ""), ".md");

// ─── Metrics ──────────────────────────────────────────────────────────────
// Binary relevance: a document is either a correct answer or it is not.

function dcg(hits) {
  // hits[i] is 1 when the document at rank i (0-based) is relevant.
  return hits.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
}

function ndcgAt(rankedIds, relevant, k) {
  if (relevant.length === 0) return null;
  const hits = rankedIds.slice(0, k).map((id) => (relevant.includes(id) ? 1 : 0));
  const ideal = Array.from({ length: Math.min(relevant.length, k) }, () => 1);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? null : dcg(hits) / idealDcg;
}

function recallAt(rankedIds, relevant, k) {
  if (relevant.length === 0) return null;
  const found = relevant.filter((id) => rankedIds.slice(0, k).includes(id)).length;
  return found / relevant.length;
}

function reciprocalRank(rankedIds, relevant) {
  if (relevant.length === 0) return null;
  const idx = rankedIds.findIndex((id) => relevant.includes(id));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function percentile(xs, p) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

// ─── Configurations ───────────────────────────────────────────────────────
// The shipped default plus the baselines that make its number mean something.
// "Is the hybrid better than plain BM25?" is the question a single score
// cannot answer, and it is the one most worth knowing.
const CONFIGS = [
  {
    name: "shipped default",
    note: "0.1/0.1/0.8, vector 0.7",
    weights: { recency: 0.1, importance: 0.1, relevance: 0.8 },
    vectorMix: 0.7,
  },
  {
    name: "keyword only",
    note: "relevance 1.0, vector 0.0 — BM25 baseline",
    weights: { recency: 0, importance: 0, relevance: 1 },
    vectorMix: 0,
  },
  {
    name: "vector only",
    note: "relevance 1.0, vector 1.0 — semantic baseline",
    weights: { recency: 0, importance: 0, relevance: 1 },
    vectorMix: 1,
  },
  {
    name: "hybrid, no priors",
    note: "relevance 1.0, vector 0.7 — isolates recency+importance",
    weights: { recency: 0, importance: 0, relevance: 1 },
    vectorMix: 0.7,
  },
  {
    name: "priors only",
    note: "recency+importance, no relevance — sanity floor",
    weights: { recency: 0.4, importance: 0.6, relevance: 0 },
    vectorMix: 0.7,
  },
];

const K_NDCG = 10;
const K_RECALL = 20;

async function evaluate(config) {
  const perQuery = [];
  const latencies = [];
  const answerableTopScores = [];
  const unanswerableTopScores = [];

  for (const g of GOLD) {
    const t0 = performance.now();
    const results = await store.search(g.q, K_RECALL, config.weights, config.vectorMix);
    latencies.push(performance.now() - t0);

    const ranked = results.map((r) => idFromFile(r.file));
    const topScore = results.length ? Number(results[0].score ?? 0) : 0;

    if (g.kind === "unanswerable") {
      unanswerableTopScores.push(topScore);
      continue;
    }
    answerableTopScores.push(topScore);

    perQuery.push({
      q: g.q,
      kind: g.kind,
      ndcg: ndcgAt(ranked, g.relevant, K_NDCG),
      recall: recallAt(ranked, g.relevant, K_RECALL),
      rr: reciprocalRank(ranked, g.relevant),
      top: ranked[0] ?? null,
      // Did it surface the superseded answer above the current one?
      returnedStale: Boolean(
        g.stale?.length &&
        ranked.findIndex((id) => g.stale.includes(id)) !== -1 &&
        (ranked.findIndex((id) => g.relevant.includes(id)) === -1 ||
          ranked.findIndex((id) => g.stale.includes(id)) <
            ranked.findIndex((id) => g.relevant.includes(id))),
      ),
    });
  }

  const byKind = {};
  for (const kind of ["temporal", "hard-negative", "paraphrase"]) {
    const rows = perQuery.filter((r) => r.kind === kind);
    if (rows.length) byKind[kind] = mean(rows.map((r) => r.ndcg));
  }

  return {
    config: config.name,
    note: config.note,
    ndcg: mean(perQuery.map((r) => r.ndcg)),
    recall: mean(perQuery.map((r) => r.recall)),
    mrr: mean(perQuery.map((r) => r.rr)),
    p95: percentile(latencies, 95),
    staleWins: perQuery.filter((r) => r.returnedStale).length,
    byKind,
    // Abstention is not implemented; this measures whether it COULD be, by
    // asking if a score threshold could separate answerable from unanswerable.
    abstention: {
      answerableMeanTop: mean(answerableTopScores),
      unanswerableMeanTop: mean(unanswerableTopScores),
      separable:
        Math.min(...answerableTopScores) > Math.max(...unanswerableTopScores) ? "yes" : "no",
    },
    worst: [...perQuery].sort((a, b) => a.ndcg - b.ndcg).slice(0, 5),
  };
}

const results = [];
for (const c of CONFIGS) results.push(await evaluate(c));

// ─── Report ───────────────────────────────────────────────────────────────
const meta = {
  provider: getProvider(),
  dimension: getDimension(),
  documents: CORPUS.length,
  cited: new Set(GOLD.flatMap((g) => g.relevant)).size,
  distractors: CORPUS.length - new Set(GOLD.flatMap((g) => g.relevant)).size,
  queries: ANSWERABLE.length,
  unanswerable: UNANSWERABLE.length,
};

if (AS_JSON) {
  process.stdout.write(JSON.stringify({ meta, results }, null, 2) + "\n");
} else {
  const pct = (x) => (x == null ? "  -  " : (x * 100).toFixed(1).padStart(5));
  process.stdout.write(
    `\nMemoria retrieval eval\n` +
      `  provider   ${meta.provider} (${meta.dimension}d)\n` +
      `  corpus     ${meta.documents} documents (${meta.cited} cited by a query, ${meta.distractors} pure distractors)\n` +
      `  queries    ${meta.queries} answerable, ${meta.unanswerable} unanswerable\n\n`,
  );
  process.stdout.write(
    `  ${"configuration".padEnd(20)} ${"nDCG@10".padStart(7)} ${"R@20".padStart(6)} ${"MRR".padStart(6)} ${"p95ms".padStart(6)}  stale\n` +
      `  ${"-".repeat(20)} ${"-".repeat(7)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(6)}  -----\n`,
  );
  for (const r of results) {
    process.stdout.write(
      `  ${r.config.padEnd(20)} ${pct(r.ndcg).padStart(7)} ${pct(r.recall).padStart(6)} ` +
        `${pct(r.mrr).padStart(6)} ${r.p95.toFixed(0).padStart(6)}  ${String(r.staleWins).padStart(5)}\n`,
    );
  }

  const base = results[0];
  // Per-kind across every configuration, because the aggregate hides the
  // question each weight exists to answer. "temporal" is the only column that
  // tests recency: if a configuration with recency switched off also wins
  // there, the recency weight is not earning its place.
  const kinds = ["temporal", "hard-negative", "paraphrase"];
  process.stdout.write(`\n  nDCG@10 by query kind:\n`);
  process.stdout.write(`  ${"".padEnd(20)} ${kinds.map((k) => k.padStart(14)).join("")}\n`);
  for (const r of results) {
    process.stdout.write(
      `  ${r.config.padEnd(20)} ${kinds.map((k) => pct(r.byKind[k]).padStart(14)).join("")}\n`,
    );
  }

  process.stdout.write(
    `\n  abstention headroom (shipped default):\n` +
      `    mean top score, answerable   ${base.abstention.answerableMeanTop.toFixed(4)}\n` +
      `    mean top score, unanswerable ${base.abstention.unanswerableMeanTop.toFixed(4)}\n` +
      `    separable by a threshold?    ${base.abstention.separable}\n`,
  );

  process.stdout.write(`\n  worst queries (shipped default):\n`);
  for (const w of base.worst) {
    process.stdout.write(
      `    ${pct(w.ndcg)}  [${w.kind}] ${w.q}\n           returned: ${w.top ?? "nothing"}${w.returnedStale ? "  <- SUPERSEDED ANSWER" : ""}\n`,
    );
  }
  process.stdout.write("\n");
}

store.close();
fs.rmSync(ROOT, { recursive: true, force: true });
