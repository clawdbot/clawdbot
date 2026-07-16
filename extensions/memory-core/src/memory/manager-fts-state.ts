import type { DatabaseSync } from "node:sqlite";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function deleteMemoryFtsRows(params: {
  db: DatabaseSync;
  tableName?: string;
  path: string;
  source: MemorySource;
  currentModel?: string;
}): void {
  const tableName = params.tableName ?? "chunks_fts";
  if (params.currentModel) {
    params.db
      .prepare(`DELETE FROM ${tableName} WHERE path = ? AND source = ? AND model = ?`)
      .run(params.path, params.source, params.currentModel);
    return;
  }
  params.db
    .prepare(`DELETE FROM ${tableName} WHERE path = ? AND source = ?`)
    .run(params.path, params.source);
}
