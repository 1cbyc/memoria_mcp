/**
 * Collector Daemon — orchestrates poll loops for all active source adapters.
 *
 * Responsibilities:
 *   - Run each adapter's poll() on its configured interval
 *   - Push collected events into the encrypted ring buffer
 *   - Trigger ingestion pipeline when buffer has enough events
 *   - Handle errors gracefully (backoff, logging, per-source isolation)
 *   - Graceful shutdown with checkpoint saving
 */

import { SourceRegistry } from "./registry.js";
import { EventBuffer } from "./buffer.js";
import type { RawEvent } from "./adapters/base.js";
import type { IngestionResult } from "./ingestion.js";

// ── Types ──────────────────────────────────────────────────

export interface DaemonConfig {
  /** Minimum ms between ingestion batches (default: 30_000) */
  ingestionIntervalMs?: number;
  /** Max events per ingestion batch (default: 100) */
  ingestionBatchSize?: number;
  /** Enable cross-source fusion (default: true) */
  enableFusion?: boolean;
  /** Failed ingest attempts before an event is dead-lettered (default 3;
   *  env MEMORIA_INGEST_MAX_ATTEMPTS). */
  maxIngestAttempts?: number;
  /** Fraction of buffer capacity at which polling pauses so ingestion can
   *  catch up instead of evicting unsynced events (default 0.8;
   *  env MEMORIA_BACKPRESSURE_THRESHOLD). */
  backpressureThreshold?: number;
}

interface PollTimer {
  sourceId: string;
  intervalMs: number;
  timer: ReturnType<typeof setInterval> | null;
  lastPoll: number;
  consecutiveErrors: number;
  backoffUntil: number;
  /** True while a poll() is running — prevents overlapping invocations when a
   *  slow adapter exceeds its interval (double-insert / checkpoint races). */
  inFlight: boolean;
}

// ── Constants ──────────────────────────────────────────────

const MAX_BACKOFF_MS = 300_000; // 5 minutes max backoff
const BASE_BACKOFF_MS = 5_000; // 5 seconds initial backoff
const CLEANUP_INTERVAL_MS = 3_600_000; // hourly buffer cleanup

// ── Daemon ─────────────────────────────────────────────────

export class CollectorDaemon {
  private registry: SourceRegistry;
  private buffer: EventBuffer;
  private config: Required<DaemonConfig>;
  private pollTimers = new Map<string, PollTimer>();
  private ingestionTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** The currently running ingestion cycle, if any — a cycle slower than
   *  the interval must not overlap the next one, or both fetch and process
   *  the identical unsynced batch (H-04). Tracked as a promise so stop()
   *  can await quiescence before its final flush instead of returning
   *  while a cycle is still writing. */
  private ingestionPromise: Promise<void> | null = null;
  private lastBackpressureLog = 0;
  private onIngest?: (events: RawEvent[]) => Promise<IngestionResult | void>;

  constructor(registry: SourceRegistry, buffer: EventBuffer, config?: DaemonConfig) {
    this.registry = registry;
    this.buffer = buffer;
    this.config = {
      ingestionIntervalMs: config?.ingestionIntervalMs ?? 30_000,
      ingestionBatchSize: config?.ingestionBatchSize ?? 100,
      enableFusion: config?.enableFusion ?? true,
      maxIngestAttempts:
        config?.maxIngestAttempts ??
        Math.max(1, parseInt(process.env.MEMORIA_INGEST_MAX_ATTEMPTS || "3", 10) || 3),
      backpressureThreshold:
        config?.backpressureThreshold ??
        Math.min(
          0.99,
          Math.max(0.1, parseFloat(process.env.MEMORIA_BACKPRESSURE_THRESHOLD || "0.8") || 0.8),
        ),
    };
  }

  /**
   * Register a callback for when events are ready for core ingestion.
   * The callback receives decrypted events from the buffer. When it returns an
   * IngestionResult, the daemon syncs ONLY durably-handled events; a void
   * return falls back to whole-batch sync (legacy behavior).
   */
  onIngestion(handler: (events: RawEvent[]) => Promise<IngestionResult | void>): void {
    this.onIngest = handler;
  }

