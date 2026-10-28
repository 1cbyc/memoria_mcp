/**
 * Source Registry — manages available and enabled data sources.
 *
 * Features:
 *   - Select/deselect data sources
 *   - Add custom sources (user-defined)
 *   - Auto-install npm dependencies when a source is enabled
 *   - Persist configuration (encrypted)
 *   - User agreement flow before enabling any source
 */

import * as fs from "node:fs";
import { writeFileAtomic } from "../atomic-fs.js";
import * as path from "node:path";
import { installDependencies, isDependencyAvailable, setAdapterModulesDir } from "./deps.js";
import type { SourceAdapter, AdapterConfig } from "./adapters/base.js";
import { IMessageAdapter } from "./adapters/imessage.js";
import { CalendarAdapter } from "./adapters/calendar.js";
import { EmailAdapter } from "./adapters/email.js";
import { GoogleGmailAdapter } from "./adapters/google-gmail.js";
import { GoogleCalendarAdapter } from "./adapters/google-calendar.js";
import { GoogleDriveAdapter } from "./adapters/google-drive.js";
import {
  CUSTOM_BASELINE,
  CustomAdapter,
  assertWatchPathAllowed,
  type CustomSourceDefinition,
} from "./adapters/custom.js";
import { encryptJSON, decryptJSON, initMasterKey } from "./crypto.js";

// ── Types ──────────────────────────────────────────────────

export interface SourceStatus {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  installed: boolean;
  platforms: string[];
  requiredPermissions: string[];
  builtIn: boolean;
  eventCount: number;
  lastPoll: string | null;
  error: string | null;
  /**
   * For a custom source, what it actually reads or runs (the watched path
   * or the command). Shown in the consent dialog: the name and description
   * are free text chosen by whoever added the source, possibly an agent.
   */
  detail: string | null;
}

export interface UserAgreement {
  agreedAt: string;
  sources: string[];
  version: number;
}

interface RegistryState {
  configs: Record<string, AdapterConfig>;
  checkpoints: Record<string, string>;
  customSources: CustomSourceDefinition[];
  agreement: UserAgreement | null;
  eventCounts: Record<string, number>;
}

/**
 * Who asked for a source change. "user" is the dashboard: a person at a
 * logged-in browser. "agent" is any MCP caller, which may be acting on
 * prompt-injected instructions, so it is held to scheduling changes only.
 */
export type ChangeOrigin = "user" | "agent";

const MIN_POLL_SEC = 10;
/** One day. Larger values overflow setInterval (2^31-1 ms) into a 1ms loop. */
export const MAX_POLL_SEC = 86_400;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Apply a config change to a source's effective config. Accepts both shapes
 * callers send: `{ settings: {...} }` and the flat form the dashboard posts
 * (`{ host, user, password }`), where every key other than the two
 * scheduling knobs is a source setting. Before this, enable spread the flat
 * form onto the top level, so a dashboard-configured email or Google source
 * never saw its own settings.
 *
 * `settingsChanged` reports whether anything under `settings` changed. That
 * is where hosts, TLS, credentials, watch paths and labels live, i.e. what is
 * collected and where credentials are sent, so only the user may change it.
 */
export function applyConfigChange(
  base: AdapterConfig,
  change: Record<string, unknown> | undefined,
): { config: AdapterConfig; settingsChanged: boolean } | { error: string } {
  const settings: Record<string, unknown> = { ...base.settings };
  const config: AdapterConfig = { ...base, settings };
  let settingsChanged = false;
  const setSetting = (key: string, value: unknown) => {
    if (UNSAFE_KEYS.has(key)) return;
    if (JSON.stringify(settings[key]) !== JSON.stringify(value)) settingsChanged = true;
    settings[key] = value;
  };

  for (const [key, value] of Object.entries(change ?? {})) {
    if (UNSAFE_KEYS.has(key) || key === "enabled") continue;
    if (key === "pollIntervalSec") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < MIN_POLL_SEC ||
        value > MAX_POLL_SEC
      ) {
        return {
          error: `pollIntervalSec must be a number of seconds from ${MIN_POLL_SEC} to ${MAX_POLL_SEC}.`,
        };
      }
      config.pollIntervalSec = value;
    } else if (key === "importanceThreshold") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
        return { error: "importanceThreshold must be an integer from 1 to 10." };
      }
      config.importanceThreshold = value;
    } else if (key === "settings" && isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) setSetting(k, v);
    } else {
      setSetting(key, value);
    }
  }
  return { config, settingsChanged };
}

