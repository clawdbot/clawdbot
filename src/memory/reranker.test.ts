import { describe, test, expect } from "vitest";
import { rerank, rerankRRF, type RerankerInput } from "./reranker.js";

describe("reranker", () => {
  describe("rerankRRF", () => {
    test("combines vector and keyword ranks", () => {
      const inputs: RerankerInput[] = [
        { id: "a", vectorRank: 1, keywordRank: 3 },
        { id: "b", vectorRank: 2, keywordRank: 1 },
        { id: "c", vectorRank: 3, keywordRank: 2 },
      ];

      const results = rerankRRF(inputs, 60);

      expect(results).toHaveLength(3);
      expect(results[0].rank).toBe(1);
      expect(results[1].rank).toBe(2);
      expect(results[2].rank).toBe(3);
      // All should have rrfScore defined
      expect(results.every((r) => r.rrfScore !== undefined)).toBe(true);
    });

    test("handles vector-only results", () => {
      const inputs: RerankerInput[] = [
        { id: "a", vectorRank: 1 },
        { id: "b", vectorRank: 2 },
      ];

      const results = rerankRRF(inputs);

      expect(results[0].id).toBe("a");
      expect(results[1].id).toBe("b");
    });

    test("handles keyword-only results", () => {
      const inputs: RerankerInput[] = [
        { id: "a", keywordRank: 2 },
        { id: "b", keywordRank: 1 },
      ];

      const results = rerankRRF(inputs);

      expect(results[0].id).toBe("b");
      expect(results[1].id).toBe("a");
    });

    test("item in both sources ranks higher than single-source", () => {
      const inputs: RerankerInput[] = [
        { id: "both", vectorRank: 2, keywordRank: 2 },
        { id: "vector-only", vectorRank: 1 },
        { id: "keyword-only", keywordRank: 1 },
      ];

      const results = rerankRRF(inputs, 60);

      // "both" should rank higher due to contributions from two sources
      expect(results[0].id).toBe("both");
    });

    test("returns empty array for empty input", () => {
      expect(rerankRRF([])).toEqual([]);
    });

    test("k parameter affects score distribution", () => {
      const inputs: RerankerInput[] = [
        { id: "a", vectorRank: 1 },
        { id: "b", vectorRank: 2 },
      ];

      const lowK = rerankRRF(inputs, 1);
      const highK = rerankRRF(inputs, 100);

      // With lower k, the score difference should be larger
      const lowKDiff = (lowK[0].rrfScore ?? 0) - (lowK[1].rrfScore ?? 0);
      const highKDiff = (highK[0].rrfScore ?? 0) - (highK[1].rrfScore ?? 0);
      expect(lowKDiff).toBeGreaterThan(highKDiff);
    });
  });

  describe("rerank", () => {
    test("method=none preserves input order", () => {
      const inputs: RerankerInput[] = [
        { id: "c", vectorRank: 3 },
        { id: "a", vectorRank: 1 },
        { id: "b", vectorRank: 2 },
      ];

      const results = rerank(inputs, { method: "none" });

      expect(results.map((r) => r.id)).toEqual(["c", "a", "b"]);
      expect(results.map((r) => r.rank)).toEqual([1, 2, 3]);
    });

    test("method=rrf applies RRF reranking", () => {
      const inputs: RerankerInput[] = [
        { id: "a", vectorRank: 2, keywordRank: 1 },
        { id: "b", vectorRank: 1, keywordRank: 2 },
      ];

      const results = rerank(inputs, { method: "rrf" });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.rrfScore !== undefined)).toBe(true);
    });

    test("respects custom k value", () => {
      const inputs: RerankerInput[] = [{ id: "a", vectorRank: 1 }];

      const result = rerank(inputs, { method: "rrf", rrf: { k: 10 } });

      // With k=10, score for rank 1 is 1/(10+1) = 0.0909...
      expect(result[0].rrfScore).toBeCloseTo(1 / 11, 4);
    });
  });
});
