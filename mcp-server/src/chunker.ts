/**
 * Splits markdown files into overlapping chunks for vector indexing.
 * Target: ~400 tokens per chunk, ~80 token overlap.
 * Approximation: 1 token ≈ 4 characters.
 */

// Named imports only. js-yaml 5 has no default export, and under this
// project's settings (module Node16, esModuleInterop) `import yaml from
// "js-yaml"` still type-checks — then fails at link time in real Node with
// "does not provide an export named 'default'", so the server would not start.
import { CORE_SCHEMA, boolYaml11Tag, load } from "js-yaml";

/**
 * Schema for READING frontmatter: YAML 1.2 core. Dates stay strings, and
 * `yes`/`no`/`on`/`off` are strings rather than booleans.
 */
export const FRONTMATTER_READ_SCHEMA = CORE_SCHEMA;

/**
 * Schema for WRITING frontmatter. Only used to decide when a string must be
 * quoted; it never changes what is written, only how.
 *
 * Plain CORE_SCHEMA writes `yes`, `no`, `on`, `off`, `y` and `n` unquoted,
 * because under YAML 1.2 they are strings. Memoria reads them back correctly,
 * but YAML 1.1 readers — PyYAML, and much of the tooling people point at a
 * directory of Markdown — read an unquoted `on` as `true`. js-yaml 4 quoted
 * them, so adding YAML 1.1's boolean tag restores that behaviour exactly.
 *
 * Do NOT add YAML 1.1's int or float tags in pursuit of fuller js-yaml 4
 * parity. `withTags` REPLACES core tags of the same name rather than adding
 * to them, so core-only forms stop being recognised as ambiguous: the string
 * "0o17" is then written bare and read back as the number 15, and "1e3" as
 * 1000. That is silent data corruption; the round-trip test in
 * chunker.test.ts exists to catch it.
 *
 * DUMP_SCHEMA is not used either: it quotes every date string
 * (`created: '2026-09-23'`), changing the look of every compiled memory
 * relative to the rest of the store for no gain in correctness.
 *
 * Measured against js-yaml 4 on 190 real frontmatter blocks: byte-identical
 * output for all of them. It still differs from js-yaml 4 on four strings —
 * "0b101" and sexagesimal times such as "12:30" — all of which round-trip
 * correctly through FRONTMATTER_READ_SCHEMA.
 */
export const FRONTMATTER_WRITE_SCHEMA = CORE_SCHEMA.withTags(boolYaml11Tag);

export interface Chunk {
  text: string;
  file: string;
  startLine: number;
  endLine: number;
}

const TARGET_CHARS = 1600; // ~400 tokens
const OVERLAP_CHARS = 320; // ~80 tokens

/**
 * Parse YAML frontmatter from a markdown file, returning metadata and body.
 * Uses js-yaml for proper YAML 1.2 parsing (handles quoted strings, escaped
 * colons, multi-line values, nested structures, etc.).
 */
export function parseFrontmatter(content: string): {
  metadata: Record<string, unknown>;
  body: string;
} {
  // Strip BOM and normalize line endings
  let normalized = content;
  if (normalized.charCodeAt(0) === 0xfeff) {
    normalized = normalized.slice(1);
  }
  normalized = normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { metadata: {}, body: normalized };

  let metadata: Record<string, unknown> = {};
  try {
    const parsed = load(match[1], { schema: FRONTMATTER_READ_SCHEMA });
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
      // Normalize Date objects (YAML auto-parses ISO dates) back to ISO strings.
      // The rest of the codebase treats date frontmatter values as strings.
      for (const [k, v] of Object.entries(metadata)) {
        if (v instanceof Date) {
          metadata[k] = v.toISOString().split("T")[0];
        } else if (Array.isArray(v)) {
          // Stringify Date entries inside arrays too
          metadata[k] = v.map((item) =>
            item instanceof Date ? item.toISOString().split("T")[0] : item,
          );
        }
      }
    }
  } catch (err) {
    // Malformed YAML — log to stderr but don't break the file
    process.stderr.write(`Memoria: frontmatter parse error: ${(err as Error).message}\n`);
  }

  return { metadata, body: match[2] };
}

/**
 * Split markdown content into overlapping chunks.
 */
export function chunkMarkdown(content: string, filePath: string): Chunk[] {
  const { body } = parseFrontmatter(content);
  const lines = body.split("\n");
  const chunks: Chunk[] = [];

  let currentChunk = "";
  let chunkStartLine = 1;
  let lineNum = 0;

  // Count newlines in the frontmatter region (not split-segments). Using
  // .split("\n").length over-counts by 1 for any string with content after
  // the last newline, which made search results report off-by-one line
  // numbers in indexes.
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n?/);
  const frontmatterLines = frontmatterMatch ? (frontmatterMatch[0].match(/\n/g) || []).length : 0;

  // A single line longer than a chunk (pasted logs, minified JSON, a long
  // paragraph without breaks) used to become one oversized chunk, which an
  // embedding API with a token limit rejects. Such lines are cut into
  // pieces at whitespace where possible; the pieces keep the line's number.
  const segments: Array<{ text: string; newLine: boolean }> = [];
  for (const line of lines) {
    if (line.length <= TARGET_CHARS) {
      segments.push({ text: line, newLine: true });
      continue;
    }
    let rest = line;
    let first = true;
    while (rest.length > TARGET_CHARS) {
      const space = rest.lastIndexOf(" ", TARGET_CHARS);
      const cut = space > TARGET_CHARS / 2 ? space : TARGET_CHARS;
      segments.push({ text: rest.slice(0, cut), newLine: first });
      rest = rest.slice(cut).replace(/^ /, "");
      first = false;
    }
    if (rest) segments.push({ text: rest, newLine: first });
  }

  for (const { text: line, newLine } of segments) {
    if (newLine) lineNum++;
    currentChunk += (currentChunk ? (newLine ? "\n" : " ") : "") + line;

    if (currentChunk.length >= TARGET_CHARS) {
      chunks.push({
        text: currentChunk.trim(),
        file: filePath,
        startLine: chunkStartLine + frontmatterLines,
        endLine: lineNum + frontmatterLines,
      });

      // Overlap: keep the last OVERLAP_CHARS worth of text
      const overlapText = currentChunk.slice(-OVERLAP_CHARS);
      const overlapLines = overlapText.split("\n").length;
      currentChunk = overlapText;
      chunkStartLine = lineNum - overlapLines + 1;
    }
  }

  // Final chunk
  if (currentChunk.trim()) {
    chunks.push({
      text: currentChunk.trim(),
      file: filePath,
      startLine: chunkStartLine + frontmatterLines,
      endLine: lineNum + frontmatterLines,
    });
  }

  return chunks;
}
