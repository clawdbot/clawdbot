import { DatabaseSync } from "node:sqlite";
import { MEMORY_INDEX_META_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePersistedMemoryVectorIndexState } from "./manager-vector-rebuild-state.js";

describe("persisted memory vector index state", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE ${MEMORY_INDEX_META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY);
    `);
  });

  afterEach(() => db.close());

  it("trusts a clean published index even when an incremental first write has no dimensions metadata", () => {
    db.prepare(`INSERT INTO ${MEMORY_INDEX_META_TABLE} (key, value) VALUES (?, 'clean')`).run(
      "memory_vector_rebuild_v1",
    );

    expect(
      resolvePersistedMemoryVectorIndexState({
        db,
        vectorTable: "memory_index_chunks_vec",
        hasSemanticChunks: true,
      }),
    ).toEqual({ state: "complete" });
  });

  it("keeps a pre-marker vector index unverified", () => {
    expect(
      resolvePersistedMemoryVectorIndexState({
        db,
        vectorTable: "memory_index_chunks_vec",
        metaVectorDims: 768,
        hasSemanticChunks: true,
      }),
    ).toEqual({ state: "unverified" });
  });
});
