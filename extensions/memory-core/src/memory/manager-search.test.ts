// Memory Core tests cover manager search plugin behavior.
import type { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import { bm25RankToScore, buildFtsQuery } from "./hybrid.js";
import { searchKeyword, searchPathKeyword, searchVector } from "./manager-search.js";
import { vectorToBlob } from "./vector-blob.js";

function insertKeywordFixture(
  db: DatabaseSync,
  params: {
    text: string;
    id: string;
    path: string;
    source: "memory" | "sessions";
    model: string;
    startLine: number;
    endLine: number;
  },
): void {
  db.prepare(
    "INSERT OR IGNORE INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, 0, 0)",
  ).run(params.path, params.source, `${params.path}:${params.source}:hash`);
  db.prepare(
    "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    params.id,
    params.path,
    params.source,
    params.startLine,
    params.endLine,
    `${params.id}:hash`,
    params.model,
    params.text,
    JSON.stringify([0]),
    Date.now(),
  );
  db.prepare(
    "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    params.text,
    params.id,
    params.path,
    params.source,
    params.model,
    params.startLine,
    params.endLine,
  );
}

describe("searchKeyword trigram fallback", () => {
  const { DatabaseSync } = requireNodeSqlite();

  function supportsTrigramFts(): boolean {
    const db = new DatabaseSync(":memory:");
    try {
      const result = ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
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
      cacheEnabled: false,
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
      for (const row of params.rows) {
        insertKeywordFixture(db, {
          text: row.text,
          id: row.id,
          path: row.path,
          source: "memory",
          model: "mock-embed",
          startLine: 1,
          endLine: 1,
        });
      }
      return await searchKeyword({
        db,
        ftsTable: "memory_index_chunks_fts",
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

describe("searchKeyword FTS MATCH fallback", () => {
  const { DatabaseSync } = requireNodeSqlite();

  function supportsFts(): boolean {
    const db = new DatabaseSync(":memory:");
    try {
      const result = ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
      });
      return result.ftsAvailable;
    } finally {
      db.close();
    }
  }

  function createFtsDb() {
    const db = new DatabaseSync(":memory:");
    const result = ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: true,
    });
    if (!result.ftsAvailable) {
      db.close();
      throw new Error(`FTS5 unavailable: ${result.ftsError ?? "unknown error"}`);
    }
    return db;
  }

  const itWithFts = supportsFts() ? it : it.skip;

  itWithFts("falls back to LIKE search when FTS MATCH throws", async () => {
    const db = createFtsDb();
    try {
      insertKeywordFixture(db, {
        text: "The Agent framework handles API calls and cron jobs",
        id: "1",
        path: "doc.md",
        source: "sessions",
        model: "mock-embed",
        startLine: 1,
        endLine: 5,
      });
      insertKeywordFixture(db, {
        text: "Deploy the database cluster on Hetzner",
        id: "2",
        path: "ops.md",
        source: "sessions",
        model: "mock-embed",
        startLine: 1,
        endLine: 3,
      });

      // Simulate a buildFtsQuery that produces a broken MATCH expression
      const brokenBuildFtsQuery = () => "BROKEN_QUERY_SYNTAX <<<";

      const results = await searchKeyword({
        db,
        ftsTable: "memory_index_chunks_fts",
        query: "Agent",
        ftsTokenizer: "unicode61",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery: brokenBuildFtsQuery,
        bm25RankToScore,
      });

      // LIKE fallback should find "Agent" in the first row
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.id).toBe("1");
      // Fallback results have textScore=1 (no BM25 ranking)
      expect(results[0]?.textScore).toBe(1);
    } finally {
      db.close();
    }
  });

  itWithFts("returns BM25-scored results when FTS MATCH succeeds", async () => {
    const db = createFtsDb();
    try {
      insertKeywordFixture(db, {
        text: "The Transformer architecture powers modern LLMs",
        id: "1",
        path: "ml.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 3,
      });

      const results = await searchKeyword({
        db,
        ftsTable: "memory_index_chunks_fts",
        query: "Transformer",
        ftsTokenizer: "unicode61",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery,
        bm25RankToScore,
      });

      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe("1");
      // BM25 score should be a real computed value, not the fallback default
      expect(results[0]?.textScore).toBeGreaterThan(0);
      expect(results[0]?.textScore).toBeLessThan(1);
    } finally {
      db.close();
    }
  });

  itWithFts("applies source filter in LIKE fallback", async () => {
    const db = createFtsDb();
    try {
      insertKeywordFixture(db, {
        text: "Agent handles API calls",
        id: "1",
        path: "doc.md",
        source: "sessions",
        model: "mock-embed",
        startLine: 1,
        endLine: 3,
      });
      insertKeywordFixture(db, {
        text: "Agent design patterns",
        id: "2",
        path: "notes.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 3,
      });

      const brokenBuildFtsQuery = () => "BROKEN <<<";
      const results = await searchKeyword({
        db,
        ftsTable: "memory_index_chunks_fts",
        query: "Agent",
        ftsTokenizer: "unicode61",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: " AND source IN (?)", params: ["sessions"] },
        buildFtsQuery: brokenBuildFtsQuery,
        bm25RankToScore,
      });

      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe("1");
      expect(results[0]?.source).toBe("sessions");
    } finally {
      db.close();
    }
  });

  itWithFts("splits multi-word query into per-token LIKE clauses in fallback", async () => {
    const db = createFtsDb();
    try {
      // "Agent" and "cron" appear in this row but not adjacent
      insertKeywordFixture(db, {
        text: "The Agent framework handles API calls and cron jobs",
        id: "1",
        path: "doc.md",
        source: "sessions",
        model: "mock-embed",
        startLine: 1,
        endLine: 5,
      });
      // Only "Agent" appears in this row
      insertKeywordFixture(db, {
        text: "Agent design patterns for microservices",
        id: "2",
        path: "arch.md",
        source: "sessions",
        model: "mock-embed",
        startLine: 1,
        endLine: 3,
      });

      // A single-substring LIKE '%Agent cron%' would miss row 1 because
      // the words are not adjacent. Per-token LIKE should find it.
      const brokenBuildFtsQuery = () => "BROKEN <<<";
      const results = await searchKeyword({
        db,
        ftsTable: "memory_index_chunks_fts",
        query: "Agent cron",
        ftsTokenizer: "unicode61",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery: brokenBuildFtsQuery,
        bm25RankToScore,
      });

      // Per-token fallback: both "Agent" AND "cron" must match
      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe("1");
    } finally {
      db.close();
    }
  });

  itWithFts("logs warning when MATCH fallback is used", async () => {
    const db = createFtsDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      insertKeywordFixture(db, {
        text: "test content",
        id: "1",
        path: "doc.md",
        source: "sessions",
        model: "mock-embed",
        startLine: 1,
        endLine: 1,
      });

      await searchKeyword({
        db,
        ftsTable: "memory_index_chunks_fts",
        query: "test",
        ftsTokenizer: "unicode61",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery: () => "BROKEN <<<",
        bm25RankToScore,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warning] = warnSpy.mock.calls[0] ?? [];
      expect(typeof warning).toBe("string");
      expect(
        (warning as string | undefined)?.startsWith(
          "memory search: FTS5 MATCH failed, falling back to LIKE: ",
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      db.close();
    }
  });
});

describe("searchPathKeyword", () => {
  const { DatabaseSync } = requireNodeSqlite();

  it("returns the first scoped chunk and reserves exact precedence for path identifiers", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      insertKeywordFixture(db, {
        id: "memory-late",
        path: "memory/projects/Project-Lantern.md",
        source: "memory",
        model: "mock-embed",
        startLine: 20,
        endLine: 25,
        text: "later unrelated body",
      });
      insertKeywordFixture(db, {
        id: "memory-early",
        path: "memory/projects/Project-Lantern.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 5,
        text: "early unrelated body",
      });
      insertKeywordFixture(db, {
        id: "session-early",
        path: "memory/projects/Project-Lantern.md",
        source: "sessions",
        model: "mock-embed",
        startLine: 1,
        endLine: 2,
        text: "session unrelated body",
      });

      const search = (query: string) =>
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query,
          ftsTokenizer: "unicode61",
          limit: 10,
          snippetMaxChars: 200,
          sourceFilter: {
            sql: " AND memory_index_paths_fts.source IN (?)",
            params: ["memory"],
          },
          buildFtsQuery,
          bm25RankToScore,
        });

      const exact = await search("project-lantern");
      expect(exact).toHaveLength(1);
      expect(exact[0]).toMatchObject({
        id: "memory-early",
        path: "memory/projects/Project-Lantern.md",
        source: "memory",
        startLine: 1,
        snippet: "early unrelated body",
        exactPathSpecificity: 1,
        textScore: 0,
      });
      expect(exact[0]?.score).toBe(exact[0]?.pathScore);

      const token = await search("lantern");
      expect(token).toHaveLength(1);
      expect(token[0]?.exactPathSpecificity).toBe(0);
      expect(token[0]?.textScore).toBe(0);
      expect(token[0]?.score).toBe(token[0]?.pathScore);
      expect(token[0]?.score).toBeLessThan(1);
    } finally {
      db.close();
    }
  });

  it("finds an ASCII exact path amid many unrelated source rows", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      const unrelatedCount = 256;
      const insertSource = db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'memory', ?, 0, 0)",
      );
      for (let index = 0; index < unrelatedCount; index += 1) {
        insertSource.run(`memory/unrelated-${index}.md`, `unrelated-${index}`);
      }
      insertSource.run("memory/project-lantern.notes.md", "near");
      insertKeywordFixture(db, {
        id: "exact-ascii-path",
        path: "memory/project-lantern.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 2,
        text: "unrelated body",
      });

      const results = await searchPathKeyword({
        db,
        pathFtsTable: "memory_index_paths_fts",
        query: "project-lantern",
        ftsTokenizer: "unicode61",
        limit: 1,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery,
        bm25RankToScore,
      });

      expect(results).toMatchObject([{ id: "exact-ascii-path", exactPathSpecificity: 1 }]);
    } finally {
      db.close();
    }
  });

  it("skips empty exact sources before applying the exact result limit", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, 0, 0)",
      ).run("a/foo.md", "memory", "empty-source");
      insertKeywordFixture(db, {
        id: "live-exact-source",
        path: "z/foo.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 2,
        text: "live exact source",
      });

      await expect(
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query: "foo",
          ftsTokenizer: "unicode61",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        }),
      ).resolves.toMatchObject([{ id: "live-exact-source", exactPathSpecificity: 1 }]);
    } finally {
      db.close();
    }
  });

  it("keeps exact basename truncation independent of path BM25", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      for (const fixture of [
        { id: "exact-a", path: "a/very/deep/foo.md" },
        { id: "exact-b", path: "b/foo.md" },
        { id: "exact-c", path: "c/foo.md" },
      ]) {
        insertKeywordFixture(db, {
          ...fixture,
          source: "memory",
          model: "mock-embed",
          startLine: 1,
          endLine: 2,
          text: "unrelated body",
        });
      }

      const results = await searchPathKeyword({
        db,
        pathFtsTable: "memory_index_paths_fts",
        query: "foo.md",
        ftsTokenizer: "unicode61",
        limit: 2,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery,
        bm25RankToScore,
      });

      expect(results.map((entry) => entry.id)).toEqual(["exact-a", "exact-b"]);
      expect(results.every((entry) => entry.textScore === 0)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("ranks exact full names above last-extension stem collisions", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      for (const fixture of [
        { id: "foo-stem", path: "a/foo.md.bak" },
        { id: "foo-basename", path: "z/foo.md" },
        { id: "bar-stem", path: "a/bar.md" },
        { id: "bar-basename", path: "z/bar" },
      ]) {
        insertKeywordFixture(db, {
          ...fixture,
          source: "memory",
          model: "mock-embed",
          startLine: 1,
          endLine: 2,
          text: "unrelated body",
        });
      }
      const search = (query: string) =>
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query,
          ftsTokenizer: "unicode61",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        });

      await expect(search("foo.md")).resolves.toMatchObject([
        { id: "foo-basename", exactPathSpecificity: 2 },
      ]);
      await expect(search("bar")).resolves.toMatchObject([
        { id: "bar-basename", exactPathSpecificity: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps mixed-case Unicode exact identifiers in the predicate candidate set", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      for (const fixture of [
        { id: "cyrillic-near", path: "МОСКВА.notes.md" },
        { id: "cyrillic-exact", path: "я/Москва.md" },
        { id: "cyrillic-unrelated", path: "Киев.md" },
      ]) {
        insertKeywordFixture(db, {
          ...fixture,
          source: "memory",
          model: "mock-embed",
          startLine: 1,
          endLine: 2,
          text: "unrelated body",
        });
      }

      const results = await searchPathKeyword({
        db,
        pathFtsTable: "memory_index_paths_fts",
        query: "МОСКВА",
        ftsTokenizer: "unicode61",
        limit: 1,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery,
        bm25RankToScore,
      });

      expect(results).toMatchObject([{ id: "cyrillic-exact", exactPathSpecificity: 1 }]);
    } finally {
      db.close();
    }
  });

  it("applies the final exact predicate before limiting multi-dot and Unicode matches", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      if (!schema.ftsAvailable) {
        throw new Error(schema.ftsError ?? "FTS unavailable");
      }
      for (const fixture of [
        { id: "foo-near", path: "foo.bar.md" },
        { id: "foo-exact", path: "memory/deep/archive/foo.md" },
        { id: "unicode-near", path: "CAFÉ.notes.md" },
        { id: "unicode-exact", path: "memory/deep/Cafe\u0301.md" },
      ]) {
        insertKeywordFixture(db, {
          ...fixture,
          source: "memory",
          model: "mock-embed",
          startLine: 1,
          endLine: 2,
          text: "unrelated body",
        });
      }

      const search = (query: string) =>
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query,
          ftsTokenizer: "unicode61",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        });

      await expect(search("foo")).resolves.toMatchObject([
        { id: "foo-exact", exactPathSpecificity: 1 },
      ]);
      await expect(search("CAFÉ")).resolves.toMatchObject([
        { id: "unicode-exact", exactPathSpecificity: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it("applies short CJK trigram substring matching to the path table", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
        ftsTokenizer: "trigram",
      });
      if (!schema.ftsAvailable) {
        return;
      }
      insertKeywordFixture(db, {
        id: "cjk-path",
        path: "memory/成语-notes.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 2,
        text: "unrelated body",
      });
      insertKeywordFixture(db, {
        id: "cjk-exact",
        path: "memory/成语.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 2,
        text: "unrelated body",
      });
      insertKeywordFixture(db, {
        id: "readme-exact",
        path: "memory/README.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 2,
        text: "unrelated body",
      });
      insertKeywordFixture(db, {
        id: "normalized-exact",
        path: "memory/Cafe\u0301.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 2,
        text: "unrelated body",
      });
      insertKeywordFixture(db, {
        id: "tokenless-exact",
        path: "memory/🧠.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 2,
        text: "unrelated body",
      });

      const results = await searchPathKeyword({
        db,
        pathFtsTable: "memory_index_paths_fts",
        query: "成语",
        ftsTokenizer: "trigram",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery,
        bm25RankToScore,
      });

      expect(results.map((entry) => entry.id)).toEqual(["cjk-exact", "cjk-path"]);
      await expect(
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query: "成语.md",
          ftsTokenizer: "trigram",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        }),
      ).resolves.toMatchObject([{ id: "cjk-exact", exactPathSpecificity: 2 }]);
      await expect(
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query: "README.md",
          ftsTokenizer: "trigram",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        }),
      ).resolves.toMatchObject([{ id: "readme-exact", exactPathSpecificity: 2 }]);
      await expect(
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query: "CAFÉ",
          ftsTokenizer: "trigram",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        }),
      ).resolves.toMatchObject([{ id: "normalized-exact", exactPathSpecificity: 1 }]);
      await expect(
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query: "🧠",
          ftsTokenizer: "trigram",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        }),
      ).resolves.toMatchObject([{ id: "tokenless-exact", exactPathSpecificity: 1 }]);
    } finally {
      db.close();
    }
  });

  it("case-folds short Cyrillic and Greek trigram terms after an anchor prefilter", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
        ftsTokenizer: "trigram",
      });
      if (!schema.ftsAvailable) {
        return;
      }
      const insertSource = db.prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'memory', ?, 0, 0)",
      );
      for (let index = 0; index < 256; index += 1) {
        insertSource.run(`memory/unrelated-${index}.md`, `unrelated-${index}`);
      }
      insertSource.run("memory/Мир.md", "cyrillic-anchor-negative");
      insertSource.run("memory/Αλφα.md", "greek-anchor-negative");
      for (const fixture of [
        { id: "cyrillic-short", path: "memory/Москва-notes.md" },
        { id: "greek-short", path: "memory/Αθήνα-notes.md" },
      ]) {
        insertKeywordFixture(db, {
          ...fixture,
          source: "memory",
          model: "mock-embed",
          startLine: 1,
          endLine: 2,
          text: "unrelated body",
        });
      }
      expect(
        db.prepare("SELECT 1 FROM memory_index_paths_fts WHERE path LIKE ? LIMIT 1").get("%МО%"),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT 1 FROM memory_index_paths_fts WHERE path LIKE ? LIMIT 1").get("%ΑΘ%"),
      ).toBeUndefined();
      for (const anchors of [
        ["%М%", "%м%"],
        ["%Α%", "%α%"],
      ]) {
        const candidateCount = db
          .prepare(
            "SELECT count(*) AS count FROM memory_index_paths_fts WHERE path LIKE ? OR path LIKE ?",
          )
          .get(...anchors) as { count: number };
        expect(candidateCount.count).toBe(2);
      }
      const search = (query: string) =>
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query,
          ftsTokenizer: "trigram",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        });

      await expect(search("МО")).resolves.toMatchObject([
        { id: "cyrillic-short", exactPathSpecificity: 0 },
      ]);
      await expect(search("ΑΘ")).resolves.toMatchObject([
        { id: "greek-short", exactPathSpecificity: 0 },
      ]);
    } finally {
      db.close();
    }
  });

  it("bridges NFC trigram queries to partial NFD path spellings", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
        ftsTokenizer: "trigram",
      });
      if (!schema.ftsAvailable) {
        return;
      }
      insertKeywordFixture(db, {
        id: "normalized-partial",
        path: "memory/Cafe\u0301-notes.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 2,
        text: "unrelated body",
      });
      const search = (query: string) =>
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query,
          ftsTokenizer: "trigram",
          limit: 10,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        });

      for (const query of ["Café", "fé"]) {
        const results = await search(query);
        expect(results).toMatchObject([{ id: "normalized-partial", exactPathSpecificity: 0 }]);
      }
    } finally {
      db.close();
    }
  });

  it("matches partial Unicode path text with the default unicode61 tokenizer", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      if (!schema.ftsAvailable) {
        return;
      }
      insertKeywordFixture(db, {
        id: "unicode61-partial",
        path: "memory/Café.md",
        source: "memory",
        model: "mock-embed",
        startLine: 1,
        endLine: 2,
        text: "unrelated body",
      });

      const search = (query: string) =>
        searchPathKeyword({
          db,
          pathFtsTable: "memory_index_paths_fts",
          query,
          ftsTokenizer: "unicode61",
          limit: 1,
          snippetMaxChars: 200,
          sourceFilter: { sql: "", params: [] },
          buildFtsQuery,
          bm25RankToScore,
        });

      for (const query of ["afé", "AFE\u0301", "memory afé"]) {
        await expect(search(query)).resolves.toMatchObject([
          { id: "unicode61-partial", exactPathSpecificity: 0 },
        ]);
      }
      await expect(search("emory afé")).resolves.toEqual([]);
    } finally {
      db.close();
    }
  });

  it("bounds exact-path headroom independently from lexical candidates", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
      if (!schema.ftsAvailable) {
        return;
      }
      for (let index = 0; index < 205; index += 1) {
        insertKeywordFixture(db, {
          id: `duplicate-${index}`,
          path: `memory/duplicates/${index.toString().padStart(3, "0")}/README.md`,
          source: "memory",
          model: "mock-embed",
          startLine: 1,
          endLine: 2,
          text: "unrelated body",
        });
      }
      for (let index = 0; index < 6; index += 1) {
        insertKeywordFixture(db, {
          id: `partial-${index}`,
          path: `memory/partial/${index}/notes-README.md.bak`,
          source: "memory",
          model: "mock-embed",
          startLine: 1,
          endLine: 2,
          text: "unrelated body",
        });
      }

      const results = await searchPathKeyword({
        db,
        pathFtsTable: "memory_index_paths_fts",
        query: "README.md",
        exactPathLimit: 200,
        ftsTokenizer: "unicode61",
        limit: 4,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery,
        bm25RankToScore,
      });

      expect(results).toHaveLength(204);
      expect(results.filter((entry) => entry.exactPathSpecificity === 2)).toHaveLength(200);
      expect(results.filter((entry) => entry.exactPathSpecificity === 0)).toHaveLength(4);
    } finally {
      db.close();
    }
  });
});

