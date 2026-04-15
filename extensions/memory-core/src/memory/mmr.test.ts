import { describe, it, expect } from "vitest";
import {
  tokenize,
  jaccardSimilarity,
  textSimilarity,
  computeMMRScore,
  mmrRerank,
  applyMMRToHybridResults,
  DEFAULT_MMR_CONFIG,
  type MMRItem,
} from "./mmr.js";

describe("tokenize", () => {
  it("normalizes, filters, and deduplicates token sets", () => {
    const cases = [
      {
        name: "alphanumeric lowercase",
        input: "Hello World 123",
        expected: ["hello", "world", "123"],
      },
      { name: "empty string", input: "", expected: [] },
      { name: "special chars only", input: "!@#$%^&*()", expected: [] },
      {
        name: "underscores",
        input: "hello_world test_case",
        expected: ["hello_world", "test_case"],
      },
      {
        name: "dedupe repeated tokens",
        input: "hello hello world world",
        expected: ["hello", "world"],
      },
      {
        name: "CJK characters produce unigrams and bigrams",
        input: "今天讨论",
        expected: ["今", "天", "讨", "论", "今天", "天讨", "讨论"],
      },
      {
        name: "mixed ASCII and CJK",
        input: "hello 你好世界 test",
        expected: ["hello", "test", "你", "好", "世", "界", "你好", "好世", "世界"],
      },
      {
        name: "single CJK character (no bigrams)",
        input: "龙",
        expected: ["龙"],
      },
      {
        name: "non-adjacent CJK chars do not form bigrams",
        input: "我a好",
        expected: ["a", "我", "好"],
        // No "我好" bigram — they are separated by "a"
      },
      {
        name: "Japanese hiragana",
        input: "こんにちは",
        expected: ["こ", "ん", "に", "ち", "は", "こん", "んに", "にち", "ちは"],
      },
      {
        name: "Korean hangul",
        input: "안녕하세요",
        expected: ["안", "녕", "하", "세", "요", "안녕", "녕하", "하세", "세요"],
      },
    ] as const;

    for (const testCase of cases) {
      expect(tokenize(testCase.input), testCase.name).toEqual(new Set(testCase.expected));
    }
  });
});

describe("jaccardSimilarity", () => {
  it("computes expected scores for overlap edge cases", () => {
    const cases = [
      {
        name: "identical sets",
        left: new Set(["a", "b", "c"]),
        right: new Set(["a", "b", "c"]),
        expected: 1,
      },
      { name: "disjoint sets", left: new Set(["a", "b"]), right: new Set(["c", "d"]), expected: 0 },
      { name: "two empty sets", left: new Set<string>(), right: new Set<string>(), expected: 1 },
      {
        name: "left non-empty right empty",
        left: new Set(["a"]),
        right: new Set<string>(),
        expected: 0,
      },
      {
        name: "left empty right non-empty",
        left: new Set<string>(),
        right: new Set(["a"]),
        expected: 0,
      },
      {
        name: "partial overlap",
        left: new Set(["a", "b", "c"]),
        right: new Set(["b", "c", "d"]),
        expected: 0.5,
      },
    ] as const;

    for (const testCase of cases) {
      expect(jaccardSimilarity(testCase.left, testCase.right), testCase.name).toBe(
        testCase.expected,
      );
    }
  });

  it("is symmetric", () => {
    const setA = new Set(["a", "b"]);
    const setB = new Set(["b", "c"]);
    expect(jaccardSimilarity(setA, setB)).toBe(jaccardSimilarity(setB, setA));
  });
});

describe("textSimilarity", () => {
  it("computes expected text-level similarity cases", () => {
    const cases = [
      { name: "identical", left: "hello world", right: "hello world", expected: 1 },
      { name: "same words reordered", left: "hello world", right: "world hello", expected: 1 },
      { name: "different text", left: "hello world", right: "foo bar", expected: 0 },
      { name: "case insensitive", left: "Hello World", right: "hello world", expected: 1 },
      {
        name: "CJK similar texts share tokens",
        left: "今天我们讨论了项目进展",
        right: "今天我们讨论了会议安排",
        // Shared unigrams: 今,天,我,们,讨,论,了 (7) + shared bigrams: 今天,天我,我们,们讨,讨论,论了 (6) = 13 shared
        // Total unique tokens > 13, so similarity > 0 and < 1
        expected: -1, // placeholder — just check > 0
      },
      {
        name: "CJK completely different texts",
        left: "苹果香蕉",
        right: "钢铁煤炭",
        expected: 0,
      },
    ] as const;

    for (const testCase of cases) {
      if (testCase.expected === -1) {
        // Placeholder: just assert positive similarity
        const sim = textSimilarity(testCase.left, testCase.right);
        expect(sim, testCase.name).toBeGreaterThan(0);
        expect(sim, testCase.name).toBeLessThan(1);
      } else {
        expect(textSimilarity(testCase.left, testCase.right), testCase.name).toBe(
          testCase.expected,
        );
      }
    }
  });
});

