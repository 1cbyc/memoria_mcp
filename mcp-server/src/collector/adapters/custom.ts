/**
 * Custom adapter — allows users to add their own data sources.
 *
 * Supports three modes:
 *   1. File watcher: monitor a file/directory for changes (JSON, CSV, plain text)
 *   2. HTTP webhook: receive POST requests with event data
 *   3. Shell command: periodically run a command and parse its output
 *
 * This enables integration with any tool that can output structured data:
 *   - Fitness apps (export to JSON)
 *   - Smart home systems (webhook)
 *   - Custom scripts (shell command)
 *   - Chat export tools (file watcher)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { SourceAdapter, AdapterInfo, AdapterConfig, RawEvent } from "./base.js";
import { estimateImportance, classifyPrivacy } from "./base.js";
import { contentHash, keyedContentHash } from "../crypto.js";
import { normalizeTimestamp } from "../../daily-format.js";

/**
 * Checkpoint for a source that collected before checkpoints existed: its
 * first read records what is there without emitting it again.
 */
export const CUSTOM_BASELINE = "baseline";

export interface CustomSourceDefinition {
  /** Unique ID for this custom source */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Collection mode */
  mode: "file_watcher" | "shell_command" | "webhook";
  /** For file_watcher: path to watch */
  watchPath?: string;
  /** For file_watcher: file format */
  fileFormat?: "json" | "csv" | "lines";
  /** For shell_command: the command to run */
  command?: string;
  /** For webhook: the path to listen on (e.g., /webhook/fitbit) */
  webhookPath?: string;
  /** JSON path to extract events from structured data (e.g., "data.events") */
  jsonPath?: string;
  /** Field mappings: map source fields to RawEvent fields */
  fieldMap?: {
    content?: string; // JSON path to content field
    timestamp?: string; // JSON path to timestamp field
    id?: string; // JSON path to ID field
    meta?: string[]; // JSON paths to include in meta
  };
}

/**
 * Split a CSV line handling double-quoted fields (commas inside quotes are preserved).
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'; // escaped quote
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// ── file_watcher path containment ────────────────────────────

/**
 * Resolve a path to its real location, following symlinks. For a path whose
 * leaf doesn't exist yet, resolve the nearest existing ancestor and re-append
 * the remainder so a symlinked ancestor can't be used to escape.
 */
export function resolveWatchRealPath(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const tail: string[] = [];
  while (!fs.existsSync(cur)) {
    tail.unshift(path.basename(cur));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(cur);
  } catch {
    real = cur;
  }
  return tail.length ? path.join(real, ...tail) : real;
}

function isInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const par = path.resolve(parent);
  const prefix = par.endsWith(path.sep) ? par : par + path.sep;
  return c === par || c.startsWith(prefix);
}

/**
 * Guard a file_watcher watchPath against reading sensitive host files.
 *
 *  1. Unconditionally rejects any path resolving inside the collector data
 *     directory — that's where the AES master key (collector.key), the
 *     encrypted credential store (collector-config.enc) and the SQLite DBs
 *     live. Without this, an authenticated caller could register a watcher on
 *     the key/creds and exfiltrate them through the daily log.
 *  2. file_watcher sources are DENIED BY DEFAULT (fail closed). To enable any,
 *     set MEMORIA_FILE_WATCHER_ROOTS to a comma-separated allowlist of
 *     directories; the path must then resolve under one of those roots. When
 *     the variable is unset or empty, every file_watcher source is refused —
 *     the safe posture for a shared or internet-reachable deployment, and it
 *     closes the confused-deputy exfiltration path where an authenticated (or
 *     prompt-injected) caller registers a watcher on ~/.ssh/id_rsa, ~/.env,
 *     etc. and has its contents copied into the searchable, synced store.
 *
 * Throws with an explanatory message when the path is not allowed.
 */
