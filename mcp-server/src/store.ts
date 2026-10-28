/**
 * SQLite storage for memory chunks, vectors, and access tracking.
 * Uses better-sqlite3 for the database. Vector search is done in-process
 * using cosine similarity (no sqlite-vec extension needed).
 *
 * Features:
 * - FTS5 full-text search for proper BM25 keyword scoring
 * - Content hashing to skip re-embedding unchanged files
 * - Three-signal retrieval (weighted SUM): 0.1·recency + 0.1·importance + 0.8·relevance
 * - Idempotent decay/boost with last-run tracking
 * - Staleness detection based on last_accessed (not updated_at)
 */

import Database from "better-sqlite3";
import { acquireStoreLock, StoreInUseError } from "./store-lock.js";
import { Chunk } from "./chunker.js";
import { embed, embedBatch, cosineSimilarity, getDimension, getProvider } from "./embeddings.js";
import crypto from "crypto";

export interface StoredChunk {
  id: number;
  text: string;
  file: string;
  startLine: number;
  endLine: number;
  embedding: Float32Array;
  importance: number;
  updatedAt: string;
  accessCount: number;
  lastAccessed: string;
}

export interface SearchResult {
  text: string;
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  importance: number;
  recencyScore: number;
  relevanceScore: number;
  importanceScore: number;
  /** How many chunks the semantic candidate scan actually covered vs the store
   *  total. When scanned < total the store exceeded MEMORIA_VECTOR_SCAN_CAP and
   *  recall is partial — surfaced so recall loss is visible, never silent. */
  scannedChunks: number;
  totalChunks: number;
}

// Max chunks scanned for semantic candidate selection per query. Personal
// stores are well under this; larger stores degrade gracefully (still better
// than keyword-only candidates). Override with MEMORIA_VECTOR_SCAN_CAP.
const VECTOR_SCAN_CAP = parseInt(process.env.MEMORIA_VECTOR_SCAN_CAP || "5000", 10);

/**
 * Deterministic per-query offset into the id range for the over-cap vector
 * sample. djb2 over the query text, reduced mod total. Exported for tests.
 */
export function samplePhase(query: string, totalChunks: number): number {
  let h = 5381;
  for (let i = 0; i < query.length; i++) {
    h = ((h << 5) + h + query.charCodeAt(i)) >>> 0; // h * 33 + c, unsigned
  }
  return totalChunks > 0 ? h % totalChunks : 0;
}

/**
 * Select an even sample of exactly `cap` of the `total` chunks, spread across
 * the whole id range and offset by `phase`: keep the rows where
 * floor((rn + phase) * cap / total) increments.
 *
 * The arithmetic parameters are bound as **BigInt** deliberately. better-sqlite3
 * binds JS numbers as SQLite REAL, under which the division is exact, the
 * floor-crossing WHERE clause becomes a tautology, and LIMIT silently degrades
 * the "rotating even sample" to "the oldest cap rows" — precisely the
 * newest-content-invisible failure this sampler exists to prevent. Caught by
 * adversarial review on 2026-07-25 (tests asserted only row COUNTS, which the
 * broken version also satisfied; hence the row-identity tests). BigInt binds
 * as INTEGER, restoring integer division.
 *
 * Exported for tests, which pin the exact row identities per phase.
 */
export function selectEvenSample(
  db: Database.Database,
  cap: number,
  total: number,
  phase: number,
): Array<{ id: number; embedding: Buffer }> {
  const p = BigInt(phase);
  const c = BigInt(cap);
  const t = BigInt(total);
  return db
    .prepare(
      `SELECT id, embedding FROM (
         SELECT id, embedding, ROW_NUMBER() OVER (ORDER BY id) AS rn
         FROM chunks
       ) WHERE ((rn + ?) * ?) / ? > ((rn - 1 + ?) * ?) / ?
       LIMIT ?`,
    )
    .all(p, c, t, p, c, t, BigInt(cap)) as Array<{ id: number; embedding: Buffer }>;
}

// A word, in any script: letters, combining marks, digits, underscore.
const FTS_TERM_RE = /[\p{L}\p{M}\p{N}_]+/gu;
const FTS_MAX_TERMS = 32;
const FTS_WORD_CHAR_RE = /[\p{L}\p{M}\p{N}_]/u;
const FTS_TRAILING_WORD_RE = /[\p{L}\p{M}\p{N}_]+$/u;

/**
 * The first `max` UTF-16 units of `text`, minus a word the cut went through.
 * A truncated last term ("Müll" of "Müller") matches nothing, and because the
 * terms are ANDed, one such term emptied the whole keyword pre-filter behind
 * memory_write's duplicate check for any text longer than the cut. A cut
 * inside a surrogate pair moves back one unit, so a letter outside the BMP
 * (CJK Extension B, say) counts as the word character it is.
 */
export function headWithoutCutWord(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const unit = text.charCodeAt(cut);
  if (unit >= 0xdc00 && unit <= 0xdfff) cut -= 1;
  const head = text.slice(0, cut);
  const next = String.fromCodePoint(text.codePointAt(cut) ?? 0x20);
  return FTS_WORD_CHAR_RE.test(next) ? head.replace(FTS_TRAILING_WORD_RE, "") : head;
}

