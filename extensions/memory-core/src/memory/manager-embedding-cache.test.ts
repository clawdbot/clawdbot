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
  const { DatabaseSync } = requireNodeSqlite();

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
    try {
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "openai", model: "text-embedding-3-small" },
        providerKey: "provider-key",
        entries: [
          { hash: "a", embedding: [0.1, 0.2] },
          { hash: "b", embedding: [0.3, 0.4] },
        ],
        now: 123,
      });

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
          ["a", [0.1, 0.2]],
          ["b", [0.3, 0.4]],
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("loads provider-declared alias cache rows without accepting arbitrary identities", () => {
    const db = createDb();
    try {
      upsertMemoryEmbeddingCache({
        db,
        enabled: true,
        provider: { id: "local", model: "/cache/default.gguf" },
        providerKey: "provider-key-alias",
        entries: [{ hash: "alias", embedding: [0.1, 0.2] }],
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
        hashes: ["alias", "arbitrary"],
      });

      expect(cached).toEqual(new Map([["alias", [0.1, 0.2]]]));
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
