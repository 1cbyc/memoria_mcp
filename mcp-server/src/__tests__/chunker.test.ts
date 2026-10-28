import { describe, it, expect } from "vitest";
import { dump } from "js-yaml";
import { FRONTMATTER_WRITE_SCHEMA, parseFrontmatter, chunkMarkdown } from "../chunker.js";

describe("parseFrontmatter", () => {
  it("parses YAML frontmatter with string, number, and array values", () => {
    const content = `---
name: Test Memory
importance: 8
tags: [alpha, beta, gamma]
---

Body content here.`;

    const { metadata, body } = parseFrontmatter(content);
    expect(metadata.name).toBe("Test Memory");
    expect(metadata.importance).toBe(8);
    expect(metadata.tags).toEqual(["alpha", "beta", "gamma"]);
    expect(body.trim()).toBe("Body content here.");
  });

  it("returns empty metadata when no frontmatter present", () => {
    const content = "Just some plain text without frontmatter.";
    const { metadata, body } = parseFrontmatter(content);
    expect(metadata).toEqual({});
    expect(body).toBe(content);
  });

  it("strips BOM character", () => {
    const content = "\uFEFF---\nname: BOM test\n---\nContent";
    const { metadata } = parseFrontmatter(content);
    expect(metadata.name).toBe("BOM test");
  });

  it("normalizes CRLF line endings", () => {
    const content = "---\r\nname: CRLF\r\n---\r\nBody";
    const { metadata, body } = parseFrontmatter(content);
    expect(metadata.name).toBe("CRLF");
    expect(body).toBe("Body");
  });

  it("parses float numbers", () => {
    const content = "---\nscore: 7.5\n---\nBody";
    const { metadata } = parseFrontmatter(content);
    expect(metadata.score).toBe(7.5);
  });

  it("handles content with only frontmatter (empty body)", () => {
    const content = "---\nname: Empty\n---\n";
    const { metadata, body } = parseFrontmatter(content);
    expect(metadata.name).toBe("Empty");
    expect(body.trim()).toBe("");
  });

  it("handles colons in quoted values (proper YAML)", () => {
    const content = `---\ndescription: "Key: value pair inside"\n---\nBody`;
    const { metadata } = parseFrontmatter(content);
    expect(metadata.description).toBe("Key: value pair inside");
  });

  it("handles tags with special characters when quoted", () => {
    const content = `---\ntags: ["a, b", "c:d", "normal"]\n---\nBody`;
    const { metadata } = parseFrontmatter(content);
    expect(metadata.tags).toEqual(["a, b", "c:d", "normal"]);
  });

  it("preserves multi-line strings", () => {
    const content = `---\ndescription: |\n  line one\n  line two\n---\nBody`;
    const { metadata } = parseFrontmatter(content);
    expect(metadata.description).toBe("line one\nline two\n");
  });

  it("returns empty metadata for malformed YAML (does not throw)", () => {
    const content = `---\nname: [unclosed array\nimportance: 5\n---\nBody`;
    const { metadata, body } = parseFrontmatter(content);
    // js-yaml throws on this, we catch and return empty metadata
    expect(metadata).toEqual({});
    expect(body).toBe("Body");
  });

  it("normalizes Date objects (from auto-parsed ISO dates) to ISO strings", () => {
    const content = `---\ncreated: 2026-04-19\nupdated: 2026-04-20\n---\nBody`;
    const { metadata } = parseFrontmatter(content);
    expect(typeof metadata.created).toBe("string");
    expect(metadata.created).toBe("2026-04-19");
    expect(metadata.updated).toBe("2026-04-20");
  });

  it("normalizes dates inside arrays", () => {
    const content = `---\nmilestones: [2026-01-01, 2026-12-31]\n---\nBody`;
    const { metadata } = parseFrontmatter(content);
    expect(Array.isArray(metadata.milestones)).toBe(true);
    expect((metadata.milestones as string[]).every((d) => typeof d === "string")).toBe(true);
  });
});

describe("chunkMarkdown", () => {
  it("returns empty array for empty content", () => {
    const chunks = chunkMarkdown("", "test.md");
    expect(chunks).toEqual([]);
  });

  it("returns single chunk for small content", () => {
    const content = "---\nname: Small\n---\n\nA short memory.";
    const chunks = chunkMarkdown(content, "test.md");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].file).toBe("test.md");
    expect(chunks[0].text).toContain("short memory");
  });

  it("produces multiple chunks for large content", () => {
    const longParagraph = "Lorem ipsum dolor sit amet. ".repeat(200);
    const content = `---\nname: Large\n---\n\n${longParagraph}`;
    const chunks = chunkMarkdown(content, "big.md");
    expect(chunks.length).toBeGreaterThan(1);

    // Verify chunks have correct file reference
    for (const chunk of chunks) {
      expect(chunk.file).toBe("big.md");
      expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine);
    }
  });

  it("preserves correct line number offsets accounting for frontmatter", () => {
    const content = "---\nname: Lines\ntype: test\n---\n\nLine one.\nLine two.\nLine three.";
    const chunks = chunkMarkdown(content, "lines.md");
    expect(chunks).toHaveLength(1);
    // Frontmatter is 4 lines (---, name, type, ---), so body starts at line 5
    expect(chunks[0].startLine).toBeGreaterThanOrEqual(5);
  });
});