/**
 * Turn free text into a safe FTS5 MATCH expression: each word becomes a
 * quoted string, and the strings are joined with OR. Returns "" when the
 * text has no words.
 *
 * OR, not FTS5's implicit AND: a natural-language query ("what did we
 * decide about the queue") almost never has every one of its words in one
 * chunk, so AND returned no keyword matches for most real queries. BM25
 * still ranks chunks matching more (and rarer) terms first. On the eval
 * corpus (hash provider) keyword-only nDCG@10 went from 53.8 to 66.5 and
 * the shipped default from 60.4 to 61.7.
 *
 * The previous sanitiser, `text.replace(/[^\w\s]/g, " ")`, had two failures.
 * JavaScript's \w is ASCII-only, so it cut "Müller" to "M ller" and "café" to
 * "caf", and dropped CJK text entirely — keyword search missed exactly the
 * words it existed to find. And it let FTS5 operators through: a query with
 * AND, OR, NOT or NEAR in it either changed meaning or was a syntax error
 * that the search swallowed, silently returning no keyword matches at all.
 * Quoted, "AND" is just a word, and FTS5's own tokenizer (unicode61, which
 * also folds diacritics) splits each quoted term exactly as it split the
 * indexed text.
 */
export function toFtsQuery(text: string, maxTerms = FTS_MAX_TERMS): string {
  const terms = text.match(FTS_TERM_RE) ?? [];
  return terms
    .slice(0, maxTerms)
    .map((t) => `"${t}"`)
    .join(" OR ");
}

/**
 * Bumped when indexed rows need rebuilding from the files. 2: recency dates
 * come from the memory (frontmatter `updated`/`created`, else file mtime)
 * instead of the time it was indexed, so every row indexed by version 1
 * carries an index-time date. 3: the lexical (hash) embedding keeps
 * non-ASCII words instead of mapping them to nothing.
 */
const INDEX_VERSION = "3";

/**
 * Whether an index written at `stored` version must be rebuilt. Version 3
 * changed only the lexical (hash, provider "local") vectors, so a version 2
 * index from another provider is current and is not re-embedded (a full
 * re-embed costs OpenAI users money and leaves search empty meanwhile).
 */
export function indexVersionOutdated(stored: string | undefined, provider: string): boolean {
  if (stored === INDEX_VERSION) return false;
  if (stored === "2" && provider !== "local") return false;
  return true;
}

/** When a memory was indexed: the inputs for its recency date. */
export interface IndexDates {
  /**
   * The memory's own date candidates, best first (frontmatter `updated`,
   * then `created`); the first one that parses as an ISO date wins.
   */
  contentDate?: unknown | unknown[];
  /** The file's mtime, in epoch ms. */
  mtimeMs?: number;
}

function toDay(ms: number): string {
  return new Date(ms).toISOString().split("T")[0];
}

// ISO dates only: V8's Date parser also accepts "January 5" (as 2001) or
// "1", which would silently misdate a memory.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function parseDateMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }
  if (typeof value !== "string" || !ISO_DATE.test(value.trim())) return undefined;
  const ms = new Date(value.trim()).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

export class MemoryStore {
  private db: Database.Database;
  private dimension: number;
  private releaseLock: () => void;
  private readonly dbPath: string;
  /**
   * Whether this process holds the store lock. Only the primary runs what
   * must not run twice over one store: the collector (its whole-state
   * registry file is last-writer-wins) and scheduled maintenance.
   */
  isPrimary = true;

  /**
   * @param opts.shared When the store is held by another live server, open
   *   it as a secondary instead of failing. Each Claude Code window or
   *   Claude Desktop session starts its own stdio server on the same store;
   *   refusing the second one left that session with no memory tools.
   *   SQLite (WAL, busy_timeout) makes concurrent reads and writes from
   *   processes on one host safe; see isPrimary for what stays with the
   *   primary. A secondary takes over the lock when the primary exits
   *   (tryBecomePrimary).
   */
  constructor(dbPath: string, opts: { shared?: boolean } = {}) {
    this.dbPath = dbPath;
    // One process per store directory (review H3) unless shared: without
    // `shared`, fail loudly rather than race another server.
    try {
      this.releaseLock = acquireStoreLock(dbPath);
    } catch (err) {
      // Secondary mode is for processes on ONE host, where SQLite's locking
      // is sound. A holder on another host (two replicas on a network
      // mount) is still refused: SQLite's WAL is not safe across hosts.
      if (!opts.shared || !(err instanceof StoreInUseError) || err.foreign) throw err;
      this.isPrimary = false;
      this.releaseLock = () => {};
      process.stderr.write(
        `Memoria: another Memoria server` +
          (Number.isFinite(err.holderPid) ? ` (pid ${err.holderPid})` : "") +
          ` holds this store; running as a secondary. Search, reading and writing work; ` +
          `the collector and scheduled maintenance run in that server.\n`,
      );
    }
    try {
      this.db = new Database(dbPath);
    } catch (err: any) {
      this.releaseLock();
      if (err.message?.includes("Could not locate") || err.code === "MODULE_NOT_FOUND") {
        throw new Error(
          `Failed to load better-sqlite3 native module. ` +
            `Try running: npm rebuild better-sqlite3\n` +
            `Original error: ${err.message}`,
          { cause: err },
        );
      }
      throw err;
    }
    try {
      this.dimension = getDimension();
      this.init();
    } catch (initErr) {
      try {
        this.db.close();
      } catch {
        // already closed / never opened cleanly
      }
      this.releaseLock();
      throw initErr;
    }
  }

  needsReindex: boolean = false;

  /**
   * A secondary tries to take the store lock (the primary may have exited).
   * Returns whether this process is now the primary.
   */
  tryBecomePrimary(): boolean {
    if (this.isPrimary) return true;
    try {
      // No waiting on another host's lock: this runs on a timer.
      this.releaseLock = acquireStoreLock(this.dbPath, { foreignWaitMs: 0 });
      this.isPrimary = true;
      process.stderr.write("Memoria: took over the store lock; this server is now the primary.\n");
      return true;
    } catch (err) {
      if (err instanceof StoreInUseError) return false;
      throw err;
    }
  }

