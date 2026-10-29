/**
 * Durable raw / provenance archive (Karpathy rule I: "sources are immutable").
 *
 * Daily logs are a *processed* record (summarized, redacted, and liable to be
 * compacted), and the encrypted ring buffer is *ephemeral* (it overwrites at
 * capacity). So once an event is ingested, the original is effectively gone and
 * a wrong compiled page cannot be traced back to its source.
 *
 * This module keeps an append-only, immutable provenance record for every
 * ingested event under `data/raw/<source>/<YYYY-MM>.jsonl`. It lives under
 * data/ (not memories/), so it is never embedded, indexed, or git-synced — it is
 * strictly lower-exposure than the daily log.
 *
 * Privacy-aware, mirroring sink-side enforcement so the archive never holds more
 * than policy allows:
 *   - local-only → metadata + content hash only (NEVER the content)
 *   - summarize  → the already-truncated content
 *   - send       → full content
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { decrypt, encrypt, getMasterKey, initMasterKey, keyedContentHash } from "./crypto.js";
import type { RawEvent } from "./adapters/base.js";

export interface ProvenanceRecord {
  id: string;
  source: string;
  eventType: string;
  timestamp: string;
  /** Hash of the ORIGINAL content (stable fingerprint of the true source). */
  contentHash: string;
  privacyTier: RawEvent["privacyTier"];
  /** Present only when policy allows (omitted entirely for local-only).
   * On disk this is never stored in plaintext: see `contentEnc`. */
  content?: string;
  /** AES-256-GCM ciphertext (base64) of `content` as stored on disk. */
  contentEnc?: string;
}

function ensureKey(dataDir: string): void {
  try {
    getMasterKey();
  } catch {
    initMasterKey(dataDir);
  }
}

/** Disabled only when explicitly set to "false". On by default — durability is
 * the whole point of the layer. */
export function rawArchiveEnabled(): boolean {
  return process.env.MEMORIA_RAW_ARCHIVE !== "false";
}

export function rawArchiveDir(dataDir: string): string {
  return path.join(dataDir, "raw");
}

/** Path-safe filesystem segment from an arbitrary source name. */
function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64) || "unknown";
}

// ── Batching + rotation (Phase 5, F4) ────────────────────────
//
// On GCS FUSE an append is a full-object rewrite, so a per-event
// appendFileSync to an ever-growing JSONL costs O(file size) per event and
// grows without bound. Two fixes:
//  1. BATCH: records accumulate in memory and flush together once
//     FLUSH_MAX_RECORDS pile up or FLUSH_MAX_AGE_MS elapses (checked on each
//     append — no timer; call flushRawArchive() on shutdown). Amortizes the
//     rewrite cost by the batch size; at most one batch is lost on a crash,
//     acceptable for a secondary provenance trail.
//  2. ROTATE: when the current file exceeds ROTATE_MAX_BYTES the batch rolls
//     to <month>-p2.jsonl, -p3.jsonl, … so the rewritten object is bounded.

const FLUSH_MAX_RECORDS = parseInt(process.env.MEMORIA_RAW_ARCHIVE_BATCH || "20", 10);
const FLUSH_MAX_AGE_MS = parseInt(process.env.MEMORIA_RAW_ARCHIVE_FLUSH_MS || "60000", 10);
const ROTATE_MAX_BYTES = parseInt(
  process.env.MEMORIA_RAW_ARCHIVE_ROTATE_BYTES || String(5 * 1024 * 1024),
  10,
);

interface PendingBatch {
  lines: string[];
  firstAt: number; // epoch ms of oldest buffered record
}
// key: `${dataDir}|${sourceSegment}|${month}`
const pending = new Map<string, PendingBatch>();

/** Pick the current (unrotated-or-latest) file for a source/month, rolling to
 * a new part when the latest exceeds the rotation cap. */
function targetFile(dir: string, month: string): string {
  let part = 1;
  let file = path.join(dir, `${month}.jsonl`);
  // Find the highest existing part, then roll if it's over the cap.
  for (;;) {
    const next =
      part === 1 ? path.join(dir, `${month}.jsonl`) : path.join(dir, `${month}-p${part}.jsonl`);
    if (!fs.existsSync(next)) break;
    file = next;
    part++;
  }
  try {
    if (fs.existsSync(file) && fs.statSync(file).size >= ROTATE_MAX_BYTES) {
      file = path.join(dir, `${month}-p${part}.jsonl`);
    }
  } catch {
    // stat failed — keep current target
  }
  return file;
}