describe("computeMMRScore", () => {
  it("balances relevance and diversity across lambda settings", () => {
    const cases = [
      {
        name: "lambda=1 relevance only",
        relevance: 0.8,
        similarity: 0.5,
        lambda: 1,
        expected: 0.8,
      },
      {
        name: "lambda=0 diversity only",
        relevance: 0.8,
        similarity: 0.5,
        lambda: 0,
        expected: -0.5,
      },
      { name: "lambda=0.5 mixed", relevance: 0.8, similarity: 0.6, lambda: 0.5, expected: 0.1 },
      { name: "default lambda math", relevance: 1.0, similarity: 0.5, lambda: 0.7, expected: 0.55 },
    ] as const;

    for (const testCase of cases) {
      expect(
        computeMMRScore(testCase.relevance, testCase.similarity, testCase.lambda),
        testCase.name,
      ).toBeCloseTo(testCase.expected);
    }
  });
});

describe("empty input behavior", () => {
  it("returns empty array for empty input", () => {
    expect(mmrRerank([])).toEqual([]);
    expect(applyMMRToHybridResults([])).toEqual([]);
  });
});

describe("mmrRerank", () => {
  describe("edge cases", () => {
    it("returns single item unchanged", () => {
      const items: MMRItem[] = [{ id: "1", score: 0.9, content: "hello" }];
      expect(mmrRerank(items)).toEqual(items);
    });

    it("returns copy, not original array", () => {
      const items: MMRItem[] = [{ id: "1", score: 0.9, content: "hello" }];
      const result = mmrRerank(items);
      expect(result).not.toBe(items);
    });

    it("returns items unchanged when disabled", () => {
      const items: MMRItem[] = [
        { id: "1", score: 0.9, content: "hello" },
        { id: "2", score: 0.8, content: "hello" },
      ];
      const result = mmrRerank(items, { enabled: false });
      expect(result).toEqual(items);
    });
  });

  describe("lambda edge cases", () => {
    const diverseItems: MMRItem[] = [
      { id: "1", score: 1.0, content: "apple banana cherry" },
      { id: "2", score: 0.9, content: "apple banana date" },
      { id: "3", score: 0.8, content: "elderberry fig grape" },
    ];

    it("lambda=1 returns pure relevance order", () => {
      const result = mmrRerank(diverseItems, { lambda: 1 });
      expect(result.map((i) => i.id)).toEqual(["1", "2", "3"]);
    });

    it("lambda=0 maximizes diversity", () => {
      const result = mmrRerank(diverseItems, { enabled: true, lambda: 0 });
      // First item is still highest score (no penalty yet)
      expect(result[0].id).toBe("1");
      // Second should be most different from first
      expect(result[1].id).toBe("3"); // elderberry... is most different
    });

    it("clamps lambda > 1 to 1", () => {
      const result = mmrRerank(diverseItems, { lambda: 1.5 });
      expect(result.map((i) => i.id)).toEqual(["1", "2", "3"]);
    });

    it("clamps lambda < 0 to 0", () => {
      const result = mmrRerank(diverseItems, { enabled: true, lambda: -0.5 });
      expect(result[0].id).toBe("1");
      expect(result[1].id).toBe("3");
    });
  });

  describe("diversity behavior", () => {
    it("promotes diverse results over similar high-scoring ones", () => {
      const items: MMRItem[] = [
        { id: "1", score: 1.0, content: "machine learning neural networks" },
        { id: "2", score: 0.95, content: "machine learning deep learning" },
        { id: "3", score: 0.9, content: "database systems sql queries" },
        { id: "4", score: 0.85, content: "machine learning algorithms" },
      ];

      const result = mmrRerank(items, { enabled: true, lambda: 0.5 });

      // First is always highest score
      expect(result[0].id).toBe("1");
      // Second should be the diverse database item, not another ML item
      expect(result[1].id).toBe("3");
    });

    it("handles items with identical content", () => {
      const items: MMRItem[] = [
        { id: "1", score: 1.0, content: "identical content" },
        { id: "2", score: 0.9, content: "identical content" },
        { id: "3", score: 0.8, content: "different stuff" },
      ];

      const result = mmrRerank(items, { enabled: true, lambda: 0.5 });
      expect(result[0].id).toBe("1");
      // Second should be different, not identical duplicate
      expect(result[1].id).toBe("3");
    });

    it("handles all identical content gracefully", () => {
      const items: MMRItem[] = [
        { id: "1", score: 1.0, content: "same" },
        { id: "2", score: 0.9, content: "same" },
        { id: "3", score: 0.8, content: "same" },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      // Should still complete without error, order by score as tiebreaker
      expect(result).toHaveLength(3);
    });
  });

  describe("tie-breaking", () => {
    it("uses original score as tiebreaker", () => {
      const items: MMRItem[] = [
        { id: "1", score: 1.0, content: "unique content one" },
        { id: "2", score: 0.9, content: "unique content two" },
        { id: "3", score: 0.8, content: "unique content three" },
      ];

      // With very different content and lambda=1, should be pure score order
      const result = mmrRerank(items, { lambda: 1 });
      expect(result.map((i) => i.id)).toEqual(["1", "2", "3"]);
    });

    it("preserves all items even with same MMR scores", () => {
      const items: MMRItem[] = [
        { id: "1", score: 0.5, content: "a" },
        { id: "2", score: 0.5, content: "b" },
        { id: "3", score: 0.5, content: "c" },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(3);
      expect(new Set(result.map((i) => i.id))).toEqual(new Set(["1", "2", "3"]));
    });
  });

  describe("score normalization", () => {
    it("handles items with same scores", () => {
      const items: MMRItem[] = [
        { id: "1", score: 0.5, content: "hello world" },
        { id: "2", score: 0.5, content: "foo bar" },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(2);
    });

    it("handles negative scores", () => {
      const items: MMRItem[] = [
        { id: "1", score: -0.5, content: "hello world" },
        { id: "2", score: -1.0, content: "foo bar" },
      ];

      const result = mmrRerank(items, { lambda: 0.7 });
      expect(result).toHaveLength(2);
      // Higher score (less negative) should come first
      expect(result[0].id).toBe("1");
    });
  });
});

describe("applyMMRToHybridResults", () => {
  type HybridResult = {
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: string;
  };

  it("preserves all original fields", () => {
    const results: HybridResult[] = [
      {
        path: "/test/file.ts",
        startLine: 1,
        endLine: 10,
        score: 0.9,
        snippet: "hello world",
        source: "memory",
      },
    ];

    const reranked = applyMMRToHybridResults(results);
    expect(reranked[0]).toEqual(results[0]);
  });

  it("creates unique IDs from path and startLine", () => {
    const results: HybridResult[] = [
      {
        path: "/test/a.ts",
        startLine: 1,
        endLine: 10,
        score: 0.9,
        snippet: "same content here",
        source: "memory",
      },
      {
        path: "/test/a.ts",
        startLine: 20,
        endLine: 30,
        score: 0.8,
        snippet: "same content here",
        source: "memory",
      },
    ];

    // Should work without ID collision
    const reranked = applyMMRToHybridResults(results);
    expect(reranked).toHaveLength(2);
  });

  it("re-ranks results for diversity", () => {
    const results: HybridResult[] = [
      {
        path: "/a.ts",
        startLine: 1,
        endLine: 10,
        score: 1.0,
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

    // First stays the same (highest score)
    expect(reranked[0].path).toBe("/a.ts");
    // Second should be the diverse one
    expect(reranked[1].path).toBe("/c.ts");
  });

  it("respects disabled config", () => {
    const results: HybridResult[] = [
      { path: "/a.ts", startLine: 1, endLine: 10, score: 0.9, snippet: "test", source: "memory" },
      { path: "/b.ts", startLine: 1, endLine: 10, score: 0.8, snippet: "test", source: "memory" },
    ];

    const reranked = applyMMRToHybridResults(results, { enabled: false });
    expect(reranked).toEqual(results);
  });
});

describe("DEFAULT_MMR_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_MMR_CONFIG.enabled).toBe(false);
    expect(DEFAULT_MMR_CONFIG.lambda).toBe(0.7);
  });
});
