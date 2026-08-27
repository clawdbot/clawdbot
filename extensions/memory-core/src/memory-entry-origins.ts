import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawAgentDatabase,
  runSqliteImmediateTransactionSync,
  tableExists,
  withOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { DREAMS_FILENAMES, readDreamsFile } from "./dreaming-dreams-file.js";
import { extractPromotionKeys } from "./short-term-promotion-memory-write.js";

type MemoryOriginClass = "owner" | "agent" | "untrusted" | "system";

export type MemoryEntryOrigin = {
  entryKey: string;
  agentId: string;
  sessionId: string;
  sessionKey: string | null;
  originClass: MemoryOriginClass;
  observedAt: number;
};

type MemorySessionTombstone = {
  sessionId: string;
  agentId: string;
  reason: string;
  createdAt: number;
};

type MemoryEntryOriginRow = {
  entry_key: string;
  agent_id: string;
  session_id: string;
  session_key: string | null;
  origin_class: MemoryOriginClass;
  observed_at: number;
};

type MemorySessionTombstoneRow = {
  session_id: string;
  agent_id: string;
  reason: string;
  created_at: number;
};

type MemoryOriginDatabase = {
  memory_entry_origins: MemoryEntryOriginRow;
  memory_session_tombstones: MemorySessionTombstoneRow;
  memory_index_state: { id: number; revision: number };
  memory_index_chunks: { text: string; source: string };
};
const ensuredDatabases = new WeakSet<DatabaseSync>();
const ensuredTombstoneDatabases = new WeakSet<DatabaseSync>();

function openMemoryOriginDatabase(agentId: string): DatabaseSync {
  const db = openOpenClawAgentDatabase({ agentId }).db;
  if (!ensuredDatabases.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_entry_origins (
      entry_key TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_key TEXT,
      origin_class TEXT NOT NULL CHECK (origin_class IN ('owner', 'agent', 'untrusted', 'system')),
      observed_at INTEGER NOT NULL,
      PRIMARY KEY (entry_key, agent_id, session_id)
    ) STRICT`);
    ensuredDatabases.add(db);
  }
  return db;
}

function readOrigin(row: MemoryEntryOriginRow): MemoryEntryOrigin {
  return {
    entryKey: row.entry_key,
    agentId: row.agent_id,
    sessionId: row.session_id,
    sessionKey: row.session_key,
    originClass: row.origin_class,
    observedAt: row.observed_at,
  };
}

export function listMemoryEntryOrigins(params: {
  agentId: string;
  sessionIds?: readonly string[];
  entryKeys?: readonly string[];
}): MemoryEntryOrigin[] {
  if (params.sessionIds?.length === 0 || params.entryKeys?.length === 0) {
    return [];
  }
  const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
    if (!ensuredDatabases.has(db) && !tableExists(db, "memory_entry_origins")) {
      return [];
    }
    const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
    let query = kysely
      .selectFrom("memory_entry_origins")
      .selectAll()
      .where("agent_id", "=", params.agentId);
    if (params.sessionIds) {
      query = query.where("session_id", "in", params.sessionIds);
    }
    if (params.entryKeys) {
      query = query.where("entry_key", "in", params.entryKeys);
    }
    return executeSqliteQuerySync(
      db,
      query.orderBy("entry_key", "asc").orderBy("session_id", "asc"),
    ).rows.map(readOrigin);
  }, params);
  return result.found ? result.value : [];
}

export function listMemorySessionTombstones(params: {
  agentId: string;
  sessionIds?: readonly string[];
}): MemorySessionTombstone[] {
  if (params.sessionIds?.length === 0) {
    return [];
  }
  const result = withOpenClawAgentDatabaseReadOnly(({ db }) => {
    if (!ensuredTombstoneDatabases.has(db) && !tableExists(db, "memory_session_tombstones")) {
      return [];
    }
    const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
    let query = kysely
      .selectFrom("memory_session_tombstones")
      .selectAll()
      .where("agent_id", "=", params.agentId);
    if (params.sessionIds) {
      query = query.where("session_id", "in", params.sessionIds);
    }
    return executeSqliteQuerySync(db, query.orderBy("session_id", "asc")).rows.map((row) => ({
      sessionId: row.session_id,
      agentId: row.agent_id,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }, params);
  return result.found ? result.value : [];
}

export function recordMemorySessionTombstones(params: {
  agentId: string;
  sessionIds: readonly string[];
  reason?: string;
  createdAt?: number;
}): number {
  const sessionIds = [...new Set(params.sessionIds)];
  if (sessionIds.length === 0) {
    return 0;
  }
  const db = openOpenClawAgentDatabase({ agentId: params.agentId }).db;
  if (!ensuredTombstoneDatabases.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_session_tombstones (
      session_id TEXT NOT NULL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`);
    ensuredTombstoneDatabases.add(db);
  }
  const reason = params.reason ?? "forgotten";
  const createdAt = params.createdAt ?? Date.now();
  return runSqliteImmediateTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
    let recorded = 0;
    for (const sessionId of sessionIds) {
      const result = executeSqliteQuerySync(
        db,
        kysely
          .insertInto("memory_session_tombstones")
          .values({
            session_id: sessionId,
            agent_id: params.agentId,
            reason,
            created_at: createdAt,
          })
          .onConflict((conflict) => conflict.column("session_id").doNothing()),
      );
      recorded += Number(result.numAffectedRows ?? 0n);
    }
    if (recorded > 0) {
      // A shadow index can have no published chunks yet. Its existing revision
      // fence must still reject a rebuild prepared before this deletion.
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("memory_index_state")
          .set((expression) => ({ revision: expression("revision", "+", 1) }))
          .where("id", "=", 1),
      );
    }
    return recorded;
  });
}

