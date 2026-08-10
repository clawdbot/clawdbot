import type { DatabaseSync } from "node:sqlite";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { bm25RankToScore, buildFtsQuery } from "./hybrid.js";

export type ScopedMemoryCandidate = Readonly<{
  chunkId: string;
  revisionId: string;
  score: number;
  vectorScore?: number;
  textScore?: number;
}>;

export type ScopedMemoryCandidatePageParams = Readonly<{
  database: DatabaseSync;
  query: string;
  queryVector?: readonly number[];
  storeIds: readonly string[];
  sources: readonly MemorySource[];
  limit: number;
  offset: number;
  /** Candidates are only a prefilter, but retired/expired revisions can never be returned. */
  nowMs?: number;
}>;

export type ScopedMemoryCandidatePageReader = (
  params: ScopedMemoryCandidatePageParams,
) => readonly ScopedMemoryCandidate[];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** FTS candidates carry only opaque identifiers from the already-selected scoped view. */
export const readScopedMemoryFtsCandidatePage: ScopedMemoryCandidatePageReader = (params) => {
  if (params.storeIds.length === 0 || params.limit <= 0) {
    return [];
  }
  const matchQuery = buildFtsQuery(params.query);
  if (!matchQuery) {
    return [];
  }
  const storePlaceholders = params.storeIds.map(() => "?").join(", ");
  const sourcePlaceholders = params.sources.map(() => "?").join(", ");
  // sqlite-allow-raw -- FTS MATCH and a view-sized IN list are SQLite primitives.
  const rows = params.database
    .prepare(
      `SELECT chunk.chunk_id, chunk.revision_id, bm25(memory_scoped_chunks_fts) AS rank
         FROM memory_scoped_chunks_fts
         JOIN memory_scoped_chunks AS chunk ON chunk.chunk_key = memory_scoped_chunks_fts.rowid
         JOIN memory_resource_revisions AS revision ON revision.revision_id = chunk.revision_id
         JOIN memory_resources AS resource ON resource.resource_id = revision.resource_id
        WHERE memory_scoped_chunks_fts MATCH ?
          AND resource.store_id IN (${storePlaceholders})
          AND resource.source IN (${sourcePlaceholders})
          AND revision.lifecycle_state = 'active'
          AND (revision.expires_at IS NULL OR revision.expires_at > ?)
        ORDER BY rank ASC, chunk.chunk_id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(
      matchQuery,
      ...params.storeIds,
      ...params.sources,
      params.nowMs ?? Date.now(),
      params.limit,
      params.offset,
    ) as Array<{
    chunk_id: string;
    revision_id: string;
    rank: number;
  }>;
  return rows.map((row) => ({
    chunkId: row.chunk_id,
    revisionId: row.revision_id,
    score: bm25RankToScore(row.rank),
    textScore: bm25RankToScore(row.rank),
  }));
};

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** Bounded same-store vector scan used when a scoped sqlite-vec table is unavailable. */
export const readScopedMemoryVectorCandidatePage: ScopedMemoryCandidatePageReader = (params) => {
  if (!params.queryVector?.length || params.storeIds.length === 0 || params.limit <= 0) {
    return [];
  }
  const storePlaceholders = params.storeIds.map(() => "?").join(", ");
  const sourcePlaceholders = params.sources.map(() => "?").join(", ");
  // sqlite-allow-raw -- Reads only scoped vector payloads for an in-process cosine scan.
  const rows = params.database
    .prepare(
      `SELECT chunk.chunk_id, chunk.revision_id, vector.embedding
         FROM memory_scoped_chunk_vectors AS vector
         JOIN memory_scoped_chunks AS chunk ON chunk.chunk_id = vector.chunk_id
         JOIN memory_resource_revisions AS revision ON revision.revision_id = chunk.revision_id
         JOIN memory_resources AS resource ON resource.resource_id = revision.resource_id
        WHERE resource.store_id IN (${storePlaceholders})
          AND resource.source IN (${sourcePlaceholders})
          AND revision.lifecycle_state = 'active'
          AND (revision.expires_at IS NULL OR revision.expires_at > ?)
        ORDER BY chunk.chunk_id ASC`,
    )
    .all(...params.storeIds, ...params.sources, params.nowMs ?? Date.now()) as Array<{
    chunk_id: string;
    revision_id: string;
    embedding: string;
  }>;
  return rows
    .flatMap((row) => {
      try {
        const embedding = JSON.parse(row.embedding) as unknown;
        if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number")) {
          return [];
        }
        const score = cosineSimilarity(params.queryVector ?? [], embedding);
        return [{ chunkId: row.chunk_id, revisionId: row.revision_id, score, vectorScore: score }];
      } catch {
        return [];
      }
    })
    .toSorted((left, right) => right.score - left.score || compareText(left.chunkId, right.chunkId))
    .slice(params.offset, params.offset + params.limit);
};

function vectorToBlob(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

/** sqlite-vec KNN reader; any absence falls back only to the same scoped vectors. */
export const readScopedMemorySqliteVecCandidatePage: ScopedMemoryCandidatePageReader = (params) => {
  if (!params.queryVector?.length || params.storeIds.length === 0 || params.limit <= 0) {
    return [];
  }
  const hasVectorIndex = Boolean(
    params.database
      .prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
      .get("memory_scoped_chunks_vec"),
  );
  if (!hasVectorIndex) {
    return readScopedMemoryVectorCandidatePage(params);
  }
  const storePlaceholders = params.storeIds.map(() => "?").join(", ");
  const sourcePlaceholders = params.sources.map(() => "?").join(", ");
  // sqlite-allow-raw -- vec0 applies k before joins, so full scoped filtering is required.
  const rows = params.database
    .prepare(
      `SELECT chunk.chunk_id, chunk.revision_id,
              vec_distance_cosine(vector.embedding, ?) AS distance
         FROM memory_scoped_chunks_vec AS vector
         JOIN memory_scoped_chunks AS chunk ON chunk.chunk_id = vector.chunk_id
         JOIN memory_resource_revisions AS revision ON revision.revision_id = chunk.revision_id
         JOIN memory_resources AS resource ON resource.resource_id = revision.resource_id
        WHERE resource.store_id IN (${storePlaceholders})
          AND resource.source IN (${sourcePlaceholders})
          AND revision.lifecycle_state = 'active'
          AND (revision.expires_at IS NULL OR revision.expires_at > ?)
        ORDER BY distance ASC, chunk.chunk_id ASC
        LIMIT ? OFFSET ?`,
    )
    .all(
      vectorToBlob(params.queryVector),
      ...params.storeIds,
      ...params.sources,
      params.nowMs ?? Date.now(),
      params.limit,
      params.offset,
    ) as Array<{ chunk_id: string; revision_id: string; distance: number }>;
  return rows.map((row) => {
    const score = Math.max(0, Math.min(1, 1 - row.distance));
    return { chunkId: row.chunk_id, revisionId: row.revision_id, score, vectorScore: score };
  });
};
