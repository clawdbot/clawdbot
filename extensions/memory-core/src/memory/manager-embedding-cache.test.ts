// Memory Core tests cover manager embedding cache plugin behavior.
import {
  ensureMemoryIndexSchema,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import {
  collectMemoryCachedEmbeddings,
  loadMemoryEmbeddingCache,
  upsertMemoryEmbeddingCache,
} from "./manager-embedding-cache.js";

describe("memory embedding cache", () => {
  const { DatabaseSync, StatementSync } = requireNodeSqlite();

  function createDb() {
    const db = new DatabaseSync(":memory:");
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: false,
      ftsTokenizer: "unicode61",
    });
    return db;
  }

  it("loads cached embeddings for the active provider key", () => {
    const db = createDb();
    const prepare = vi.spyOn(db, "prepare");
    const columns = vi.spyOn(StatementSync.prototype, "columns");
    const largeEmbedding = Array.from({ length: 4096 }, () => 0.1234567890123456);
    try {
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "openai", model: "text-embedding-3-small" },
        providerKey: "provider-key",
        entries: [
          { hash: "a", embedding: [0.1, 0.2] },
          { hash: "b", embedding: [0.3, 0.4] },
          { hash: "a", embedding: largeEmbedding },
        ],
        now: 123,
      });
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(columns).not.toHaveBeenCalled();
      expect(
        db.prepare("SELECT hash, dims, updated_at FROM memory_embedding_cache ORDER BY hash").all(),
      ).toEqual([
        { hash: "a", dims: 4096, updated_at: 123 },
        { hash: "b", dims: 2, updated_at: 123 },
      ]);

      const cached = loadMemoryEmbeddingCache({
        db,
        enabled: true,
        providerIdentities: [
          {
            provider: "openai",
            model: "text-embedding-3-small",
            providerKey: "provider-key",
          },
        ],
        hashes: ["a", "b", "a"],
      });

      expect(cached).toEqual(
        new Map([
          ["a", largeEmbedding],
          ["b", [0.3, 0.4]],
        ]),
      );
    } finally {
      prepare.mockRestore();
      columns.mockRestore();
      db.close();
    }
  });

  it("loads provider-declared alias cache rows without accepting arbitrary identities", () => {
    const db = createDb();
    try {
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "local", model: "hf:owner/default.gguf" },
        providerKey: "provider-key-current",
        entries: [
          { hash: "overlap", embedding: [1, 2] },
          { hash: "empty", embedding: [] },
          { hash: "invalid", embedding: [] },
        ],
      });
      db.prepare("UPDATE memory_embedding_cache SET embedding = ? WHERE hash = ?").run(
        "invalid JSON",
        "invalid",
      );
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "local", model: "/cache/default.gguf" },
        providerKey: "provider-key-alias",
        entries: ["alias", "overlap", "empty", "invalid"].map((hash) => ({
          hash,
          embedding: [0.1, 0.2],
        })),
      });
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "local", model: "/other/default.gguf" },
        providerKey: "provider-key-arbitrary",
        entries: [{ hash: "arbitrary", embedding: [0.3, 0.4] }],
      });

      const cached = loadMemoryEmbeddingCache({
        db,
        enabled: true,
        providerIdentities: [
          {
            provider: "local",
            model: "hf:owner/default.gguf",
            providerKey: "provider-key-current",
          },
          {
            provider: "local",
            model: "/cache/default.gguf",
            providerKey: "provider-key-alias",
          },
        ],
        hashes: ["alias", "arbitrary", "overlap", "empty", "invalid", "overlap", ""],
      });

      expect(cached).toEqual(
        new Map([
          ["overlap", [1, 2]],
          ["empty", []],
          ["invalid", []],
          ["alias", [0.1, 0.2]],
        ]),
      );
      const { missing } = collectMemoryCachedEmbeddings({
        chunks: ["overlap", "empty", "invalid", "alias", "arbitrary"].map((hash) => ({ hash })),
        cached,
      });
      expect(missing.map(({ chunk }) => chunk.hash)).toEqual(["empty", "invalid", "arbitrary"]);
    } finally {
      db.close();
    }
  });

  it.each([0, 200, 401])(
    "reads each requested cache row at most once with %i canonical hits",
    (canonicalHits) => {
      const db = createDb();
      try {
        const hashes = Array.from({ length: 401 }, (_, index) => `hash-${index}`);
        const providerIdentities = Array.from({ length: 4 }, (_, index) => ({
          provider: "local",
          model: `model-${index}`,
          providerKey: `provider-key-${index}`,
        }));
        for (const [index, identity] of providerIdentities.entries()) {
          upsertMemoryEmbeddingCache({
            db,
            enabled: true,
            provider: { id: identity.provider, model: identity.model },
            providerKey: identity.providerKey,
            entries: (index === 0 ? hashes.slice(0, canonicalHits) : hashes).map((hash) => ({
              hash,
              embedding: [index + 1],
            })),
          });
        }
        const reads: Array<{ bindings: number; rows: number }> = [];
        const prepare = db.prepare.bind(db);
        vi.spyOn(db, "prepare").mockImplementation((sql) => {
          const statement = prepare(sql);
          const iterate = statement.iterate.bind(statement);
          vi.spyOn(statement, "iterate").mockImplementation(function* (...bindings) {
            const read = { bindings: bindings.length, rows: 0 };
            reads.push(read);
            for (const row of iterate(...bindings)) {
              read.rows += 1;
              yield row;
            }
            return undefined;
          });
          return statement;
        });

        const cached = loadMemoryEmbeddingCache({
          db,
          enabled: true,
          providerIdentities,
          hashes: [...hashes, ...hashes.slice(0, 1), ""],
        });

        expect(cached).toEqual(
          new Map(hashes.map((hash, index) => [hash, [index < canonicalHits ? 1 : 2]])),
        );
        expect(reads.every(({ bindings }) => bindings <= 403)).toBe(true);
        expect(reads.reduce((total, { rows }) => total + rows, 0)).toBe(hashes.length);
        expect(reads.length).toBeLessThanOrEqual(2 + Math.ceil((401 - canonicalHits) / 400));
      } finally {
        db.close();
      }
    },
  );

  it("propagates a native cache read failure without retaining a partial cursor", () => {
    const db = createDb();
    try {
      const identity = { provider: "local", model: "fixture", providerKey: "fixture" };
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: identity.provider, model: identity.model },
        providerKey: identity.providerKey,
        entries: ["first", "second"].map((hash) => ({ hash, embedding: [1, 2] })),
      });
      let reads = 0;
      db.function("read_embedding", (value) => {
        if (++reads === 2) {
          throw new Error("cache step failed");
        }
        return value;
      });
      db.exec(`
        ALTER TABLE memory_embedding_cache RENAME TO stored_cache;
        CREATE VIEW memory_embedding_cache AS SELECT
          provider, model, provider_key, hash, read_embedding(embedding) AS embedding
          FROM stored_cache;
      `);
      const load = () =>
        loadMemoryEmbeddingCache({
          db,
          enabled: true,
          providerIdentities: [identity],
          hashes: ["first", "second"],
        });
      expect(load).toThrow("cache step failed");
      db.exec(
        "DROP VIEW memory_embedding_cache; ALTER TABLE stored_cache RENAME TO memory_embedding_cache",
      );
      expect(load()).toEqual(
        new Map([
          ["first", [1, 2]],
          ["second", [1, 2]],
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("reuses cached embeddings on forced reindex instead of scheduling new embeds", () => {
    const cached = new Map<string, number[]>([
      ["alpha", [0.1, 0.2]],
      ["beta", [0.3, 0.4]],
    ]);
    const embedMissing = vi.fn();

    const plan = collectMemoryCachedEmbeddings({
      chunks: [{ hash: "alpha" }, { hash: "beta" }],
      cached,
    });

    if (plan.missing.length > 0) {
      embedMissing(plan.missing);
    }

    expect(plan.embeddings).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(plan.missing).toHaveLength(0);
    expect(embedMissing).not.toHaveBeenCalled();
  });
});