// Frontmatter written by the compile path (tools.ts, FRONTMATTER_WRITE_SCHEMA)
// is read back by parseFrontmatter (FRONTMATTER_READ_SCHEMA). Every string must
// survive that trip as the identical string. This is the property that breaks
// silently if someone "fixes" the write schema by adding YAML 1.1 int or float
// tags for closer js-yaml 4 parity: "0o17" comes back as 15, "1e3" as 1000.
describe("frontmatter write/read round trip", () => {
  const TRICKY = [
    "yes",
    "no",
    "on",
    "off",
    "y",
    "n",
    "Yes",
    "NO",
    "On",
    "true",
    "false",
    "True",
    "null",
    "Null",
    "~",
    "",
    " padded ",
    "007",
    "0o17",
    "0x1F",
    "0b101",
    "1_000",
    "1e3",
    "+12",
    "-0",
    "1.0",
    ".5",
    ".inf",
    "-.Inf",
    ".nan",
    "12:30",
    "12:30:45",
    "190:20:30",
    "2026-09-23",
    "2026-09-23T10:00:00Z",
    "has: colon",
    "# hash",
    "- dash",
    "@at",
    "*star",
    "&amp",
    "!bang",
    "%pct",
    "[flow]",
    "{map}",
    "a, b",
    "'quoted'",
    '"dq"',
    "café 日本語 🧠",
  ];

  // Mirrors how tools.ts assembles a compiled memory file.
  const roundTrip = (obj: Record<string, unknown>) =>
    parseFrontmatter(
      `---\n${dump(obj, { lineWidth: 200, schema: FRONTMATTER_WRITE_SCHEMA })}---\n\nbody`,
    ).metadata;

  it.each(TRICKY)("string %j survives as a scalar value", (s) => {
    expect(roundTrip({ v: s })).toEqual({ v: s });
  });

  it("every tricky string survives inside a tags array", () => {
    expect(roundTrip({ tags: TRICKY })).toEqual({ tags: TRICKY });
  });

  it("quotes YAML 1.1 boolean words so other YAML readers do not see booleans", () => {
    const out = dump(
      { a: "yes", b: "no", c: "on", d: "off" },
      { schema: FRONTMATTER_WRITE_SCHEMA },
    );
    expect(out).toBe("a: 'yes'\nb: 'no'\nc: 'on'\nd: 'off'\n");
  });

  it("leaves date strings unquoted, matching the rest of the store", () => {
    const out = dump({ created: "2026-09-23" }, { schema: FRONTMATTER_WRITE_SCHEMA });
    expect(out).toBe("created: 2026-09-23\n");
  });

  it("round-trips the exact shape the compile path writes", () => {
    const compiled = {
      name: "entity-acme",
      description: "Acme is a series-B fintech we work with: pricing, security review.",
      type: "reference",
      importance: 7,
      created: "2026-09-23",
      updated: "2026-09-23",
      last_accessed: "2026-09-23",
      access_count: 0,
      tags: ["acme", "on", "fintech"],
      origin: "compiled",
      related: ["project/acme-pricing.md"],
    };
    expect(roundTrip(compiled)).toEqual(compiled);
  });
});

describe("chunkMarkdown long lines (review 2026-10)", () => {
  it("splits a single line longer than a chunk, keeping its line number", () => {
    const words = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" "); // ~15KB, one line
    const content = `---\nname: x\n---\nfirst line\n${words}\nlast line`;
    const chunks = chunkMarkdown(content, "long.md");
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(2 * 1600);
    // Nothing is lost: every word appears in some chunk.
    const all = chunks.map((c) => c.text).join(" ");
    expect(all).toContain("word0");
    expect(all).toContain("word1999");
    expect(all).toContain("last line");
    // Pieces of the long line all report line 5 (frontmatter is 3 lines).
    expect(Math.max(...chunks.map((c) => c.endLine))).toBe(6);
  });

  it("cuts a line with no spaces at the chunk size", () => {
    const chunks = chunkMarkdown("x".repeat(10_000), "dense.md");
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(2 * 1600);
  });
});
