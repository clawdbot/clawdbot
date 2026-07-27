// Memory Core tests cover MMR behavior through the production result adapter.
import { describe, expect, it } from "vitest";
import { applyMMRToHybridResults, DEFAULT_MMR_CONFIG } from "./mmr.js";
import { jaccardSimilarity, textSimilarity, tokenize } from "./tokenize.js";

describe("memory MMR", () => {
  it("tokenizes mixed ASCII and CJK text", () => {
    expect(tokenize("Hello 今天讨论 hello")).toEqual(
      new Set(["hello", "今", "天", "讨", "论", "今天", "天讨", "讨论"]),
    );
  });

  it("compares token sets and falls back to literal equality for empty token sets", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(textSimilarity("Привет мир", "Доброе утро")).toBe(0);
    expect(textSimilarity("🦞🦞", "🦞🦞")).toBe(1);
  });

  it("promotes a diverse result over a near duplicate", () => {
    const results = [
      {
        path: "/a.ts",
        startLine: 1,
        endLine: 10,
        score: 1,
        snippet: "function add numbers together",
        source: "memory",
      },
      {
        path: "/b.ts",
        startLine: 1,
        endLine: 10,
        score: 0.95,
        snippet: "function add values together",
        source: "memory",
      },
      {
        path: "/c.ts",
        startLine: 1,
        endLine: 10,
        score: 0.9,
        snippet: "database connection pool",
        source: "memory",
      },
    ];

    const reranked = applyMMRToHybridResults(results, { enabled: true, lambda: 0.5 });

    expect(reranked.map((result) => result.path)).toStrictEqual(["/a.ts", "/c.ts", "/b.ts"]);
  });

  it("keeps input order when disabled", () => {
    const results = [
      { path: "/a", startLine: 1, endLine: 1, score: 1, snippet: "same", source: "memory" },
      { path: "/b", startLine: 1, endLine: 1, score: 0.9, snippet: "same", source: "memory" },
    ];

    expect(applyMMRToHybridResults(results, { enabled: false })).toEqual(results);
    expect(DEFAULT_MMR_CONFIG).toEqual({ enabled: false, lambda: 0.7 });
  });
});
