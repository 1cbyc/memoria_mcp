/**
 * Focused tests for CollectorDaemon orchestration (Step 8: the daemon was
 * the thinnest-covered critical module). Registry and buffer are stubs at
 * their public seams; the daemon's own logic — timers, backpressure,
 * backoff, outcome partitioning — is what is exercised.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { CollectorDaemon } from "../collector/daemon.js";

function ev(id: string, source = "src-a") {
  return {
    id,
    source,
    eventType: "agent_result",
    content: `event ${id}`,
    timestamp: "2026-06-15T12:00:00Z",
    meta: {},
    importanceEstimate: 5,
    privacyTier: "send" as const,
  };
}

function makeAdapter(over: Record<string, unknown> = {}) {
  return {
    info: { id: "src-a", defaultConfig: { pollIntervalSec: 10 } },
    poll: vi.fn(async () => [ev("e1")]),
    ...over,
  };
}

function makeDaemon(
  opts: { adapter?: any; bufferOver?: Record<string, unknown>; config?: any } = {},
) {
  const adapter = opts.adapter ?? makeAdapter();
  const active = new Map<string, any>([["src-a", adapter]]);
  const registry: any = {
    getActiveAdapters: () => active,
    getEffectiveConfig: () => ({ pollIntervalSec: 10 }),
    recordEvents: vi.fn(),
    saveCheckpoints: vi.fn(),
  };
  const buffer: any = {
    unsyncedCount: () => 0,
    maxCapacity: () => 100,
    pushBatch: vi.fn(() => ({ inserted: 1, dropped: 0 })),
    fetchUnsyncedFair: vi.fn(() => []),
    markSynced: vi.fn(),
    recordFailedAttempts: vi.fn(() => ({ deadLettered: 0 })),
    cleanup: vi.fn(() => 0),
    getStats: () => ({ total: 0 }),
    ...opts.bufferOver,
  };
  const daemon = new CollectorDaemon(registry, buffer, opts.config);
  return { daemon, registry, buffer, adapter, active };
}

const daemons: CollectorDaemon[] = [];
afterEach(async () => {
  while (daemons.length) await daemons.pop()!.stop();
});

describe("CollectorDaemon", () => {
  it("starts, reports status, and stops idempotently", async () => {
    const { daemon } = makeDaemon();
    daemons.push(daemon);
    daemon.start();
    daemon.start(); // no-op while running
    const status = daemon.getStatus();
    expect(status.running).toBe(true);
    expect(status.activeSources).toBe(1);
    expect(status.pollTimers[0]).toMatchObject({ sourceId: "src-a", intervalMs: 10_000 });
    await daemon.stop();
    expect(daemon.getStatus().running).toBe(false);
    await daemon.stop(); // no-op when already stopped
  });

  it("polls an active source into the buffer and records the count", async () => {
    const { daemon, buffer, registry } = makeDaemon();
    daemons.push(daemon);
    daemon.start();
    // syncPollTimers fires the first poll immediately (fire-and-forget).
    await vi.waitFor(() => expect(buffer.pushBatch).toHaveBeenCalled());
    expect(registry.recordEvents).toHaveBeenCalledWith("src-a", 1);
    await daemon.stop();
  });

  it("removes the poll timer when a source is deactivated", async () => {
    const { daemon, active } = makeDaemon();
    daemons.push(daemon);
    daemon.start();
    expect(daemon.getStatus().activeSources).toBe(1);
    active.delete("src-a");
    daemon.syncPollTimers();
    expect(daemon.getStatus().activeSources).toBe(0);
    await daemon.stop();
  });

  it("backs off after a poll error instead of hot-looping", async () => {
    const adapter = makeAdapter({
      poll: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { daemon } = makeDaemon({ adapter });
    daemons.push(daemon);
    daemon.start();
    await vi.waitFor(() =>
      expect(daemon.getStatus().pollTimers[0].errors).toBeGreaterThanOrEqual(1),
    );
    expect(daemon.getStatus().pollTimers[0].inBackoff).toBe(true);
    // A poll attempted inside the backoff window is suppressed by the gate
    // in pollSource(), not merely left unscheduled.
    const calls = adapter.poll.mock.calls.length;
    await (daemon as any).pollSource("src-a");
    expect(adapter.poll.mock.calls.length).toBe(calls);
    await daemon.stop();
  });

  it("pauses polling while the buffer is backpressured", async () => {
    const adapter = makeAdapter();
    const { daemon } = makeDaemon({
      adapter,
      bufferOver: { unsyncedCount: () => 95, maxCapacity: () => 100 },
    });
    daemons.push(daemon);
    expect(daemon.backpressured()).toBe(true);
    daemon.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(adapter.poll).not.toHaveBeenCalled();
    await daemon.stop();
  });

  it("partitions ingestion outcomes: handled synced, errored retried, rate-limited deferred", async () => {
    const rows = [
      { rowid: 1, event: ev("ok") },
      { rowid: 2, event: ev("bad") },
      { rowid: 3, event: ev("slow") },
    ];
    const { daemon, buffer } = makeDaemon({
      bufferOver: { fetchUnsyncedFair: vi.fn(() => rows) },
    });
    daemons.push(daemon);
    daemon.onIngestion(async () => ({
      processed: 3,
      written: 1,
      deduplicated: 0,
      rateLimited: 1,
      errors: [],
      writtenSources: [],
      outcomes: [
        { source: "src-a", id: "ok", outcome: "written" as const },
        { source: "src-a", id: "bad", outcome: "error" as const, error: "x" },
        { source: "src-a", id: "slow", outcome: "rate_limited" as const },
      ],
    }));
    await daemon.runIngestionOnce();
    expect(buffer.markSynced).toHaveBeenCalledWith([1]);
    expect(buffer.recordFailedAttempts).toHaveBeenCalledWith([2], 3);
  });

  it("syncs the whole batch for a legacy void-returning handler, and no-ops without one", async () => {
    const rows = [{ rowid: 7, event: ev("e7") }];
    const { daemon, buffer } = makeDaemon({
      bufferOver: { fetchUnsyncedFair: vi.fn(() => rows) },
    });
    daemons.push(daemon);
    await daemon.runIngestionOnce(); // no handler registered
    expect(buffer.markSynced).not.toHaveBeenCalled();
    daemon.onIngestion(async () => undefined);
    await daemon.runIngestionOnce();
    expect(buffer.markSynced).toHaveBeenCalledWith([7]);
  });

  it("keeps events unsynced when the ingestion handler throws", async () => {
    const rows = [{ rowid: 9, event: ev("e9") }];
    const { daemon, buffer } = makeDaemon({
      bufferOver: { fetchUnsyncedFair: vi.fn(() => rows) },
    });
    daemons.push(daemon);
    daemon.onIngestion(async () => {
      throw new Error("core down");
    });
    await daemon.runIngestionOnce();
    expect(buffer.markSynced).not.toHaveBeenCalled();
  });
});