  private init(): void {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    // Defence in depth behind the store lock: brief writer contention
    // (e.g. a test or tool opening the DB) waits instead of SQLITE_BUSY.
    this.db.pragma("busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        file TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        importance INTEGER DEFAULT 5,
        updated_at TEXT DEFAULT (date('now')),
        access_count INTEGER DEFAULT 0,
        last_accessed TEXT DEFAULT (date('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
      CREATE INDEX IF NOT EXISTS idx_chunks_last_accessed ON chunks(last_accessed DESC);
      CREATE INDEX IF NOT EXISTS idx_chunks_importance ON chunks(importance DESC);

      CREATE TABLE IF NOT EXISTS file_meta (
        file TEXT PRIMARY KEY,
        importance INTEGER DEFAULT 5,
        access_count INTEGER DEFAULT 0,
        last_accessed TEXT DEFAULT (date('now')),
        updated_at TEXT DEFAULT (date('now')),
        content_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Create FTS5 virtual table for proper BM25 keyword scoring
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          text,
          file,
          content='chunks',
          content_rowid='id'
        );
      `);

      // Create triggers to keep FTS in sync
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
          INSERT INTO chunks_fts(rowid, text, file) VALUES (new.id, new.text, new.file);
        END;

        CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text, file) VALUES('delete', old.id, old.text, old.file);
        END;

        CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
          INSERT INTO chunks_fts(chunks_fts, rowid, text, file) VALUES('delete', old.id, old.text, old.file);
          INSERT INTO chunks_fts(rowid, text, file) VALUES (new.id, new.text, new.file);
        END;
      `);
    } catch {
      // FTS5 not available — fall back to naive keyword matching
      process.stderr.write("Memoria: FTS5 not available, using fallback keyword search\n");
    }

    // One-time migration: normalize legacy Windows backslash file keys to
    // forward slashes so the index is portable and matches getRelativePath's
    // new output. Idempotent (matches nothing once normalized); a no-op on
    // POSIX where keys were always forward-slash. The chunks UPDATE trigger
    // keeps the FTS file column in sync.
    try {
      const migrated = this.db
        .prepare("UPDATE chunks SET file = REPLACE(file, '\\', '/') WHERE file LIKE '%\\%'")
        .run();
      this.db
        .prepare("UPDATE file_meta SET file = REPLACE(file, '\\', '/') WHERE file LIKE '%\\%'")
        .run();
      if (migrated.changes > 0) {
        process.stderr.write(
          `Memoria: normalized ${migrated.changes} backslash file key(s) to forward slashes\n`,
        );
      }
    } catch {
      // Non-fatal — keys just stay as they are
    }

    // Detect embedding provider change → force reindex
    const currentProvider = getProvider();
    const currentDim = String(this.dimension);
    const storedProvider = this.db
      .prepare("SELECT value FROM store_meta WHERE key = 'embedding_provider'")
      .get() as { value: string } | undefined;
    const storedDim = this.db
      .prepare("SELECT value FROM store_meta WHERE key = 'embedding_dimension'")
      .get() as { value: string } | undefined;

    const storedIndexVersion = this.db
      .prepare("SELECT value FROM store_meta WHERE key = 'index_version'")
      .get() as { value: string } | undefined;
    const providerChanged =
      storedProvider?.value !== currentProvider || storedDim?.value !== currentDim;
    // A store that already has an index from an older version is rebuilt;
    // a brand-new one (no provider recorded yet) is not announced twice.
    const indexOutdated =
      !!storedProvider && indexVersionOutdated(storedIndexVersion?.value, currentProvider);

    if (providerChanged || indexOutdated) {
      process.stderr.write(
        providerChanged
          ? `Memoria: embedding provider changed (${storedProvider?.value ?? "none"}→${currentProvider}, dim ${storedDim?.value ?? "?"}→${currentDim}). Will reindex.\n`
          : `Memoria: index format updated (v${storedIndexVersion?.value ?? "1"}→v${INDEX_VERSION}). Will reindex.\n`,
      );
      this.db.prepare("DELETE FROM chunks").run();
      // Rebuild FTS after clearing chunks
      try {
        this.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
      } catch {
        /* FTS5 not available */
      }
      // Forget the content hashes so every file is re-embedded, but keep the
      // access history: file_meta is the only record of access_count and
      // last_accessed, and wiping it made every memory look never-read
      // (stale, decayed, recency 0) after an upgrade or provider switch.
      this.db.prepare("UPDATE file_meta SET content_hash = NULL").run();
      this.needsReindex = true;
    }

    // Store current provider info
    this.db
      .prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('embedding_provider', ?)")
      .run(currentProvider);
    this.db
      .prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('embedding_dimension', ?)")
      .run(currentDim);
    this.db
      .prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('index_version', ?)")
      .run(INDEX_VERSION);
  }

  /**
   * Check if a file's content has changed since last index.
   */
  hasContentChanged(file: string, content: string): boolean {
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    const stored = this.db
      .prepare("SELECT content_hash FROM file_meta WHERE file = ?")
      .get(file) as { content_hash: string | null } | undefined;

    return !stored || stored.content_hash !== hash;
  }

  /**
   * Store the content hash for a file after indexing.
   */
  private storeContentHash(
    file: string,
    content: string,
    importance: number,
    updatedAt: string,
    lastAccessed: string,
  ): void {
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    // last_accessed is computed by indexDatesFor (never "now" for merely
    // being indexed); access_count is left as it is.
    this.db
      .prepare(
        `INSERT INTO file_meta (file, content_hash, importance, updated_at, last_accessed)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(file) DO UPDATE SET
           content_hash = excluded.content_hash,
           importance = excluded.importance,
           updated_at = excluded.updated_at,
           last_accessed = excluded.last_accessed`,
      )
      .run(file, hash, importance, updatedAt, lastAccessed);
  }

  /**
   * The recency inputs for a file about to be (re)indexed. Recency used to
   * be the time a row was inserted, so every edit, provider switch or
   * rebuild made every memory look brand new and restarted the decay and
   * staleness clocks.
   *
   * - An edit to a file already in the index happened at its mtime.
   * - On a first index (a new file, or a rebuild after the index was
   *   dropped) the frontmatter date is the memory's own record of when it
   *   was written. mtime is only the fallback there: a git clone or pull
   *   stamps every file with the checkout time.
   *
   * Access history (last_accessed, access_count) lives in file_meta and is
   * carried onto the new chunk rows. last_accessed is "last touched": the
   * later of the last read and this content date, so an edit counts as a
   * touch for staleness and decay as it does for search recency. A
   * last_accessed with no recorded access is ignored: indexes before
   * version 2 stamped it with the time of indexing.
   */
  private indexDatesFor(
    file: string,
    dates: IndexDates | undefined,
  ): { updatedAt: string; lastAccessed: string; accessCount: number } {
    const now = Date.now();
    const meta = this.db
      .prepare("SELECT content_hash, access_count, last_accessed FROM file_meta WHERE file = ?")
      .get(file) as
      | { content_hash: string | null; access_count: number; last_accessed: string | null }
      | undefined;
    const mtimeMs = Math.min(dates?.mtimeMs ?? now, now);
    const candidates = Array.isArray(dates?.contentDate) ? dates.contentDate : [dates?.contentDate];
    const contentMs = candidates.map(parseDateMs).find((ms) => ms !== undefined);
    const updatedMs = meta?.content_hash ? mtimeMs : Math.min(contentMs ?? mtimeMs, now);
    const updatedAt = toDay(updatedMs);
    const accessCount = meta?.access_count ?? 0;
    const lastRead = accessCount > 0 ? meta?.last_accessed : null;
    return {
      updatedAt,
      lastAccessed: lastRead && lastRead > updatedAt ? lastRead : updatedAt,
      accessCount,
    };
  }

  /**
   * Drop a file's chunks while keeping its content hash, for a file that
   * now has no indexable body. Leaving the old chunks made text a user
   * deleted (e.g. to redact it) searchable indefinitely.
   */
  clearFile(file: string, content: string, importance: number = 5): void {
    const { updatedAt, lastAccessed } = this.indexDatesFor(file, undefined);
    this.db
      .transaction(() => {
        this.db.prepare("DELETE FROM chunks WHERE file = ?").run(file);
        this.storeContentHash(file, content, importance, updatedAt, lastAccessed);
      })
      .immediate();
  }

  /**
   * Index chunks from a file, replacing any existing chunks for that file.
   * Skips re-embedding if content hasn't changed (use force=true to override).
   */
  async indexChunks(
    chunks: Chunk[],
    importance: number = 5,
    content?: string,
    dates?: IndexDates,
  ): Promise<void> {
    if (chunks.length === 0) return;

    const file = chunks[0].file;

    // Skip if content unchanged
    if (content && !this.hasContentChanged(file, content)) {
      return;
    }

    const embeddings = await embedBatch(chunks.map((c) => c.text));

    const deleteStmt = this.db.prepare("DELETE FROM chunks WHERE file = ?");
    const insertStmt = this.db.prepare(
      `INSERT INTO chunks (text, file, start_line, end_line, embedding, importance,
                           updated_at, access_count, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const transaction = this.db.transaction(() => {
      // Read inside the transaction, after the embedding await, so the
      // dates match the file_meta row this write replaces.
      const { updatedAt, lastAccessed, accessCount } = this.indexDatesFor(file, dates);
      deleteStmt.run(file);
      for (let i = 0; i < chunks.length; i++) {
        const embBuffer = Buffer.from(embeddings[i].buffer);
        insertStmt.run(
          chunks[i].text,
          chunks[i].file,
          chunks[i].startLine,
          chunks[i].endLine,
          embBuffer,
          importance,
          updatedAt,
          accessCount,
          lastAccessed,
        );
      }
      if (content) this.storeContentHash(file, content, importance, updatedAt, lastAccessed);
    });

    // IMMEDIATE: this transaction reads (indexDatesFor) before it writes,
    // and a deferred transaction that must upgrade from a read to a write
    // lock while another process writes fails with SQLITE_BUSY at once,
    // bypassing busy_timeout. Shared stores have several writers.
    transaction.immediate();
  }

  /**
   * Check if FTS5 is available.
   */
  private hasFts5(): boolean {
    try {
      this.db.prepare("SELECT * FROM chunks_fts LIMIT 0").run();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch chunk rows by id, batched to stay under SQLite's host-parameter
   * limit (SQLITE_MAX_VARIABLE_NUMBER, 999 in common builds). Without
   * batching, a large max_results (candidate set can reach max_results*20)
   * produces an IN(...) list that exceeds the limit and throws.
   * `columns` is a hardcoded SELECT list — never user input.
   */
  private fetchChunksByIds<T>(ids: number[], columns: string): T[] {
    const BATCH = 800;
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const placeholders = slice.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT ${columns} FROM chunks WHERE id IN (${placeholders})`)
        .all(...slice) as T[];
      for (const r of rows) out.push(r);
    }
    return out;
  }

