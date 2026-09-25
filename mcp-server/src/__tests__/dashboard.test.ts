import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { JSDOM } from "jsdom";
import os from "os";
import path from "path";
import fs from "fs";

// dashboard.ts (via tools.ts) reads MEMORIA_DIR at load — point it at a temp dir.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-dash-"));
process.env.MEMORIA_DIR = ROOT;

let createDashboardRouter: (store: any) => any;
let MemoryStore: any;
let store: any;

beforeAll(async () => {
  fs.mkdirSync(path.join(ROOT, "memories"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  const s = await import("../store.js");
  MemoryStore = s.MemoryStore;
  store = new MemoryStore(path.join(ROOT, "data", "dash.sqlite"));
  const d = await import("../dashboard.js");
  createDashboardRouter = d.createDashboardRouter;
});

afterAll(() => {
  try {
    store?.close();
  } catch {}
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

/** Render the dashboard page ("/") by invoking the router with a mock req/res. */
function renderDashboard(): { html: string; headers: Record<string, string> } {
  const router = createDashboardRouter(store);
  let html = "";
  const headers: Record<string, string> = {};
  const req: any = { method: "GET", url: "/", headers: {} };
  const res: any = {
    send(s: string) {
      html = String(s);
      return res;
    },
    set(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    type() {
      return res;
    },
    status() {
      return res;
    },
    json() {
      return res;
    },
    end() {
      return res;
    },
  };
  router(req, res, (err?: any) => {
    if (err) throw err;
  });
  return { html, headers };
}

const SCRIPT_RE = /<script nonce="([^"]+)">([\s\S]*?)<\/script>/;

function clientScript(html: string): string {
  const m = html.match(SCRIPT_RE);
  expect(m).toBeTruthy();
  return (m as RegExpMatchArray)[2];
}

type FetchCall = { url: string; init?: RequestInit };

function dashboardDom(responseFor: (url: string, init?: RequestInit) => unknown): {
  dom: JSDOM;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const dom = new JSDOM(renderDashboard().html, {
    runScripts: "dangerously",
    url: "http://localhost/dashboard/",
    beforeParse(window) {
      window.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        return new Response(JSON.stringify(responseFor(url, init)), {
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
    },
  });
  return { dom, calls };
}

describe("dashboard page", () => {
  it("renders the page with the Wiki tab", () => {
    const { html } = renderDashboard();
    expect(html).toContain('data-tab="wiki"');
    expect(html).toMatch(SCRIPT_RE);
    expect(html).not.toContain("__CSP_NONCE__");
  });

  it("emits a syntactically valid client script (guards against quoting bugs)", () => {
    // new Function() COMPILES (not runs) the body — throws SyntaxError on bad
    // syntax (e.g. a single quote that closes a JS string early). It would have
    // caught the `onkeyup="...'Enter'..."` regression.
    expect(() => new Function(clientScript(renderDashboard().html))).not.toThrow();
  });
});

describe("dashboard XSS defences (2026-09 review, H2)", () => {
  it("sends a CSP whose script nonce matches the page's one script, fresh per response", () => {
    const a = renderDashboard();
    const b = renderDashboard();
    const nonce = (a.html.match(SCRIPT_RE) as RegExpMatchArray)[1];
    const csp = a.headers["content-security-policy"];
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect((b.html.match(SCRIPT_RE) as RegExpMatchArray)[1]).not.toBe(nonce);
  });

  it("has no inline event-handler attributes, in the markup or in HTML the script builds", () => {
    // The CSP blocks them, so one would be a silently dead button — and they
    // are exactly what an attribute breakout would inject.
    expect(renderDashboard().html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
  });

  it("every data-action in the page has a handler, and every handler is used", () => {
    const { html } = renderDashboard();
    const used = new Set([...html.matchAll(/data-action="([a-z-]+)"/g)].map((m) => m[1]));
    const block = html.match(/const ACTIONS = \{([\s\S]*?)\n\};/);
    expect(block).toBeTruthy();
    const defined = new Set(
      [...(block as RegExpMatchArray)[1].matchAll(/^\s*'([a-z-]+)':/gm)].map((m) => m[1]),
    );
    expect([...used].sort()).toEqual([...defined].sort());
  });

  it("every element the script binds at load exists in the static markup", () => {
    // A top-level getElementById(...).addEventListener on a missing id throws
    // on page load and takes every handler after it down with it.
    const { html } = renderDashboard();
    const markup = html.slice(0, html.search(SCRIPT_RE));
    const bound = [...clientScript(html).matchAll(/^document\.getElementById\('([\w-]+)'\)/gm)];
    expect(bound.length).toBeGreaterThanOrEqual(3);
    for (const [, id] of bound) expect(markup).toContain(`id="${id}"`);
  });

  it("the client escapeHtml escapes all five characters, quotes included", () => {
    // Run the page's own escaper, not a copy of it.
    const script = clientScript(renderDashboard().html);
    const src = script.match(
      /const HTML_ESCAPES = [^\n]*\nfunction escapeHtml\(s\) \{[\s\S]*?\n\}/,
    );
    expect(src).toBeTruthy();
    const escapeHtml = new Function(`${(src as RegExpMatchArray)[0]}; return escapeHtml;`)();
    expect(escapeHtml(`"><img src=x>'&`)).toBe("&quot;&gt;&lt;img src=x&gt;&#39;&amp;");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(0)).toBe("0");
  });
});

describe("dashboard browser interactions", () => {
  it("round-trips an escaped wiki filename through rendering and the click request", async () => {
    const file = 'projects/a"<b>.md';
    const { dom, calls } = dashboardDom((url) => {
      if (url.endsWith("/wiki/index")) {
        return { categories: { projects: [{ file, name: "Quoted project" }] }, daily: [] };
      }
      if (url.includes("/memory?file=")) {
        return { file, meta: {}, html: "<p>Loaded</p>", related: [], backlinks: [] };
      }
      if (url.endsWith("/collector/status")) return { running: false };
      return [];
    });

    const wikiTab = dom.window.document.querySelector<HTMLElement>('[data-tab="wiki"]');
    wikiTab?.click();
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector('[data-action="open-wiki"]')).not.toBeNull();
    });

    const link = dom.window.document.querySelector<HTMLElement>('[data-action="open-wiki"]');
    expect(link?.dataset.file).toBe(file);
    link?.click();

    await vi.waitFor(() => {
      expect(
        calls.some((call) => call.url === `/dashboard/api/memory?file=${encodeURIComponent(file)}`),
      ).toBe(true);
      expect(dom.window.document.querySelector("#wiki-page")?.textContent).toContain("Loaded");
    });
    await vi.waitFor(() => {
      expect(dom.window.document.querySelector("#recent-journal")?.textContent).toContain(
        "No journal entries yet",
      );
    });
    dom.window.close();
  });

  it("posts the selected journal mood and parsed tags", async () => {
    const { dom, calls } = dashboardDom((url, init) => {
      if (url.endsWith("/journal") && init?.method === "POST") return { success: true };
      if (url.endsWith("/collector/status")) return { running: false };
      return [];
    });

    dom.window.document.querySelector<HTMLElement>('[data-mood="good"]')?.click();
    const entry = dom.window.document.querySelector<HTMLTextAreaElement>("#journal-input");
    const tags = dom.window.document.querySelector<HTMLInputElement>("#journal-tags");
    if (entry) entry.value = "A useful note";
    if (tags) tags.value = "work, follow-up";
    dom.window.document.querySelector<HTMLElement>('[data-action="save-journal"]')?.click();

    await vi.waitFor(() => {
      expect(
        calls.some((call) => call.url.endsWith("/journal") && call.init?.method === "POST"),
      ).toBe(true);
    });
    const request = calls.find(
      (call) => call.url.endsWith("/journal") && call.init?.method === "POST",
    );
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      entry: "A useful note",
      mood: "good",
      tags: ["work", "follow-up"],
    });
    await vi.waitFor(() => {
      expect(entry?.value).toBe("");
      expect(dom.window.document.querySelector("#journal-history")?.textContent).toContain(
        "No entries yet",
      );
      expect(dom.window.document.querySelector("#recent-journal")?.textContent).toContain(
        "No journal entries yet",
      );
    });
    dom.window.close();
  });
});