  /**
   * True when the buffer's unsynced backlog has crossed the backpressure
   * threshold. Polling pauses while backpressured so ingestion can drain the
   * backlog instead of the buffer evicting unsynced (personal) events at
   * capacity.
   */
  backpressured(): boolean {
    return (
      this.buffer.unsyncedCount() >= this.buffer.maxCapacity() * this.config.backpressureThreshold
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Start the daemon — begins polling all active adapters.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    process.stderr.write("Memoria: collector daemon starting\n");

    // Start poll timers for each active adapter
    this.syncPollTimers();

    // Ingestion loop — pull from buffer and send to core
    this.ingestionTimer = setInterval(() => this.runIngestion(), this.config.ingestionIntervalMs);

    // Periodic buffer cleanup
    this.cleanupTimer = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);

    process.stderr.write(`Memoria: daemon started with ${this.pollTimers.size} active source(s)\n`);
  }

  /**
   * Stop the daemon gracefully.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    process.stderr.write("Memoria: collector daemon stopping\n");

    // Clear all timers
    for (const [, pt] of this.pollTimers) {
      if (pt.timer) clearInterval(pt.timer);
    }
    this.pollTimers.clear();

    if (this.ingestionTimer) {
      clearInterval(this.ingestionTimer);
      this.ingestionTimer = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    // Final ingestion flush. runIngestion() joins an in-flight cycle
    // rather than starting a second one, so when a cycle was running the
    // first await only reaches quiescence and a second, fresh cycle
    // flushes whatever its batch did not cover. With nothing in flight
    // the first await IS the flush — running another would re-fetch
    // errored rows and count a second failed attempt against them
    // during shutdown, dead-lettering some a cycle early.
    const joinedInFlight = this.ingestionPromise !== null;
    await this.runIngestion();
    if (joinedInFlight) {
      await this.runIngestion();
    }

    // Save registry checkpoints
    this.registry.saveCheckpoints();

    process.stderr.write("Memoria: daemon stopped\n");
  }

  /**
   * Refresh poll timers to match current active adapters.
   * Call this after enabling/disabling sources.
   */
  syncPollTimers(): void {
    const activeAdapters = this.registry.getActiveAdapters();

    // Remove timers for adapters that are no longer active
    for (const [sourceId, pt] of this.pollTimers) {
      if (!activeAdapters.has(sourceId)) {
        if (pt.timer) clearInterval(pt.timer);
        this.pollTimers.delete(sourceId);
      }
    }

    // Add timers for new active adapters
    for (const [sourceId, adapter] of activeAdapters) {
      if (this.pollTimers.has(sourceId)) continue;

      // Honor the user-configured interval (persisted per-source), not just the
      // adapter's static default. Sanitize against a bad persisted value so a
      // 0/NaN/negative interval can't spin a runaway poll loop.
      const effective = this.registry.getEffectiveConfig(sourceId);
      const rawSec = effective?.pollIntervalSec ?? adapter.info.defaultConfig.pollIntervalSec ?? 60;
      const MIN_POLL_SEC = 10;
      const pollSec = Number.isFinite(rawSec) && rawSec >= MIN_POLL_SEC ? rawSec : 60;
      const intervalMs = pollSec * 1000;

      const pt: PollTimer = {
        sourceId,
        intervalMs,
        timer: null,
        lastPoll: 0,
        consecutiveErrors: 0,
        backoffUntil: 0,
        inFlight: false,
      };

      // Start the poll loop
      pt.timer = setInterval(() => this.pollSource(sourceId), intervalMs);

      // Register BEFORE the first poll: pollSource() looks its timer up in
      // the map and returns silently when absent, so firing first made the
      // "immediate" poll a no-op and collection waited a full interval.
      this.pollTimers.set(sourceId, pt);

      // Run first poll immediately. Fire-and-forget on purpose: pollSource
      // handles its own failures (error counter + exponential backoff), so it
      // never rejects, and start() must not block on a slow first poll.
      void this.pollSource(sourceId);
    }
  }

  // ── Polling ────────────────────────────────────────────────