describe("searchKeyword cross-model FTS visibility (issue #48300)", () => {
  const { DatabaseSync } = requireNodeSqlite();

  function supportsFts(): boolean {
    const db = new DatabaseSync(":memory:");
    try {
      const result = ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
      });
      return result.ftsAvailable;
    } finally {
      db.close();
    }
  }

  const itWithFts = supportsFts() ? it : it.skip;

  itWithFts("returns FTS hits indexed under a different embedding model", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const result = ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
      });
      if (!result.ftsAvailable) {
        throw new Error(result.ftsError ?? "FTS unavailable");
      }
      insertKeywordFixture(db, {
        text: "Persona notes for Clyde the assistant",
        id: "clyde-old",
        path: "memory/persona.md",
        source: "memory",
        model: "bge-m3",
        startLine: 1,
        endLine: 3,
      });
      insertKeywordFixture(db, {
        text: "Persona notes for Clyde the assistant",
        id: "clyde-new",
        path: "memory/persona.md",
        source: "memory",
        model: "nomic-embed-text",
        startLine: 1,
        endLine: 3,
      });

      const results = await searchKeyword({
        db,
        ftsTable: "memory_index_chunks_fts",
        query: "Clyde",
        ftsTokenizer: "unicode61",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery,
        bm25RankToScore,
      });

      expect(results.map((row) => row.id).toSorted()).toEqual(["clyde-new", "clyde-old"]);
    } finally {
      db.close();
    }
  });

  itWithFts("does not return orphaned old-model FTS rows without a live chunk", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const result = ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: true,
      });
      if (!result.ftsAvailable) {
        throw new Error(result.ftsError ?? "FTS unavailable");
      }
      insertKeywordFixture(db, {
        text: "Current Clyde notes",
        id: "live-clyde",
        path: "memory/persona.md",
        source: "memory",
        model: "nomic-embed-text",
        startLine: 1,
        endLine: 3,
      });
      db.prepare(
        "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "Deleted Clyde notes from an older model",
        "orphan-clyde",
        "memory/persona.md",
        "memory",
        "bge-m3",
        1,
        3,
      );

      const results = await searchKeyword({
        db,
        ftsTable: "memory_index_chunks_fts",
        query: "Clyde",
        ftsTokenizer: "unicode61",
        limit: 10,
        snippetMaxChars: 200,
        sourceFilter: { sql: "", params: [] },
        buildFtsQuery,
        bm25RankToScore,
      });

      expect(results.map((row) => row.id)).toEqual(["live-clyde"]);
    } finally {
      db.close();
    }
  });
});

