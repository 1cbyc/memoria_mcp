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
  private checkpoint: string = ""; // ISO date of last polled event modification
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
      // No checkpoint is set here: the first poll returns the whole window
      // (see poll). Setting it to "now" made the first poll return only
      // events modified after enabling, contradicting that design.
      this.db = new Database(cachePath, { readonly: true });
    } catch (err: any) {
      throw new Error(
        `Cannot open Calendar database: ${err.message}. ` +
          "You may need to grant Full Disk Access.",
        { cause: err },
      );
    }
  }

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

    // Incremental filter. On the first poll (no checkpoint) this is null, so the
    // WHERE clause `(? IS NULL OR ZMODIFIEDDATE >= ?)` returns every event in
    // the window — including never-modified ones whose ZMODIFIEDDATE is NULL
    // (which a bare comparison would drop). Afterwards it returns only events
    // modified since the cursor. `>=` re-sees an event modified exactly at
    // the cursor; the buffer dedupes it by id, which beats missing it.
    const modifiedSinceCoreData = this.checkpoint
      ? new Date(this.checkpoint).getTime() / 1000 - CORE_DATA_EPOCH
      : null;

    // Oldest modification first, so a page cut off by the LIMIT ends at a
    // known point and the next poll resumes there. Ordered by start date
    // with the cursor jumping to "now", every row past the 200th was lost.
    // A query error (the schema differs between macOS versions) propagates
    // to the daemon instead of looking like an empty calendar.
    const LIMIT = 200;
    const rows = this.db
      .prepare(
        `SELECT
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
          AND (? IS NULL OR ci.ZMODIFIEDDATE >= ?)
        ORDER BY ci.ZMODIFIEDDATE ASC, ci.ZSTARTDATE ASC
        LIMIT ${LIMIT}`,
      )
      .all(startCoreData, endCoreData, modifiedSinceCoreData, modifiedSinceCoreData) as any[];

    const events: RawEvent[] = [];

    for (const row of rows) {
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

    // A full page: resume after the last modification actually returned.
    // Otherwise everything modified before this poll started has been seen,
    // so the cursor moves to poll start (an event modified during the query
    // is re-seen next time and deduped, never missed). A full page that did
    // not advance (200+ events sharing one timestamp) would repeat forever,
    // so it moves on and says what it skipped.
    const last = rows[rows.length - 1];
    const lastModifiedMs =
      last?.modified != null ? (last.modified + CORE_DATA_EPOCH) * 1000 : undefined;
    const previousMs = this.checkpoint ? new Date(this.checkpoint).getTime() : -Infinity;
    if (rows.length >= LIMIT && lastModifiedMs !== undefined && lastModifiedMs > previousMs) {
      this.checkpoint = new Date(lastModifiedMs).toISOString();
    } else {
      if (rows.length >= LIMIT) {
        process.stderr.write(
          `Memoria calendar: more than ${LIMIT} events share one modification time; ` +
            "some were skipped.\n",
        );
      }
      this.checkpoint = now.toISOString();
    }
    return events;
  }

  getCheckpoint(): string {
    return this.checkpoint;
  }

  setCheckpoint(cursor: string): void {
    this.checkpoint = cursor;
  }

  async destroy(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