  private async pollSource(sourceId: string): Promise<void> {
    if (!this.running) return;

    const pt = this.pollTimers.get(sourceId);
    if (!pt) return;

    // Check backoff
    if (Date.now() < pt.backoffUntil) return;

    // Skip if the previous poll for this source is still running — a slow
    // adapter exceeding its interval must not overlap itself.
    if (pt.inFlight) return;
    pt.inFlight = true;
    try {
      await this.pollSourceInner(sourceId, pt);
    } finally {
      pt.inFlight = false;
    }
  }

  private async pollSourceInner(sourceId: string, pt: PollTimer): Promise<void> {
    // Backpressure: when the unsynced backlog nears buffer capacity, pause
    // polling so ingestion can catch up — collecting more right now would
    // evict UNSYNCED (personal) events at capacity, which is permanent loss.
    // Skipped polls are naturally retried on the next interval tick.
    if (this.backpressured()) {
      const now = Date.now();
      if (now - this.lastBackpressureLog > 5 * 60_000) {
        this.lastBackpressureLog = now;
        process.stderr.write(
          `Memoria: BACKPRESSURE — pausing source polling; unsynced backlog ` +
            `(${this.buffer.unsyncedCount()}) is at ≥${Math.round(this.config.backpressureThreshold * 100)}% ` +
            `of buffer capacity (${this.buffer.maxCapacity()}). Ingestion must drain before collection resumes.\n`,
        );
      }
      return;
    }

    const adapter = this.registry.getActiveAdapters().get(sourceId);
    if (!adapter) return;

    // Adapters advance their cursor while polling. Until the events are in
    // the buffer that advance is a promise, not a fact: if the poll or the
    // buffer write fails, put the cursor back so the same range is read
    // again instead of being skipped for good.
    const cursorBefore = adapter.getCheckpoint();
    try {
      const events = await adapter.poll();

      if (events.length > 0) {
        // Push to encrypted buffer
        const { inserted, dropped } = this.buffer.pushBatch(events);

        // Record in registry
        this.registry.recordEvents(sourceId, inserted);

        if (inserted > 0) {
          const dropMsg = dropped > 0 ? ` (capacity hit: ${dropped} oldest dropped)` : "";
          process.stderr.write(`Memoria: ${sourceId} collected ${inserted} event(s)${dropMsg}\n`);
        }
      }

      // The events are durable; persist the cursor now. It used to be saved
      // only on a clean shutdown, so a crash or forced exit rewound it to
      // when the source was enabled and replayed weeks of history.
      this.registry.saveCheckpoint(sourceId);

      // Reset error state on success
      pt.consecutiveErrors = 0;
      pt.backoffUntil = 0;
      pt.lastPoll = Date.now();
    } catch (err: any) {
      adapter.setCheckpoint(cursorBefore);
      pt.consecutiveErrors++;

      // Exponential backoff with jitter
      const backoff = Math.min(
        BASE_BACKOFF_MS * Math.pow(2, pt.consecutiveErrors - 1),
        MAX_BACKOFF_MS,
      );
      const jitter = Math.random() * backoff * 0.2;
      pt.backoffUntil = Date.now() + backoff + jitter;

      process.stderr.write(
        `Memoria: ${sourceId} poll error (attempt ${pt.consecutiveErrors}, ` +
          `backoff ${Math.round(backoff / 1000)}s): ${err.message}\n`,
      );
    }
  }

  // ── Ingestion ──────────────────────────────────────────────

  /** Run one ingestion cycle now, or join the cycle already in flight
   *  (no fresh cycle is started in that case). Public so tests and
   *  operators can drive a cycle deterministically; the interval timer
   *  calls this too. */
  async runIngestionOnce(): Promise<void> {
    return this.runIngestion();
  }

  private runIngestion(): Promise<void> {
    if (!this.onIngest) return Promise.resolve();
    // Join a cycle that is already running instead of starting a second
    // one: the buffer rows are not claimed at fetch time, so an
    // overlapping cycle would re-fetch and re-process the same batch
    // (H-04). Callers that need a fresh cycle (stop's final flush) call
    // again after the joined promise settles.
    if (this.ingestionPromise) return this.ingestionPromise;
    this.ingestionPromise = (async () => {
      try {
        await this.doRunIngestion();
      } finally {
        this.ingestionPromise = null;
      }
    })();
    return this.ingestionPromise;
  }

