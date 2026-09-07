import type { DatabaseSync } from "node:sqlite";
import { INVALID_PROJECT_ANNOTATION_KEY } from "./internal.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./openclaw-runtime-kysely.js";
import type { MemoryEntryProvenance, MemoryOriginClass, MemorySessionKind } from "./types.js";

type MemoryRecallMetadataDatabase = {
  memory_index_chunks: {
    id: string;
    path: string;
    source: string;
    start_line: number;
    end_line: number;
    text: string;
  };
  memory_index_chunk_recall_metadata: {
    chunk_id: string;
    importance: number | null;
    triggers: string | null;
    project_key: string | null;
  };
  memory_index_chunk_provenance: {
    chunk_id: string;
    origin_class: MemoryOriginClass;
    session_kind: MemorySessionKind;
    observed_at: number;
    supersedes_key: string | null;
  };
};

const MEMORY_ORIGIN_CLASSES: ReadonlySet<string> = new Set([
  "owner",
  "agent",
  "untrusted",
  "system",
]);
const MEMORY_SESSION_KINDS: ReadonlySet<string> = new Set([
  "interactive",
  "cron",
  "heartbeat",
  "subagent",
  "unknown",
]);

function decodeChunkProvenance(row: {
  origin_class: unknown;
  session_kind: unknown;
  observed_at: unknown;
  supersedes_key: unknown;
}): MemoryEntryProvenance | undefined {
  if (
    typeof row.origin_class !== "string" ||
    !MEMORY_ORIGIN_CLASSES.has(row.origin_class) ||
    typeof row.session_kind !== "string" ||
    !MEMORY_SESSION_KINDS.has(row.session_kind) ||
    typeof row.observed_at !== "number"
  ) {
    return undefined;
  }
  return {
    // SAFETY: Membership in the closed origin-class set is validated above.
    originClass: row.origin_class as MemoryOriginClass,
    // SAFETY: Membership in the closed session-kind set is validated above.
    sessionKind: row.session_kind as MemorySessionKind,
    observedAt: row.observed_at,
    ...(typeof row.supersedes_key === "string" && row.supersedes_key.trim()
      ? { supersedesKey: row.supersedes_key }
      : {}),
  };
}

export function readMemoryRecallMetadata(db: DatabaseSync, ids: readonly string[]) {
  if (ids.length === 0) {
    return new Map<
      string,
      Omit<MemoryRecallMetadataDatabase["memory_index_chunk_recall_metadata"], "chunk_id"> & {
        id: string;
        provenance?: MemoryEntryProvenance;
      }
    >();
  }
  const query = getNodeSqliteKysely<MemoryRecallMetadataDatabase>(db)
    .selectFrom("memory_index_chunks as chunk")
    .leftJoin("memory_index_chunk_recall_metadata as metadata", "metadata.chunk_id", "chunk.id")
    .leftJoin("memory_index_chunk_provenance as provenance", "provenance.chunk_id", "chunk.id")
    .select([
      "chunk.id as id",
      "metadata.importance as importance",
      "metadata.triggers as triggers",
      "metadata.project_key as project_key",
      "provenance.origin_class as origin_class",
      "provenance.session_kind as session_kind",
      "provenance.observed_at as observed_at",
      "provenance.supersedes_key as supersedes_key",
    ])
    .where("chunk.id", "in", [...ids]);
  return new Map(
    executeSqliteQuerySync(db, query).rows.map((row) => {
      const provenance = decodeChunkProvenance(row);
      return [
        row.id,
        {
          id: row.id,
          importance: row.importance,
          triggers: row.triggers,
          project_key: row.project_key,
          ...(provenance ? { provenance } : {}),
        },
      ];
    }),
  );
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
    .selectFrom("memory_index_chunks as chunk")
    .leftJoin("memory_index_chunk_recall_metadata as metadata", "metadata.chunk_id", "chunk.id")
    .innerJoin("memory_index_chunk_provenance as provenance", "provenance.chunk_id", "chunk.id")
    .select([
      "chunk.id as id",
      "chunk.path as path",
      "chunk.source as source",
      "chunk.start_line as start_line",
      "chunk.end_line as end_line",
      "chunk.text as text",
      "metadata.importance as importance",
      "metadata.triggers as triggers",
      "metadata.project_key as project_key",
      "provenance.origin_class as origin_class",
      "provenance.session_kind as session_kind",
      "provenance.observed_at as observed_at",
      "provenance.supersedes_key as supersedes_key",
    ])
    .where("chunk.source", "=", "memory")
    .where("chunk.path", "in", ["MEMORY.md", "USER.md"])
    .where("provenance.origin_class", "in", ["owner", "agent"]);
  if (params.requireProject) {
    query = query.where("metadata.project_key", "is not", null);
  }
  if (params.requireTriggers) {
    query = query.where("metadata.triggers", "is not", null);
  }
  if (params.cursor) {
    const cursor = params.cursor;
    query = query.where((eb) => {
      const importance = eb.fn.coalesce("metadata.importance", eb.val(0));
      const cursorImportance = cursor.importance ?? 0;
      return eb.or([
        eb(importance, "<", cursorImportance),
        eb.and([
          eb(importance, "=", cursorImportance),
          eb.or([
            eb("chunk.path", ">", cursor.path),
            eb.and([eb("chunk.path", "=", cursor.path), eb("chunk.id", ">", cursor.id)]),
          ]),
        ]),
      ]);
    });
  }
  query = query
    .orderBy((eb) => eb.fn.coalesce("metadata.importance", eb.val(0)), "desc")
    .orderBy("chunk.path")
    .orderBy("chunk.id")
    .limit(params.limit);
  return executeSqliteQuerySync(params.db, query).rows;
}