function flushKey(key: string): void {
  const batch = pending.get(key);
  if (!batch || batch.lines.length === 0) return;
  pending.delete(key);
  const [dataDir, seg, month] = key.split("|");
  try {
    const dir = path.join(rawArchiveDir(dataDir), seg);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(targetFile(dir, month), batch.lines.join("\n") + "\n", "utf-8");
  } catch (err) {
    process.stderr.write(
      `Memoria: raw archive flush failed (non-fatal, ${batch.lines.length} records dropped): ${(err as Error).message}\n`,
    );
  }
}

/** Flush all pending provenance batches. Call on shutdown; safe to call anytime. */
export function flushRawArchive(): void {
  for (const key of [...pending.keys()]) flushKey(key);
}

/**
 * Append an immutable provenance record (batched; see above). `safeEvent` is
 * the privacy-enforced copy (its tier + redacted/truncated content govern what
 * is stored); `originalContent` is the pre-redaction content, used only to
 * compute the stable hash. Best-effort: never throws into the ingestion path.
 */
export function appendRawArchive(
  dataDir: string,
  safeEvent: RawEvent,
  originalContent: string,
): void {
  try {
    const tier = safeEvent.privacyTier;
    const rec: ProvenanceRecord = {
      id: safeEvent.id,
      source: safeEvent.source,
      eventType: safeEvent.eventType,
      timestamp: safeEvent.timestamp,
      // Keyed: a bare SHA-256 of local-only content (stored here in place of
      // the content) could be reversed by guessing short secrets.
      contentHash: keyedContentHash(originalContent, dataDir),
      privacyTier: tier,
    };
    // local-only: store the fingerprint only, never the content. Other
    // tiers: store content ENCRYPTED under the collector master key, so a
    // copied volume does not yield plaintext beside the encrypted buffer.
    if (tier !== "local-only") {
      ensureKey(dataDir);
      rec.contentEnc = encrypt(safeEvent.content).toString("base64");
    }

    const month = /^\d{4}-\d{2}/.test(safeEvent.timestamp || "")
      ? safeEvent.timestamp.slice(0, 7)
      : new Date().toISOString().slice(0, 7);
    const key = `${dataDir}|${sanitizeSegment(safeEvent.source)}|${month}`;

    const now = Date.now();
    let batch = pending.get(key);
    if (!batch) {
      batch = { lines: [], firstAt: now };
      pending.set(key, batch);
    }
    batch.lines.push(JSON.stringify(rec));

    if (batch.lines.length >= FLUSH_MAX_RECORDS || now - batch.firstAt >= FLUSH_MAX_AGE_MS) {
      flushKey(key);
    }
  } catch (err) {
    process.stderr.write(
      `Memoria: raw archive append failed (non-fatal): ${(err as Error).message}\n`,
    );
  }
}

/**
 * Read provenance records for a source (most recent month files first), newest
 * record first. Used to trace a daily-log entry / compiled fact back to source.
 */
export function readRawArchive(dataDir: string, source: string, limit = 100): ProvenanceRecord[] {
  // Read-your-writes: fold any buffered batches in before reading.
  flushRawArchive();
  const dir = path.join(rawArchiveDir(dataDir), sanitizeSegment(source));
  const out: ProvenanceRecord[] = [];
  let files: string[];
  try {
    // Rotated parts (-p2, -p3, …) sort after the base month file, so
    // sort().reverse() still yields newest-month, newest-part first.
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();
  } catch {
    return out;
  }
  for (const f of files) {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(dir, f), "utf-8").split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]) as ProvenanceRecord;
        if (rec.contentEnc) {
          // Never GENERATE a key on the read path: a fresh key cannot
          // decrypt existing records, and minting one would mask the real
          // problem (missing key) while dropping every record silently.
          let keyReady = true;
          try {
            getMasterKey();
          } catch {
            keyReady =
              !!process.env.MEMORIA_ENCRYPTION_KEY ||
              fs.existsSync(path.join(dataDir, "collector.key"));
            if (keyReady) initMasterKey(dataDir);
          }
          if (!keyReady) continue;
          rec.content = decrypt(Buffer.from(rec.contentEnc, "base64")).toString("utf-8");
          delete rec.contentEnc;
        }
        out.push(rec);
      } catch {
        // skip a corrupt/undecryptable line
      }
      if (out.length >= limit) return out;
    }
  }
  return out;
}
