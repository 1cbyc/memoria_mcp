/**
 * H-02/H-03: temporal fusion must not bypass sink-side privacy enforcement.
 * Both fusion call sites (daemon onIngestion in tools.ts and the memory_fuse
 * MCP tool) pass raw buffer events to TemporalFusion.fuse() and write
 * formatFusedActivity() output to the synced daily log. Fusion therefore
 * enforces the same privacy tiers as ingestion before any content, label,
 * tag, or meta can reach a fused activity.
 */
import { describe, it, expect } from "vitest";
import { TemporalFusion, formatFusedActivity } from "../collector/fusion.js";
import { enforceEventPrivacy } from "../collector/adapters/base.js";
import type { RawEvent } from "../collector/adapters/base.js";

function ev(over: Partial<RawEvent> = {}): RawEvent {
  return {
    id: over.id ?? `evt-${Math.random().toString(36).slice(2)}`,
    source: over.source ?? "imessage",
    eventType: over.eventType ?? "message",
    content: over.content ?? "Ordinary cross-source event body for fusion.",
    timestamp: over.timestamp ?? "2026-07-02T12:00:00Z",
    meta: over.meta ?? {},
    importanceEstimate: over.importanceEstimate ?? 5,
    privacyTier: over.privacyTier ?? "send",
  };
}

const T = "2026-07-02T12:00:00Z";

describe("fusion privacy enforcement (H-02/H-03)", () => {
  it("never emits a labelled local-only event's content", () => {
    const fusion = new TemporalFusion();
    const activities = fusion.fuse([
      ev({
        id: "secret1",
        source: "imessage",
        timestamp: T,
        privacyTier: "local-only",
        content: "password is hunter2 secret xyz",
      }),
      ev({
        id: "mail1",
        source: "email",
        timestamp: T,
        content: "Standup notes from the team meeting",
      }),
    ]);
    const out = activities.map(formatFusedActivity).join("\n");
    expect(out).not.toContain("hunter2");
    expect(activities).toHaveLength(0);
  });

  it("re-classifies a mislabelled 'send' event containing a secret", () => {
    const fusion = new TemporalFusion();
    const activities = fusion.fuse([
      ev({
        id: "secret2",
        source: "imessage",
        timestamp: T,
        privacyTier: "send",
        content: "my password is hunter2 secret xyz",
      }),
      ev({
        id: "mail2",
        source: "email",
        timestamp: T,
        content: "Standup notes from the team meeting",
      }),
    ]);
    const out = activities.map(formatFusedActivity).join("\n");
    expect(out).not.toContain("hunter2");
    expect(activities).toHaveLength(0);
  });

  it("fuses only the safe events when a cluster mixes safe and local-only", () => {
    const fusion = new TemporalFusion();
    const activities = fusion.fuse([
      ev({
        id: "secret3",
        source: "imessage",
        timestamp: T,
        privacyTier: "local-only",
        content: "password is hunter2 secret xyz",
      }),
      ev({ id: "cal1", source: "calendar", timestamp: T, content: "Team standup meeting" }),
      ev({
        id: "mail3",
        source: "email",
        timestamp: T,
        content: "Standup notes from the team meeting",
      }),
    ]);
    expect(activities).toHaveLength(1);
    expect(activities[0].sourceEvents.map((e) => e.id)).not.toContain("secret3");
    const out = formatFusedActivity(activities[0]);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("Team standup");
  });

  it("does not leak a secret through the email-subject label path", () => {
    // No calendar event in the cluster: deriveLabel falls back to the email
    // subject, so a secret subject is the label itself if meta is not dropped.
    const fusion = new TemporalFusion();
    const activities = fusion.fuse([
      ev({
        id: "mail4",
        source: "email",
        timestamp: T,
        content: "Ordinary email body about the meeting",
        meta: { subject: "password is hunter2 secret xyz" },
      }),
      ev({ id: "msg4", source: "imessage", timestamp: T, content: "Joining the meeting now" }),
    ]);
    expect(activities).toHaveLength(1);
    expect(activities[0].label).not.toContain("hunter2");
    const out = formatFusedActivity(activities[0]);
    expect(out).not.toContain("hunter2");
    expect(activities[0].tags.join(" ")).not.toContain("hunter2");
  });

  it("does not leak a secret through a non-scalar (array) meta subject", () => {
    const fusion = new TemporalFusion();
    const activities = fusion.fuse([
      ev({
        id: "mail5",
        source: "email",
        timestamp: T,
        content: "Ordinary email body about the meeting",
        meta: { subject: ["password is hunter2 secret xyz"] },
      }),
      ev({ id: "msg5", source: "imessage", timestamp: T, content: "Joining the meeting now" }),
    ]);
    expect(activities).toHaveLength(1);
    expect(activities[0].label).not.toContain("hunter2");
    expect(formatFusedActivity(activities[0])).not.toContain("hunter2");
  });

  it("drops a local-only calendar event instead of using it as the label", () => {
    const fusion = new TemporalFusion();
    const activities = fusion.fuse([
      ev({
        id: "cal4",
        source: "calendar",
        timestamp: T,
        privacyTier: "local-only",
        content: "password hunter2 review meeting",
      }),
      ev({
        id: "mail6",
        source: "email",
        timestamp: T,
        content: "Standup notes from the team meeting",
      }),
    ]);
    expect(activities).toHaveLength(0);
  });

  it("suppresses bare value-shaped secrets with no keyword (SSN, AWS key)", () => {
    const fusion = new TemporalFusion();
    for (const secret of ["123-45-6789", "AKIAIOSFODNN7EXAMPLE"]) {
      const activities = fusion.fuse([
        ev({
          id: `v-${secret}`,
          source: "imessage",
          timestamp: T,
          content: `value ${secret} here`,
        }),
        ev({
          id: `m-${secret}`,
          source: "email",
          timestamp: T,
          content: "Standup notes from the team meeting",
        }),
      ]);
      expect(activities.map(formatFusedActivity).join("\n")).not.toContain(secret);
      expect(activities).toHaveLength(0);
    }
  });

  it("truncates summarize-tier content before it reaches a fused activity", () => {
    const tail = "TAILMARKER-ONLY-AT-THE-END";
    const longContent = `Meeting notes ${"x".repeat(600)} ${tail}`;
    // Direct helper assertion: enforcement itself cuts the tail.
    const safe = enforceEventPrivacy(ev({ id: "long0", content: longContent }));
    expect(safe.privacyTier).toBe("summarize");
    expect(safe.content).not.toContain(tail);
    expect(safe.content.length).toBeLessThan(longContent.length);
    // Fusion assertion on the activity object, not just formatted output:
    // fused source-event content is sliced from the truncated text.
    const fusion = new TemporalFusion();
    const activities = fusion.fuse([
      ev({ id: "long1", source: "email", timestamp: T, content: longContent }),
      ev({ id: "cal3", source: "calendar", timestamp: T, content: "Team standup meeting" }),
    ]);
    expect(activities).toHaveLength(1);
    expect(JSON.stringify(activities[0])).not.toContain(tail);
    expect(formatFusedActivity(activities[0])).not.toContain(tail);
  });
});