const AGENT_SETTINGS_REFUSAL =
  "Source settings (hosts, credentials, paths, labels) can only be changed in the Memoria " +
  "dashboard (Sources tab). Through MCP, only pollIntervalSec and importanceThreshold can be changed.";

// ── Registry ───────────────────────────────────────────────

export class SourceRegistry {
  private adapters = new Map<string, SourceAdapter>();
  private activeAdapters = new Map<string, SourceAdapter>();
  private state: RegistryState;
  private configPath: string;
  private dataDir: string;
  private errors = new Map<string, string>();
  /** Serializes enable/disable/remove per source (see withSourceLock). */
  private sourceOps = new Map<string, Promise<unknown>>();
  private resumeErrorsLogged = new Map<string, string>();
  private lastPolled = new Map<string, string>();

  /**
   * @param adapterModulesDir where optional adapter dependencies (imapflow,
   *   googleapis) are installed on demand; see deps.ts.
   */
  constructor(dataDir: string, adapterModulesDir = path.join(dataDir, "adapter-modules")) {
    this.configPath = path.join(dataDir, "collector-config.enc");
    this.dataDir = dataDir;
    setAdapterModulesDir(adapterModulesDir);

    // Init encryption
    initMasterKey(dataDir);

    // Register built-in adapters
    this.registerBuiltIn(new IMessageAdapter());
    this.registerBuiltIn(new CalendarAdapter());
    this.registerBuiltIn(new EmailAdapter());
    this.registerBuiltIn(new GoogleGmailAdapter());
    this.registerBuiltIn(new GoogleCalendarAdapter());
    this.registerBuiltIn(new GoogleDriveAdapter());

    // Load persisted state
    this.state = this.loadState();

    // Re-register custom sources from state
    for (const def of this.state.customSources) {
      this.adapters.set(`custom-${def.id}`, new CustomAdapter(def, { dataDir }));
    }
  }

  // ── Built-in registration ────────────────────────────────

  private registerBuiltIn(adapter: SourceAdapter): void {
    this.adapters.set(adapter.info.id, adapter);
  }

  // ── Source listing and selection ──────────────────────────

  /**
   * List all available sources with their status.
   */
  listSources(): SourceStatus[] {
    const statuses: SourceStatus[] = [];

    for (const [id, adapter] of this.adapters) {
      const config = this.state.configs[id] ?? adapter.info.defaultConfig;
      const depsInstalled = this.checkDependencies(adapter.info.dependencies);

      statuses.push({
        id,
        name: adapter.info.name,
        description: adapter.info.description,
        enabled: config.enabled,
        installed: depsInstalled,
        platforms: adapter.info.platforms,
        requiredPermissions: adapter.info.requiredPermissions,
        builtIn: adapter.info.builtIn,
        eventCount: this.state.eventCounts[id] ?? 0,
        lastPoll: this.lastPolled.get(id) ?? null,
        error: this.errors.get(id) ?? null,
        detail: this.customDetail(id),
      });
    }

    return statuses;
  }

  private customDetail(sourceId: string): string | null {
    const def = this.state.customSources.find((d) => `custom-${d.id}` === sourceId);
    if (!def) return null;
    if (def.mode === "shell_command") return `Runs the command: ${def.command ?? ""}`;
    if (def.mode === "file_watcher") return `Reads the file: ${def.watchPath ?? ""}`;
    return `Mode: ${def.mode}`;
  }