  /**
   * Three-signal search: recency × importance × relevance
   * Uses two-stage candidate pre-filtering to avoid loading all chunks.
   * Stage 1: Collect candidate IDs from FTS5 + recency + importance
   * Stage 2: Fetch and score only candidates
   */
  async search(
    query: string,
    maxResults: number = 10,
    // Relevance dominates; recency and importance are tie-breakers. They
    // were 0.2 and 0.3, but relevance scores sit in a narrow band while the
    // priors span 0-1, so priors at half the weight decided most rankings:
    // eval/ measured the old default far below relevance alone on every
    // provider (see eval/README.md).
    weights = { recency: 0.1, importance: 0.1, relevance: 0.8 },
    // Split of the relevance signal between vector cosine and keyword score.
    // Exposed as a parameter purely so eval/ can sweep it; every caller in the
    // server uses the default, and the default is the shipped behaviour.
    vectorMix: number = 0.7,
  ): Promise<SearchResult[]> {
    // Backstop against bad numeric input (float/NaN/huge): SQLite LIMIT needs a
    // sane non-negative integer. Tool schemas also constrain this upstream.
    maxResults = Math.max(
      1,
      Math.min(1000, Math.floor(Number.isFinite(maxResults) ? maxResults : 10)),
    );

    // Guard against degenerate queries — fall back to recency/importance only.
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return this.searchByRecency(maxResults);
    }

