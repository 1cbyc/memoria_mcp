/**
 * Calendar adapter — reads macOS Calendar events.
 * Uses the CalendarStore framework SQLite database.
 * Path: ~/Library/Calendars/Calendar Cache (SQLite)
 *
 * Alternatively, can use ical/CalDAV for cross-platform support.
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import type { SourceAdapter, AdapterInfo, AdapterConfig, RawEvent } from "./base.js";
import { estimateImportance, classifyPrivacy, CORE_DATA_EPOCH } from "./base.js";

export class CalendarAdapter implements SourceAdapter {
  readonly info: AdapterInfo = {
    id: "calendar",
    name: "Calendar",
    description:
      "Collects calendar events from macOS Calendar app. Captures meetings, appointments, and reminders.",
    platforms: ["macos"],
    dependencies: [],
    requiredPermissions: ["Calendar access (granted on first run)"],
    builtIn: true,
    defaultConfig: {
      enabled: false,
      pollIntervalSec: 300, // 5 minutes
      importanceThreshold: 2,
      settings: {
        lookAheadDays: 7,
        lookBehindDays: 1,
        includeAllDayEvents: true,
      },
    },
  };

  private db: any = null;
  /**
   * What has been collected: the window's events by row id, each with a
   * fingerprint of its modification date, start and title. Serialized as
   * the checkpoint ("v2:" + JSON). Older versions stored an ISO
   * modification-date cursor instead (see setCheckpoint).
   */
  private seen: Record<string, string> | null = null;
  /** A pre-v2 cursor: on the next poll, emit only events modified since. */
  private legacyCursor: string | null = null;
  private config!: AdapterConfig;

  async init(config: AdapterConfig): Promise<void> {
    this.config = config;

    // macOS Calendar Cache database
    const cachePath = path.join(os.homedir(), "Library/Calendars/Calendar Cache");

    if (!fs.existsSync(cachePath)) {
      throw new Error(
        "Calendar database not found. Ensure macOS Calendar app has been opened at least once.",
      );
    }

    try {
      const Database = (await import("better-sqlite3")).default;
      this.db = new Database(cachePath, { readonly: true });
    } catch (err: any) {
      throw new Error(
        `Cannot open Calendar database: ${err.message}. ` +
          "You may need to grant Full Disk Access.",
        { cause: err },
      );
    }
  }

  /**
   * Every poll reads the whole window and emits the events it has not
   * collected in their current form. A modification-date cursor (the old
   * design) missed events Calendar stores with no modification date, and
   * events created far ahead that only later slid into the look-ahead
   * window, and needed tie-breaking rules for events sharing a timestamp.
   * The window is small (lookBehind + lookAhead days), so reading it whole
   * is cheap; the seen set is pruned to it, so it stays small too.
   */
  async poll(): Promise<RawEvent[]> {
    if (!this.db) return [];

    const lookAhead = (this.config.settings?.lookAheadDays as number) ?? 7;
    const lookBehind = (this.config.settings?.lookBehindDays as number) ?? 1;
    const includeAllDay = this.config.settings?.includeAllDayEvents !== false;

    const now = new Date();
    const startDate = new Date(now.getTime() - lookBehind * 86400000);
    const endDate = new Date(now.getTime() + lookAhead * 86400000);

    const startCoreData = startDate.getTime() / 1000 - CORE_DATA_EPOCH;
    const endCoreData = endDate.getTime() / 1000 - CORE_DATA_EPOCH;

    // ROWID rather than a named key column: every rowid table has it, and in
    // a Core Data store it is the Z_PK. A query error (the schema differs
    // between macOS versions) propagates to the daemon instead of looking
    // like an empty calendar.
    const LIMIT = 5000;
    const rows = this.db
      .prepare(
        `SELECT
          ci.ROWID as row_id,
          ci.ZSTARTDATE as start_date,
          ci.ZENDDATE as end_date,
          ci.ZSUMMARY as title,
          ci.ZLOCATION as location,
          ci.ZNOTES as notes,
          ci.ZALLDAY as all_day,
          ci.ZMODIFIEDDATE as modified,
          c.ZTITLE as calendar_name
        FROM ZCALENDARITEM ci
        LEFT JOIN ZCALENDAR c ON ci.ZCALENDAR = c.Z_PK
        WHERE ci.ZSTARTDATE BETWEEN ? AND ?
        ORDER BY ci.ZSTARTDATE ASC
        LIMIT ${LIMIT}`,
      )
      .all(startCoreData, endCoreData) as any[];
    if (rows.length >= LIMIT) {
      process.stderr.write(
        `Memoria calendar: more than ${LIMIT} events in the collection window; ` +
          "the latest ones are not collected. Shorten lookAheadDays.\n",
      );
    }

    const previous = this.seen ?? {};
    const legacyCutoff =
      this.legacyCursor !== null
        ? new Date(this.legacyCursor).getTime() / 1000 - CORE_DATA_EPOCH
        : null;
    const seen: Record<string, string> = {};
    const events: RawEvent[] = [];

    for (const row of rows) {
      const key = String(row.row_id);
      const fingerprint = `${row.modified ?? ""}|${row.start_date}|${row.title ?? ""}`;
      seen[key] = fingerprint;
      if (previous[key] === fingerprint) continue;
      // Upgrading from a modification-date cursor: what was modified before
      // it was collected then; only record it.
      if (legacyCutoff !== null && Number.isFinite(legacyCutoff)) {
        if (row.modified == null || row.modified < legacyCutoff) continue;
      }

      if (!row.title) continue;
      if (!includeAllDay && row.all_day) continue;

      const startTime = new Date((row.start_date + CORE_DATA_EPOCH) * 1000);
      const endTime = row.end_date ? new Date((row.end_date + CORE_DATA_EPOCH) * 1000) : null;

      const meta: Record<string, unknown> = {
        calendarName: row.calendar_name ?? "default",
        location: row.location ?? null,
        isAllDay: !!row.all_day,
        endTime: endTime?.toISOString() ?? null,
      };

      const content = [
        row.title,
        row.location ? `at ${row.location}` : "",
        row.notes ? `— ${row.notes.slice(0, 200)}` : "",
      ]
        .filter(Boolean)
        .join(" ");

      const importance = estimateImportance(content, {
        ...meta,
        participantCount: row.notes?.includes("@") ? 3 : 1,
      });

      if (importance < this.config.importanceThreshold) continue;

      events.push({
        id: `cal-${startTime.getTime()}-${row.title.slice(0, 20)}`,
        source: "calendar",
        eventType: row.all_day ? "all_day_event" : "event",
        content,
        timestamp: startTime.toISOString(),
        meta,
        importanceEstimate: Math.max(importance, 4), // Calendar events are at least moderate importance
        // Event titles/notes routinely carry secrets (meeting passcodes, keys).
        // Classify rather than blanket-"send"; the ingestion sink also enforces.
        privacyTier: classifyPrivacy(content, meta),
      });
    }

    this.seen = seen;
    this.legacyCursor = null;
    return events;
  }

  getCheckpoint(): string {
    return this.seen ? `v2:${JSON.stringify(this.seen)}` : (this.legacyCursor ?? "");
  }

  setCheckpoint(cursor: string): void {
    this.seen = null;
    this.legacyCursor = null;
    if (cursor.startsWith("v2:")) {
      try {
        const parsed = JSON.parse(cursor.slice(3));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.seen = parsed as Record<string, string>;
        }
      } catch {
        // unreadable: start over with the whole window
      }
    } else if (cursor) {
      this.legacyCursor = cursor;
    }
  }

  async destroy(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