  /**
   * Enable a data source. Requires user agreement.
   * Auto-installs dependencies if needed.
   */
  /**
   * Run lifecycle operations on one source one at a time. Two enables of the
   * same source (the startup resume and a dashboard click, say) both saw no
   * running instance and both ran init on the one adapter object, orphaning
   * the first IMAP connection.
   */
  private withSourceLock<T>(sourceId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.sourceOps.get(sourceId) ?? Promise.resolve();
    const next = prev.then(op, op);
    const tail = next.catch(() => {});
    this.sourceOps.set(sourceId, tail);
    void tail.then(() => {
      if (this.sourceOps.get(sourceId) === tail) this.sourceOps.delete(sourceId);
    });
    return next;
  }

  enableSource(
    sourceId: string,
    configOverrides?: Record<string, unknown>,
    origin: ChangeOrigin = "agent",
  ): Promise<{ success: boolean; message: string }> {
    return this.withSourceLock(sourceId, () =>
      this.enableSourceUnlocked(sourceId, configOverrides, origin),
    );
  }

  private async enableSourceUnlocked(
    sourceId: string,
    configOverrides: Record<string, unknown> | undefined,
    origin: ChangeOrigin,
  ): Promise<{ success: boolean; message: string }> {
    const adapter = this.adapters.get(sourceId);
    if (!adapter) {
      return { success: false, message: `Unknown source: ${sourceId}` };
    }

    // Check platform compatibility
    const platformMap: Record<string, string> = {
      darwin: "macos",
      linux: "linux",
      win32: "windows",
    };
    const currentPlatform = platformMap[process.platform] || process.platform;
    if (
      adapter.info.platforms.length > 0 &&
      !adapter.info.platforms.includes(currentPlatform as (typeof adapter.info.platforms)[number])
    ) {
      return {
        success: false,
        message:
          `Source "${adapter.info.name}" is not available on ${currentPlatform}. ` +
          `Supported platforms: ${adapter.info.platforms.join(", ")}`,
      };
    }

    // Check user agreement
    if (!this.hasAgreement(sourceId)) {
      return {
        success: false,
        message:
          `User agreement required before enabling "${adapter.info.name}". ` +
          `This source will collect: ${adapter.info.description} ` +
          `Permissions needed: ${adapter.info.requiredPermissions.join(", ") || "none"}. ` +
          `All collected data is encrypted (AES-256-GCM). Only you and the Memoria agent have access. ` +
          `Grant consent in the Memoria dashboard (Sources tab) — consent cannot be granted through the MCP tool surface.`,
      };
    }

    // Re-validate file_watcher containment at enable time (a definition may
    // have been persisted before the guard existed, or the allowlist may have
    // tightened since it was added).
    const customDef = this.state.customSources.find((d) => `custom-${d.id}` === sourceId);
    if (customDef?.mode === "file_watcher") {
      try {
        assertWatchPathAllowed(customDef.watchPath ?? "", { dataDir: this.dataDir });
      } catch (e: any) {
        return { success: false, message: e.message };
      }
    }

    // Resolve the config before doing anything with side effects. An agent
    // may not change settings: consent was given for the source as the user
    // configured it, and reusing that consent with an attacker's host would
    // send the stored credentials there (review 2026-10, credential redirect).
    const change = applyConfigChange(
      { ...adapter.info.defaultConfig, ...this.state.configs[sourceId] },
      configOverrides,
    );
    if ("error" in change) return { success: false, message: change.error };
    if (change.settingsChanged && origin !== "user") {
      return { success: false, message: AGENT_SETTINGS_REFUSAL };
    }

    // Auto-install dependencies
    if (adapter.info.dependencies.length > 0) {
      const installResult = await this.installDependencies(adapter.info.dependencies);
      if (!installResult.success) {
        return {
          success: false,
          message: `Failed to install dependencies: ${installResult.message}`,
        };
      }
    }

    const config: AdapterConfig = { ...change.config, enabled: true };
    this.state.configs[sourceId] = config;

    // Re-enabling a running source: release the old instance (its IMAP
    // connection or SQLite handle) before re-initialising. Its live cursor
    // is NOT kept: a poll may be mid-flight and have advanced it past events
    // that never reached the buffer. The persisted cursor (saved by the
    // daemon once events are buffered) is the truth.
    const running = this.activeAdapters.get(sourceId);
    if (running) {
      this.activeAdapters.delete(sourceId);
      try {
        await running.destroy();
      } catch {
        // best effort: a failed teardown must not block the re-init
      }
    }

    // Initialize adapter
    try {
      // Restore checkpoint
      const savedCheckpoint = this.state.checkpoints[sourceId];
      if (savedCheckpoint) {
        adapter.setCheckpoint(savedCheckpoint);
      } else if (adapter instanceof CustomAdapter && (this.state.eventCounts[sourceId] ?? 0) > 0) {
        // A custom source that collected under 0.2.x, which kept no record
        // of what it had read: take what is there now as already collected
        // rather than re-ingesting its whole history once.
        adapter.setCheckpoint(CUSTOM_BASELINE);
      }

      await adapter.init(config);
      this.activeAdapters.set(sourceId, adapter);
      this.errors.delete(sourceId);
      this.saveState();

      return {
        success: true,
        message: `Source "${adapter.info.name}" enabled and collecting.`,
      };
    } catch (err: any) {
      this.errors.set(sourceId, err.message);
      return {
        success: false,
        message: `Failed to initialize "${adapter.info.name}": ${err.message}`,
      };
    }
  }

