/**
 * Encrypted Ring Buffer — local event staging before core ingestion.
 *
 * Uses SQLite with AES-256-GCM encryption on event content.
 * Auto-cleans synced events to bound storage usage.
 *
 * Design:
 *   - Events land here from adapters (sub-memory side)
 *   - Core ingestion reads batches, marks them synced
 *   - Ring cleanup removes synced events older than retention period
 *   - Max buffer size is capped; oldest unsynced events are dropped if full
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { encrypt, decrypt } from "./crypto.js";
import type { RawEvent } from "./adapters/base.js";

// ── Types ──────────────────────────────────────────────────

export interface BufferedEvent {
  rowid: number;
  event: RawEvent;
  bufferedAt: string;
  synced: boolean;
  syncedAt: string | null;
}

export interface BufferStats {
  totalEvents: number;
  unsyncedEvents: number;
  syncedEvents: number;
  oldestUnsynced: string | null;
  newestEvent: string | null;
  bufferSizeBytes: number;
  /** Cumulative count of UNSYNCED events dropped at capacity (data loss). >0
   *  means ingestion fell behind and personal events were lost before reaching
   *  core memory — an operator should investigate a stalled sync. */
  droppedUnsynced: number;
  /** Cumulative count of events dead-lettered after exhausting ingest retries
   *  (poison events). Their metadata is preserved in data/.dead-letter.jsonl. */
  deadLettered: number;
}

// ── Configuration ──────────────────────────────────────────

const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_RETENTION_HOURS = 48; // keep synced events for 48h
const DEFAULT_BATCH_SIZE = 50;

// ── Ring Buffer ────────────────────────────────────────────

/** `synced` value for rows that cannot be decrypted with the current key. */
const HELD = 2;

export class EventBuffer {
  private db: any = null;
  private dbPath: string;
  private deadLetterPath: string;
  private maxEvents: number;
  private retentionMs: number;
  private droppedUnsynced = 0;
  private deadLettered = 0;

  constructor(
    dataDir: string,
    options?: {
      maxEvents?: number;
      retentionHours?: number;
    },
  ) {
    this.dbPath = path.join(dataDir, "event-buffer.sqlite");
    this.deadLetterPath = path.join(dataDir, ".dead-letter.jsonl");
    const requestedMax = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (requestedMax < 100) {
      process.stderr.write(
        `Memoria buffer: maxEvents=${requestedMax} is too low; using minimum 100. ` +
          `A small buffer will drop events constantly.\n`,
      );
    }
    this.maxEvents = Math.max(100, requestedMax);
    this.retentionMs = (options?.retentionHours ?? DEFAULT_RETENTION_HOURS) * 3600_000;
  }

  async init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    const Database = (await import("better-sqlite3")).default;
    this.db = new Database(this.dbPath);

    // Restrict file permissions (owner read/write only; skip on GCS FUSE)
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch (err) {
      process.stderr.write(
        `Memoria buffer: chmod 0600 on ${this.dbPath} failed (${(err as Error).message}). ` +
          `Rely on bucket ACLs for cloud storage.\n`,
      );
    }

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        encrypted_data BLOB NOT NULL,
        importance INTEGER NOT NULL DEFAULT 5,
        privacy_tier TEXT NOT NULL DEFAULT 'send',
        buffered_at TEXT NOT NULL DEFAULT (datetime('now')),
        synced INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT,
        UNIQUE(source, event_id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_unsynced
        ON events (synced, importance DESC, buffered_at ASC);

      CREATE INDEX IF NOT EXISTS idx_events_source
        ON events (source, buffered_at DESC);

      CREATE INDEX IF NOT EXISTS idx_events_synced_at
        ON events (synced_at) WHERE synced = 1;
    `);

    // Migration: `attempts` tracks failed ingest tries per event so poison
    // events (always-erroring) can be dead-lettered instead of retried forever.
    // Older buffers predate the column — add it in place.
    const cols = this.db.pragma("table_info(events)") as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "attempts")) {
      this.db.exec(`ALTER TABLE events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
    }