describe("POST /api/journal input validation (2026-09 review, L8/L9)", () => {
  async function post(body: unknown) {
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const app = express();
    app.use(express.json());
    app.use("/", createDashboardRouter(store));
    return request(app).post("/api/journal").send(body);
  }

  it("rejects a mood the picker cannot produce", async () => {
    const r = await post({ entry: "x", mood: "good)\n## 00:00 — forged" });
    expect(r.status).toBe(400);
  });

  it("rejects tags that are not an array of short one-line strings", async () => {
    expect((await post({ entry: "x", tags: "not-an-array" })).status).toBe(400);
    expect((await post({ entry: "x", tags: ["ok", "two\nlines"] })).status).toBe(400);
    expect((await post({ entry: "x", tags: ["x".repeat(51)] })).status).toBe(400);
    expect((await post({ entry: "x", tags: Array(21).fill("t") })).status).toBe(400);
  });

  it("accepts a valid entry and labels it in UTC, matching the file's UTC date", async () => {
    const r = await post({ entry: "valid entry", mood: "good", tags: ["a", "b"] });
    expect(r.status).toBe(200);
    const file = path.join(ROOT, "memories", "daily", `${r.body.date}.md`);
    const text = fs.readFileSync(file, "utf-8");
    expect(text).toMatch(/## \d{2}:\d{2} UTC — Journal \(good\)\n\nvalid entry\n\*Tags: a, b\*/);
  });
});