export function assertWatchPathAllowed(watchPath: string, opts: { dataDir?: string } = {}): void {
  if (!watchPath) return;
  const real = resolveWatchRealPath(watchPath);

  if (opts.dataDir && isInside(real, opts.dataDir)) {
    throw new Error(
      `Watch path not allowed: "${watchPath}" resolves inside the collector data ` +
        `directory, which holds the encryption key and credentials.`,
    );
  }

  // Fail closed: file_watcher is disabled unless an explicit, non-empty
  // allowlist is configured. An unset OR empty MEMORIA_FILE_WATCHER_ROOTS
  // denies all watchers (mirrors the shell_command opt-in gate).
  const roots = (process.env.MEMORIA_FILE_WATCHER_ROOTS ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (roots.length === 0) {
    throw new Error(
      `Watch path not allowed: "${watchPath}". file_watcher sources are disabled by ` +
        `default. Set MEMORIA_FILE_WATCHER_ROOTS to a comma-separated allowlist of ` +
        `directories to enable them.`,
    );
  }
  const ok = roots.some((root) => isInside(real, resolveWatchRealPath(root)));
  if (!ok) {
    throw new Error(
      `Watch path not in allowlist (MEMORIA_FILE_WATCHER_ROOTS): "${watchPath}". ` +
        `Allowed roots: ${roots.join(", ")}.`,
    );
  }
}

export class CustomAdapter implements SourceAdapter {
  readonly info: AdapterInfo;

  private definition: CustomSourceDefinition;
  private config!: AdapterConfig;
  private checkpoint: string = "";
  private lastModified: number = 0;
  private dataDir?: string;

  constructor(definition: CustomSourceDefinition, opts: { dataDir?: string } = {}) {
    this.definition = definition;
    this.dataDir = opts.dataDir;

    this.info = {
      id: `custom-${definition.id}`,
      name: definition.name,
      description: definition.description,
      platforms: ["macos", "linux", "windows"],
      dependencies: [],
      requiredPermissions: [],
      builtIn: false,
      defaultConfig: {
        enabled: false,
        pollIntervalSec: 60,
        importanceThreshold: 3,
        settings: { ...definition },
      },
    };
  }

  async init(config: AdapterConfig): Promise<void> {
    this.config = config;

    if (this.definition.mode === "file_watcher" && this.definition.watchPath) {
      // Defense in depth (mirrors the shell_command runtime gate): re-validate
      // containment at activation, even for definitions persisted before this
      // guard existed.
      assertWatchPathAllowed(this.definition.watchPath, { dataDir: this.dataDir });
      if (!fs.existsSync(this.definition.watchPath)) {
        throw new Error(`Watch path does not exist: ${this.definition.watchPath}`);
      }
    }
  }

  async poll(): Promise<RawEvent[]> {
    switch (this.definition.mode) {
      case "file_watcher":
        return this.onlyNew(this.pollFile());
      case "shell_command":
        return this.onlyNew(this.pollCommand());
      case "webhook":
        // Webhooks are push-based; poll returns pending events
        return this.drainWebhookQueue();
      default:
        return [];
    }
  }

  // ── File watcher mode ──────────────────────────────────────

  /** null when no read happened (unchanged, missing or oversized file). */
  private pollFile(): RawEvent[] | null {
    const watchPath = this.definition.watchPath;
    if (!watchPath || !fs.existsSync(watchPath)) return null;

    const stat = fs.statSync(watchPath);
    if (stat.mtimeMs <= this.lastModified) return null; // no change
    this.lastModified = stat.mtimeMs;

    // Never read an unbounded file into memory on the single instance (L5).
    const MAX_WATCH_BYTES = 10 * 1024 * 1024;
    if (stat.size > MAX_WATCH_BYTES) {
      process.stderr.write(
        `Memoria custom adapter "${this.definition.id}": watch file is ${stat.size} bytes ` +
          `(cap ${MAX_WATCH_BYTES}); skipping this poll.\n`,
      );
      return null;
    }

    const raw = fs.readFileSync(watchPath, "utf-8");
    return this.parseRawData(raw);
  }

  // ── Shell command mode ─────────────────────────────────────

  /** null when no read happened (disabled, failed or empty command). */
  private pollCommand(): RawEvent[] | null {
    if (!this.definition.command) return null;

    // Defense in depth: refuse to execute unless explicitly opted in, even if a
    // shell_command definition was persisted before this guard existed.
    if (process.env.MEMORIA_ALLOW_SHELL_SOURCES !== "true") {
      process.stderr.write(
        `Memoria custom adapter "${this.definition.id}": shell_command execution is disabled ` +
          `(set MEMORIA_ALLOW_SHELL_SOURCES=true to allow). Skipping.\n`,
      );
      return null;
    }

    try {
      // Split command into executable + args to avoid shell injection
      const parts = this.definition.command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
      const [cmd, ...args] = parts.map((p) => p.replace(/^"|"$/g, ""));
      if (!cmd) return null;

      const output = execFileSync(cmd, args, {
        encoding: "utf-8",
        timeout: 10000,
        maxBuffer: 1024 * 1024, // 1 MB
      });
      return this.parseRawData(output);
    } catch (err: any) {
      process.stderr.write(
        `Memoria custom adapter "${this.definition.id}" command error: ${err.message}\n`,
      );
      return null;
    }
  }

  // ── Webhook mode (queue-based) ─────────────────────────────

  private webhookQueue: RawEvent[] = [];

  /** Called by the HTTP server when a webhook POST arrives */
  pushWebhookEvent(body: unknown): void {
    const events = this.parseRawData(typeof body === "string" ? body : JSON.stringify(body));
    this.webhookQueue.push(...(events ?? []));
  }

  private drainWebhookQueue(): RawEvent[] {
    const events = [...this.webhookQueue];
    this.webhookQueue = [];
    return events;
  }

  // ── Data parsing ───────────────────────────────────────────

  /** null on a parse error: a half-written file is not "no records". */
  private parseRawData(raw: string): RawEvent[] | null {
    const format = this.definition.fileFormat ?? "json";
    const events: RawEvent[] = [];

    try {
      if (format === "json") {
        let data = JSON.parse(raw);

        // Navigate to nested path if specified
        if (this.definition.jsonPath) {
          for (const key of this.definition.jsonPath.split(".")) {
            data = data?.[key];
          }
        }

        // Normalize to array
        const items = Array.isArray(data) ? data : [data];

        for (const item of items) {
          const event = this.mapToEvent(item);
          if (event) events.push(event);
        }
      } else if (format === "csv") {
        const lines = raw.trim().split("\n");
        const headers = splitCsvLine(lines[0] ?? "");
        for (let i = 1; i < lines.length; i++) {
          const values = splitCsvLine(lines[i]);
          const obj: Record<string, string> = {};
          headers.forEach((h, idx) => (obj[h] = values[idx] ?? ""));
          const event = this.mapToEvent(obj);
          if (event) events.push(event);
        }
      } else if (format === "lines") {
        const lines = raw.trim().split("\n").filter(Boolean);
        for (const line of lines) {
          const trimmed = line.trim();
          events.push({
            // Derive a stable id from content so a re-read of unchanged lines
            // collapses at the buffer's UNIQUE(source, event_id) constraint
            // (a random id every poll would re-admit identical lines forever).
            id: `${this.definition.id}-${keyedContentHash(trimmed, this.dataDir).slice(0, 16)}`,
            source: this.info.id, // registry key (`custom-<id>`), for correct stats/rate/dedup
            eventType: "custom_entry",
            content: trimmed,
            timestamp: new Date().toISOString(),
            meta: {},
            importanceEstimate: estimateImportance(trimmed),
            privacyTier: classifyPrivacy(trimmed),
          });
        }
      }
    } catch (err: any) {
      process.stderr.write(
        `Memoria custom adapter "${this.definition.id}" parse error: ${err.message}\n`,
      );
      return null;
    }

    // Apply importance filter
    return events.filter((e) => e.importanceEstimate >= this.config.importanceThreshold);
  }

  private mapToEvent(item: any): RawEvent | null {
    if (!item || typeof item !== "object") return null;

    const fm = this.definition.fieldMap ?? {};

    const content = fm.content ? this.getNestedValue(item, fm.content) : JSON.stringify(item);
    if (!content) return null;

    const timestamp = normalizeTimestamp(
      fm.timestamp ? this.getNestedValue(item, fm.timestamp) : undefined,
    );

    // Prefer a mapped id; otherwise derive a stable id from content so repeated
    // reads of the same record dedup at the buffer instead of piling up.
    const id = fm.id
      ? this.getNestedValue(item, fm.id)
      : `${this.definition.id}-${keyedContentHash(String(content), this.dataDir).slice(0, 16)}`;

    const meta: Record<string, unknown> = {};
    if (fm.meta) {
      for (const metaPath of fm.meta) {
        const key = metaPath.split(".").pop() ?? metaPath;
        meta[key] = this.getNestedValue(item, metaPath);
      }
    }

    return {
      id: String(id),
      source: this.info.id, // registry key (`custom-<id>`), for correct stats/rate/dedup
      eventType: "custom_entry",
      content: String(content),
      timestamp: String(timestamp),
      meta,
      importanceEstimate: estimateImportance(String(content), meta),
      privacyTier: classifyPrivacy(String(content), meta),
    };
  }

  private getNestedValue(obj: any, path: string): any {
    let current = obj;
    for (const key of path.split(".")) {
      current = current?.[key];
    }
    return current;
  }

  // ── What has been collected ────────────────────────────────

  /**
   * Record ids the previous read produced, as 12-hex-character fingerprints
   * (null = no read yet). A watched file is re-read whole whenever it
   * changes and a command's whole output on every poll; without this, every
   * record was emitted again each time, and only the buffer's id dedup
   * (about a day or two) stood between an appended line and a re-ingest of
   * the whole history into today's log.
   */
  private seenIds: Set<string> | null = null;
  /** Upgrading a source that collected before: the first read only records. */
  private baselineOnly = false;

  private static fingerprint(id: string): string {
    return contentHash(id).slice(0, 12);
  }

  /** The previous read had more than MAX_TRACKED records; only its newest are known. */
  private seenCapped = false;

  /**
   * Keep the records not seen before. `null` means no read
   * happened (unchanged, missing or oversized file, a failed or disabled
   * command, a parse error): nothing is learned and nothing is reset, so a
   * skipped read can neither forget what was collected nor use up an
   * upgrade's baseline.
   *
   * Bounded: past MAX_TRACKED records only the newest are remembered. When
   * the previous read was capped, records before the first remembered one
   * in this read are older than that window (a log keeps its order) and are
   * treated as collected, instead of all being emitted again.
   */
  private onlyNew(events: RawEvent[] | null): RawEvent[] {
    const MAX_TRACKED = 50_000;
    if (events === null) return [];
    const previous = this.seenIds ?? new Set<string>();
    const fps = events.map((e) => CustomAdapter.fingerprint(String(e.id)));
    let firstNew = 0;
    if (this.seenCapped) {
      const firstKnown = fps.findIndex((fp) => previous.has(fp));
      if (firstKnown > 0) firstNew = firstKnown;
    }
    const fresh = events.filter((_, i) => i >= firstNew && !previous.has(fps[i]));
    // Remember what was seen before AND now, not only this read: a read that
    // catches a file mid-rewrite (empty or half written), or a command that
    // printed nothing this time, replaced the set and the next full read
    // emitted the whole history again. Older ids first, so the cap keeps
    // the most recently seen.
    const current = new Set<string>(fps);
    const seen = [...[...previous].filter((fp) => !current.has(fp)), ...current];
    this.seenCapped = seen.length > MAX_TRACKED;
    this.seenIds = new Set(this.seenCapped ? seen.slice(-MAX_TRACKED) : seen);
    if (this.baselineOnly) {
      this.baselineOnly = false;
      return [];
    }
    return fresh;
  }

  getCheckpoint(): string {
    if (this.seenIds === null) return this.baselineOnly ? CUSTOM_BASELINE : "";
    return `${this.seenCapped ? "v2c:" : "v2:"}${[...this.seenIds].join("")}`;
  }

  setCheckpoint(cursor: string): void {
    this.checkpoint = cursor;
    this.seenIds = null;
    this.seenCapped = cursor.startsWith("v2c:");
    this.baselineOnly = cursor === CUSTOM_BASELINE;
    const packed = cursor.startsWith("v2:")
      ? cursor.slice(3)
      : cursor.startsWith("v2c:")
        ? cursor.slice(4)
        : null;
    if (packed !== null) {
      const ids = new Set<string>();
      for (let i = 0; i + 12 <= packed.length; i += 12) ids.add(packed.slice(i, i + 12));
      this.seenIds = ids;
    }
  }

  async destroy(): Promise<void> {
    this.webhookQueue = [];
  }
}
