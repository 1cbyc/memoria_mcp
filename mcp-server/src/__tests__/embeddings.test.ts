import { describe, it, expect } from "vitest";
import { embed, embedBatch, cosineSimilarity, getDimension } from "../embeddings.js";

// These tests all use the local n-gram provider (no OPENAI_API_KEY set)

describe("embeddings (local n-gram)", () => {
  it("returns a Float32Array of the correct dimension", async () => {
    const vec = await embed("hello world");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(getDimension());
  });

  it("produces L2-normalized vectors (magnitude ~1.0)", async () => {
    const vec = await embed("test embedding normalization");
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 2);
  });

  it("returns similar vectors for similar text", async () => {
    const a = await embed("the cat sat on the mat");
    const b = await embed("the cat sat on the rug");
    const c = await embed("quantum physics research paper");
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const vec = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("handles zero vectors gracefully", () => {
    const zero = new Float32Array([0, 0, 0]);
    const nonzero = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(zero, nonzero)).toBe(0);
  });
});

describe("embedBatch", () => {
  it("returns correct number of vectors", async () => {
    const texts = ["hello", "world", "test"];
    const results = await embedBatch(texts);
    expect(results).toHaveLength(3);
    for (const vec of results) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(getDimension());
    }
  });

  it("returns empty array for empty input", async () => {
    const results = await embedBatch([]);
    expect(results).toEqual([]);
  });

  it("handles non-ASCII/Unicode text", async () => {
    const vec = await embed("日本語テスト données françaises");
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(getDimension());
    // Should still be normalized
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 2);
  });
});

describe("lexical embedding keeps non-ASCII text (review 2026-10)", () => {
  it("embeds CJK, Cyrillic and Greek text as non-zero, distinguishable vectors", async () => {
    const texts = ["東京の会議は金曜日です", "Встреча в пятницу", "Συνάντηση την Παρασκευή"];
    const vecs = await Promise.all(texts.map((t) => embed(t)));
    for (const v of vecs) expect(v.some((x) => x !== 0)).toBe(true);
    expect(cosineSimilarity(vecs[1], await embed("Встреча в пятницу"))).toBeGreaterThan(0.99);
    expect(cosineSimilarity(vecs[1], vecs[2])).toBeLessThan(0.5);
  });
});

describe("lexical embedding keeps combining marks (re-review 2026-10)", () => {
  it("embeds composed and decomposed text alike, and keeps vowel signs", async () => {
    const nfc = await embed("résumé review");
    const nfd = await embed("résumé review");
    expect(cosineSimilarity(nfc, nfd)).toBeGreaterThan(0.99);
    const a = await embed("किताब मेज़ पर है");
    const b = await embed("कतब मज पर ह"); // the same with its marks stripped
    expect(cosineSimilarity(a, b)).toBeLessThan(0.9);
  });
});
