/**
 * Cross-Source Temporal Fusion — detects patterns across data sources.
 *
 * When events from different sources cluster within a time window,
 * they likely relate to the same real-world activity. Fusion creates
 * higher-level "activity" memories that link the individual events.
 *
 * Examples:
 *   - Calendar event "Team standup" + iMessage "joining now" + Email "standup notes"
 *     → Activity: "Team standup (attended, notes received)"
 *   - Calendar "Doctor appointment" + location change + iMessage "on my way"
 *     → Activity: "Doctor visit"
 *
 * Algorithm:
 *   1. Sort events by timestamp
 *   2. Sliding window (±30 min default) groups overlapping events
 *   3. Groups spanning 2+ sources are "fused" into activity records
 *   4. Activities are scored by richness (more sources = higher importance)
 */

import type { RawEvent } from "./adapters/base.js";
import { enforceEventPrivacy } from "./adapters/base.js";
import { utcTimeLabel } from "../daily-format.js";

// ── Types ──────────────────────────────────────────────────

export interface FusedActivity {
  /** Unique ID for this activity */
  id: string;
  /** Best-guess label for the activity */
  label: string;
  /** Detailed description combining all sources */
  description: string;
  /** Start time (earliest event in the cluster) */
  startTime: string;
  /** End time (latest event in the cluster) */
  endTime: string;
  /** Source events that were fused */
  sourceEvents: Array<{
    source: string;
    id: string;
    content: string;
    timestamp: string;
  }>;
  /** Number of distinct sources involved */
  sourceCount: number;
  /** Fused importance (boosted by cross-source confirmation) */
  importance: number;
  /** Tags derived from content */
  tags: string[];
}

export interface FusionConfig {
  /** Time window in ms for clustering events (default: 30 minutes) */
  windowMs?: number;
  /** Minimum sources to create a fused activity (default: 2) */
  minSources?: number;
  /** Minimum events to create a fused activity (default: 2) */
  minEvents?: number;
}

// ── Constants ──────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MIN_SOURCES = 2;
const DEFAULT_MIN_EVENTS = 2;

// ── Fusion Engine ──────────────────────────────────────────

export class TemporalFusion {
  private config: Required<FusionConfig>;

  constructor(config?: FusionConfig) {
    this.config = {
      windowMs: config?.windowMs ?? DEFAULT_WINDOW_MS,
      minSources: config?.minSources ?? DEFAULT_MIN_SOURCES,
      minEvents: config?.minEvents ?? DEFAULT_MIN_EVENTS,
    };
  }

  /**
   * Fuse a set of events into activity records.
   * Events should be from the same rough time period (e.g., today's events).
   */
  fuse(events: RawEvent[]): FusedActivity[] {
    // Privacy gate (H-02/H-03): fused activities are written to the synced
    // daily log, so fusion must apply the same sink-side enforcement as
    // ingestion. Enforce every event's effective tier first, then drop
    // local-only events entirely — their content, label, tags, and meta
    // must never reach a fused activity. Summarize-tier content arrives
    // already truncated by enforceEventPrivacy.
    const safeEvents = events
      .map((e) => enforceEventPrivacy(e))
      .filter((e) => e.privacyTier !== "local-only");
    if (safeEvents.length < this.config.minEvents) return [];

    // Sort by timestamp
    const sorted = [...safeEvents].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    // Build temporal clusters using sliding window
    const clusters = this.clusterEvents(sorted);

    // Convert qualifying clusters to fused activities
    const activities: FusedActivity[] = [];

    for (const cluster of clusters) {
      const sources = new Set(cluster.map((e) => e.source));

      // Skip clusters where every event refers to the same agent_id —
      // those are typically agent_result + agent_metric for the same call,
      // not independent sources. Fusing them creates "Activity at X
      // (orchestrator-foo + orchestrator-metrics)" entries that are pure
      // noise (~90% of fusion output in production).
      const agentIds = new Set(
        cluster
          .map((e) => (e.meta as Record<string, unknown> | undefined)?.agent_id)
          .filter((v): v is string => typeof v === "string"),
      );
      // Skip ONLY when EVERY event carries an agent_id and they are all equal
      // — that's one agent's result + metric recorded twice, not independent
      // observations. Previously the filter fired when agentIds.size === 1
      // even if some events had NO agent_id, which wrongly suppressed genuine
      // cross-source clusters (one agent event + a personal calendar/message
      // event with no id) — the exact fusion the feature exists to catch.
      const everyHasAgentId = cluster.every(
        (e) => typeof (e.meta as Record<string, unknown> | undefined)?.agent_id === "string",
      );
      const allSameAgent = everyHasAgentId && agentIds.size === 1;

      if (
        sources.size >= this.config.minSources &&
        cluster.length >= this.config.minEvents &&
        !allSameAgent
      ) {
        const activity = this.buildActivity(cluster, sources);
        activities.push(activity);
      }
    }

    return activities;
  }

  // ── Clustering ─────────────────────────────────────────────