  /**
   * Disable a data source.
   */
  /**
   * Disable a source. When the user does it (the dashboard), consent is
   * withdrawn too: otherwise an agent could switch straight back on a
   * source the user had turned off. An agent disabling leaves consent as is.
   */
  disableSource(
    sourceId: string,
    origin: ChangeOrigin = "agent",
  ): Promise<{ success: boolean; message: string }> {
    return this.withSourceLock(sourceId, () => this.disableSourceUnlocked(sourceId, origin));
  }

  private async disableSourceUnlocked(
    sourceId: string,
    origin: ChangeOrigin,
  ): Promise<{ success: boolean; message: string }> {
    // The live cursor is not saved here (see enableSourceUnlocked): the
    // daemon persists it once a poll's events are buffered.
    const adapter = this.activeAdapters.get(sourceId);
    if (adapter) {
      this.activeAdapters.delete(sourceId);
      await adapter.destroy();
    }

    if (this.state.configs[sourceId]) {
      this.state.configs[sourceId].enabled = false;
    }
    if (origin === "user") this.revokeAgreement(sourceId);

    this.saveState();
    return {
      success: true,
      message: `Source "${sourceId}" disabled.`,
    };
  }

  /**
   * Update configuration for a source.
   */
  updateSourceConfig(
    sourceId: string,
    changes: Record<string, unknown>,
    origin: ChangeOrigin = "agent",
  ): { success: boolean; message: string } {
    const adapter = this.adapters.get(sourceId);
    if (!adapter) {
      return { success: false, message: `Unknown source: ${sourceId}` };
    }

    const change = applyConfigChange(
      { ...adapter.info.defaultConfig, ...this.state.configs[sourceId] },
      changes,
    );
    if ("error" in change) return { success: false, message: change.error };
    if (change.settingsChanged && origin !== "user") {
      return { success: false, message: AGENT_SETTINGS_REFUSAL };
    }
    this.state.configs[sourceId] = change.config;

    this.saveState();
    return {
      success: true,
      message: `Configuration updated for "${sourceId}". Restart the source for changes to take effect.`,
    };
  }

  // ── Custom source management ─────────────────────────────

