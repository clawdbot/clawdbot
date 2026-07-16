import type { SQLInputValue } from "node:sqlite";

type VectorWriteDb = {
  prepare: (sql: string) => {
    run: (...params: SQLInputValue[]) => unknown;
  };
};

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

export function replaceMemoryVectorRow(params: {
  db: VectorWriteDb;
  id: string;
  embedding: number[];
  tableName?: string;
}): void {
  const tableName = params.tableName ?? "chunks_vec";
  try {
    params.db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(params.id);
  } catch {}
  params.db
    .prepare(`INSERT INTO ${tableName} (id, embedding) VALUES (?, ?)`)
    .run(params.id, vectorToBlob(params.embedding));
}
