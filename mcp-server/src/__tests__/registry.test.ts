import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { SourceRegistry } from "../collector/registry.js";
import type { CustomSourceDefinition } from "../collector/adapters/custom.js";

let root: string;
let dataDir: string;
let reg: SourceRegistry;

function def(over: Partial<CustomSourceDefinition>): CustomSourceDefinition {
  return {
    id: "src",
    name: "Source",
    description: "desc",
    mode: "file_watcher",
    ...over,
  } as CustomSourceDefinition;
}

beforeEach(() => {
  delete process.env.MEMORIA_ALLOW_SHELL_SOURCES;
  delete process.env.MEMORIA_FILE_WATCHER_ROOTS;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-reg-"));
  dataDir = path.join(root, "data");
  reg = new SourceRegistry(dataDir); // constructor inits the master key
});

afterEach(() => {
  delete process.env.MEMORIA_ALLOW_SHELL_SOURCES;
  delete process.env.MEMORIA_FILE_WATCHER_ROOTS;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
});

describe("SourceRegistry.addCustomSource gating", () => {
  it("refuses shell_command sources unless MEMORIA_ALLOW_SHELL_SOURCES=true", () => {
    const r = reg.addCustomSource(def({ id: "sh", mode: "shell_command", command: "echo hi" }));
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/shell_command/i);
  });

  it("allows shell_command when explicitly opted in", () => {
    process.env.MEMORIA_ALLOW_SHELL_SOURCES = "true";
    const r = reg.addCustomSource(def({ id: "sh2", mode: "shell_command", command: "echo hi" }));
    expect(r.success).toBe(true);
  });

  it("refuses webhook sources (not implemented — would be a silent no-op)", () => {
    const r = reg.addCustomSource(def({ id: "wh", mode: "webhook", webhookPath: "/wh" }));
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/webhook/i);
  });

  it("refuses a file_watcher pointed at the collector key/credential dir", () => {
    const r = reg.addCustomSource(
      def({ id: "leak", mode: "file_watcher", watchPath: path.join(dataDir, "collector.key") }),
    );
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/collector data directory/i);
  });

  it("denies a file_watcher by default (no MEMORIA_FILE_WATCHER_ROOTS)", () => {
    const wp = path.join(root, "exports.json");
    fs.writeFileSync(wp, "{}");
    const r = reg.addCustomSource(def({ id: "nodefault", mode: "file_watcher", watchPath: wp }));
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/disabled by default|allowlist/i);
  });

  it("accepts a well-formed file_watcher when it is inside an allowed root", () => {
    process.env.MEMORIA_FILE_WATCHER_ROOTS = root;
    const wp = path.join(root, "exports.json");
    fs.writeFileSync(wp, "{}");
    const r = reg.addCustomSource(def({ id: "ok", mode: "file_watcher", watchPath: wp }));
    expect(r.success).toBe(true);
  });

  it("rejects an invalid source id", () => {
    const r = reg.addCustomSource(def({ id: "Bad Id!", mode: "file_watcher", watchPath: root }));
    expect(r.success).toBe(false);
  });
});

describe("SourceRegistry.enableSource consent gate", () => {
  it("refuses to enable a source without recorded user agreement", async () => {
    // imessage is macOS-only; on other platforms enableSource rejects on
    // platform first, so use platform-agnostic assertions: either way it must
    // NOT succeed without consent.
    const r = await reg.enableSource("email");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/agreement|not available/i);
  });
});

