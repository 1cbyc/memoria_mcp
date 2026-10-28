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
    adapter.setCheckpoint("cursor-42");
    reg.saveCheckpoint("custom-w");
    const reread = new SourceRegistry(dataDir);
    expect((reread as any).state.checkpoints["custom-w"]).toBe("cursor-42");
    await reg.destroy();
  });
});
