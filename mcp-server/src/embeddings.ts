/**
 * Embedding provider abstraction. Three providers, selected at module load:
 *
 *   - "openai" : OpenAI text-embedding-3-small (1536-dim). Best quality.
 *   - "minilm" : local all-MiniLM-L6-v2 via @huggingface/transformers (384-dim).
 *                True semantic embeddings, fully offline after a one-time
 *                model download. This is the default when no OpenAI key is set
 *                and the transformers package is installed.
 *   - "local"  : n-gram hashing (384-dim). Lexical approximation only — last
 *                resort when neither of the above is available.
 *
 * Selection is controlled by MEMORIA_EMBEDDINGS = auto | openai | minilm | hash
 * (default "auto"). The provider is deterministic from the environment so the
 * SQLite index never mixes incompatible vectors; a model that can't load fails
 * loudly rather than silently degrading to a different vector space.
 */

import { createRequire } from "node:module";

const OPENAI_DIM = 1536;
const MINILM_DIM = 384;
const LOCAL_DIM = 384;

const MINILM_MODEL = "Xenova/all-MiniLM-L6-v2";

type Provider = "openai" | "minilm" | "local";

// ─── Provider detection (synchronous, at module load) ───────

function minilmInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure provider selection, exported for tests. A remote provider is chosen
 * ONLY when explicitly requested via MEMORIA_EMBEDDINGS=openai: the mere
 * presence of OPENAI_API_KEY must never silently send memory content and
 * search queries to a third-party API (review H4).
 */
export function selectProvider(
  forcedRaw: string | undefined,
  hasOpenAI: boolean,
  minilmAvailable: boolean,
): Provider {
  const forced = (forcedRaw || "auto").toLowerCase();
  switch (forced) {
    case "openai":
      return "openai";
    case "minilm":
      return "minilm";
    case "hash":
    case "local":
      return "local";
    case "auto":
    case "":
      return minilmAvailable ? "minilm" : "local";
    default:
      process.stderr.write(
        `Memoria: unknown MEMORIA_EMBEDDINGS="${forced}", falling back to local detection\n`,
      );
      return minilmAvailable ? "minilm" : "local";
  }
}

function detectProvider(): Provider {
  return selectProvider(
    process.env.MEMORIA_EMBEDDINGS,
    !!process.env.OPENAI_API_KEY,
    minilmInstalled(),
  );
}

const provider: Provider = detectProvider();
const dimension =
  provider === "openai" ? OPENAI_DIM : provider === "minilm" ? MINILM_DIM : LOCAL_DIM;

switch (provider) {
  case "openai":
    process.stderr.write(
      "Memoria: using OpenAI text-embedding-3-small (1536-dim). WARNING: memory content and " +
        "search queries are sent to OpenAI's API. This happens only because MEMORIA_EMBEDDINGS=openai " +
        "was set explicitly; unset it to keep embeddings on this device.\n",
    );
    break;
  case "minilm":
    process.stderr.write(
      `Memoria: using local ${MINILM_MODEL} (384-dim). First run downloads the model (~23MB).\n`,
    );
    break;
  case "local":
    process.stderr.write(
      "Memoria: using local n-gram hash embeddings (384-dim, lexical approximation). " +
        "Install @huggingface/transformers for local semantic search, or set " +
        "MEMORIA_EMBEDDINGS=openai (with OPENAI_API_KEY) to send content to OpenAI.\n",
    );
    break;
}

// ─── OpenAI embeddings ──────────────────────────────────────

async function openaiEmbed(texts: string[]): Promise<Float32Array[]> {
  const apiKey = process.env.OPENAI_API_KEY!;
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // Log full error to stderr but throw sanitized message (no API key leaks)
    process.stderr.write(`Memoria: OpenAI API error ${res.status}: ${body}\n`);
    throw new Error(
      `OpenAI embedding API error (status ${res.status}). Check server logs for details.`,
    );
  }

  const json = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
  };

  // Sort by index to match input order
  const sorted = json.data.sort((a, b) => a.index - b.index);
  return sorted.map((d) => new Float32Array(d.embedding));
}

// ─── Local transformer embeddings (all-MiniLM-L6-v2) ────────

// Lazy singleton — the model (~23MB) is loaded on first use and reused.
let extractorPromise: Promise<
  (input: string[], opts: object) => Promise<{ data: Float32Array; dims: number[] }>
> | null = null;

// Hand-written structural type for the slice of @huggingface/transformers we use.
// The package is an OPTIONAL dependency, so the build must not depend on its
// bundled types: a `typeof import("@huggingface/transformers")` cast (the previous
// approach) makes tsc resolve the package at compile time and hard-fails any
// install where the optional dep was skipped (offline, --omit=optional).
interface TransformersModule {
  pipeline: (task: string, model?: string, opts?: Record<string, unknown>) => Promise<unknown>;
  env: { cacheDir?: string; allowRemoteModels?: boolean };
}

// Module specifier via a variable: tsc does not try to resolve a non-literal
// dynamic import, so type-checking succeeds whether or not the optional dep is
// installed. Runtime behavior is identical.
const TRANSFORMERS_PKG = "@huggingface/transformers";

