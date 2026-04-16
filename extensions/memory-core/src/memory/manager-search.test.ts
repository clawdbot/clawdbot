import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it } from "vitest";
import { bm25RankToScore, buildFtsQuery } from "./hybrid.js";
import { searchKeyword } from "./manager-search.js";

describe("searchKeyword trigram fallback", () => {
  const { DatabaseSync } = requireNodeSqlite();

  function supportsTrigramFts(): boolean {
    const db = new DatabaseSync(":memory:");
    try {
      const result = ensureMemoryIndexSchema({
        db,
        embeddingCacheTable: "embedding_cache",
        cacheEnabled: false,
        ftsTable: "chunks_fts",
        ftsEnabled: true,
        ftsTokenizer: "trigram",
      });
      return result.ftsAvailable;
    } finally {
      db.close();
    }
  }

  function createTrigramDb() {
    const db = new DatabaseSync(":memory:");
    const result = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      cacheEnabled: false,
      ftsTable: "chunks_fts",
      ftsEnabled: true,
      ftsTokenizer: "trigram",
    });
    if (!result.ftsAvailable) {
      db.close();
      throw new Error(`FTS5 trigram unavailable: ${result.ftsError ?? "unknown error"}`);
    }
    return db;
  }

  async function runSearch(params: {
    rows: Array<{ id: string; path: string; text: string }>;
    query: string;
    boostFallbackRanking?: boolean;
  }) {
    const db = createTrigramDb();
    try {
      const insert = db.prepare(
        "INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of params.rows) {
        insert.run(row.text, row.id, row.path, "memory", "mock-embed", 1, 1);
      }
      return await searchKeyword({
        db,
        ftsTable: "chunks_fts",
        providerModel: "mock-embed",
        query: params.query,
        ftsTokenizer: "trigram",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery,
        bm25RankToScore,
        boostFallbackRanking: params.boostFallbackRanking,
      });
    } finally {
      db.close();
    }
  }

  const itWithTrigramFts = supportsTrigramFts() ? it : it.skip;

  itWithTrigramFts("finds short Chinese queries with substring fallback", async () => {
    const results = await runSearch({
      rows: [{ id: "1", path: "memory/zh.md", text: "今天玩成语接龙游戏" }],
      query: "成语",
    });
    expect(results.map((row) => row.id)).toContain("1");
    expect(results[0]?.textScore).toBe(1);
  });

  itWithTrigramFts("finds short Japanese and Korean queries with substring fallback", async () => {
    const japaneseResults = await runSearch({
      rows: [{ id: "jp", path: "memory/jp.md", text: "今日はしりとり大会" }],
      query: "しり とり",
    });
    expect(japaneseResults.map((row) => row.id)).toEqual(["jp"]);

    const koreanResults = await runSearch({
      rows: [{ id: "ko", path: "memory/ko.md", text: "오늘 끝말잇기 게임을 했다" }],
      query: "끝말",
    });
    expect(koreanResults.map((row) => row.id)).toEqual(["ko"]);
  });

  itWithTrigramFts(
    "keeps MATCH semantics for long trigram terms while requiring short CJK substrings",
    async () => {
      const results = await runSearch({
        rows: [
          { id: "match", path: "memory/good.md", text: "今天玩成语接龙游戏" },
          { id: "partial", path: "memory/partial.md", text: "今天玩成语接龙" },
        ],
        query: "成语接龙 游戏",
      });
      expect(results.map((row) => row.id)).toEqual(["match"]);
      expect(results[0]?.textScore).toBeGreaterThan(0);
    },
  );

  itWithTrigramFts("applies fallback lexical boosts without exceeding bounded scores", async () => {
    const results = await runSearch({
      rows: [
        {
          id: "strong",
          path: "memory/project-memory-notes.md",
          text: "Project memory notes covering workspace context and retrieval behavior.",
        },
        {
          id: "weak",
          path: "memory/notes.md",
          text: "Project memory context.",
        },
      ],
      query: "project memory context",
      boostFallbackRanking: true,
    });
    expect(results.map((row) => row.id)).toEqual(["weak", "strong"]);
    const rawResults = await runSearch({
      rows: [
        {
          id: "strong",
          path: "memory/project-memory-notes.md",
          text: "Project memory notes covering workspace context and retrieval behavior.",
        },
        {
          id: "weak",
          path: "memory/notes.md",
          text: "Project memory context.",
        },
      ],
      query: "project memory context",
      boostFallbackRanking: false,
    });

    const boostedById = new Map(results.map((row) => [row.id, row]));
    const rawById = new Map(rawResults.map((row) => [row.id, row]));
    expect(rawById.get("strong")?.textScore).toBeLessThan(rawById.get("weak")?.textScore ?? 0);
    expect(boostedById.get("strong")?.score).toBeGreaterThan(boostedById.get("weak")?.score ?? 0);
    expect(boostedById.get("strong")?.textScore).toBe(rawById.get("strong")?.textScore);
    expect(boostedById.get("weak")?.textScore).toBe(rawById.get("weak")?.textScore);
    expect(boostedById.get("strong")?.score).toBeLessThanOrEqual(1);
    expect(boostedById.get("weak")?.score).toBeLessThanOrEqual(1);
  });

  itWithTrigramFts("does not overweight repeated query tokens in fallback scoring", async () => {
    const unique = await runSearch({
      rows: [{ id: "1", path: "memory/project.md", text: "Project memory context." }],
      query: "project memory context",
      boostFallbackRanking: true,
    });
    const repeated = await runSearch({
      rows: [{ id: "1", path: "memory/project.md", text: "Project memory context." }],
      query: "project project project memory context",
      boostFallbackRanking: true,
    });

    expect(repeated[0]?.score).toBe(unique[0]?.score);
  });
});