export function hasMemorySessionTombstone(
  db: DatabaseSync,
  agentId: string,
  sessionId: string,
): boolean {
  if (!ensuredTombstoneDatabases.has(db) && !tableExists(db, "memory_session_tombstones")) {
    return false;
  }
  const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
  return (
    executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("memory_session_tombstones")
        .select("session_id")
        .where("agent_id", "=", agentId)
        .where("session_id", "=", sessionId),
    ).rows.length > 0
  );
}

export function recordMemoryEntryOrigins(params: {
  agentId: string;
  origins: readonly MemoryEntryOrigin[];
  entryKey?: string;
}): MemoryEntryOrigin[] {
  if (params.origins.length === 0) {
    return [];
  }
  const db = openMemoryOriginDatabase(params.agentId);
  return runSqliteImmediateTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
    return params.origins.flatMap((origin) => {
      if (origin.agentId !== params.agentId) {
        throw new Error("memory entry origin belongs to another agent");
      }
      return executeSqliteQuerySync(
        db,
        kysely
          .insertInto("memory_entry_origins")
          .values({
            entry_key: params.entryKey ?? origin.entryKey,
            agent_id: origin.agentId,
            session_id: origin.sessionId,
            session_key: origin.sessionKey,
            origin_class: origin.originClass,
            observed_at: origin.observedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["entry_key", "agent_id", "session_id"]).doNothing(),
          )
          .returningAll(),
      ).rows.map(readOrigin);
    });
  });
}

export function deleteMemoryEntryOrigins(params: {
  agentId: string;
  entryKeys: readonly string[];
  sessionIds?: readonly string[];
}): number {
  if (listMemoryEntryOrigins(params).length === 0) {
    return 0;
  }
  const db = openMemoryOriginDatabase(params.agentId);
  return runSqliteImmediateTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
    let query = kysely
      .deleteFrom("memory_entry_origins")
      .where("agent_id", "=", params.agentId)
      .where("entry_key", "in", params.entryKeys);
    if (params.sessionIds) {
      query = query.where("session_id", "in", params.sessionIds);
    }
    return Number(executeSqliteQuerySync(db, query).numAffectedRows ?? 0n);
  });
}

export function reserveMemoryEntryOrigins(params: {
  agentIds: readonly string[];
  previousMemory: string;
  operations: readonly {
    candidateKey: string;
    action: "added" | "merged" | "superseded";
    priorEntries: readonly string[];
  }[];
}): () => void {
  const previousLines = params.previousMemory.replace(/\r\n/gu, "\n").split("\n");
  const operationParents = params.operations.map((operation) => {
    const parentKeys = new Set([operation.candidateKey]);
    for (const entry of operation.priorEntries) {
      const entryIndex = previousLines.findIndex((line) => line.trim() === entry);
      const marker = previousLines[entryIndex - 1]?.trim();
      const parentKey = /^<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->$/u
        .exec(marker ?? "")?.[1]
        ?.trim();
      if (parentKey) {
        parentKeys.add(parentKey);
      }
    }
    return { operation, parentKeys };
  });
  const affectedKeys = [...new Set(operationParents.flatMap(({ parentKeys }) => [...parentKeys]))];
  const reservations: Array<Parameters<typeof deleteMemoryEntryOrigins>[0]> = [];
  const rollback = () => {
    for (const reservation of reservations.toReversed()) {
      deleteMemoryEntryOrigins(reservation);
    }
  };
  try {
    for (const agentId of [...new Set(params.agentIds)].toSorted()) {
      const origins = listMemoryEntryOrigins({ agentId, entryKeys: affectedKeys });
      for (const { operation, parentKeys } of operationParents) {
        const added = recordMemoryEntryOrigins({
          agentId,
          origins: origins.filter((origin) => parentKeys.has(origin.entryKey)),
          entryKey: operation.candidateKey,
        });
        if (added.length > 0) {
          reservations.push({
            agentId,
            entryKeys: [operation.candidateKey],
            sessionIds: added.map((origin) => origin.sessionId),
          });
        }
      }
    }
  } catch (error) {
    rollback();
    throw error;
  }
  return rollback;
}

export async function pruneMemoryEntryOrigins(params: {
  workspaceDir: string;
  agentIds: readonly string[];
  entryKeys: Iterable<string>;
  retainedEntryKeys: ReadonlySet<string>;
}): Promise<void> {
  const entryKeys = [...new Set(params.entryKeys)].filter(
    (key) => !params.retainedEntryKeys.has(key),
  );
  if (entryKeys.length === 0) {
    return;
  }
  // Keep diary origins through backup rotation; callers hold the workspace lock.
  const diaries = await Promise.all(
    DREAMS_FILENAMES.map((name) => readDreamsFile(path.join(params.workspaceDir, name))),
  );
  const diaryKeys = new Set(diaries.flatMap(extractPromotionKeys));
  for (const agentId of new Set(params.agentIds)) {
    // A sibling may still index an older shared MEMORY snapshot. Retain its
    // lineage until that agent can identify and purge those derived records.
    const indexed = withOpenClawAgentDatabaseReadOnly(
      ({ db }) =>
        new Set(
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<MemoryOriginDatabase>(db)
              .selectFrom("memory_index_chunks")
              .select("text")
              .where("source", "=", "memory")
              .where("text", "like", "%openclaw-memory-promotion:%"),
          ).rows.flatMap(({ text }) => extractPromotionKeys(text)),
        ),
      { agentId },
    );
    deleteMemoryEntryOrigins({
      agentId,
      entryKeys: entryKeys.filter(
        (key) => !diaryKeys.has(key) && !(indexed.found && indexed.value.has(key)),
      ),
    });
  }
}