function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      let mod;
      try {
        mod = await import(TRANSFORMERS_PKG);
      } catch (err) {
        throw new Error(
          `MEMORIA_EMBEDDINGS=minilm but @huggingface/transformers is not installed ` +
            `(${(err as Error).message}). Run \`npm install\` or set MEMORIA_EMBEDDINGS=hash.`,
          { cause: err },
        );
      }
      const { pipeline, env } = mod as TransformersModule;
      if (process.env.MEMORIA_MODEL_CACHE) {
        env.cacheDir = process.env.MEMORIA_MODEL_CACHE;
      }
      // Allow running fully offline once the model is cached / pre-baked.
      if (process.env.MEMORIA_MODEL_OFFLINE === "true") {
        env.allowRemoteModels = false;
      }
      try {
        // dtype MUST stay "q8". @xenova/transformers v2 defaulted to the int8
        // quantized weights; @huggingface/transformers v3 defaults to fp32
        // instead. Same model id, different numbers: measured on identical
        // input, v3-default vectors sit at cosine 0.9929 to the v2 vectors
        // (max element delta 0.0217), while dtype "q8" reproduces them exactly
        // (cosine 1.00000000, delta 0.000000).
        //
        // That 0.993 is the dangerous case, not the safe one. Every store
        // written before this upgrade holds v2 vectors, and the provider-change
        // check keys on provider name and dimension -- both unchanged here -- so
        // nothing would trigger a reindex. The store would silently mix two
        // vector spaces and quietly return slightly worse neighbours forever.
        // Pinning q8 keeps every existing index exactly valid.
        const extractor = await pipeline("feature-extraction", MINILM_MODEL, {
          dtype: "q8",
        });
        process.stderr.write(`Memoria: loaded ${MINILM_MODEL}\n`);
        return extractor as unknown as (
          input: string[],
          opts: object,
        ) => Promise<{ data: Float32Array; dims: number[] }>;
      } catch (err) {
        // Fail loudly: the store committed to the "minilm" vector space, so we
        // must not silently produce a different (hash) embedding. Reset the
        // promise so a later call can retry once the model is reachable.
        extractorPromise = null;
        throw new Error(
          `Failed to load local embedding model ${MINILM_MODEL}: ${(err as Error).message}. ` +
            `Ensure network access for the one-time download, pre-bake the model into the image, ` +
            `or set MEMORIA_EMBEDDINGS=hash to use the lexical fallback.`,
          { cause: err },
        );
      }
    })();
  }
  return extractorPromise;
}

async function minilmEmbed(texts: string[]): Promise<Float32Array[]> {
  const extractor = await loadExtractor();
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  const [n, dim] = out.dims;
  const data = out.data;
  const result: Float32Array[] = [];
  for (let i = 0; i < n; i++) {
    // Copy each row out of the shared backing buffer.
    result.push(Float32Array.from(data.subarray(i * dim, (i + 1) * dim)));
  }
  return result;
}

// ─── Local n-gram embeddings (lexical fallback) ─────────────

function hashNgrams(text: string, dim: number): Float32Array {
  const vec = new Float32Array(dim);
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const words = normalized.split(/\s+/).filter(Boolean);

  // Word-level features
  for (const word of words) {
    const hash = simpleHash(word);
    vec[(hash >>> 0) % dim] += 1;

    // Character trigrams for fuzzy matching
    for (let i = 0; i < word.length - 2; i++) {
      const trigram = word.slice(i, i + 3);
      const h = simpleHash(trigram);
      vec[(h >>> 0) % dim] += 0.5;
    }
  }

  // Bigram features for phrase matching
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = words[i] + " " + words[i + 1];
    const h = simpleHash(bigram);
    vec[(h >>> 0) % dim] += 0.75;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) vec[i] /= norm;
  }

  return vec;
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash;
}

// ─── Public API ─────────────────────────────────────────────

export function getDimension(): number {
  return dimension;
}

export function getProvider(): string {
  return provider;
}

export async function embed(text: string): Promise<Float32Array> {
  if (provider === "openai") return (await openaiEmbed([text]))[0];
  if (provider === "minilm") return (await minilmEmbed([text]))[0];
  return hashNgrams(text, LOCAL_DIM);
}

export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  if (provider === "openai") {
    // OpenAI supports up to 2048 inputs per request; batch in chunks of 100
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 100) {
      results.push(...(await openaiEmbed(texts.slice(i, i + 100))));
    }
    return results;
  }

  if (provider === "minilm") {
    // Bound memory/latency per forward pass.
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 32) {
      results.push(...(await minilmEmbed(texts.slice(i, i + 32))));
    }
    return results;
  }

  return texts.map((t) => hashNgrams(t, LOCAL_DIM));
}

/**
 * Cosine similarity between two vectors.
 */
let warnedDimMismatch = false;

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  // A dimension mismatch means a corrupt/truncated stored BLOB or a partial
  // provider migration. Silently comparing prefixes yields a wrong-but-
  // plausible score; treat the pair as no-match instead, and say so once.
  if (a.length !== b.length) {
    if (!warnedDimMismatch) {
      warnedDimMismatch = true;
      process.stderr.write(
        `Memoria: embedding dimension mismatch (${a.length} vs ${b.length}) — ` +
          `treating as similarity 0. Run memory_index to rebuild the affected rows.\n`,
      );
    }
    return 0;
  }
  const len = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
