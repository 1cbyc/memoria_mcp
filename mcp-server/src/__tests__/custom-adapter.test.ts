import { describe, expect, it } from "vitest";
import { CustomAdapter, type CustomSourceDefinition } from "../collector/adapters/custom.js";

function definition(): CustomSourceDefinition {
  return {
    id: "webhook-test",
    name: "Webhook test",
    description: "Synthetic custom source",
    mode: "webhook",
    fileFormat: "json",
    fieldMap: { id: "id", content: "content", timestamp: "timestamp" },
  };
}

describe("CustomAdapter timestamps", () => {
  it("keeps plausible timestamps and normalizes invalid or microsecond values", async () => {
    const adapter = new CustomAdapter(definition());
    await adapter.init({
      enabled: true,
      pollIntervalSec: 60,
      importanceThreshold: 1,
      settings: {},
    });

    const before = Date.now();
    adapter.pushWebhookEvent([
      { id: "valid", content: "valid timestamp", timestamp: "2026-09-24T14:05:00+02:00" },
      { id: "microseconds", content: "microsecond timestamp", timestamp: 1727186400000000 },
      { id: "invalid", content: "invalid timestamp", timestamp: "24/09/2026" },
    ]);
    const events = await adapter.poll();
    const after = Date.now();

    expect(events[0].timestamp).toBe("2026-09-24T12:05:00.000Z");
    for (const event of events.slice(1)) {
      const normalized = new Date(event.timestamp).getTime();
      expect(normalized).toBeGreaterThanOrEqual(before);
      expect(normalized).toBeLessThanOrEqual(after);
    }
  });
});