    const queryEmbedding = await embed(trimmedQuery);
    const now = Date.now();
    const useFts = this.hasFts5();

    // ── Stage 1: Collect candidate IDs ──────────────────────
    const candidateIds = new Set<number>();
    const ftsScores = new Map<number, number>();

    // FTS5 candidates (keyword relevance)
    if (useFts) {
      try {
        const ftsQuery = toFtsQuery(query);
        if (ftsQuery) {
          const ftsRows = this.db
            .prepare(
              `SELECT rowid, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`,
            )
            .all(ftsQuery, maxResults * 10) as Array<{ rowid: number; rank: number }>;

          if (ftsRows.length > 0) {
            for (const row of ftsRows) {
              candidateIds.add(row.rowid);
              // FIXED transform of the BM25 rank (FTS5 rank is negative;
              // more negative = better). -rank / (-rank + K) maps it onto
              // (0, 1) monotonically and ABSOLUTELY: the same match quality
              // always yields the same score, unlike the previous per-query
              // min-max normalization where the best match in every result
              // set scored exactly 1.0 regardless of how good it actually
              // was (a rank position, not a magnitude). K = half-saturation
              // constant: rank -10 → 0.5.
              const bm25 = Math.max(0, -row.rank);
              ftsScores.set(row.rowid, bm25 / (bm25 + 10));
            }
          }
        }
      } catch (err) {
        // Quoted terms cannot be a syntax error, so this is unexpected:
        // say so rather than quietly searching without keywords.
        process.stderr.write(`Memoria: keyword search failed: ${(err as Error).message}\n`);
      }
    }

    // Recency candidates (recently accessed)
    const recencyRows = this.db
      .prepare(`SELECT id FROM chunks ORDER BY last_accessed DESC LIMIT ?`)
      .all(maxResults * 5) as Array<{ id: number }>;
    for (const row of recencyRows) candidateIds.add(row.id);

    // NOTE: there is deliberately no importance-ordered candidate block here.
    // Importance already contributes 0.3 of the final score (a retrieval
    // prior); ALSO using it as a candidate FILTER triple-counted it (filter +
    // prior + access-driven boost feeding back into it), entrenching a few
    // high-importance memories while the long tail became unreachable.
    // Importance-but-irrelevant rows shouldn't outrank relevant ones anyway.

    // Vector candidates (semantic relevance). Without this, a chunk that is
    // semantically on-topic but shares no keywords and is neither recent nor
    // high-importance never enters the candidate set — so the vector score
    // could never surface it. Sims are cached and reused in Stage 2.
    const vectorSims = new Map<number, number>();
    const totalChunks = (
      this.db.prepare(`SELECT COUNT(*) as cnt FROM chunks`).get() as { cnt: number }
    ).cnt;
    let scannedChunks = 0;
    {
      // Recall-fair coverage: when the store fits under the cap (the normal
      // personal-store case) scan EVERYTHING, in stable id order. When it
      // exceeds the cap, scan an even sample of EXACTLY cap rows spread
      // across the whole id range. Two properties matter here:
      //
      //  1. No cliff. The previous ceil-stride sample (`keep every Nth row`)
      //     jumped from scanning 5000 rows at total=5000 to 2501 at
      //     total=5001 — a ~50% overnight recall discontinuity. Selecting the
      //     rows where floor((rn + phase) * cap / total) increments yields
      //     exactly `cap` rows for ANY total, so coverage degrades
      //     continuously as the store grows.
      //
      //  2. No permanently invisible rows. A fixed sample excludes the same
      //     (total - cap) rows from the vector path of EVERY query forever.
      //     The phase is derived from the query text, so different queries
      //     see different residues of the id range and any given row is
      //     reachable; repeating the same query stays deterministic.
      //
      // Coverage is reported on every result (scannedChunks/totalChunks) so
      // partial recall is visible, never silent.
      let embRows: Array<{ id: number; embedding: Buffer }>;
      if (totalChunks <= VECTOR_SCAN_CAP) {
        embRows = this.db.prepare(`SELECT id, embedding FROM chunks ORDER BY id`).all() as Array<{
          id: number;
          embedding: Buffer;
        }>;
      } else {
        const phase = samplePhase(trimmedQuery, totalChunks);
        embRows = selectEvenSample(this.db, VECTOR_SCAN_CAP, totalChunks, phase);
      }
      scannedChunks = embRows.length;
      const ranked: Array<{ id: number; sim: number }> = [];
      for (const row of embRows) {
        const storedEmb = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        const sim = cosineSimilarity(queryEmbedding, storedEmb);
        vectorSims.set(row.id, sim);
        ranked.push({ id: row.id, sim });
      }
      ranked.sort((a, b) => b.sim - a.sim);
      for (const { id } of ranked.slice(0, maxResults * 5)) candidateIds.add(id);
    }

    // ── Stage 2: Fetch and score candidates ─────────────────
    let rows: Array<{
      id: number;
      text: string;
      file: string;
      start_line: number;
      end_line: number;
      embedding: Buffer;
      importance: number;
      updated_at: string;
      access_count: number;
      last_accessed: string;
    }>;

