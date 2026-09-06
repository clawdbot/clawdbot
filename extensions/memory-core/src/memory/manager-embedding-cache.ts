// Memory Core plugin module implements manager embedding cache behavior.
import type { DatabaseSync } from "node:sqlite";
import {
  parseEmbedding,
  type MemoryChunk,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  compileSqliteQueryBindings,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import type { MemoryIndexProviderIdentity } from "./manager-reindex-state.js";

export type MemoryEmbeddingCacheRow = {
  provider: string;
  model: string;
  provider_key: string;
  hash: string;
  embedding: string;
  dims: number | null;
  updated_at: number;
};

type EmbeddingCacheDatabase = {
  memory_embedding_cache: MemoryEmbeddingCacheRow;
};

export function loadMemoryEmbeddingCache(params: {
  db: DatabaseSync;
  enabled: boolean;
  providerIdentities: MemoryIndexProviderIdentity[];
  hashes: string[];
}): Map<string, number[]> {
  if (!params.enabled || params.providerIdentities.length === 0 || params.hashes.length === 0) {
    return new Map();
  }
  const unresolved = new Set(params.hashes.filter(Boolean));
  if (unresolved.size === 0) {
    return new Map();
  }

  const db = getNodeSqliteKysely<EmbeddingCacheDatabase>(params.db);
  const out = new Map<string, number[]>();
  const batchSize = 400;
  for (const identity of params.providerIdentities) {
    if (unresolved.size === 0) {
      break;
    }
    const hashes = [...unresolved];
    for (let start = 0; start < hashes.length; start += batchSize) {
      const batch = hashes.slice(start, start + batchSize);
      const query = db
        .selectFrom("memory_embedding_cache")
        .select(["hash", "embedding"])
        .where("provider", "=", identity.provider)
        .where("model", "=", identity.model)
        .where("provider_key", "=", identity.providerKey)
        .where("hash", "in", batch);
      for (const row of iterateSqliteQuerySync(params.db, query)) {
        // The first stored row wins even when its vector needs to be regenerated.
        out.set(row.hash, parseEmbedding(row.embedding));
        unresolved.delete(row.hash);
      }
    }
  }
  return out;
}

export function prepareMemoryEmbeddingCacheUpsert(db: DatabaseSync) {
  const { compiled, bind } = compileSqliteQueryBindings<MemoryEmbeddingCacheRow>((parameter) =>
    getNodeSqliteKysely<EmbeddingCacheDatabase>(db)
      .insertInto("memory_embedding_cache")
      .values({
        provider: parameter((row) => row.provider),
        model: parameter((row) => row.model),
        provider_key: parameter((row) => row.provider_key),
        hash: parameter((row) => row.hash),
        embedding: parameter((row) => row.embedding),
        dims: parameter((row) => row.dims),
        updated_at: parameter((row) => row.updated_at),
      })
      .onConflict((conflict) =>
        conflict.columns(["provider", "model", "provider_key", "hash"]).doUpdateSet((eb) => ({
          embedding: eb.ref("excluded.embedding"),
          dims: eb.ref("excluded.dims"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      ),
  );
  // The caller owns this statement for its write loop, including large embedding bindings.
  const statement = db.prepare(compiled.sql);
  return (row: MemoryEmbeddingCacheRow) => statement.run(...bind(row));
}

export function upsertMemoryEmbeddingCache(params: {
  db: DatabaseSync;
  enabled: boolean;
  provider: { id: string; model: string } | null;
  providerKey: string | null;
  entries: Array<{ hash: string; embedding: number[] }>;
  now?: number;
}): void {
  const provider = params.provider;
  if (!params.enabled || !provider || !params.providerKey || params.entries.length === 0) {
    return;
  }
  const now = params.now ?? Date.now();
  const upsert = prepareMemoryEmbeddingCacheUpsert(params.db);
  for (const entry of params.entries) {
    const embedding = entry.embedding ?? [];
    upsert({
      provider: provider.id,
      model: provider.model,
      provider_key: params.providerKey,
      hash: entry.hash,
      embedding: JSON.stringify(embedding),
      dims: embedding.length,
      updated_at: now,
    });
  }
}

export function collectMemoryCachedEmbeddings<T extends Pick<MemoryChunk, "hash">>(params: {
  chunks: T[];
  cached: Map<string, number[]>;
}): {
  embeddings: number[][];
  missing: Array<{ index: number; chunk: T }>;
} {
  const embeddings: number[][] = Array.from({ length: params.chunks.length }, () => []);
  const missing: Array<{ index: number; chunk: T }> = [];

  for (let index = 0; index < params.chunks.length; index += 1) {
    const chunk = params.chunks[index];
    const hit = chunk?.hash ? params.cached.get(chunk.hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[index] = hit;
    } else if (chunk) {
      missing.push({ index, chunk });
    }
  }

  return { embeddings, missing };
}