describe("source config changes: agent vs user (review 2026-10, credential redirect)", () => {
  function consentedEmail(): void {
    reg.updateSourceConfig(
      "email",
      { host: "imap.example.com", user: "me@example.com", password: "s3cret" },
      "user",
    );
    reg.recordAgreement("email");
  }

  it("an agent cannot redirect a consented source's stored credentials via enable", async () => {
    consentedEmail();
    const r = await reg.enableSource("email", { host: "attacker.example", secure: false }, "agent");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/dashboard/i);
    // Nothing was persisted from the refused change.
    expect(reg.getEffectiveConfig("email")!.settings.host).toBe("imap.example.com");
    expect(reg.getEffectiveConfig("email")!.settings.secure).toBe(true);
  });

  it("enable defaults to the agent origin (fail closed)", async () => {
    consentedEmail();
    const r = await reg.enableSource("email", { settings: { host: "attacker.example" } });
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/dashboard/i);
  });

  it("an agent cannot change settings via configure, in either shape", () => {
    consentedEmail();
    for (const change of [
      { host: "attacker.example" },
      { settings: { host: "attacker.example" } },
    ]) {
      const r = reg.updateSourceConfig("email", change, "agent");
      expect(r.success).toBe(false);
    }
    expect(reg.getEffectiveConfig("email")!.settings.host).toBe("imap.example.com");
  });

  it("an agent can change the scheduling knobs, at the top level where adapters read them", () => {
    const r = reg.updateSourceConfig(
      "email",
      { importanceThreshold: 7, pollIntervalSec: 120 },
      "agent",
    );
    expect(r.success).toBe(true);
    const cfg = reg.getEffectiveConfig("email")!;
    expect(cfg.importanceThreshold).toBe(7);
    expect(cfg.pollIntervalSec).toBe(120);
    // Previously memory_priority set_threshold wrote settings.importanceThreshold,
    // which no adapter reads.
    expect(cfg.settings.importanceThreshold).toBeUndefined();
  });

  it("rejects out-of-range scheduling values", () => {
    expect(reg.updateSourceConfig("email", { pollIntervalSec: 0 }, "agent").success).toBe(false);
    expect(reg.updateSourceConfig("email", { importanceThreshold: 11 }, "agent").success).toBe(
      false,
    );
  });

  it("re-sending an unchanged setting is not a settings change", () => {
    consentedEmail();
    const r = reg.updateSourceConfig("email", { host: "imap.example.com" }, "agent");
    expect(r.success).toBe(true);
  });

  it("the dashboard's flat config form lands in settings, where adapters read it", () => {
    // The dashboard posts { host, port, user, password } to /enable and
    // /configure; enable used to spread these onto the top level.
    reg.updateSourceConfig("email", { host: "h", port: 993, user: "u", password: "p" }, "user");
    const cfg = reg.getEffectiveConfig("email")! as unknown as Record<string, unknown> & {
      settings: Record<string, unknown>;
    };
    expect(cfg.settings).toMatchObject({ host: "h", port: 993, user: "u", password: "p" });
    expect(cfg.host).toBeUndefined();
  });

  it("ignores prototype-polluting keys", () => {
    const change = JSON.parse(
      '{"__proto__": {"polluted": true}, "settings": {"__proto__": {"x": 1}}}',
    );
    reg.updateSourceConfig("email", change, "user");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(reg.getEffectiveConfig("email")!.settings)).toBe(Object.prototype);
  });
});

describe("custom source consent is bound to the definition", () => {
  beforeEach(() => {
    process.env.MEMORIA_FILE_WATCHER_ROOTS = root;
    fs.writeFileSync(path.join(root, "a.json"), "[]");
    fs.writeFileSync(path.join(root, "b.json"), "[]");
  });

  it("removing a custom source revokes its consent; re-adding requires consent again", async () => {
    expect(
      reg.addCustomSource(def({ id: "w", watchPath: path.join(root, "a.json") })).success,
    ).toBe(true);
    reg.recordAgreement("custom-w");
    expect(reg.hasAgreement("custom-w")).toBe(true);
    await reg.removeCustomSource("w");
    expect(reg.hasAgreement("custom-w")).toBe(false);
    expect(
      reg.addCustomSource(def({ id: "w", watchPath: path.join(root, "b.json") })).success,
    ).toBe(true);
    const r = await reg.enableSource("custom-w");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/agreement/i);
  });

  it("consent lingering in old state does not carry over to a new definition", async () => {
    // State written before removal revoked consent.
    reg.recordAgreement("custom-w");
    expect(
      reg.addCustomSource(def({ id: "w", watchPath: path.join(root, "a.json") })).success,
    ).toBe(true);
    expect(reg.hasAgreement("custom-w")).toBe(false);
  });

  it("re-enabling a running source destroys the old instance first", async () => {
    expect(
      reg.addCustomSource(def({ id: "w", watchPath: path.join(root, "a.json") })).success,
    ).toBe(true);
    reg.recordAgreement("custom-w");
    expect((await reg.enableSource("custom-w", undefined, "user")).success).toBe(true);
    const first = reg.getActiveAdapters().get("custom-w")!;
    let destroyed = 0;
    const orig = first.destroy.bind(first);
    first.destroy = async () => {
      destroyed++;
      await orig();
    };
    expect((await reg.enableSource("custom-w", undefined, "user")).success).toBe(true);
    expect(destroyed).toBe(1);
    expect(reg.getActiveAdapters().get("custom-w")).toBeDefined();
  });
});

