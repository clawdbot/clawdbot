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

  it("preserves the reference MMR ranking while caching running similarities", () => {
    // Reference implementation: recomputes max-similarity-to-selected from
    // scratch on every selection round (the pre-optimization behavior). The
    // production path must produce an identical ranking.
    type Ref = { id: string; score: number; content: string };
    const referenceMmrRerank = (items: Ref[], lambda: number): Ref[] => {
      const tokenCache = new Map(items.map((item) => [item.id, tokenize(item.content)]));
      const maxScore = Math.max(...items.map((item) => item.score));
      const minScore = Math.min(...items.map((item) => item.score));
      const scoreRange = maxScore - minScore;
      const selected: Ref[] = [];
      const remaining = new Set(items);

      while (remaining.size > 0) {
        let bestItem: Ref | null = null;
        let bestScore = -Infinity;
        for (const candidate of remaining) {
          let maxSimilarity = 0;
          for (const selectedItem of selected) {
            maxSimilarity = Math.max(
              maxSimilarity,
              jaccardSimilarity(tokenCache.get(candidate.id)!, tokenCache.get(selectedItem.id)!),
            );
          }
          const normalizedScore = scoreRange === 0 ? 1 : (candidate.score - minScore) / scoreRange;
          const score = lambda * normalizedScore - (1 - lambda) * maxSimilarity;
          if (
            score > bestScore ||
            (score === bestScore && candidate.score > (bestItem?.score ?? -Infinity))
          ) {
            bestItem = candidate;
            bestScore = score;
          }
        }
        if (!bestItem) {
          break;
        }
        selected.push(bestItem);
        remaining.delete(bestItem);
      }
      return selected;
    };

    const results = Array.from({ length: 24 }, (_, index) => ({
      path: `/doc-${index}.md`,
      startLine: index,
      endLine: index,
      score: 1 - index / 100,
      snippet: [
        `shared topic ${index % 5}`,
        index % 2 === 0 ? "alpha beta gamma" : "delta epsilon zeta",
        `distinct-${index}`,
      ].join(" "),
      source: "memory",
    }));

    for (const lambda of [0, 0.3, 0.5, 0.7, 0.95]) {
      const refItems: Ref[] = results.map((r) => ({
        id: r.path,
        score: r.score,
        content: r.snippet,
      }));
      const expected = referenceMmrRerank(refItems, lambda).map((item) => item.id);
      const actual = applyMMRToHybridResults(results, { enabled: true, lambda }).map((r) => r.path);
      expect(actual, `lambda=${lambda}`).toEqual(expected);
    }
  });
});
