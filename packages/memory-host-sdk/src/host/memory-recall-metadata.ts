import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./openclaw-runtime-sqlite.js";

type MemoryRecallMetadataDatabase = {
  memory_index_chunks: {
    id: string;
    importance: number | null;
    path: string;
    source: string;
    start_line: number;
    end_line: number;
    text: string;
    triggers: string | null;
  };
};

export function readMemoryRecallMetadata(db: DatabaseSync, ids: readonly string[]) {
  if (ids.length === 0) {
    return new Map<string, { importance: number | null; triggers: string | null }>();
  }
  const query = getNodeSqliteKysely<MemoryRecallMetadataDatabase>(db)
    .selectFrom("memory_index_chunks")
    .select(["id", "importance", "triggers"])
    .where("id", "in", [...ids]);
  return new Map(executeSqliteQuerySync(db, query).rows.map((row) => [row.id, row]));
}

export function readCuratedMemoryTriggerCandidates(db: DatabaseSync, limit: number) {
  const query = getNodeSqliteKysely<MemoryRecallMetadataDatabase>(db)
    .selectFrom("memory_index_chunks")
    .select(["id", "path", "source", "start_line", "end_line", "text", "importance", "triggers"])
    .where("source", "=", "memory")
    .where("path", "in", ["MEMORY.md", "USER.md"])
    .where("triggers", "is not", null)
    .orderBy("path")
    .orderBy("id")
    .limit(limit);
  return executeSqliteQuerySync(db, query).rows;
}