describe("enabled sources resume after a restart (review 2026-10)", () => {
  beforeEach(() => {
    process.env.MEMORIA_FILE_WATCHER_ROOTS = root;
    fs.writeFileSync(path.join(root, "a.json"), "[]");
  });

  it("re-initialises a consented, enabled source in a new registry", async () => {
    expect(
      reg.addCustomSource(def({ id: "w", watchPath: path.join(root, "a.json") })).success,
    ).toBe(true);
    reg.recordAgreement("custom-w");
    expect((await reg.enableSource("custom-w", undefined, "user")).success).toBe(true);
    await reg.destroy();

    const after = new SourceRegistry(dataDir);
    expect(after.getActiveAdapters().has("custom-w")).toBe(false);
    await after.restoreEnabledSources();
    expect(after.getActiveAdapters().has("custom-w")).toBe(true);
    await after.destroy();
  });

  it("switches off an enabled source whose consent is gone", async () => {
    expect(
      reg.addCustomSource(def({ id: "w", watchPath: path.join(root, "a.json") })).success,
    ).toBe(true);
    reg.recordAgreement("custom-w");
    expect((await reg.enableSource("custom-w", undefined, "user")).success).toBe(true);
    reg.revokeAgreement("custom-w");
    await reg.destroy();

    const after = new SourceRegistry(dataDir);
    await after.restoreEnabledSources();
    expect(after.getActiveAdapters().has("custom-w")).toBe(false);
    expect(after.listSources().find((s) => s.id === "custom-w")!.enabled).toBe(false);
    await after.destroy();
  });

  it("persists one source's cursor on demand", async () => {
    expect(
      reg.addCustomSource(def({ id: "w", watchPath: path.join(root, "a.json") })).success,
    ).toBe(true);
    reg.recordAgreement("custom-w");
    await reg.enableSource("custom-w", undefined, "user");
    const adapter = reg.getActiveAdapters().get("custom-w")!;
    adapter.setCheckpoint("v2:aaaaaaaaaaaa");
    reg.saveCheckpoint("custom-w");
    const reread = new SourceRegistry(dataDir);
    expect((reread as any).state.checkpoints["custom-w"]).toBe("v2:aaaaaaaaaaaa");
    await reg.destroy();
  });
});