  private clusterEvents(sorted: RawEvent[]): RawEvent[][] {
    const clusters: RawEvent[][] = [];
    let currentCluster: RawEvent[] = [sorted[0]];
    let clusterEnd = new Date(sorted[0].timestamp).getTime() + this.config.windowMs;

    for (let i = 1; i < sorted.length; i++) {
      const eventTime = new Date(sorted[i].timestamp).getTime();

      if (eventTime <= clusterEnd) {
        // Event falls within the window — add to current cluster
        currentCluster.push(sorted[i]);
        // Extend window from this event
        clusterEnd = Math.max(clusterEnd, eventTime + this.config.windowMs);
      } else {
        // Gap too large — start new cluster
        clusters.push(currentCluster);
        currentCluster = [sorted[i]];
        clusterEnd = eventTime + this.config.windowMs;
      }
    }

    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    return clusters;
  }

  // ── Activity Construction ──────────────────────────────────

  private buildActivity(events: RawEvent[], sources: Set<string>): FusedActivity {
    const timestamps = events.map((e) => new Date(e.timestamp).getTime());
    const startTime = new Date(Math.min(...timestamps)).toISOString();
    const endTime = new Date(Math.max(...timestamps)).toISOString();

    // Determine activity label from the most informative event
    const label = this.deriveLabel(events);

    // Build description
    const description = this.buildDescription(events);

    // Calculate fused importance (boosted by multi-source confirmation)
    const baseImportance = events.reduce((sum, e) => sum + e.importanceEstimate, 0) / events.length;
    const sourceBoost = Math.min(sources.size - 1, 3); // up to +3 for 4 sources
    const importance = Math.min(10, Math.round(baseImportance + sourceBoost));

    // Extract tags
    const tags = this.extractTags(events, sources);

    return {
      id: `fused-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label,
      description,
      startTime,
      endTime,
      sourceEvents: events.map((e) => ({
        source: e.source,
        id: e.id,
        content: e.content.slice(0, 100),
        timestamp: e.timestamp,
      })),
      sourceCount: sources.size,
      importance,
      tags,
    };
  }

  private deriveLabel(events: RawEvent[]): string {
    // Prefer calendar event titles as they're most descriptive
    const calendarEvent = events.find((e) => e.source === "calendar");
    if (calendarEvent) {
      // Extract title (first line or before dash/comma)
      const title = calendarEvent.content.split(/[—,\n]/)[0].trim();
      return title.slice(0, 60);
    }

    // Next prefer email subjects
    const emailEvent = events.find((e) => e.source === "email");
    if (emailEvent?.meta?.subject) {
      return String(emailEvent.meta.subject).slice(0, 60);
    }

    // Fall back to a generic label
    const sources = [...new Set(events.map((e) => e.source))];
    const time = utcTimeLabel(new Date(events[0].timestamp));
    return `Activity at ${time} (${sources.join(" + ")})`;
  }

  private buildDescription(events: RawEvent[]): string {
    const lines: string[] = [];

    // Group by source
    const bySource = new Map<string, RawEvent[]>();
    for (const event of events) {
      const existing = bySource.get(event.source) ?? [];
      existing.push(event);
      bySource.set(event.source, existing);
    }

    for (const [source, sourceEvents] of bySource) {
      const label = this.sourceLabel(source);
      if (sourceEvents.length === 1) {
        lines.push(`**${label}**: ${sourceEvents[0].content.slice(0, 150)}`);
      } else {
        lines.push(`**${label}** (${sourceEvents.length} events):`);
        for (const e of sourceEvents.slice(0, 3)) {
          lines.push(`  - ${e.content.slice(0, 100)}`);
        }
        if (sourceEvents.length > 3) {
          lines.push(`  - ... and ${sourceEvents.length - 3} more`);
        }
      }
    }

    return lines.join("\n");
  }

  private extractTags(events: RawEvent[], sources: Set<string>): string[] {
    const tags: Set<string> = new Set();

    // Add source names as tags
    for (const source of sources) {
      tags.add(source);
    }

    // Add "multi-source" tag for cross-source activities
    tags.add("fused");

    // Detect common activity types
    const allContent = events.map((e) => e.content.toLowerCase()).join(" ");

    if (/meet|standup|sync|call|zoom|teams/i.test(allContent)) {
      tags.add("meeting");
    }
    if (/doctor|health|appointment|medical/i.test(allContent)) {
      tags.add("health");
    }
    if (/deadline|due|submit|release/i.test(allContent)) {
      tags.add("deadline");
    }
    if (/travel|flight|hotel|trip/i.test(allContent)) {
      tags.add("travel");
    }

    return Array.from(tags);
  }

  private sourceLabel(source: string): string {
    const labels: Record<string, string> = {
      imessage: "iMessage",
      calendar: "Calendar",
      email: "Email",
    };
    return labels[source] ?? source;
  }
}

// ── Utility: Format fused activities for memory storage ────

export function formatFusedActivity(activity: FusedActivity): string {
  const date = new Date(activity.startTime).toISOString().slice(0, 10);
  const startTime = utcTimeLabel(new Date(activity.startTime));
  const endTime = utcTimeLabel(new Date(activity.endTime));

  return [
    `## ${activity.label}`,
    "",
    `**Time**: ${startTime} – ${endTime} on ${date}`,
    `**Sources**: ${activity.sourceEvents.map((e) => e.source).join(", ")} (${activity.sourceCount} sources)`,
    `**Importance**: ${activity.importance}/10`,
    `**Tags**: ${activity.tags.join(", ")}`,
    "",
    activity.description,
    "",
    `*Fused from ${activity.sourceEvents.length} events across ${activity.sourceCount} sources*`,
    "",
  ].join("\n");
}
