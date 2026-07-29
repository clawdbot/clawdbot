import type { DatabaseSync } from "node:sqlite";
import { INVALID_PROJECT_ANNOTATION_KEY } from "./internal.js";
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
    project_key: string | null;
  };
};

export function readMemoryRecallMetadata(db: DatabaseSync, ids: readonly string[]) {
  if (ids.length === 0) {
    return new Map<
      string,
      { importance: number | null; triggers: string | null; project_key: string | null }
    >();
  }
  const query = getNodeSqliteKysely<MemoryRecallMetadataDatabase>(db)
    .selectFrom("memory_index_chunks")
    .select(["id", "importance", "triggers", "project_key"])
    .where("id", "in", [...ids]);
  return new Map(executeSqliteQuerySync(db, query).rows.map((row) => [row.id, row]));
}

export function readCuratedMemoryTriggerCandidates(
  db: DatabaseSync,
  limit: number,
  activeProjectKeys?: readonly string[],
) {
  return readCuratedMemoryCandidates({
    db,
    limit,
    activeProjectKeys,
    requireProject: false,
    requireTriggers: true,
  });
}

export function readCuratedProjectMemoryCandidates(
  db: DatabaseSync,
  limit: number,
  activeProjectKeys: readonly string[],
) {
  if (activeProjectKeys.length === 0) {
    return [];
  }
  return readCuratedMemoryCandidates({
    db,
    limit,
    activeProjectKeys,
    requireProject: true,
    requireTriggers: false,
  });
}

function readCuratedMemoryCandidates(params: {
  db: DatabaseSync;
  limit: number;
  activeProjectKeys?: readonly string[];
  requireProject: boolean;
  requireTriggers: boolean;
}) {
  const { db, limit } = params;
  const active = params.activeProjectKeys
    ? new Set(params.activeProjectKeys.map((key) => key.trim()).filter(Boolean))
    : undefined;
  const results: ReturnType<typeof readCuratedCandidateBatch> = [];
  let cursor: { importance: number | null; path: string; id: string } | undefined;
  const batchSize = Math.max(64, limit);
  // Curated paths are constrained in SQL, while project eligibility is applied
  // across keyset batches before filling the caller's window so foreign rows cannot starve it.
  while (results.length < limit) {
    const rows = readCuratedCandidateBatch({
      db,
      limit: batchSize,
      cursor,
      requireProject: params.requireProject,
      requireTriggers: params.requireTriggers,
    });
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      const storedKeys = row.project_key
        ?.split(";")
        .map((key) => key.trim())
        .filter(Boolean);
      if (storedKeys?.includes(INVALID_PROJECT_ANNOTATION_KEY)) {
        continue;
      }
      if (
        (active === undefined && !params.requireProject) ||
        (row.project_key === null && !params.requireProject) ||
        (storedKeys &&
          storedKeys.length > 0 &&
          storedKeys.every((key) => active?.has(key) === true))
      ) {
        results.push(row);
        if (results.length === limit) {
          break;
        }
      }
    }
    const last = rows.at(-1);
    if (!last || rows.length < batchSize) {
      break;
    }
    cursor = { importance: last.importance, path: last.path, id: last.id };
  }
  return results;
}

function readCuratedCandidateBatch(params: {
  db: DatabaseSync;
  limit: number;
  cursor?: { importance: number | null; path: string; id: string };
  requireProject: boolean;
  requireTriggers: boolean;
}) {
  let query = getNodeSqliteKysely<MemoryRecallMetadataDatabase>(params.db)
    .selectFrom("memory_index_chunks")
    .select([
      "id",
      "path",
      "source",
      "start_line",
      "end_line",
      "text",
      "importance",
      "triggers",
      "project_key",
    ])
    .where("source", "=", "memory")
    .where("path", "in", ["MEMORY.md", "USER.md"]);
  if (params.requireProject) {
    query = query.where("project_key", "is not", null);
  }
  if (params.requireTriggers) {
    query = query.where("triggers", "is not", null);
  }
  if (params.cursor) {
    const cursor = params.cursor;
    query = query.where((eb) => {
      const importance = eb.fn.coalesce("importance", eb.val(0));
      const cursorImportance = cursor.importance ?? 0;
      return eb.or([
        eb(importance, "<", cursorImportance),
        eb.and([
          eb(importance, "=", cursorImportance),
          eb.or([
            eb("path", ">", cursor.path),
            eb.and([eb("path", "=", cursor.path), eb("id", ">", cursor.id)]),
          ]),
        ]),
      ]);
    });
  }
  query = query
    .orderBy((eb) => eb.fn.coalesce("importance", eb.val(0)), "desc")
    .orderBy("path")
    .orderBy("id")
    .limit(params.limit);
  return executeSqliteQuerySync(params.db, query).rows;
}