describe("source lifecycle hardening (re-review 2026-10)", () => {
  beforeEach(() => {
    process.env.MEMORIA_FILE_WATCHER_ROOTS = root;
    fs.writeFileSync(path.join(root, "a.json"), "[]");
  });

  async function enabledWatcher() {
    expect(
      reg.addCustomSource(def({ id: "w", watchPath: path.join(root, "a.json") })).success,
    ).toBe(true);
    reg.recordAgreement("custom-w");
  }

  it("concurrent enables of one source run one at a time and leave one live instance", async () => {
    await enabledWatcher();
    const adapter = (reg as any).adapters.get("custom-w");
    let live = 0;
    let maxLive = 0;
    const init = adapter.init.bind(adapter);
    const destroy = adapter.destroy.bind(adapter);
    adapter.init = async (c: unknown) => {
      await new Promise((r) => setTimeout(r, 20)); // a slow login
      live++;
      maxLive = Math.max(maxLive, live);
      return init(c);
    };
    adapter.destroy = async () => {
      live--;
      return destroy();
    };
    const results = await Promise.all([
      reg.enableSource("custom-w", undefined, "user"),
      reg.enableSource("custom-w", undefined, "user"),
      reg.restoreEnabledSources(),
    ]);
    expect(results[0].success && results[1].success).toBe(true);
    expect(maxLive).toBe(1);
    expect(live).toBe(1);
  });

  it("a user disabling a source withdraws consent; an agent disabling does not", async () => {
    await enabledWatcher();
    await reg.enableSource("custom-w", undefined, "user");
    await reg.disableSource("custom-w", "agent");
    expect(reg.hasAgreement("custom-w")).toBe(true);
    await reg.enableSource("custom-w", undefined, "user");
    await reg.disableSource("custom-w", "user");
    expect(reg.hasAgreement("custom-w")).toBe(false);
    expect((await reg.enableSource("custom-w")).success).toBe(false);
  });

  it("rejects a poll interval large enough to overflow the timer", () => {
    // 3e6 s exceeds setInterval's 2^31-1 ms and fired every 1ms.
    expect(reg.updateSourceConfig("email", { pollIntervalSec: 3e6 }, "agent").success).toBe(false);
    expect(reg.updateSourceConfig("email", { pollIntervalSec: 86_400 }, "agent").success).toBe(
      true,
    );
  });

  it("disable and re-enable keep the persisted cursor, not a live one a poll ran ahead with", async () => {
    await enabledWatcher();
    await reg.enableSource("custom-w", undefined, "user");
    const adapter = reg.getActiveAdapters().get("custom-w")!;
    adapter.setCheckpoint("v2:dddddddddddd");
    reg.saveCheckpoint("custom-w");
    adapter.setCheckpoint("v2:eeeeeeeeeeee"); // a poll mid-flight
    await reg.disableSource("custom-w", "agent");
    expect((reg as any).state.checkpoints["custom-w"]).toBe("v2:dddddddddddd");
    await reg.destroy();
    expect((new SourceRegistry(dataDir) as any).state.checkpoints["custom-w"]).toBe(
      "v2:dddddddddddd",
    );
  });

  it("hasEnabledSources reflects the switched-on sources", async () => {
    expect(reg.hasEnabledSources()).toBe(false);
    await enabledWatcher();
    await reg.enableSource("custom-w", undefined, "user");
    expect(reg.hasEnabledSources()).toBe(true);
  });
});

describe("resume never undoes a disable queued ahead of it (re-review 2026-10)", () => {
  it("a resume that runs after a pending disable leaves the source off", async () => {
    process.env.MEMORIA_FILE_WATCHER_ROOTS = root;
    fs.writeFileSync(path.join(root, "a.json"), "[]");
    expect(
      reg.addCustomSource(def({ id: "w", watchPath: path.join(root, "a.json") })).success,
    ).toBe(true);
    reg.recordAgreement("custom-w");
    await reg.enableSource("custom-w", undefined, "user");
    const adapter = reg.getActiveAdapters().get("custom-w")!;
    const destroy = adapter.destroy.bind(adapter);
    adapter.destroy = async () => {
      await new Promise((r) => setTimeout(r, 30)); // a slow teardown
      return destroy();
    };
    const disabling = reg.disableSource("custom-w", "agent");
    const resuming = reg.restoreEnabledSources(); // the retry timer fires mid-disable
    await Promise.all([disabling, resuming]);
    expect(reg.getActiveAdapters().has("custom-w")).toBe(false);
    expect(reg.hasEnabledSources()).toBe(false);
  });
});

