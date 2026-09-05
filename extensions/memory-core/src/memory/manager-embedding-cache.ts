// Memory Core plugin module implements manager embedding cache behavior.
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  parseEmbedding,
  type MemoryChunk,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type EmbeddingCacheDb = Pick<DatabaseSync, "prepare">;

type EmbeddingProviderIdentity = {
  provider: string;
  model: string;
  providerKey: string;
};

export function loadMemoryEmbeddingCache(params: {
  db: EmbeddingCacheDb;
  enabled: boolean;
  providerIdentities: EmbeddingProviderIdentity[];
  hashes: string[];
  tableName?: string;
}): Map<string, number[]> {
  if (!params.enabled || params.providerIdentities.length === 0 || params.hashes.length === 0) {
    return new Map();
  }
  const unresolved = new Set(params.hashes.filter(Boolean));
  if (unresolved.size === 0) {
    return new Map();
  }

  const tableName = params.tableName ?? "memory_embedding_cache";
  const out = new Map<string, number[]>();
  const batchSize = 400;
  for (const identity of params.providerIdentities) {
    if (unresolved.size === 0) {
      break;
    }
    const hashes = [...unresolved];
    const baseParams: SQLInputValue[] = [identity.provider, identity.model, identity.providerKey];
    for (let start = 0; start < hashes.length; start += batchSize) {
      const batch = hashes.slice(start, start + batchSize);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = params.db
        .prepare(
          `SELECT hash, embedding FROM ${tableName}\n` +
            ` WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
        )
        .all(...baseParams, ...batch) as Array<{ hash: string; embedding: string }>;
      for (const row of rows) {
        // The first stored row wins even when its vector needs to be regenerated.
        out.set(row.hash, parseEmbedding(row.embedding));
        unresolved.delete(row.hash);
      }
    }
  }
  return out;
}

export function upsertMemoryEmbeddingCache(params: {
  db: EmbeddingCacheDb;
  enabled: boolean;
  provider: { id: string; model: string } | null;
  providerKey: string | null;
  entries: Array<{ hash: string; embedding: number[] }>;
  now?: number;
  tableName?: string;
}): void {
  const provider = params.provider;
  if (!params.enabled || !provider || !params.providerKey || params.entries.length === 0) {
    return;
  }
  const tableName = params.tableName ?? "memory_embedding_cache";
  const now = params.now ?? Date.now();
  const stmt = params.db.prepare(
    `INSERT INTO ${tableName} (provider, model, provider_key, hash, embedding, dims, updated_at)\n` +
      ` VALUES (?, ?, ?, ?, ?, ?, ?)\n` +
      ` ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n` +
      `   embedding=excluded.embedding,\n` +
      `   dims=excluded.dims,\n` +
      `   updated_at=excluded.updated_at`,
  );
  for (const entry of params.entries) {
    const embedding = entry.embedding ?? [];
    stmt.run(
      provider.id,
      provider.model,
      params.providerKey,
      entry.hash,
      JSON.stringify(embedding),
      embedding.length,
      now,
    );
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