  /**
   * Add a user-defined custom data source.
   */
  addCustomSource(input: CustomSourceDefinition): { success: boolean; message: string } {
    // Name and description are free text from whoever adds the source,
    // possibly an agent, and the consent dialog shows them: one line each,
    // bounded, so they cannot carry a fake "Reads the file: ..." line or
    // push the real one out of view.
    const oneLine = (v: unknown, max: number) =>
      String(v ?? "")
        // eslint-disable-next-line no-control-regex -- stripping control characters is the point
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
        .trim()
        .slice(0, max);
    const definition: CustomSourceDefinition = {
      ...input,
      name: oneLine(input.name, 80),
      description: oneLine(input.description, 300),
    };
    // Validate
    if (!definition.id || !/^[a-z0-9_-]+$/.test(definition.id)) {
      return {
        success: false,
        message: "Source ID must be lowercase alphanumeric with hyphens/underscores.",
      };
    }

    if (this.adapters.has(`custom-${definition.id}`)) {
      return {
        success: false,
        message: `Custom source "${definition.id}" already exists.`,
      };
    }

    if (!["file_watcher", "shell_command", "webhook"].includes(definition.mode)) {
      return {
        success: false,
        message: 'Mode must be "file_watcher", "shell_command", or "webhook".',
      };
    }

    // shell_command sources run arbitrary executables on the host. On a
    // networked deployment that is remote code execution, so it is disabled
    // unless explicitly opted in on a trusted local instance.
    if (definition.mode === "shell_command" && process.env.MEMORIA_ALLOW_SHELL_SOURCES !== "true") {
      return {
        success: false,
        message:
          "shell_command sources are disabled for security (arbitrary command execution). " +
          "Set MEMORIA_ALLOW_SHELL_SOURCES=true on a trusted local instance to enable them.",
      };
    }

    // webhook mode has no HTTP delivery route wired (pushWebhookEvent is never
    // called), so a webhook source would silently collect nothing. Reject it
    // rather than present a dead no-op. Push events to the authenticated
    // /ingest endpoint, or use file_watcher / shell_command instead.
    if (definition.mode === "webhook") {
      return {
        success: false,
        message:
          "webhook custom sources are not yet supported (no HTTP delivery endpoint is wired). " +
          "Push events to the authenticated /ingest endpoint, or use a file_watcher or shell_command source.",
      };
    }

    // file_watcher sources read an arbitrary host path. Contain it so a watcher
    // can't be pointed at the collector's own key/credential store (or, when an
    // allowlist is configured, anywhere outside it).
    if (definition.mode === "file_watcher") {
      if (!definition.watchPath) {
        return { success: false, message: "file_watcher sources require a watchPath." };
      }
      try {
        assertWatchPathAllowed(definition.watchPath, { dataDir: this.dataDir });
      } catch (e: any) {
        return { success: false, message: e.message };
      }
    }

    // A new definition is a new consent decision. Consent left behind by an
    // earlier source with this id (removed before removal revoked it) must
    // not carry over to whatever this one watches or runs.
    this.revokeAgreement(`custom-${definition.id}`);

    // Register the adapter
    const adapter = new CustomAdapter(definition, { dataDir: this.dataDir });
    this.adapters.set(`custom-${definition.id}`, adapter);
    this.state.customSources.push(definition);
    this.saveState();

    return {
      success: true,
      message:
        `Custom source "${definition.name}" added (ID: custom-${definition.id}). ` +
        `Enable it with action "enable" and source "custom-${definition.id}".`,
    };
  }

  /**
   * Remove a custom data source.
   */
  removeCustomSource(sourceId: string): Promise<{ success: boolean; message: string }> {
    const fullId = sourceId.startsWith("custom-") ? sourceId : `custom-${sourceId}`;
    return this.withSourceLock(fullId, () => this.removeCustomSourceUnlocked(sourceId, fullId));
  }

