import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawAgentDatabase,
  runSqliteImmediateTransactionSync,
  withOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/sqlite-runtime";

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
};
type SqliteSchemaDatabase = { sqlite_schema: { type: string; name: string } };
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

function hasMemoryTable(db: DatabaseSync, tableName: string): boolean {
  const schema = getNodeSqliteKysely<SqliteSchemaDatabase>(db);
  return (
    executeSqliteQuerySync(
      db,
      schema
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "=", tableName),
    ).rows.length > 0
  );
}

function originRow(origin: MemoryEntryOrigin): MemoryEntryOriginRow {
  return {
    entry_key: origin.entryKey,
    agent_id: origin.agentId,
    session_id: origin.sessionId,
    session_key: origin.sessionKey,
    origin_class: origin.originClass,
    observed_at: origin.observedAt,
  };
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
    if (!ensuredDatabases.has(db) && !hasMemoryTable(db, "memory_entry_origins")) {
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
    if (!ensuredTombstoneDatabases.has(db) && !hasMemoryTable(db, "memory_session_tombstones")) {
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
    return recorded;
  });
}

export function recordMemoryEntryOrigins(params: {
  agentId: string;
  origins: readonly MemoryEntryOrigin[];
}): void {
  if (params.origins.length === 0) {
    return;
  }
  const db = openMemoryOriginDatabase(params.agentId);
  runSqliteImmediateTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
    for (const origin of params.origins) {
      if (origin.agentId !== params.agentId) {
        throw new Error("memory entry origin belongs to another agent");
      }
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("memory_entry_origins")
          .values(originRow(origin))
          .onConflict((conflict) =>
            conflict.columns(["entry_key", "agent_id", "session_id"]).doNothing(),
          ),
      );
    }
  });
}

export function deleteMemoryEntryOrigins(params: {
  agentId: string;
  entryKeys: readonly string[];
}): number {
  if (params.entryKeys.length === 0) {
    return 0;
  }
  const db = openMemoryOriginDatabase(params.agentId);
  return runSqliteImmediateTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
    const result = executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("memory_entry_origins")
        .where("agent_id", "=", params.agentId)
        .where("entry_key", "in", params.entryKeys),
    );
    return Number(result.numAffectedRows ?? 0n);
  });
}

export function reconcileMemoryEntryOrigins(params: {
  agentIds: readonly string[];
  previousMemory: string;
  currentMemory: string;
  operations: readonly {
    candidateKey: string;
    action: "added" | "merged" | "superseded";
    priorEntries: readonly string[];
  }[];
}): void {
  if (params.operations.length === 0) {
    return;
  }
  const previousLines = params.previousMemory.replace(/\r\n/gu, "\n").split("\n");
  const promotionKeys = (content: string) =>
    [...content.matchAll(/<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->/giu)]
      .map((match) => match[1]?.trim())
      .filter((key): key is string => Boolean(key));
  const liveKeys = new Set(promotionKeys(params.currentMemory));
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
    return { operation, parentKeys: [...parentKeys] };
  });
  const retiredKeys = promotionKeys(params.previousMemory).filter((key) => !liveKeys.has(key));
  const affectedKeys = [
    ...new Set([...retiredKeys, ...operationParents.flatMap(({ parentKeys }) => parentKeys)]),
  ];
  for (const agentId of [...new Set(params.agentIds)].toSorted()) {
    if (listMemoryEntryOrigins({ agentId, entryKeys: affectedKeys }).length === 0) {
      continue;
    }
    const db = openMemoryOriginDatabase(agentId);
    runSqliteImmediateTransactionSync(db, () => {
      const kysely = getNodeSqliteKysely<MemoryOriginDatabase>(db);
      for (const { operation, parentKeys } of operationParents) {
        const rows = executeSqliteQuerySync(
          db,
          kysely
            .selectFrom("memory_entry_origins")
            .selectAll()
            .where("agent_id", "=", agentId)
            .where("entry_key", "in", parentKeys),
        ).rows;
        for (const row of rows) {
          executeSqliteQuerySync(
            db,
            kysely
              .insertInto("memory_entry_origins")
              .values({ ...row, entry_key: operation.candidateKey })
              .onConflict((conflict) =>
                conflict.columns(["entry_key", "agent_id", "session_id"]).doNothing(),
              ),
          );
        }
      }
      if (retiredKeys.length > 0) {
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("memory_entry_origins")
            .where("agent_id", "=", agentId)
            .where("entry_key", "in", retiredKeys),
        );
      }
    });
  }
}
