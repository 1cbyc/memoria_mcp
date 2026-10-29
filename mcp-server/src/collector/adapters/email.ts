/**
 * Email adapter — reads email via IMAP.
 * Works cross-platform. Uses the `imapflow` npm package.
 * Auto-installed when the user enables this source.
 */

import type { SourceAdapter, AdapterInfo, AdapterConfig, RawEvent } from "./base.js";
import { estimateImportance, classifyPrivacy } from "./base.js";
import { importDependency } from "../deps.js";

export class EmailAdapter implements SourceAdapter {
  readonly info: AdapterInfo = {
    id: "email",
    name: "Email (IMAP)",
    description:
      "Collects email subjects and summaries via IMAP. Supports Gmail, Outlook, iCloud, and any IMAP server.",
    platforms: ["macos", "linux", "windows"],
    dependencies: ["imapflow"],
    requiredPermissions: ["IMAP credentials (server, username, app password)"],
    builtIn: true,
    defaultConfig: {
      enabled: false,
      pollIntervalSec: 600, // 10 minutes
      importanceThreshold: 3,
      settings: {
        host: "",
        port: 993,
        secure: true,
        user: "",
        password: "", // stored encrypted
        mailbox: "INBOX",
        maxFetch: 50,
      },
    },
  };

  private client: any = null;
  private checkpoint: number = 0; // UID of last processed message
  // UIDs are only meaningful within one UIDVALIDITY. When the mailbox is
  // recreated, the server migrates, or the mailbox setting changes, a stale
  // high UID made "N:*" match only the newest message, which the cursor
  // then skipped: collection stopped silently.
  private uidValidity: string = "";
  private config!: AdapterConfig;

  async init(config: AdapterConfig): Promise<void> {
    this.config = config;

    const { host, user, password } = config.settings as Record<string, any>;

    if (!host || !user || !password) {
      throw new Error("Email adapter requires host, user, and password in settings.");
    }

    await this.connect();
  }

  /**
   * (Re)connect. imapflow does not reconnect on its own: once the server
   * drops an idle connection the client stays unusable, and every later
   * poll failed until the source was disabled and re-enabled.
   */
  private async connect(): Promise<void> {
    const { host, port, secure, user, password } = this.config.settings as Record<string, any>;
    if (this.client) {
      const stale = this.client;
      this.client = null;
      await Promise.resolve(stale.logout?.()).catch(() => {});
    }
    try {
      const { ImapFlow } = await importDependency<typeof import("imapflow")>("imapflow");
      const client = new ImapFlow({
        host,
        port: port ?? 993,
        secure: secure !== false,
        auth: { user, pass: password },
        logger: false,
      });
      // An 'error' event with no listener would crash the process.
      client.on?.("error", () => {});
      await client.connect();
      this.client = client;
    } catch (err: any) {
      throw new Error(
        `Email connection failed: ${err.message}. ` +
          "Check your IMAP credentials and ensure app-specific passwords are used for Gmail/iCloud.",
        { cause: err },
      );
    }
  }