  private async removeCustomSourceUnlocked(
    sourceId: string,
    fullId: string,
  ): Promise<{ success: boolean; message: string }> {
    if (!this.adapters.has(fullId)) {
      return { success: false, message: `Custom source "${sourceId}" not found.` };
    }

    // Disable first
    await this.disableSourceUnlocked(fullId, "agent");

    // Remove from registry
    this.adapters.delete(fullId);
    this.state.customSources = this.state.customSources.filter((d) => `custom-${d.id}` !== fullId);
    delete this.state.configs[fullId];
    delete this.state.checkpoints[fullId];
    delete this.state.eventCounts[fullId];
    // Consent was for this definition; a later add_custom with the same id
    // must be agreed to afresh in the dashboard.
    this.revokeAgreement(fullId);

    this.saveState();
    return { success: true, message: `Custom source "${sourceId}" removed.` };
  }

  // ── User agreement ───────────────────────────────────────

  /**
   * Record user consent for a source.
   */
  recordAgreement(sourceId: string): void {
    if (!this.state.agreement) {
      this.state.agreement = {
        agreedAt: new Date().toISOString(),
        sources: [],
        version: 1,
      };
    }

    if (!this.state.agreement.sources.includes(sourceId)) {
      this.state.agreement.sources.push(sourceId);
      this.state.agreement.agreedAt = new Date().toISOString();
    }

    this.saveState();
  }

  revokeAgreement(sourceId: string): void {
    if (!this.state.agreement) return;
    const before = this.state.agreement.sources.length;
    this.state.agreement.sources = this.state.agreement.sources.filter((s) => s !== sourceId);
    if (this.state.agreement.sources.length !== before) this.saveState();
  }

  hasAgreement(sourceId: string): boolean {
    return this.state.agreement?.sources.includes(sourceId) ?? false;
  }

  // ── Polling (used by the daemon) ─────────────────────────

  /**
   * Get all active (enabled + initialized) adapters.
   */
  getActiveAdapters(): Map<string, SourceAdapter> {
    return this.activeAdapters;
  }

  /**
   * The effective config for a source: the adapter's static defaults overlaid
   * with any persisted per-source overrides. Use this (not info.defaultConfig)
   * to read runtime settings like pollIntervalSec.
   */
  getEffectiveConfig(sourceId: string): AdapterConfig | null {
    const adapter = this.adapters.get(sourceId);
    if (!adapter) return null;
    return { ...adapter.info.defaultConfig, ...this.state.configs[sourceId] };
  }

  /**
   * Record that events were collected.
   */
  recordEvents(sourceId: string, count: number): void {
    this.state.eventCounts[sourceId] = (this.state.eventCounts[sourceId] ?? 0) + count;
    this.lastPolled.set(sourceId, new Date().toISOString());
  }

  /**
   * Persist one active adapter's cursor (after its events reached the buffer).
   */
  saveCheckpoint(sourceId: string): void {
    const adapter = this.activeAdapters.get(sourceId);
    if (!adapter) return;
    const cursor = adapter.getCheckpoint();
    if (this.state.checkpoints[sourceId] === cursor) return;
    this.state.checkpoints[sourceId] = cursor;
    this.saveState();
  }

