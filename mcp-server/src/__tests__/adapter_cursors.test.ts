/**
 * Adapter cursors (review 2026-10): each adapter must advance its cursor only
 * past what it actually returned, and surface failures to the daemon instead
 * of reporting "nothing new". The external services are faked at the client
 * boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

// ── IMAP ────────────────────────────────────────────────────

interface FakeMessage {
  uid: number;
  seq: number;
}

const imap = {
  instances: [] as any[],
  messages: [] as FakeMessage[],
  fetchCalls: [] as Array<{ range: string; query: any; options: any }>,
  failLock: false,
  uidValidity: 1,
};

class FakeImapFlow {
  usable = false;
  mailbox: { uidValidity: number } | false = false;
  constructor(public opts: any) {
    imap.instances.push(this);
  }
  on() {
    return this;
  }
  async connect() {
    this.usable = true;
  }
  async logout() {
    this.usable = false;
  }
  async getMailboxLock() {
    if (imap.failLock) throw new Error("connection not available");
    this.mailbox = { uidValidity: imap.uidValidity };
    return { release() {} };
  }
  // Mirrors IMAP: "N:*" by UID when options.uid, else by sequence number;
  // "*" alone is the newest message.
  async *fetch(range: string, query: any, options: any = {}) {
    imap.fetchCalls.push({ range, query, options });
    const key = options.uid ? "uid" : "seq";
    const sorted = [...imap.messages].sort((a, b) => a[key] - b[key]);
    let selected: FakeMessage[];
    if (range === "*") selected = sorted.slice(-1);
    else {
      const from = parseInt(range, 10);
      selected = sorted.filter((m) => m[key] >= from);
      if (selected.length === 0) selected = sorted.slice(-1); // "*" always matches
    }
    for (const m of selected) {
      yield {
        uid: m.uid,
        envelope: { from: [{ name: "Alice" }], to: [], subject: `Project update ${m.uid}` },
        source: Buffer.from(`Header: x\r\n\r\nWe decided to ship the release on Friday.`),
      };
    }
  }
}

vi.mock("../collector/deps.js", () => ({
  importDependency: async (name: string) => {
    if (name === "imapflow") return { ImapFlow: FakeImapFlow };
    throw new Error(`unexpected dependency ${name}`);
  },
}));

const { EmailAdapter } = await import("../collector/adapters/email.js");
const { GoogleGmailAdapter } = await import("../collector/adapters/google-gmail.js");
const { CalendarAdapter } = await import("../collector/adapters/calendar.js");

function emailConfig() {
  return {
    enabled: true,
    pollIntervalSec: 600,
    importanceThreshold: 1,
    settings: { host: "imap.example.com", user: "u", password: "p", maxFetch: 50 },
  };
}

beforeEach(() => {
  imap.instances = [];
  imap.fetchCalls = [];
  imap.failLock = false;
  imap.uidValidity = 1;
  // A long-lived mailbox: UIDs far above sequence numbers.
  imap.messages = Array.from({ length: 5 }, (_, i) => ({ uid: 120_000 + i, seq: 4_996 + i }));
});

describe("EmailAdapter", () => {
  it("fetches by UID, so a stored UID cursor resumes at the right message", async () => {
    const a = new EmailAdapter();
    await a.init(emailConfig());
    a.setCheckpoint("120001");
    const events = await a.poll();
    expect(imap.fetchCalls[0].range).toBe("120002:*");
    expect(imap.fetchCalls[0].options).toEqual({ uid: true });
    expect(events.map((e) => e.id)).toEqual(["email-120002", "email-120003", "email-120004"]);
    expect(a.getCheckpoint()).toBe("1:120004");
  });

  it("restarts from the newest message when UIDVALIDITY changes", async () => {
    const a = new EmailAdapter();
    await a.init(emailConfig());
    a.setCheckpoint("1:999999"); // a UID from the mailbox's previous life
    imap.uidValidity = 2;
    const events = await a.poll();
    expect(events.map((e) => e.id)).toEqual(["email-120004"]);
    expect(a.getCheckpoint()).toBe("2:120004");
  });

  it("starts from the newest message when there is no cursor", async () => {
    const a = new EmailAdapter();
    await a.init(emailConfig());
    const events = await a.poll();
    expect(events.map((e) => e.id)).toEqual(["email-120004"]);
    expect(a.getCheckpoint()).toBe("1:120004");
    // Nothing new: the "*" match on the newest message is not re-emitted.
    expect(await a.poll()).toEqual([]);
  });

  it("reconnects when the connection was dropped", async () => {
    const a = new EmailAdapter();
    await a.init(emailConfig());
    imap.instances[0].usable = false; // server closed the idle connection
    a.setCheckpoint("120003");
    const events = await a.poll();
    expect(imap.instances).toHaveLength(2);
    expect(events.map((e) => e.id)).toEqual(["email-120004"]);
  });

  it("throws on a failed poll instead of reporting an empty mailbox", async () => {
    const a = new EmailAdapter();
    await a.init(emailConfig());
    imap.failLock = true;
    await expect(a.poll()).rejects.toThrow(/email poll failed/);
  });
});

// ── Gmail ───────────────────────────────────────────────────

function fakeGmail(pages: Array<{ history: any[]; nextPageToken?: string }>, current = "900") {
  const fetched: string[] = [];
  const gmail = {
    users: {
      history: {
        list: vi.fn(
          async ({ pageToken, startHistoryId }: { pageToken?: string; startHistoryId: string }) => {
            const page = pages[pageToken ? parseInt(pageToken, 10) : 0];
            // startHistoryId is exclusive, as in the Gmail API.
            const history = page.history.filter((r) => Number(r.id) > Number(startHistoryId));
            return { data: { ...page, history, historyId: current } };
          },
        ),
      },
      messages: {
        get: vi.fn(async ({ id }: { id: string }) => {
          fetched.push(id);
          return {
            data: {
              snippet: "We decided to ship the release on Friday",
              labelIds: ["INBOX"],
              payload: {
                headers: [
                  { name: "From", value: "Alice <alice@example.com>" },
                  { name: "Subject", value: `Project update ${id}` },
                  { name: "Date", value: "Mon, 26 Oct 2026 10:00:00 +0000" },
                ],
              },
            },
          };
        }),
      },
      getProfile: vi.fn(async () => ({ data: { historyId: current } })),
    },
  };
  return { gmail, fetched };
}

function record(id: number, ...msgIds: string[]) {
  return {
    id: String(id),
    messagesAdded: msgIds.map((m) => ({ message: { id: m, labelIds: [] } })),
  };
}

function gmailAdapter(gmail: any, maxResults: number) {
  const a = new GoogleGmailAdapter();
  (a as any).gmail = gmail;
  (a as any).config = {
    enabled: true,
    pollIntervalSec: 300,
    importanceThreshold: 1,
    settings: { labels: ["INBOX"], excludeLabels: [], maxResults },
  };
  a.setCheckpoint("100");
  return a;
}

describe("GoogleGmailAdapter history cursor", () => {
  it("does not skip messages beyond one batch: the cursor stops at the last record taken", async () => {
    const { gmail, fetched } = fakeGmail([
      { history: [record(101, "m1", "m2"), record(102, "m3")], nextPageToken: "1" },
      { history: [record(103, "m4"), record(104, "m5")] },
    ]);
    const a = gmailAdapter(gmail, 3);
    await a.poll();
    expect(fetched).toEqual(["m1", "m2", "m3"]);
    // Not the mailbox's current id (900): records 103-104 are still pending.
    expect(a.getCheckpoint()).toBe("102");
  });

  it("the next poll resumes exactly where the previous batch stopped", async () => {
    const { gmail, fetched } = fakeGmail([
      {
        history: [record(101, "m1", "m2"), record(102, "m3"), record(103, "m4"), record(104, "m5")],
      },
    ]);
    const a = gmailAdapter(gmail, 3);
    await a.poll();
    expect(a.getCheckpoint()).toBe("102");
    await a.poll();
    expect(fetched).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(a.getCheckpoint()).toBe("900");
  });

  it("jumps to the mailbox's current history id once everything was read", async () => {
    const { gmail, fetched } = fakeGmail([
      { history: [record(101, "m1")], nextPageToken: "1" },
      { history: [record(102, "m2")] },
    ]);
    const a = gmailAdapter(gmail, 50);
    await a.poll();
    expect(fetched).toEqual(["m1", "m2"]);
    expect(a.getCheckpoint()).toBe("900");
  });

  it("a failed message fetch fails the poll (the daemon restores the cursor)", async () => {
    const { gmail } = fakeGmail([{ history: [record(101, "m1")] }]);
    gmail.users.messages.get = vi.fn(async () => {
      throw Object.assign(new Error("rate limited"), { code: 429 });
    });
    const a = gmailAdapter(gmail, 50);
    await expect(a.poll()).rejects.toThrow(/rate limited/);
  });

  it("skips a message deleted since its history record (404)", async () => {
    const { gmail } = fakeGmail([{ history: [record(101, "m1")] }]);
    gmail.users.messages.get = vi.fn(async () => {
      throw Object.assign(new Error("not found"), { code: 404 });
    });
    const a = gmailAdapter(gmail, 50);
    expect(await a.poll()).toEqual([]);
    expect(a.getCheckpoint()).toBe("900");
  });
});

// ── macOS Calendar ──────────────────────────────────────────

const CORE_DATA_EPOCH = 978307200;
const nowCore = () => Date.now() / 1000 - CORE_DATA_EPOCH;

function calendarDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE ZCALENDAR (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT);
    CREATE TABLE ZCALENDARITEM (Z_PK INTEGER PRIMARY KEY, ZSTARTDATE REAL, ZENDDATE REAL,
      ZSUMMARY TEXT, ZLOCATION TEXT, ZNOTES TEXT, ZALLDAY INTEGER, ZMODIFIEDDATE REAL,
      ZCALENDAR INTEGER);
    INSERT INTO ZCALENDAR VALUES (1, 'Work');
  `);
  return db;
}

function addEvent(
  db: Database.Database,
  title: string,
  startInHours: number,
  modified: number | null,
): number {
  const start = nowCore() + startInHours * 3600;
  return Number(
    db
      .prepare(
        `INSERT INTO ZCALENDARITEM (ZSTARTDATE, ZENDDATE, ZSUMMARY, ZALLDAY, ZMODIFIEDDATE, ZCALENDAR)
         VALUES (?, ?, ?, 0, ?, 1)`,
      )
      .run(start, start + 3600, title, modified).lastInsertRowid,
  );
}

function calendarAdapter(db: Database.Database, lookAheadDays = 7) {
  const a = new CalendarAdapter();
  (a as any).db = db;
  (a as any).config = {
    enabled: true,
    pollIntervalSec: 300,
    importanceThreshold: 1,
    settings: { lookAheadDays },
  };
  return a;
}

const titles = (events: Array<{ content: string }>) => events.map((e) => e.content).sort();

describe("CalendarAdapter collection", () => {
  it("the first poll returns the window, including never-modified events", async () => {
    const db = calendarDb();
    addEvent(db, "Planning meeting A", 2, null);
    addEvent(db, "Planning meeting B", 3, nowCore() - 600);
    expect(titles(await calendarAdapter(db).poll())).toEqual([
      "Planning meeting A",
      "Planning meeting B",
    ]);
  });

  it("collects each event once, and again when it is edited", async () => {
    const db = calendarDb();
    const id = addEvent(db, "Planning meeting", 2, nowCore() - 600);
    const a = calendarAdapter(db);
    expect(await a.poll()).toHaveLength(1);
    expect(await a.poll()).toEqual([]);
    db.prepare("UPDATE ZCALENDARITEM SET ZSUMMARY = ?, ZMODIFIEDDATE = ? WHERE Z_PK = ?").run(
      "Planning meeting moved",
      nowCore(),
      id,
    );
    expect(titles(await a.poll())).toEqual(["Planning meeting moved"]);
  });

  it("collects an event created later with no modification date", async () => {
    // The modification-date cursor could never see these after the first poll.
    const db = calendarDb();
    addEvent(db, "Planning meeting A", 2, nowCore() - 600);
    const a = calendarAdapter(db);
    await a.poll();
    addEvent(db, "Planning meeting B", 5, null);
    expect(titles(await a.poll())).toEqual(["Planning meeting B"]);
  });

  it("collects an event created long ago once it enters the look-ahead window", async () => {
    const db = calendarDb();
    addEvent(db, "Planning offsite", 24 * 20, nowCore() - 86400 * 30); // 20 days out
    const a = calendarAdapter(db, 7);
    expect(await a.poll()).toEqual([]);
    // Time passes: simulate by widening the window to where "now" will be.
    (a as any).config.settings.lookAheadDays = 21;
    expect(titles(await a.poll())).toEqual(["Planning offsite"]);
  });

  it("collects every event of a busy window in one poll, with no tie rules", async () => {
    const db = calendarDb();
    const t = nowCore() - 100_000 + 0.123456; // one shared, fractional modification time
    for (let i = 0; i < 600; i++) addEvent(db, `Planning meeting ${i}`, 1 + i / 100, t);
    const a = calendarAdapter(db);
    expect(await a.poll()).toHaveLength(600);
    expect(await a.poll()).toEqual([]);
  });

  it("upgrading from a modification-date cursor emits only what changed since it", async () => {
    const db = calendarDb();
    addEvent(db, "Planning meeting old", 2, nowCore() - 86400);
    addEvent(db, "Planning meeting new", 3, nowCore() - 60);
    const a = calendarAdapter(db);
    a.setCheckpoint(new Date(Date.now() - 3600_000).toISOString()); // a v1 cursor
    expect(titles(await a.poll())).toEqual(["Planning meeting new"]);
    expect(a.getCheckpoint()).toMatch(/^v2:/);
    expect(await a.poll()).toEqual([]);
  });

  it("the checkpoint round-trips, and a restored one suppresses re-collection", async () => {
    const db = calendarDb();
    addEvent(db, "Planning meeting", 2, null);
    const a = calendarAdapter(db);
    await a.poll();
    const b = calendarAdapter(db);
    b.setCheckpoint(a.getCheckpoint());
    expect(await b.poll()).toEqual([]);
  });

  it("throws on a query error instead of returning an empty calendar", async () => {
    const db = new Database(":memory:"); // no tables: a schema mismatch
    await expect(calendarAdapter(db).poll()).rejects.toThrow();
  });
});
