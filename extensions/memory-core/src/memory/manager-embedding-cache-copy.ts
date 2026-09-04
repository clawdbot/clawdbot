// Memory Core plugin module copies derived embedding cache rows without blocking the event loop.
import type { DatabaseSync } from "node:sqlite";
import { MEMORY_EMBEDDING_CACHE_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { withMemoryWorkspaceLock } from "../memory-workspace-lock.js";
import { readMemoryDatabaseRevision } from "./manager-db.js";

// Production embeddings measured ~28 KB/row; 1,000-row synchronous commits
// blocked the event loop for seconds. Keep each commit small between yields.
const EMBEDDING_CACHE_COPY_BATCH_SIZE = 100;

type EmbeddingCacheRow = {
  rowid: number;
  provider: string;
  model: string;
  provider_key: string;
  hash: string;
  embedding: string;
  dims: number | null;
  updated_at: number;
};

export async function copyMemoryEmbeddingCache(params: {
  sourceDb: DatabaseSync;
  targetDb: DatabaseSync;
  cacheEnabled: boolean;
  workspaceDir: string;
  expectedRevision?: number;
}): Promise<boolean> {
  if (!params.cacheEnabled) {
    return true;
  }
  const selectBatch = params.sourceDb.prepare(
    `SELECT rowid, provider, model, provider_key, hash, embedding, dims, updated_at
     FROM ${MEMORY_EMBEDDING_CACHE_TABLE}
     WHERE rowid > ?
     ORDER BY rowid
     LIMIT ?`,
  );
  const insert = params.targetDb.prepare(
    `INSERT INTO ${MEMORY_EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
       embedding=excluded.embedding,
       dims=excluded.dims,
       updated_at=excluded.updated_at`,
  );
  const runBatch = async (write: () => void): Promise<boolean> => {
    const transact = () =>
      runSqliteImmediateTransactionSync(
        params.targetDb,
        () => {
          if (
            params.expectedRevision !== undefined &&
            readMemoryDatabaseRevision(params.targetDb) !== params.expectedRevision
          ) {
            return false;
          }
          write();
          return true;
        },
        {
          operationLabel:
            params.expectedRevision === undefined
              ? "memory.embedding-cache.seed"
              : "memory.embedding-cache.publish",
        },
      );
    return params.expectedRevision === undefined
      ? transact()
      : await withMemoryWorkspaceLock(params.workspaceDir, async () => transact());
  };
  const yieldToEventLoop = async () =>
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

  if (params.expectedRevision !== undefined) {
    const deleteBatch = params.targetDb.prepare(
      `DELETE FROM ${MEMORY_EMBEDDING_CACHE_TABLE}
       WHERE rowid IN (
         SELECT rowid FROM ${MEMORY_EMBEDDING_CACHE_TABLE} ORDER BY rowid LIMIT ?
       )`,
    );
    while (true) {
      let deleted = 0;
      if (
        !(await runBatch(() => {
          deleted = Number(deleteBatch.run(EMBEDDING_CACHE_COPY_BATCH_SIZE).changes);
        }))
      ) {
        return false;
      }
      if (deleted === 0) {
        break;
      }
      await yieldToEventLoop();
    }
  }

  let lastRowid = 0;
  while (true) {
    // Materialize each source page so neither a read cursor nor a write
    // transaction remains open when control returns to the event loop.
    const batch = selectBatch.all(
      lastRowid,
      EMBEDDING_CACHE_COPY_BATCH_SIZE,
    ) as EmbeddingCacheRow[];
    if (batch.length === 0) {
      return true;
    }
    if (
      !(await runBatch(() => {
        for (const row of batch) {
          insert.run(
            row.provider,
            row.model,
            row.provider_key,
            row.hash,
            row.embedding,
            row.dims,
            row.updated_at,
          );
        }
      }))
    ) {
      return false;
    }
    lastRowid = batch.at(-1)?.rowid ?? lastRowid;
    if (batch.length < EMBEDDING_CACHE_COPY_BATCH_SIZE) {
      return true;
    }
    await yieldToEventLoop();
  }
}
