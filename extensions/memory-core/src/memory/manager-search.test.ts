import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { bm25RankToScore, buildFtsQuery } from "./hybrid.js";
import { searchKeyword, searchVector } from "./manager-search.js";

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

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

describe("searchVector sqlite-vec KNN", () => {
  const { DatabaseSync } = requireNodeSqlite();

  it("streams fallback chunk scoring without materializing candidates", async () => {
    type ChunkRow = {
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      embedding: string;
      source: string;
    };
    type StatementWithAll = {
      all: (...params: unknown[]) => ChunkRow[];
    };

    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({
        db,
        embeddingCacheTable: "embedding_cache",
        cacheEnabled: false,
        ftsTable: "chunks_fts",
        ftsEnabled: false,
      });

      const insertChunk = db.prepare(
        "INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const addChunk = (params: { id: string; model: string; vector: [number, number] }) => {
        insertChunk.run(
          params.id,
          `memory/${params.id}.md`,
          "memory",
          1,
          1,
          params.id,
          params.model,
          `chunk ${params.id}`,
          JSON.stringify(params.vector),
          1,
        );
      };
      addChunk({ id: "target-1", model: "target-model", vector: [1, 0] });
      addChunk({ id: "target-2", model: "target-model", vector: [0.8, 0.2] });
      addChunk({ id: "target-3", model: "target-model", vector: [0, 1] });
      addChunk({ id: "other-1", model: "other-model", vector: [1, 0] });

      const prepareTarget = db as unknown as { prepare: (sql: string) => unknown };
      const originalPrepare = prepareTarget.prepare.bind(db);
      const chunkRows = (
        originalPrepare(
          "SELECT id, path, start_line, end_line, text, embedding, source\n" +
            "  FROM chunks\n" +
            " WHERE model = ?",
        ) as StatementWithAll
      ).all("target-model");
      const prepareSpy = vi.spyOn(prepareTarget, "prepare").mockImplementation((sql: string) => {
        if (
          sql.includes("SELECT id, path, start_line, end_line, text, embedding, source") &&
          sql.includes("FROM chunks")
        ) {
          return {
            all: () => {
              throw new Error("fallback vector search must stream rows via iterate()");
            },
            iterate: () => chunkRows[Symbol.iterator](),
          };
        }
        return originalPrepare(sql);
      });

      try {
        const results = await searchVector({
          db,
          vectorTable: "chunks_vec",
          providerModel: "target-model",
          queryVec: [1, 0],
          limit: 2,
          snippetMaxChars: 200,
          ensureVectorReady: async () => false,
          sourceFilterVec: { sql: "", params: [] },
          sourceFilterChunks: { sql: "", params: [] },
        });

        expect(results.map((row) => row.id)).toEqual(["target-1", "target-2"]);
      } finally {
        prepareSpy.mockRestore();
      }
    } finally {
      db.close();
    }
  });

  it("fills the requested limit after model filters prune nearest KNN candidates", async () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    try {
      const loaded = await loadSqliteVecExtension({ db });
      expect(loaded.ok, loaded.error).toBe(true);
      ensureMemoryIndexSchema({
        db,
        embeddingCacheTable: "embedding_cache",
        cacheEnabled: false,
        ftsTable: "chunks_fts",
        ftsEnabled: false,
      });
      db.exec(`
        CREATE VIRTUAL TABLE chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[2]
        );
      `);

      const insertChunk = db.prepare(
        "INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertVector = db.prepare("INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)");
      const addChunk = (params: { id: string; model: string; vector: [number, number] }) => {
        insertChunk.run(
          params.id,
          `memory/${params.id}.md`,
          "memory",
          1,
          1,
          params.id,
          params.model,
          `chunk ${params.id}`,
          JSON.stringify(params.vector),
          1,
        );
        insertVector.run(params.id, vectorToBlob(params.vector));
      };

      for (let i = 0; i < 20; i += 1) {
        addChunk({ id: `other-${i}`, model: "other-model", vector: [1, i / 1000] });
      }
      addChunk({ id: "target-1", model: "target-model", vector: [0.5, 0.5] });
      addChunk({ id: "target-2", model: "target-model", vector: [0.4, 0.6] });

      const results = await searchVector({
        db,
        vectorTable: "chunks_vec",
        providerModel: "target-model",
        queryVec: [1, 0],
        limit: 2,
        snippetMaxChars: 200,
        ensureVectorReady: async () => true,
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      });

      expect(results.map((row) => row.id)).toEqual(["target-1", "target-2"]);
    } finally {
      db.close();
    }
  });
});