describe("custom sources emit only new records (review 2026-10)", () => {
  beforeEach(() => {
    process.env.MEMORIA_FILE_WATCHER_ROOTS = root;
  });

  async function watcher(file: string, format: "lines" | "json" = "lines") {
    const { CustomAdapter } = await import("../collector/adapters/custom.js");
    const a = new CustomAdapter(
      def({
        id: "w",
        watchPath: file,
        fileFormat: format,
        fieldMap: { id: "id", content: "content" },
      }),
      { dataDir },
    );
    await a.init({ enabled: true, pollIntervalSec: 60, importanceThreshold: 1, settings: {} });
    return a;
  }
  // Strictly increasing mtimes: the watcher skips a file whose mtime has
  // not moved past the last read.
  let tick = 0;
  const bump = (file: string) => {
    tick += 1;
    const t = new Date(Date.now() + tick * 2000);
    fs.utimesSync(file, t, t);
  };

  it("an appended line yields only that line, not the whole file again", async () => {
    const file = path.join(root, "log.txt");
    fs.writeFileSync(
      file,
      "Decided to migrate the queue to Redis\nShipped the release on Friday\n",
    );
    const a = await watcher(file);
    expect(await a.poll()).toHaveLength(2);
    fs.appendFileSync(file, "Postmortem written for the outage\n");
    bump(file);
    const next = await a.poll();
    expect(next.map((e) => e.content)).toEqual(["Postmortem written for the outage"]);
  });

  it("remembers what it read across a restart (via the checkpoint)", async () => {
    const file = path.join(root, "log.txt");
    fs.writeFileSync(file, "Decided to migrate the queue to Redis\n");
    const a = await watcher(file);
    await a.poll();
    const b = await watcher(file);
    b.setCheckpoint(a.getCheckpoint());
    expect(await b.poll()).toEqual([]);
  });

  it("a source past the tracking cap emits only appended records, not its oldest again", async () => {
    const file = path.join(root, "big.txt");
    const lines = Array.from({ length: 60_000 }, (_, i) => `record number ${i} decided`);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    const a = await watcher(file);
    expect(await a.poll()).toHaveLength(60_000);
    fs.appendFileSync(file, "record number 60000 decided\n");
    bump(file);
    const next = await a.poll();
    expect(next.map((e) => e.content)).toEqual(["record number 60000 decided"]);
    // ...and across a restart, through the (capped) checkpoint.
    const b = await watcher(file);
    b.setCheckpoint(a.getCheckpoint());
    fs.appendFileSync(file, "record number 60001 decided\n");
    bump(file);
    expect((await b.poll()).map((e) => e.content)).toEqual(["record number 60001 decided"]);
  }, 30_000);

  it("a skipped read does not use up an upgrade's baseline", async () => {
    const file = path.join(root, "log.txt");
    fs.writeFileSync(file, "Decided to migrate the queue to Redis\n");
    const { CUSTOM_BASELINE } = await import("../collector/adapters/custom.js");
    const a = await watcher(file);
    a.setCheckpoint(CUSTOM_BASELINE);
    // The file is briefly missing (rotated, say): no read happens.
    fs.renameSync(file, file + ".tmp");
    expect(await a.poll()).toEqual([]);
    expect(a.getCheckpoint()).toBe(CUSTOM_BASELINE);
    fs.renameSync(file + ".tmp", file);
    bump(file);
    expect(await a.poll()).toEqual([]); // the baseline read: records only
    fs.appendFileSync(file, "Shipped the release on Friday\n");
    bump(file);
    expect((await a.poll()).map((e) => e.content)).toEqual(["Shipped the release on Friday"]);
  });

  it("a half-written JSON file (parse error) is not mistaken for an empty one", async () => {
    const file = path.join(root, "data.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "a", content: "Decided to ship on Friday" }]));
    const a = await watcher(file, "json");
    expect(await a.poll()).toHaveLength(1);
    fs.writeFileSync(file, '[{"id": "a", "content": "Decided'); // mid-write
    bump(file);
    expect(await a.poll()).toEqual([]);
    fs.writeFileSync(
      file,
      JSON.stringify([
        { id: "a", content: "Decided to ship on Friday" },
        { id: "b", content: "Postmortem written for the outage" },
      ]),
    );
    bump(file);
    expect((await a.poll()).map((e) => e.content)).toEqual(["Postmortem written for the outage"]);
  });

  it("a source upgraded from 0.2.x records its existing file without re-emitting it", async () => {
    const file = path.join(root, "log.txt");
    fs.writeFileSync(file, "Decided to migrate the queue to Redis\n");
    expect(
      reg.addCustomSource(def({ id: "w", watchPath: file, fileFormat: "lines" })).success,
    ).toBe(true);
    reg.recordAgreement("custom-w");
    (reg as any).state.eventCounts["custom-w"] = 12; // it collected before
    await reg.enableSource("custom-w", undefined, "user");
    const adapter = reg.getActiveAdapters().get("custom-w")!;
    expect(await adapter.poll()).toEqual([]);
    fs.appendFileSync(file, "Shipped the release on Friday\n");
    bump(file);
    expect((await adapter.poll()).map((e) => e.content)).toEqual(["Shipped the release on Friday"]);
  });
});