    if (candidateIds.size > 0) {
      // Fetch only candidate rows (batched to stay under the SQLite var limit)
      rows = this.fetchChunksByIds(
        Array.from(candidateIds),
        `id, text, file, start_line, end_line, embedding,
         importance, updated_at, access_count, last_accessed`,
      );
    } else {
      // No candidates from FTS/recency — fallback to capped scan. Order
      // deterministically so the scanned window is stable and the most-likely
      // relevant slice on large stores (was arbitrary rowid order).
      rows = this.db
        .prepare(
          `SELECT id, text, file, start_line, end_line, embedding,
                  importance, updated_at, access_count, last_accessed
           FROM chunks ORDER BY importance DESC, last_accessed DESC LIMIT 5000`,
        )
        .all() as typeof rows;
    }

    const scored: SearchResult[] = rows.map((row) => {
      // Reuse the similarity computed during the vector candidate scan; only
      // recompute for candidates that came in beyond the scan cap.
      let vectorSim = vectorSims.get(row.id);
      if (vectorSim === undefined) {
        const storedEmb = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        vectorSim = cosineSimilarity(queryEmbedding, storedEmb);
      }

      // Uniform keyword scoring across the whole candidate pool: rows the FTS
      // query matched use the fixed BM25 transform; every other candidate
      // (recency/vector-sourced) gets the substring fallback instead of a flat
      // 0, so scoring is consistent no matter which path surfaced the row.
      let keywordScore: number | undefined = useFts ? ftsScores.get(row.id) : undefined;
      if (keywordScore === undefined) {
        const textLower = row.text.toLowerCase();
        const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
        let keywordHits = 0;
        for (const term of queryTerms) {
          if (textLower.includes(term)) keywordHits++;
        }
        keywordScore = queryTerms.length > 0 ? keywordHits / queryTerms.length : 0;
        // The substring fallback is coarser than BM25 — cap it below the BM25
        // transform's typical range so a fallback-scored row can't outrank a
        // genuine FTS match on keyword signal alone.
        keywordScore = Math.min(keywordScore, 0.6);
      }

      const relevanceScore = vectorMix * vectorSim + (1 - vectorMix) * keywordScore;
      // Recency = time since the memory was last TOUCHED — edited or read —
      // matching what users understand "recent" to mean. Previously this used
      // updated_at alone (B6): a heavily-consulted old memory ranked as
      // stale-recency forever while the decay job, which runs off
      // last_accessed, considered it fresh.
      //
      // Known tradeoff (kept deliberately): search itself bumps last_accessed
      // on returned files, so being returned refreshes recency — a mild
      // rich-get-richer effect. Unlike the removed importance feedback loop
      // this one is bounded (0.1 weight) and self-decaying (30-day half-life;
      // nothing ratchets), and the alternative — reads not counting as
      // "recent" — is what B6 was filed about. Revisit if the relevance
      // fixture ever shows entrenchment.
      //
      // NaN-guard: a missing/garbled date contributes -Infinity via
      // getTime() → max() picks the other.
      const updatedMs = new Date(row.updated_at).getTime();
      const accessedMs = new Date(row.last_accessed).getTime();
      const touchedMs = Math.max(
        Number.isFinite(updatedMs) ? updatedMs : -Infinity,
        Number.isFinite(accessedMs) ? accessedMs : -Infinity,
      );
      const ageDays = Number.isFinite(touchedMs)
        ? (now - touchedMs) / (24 * 60 * 60 * 1000)
        : Infinity;
      const recencyScore = Math.pow(0.5, ageDays / 30);
      // Clamp to [0, 1] — importance is supposed to be 1-10 but defensive clamp
      // ensures search weights stay normalized even if a memory has out-of-range importance.
      const importanceScore = Math.max(0, Math.min(1, row.importance / 10));

      const score =
        weights.recency * recencyScore +
        weights.importance * importanceScore +
        weights.relevance * relevanceScore;

      return {
        text: row.text.slice(0, 700),
        file: row.file,
        startLine: row.start_line,
        endLine: row.end_line,
        score,
        importance: row.importance,
        recencyScore,
        relevanceScore,
        importanceScore,
        scannedChunks,
        totalChunks,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
  }

  /**
   * Fallback search when the query is empty or only contains punctuation.
   * Returns recent + important chunks instead of failing or doing a full scan.
   */
  private searchByRecency(maxResults: number): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT id, text, file, start_line, end_line,
                importance, updated_at, access_count, last_accessed
         FROM chunks
         ORDER BY last_accessed DESC, importance DESC
         LIMIT ?`,
      )
      .all(maxResults) as Array<{
      id: number;
      text: string;
      file: string;
      start_line: number;
      end_line: number;
      importance: number;
      updated_at: string;
      access_count: number;
      last_accessed: string;
    }>;

    const now = Date.now();
    const totalChunks = (
      this.db.prepare(`SELECT COUNT(*) as cnt FROM chunks`).get() as { cnt: number }
    ).cnt;
    return rows.map((row) => {
      // Same "last touched" semantics as the main search path (B6).
      const updatedMs = new Date(row.updated_at).getTime();
      const accessedMs = new Date(row.last_accessed).getTime();
      const touchedMs = Math.max(
        Number.isFinite(updatedMs) ? updatedMs : -Infinity,
        Number.isFinite(accessedMs) ? accessedMs : -Infinity,
      );
      const ageDays = Number.isFinite(touchedMs)
        ? (now - touchedMs) / (24 * 60 * 60 * 1000)
        : Infinity;
      const recencyScore = Math.pow(0.5, ageDays / 30);
      const importanceScore = Math.max(0, Math.min(1, row.importance / 10));
      return {
        text: row.text.slice(0, 700),
        file: row.file,
        startLine: row.start_line,
        endLine: row.end_line,
        score: 0.5 * recencyScore + 0.5 * importanceScore,
        importance: row.importance,
        recencyScore,
        relevanceScore: 0,
        importanceScore,
        // Degenerate-query path does no semantic scan; report full coverage of
        // zero scanning honestly.
        scannedChunks: totalChunks,
        totalChunks,
      };
    });
  }

  /**
   * Track access to a file's chunks.
   */
  /**
   * Get the live access count for a file from file_meta (not stale frontmatter).
   * Returns 0 if the file has never been tracked.
   */
  getAccessCount(file: string): number {
    const row = this.db.prepare("SELECT access_count FROM file_meta WHERE file = ?").get(file) as
      { access_count: number } | undefined;
    return row?.access_count ?? 0;
  }

  trackAccess(file: string): void {
    const now = new Date().toISOString().split("T")[0];
    this.db
      .prepare(
        "UPDATE chunks SET access_count = access_count + 1, last_accessed = ? WHERE file = ?",
      )
      .run(now, file);

    this.db
      .prepare(
        `INSERT INTO file_meta (file, access_count, last_accessed)
         VALUES (?, 1, ?)
         ON CONFLICT(file) DO UPDATE SET
           access_count = access_count + 1,
           last_accessed = ?`,
      )
      .run(file, now, now);
  }

  /**
   * Track access to many files in one transaction. Used by memory_search so
   * that searching (the dominant access path) feeds boost/decay/staleness —
   * not just explicit memory_read calls.
   */
  trackAccessBatch(files: string[]): void {
    if (files.length === 0) return;
    const now = new Date().toISOString().split("T")[0];
    const updChunks = this.db.prepare(
      "UPDATE chunks SET access_count = access_count + 1, last_accessed = ? WHERE file = ?",
    );
    const upsertMeta = this.db.prepare(
      `INSERT INTO file_meta (file, access_count, last_accessed)
       VALUES (?, 1, ?)
       ON CONFLICT(file) DO UPDATE SET
         access_count = access_count + 1,
         last_accessed = ?`,
    );
    const tx = this.db.transaction((list: string[]) => {
      for (const f of list) {
        updChunks.run(now, f);
        upsertMeta.run(f, now, now);
      }
    });
    tx.immediate(files);
  }

  /**
   * Remove all chunks for a file.
   */
  removeFile(file: string): void {
    this.db.prepare("DELETE FROM chunks WHERE file = ?").run(file);
    this.db.prepare("DELETE FROM file_meta WHERE file = ?").run(file);
  }

  /** Make every file count as changed, so the next pass re-embeds it all. */
  forgetContentHashes(): void {
    this.db.prepare("UPDATE file_meta SET content_hash = NULL").run();
  }

  /**
   * Forget files that no longer exist. A rebuild drops every chunk but keeps
   * file_meta (it holds the access history), so a file deleted while the
   * server was down left a row no sweep would see, and a new file later
   * created at that path inherited its access count.
   */
  retainFiles(existing: string[], stillExists: (file: string) => boolean = () => false): number {
    const keep = new Set(existing);
    const rows = this.db.prepare("SELECT file FROM file_meta").all() as Array<{ file: string }>;
    // `existing` is a listing taken before a pass that may run for minutes;
    // a file written meanwhile is not in it, so ask again before dropping.
    const gone = rows.map((r) => r.file).filter((f) => !keep.has(f) && !stillExists(f));
    if (gone.length === 0) return 0;
    const del = this.db.prepare("DELETE FROM file_meta WHERE file = ?");
    const delChunks = this.db.prepare("DELETE FROM chunks WHERE file = ?");
    this.db
      .transaction(() => {
        for (const f of gone) {
          del.run(f);
          delChunks.run(f);
        }
      })
      .immediate();
    return gone.length;
  }

  /**
   * Get all indexed files.
   */
  getIndexedFiles(): string[] {
    const rows = this.db.prepare("SELECT DISTINCT file FROM chunks").all() as Array<{
      file: string;
    }>;
    return rows.map((r) => r.file);
  }

  /**
   * Get stats about the memory store, including importance distribution.
   */
  getStats(): {
    totalChunks: number;
    totalFiles: number;
    avgImportance: number;
    medianImportance: number;
    importanceDistribution: Record<number, number>;
    staleCount: number;
    topAccessed: Array<{ file: string; access_count: number }>;
  } {
    const totalChunks = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number }
    ).cnt;

    const totalFiles = (
      this.db.prepare("SELECT COUNT(DISTINCT file) as cnt FROM chunks").get() as {
        cnt: number;
      }
    ).cnt;

    const avgImportance =
      (
        this.db.prepare("SELECT AVG(importance) as avg FROM chunks").get() as {
          avg: number | null;
        }
      ).avg ?? 0;

    // Importance distribution (count per level 1-10)
    const distRows = this.db
      .prepare(
        "SELECT importance, COUNT(*) as cnt FROM chunks GROUP BY importance ORDER BY importance",
      )
      .all() as Array<{ importance: number; cnt: number }>;
    const importanceDistribution: Record<number, number> = {};
    for (const row of distRows) {
      importanceDistribution[row.importance] = row.cnt;
    }

    // Median importance
    const allImportances = this.db
      .prepare("SELECT importance FROM chunks ORDER BY importance")
      .all() as Array<{ importance: number }>;
    const medianImportance =
      allImportances.length > 0
        ? allImportances[Math.floor(allImportances.length / 2)].importance
        : 0;

    // Staleness: use last_accessed (not updated_at) — a frequently-read memory isn't stale
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const staleCount = (
      this.db
        .prepare(
          "SELECT COUNT(DISTINCT file) as cnt FROM chunks WHERE last_accessed < ? AND importance <= 5",
        )
        .get(ninetyDaysAgo) as { cnt: number }
    ).cnt;

    const topAccessed = this.db
      .prepare(
        "SELECT file, SUM(access_count) as access_count FROM chunks GROUP BY file ORDER BY access_count DESC LIMIT 5",
      )
      .all() as Array<{ file: string; access_count: number }>;

    return {
      totalChunks,
      totalFiles,
      avgImportance: Math.round(avgImportance * 10) / 10,
      medianImportance,
      importanceDistribution,
      staleCount,
      topAccessed,
    };
  }

  /**
   * Find potentially stale memories (based on last_accessed, not updated_at).
   */
  findStale(
    daysThreshold: number = 90,
    importanceThreshold: number = 5,
  ): Array<{
    file: string;
    importance: number;
    lastAccessed: string;
    accessCount: number;
  }> {
    const cutoff = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    return this.db
      .prepare(
        `SELECT DISTINCT file, importance, last_accessed as lastAccessed, access_count as accessCount
         FROM chunks
         WHERE last_accessed < ? AND importance <= ?
         ORDER BY importance ASC, last_accessed ASC`,
      )
      .all(cutoff, importanceThreshold) as Array<{
      file: string;
      importance: number;
      lastAccessed: string;
      accessCount: number;
    }>;
  }

  /**
   * Idempotent importance decay for unused memories.
   * Tracks the last run date — won't double-decay if called multiple times.
   */
  decayImportance(daysSinceAccess: number = 60): number {
    const today = new Date().toISOString().split("T")[0];
    const lastRun = this.db
      .prepare("SELECT value FROM store_meta WHERE key = 'last_decay_run'")
      .get() as { value: string } | undefined;

    if (lastRun?.value === today) {
      return 0; // Already ran today
    }

    const cutoff = new Date(Date.now() - daysSinceAccess * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];

    const result = this.db
      .prepare(
        "UPDATE chunks SET importance = MAX(1, importance - 1) WHERE last_accessed < ? AND importance > 1",
      )
      .run(cutoff);

    this.db
      .prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('last_decay_run', ?)")
      .run(today);

    return result.changes;
  }

  /**
   * Idempotent importance boost for frequently accessed memories.
   * Tracks the last run date — won't double-boost if called multiple times.
   */
  boostImportance(accessThreshold: number = 10): number {
    const today = new Date().toISOString().split("T")[0];
    const lastRun = this.db
      .prepare("SELECT value FROM store_meta WHERE key = 'last_boost_run'")
      .get() as { value: string } | undefined;

    if (lastRun?.value === today) {
      return 0; // Already ran today
    }

    // Bounded at two above the memory's own (frontmatter) importance, kept in
    // file_meta. Every search result counts as an access, so a file that
    // keeps being returned was boosted +1 on every run day and drifted to 10
    // under MEMORIA_AUTO_OPTIMIZE, whatever its author rated it.
    const cap = `MIN(10, COALESCE((SELECT fm.importance FROM file_meta fm WHERE fm.file = chunks.file), 5) + 2)`;
    const result = this.db
      .prepare(
        `UPDATE chunks SET importance = MIN(${cap}, importance + 1)
         WHERE access_count >= ? AND importance < ${cap}`,
      )
      .run(accessThreshold);

    this.db
      .prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('last_boost_run', ?)")
      .run(today);

    return result.changes;
  }

  /**
   * Search for similar memories to a given text (for dedup checking).
   * Uses candidate pre-filtering to avoid full scan.
   * Returns top-N most similar chunks with their file paths.
   */
  async findSimilar(
    text: string,
    topN: number = 3,
  ): Promise<
    Array<{
      file: string;
      text: string;
      similarity: number;
    }>
  > {
    const queryEmbedding = await embed(text);

    // Pre-filter candidates using FTS5 if available
    const candidateIds = new Set<number>();
    if (this.hasFts5()) {
      try {
        const ftsQuery = toFtsQuery(headWithoutCutWord(text, 200));
        if (ftsQuery) {
          const ftsRows = this.db
            // ORDER BY rank: with OR-joined terms nearly every chunk matches
            // a common word, so an unordered LIMIT returned the lowest
            // rowids and missed the actual duplicate.
            .prepare(`SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`)
            .all(ftsQuery, topN * 20) as Array<{ rowid: number }>;
          for (const row of ftsRows) candidateIds.add(row.rowid);
        }
      } catch (err) {
        process.stderr.write(
          `Memoria: keyword pre-filter for similarity failed: ${(err as Error).message}\n`,
        );
      }
    }

    // Also include recent chunks as candidates
    const recentRows = this.db
      .prepare(`SELECT id FROM chunks ORDER BY last_accessed DESC LIMIT ?`)
      .all(topN * 20) as Array<{ id: number }>;
    for (const row of recentRows) candidateIds.add(row.id);

    let rows: Array<{ id: number; file: string; text: string; embedding: Buffer }>;
    if (candidateIds.size > 0) {
      rows = this.fetchChunksByIds(Array.from(candidateIds), `id, file, text, embedding`);
    } else {
      // Fallback to capped scan
      rows = this.db
        .prepare(
          `SELECT id, file, text, embedding FROM chunks ORDER BY last_accessed DESC LIMIT 2000`,
        )
        .all() as typeof rows;
    }

    const scored = rows.map((row) => {
      const storedEmb = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      return {
        file: row.file,
        text: row.text.slice(0, 500),
        similarity: cosineSimilarity(queryEmbedding, storedEmb),
      };
    });

    scored.sort((a, b) => b.similarity - a.similarity);

    // Deduplicate by file (keep highest-scoring chunk per file)
    const seen = new Set<string>();
    const unique: typeof scored = [];
    for (const s of scored) {
      if (!seen.has(s.file)) {
        seen.add(s.file);
        unique.push(s);
      }
      if (unique.length >= topN) break;
    }

    return unique;
  }

  close(): void {
    try {
      this.db.close();
    } finally {
      this.releaseLock();
    }
  }
}
