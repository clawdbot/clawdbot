// Memory Core plugin module implements manager vector write behavior.
import type { SQLInputValue } from "node:sqlite";
import { vectorToBlob } from "./vector-blob.js";

type VectorWriteDb = {
  prepare: (sql: string) => {
    run: (...params: SQLInputValue[]) => unknown;
  };
};

export function replaceMemoryVectorRow(params: {
  db: VectorWriteDb;
  id: string;
  embedding: number[];
  tableName?: string;
}): void {
  const tableName = params.tableName ?? "memory_index_chunks_vec";
  try {
    params.db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(params.id);
  } catch {}
  params.db
    .prepare(`INSERT INTO ${tableName} (id, embedding) VALUES (?, ?)`)
    .run(params.id, vectorToBlob(params.embedding));
}
