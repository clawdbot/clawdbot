// Memory Core tests cover hybrid plugin behavior.
import { describe, expect, it } from "vitest";
import {
  bm25RankToScore,
  buildFtsQuery,
  mergeHybridResults,
  scoreExactPathTieForTemporalDecay,
} from "./hybrid.js";

describe("memory hybrid helpers", () => {
  it("buildFtsQuery tokenizes and AND-joins", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" AND "baz" AND "1"');
    expect(buildFtsQuery("金银价格")).toBe('"金银价格"');
    expect(buildFtsQuery("価格 2026年")).toBe('"価格" AND "2026年"');
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("bm25RankToScore is monotonic and clamped", () => {
    expect(bm25RankToScore(0)).toBeCloseTo(1);
    expect(bm25RankToScore(1)).toBeCloseTo(0.5);
    expect(bm25RankToScore(10)).toBeLessThan(bm25RankToScore(1));
    expect(bm25RankToScore(-100)).toBeCloseTo(1, 1);
  });

  it("bm25RankToScore preserves FTS5 BM25 relevance ordering", () => {
    const strongest = bm25RankToScore(-4.2);
    const middle = bm25RankToScore(-2.1);
    const weakest = bm25RankToScore(-0.5);

    expect(strongest).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(weakest);
    expect(strongest).not.toBe(middle);
    expect(middle).not.toBe(weakest);
  });

  it("bounds temporal exact-path tie scores to the identity and content bands", () => {
    expect(scoreExactPathTieForTemporalDecay(-1)).toBe(0.5);
    expect(scoreExactPathTieForTemporalDecay(0)).toBe(0.5);
    expect(scoreExactPathTieForTemporalDecay(0.5)).toBe(0.75);
    expect(scoreExactPathTieForTemporalDecay(2)).toBe(1);
  });

  it("mergeHybridResults unions by id and combines weighted scores", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.9,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "kw-b",
          textScore: 1,
        },
      ],
    });

    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.path === "memory/a.md");
    const b = merged.find((r) => r.path === "memory/b.md");
    expect(a?.score).toBeCloseTo(0.7 * 0.9);
    expect(a?.vectorScore).toBeCloseTo(0.9);
    expect(a?.textScore).toBe(0);
    expect(b?.score).toBeCloseTo(0.3 * 1);
    expect(b?.vectorScore).toBe(0);
    expect(b?.textScore).toBeCloseTo(1);
  });

  it("uses path BM25 only for partial path-only hybrid hits", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [],
      keyword: [
        {
          id: "partial-path",
          path: "memory/project-lantern-notes.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "unrelated body",
          textScore: 0,
          pathScore: 0.8,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.score).toBeCloseTo(0.3 * 0.8);
    expect(merged[0]?.textScore).toBe(0);
  });

  it("lets a fresh path-only exact hit beat stale content-backed retrieval", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      nowMs: Date.UTC(2026, 6, 11),
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      vector: [
        {
          id: "stale",
          path: "memory/2020-01-01.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "stale content-backed body",
          vectorScore: 1,
          exactPathSpecificity: 1,
        },
      ],
      keyword: [
        {
          id: "stale",
          path: "memory/2020-01-01.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "unrelated stale body",
          textScore: 0,
          pathScore: 1,
          exactPathSpecificity: 1,
        },
        {
          id: "fresh",
          path: "memory/2026-07-10.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "unrelated fresh body",
          textScore: 0,
          pathScore: 0.01,
          exactPathSpecificity: 1,
        },
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/2026-07-10.md",
      "memory/2020-01-01.md",
    ]);
    expect(merged.map((entry) => entry.score)).toEqual([1, 1]);
    expect(merged.every((entry) => entry.textScore === 0)).toBe(true);
  });

  it("ignores zero-weight and non-positive content when ordering exact hybrid hits", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 0,
      vector: [
        {
          id: "vector",
          path: "memory/z/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vector",
          vectorScore: -1,
          exactPathSpecificity: 2,
        },
      ],
      keyword: [
        {
          id: "body",
          path: "memory/y/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "body",
          textScore: 1,
          exactPathSpecificity: 2,
        },
        {
          id: "path",
          path: "memory/a/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "path",
          textScore: 0,
          pathScore: 1,
          exactPathSpecificity: 2,
        },
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/a/foo.md",
      "memory/y/foo.md",
      "memory/z/foo.md",
    ]);
  });

  it("uses net weighted content relevance for exact hybrid ordering", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 1,
      vector: [
        {
          id: "cancelled",
          path: "memory/z/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "negative vector",
          vectorScore: -1,
          exactPathSpecificity: 2,
        },
      ],
      keyword: [
        {
          id: "cancelled",
          path: "memory/z/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "weak body",
          textScore: 0.5,
          exactPathSpecificity: 2,
        },
        {
          id: "path",
          path: "memory/a/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "path only",
          textScore: 0,
          pathScore: 1,
          exactPathSpecificity: 2,
        },
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual(["memory/a/foo.md", "memory/z/foo.md"]);
  });

  it("keeps the full content-backed exact group ahead of path-only hits through MMR", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0,
      textWeight: 1,
      mmr: { enabled: true, lambda: 0.5 },
      vector: [],
      keyword: [
        {
          id: "body",
          path: "memory/z/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "body-backed result",
          textScore: 0.1,
          exactPathSpecificity: 2,
        },
        {
          id: "body-secondary",
          path: "memory/y/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "body-backed result",
          textScore: 0.05,
          exactPathSpecificity: 2,
        },
        {
          id: "path",
          path: "memory/a/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "path-only result",
          textScore: 0,
          pathScore: 1,
          exactPathSpecificity: 2,
        },
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/z/foo.md",
      "memory/y/foo.md",
      "memory/a/foo.md",
    ]);
  });

  it("keeps exact path identifiers ahead of weighted semantic matches", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "semantic",
          path: "memory/semantic.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "semantic",
          vectorScore: 0.99,
        },
      ],
      keyword: [
        {
          id: "exact-path",
          path: "memory/project-lantern.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "path",
          textScore: 0.01,
          exactPathSpecificity: 1,
        },
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/project-lantern.md",
      "memory/semantic.md",
    ]);
    expect(merged[0]?.score).toBe(1);
    expect(merged[0]?.textScore).toBe(0.01);
    expect(merged[1]?.score).toBeCloseTo(0.7 * 0.99);
  });

  it("keeps vector-only exact path candidates ahead of stronger semantic matches", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 1,
      vector: [
        {
          id: "semantic",
          path: "memory/semantic.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "semantic",
          vectorScore: 0.99,
        },
        {
          id: "exact-vector",
          path: "memory/deep/README.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "exact vector",
          vectorScore: 0.2,
          exactPathSpecificity: 2,
        },
      ],
      keyword: [],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/deep/README.md",
      "memory/semantic.md",
    ]);
    expect(merged[0]?.score).toBe(1);
    expect(merged[0]?.vectorScore).toBe(0.2);
  });

  it("uses specificity across exact tiers and combined relevance within one tier", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "full",
          path: "memory/full.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "full",
          vectorScore: 0,
        },
        {
          id: "basename-weak",
          path: "memory/a/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "basename weak",
          vectorScore: 0.2,
        },
        {
          id: "basename-strong",
          path: "memory/z/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "basename strong",
          vectorScore: 0.9,
        },
        {
          id: "stem",
          path: "memory/foo.md.bak",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "stem",
          vectorScore: 1,
        },
      ],
      keyword: [
        {
          id: "full",
          path: "memory/full.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "full",
          textScore: 0,
          exactPathSpecificity: 3,
        },
        {
          id: "basename-weak",
          path: "memory/a/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "basename weak",
          textScore: 0.1,
          pathScore: 1,
          exactPathSpecificity: 2,
        },
        {
          id: "basename-path-only",
          path: "memory/0/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "basename path only",
          textScore: 0,
          pathScore: 1,
          exactPathSpecificity: 2,
        },
        {
          id: "basename-strong",
          path: "memory/z/foo.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "basename strong",
          textScore: 0.8,
          pathScore: 0.01,
          exactPathSpecificity: 2,
        },
        {
          id: "stem",
          path: "memory/foo.md.bak",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "stem",
          textScore: 1,
          exactPathSpecificity: 1,
        },
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/full.md",
      "memory/z/foo.md",
      "memory/a/foo.md",
      "memory/0/foo.md",
      "memory/foo.md.bak",
    ]);
    expect(merged.map((entry) => entry.score)).toEqual([1, 1, 1, 1, 1]);
  });

  it("keeps exact path identifiers ahead after decay, oversized weights, and MMR", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 1,
      textWeight: 1,
      nowMs: Date.UTC(2026, 6, 11),
      temporalDecay: { enabled: true, halfLifeDays: 1 },
      mmr: { enabled: true, lambda: 0.5 },
      vector: [
        {
          id: "semantic",
          path: "memory/semantic.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "semantic neighbor",
          vectorScore: 1,
        },
      ],
      keyword: [
        {
          id: "semantic",
          path: "memory/semantic.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "semantic neighbor",
          textScore: 1,
        },
        {
          id: "exact-path",
          path: "memory/2020-01-01.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "dated exact path",
          textScore: 0.01,
          exactPathSpecificity: 1,
        },
      ],
    });

    expect(merged.map((entry) => entry.path)).toEqual([
      "memory/2020-01-01.md",
      "memory/semantic.md",
    ]);
    expect(merged[0]?.score).toBe(1);
    expect(merged[1]?.score).toBe(2);
  });

  it("mergeHybridResults prefers keyword snippet when ids overlap", async () => {
    const merged = await mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.2,
        },
      ],
      keyword: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 1,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
    expect(merged[0]?.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 1);
    expect(merged[0]?.vectorScore).toBeCloseTo(0.2);
    expect(merged[0]?.textScore).toBeCloseTo(1);
  });

  const vectorResult = (id: string, path: string, vectorScore: number) => ({
    id,
    path,
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: `vector ${id}`,
    vectorScore,
  });
  const keywordResult = (id: string, path: string, textScore: number) => ({
    id,
    path,
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet: `keyword ${id}`,
    textScore,
  });

  it("removes the text-weight discount only from vector-only non-text media", async () => {
    const paths = {
      vectorMedia: "memory/generated/photo.png",
      vectorText: "memory/notes.md",
      keywordMedia: "memory/clip.wav",
      bothMedia: "memory/matched.png",
      bothText: "memory/matched.md",
    };
    const merged = await mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      isNonTextMediaPath: (path) => /\.(?:png|wav)$/u.test(path),
      vector: [
        vectorResult("vector-media", paths.vectorMedia, 0.8),
        vectorResult("vector-text", paths.vectorText, 0.8),
        vectorResult("both-media", paths.bothMedia, 0.95),
        vectorResult("both-text", paths.bothText, 0.6),
      ],
      keyword: [
        keywordResult("keyword-media", paths.keywordMedia, 0.9),
        keywordResult("both-media", paths.bothMedia, 0.8),
        keywordResult("both-text", paths.bothText, 0.9),
      ],
    });
    const byPath = new Map(merged.map((entry) => [entry.path, entry]));

    expect(byPath.get(paths.vectorMedia)?.score).toBeCloseTo(0.8);
    expect(byPath.get(paths.vectorText)?.score).toBeCloseTo(0.7 * 0.8);
    expect(byPath.get(paths.keywordMedia)?.score).toBeCloseTo(0.3 * 0.9);
    expect(byPath.get(paths.bothMedia)?.score).toBeCloseTo(0.7 * 0.95 + 0.3 * 0.8);
    expect(byPath.get(paths.bothMedia)?.textScore).toBeCloseTo(0.8);
    expect(byPath.get(paths.bothText)?.score).toBeCloseTo(0.7 * 0.6 + 0.3 * 0.9);
  });

  it.each([
    {
      name: "keeps media keyword scoring when vector weight is zero",
      vectorWeight: 0,
      textWeight: 1,
      path: "memory/photo.png",
      vector: [vectorResult("candidate", "memory/photo.png", 0.95)],
      keyword: [keywordResult("candidate", "memory/photo.png", 0.8)],
      expected: 0.8,
    },
    {
      name: "keeps vector-only text scoring when weights total two",
      vectorWeight: 1,
      textWeight: 1,
      path: "memory/notes.md",
      vector: [vectorResult("candidate", "memory/notes.md", 0.6)],
      keyword: [],
      expected: 0.6,
    },
    {
      name: "keeps both-signal text scoring when weights total two",
      vectorWeight: 1,
      textWeight: 1,
      path: "memory/notes.md",
      vector: [vectorResult("candidate", "memory/notes.md", 0.6)],
      keyword: [keywordResult("candidate", "memory/notes.md", 0.9)],
      expected: 1.5,
    },
  ])("$name", async ({ vectorWeight, textWeight, path, vector, keyword, expected }) => {
    const merged = await mergeHybridResults({
      vectorWeight,
      textWeight,
      isNonTextMediaPath: (candidatePath) => candidatePath.endsWith(".png"),
      vector,
      keyword,
    });

    expect(merged.find((entry) => entry.path === path)?.score).toBeCloseTo(expected);
  });
});