describe("searchVector sqlite-vec KNN", () => {
  const { DatabaseSync } = requireNodeSqlite();

  it("batches fallback chunk scoring without materializing all candidates", async () => {
    type ChunkRow = {
      rowid: number;
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      embedding: string;
      source: string;
    };

    const chunkRows: ChunkRow[] = Array.from({ length: 513 }, (_, index) => {
      const vector: [number, number] = index === 511 ? [1, 0] : index === 512 ? [0.9, 0.1] : [0, 1];
      return {
        rowid: index + 1,
        id: `target-${index}`,
        path: `memory/target-${index}.md`,
        start_line: 1,
        end_line: 1,
        text: `chunk target-${index}`,
        embedding: JSON.stringify(vector),
        source: "memory",
      };
    });
    const batchSizes: number[] = [];
    const prepare = vi.fn((sql: string) => {
      expect(sql).toContain("SELECT rowid, id, path");
      expect(sql).toContain("ORDER BY rowid ASC");
      expect(sql).toContain("LIMIT ?");
      return {
        all: (_model: string, lastRowid: number, limit: number) => {
          const batch = chunkRows.filter((row) => row.rowid > lastRowid).slice(0, limit);
          batchSizes.push(batch.length);
          return batch;
        },
      };
    });

    const results = await searchVector({
      db: { prepare } as unknown as Parameters<typeof searchVector>[0]["db"],
      vectorTable: "memory_index_chunks_vec",
      providerModel: "target-model",
      queryVec: [1, 0],
      limit: 2,
      snippetMaxChars: 200,
      ensureVectorReady: async () => false,
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
    });

    expect(results.map((row) => row.id)).toEqual(["target-511", "target-512"]);
    expect(batchSizes).toEqual([256, 256, 1]);
  });

  it("yields to the event loop during large fallback scans (issue #81172)", async () => {
    // Real Nextcloud-scale corpus where the vec0 fast path is unavailable
    // (e.g., extension not loaded or dimension mismatch with active model)
    // used to pin the main thread for the entire fallback scan, blocking
    // channel I/O. After fix the loop yields after each full
    // FALLBACK_VECTOR_BATCH_SIZE batch so a setImmediate-scheduled task can
    // interleave between batches.
    const db = new DatabaseSync(":memory:");
    try {
      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: false,
      });

      const insertChunk = db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      // Just over 3x the yield batch (FALLBACK_VECTOR_BATCH_SIZE=256), so we
      // expect at least 3 yield points to fire during the scan.
      const N = 1024;
      for (let i = 0; i < N; i += 1) {
        insertChunk.run(
          `chunk-${i}`,
          `memory/chunk-${i}.md`,
          "memory",
          1,
          1,
          `hash-${i}`,
          "yield-model",
          `chunk ${i}`,
          // Tiny 2-dim embeddings: the test asserts the yielding *cadence*,
          // not real similarity scoring (other tests cover scoring).
          JSON.stringify([Math.cos(i), Math.sin(i)]),
          i,
        );
      }

      // Heartbeat captures whether the event loop gets a chance to run between
      // setImmediate batches. With the pre-fix synchronous loop, this would
      // fire zero times during searchVector. With the fix it should fire at
      // least once because we yield ≥3 times across 1024 rows.
      let heartbeats = 0;
      const heartbeatInterval = setInterval(() => {
        heartbeats += 1;
      }, 0);

      try {
        const results = await searchVector({
          db,
          vectorTable: "memory_index_chunks_vec",
          providerModel: "yield-model",
          queryVec: [1, 0],
          limit: 4,
          snippetMaxChars: 200,
          ensureVectorReady: async () => false,
          sourceFilterVec: { sql: "", params: [] },
          sourceFilterChunks: { sql: "", params: [] },
        });
        expect(results).toHaveLength(4);
        // ≥1 heartbeat proves the event loop was given a chance to run during
        // the scan. (Exact counts depend on machine speed; we only check the
        // qualitative property that the loop is no longer fully blocked.)
        expect(heartbeats).toBeGreaterThan(0);
      } finally {
        clearInterval(heartbeatInterval);
      }
    } finally {
      db.close();
    }
  });

  // ===== Fallback path boundary coverage (issue #81172 review diligence) =====

  function createFallbackDb(): InstanceType<typeof DatabaseSync> {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: false,
      ftsEnabled: false,
    });
    return db;
  }

  function insertFallbackChunk(
    db: InstanceType<typeof DatabaseSync>,
    params: {
      id: string;
      model: string;
      vector: number[];
    },
  ): void {
    db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
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
  }

  it("returns an empty result set when no chunks match the provider model", async () => {
    const db = createFallbackDb();
    try {
      // One chunk with a different model must not appear in results.
      insertFallbackChunk(db, { id: "other-only", model: "other-model", vector: [1, 0] });
      const results = await searchVector({
        db,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "target-model",
        queryVec: [1, 0],
        limit: 5,
        snippetMaxChars: 200,
        ensureVectorReady: async () => false,
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      });
      expect(results).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("searches provider-declared model aliases while excluding arbitrary paths", async () => {
    const db = createFallbackDb();
    try {
      insertFallbackChunk(db, { id: "canonical", model: "canonical-model", vector: [1, 0] });
      insertFallbackChunk(db, { id: "alias", model: "/cache/default.gguf", vector: [0.9, 0.1] });
      insertFallbackChunk(db, { id: "arbitrary", model: "/other/default.gguf", vector: [1, 0] });

      const results = await searchVector({
        db,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "canonical-model",
        providerModelAliases: ["/cache/default.gguf"],
        queryVec: [1, 0],
        limit: 5,
        snippetMaxChars: 200,
        ensureVectorReady: async () => false,
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      });

      expect(results.map((row) => row.id)).toEqual(["canonical", "alias"]);
    } finally {
      db.close();
    }
  });

  it("searches an empty primary model without requiring aliases", async () => {
    const db = createFallbackDb();
    try {
      insertFallbackChunk(db, { id: "empty-primary", model: "", vector: [1, 0] });
      insertFallbackChunk(db, { id: "other", model: "other-model", vector: [1, 0] });

      const results = await searchVector({
        db,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "",
        queryVec: [1, 0],
        limit: 5,
        snippetMaxChars: 200,
        ensureVectorReady: async () => false,
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      });

      expect(results.map((row) => row.id)).toEqual(["empty-primary"]);
    } finally {
      db.close();
    }
  });

  it("handles a single matching row (below the yield batch size)", async () => {
    const db = createFallbackDb();
    try {
      insertFallbackChunk(db, { id: "lone", model: "target-model", vector: [1, 0] });
      const results = await searchVector({
        db,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "target-model",
        queryVec: [1, 0],
        limit: 5,
        snippetMaxChars: 200,
        ensureVectorReady: async () => false,
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      });
      expect(results.map((r) => r.id)).toEqual(["lone"]);
    } finally {
      db.close();
    }
  });

  it("handles an exact batch-size boundary (FALLBACK_VECTOR_BATCH_SIZE rows)", async () => {
    // When N === FALLBACK_VECTOR_BATCH_SIZE exactly, the loop produces one
    // full batch and then must take one extra empty-batch step before
    // breaking; verify no row is dropped or double-counted at the seam.
    const db = createFallbackDb();
    try {
      const N = 256;
      for (let i = 0; i < N; i += 1) {
        // Each chunk gets a unique vector so cosine scoring is well-defined.
        insertFallbackChunk(db, {
          id: `chunk-${i}`,
          model: "target-model",
          vector: [Math.cos(i), Math.sin(i)],
        });
      }
      const results = await searchVector({
        db,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "target-model",
        queryVec: [1, 0],
        limit: 3,
        snippetMaxChars: 200,
        ensureVectorReady: async () => false,
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      });
      expect(results).toHaveLength(3);
      // Strictly decreasing scores confirms top-K maintenance is intact.
      for (let i = 1; i < results.length; i += 1) {
        expect(results[i - 1].score).toBeGreaterThan(results[i].score);
      }
    } finally {
      db.close();
    }
  });

  it("preserves top-K ordering vs. a naive reference cosine implementation", async () => {
    // Guards against accidental algorithmic regressions from the control-flow
    // refactor: insert 200 chunks with random vectors and assert our patched
    // fallback search returns the same top-K by id, in the same order, as a
    // straight-line JS reference that scores every row.
    const db = createFallbackDb();
    try {
      const dim = 16;
      const N = 200;
      const limit = 5;
      // Use a deterministic seed-free PRNG-equivalent: hash-derived floats so
      // the test is repeatable across machines.
      const vectorFor = (i: number, j: number): number => {
        const s = Math.sin(i * 31 + j * 17 + 3) * 1000;
        return s - Math.floor(s) - 0.5;
      };
      const chunks: Array<{ id: string; vector: number[] }> = [];
      for (let i = 0; i < N; i += 1) {
        const vector = Array.from({ length: dim }, (_, j) => vectorFor(i, j));
        chunks.push({ id: `chunk-${i}`, vector });
        insertFallbackChunk(db, { id: `chunk-${i}`, model: "target-model", vector });
      }
      const queryVec = Array.from({ length: dim }, (_, j) => vectorFor(-1, j));

      function refCosine(a: number[], b: number[]): number {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i += 1) {
          dot += a[i] * b[i];
          normA += a[i] * a[i];
          normB += b[i] * b[i];
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
      }
      const referenceTopIds = chunks
        .map((c) => ({ id: c.id, score: refCosine(queryVec, c.vector) }))
        .toSorted((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => r.id);

      const results = await searchVector({
        db,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "target-model",
        queryVec,
        limit,
        snippetMaxChars: 200,
        ensureVectorReady: async () => false,
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      });
      expect(results.map((r) => r.id)).toEqual(referenceTopIds);
    } finally {
      db.close();
    }
  });

  it("picks up rows inserted during the inter-batch event-loop yield (rowid cursor)", async () => {
    // The fix's rowid-paginated batches yield via setImmediate between batches.
    // Schedule an INSERT to land in that yield gap and verify the search picks
    // up the new rows in the next batch: no double-counting, no missed rows.
    const db = createFallbackDb();
    try {
      // 257 baseline rows: first batch sees 256 (score 0 vs. query), second
      // batch would have seen just 1 until our setImmediate insert lands.
      const baselineCount = 257;
      for (let i = 0; i < baselineCount; i += 1) {
        insertFallbackChunk(db, {
          id: `baseline-${i}`,
          model: "target-model",
          // Perpendicular to the query: cosine 0.
          vector: [0, 1],
        });
      }

      // setImmediate fires during the search's first inter-batch yield. We
      // queue an insert of two near-perfect matches; their rowids (258, 259)
      // are strictly greater than `lastRowid` (256), so the rowid cursor
      // must include them in batch 2.
      let inserted = false;
      const insertDuringYield = (): void => {
        if (inserted) {
          return;
        }
        inserted = true;
        insertFallbackChunk(db, {
          id: "winner-A",
          model: "target-model",
          vector: [1, 0],
        });
        insertFallbackChunk(db, {
          id: "winner-B",
          model: "target-model",
          vector: [0.9, 0.1],
        });
      };
      setImmediate(insertDuringYield);

      const results = await searchVector({
        db,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "target-model",
        queryVec: [1, 0],
        limit: 2,
        snippetMaxChars: 200,
        ensureVectorReady: async () => false,
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      });

      // The winners must dominate the top-2. If the rowid cursor were broken
      // (either skipping or duplicating rows past the yield), one of these
      // would be wrong.
      expect(inserted).toBe(true);
      expect(results.map((r) => r.id)).toEqual(["winner-A", "winner-B"]);
    } finally {
      db.close();
    }
  });

  it("falls back when filters hide matches beyond sqlite-vec's KNN cap", async () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    try {
      const loaded = await loadSqliteVecExtension({ db });
      expect(loaded.ok, loaded.error).toBe(true);
      ensureMemoryIndexSchema({
        db,
        cacheEnabled: false,
        ftsEnabled: false,
      });
      db.exec(`
        CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[2]
        );
      `);

      const insertChunk = db.prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insertVector = db.prepare(
        "INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)",
      );
      const addChunk = (params: {
        id: string;
        model: string;
        source: "memory" | "sessions";
        vector: [number, number];
      }) => {
        insertChunk.run(
          params.id,
          `memory/${params.id}.md`,
          params.source,
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
        addChunk({
          id: `other-${i}`,
          model: "other-model",
          source: "memory",
          vector: [1, 0],
        });
      }
      addChunk({
        id: "target",
        model: "target-model",
        source: "memory",
        vector: [0.5, 0.5],
      });
      addChunk({
        id: "alias",
        model: "alias-model",
        source: "memory",
        vector: [0.4, 0.6],
      });

      const belowCapResults = await searchVector({
        db,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "target-model",
        providerModelAliases: ["alias-model"],
        queryVec: [1, 0],
        limit: 2,
        snippetMaxChars: 200,
        ensureVectorReady: async () => true,
        sourceFilterVec: { sql: "", params: [] },
        sourceFilterChunks: { sql: "", params: [] },
      });
      expect(belowCapResults.map((row) => row.id)).toEqual(["target", "alias"]);

      db.exec("BEGIN");
      for (let i = 20; i < 4097; i += 1) {
        addChunk({
          id: `other-${i}`,
          model: "other-model",
          source: "memory",
          vector: [1, 0],
        });
      }
      addChunk({
        id: "wrong-source",
        model: "target-model",
        source: "sessions",
        vector: [0.6, 0.4],
      });
      db.exec("COMMIT");

      const overLimitQuery = db.prepare(
        "SELECT id FROM memory_index_chunks_vec WHERE embedding MATCH ? AND k = ?",
      );
      expect(() => overLimitQuery.all(vectorToBlob([1, 0]), 4097)).toThrow(
        "k value in knn query too large, provided 4097 and the limit is 4096",
      );

      const results = await searchVector({
        db,
        vectorTable: "memory_index_chunks_vec",
        providerModel: "target-model",
        providerModelAliases: ["alias-model"],
        queryVec: [1, 0],
        limit: 2,
        snippetMaxChars: 200,
        ensureVectorReady: async () => true,
        sourceFilterVec: { sql: " AND c.source IN (?)", params: ["memory"] },
        sourceFilterChunks: { sql: " AND source IN (?)", params: ["memory"] },
      });

      expect(results.map((row) => row.id)).toEqual(["target", "alias"]);
    } finally {
      db.close();
    }
  });
});
