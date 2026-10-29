import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { EventBuffer } from "../collector/buffer.js";
import { initMasterKey } from "../collector/crypto.js";
import type { RawEvent } from "../collector/adapters/base.js";

function ev(i: number): RawEvent {
  return {
    id: `e${i}`,
    source: "test",
    eventType: "x",
    content: `event body number ${i}`,
    timestamp: new Date().toISOString(),
    meta: {},
    importanceEstimate: 5,
    privacyTier: "send",
  };
}

let dir: string;
let buf: EventBuffer;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-buf-"));
  initMasterKey(dir); // module-cached; provides a key for encrypt/decrypt
  buf = new EventBuffer(dir, { maxEvents: 100 }); // min allowed
  await buf.init();
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("EventBuffer capacity / unsynced-loss accounting", () => {
  it("tracks dropped UNSYNCED events when the buffer fills with un-ingested data", () => {
    const { inserted, dropped } = buf.pushBatch(Array.from({ length: 150 }, (_, i) => ev(i)));
    expect(inserted).toBe(150);
    expect(dropped).toBeGreaterThanOrEqual(50);

    const stats = buf.getStats();
    expect(stats.totalEvents).toBeLessThanOrEqual(100);
    // None were synced, so every eviction is real data loss and must be counted.
    expect(stats.droppedUnsynced).toBeGreaterThan(0);
  });

  it("does not count dropped-unsynced when under capacity", () => {
    buf.pushBatch(Array.from({ length: 10 }, (_, i) => ev(i)));
    expect(buf.getStats().droppedUnsynced).toBe(0);
  });
});

describe("EventBuffer undecryptable rows and retention (review 2026-10)", () => {
  const db = () => (buf as any).db;

  it("holds undecryptable rows out of the queue instead of letting them block it", () => {
    buf.pushBatch(Array.from({ length: 5 }, (_, i) => ev(i)));
    // 120 high-importance rows written under another key: before, every
    // importance-ordered batch of 100 was all of them, i.e. empty.
    const ins = db().prepare(
      "INSERT INTO events (source, event_id, encrypted_data, importance) VALUES ('test', ?, ?, 10)",
    );
    for (let i = 0; i < 120; i++) ins.run(`bad-${i}`, Buffer.from("not ciphertext under this key"));
    expect(buf.fetchUnsynced(100)).toHaveLength(0); // this batch was all undecryptable...
    const next = buf.fetchUnsynced(100); // ...but they are now held, so the queue moves
    expect(next.map((r) => r.event.id).sort()).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    // The second fetch also held the remaining 20 bad rows: only the 5 real
    // events still count toward backpressure.
    expect(buf.unsyncedCount()).toBe(5);
  });

  it("keeps held rows (they are not deleted) and releases them when they decrypt again", async () => {
    buf.pushBatch([ev(1)]);
    db().prepare("UPDATE events SET synced = 2").run(); // held, e.g. after a key change
    expect(buf.fetchUnsynced(10)).toHaveLength(0);
    buf.cleanup();
    expect(buf.totalCount()).toBe(1);
    // A restart with the right key releases them.
    const again = new EventBuffer(dir, { maxEvents: 100 });
    await again.init();
    expect(again.fetchUnsynced(10).map((r) => r.event.id)).toEqual(["e1"]);
  });

  it("retention compares synced_at in SQLite's own date format", () => {
    buf.pushBatch([ev(1), ev(2)]);
    const retention = (buf as any).retentionMs as number;
    const sqlite = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
    // Synced just inside the window, on the cutoff's calendar date: kept.
    db()
      .prepare("UPDATE events SET synced = 1, synced_at = ? WHERE event_id = 'e1'")
      .run(sqlite(Date.now() - retention + 60_000));
    // Synced just outside the window: deleted.
    db()
      .prepare("UPDATE events SET synced = 1, synced_at = ? WHERE event_id = 'e2'")
      .run(sqlite(Date.now() - retention - 60_000));
    expect(buf.cleanup()).toBe(1);
    expect(
      db()
        .prepare("SELECT event_id FROM events")
        .all()
        .map((r: { event_id: string }) => r.event_id),
    ).toEqual(["e1"]);
  });
});