  async poll(): Promise<RawEvent[]> {
    if (!this.config) return [];
    if (!this.client || this.client.usable === false) await this.connect();

    const mailbox = (this.config.settings?.mailbox as string) ?? "INBOX";
    const maxFetch = (this.config.settings?.maxFetch as number) ?? 50;

    const events: RawEvent[] = [];

    // Errors propagate: the daemon backs off, records the error, and
    // restores the cursor this poll advanced. Swallowing them here made a
    // dead connection look like an empty mailbox forever.
    try {
      const lock = await this.client.getMailboxLock(mailbox);

      try {
        const validity = String(this.client.mailbox?.uidValidity ?? "");
        if (validity && this.uidValidity && validity !== this.uidValidity) {
          process.stderr.write(
            `Memoria email: UIDVALIDITY of ${mailbox} changed; restarting from the newest message.\n`,
          );
          this.checkpoint = 0;
        }
        if (validity) this.uidValidity = validity;

        // Messages with a UID above the checkpoint. Ranges are only read as
        // UIDs when `uid: true` is in the options argument; in the fetch
        // query object it merely asks for the UID attribute. With no
        // checkpoint, "*" is the newest message: collection starts from now
        // rather than ingesting the whole mailbox.
        //
        // The new UIDs are found with UID SEARCH first and at most maxFetch
        // of them fetched. Fetching "N:*" directly downloaded headers and
        // 1KB of every newer message on each poll, however far behind the
        // cursor was, only to stop after maxFetch events.
        let range = "*";
        if (this.checkpoint > 0) {
          const found = (await this.client.search(
            { uid: `${this.checkpoint + 1}:*` },
            { uid: true },
          )) as number[] | false | undefined;
          // "N:*" also matches the newest message when nothing is newer.
          const fresh = (found || [])
            .filter((uid) => uid > this.checkpoint)
            .sort((a, b) => a - b)
            .slice(0, maxFetch);
          if (fresh.length === 0) return events;
          range = fresh.join(",");
        }

        for await (const message of this.client.fetch(
          range,
          {
            uid: true,
            envelope: true,
            bodyStructure: true,
            source: { maxBytes: 1024 }, // first 1KB of body only
          },
          { uid: true },
        )) {
          if (message.uid <= this.checkpoint && this.checkpoint > 0) continue;
          this.checkpoint = Math.max(this.checkpoint, message.uid);

          const env = message.envelope;
          if (!env) continue;

          const from = env.from?.[0]?.name ?? env.from?.[0]?.address ?? "unknown";
          const to = (env.to ?? []).map((t: any) => t.name ?? t.address).join(", ");

          const subject = env.subject ?? "(no subject)";
          const date = env.date ? new Date(env.date).toISOString() : new Date().toISOString();

          // Extract preview text from source (first 500 chars)
          let preview = "";
          if (message.source) {
            const bodyText = message.source.toString("utf-8");
            // Very basic: grab text after the headers
            const bodyStart = bodyText.indexOf("\r\n\r\n");
            if (bodyStart > -1) {
              preview = bodyText
                .slice(bodyStart + 4, bodyStart + 504)
                .replace(/[<>]/g, "")
                .replace(/\s+/g, " ")
                .trim();
            }
          }

          const content = preview ? `${subject} — ${preview.slice(0, 200)}` : subject;

          const meta: Record<string, unknown> = {
            from,
            to,
            subject,
            isAutomated: /no-?reply|automated|noreply|mailer-daemon/i.test(from),
          };

          const importance = estimateImportance(content, meta);
          if (importance < this.config.importanceThreshold) continue;

          const privacy = classifyPrivacy(content, meta);
          if (privacy === "local-only") continue; // never send sensitive email content

          events.push({
            id: `email-${message.uid}`,
            source: "email",
            eventType: "email_received",
            content: privacy === "summarize" ? `${subject} (from ${from})` : content,
            timestamp: date,
            meta,
            importanceEstimate: importance,
            privacyTier: privacy,
          });

          if (events.length >= maxFetch) break;
        }
      } finally {
        lock.release();
      }
    } catch (err: any) {
      // Force a fresh connection next time; the daemon handles the error.
      if (this.client && this.client.usable === false) this.client = null;
      throw new Error(`email poll failed: ${err.message}`, { cause: err });
    }

    return events;
  }

  getCheckpoint(): string {
    return this.uidValidity ? `${this.uidValidity}:${this.checkpoint}` : String(this.checkpoint);
  }

  /** "<uidvalidity>:<uid>", or a bare UID from before UIDVALIDITY was kept. */
  setCheckpoint(cursor: string): void {
    const sep = cursor.indexOf(":");
    this.uidValidity = sep === -1 ? "" : cursor.slice(0, sep);
    this.checkpoint = parseInt(sep === -1 ? cursor : cursor.slice(sep + 1), 10) || 0;
  }

  async destroy(): Promise<void> {
    if (this.client) {
      await this.client.logout().catch(() => {});
      this.client = null;
    }
  }
}