  private async doRunIngestion(): Promise<void> {
    if (!this.onIngest) return;
    try {
      // Per-source-fair fetch: one backlogged/deferred source cannot occupy the
      // whole batch and starve the others.
      const batch = this.buffer.fetchUnsyncedFair(this.config.ingestionBatchSize);
      if (batch.length === 0) return;

      const events = batch.map((b) => b.event);

      // Map event identity → buffer rowid so per-event outcomes can be applied.
      const rowidByKey = new Map<string, number>();
      for (const b of batch) {
        rowidByKey.set(`${b.event.source}\u0000${b.event.id}`, b.rowid);
      }

      // Send to core memory for processing
      const result = await this.onIngest(events);

      if (!result || !Array.isArray(result.outcomes)) {
        // Legacy handler with no outcome reporting — whole-batch sync.
        this.buffer.markSynced(batch.map((b) => b.rowid));
        process.stderr.write(`Memoria: ingested ${batch.length} event(s) to core\n`);
        return;
      }

      // Partition by outcome: only durably-handled events are marked synced.
      // - written/duplicate/below_threshold → synced (done, deliberately)
      // - rate_limited → left unsynced, retried next cycle (budget refills)
      // - error → attempt counted; dead-lettered after the retry cap
      const handled: number[] = [];
      const errored: number[] = [];
      let deferred = 0;
      for (const o of result.outcomes) {
        const rowid = rowidByKey.get(`${o.source}\u0000${o.id}`);
        if (rowid === undefined) continue;
        if (o.outcome === "rate_limited") {
          deferred++;
        } else if (o.outcome === "error") {
          errored.push(rowid);
        } else {
          handled.push(rowid);
        }
      }

      this.buffer.markSynced(handled);
      let deadLettered = 0;
      if (errored.length > 0) {
        deadLettered = this.buffer.recordFailedAttempts(
          errored,
          this.config.maxIngestAttempts,
        ).deadLettered;
      }

      process.stderr.write(
        `Memoria: ingestion cycle — ${handled.length} handled` +
          (deferred > 0 ? `, ${deferred} deferred (rate limit)` : "") +
          (errored.length > 0 ? `, ${errored.length} errored (will retry)` : "") +
          (deadLettered > 0 ? `, ${deadLettered} dead-lettered` : "") +
          `\n`,
      );
    } catch (err: any) {
      // A handler can throw a non-Error (even null); formatting the log
      // line must not itself throw and reject the cycle wrapper.
      process.stderr.write(
        `Memoria: ingestion error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      // Events remain unsynced — will retry next cycle
    }
  }

  // ── Cleanup ────────────────────────────────────────────────

  private runCleanup(): void {
    try {
      const deleted = this.buffer.cleanup();
      if (deleted > 0) {
        process.stderr.write(`Memoria: buffer cleanup removed ${deleted} synced event(s)\n`);
      }
    } catch (err: any) {
      process.stderr.write(`Memoria: buffer cleanup error: ${err.message}\n`);
    }
  }

  // ── Status ─────────────────────────────────────────────────

  getStatus(): {
    running: boolean;
    activeSources: number;
    pollTimers: Array<{
      sourceId: string;
      intervalMs: number;
      lastPoll: number;
      errors: number;
      inBackoff: boolean;
    }>;
    bufferStats: ReturnType<EventBuffer["getStats"]>;
  } {
    const timers = Array.from(this.pollTimers.values()).map((pt) => ({
      sourceId: pt.sourceId,
      intervalMs: pt.intervalMs,
      lastPoll: pt.lastPoll,
      errors: pt.consecutiveErrors,
      inBackoff: Date.now() < pt.backoffUntil,
    }));

    return {
      running: this.running,
      activeSources: this.pollTimers.size,
      pollTimers: timers,
      bufferStats: this.buffer.getStats(),
    };
  }
}