    // Rows held as undecryptable (see decryptRows) come back once the key
    // that wrote them is in use again.
    const held = this.db
      .prepare(`SELECT encrypted_data FROM events WHERE synced = ${HELD} LIMIT 1`)
      .get() as { encrypted_data: Buffer } | undefined;
    if (held) {
      try {
        this.decryptEvent(held.encrypted_data);
        const n = this.db
          .prepare(`UPDATE events SET synced = 0 WHERE synced = ${HELD}`)
          .run().changes;
        process.stderr.write(`Memoria buffer: ${n} held event(s) decrypt again; released.\n`);
      } catch {
        // still the wrong key; they stay held
      }
    }
  }

  // ── Write ──────────────────────────────────────────────────

  /**
   * Buffer a raw event. Content is encrypted before storage.
   * Silently ignores duplicates (same source + event_id).
   */
  push(event: RawEvent): void {
    if (!this.db) throw new Error("Buffer not initialized");

    const payload = JSON.stringify(event);
    const encrypted = encrypt(payload);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO events
          (source, event_id, encrypted_data, importance, privacy_tier)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .run(event.source, event.id, encrypted, event.importanceEstimate, event.privacyTier);

    // Enforce max buffer size
    this.enforceCapacity();
  }

  /**
   * Buffer multiple events in a single transaction.
   * Returns { inserted, dropped } so callers can warn when capacity is hit.
   */
  pushBatch(events: RawEvent[]): { inserted: number; dropped: number } {
    if (!this.db) throw new Error("Buffer not initialized");

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO events
        (source, event_id, encrypted_data, importance, privacy_tier)
      VALUES (?, ?, ?, ?, ?)`,
    );

    let inserted = 0;

    const tx = this.db.transaction(() => {
      for (const event of events) {
        const payload = JSON.stringify(event);
        const encrypted = encrypt(payload);

        const result = insert.run(
          event.source,
          event.id,
          encrypted,
          event.importanceEstimate,
          event.privacyTier,
        );

        if (result.changes > 0) inserted++;
      }
    });

    tx();
    const dropped = this.enforceCapacity();
    return { inserted, dropped };
  }

  // ── Read (for ingestion) ───────────────────────────────────

  /**
   * Fetch a batch of unsynced events, highest importance first.
   * Does NOT mark them as synced — call `markSynced()` after processing.
   */
  fetchUnsynced(batchSize: number = DEFAULT_BATCH_SIZE): BufferedEvent[] {
    if (!this.db) return [];

    const rows = this.db
      .prepare(
        `SELECT rowid, source, event_id, encrypted_data, importance,
                privacy_tier, buffered_at, synced, synced_at
        FROM events
        WHERE synced = 0
        ORDER BY importance DESC, buffered_at ASC
        LIMIT ?`,
      )
      .all(batchSize) as any[];

    return this.decryptRows(rows);
  }

  /**
   * Fetch a batch of unsynced events with PER-SOURCE FAIRNESS: the batch is
   * split evenly across every source that has unsynced rows, so one backlogged
   * (or repeatedly-deferred) source cannot occupy the whole batch and starve
   * the others (head-of-line blocking). Within a source, highest importance
   * first, then oldest. Remaining slots after the even split are filled by the
   * global ordering.
   */
  fetchUnsyncedFair(batchSize: number = DEFAULT_BATCH_SIZE): BufferedEvent[] {
    if (!this.db) return [];

    const sources = this.db
      .prepare(`SELECT DISTINCT source FROM events WHERE synced = 0 ORDER BY source`)
      .all() as Array<{ source: string }>;
    if (sources.length === 0) return [];
    if (sources.length === 1) return this.fetchUnsynced(batchSize);

    const perSource = Math.max(1, Math.floor(batchSize / sources.length));
    const rows: any[] = [];
    const seen = new Set<number>();

    const perSourceStmt = this.db.prepare(
      `SELECT rowid, source, event_id, encrypted_data, importance,
              privacy_tier, buffered_at, synced, synced_at
       FROM events
       WHERE synced = 0 AND source = ?
       ORDER BY importance DESC, buffered_at ASC
       LIMIT ?`,
    );
    for (const { source } of sources) {
      for (const row of perSourceStmt.all(source, perSource) as any[]) {
        if (rows.length >= batchSize) break;
        rows.push(row);
        seen.add(row.rowid);
      }
    }

    // Fill remaining capacity by global priority order.
    if (rows.length < batchSize) {
      const filler = this.db
        .prepare(
          `SELECT rowid, source, event_id, encrypted_data, importance,
                  privacy_tier, buffered_at, synced, synced_at
           FROM events WHERE synced = 0
           ORDER BY importance DESC, buffered_at ASC
           LIMIT ?`,
        )
        .all(batchSize) as any[];
      for (const row of filler) {
        if (rows.length >= batchSize) break;
        if (!seen.has(row.rowid)) {
          rows.push(row);
          seen.add(row.rowid);
        }
      }
    }

    return this.decryptRows(rows);
  }

  /**
   * Fetch unsynced events for a specific source.
   */
  fetchUnsyncedBySource(source: string, batchSize: number = DEFAULT_BATCH_SIZE): BufferedEvent[] {
    if (!this.db) return [];

    const rows = this.db
      .prepare(
        `SELECT rowid, source, event_id, encrypted_data, importance,
                privacy_tier, buffered_at, synced, synced_at
        FROM events
        WHERE synced = 0 AND source = ?
        ORDER BY importance DESC, buffered_at ASC
        LIMIT ?`,
      )
      .all(source, batchSize) as any[];

    return this.decryptRows(rows);
  }

  /**
   * Decrypt a set of event rows, skipping (and logging) any that fail to
   * decrypt so one corrupt/tampered row can't abort an entire fetch batch.
   */
  private decryptRows(rows: any[]): BufferedEvent[] {
    const out: BufferedEvent[] = [];
    const undecryptable: number[] = [];
    for (const row of rows) {
      try {
        out.push({
          rowid: row.rowid,
          event: this.decryptEvent(row.encrypted_data),
          bufferedAt: row.buffered_at,
          synced: !!row.synced,
          syncedAt: row.synced_at,
        });
      } catch (err) {
        undecryptable.push(row.rowid);
        if (undecryptable.length === 1) {
          process.stderr.write(
            `Memoria buffer: undecryptable event row ${row.rowid}: ${(err as Error).message}\n`,
          );
        }
      }
    }
    // Skipping them was not enough: unsynced and never failing an ingest,
    // they stayed at the head of every importance-ordered batch (100 of
    // them made every batch empty) and counted toward backpressure, which
    // could pause polling for good. The usual cause is a changed master key
    // (e.g. moving to MEMORIA_ENCRYPTION_KEY). They are held out of the
    // queue, not deleted, and released at startup if they decrypt again.
    if (undecryptable.length > 0 && this.db) {
      const hold = this.db.prepare(`UPDATE events SET synced = ${HELD} WHERE rowid = ?`);
      this.db.transaction(() => {
        for (const rowid of undecryptable) hold.run(rowid);
      })();
      process.stderr.write(
        `Memoria buffer: held ${undecryptable.length} undecryptable event(s) out of the ingest ` +
          `queue. Was the collector master key changed? They are kept and released if the ` +
          `original key is restored.\n`,
      );
    }
    return out;
  }

  // ── Sync management ────────────────────────────────────────

  /**
   * Mark events as synced to core memory.
   */
  markSynced(rowids: number[]): void {
    if (!this.db || rowids.length === 0) return;

    const update = this.db.prepare(
      `UPDATE events SET synced = 1, synced_at = datetime('now') WHERE rowid = ?`,
    );

    const tx = this.db.transaction(() => {
      for (const rowid of rowids) {
        update.run(rowid);
      }
    });

    tx();
  }

  /**
   * Record a failed ingest attempt for each row. Rows that reach `maxAttempts`
   * are DEAD-LETTERED: marked synced so they exit the retry loop (and age out
   * via normal retention), counted, and their METADATA (never content — the
   * content may be what poisons the pipeline) appended to
   * data/.dead-letter.jsonl for operator inspection.
   * Returns how many rows will be retried vs dead-lettered.
   */
  recordFailedAttempts(
    rowids: number[],
    maxAttempts: number = 3,
  ): { retried: number; deadLettered: number } {
    if (!this.db || rowids.length === 0) return { retried: 0, deadLettered: 0 };

    const bump = this.db.prepare(`UPDATE events SET attempts = attempts + 1 WHERE rowid = ?`);
    const read = this.db.prepare(
      `SELECT rowid, source, event_id, importance, attempts, buffered_at
       FROM events WHERE rowid = ?`,
    );
    const kill = this.db.prepare(
      `UPDATE events SET synced = 1, synced_at = datetime('now') WHERE rowid = ?`,
    );

    const dead: Array<Record<string, unknown>> = [];
    const tx = this.db.transaction(() => {
      for (const rowid of rowids) {
        bump.run(rowid);
        const row = read.get(rowid) as
          | {
              rowid: number;
              source: string;
              event_id: string;
              importance: number;
              attempts: number;
              buffered_at: string;
            }
          | undefined;
        if (row && row.attempts >= maxAttempts) {
          kill.run(rowid);
          dead.push({
            deadLetteredAt: new Date().toISOString(),
            source: row.source,
            eventId: row.event_id,
            importance: row.importance,
            attempts: row.attempts,
            bufferedAt: row.buffered_at,
          });
        }
      }
    });
    tx();

    if (dead.length > 0) {
      this.deadLettered += dead.length;
      try {
        fs.appendFileSync(
          this.deadLetterPath,
          dead.map((d) => JSON.stringify(d)).join("\n") + "\n",
          "utf-8",
        );
      } catch (err) {
        process.stderr.write(
          `Memoria buffer: dead-letter sidecar write failed (non-fatal): ${(err as Error).message}\n`,
        );
      }
      process.stderr.write(
        `Memoria buffer: DEAD-LETTERED ${dead.length} event(s) after ${maxAttempts} failed ingest attempts ` +
          `(cumulative: ${this.deadLettered}). Metadata in ${path.basename(this.deadLetterPath)}; ` +
          `the events themselves were not written to memory.\n`,
      );
    }

    return { retried: rowids.length - dead.length, deadLettered: dead.length };
  }

  /** Count of unsynced events — cheap accessor for backpressure decisions. */
  unsyncedCount(): number {
    if (!this.db) return 0;
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM events WHERE synced = 0").get() as {
      cnt: number;
    };
    return row.cnt;
  }

  // ── Cleanup ────────────────────────────────────────────────

  /**
   * Remove synced events older than retention period.
   * Returns number of rows deleted.
   */
  cleanup(): number {
    if (!this.db) return 0;

    // In SQLite's own datetime() format: synced_at is written by
    // datetime('now') ("YYYY-MM-DD HH:MM:SS"), and comparing it with an ISO
    // string ("...T...Z") as text put every row synced on the cutoff date
    // before the cutoff (" " sorts before "T"), deleting it up to a day early
    // and shortening the buffer's id-dedup window.
    const cutoffSec = Math.floor((Date.now() - this.retentionMs) / 1000);

    const result = this.db
      .prepare(
        `DELETE FROM events
        WHERE synced = 1 AND synced_at < datetime(?, 'unixepoch')`,
      )
      .run(cutoffSec);

    // Also vacuum periodically to reclaim space
    if (result.changes > 100) {
      this.db.pragma("incremental_vacuum(100)");
    }

    return result.changes;
  }

  /**
   * Enforce maximum buffer size by dropping oldest low-importance events.
   * Returns the number of events dropped (0 if under capacity).
   */
  private enforceCapacity(): number {
    const count = this.db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number };

    if (count.cnt <= this.maxEvents) return 0;

    const excess = count.cnt - this.maxEvents;

    // The DELETE orders synced rows first (synced DESC), so synced events are
    // evicted before any unsynced one. Unsynced rows are only dropped once all
    // synced rows are gone and we're STILL over capacity — i.e. the buffer is
    // full of un-ingested events because the sync/ingestion path has stalled.
    // That is real data loss, so account for it separately and loudly.
    // Synced and held rows (synced <> 0) both go before any unsynced one.
    const syncedCount = (
      this.db.prepare("SELECT COUNT(*) as cnt FROM events WHERE synced <> 0").get() as {
        cnt: number;
      }
    ).cnt;
    const unsyncedToDrop = Math.max(0, excess - syncedCount);

    // Drop oldest synced events first, then oldest low-importance unsynced
    const result = this.db
      .prepare(
        `DELETE FROM events WHERE rowid IN (
          SELECT rowid FROM events
          ORDER BY synced DESC, importance ASC, buffered_at ASC
          LIMIT ?
        )`,
      )
      .run(excess);

    if (result.changes > 0) {
      process.stderr.write(
        `Memoria buffer: dropped ${result.changes} oldest event(s) to stay under capacity (${this.maxEvents})\n`,
      );
    }
    if (unsyncedToDrop > 0) {
      this.droppedUnsynced += unsyncedToDrop;
      process.stderr.write(
        `Memoria buffer: WARNING — dropped ${unsyncedToDrop} UNSYNCED event(s) at capacity; ` +
          `ingestion is not keeping up and these personal events were lost before reaching ` +
          `core memory. Cumulative unsynced dropped: ${this.droppedUnsynced}. ` +
          `Check the ingestion pipeline / increase capacity.\n`,
      );
    }
    return result.changes;
  }

  /** Total events currently buffered. Useful for capacity warnings. */
  totalCount(): number {
    if (!this.db) return 0;
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number };
    return row.cnt;
  }

  maxCapacity(): number {
    return this.maxEvents;
  }

  // ── Stats ──────────────────────────────────────────────────

  getStats(): BufferStats {
    if (!this.db) {
      return {
        totalEvents: 0,
        unsyncedEvents: 0,
        syncedEvents: 0,
        oldestUnsynced: null,
        newestEvent: null,
        bufferSizeBytes: 0,
        droppedUnsynced: this.droppedUnsynced,
        deadLettered: this.deadLettered,
      };
    }

    const total = this.db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number };

    const unsynced = this.db
      .prepare("SELECT COUNT(*) as cnt FROM events WHERE synced = 0")
      .get() as { cnt: number };

    const oldest = this.db
      .prepare("SELECT buffered_at FROM events WHERE synced = 0 ORDER BY buffered_at ASC LIMIT 1")
      .get() as { buffered_at: string } | undefined;

    const newest = this.db
      .prepare("SELECT buffered_at FROM events ORDER BY buffered_at DESC LIMIT 1")
      .get() as { buffered_at: string } | undefined;

    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(this.dbPath).size;
    } catch {}

    return {
      totalEvents: total.cnt,
      unsyncedEvents: unsynced.cnt,
      syncedEvents: total.cnt - unsynced.cnt,
      oldestUnsynced: oldest?.buffered_at ?? null,
      newestEvent: newest?.buffered_at ?? null,
      bufferSizeBytes: sizeBytes,
      droppedUnsynced: this.droppedUnsynced,
      deadLettered: this.deadLettered,
    };
  }

  // ── Internal ───────────────────────────────────────────────

  private decryptEvent(encrypted: Buffer): RawEvent {
    const decrypted = decrypt(encrypted);
    return JSON.parse(decrypted.toString("utf-8"));
  }

  async destroy(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