  /**
   * Re-initialise every source the user left enabled, after a restart.
   * Nothing did this before: the dashboard kept showing "Enabled" while no
   * adapter ran, so collection silently stopped at every restart. A source
   * whose consent is gone is switched off; one that fails to start keeps
   * its enabled flag and shows the error, and is retried on the next start.
   */
  async restoreEnabledSources(onEnabled?: (sourceId: string) => void): Promise<void> {
    const pending: Array<Promise<void>> = [];
    for (const [sourceId, config] of Object.entries(this.state.configs)) {
      if (!config?.enabled || this.activeAdapters.has(sourceId)) continue;
      if (!this.adapters.has(sourceId)) continue;
      if (!this.hasAgreement(sourceId)) {
        config.enabled = false;
        this.saveState();
        continue;
      }
      // Each source on its own: one slow login must not hold up the rest.
      // The checks above are repeated under the source's lock: a disable
      // queued ahead of this resume (the retry timer can fire mid-disable)
      // must win, not be undone.
      pending.push(
        this.withSourceLock(sourceId, async () => {
          if (
            !this.state.configs[sourceId]?.enabled ||
            this.activeAdapters.has(sourceId) ||
            !this.hasAgreement(sourceId)
          ) {
            return null;
          }
          return this.enableSourceUnlocked(sourceId, undefined, "agent");
        }).then((result) => {
          if (!result) return;
          if (result.success) {
            this.resumeErrorsLogged.delete(sourceId);
            onEnabled?.(sourceId);
            return;
          }
          this.errors.set(sourceId, result.message);
          // Retried periodically (see tools.ts); say so once per distinct error.
          if (this.resumeErrorsLogged.get(sourceId) !== result.message) {
            this.resumeErrorsLogged.set(sourceId, result.message);
            process.stderr.write(
              `Memoria: could not resume source ${sourceId} (will retry): ${result.message}\n`,
            );
          }
        }),
      );
    }
    await Promise.all(pending);
  }

  /** Whether any source is switched on (whether or not it is running). */
  hasEnabledSources(): boolean {
    return Object.values(this.state.configs).some((c) => c?.enabled);
  }

  /**
   * Save checkpoints for all active adapters.
   */
  saveCheckpoints(): void {
    // Deliberately a no-op beyond what saveCheckpoint already persisted: a
    // live cursor read at shutdown may be ahead of a poll still in flight,
    // whose events never reached the buffer. Kept for callers' symmetry.
  }

  // ── Dependency auto-installer ────────────────────────────

  private checkDependencies(deps: string[]): boolean {
    return deps.every(isDependencyAvailable);
  }

  private async installDependencies(
    deps: string[],
  ): Promise<{ success: boolean; message: string }> {
    return installDependencies(deps);
  }

  // ── State persistence (encrypted) ────────────────────────

  private loadState(): RegistryState {
    const defaultState: RegistryState = {
      configs: {},
      checkpoints: {},
      customSources: [],
      agreement: null,
      eventCounts: {},
    };

    if (!fs.existsSync(this.configPath)) return defaultState;

    try {
      const encrypted = fs.readFileSync(this.configPath, "utf-8");
      return decryptJSON<RegistryState>(encrypted);
    } catch (err) {
      // The file exists but failed to decrypt/parse (wrong key, corruption, or
      // tampering). Do NOT silently discard it — that permanently loses the
      // encrypted credentials and checkpoints. Preserve the original for manual
      // recovery and start with empty in-memory state so the app still runs.
      const backup = `${this.configPath}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.configPath, backup);
        process.stderr.write(
          `Memoria: SECURITY/DATA — collector config failed to decrypt (${(err as Error).message}). ` +
            `Preserved the original at ${backup}; starting with empty state. ` +
            `If MEMORIA_ENCRYPTION_KEY changed, restore the matching key to recover stored credentials.\n`,
        );
      } catch (backupErr) {
        process.stderr.write(
          `Memoria: collector config failed to decrypt and the backup also failed ` +
            `(${(backupErr as Error).message}); leaving the original in place. ` +
            `Operator action required before re-enabling sources.\n`,
        );
      }
      return defaultState;
    }
  }

  private saveState(): void {
    const encrypted = encryptJSON(this.state);
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    // Atomic: a crash or full disk mid-write used to leave a truncated
    // ciphertext that fails to decrypt, i.e. every stored credential gone.
    writeFileAtomic(this.configPath, encrypted, { mode: 0o600 });
  }

  // ── Cleanup ──────────────────────────────────────────────

  async destroy(): Promise<void> {
    // No saveState here: cursors are persisted as polls complete, and
    // writing state on every shutdown created the collector config (the
    // signal that resumes the collector at boot) for anyone who merely
    // listed sources.
    const adapters = [...this.activeAdapters.values()];
    this.activeAdapters.clear();
    for (const adapter of adapters) {
      await adapter.destroy();
    }
  }
}
