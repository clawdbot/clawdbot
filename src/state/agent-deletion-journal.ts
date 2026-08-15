import { existsSync } from "node:fs";
import path from "node:path";
import { normalizeAgentDirRegistryPath } from "../agents/agent-dir-registry.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "./openclaw-state-db-contract.js";
import { ensureAgentDeletionJournalSchema } from "./openclaw-state-db-schema-additive.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type AgentDeletionDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_databases" | "agent_deletion_journal"
>;

type AgentDeletionPathFenceSnapshot = {
  claimAgentId: string;
  fenceAgentId?: string;
  targetPaths: string[];
  entries: Array<{
    agentId: string;
    operationId: string;
    agentDir: string;
    workspaceDir: string;
    sessionsDir: string;
    cleanupCompleted: boolean;
    canonicalPaths: string[];
    databasePaths: Array<{ path: string; canonicalPath: string }>;
    cleanupPaths: Array<AgentDeletionJournalCleanupPath & { fencePath: string }>;
  }>;
};

export type AgentDeletionJournalCleanupPath = {
  path: string;
  canonicalPath: string;
  parentPath: string;
  kind: "target" | "symlink";
  sourcePaths: string[];
  dev: number | null;
  ino: number | null;
  coversDescendants: boolean;
  done: boolean;
  note?: string;
};

export function assertAgentDeletionIdentityClaimAllowed(
  claimAgentId: string,
  deletedAgentId: string | undefined,
): void {
  if (deletedAgentId && normalizeAgentId(claimAgentId) === normalizeAgentId(deletedAgentId)) {
    throw new Error(
      `OpenClaw agent database is unavailable while agent ${normalizeAgentId(deletedAgentId)} is deleted.`,
    );
  }
}

export type AgentDeletionJournalEntry = {
  agentId: string;
  operationId: string;
  agentDir: string;
  workspaceDir: string;
  sessionsDir: string;
  databasePaths: string[];
  cleanupPaths: AgentDeletionJournalCleanupPath[];
  createdAt: number;
  cleanupCompleted: boolean;
  deleteFiles: boolean;
};

export function prepareAgentDeletionPathFence(
  claim: { agentId: string; path: string; fenceAgentId?: string },
  options: OpenClawStateDatabaseOptions = {},
): AgentDeletionPathFenceSnapshot {
  let rows: Array<{
    agent_id: string;
    operation_id: string;
    agent_dir: string;
    workspace_dir: string;
    sessions_dir: string;
    database_paths_json: string;
    cleanup_paths_json: string;
    cleanup_completed: number;
  }> = [];
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("agent_deletion_journal")
        .select([
          "agent_id",
          "operation_id",
          "agent_dir",
          "workspace_dir",
          "sessions_dir",
          "database_paths_json",
          "cleanup_paths_json",
          "cleanup_completed",
        ]),
    ).rows;
  }, options);
  const env = options.env ?? process.env;
  return {
    claimAgentId: normalizeAgentId(claim.agentId),
    ...(claim.fenceAgentId ? { fenceAgentId: normalizeAgentId(claim.fenceAgentId) } : {}),
    // targetPaths is a pre-open realpath snapshot. A co-equal same-user
    // process could retarget a symlink between snapshot and open; that actor
    // already owns every file here, so the fence defends cooperative
    // interleavings only — adversarial local races are out of threat model.
    targetPaths: resolveSqliteDatabaseFilePaths(claim.path).map((filePath) =>
      normalizeAgentDirRegistryPath(filePath, env),
    ),
    entries: rows.map((row) => ({
      agentId: row.agent_id,
      operationId: row.operation_id,
      agentDir: row.agent_dir,
      workspaceDir: row.workspace_dir,
      sessionsDir: row.sessions_dir,
      cleanupCompleted: row.cleanup_completed === 1,
      canonicalPaths: [row.agent_dir, row.workspace_dir, row.sessions_dir].map((entryPath) =>
        normalizeAgentDirRegistryPath(entryPath, env),
      ),
      databasePaths: parseDatabasePaths(row.database_paths_json).map((databasePath) => ({
        path: databasePath,
        canonicalPath: normalizeAgentDirRegistryPath(databasePath, env),
      })),
      cleanupPaths: parseCleanupPaths(row.cleanup_paths_json).map((cleanupPath) =>
        Object.assign({}, cleanupPath, {
          fencePath: normalizeAgentDirRegistryPath(cleanupPath.canonicalPath, env),
        }),
      ),
    })),
  };
}

/** Refuse database claims beneath paths still owned by an unfinished deletion. */
export function assertAgentDeletionPathFence(
  database: OpenClawStateDatabase["db"],
  snapshot: AgentDeletionPathFenceSnapshot,
): void {
  ensureAgentDeletionJournalSchema(database);
  const db = getNodeSqliteKysely<AgentDeletionDatabase>(database);
  const journalRows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("agent_deletion_journal")
      .select([
        "agent_id",
        "operation_id",
        "agent_dir",
        "workspace_dir",
        "sessions_dir",
        "database_paths_json",
        "cleanup_paths_json",
        "cleanup_completed",
      ]),
  ).rows;
  const snapshotJournal = snapshot.entries
    .map((entry) =>
      [
        entry.agentId,
        entry.operationId,
        entry.agentDir,
        entry.workspaceDir,
        entry.sessionsDir,
        JSON.stringify(entry.databasePaths.map((candidate) => candidate.path)),
        JSON.stringify(
          entry.cleanupPaths.map(({ fencePath: _fencePath, ...candidate }) => ({
            ...candidate,
          })),
        ),
        entry.cleanupCompleted ? 1 : 0,
      ].join("\0"),
    )
    .toSorted();
  const currentJournal = journalRows
    .map((row) =>
      [
        row.agent_id,
        row.operation_id,
        row.agent_dir,
        row.workspace_dir,
        row.sessions_dir,
        row.database_paths_json,
        row.cleanup_paths_json,
        row.cleanup_completed,
      ].join("\0"),
    )
    .toSorted();
  if (snapshotJournal.join("\n") !== currentJournal.join("\n")) {
    throw new Error("Agent deletion journal changed while preparing a database claim.");
  }
  for (const row of journalRows) {
    if (snapshot.fenceAgentId && snapshot.fenceAgentId !== row.agent_id) {
      continue;
    }
    assertAgentDeletionIdentityClaimAllowed(snapshot.claimAgentId, row.agent_id);
    if (row.cleanup_completed === 1) {
      continue;
    }
    // Filesystem canonicalization stays outside the SQLite write transaction; the exact journal
    // row is revalidated here so a concurrent deletion can only make the claim fail closed.
    const entry = snapshot.entries.find(
      (candidate) =>
        candidate.agentId === row.agent_id &&
        candidate.operationId === row.operation_id &&
        candidate.agentDir === row.agent_dir &&
        candidate.workspaceDir === row.workspace_dir &&
        candidate.sessionsDir === row.sessions_dir &&
        JSON.stringify(candidate.databasePaths.map((databasePath) => databasePath.path)) ===
          row.database_paths_json &&
        JSON.stringify(
          candidate.cleanupPaths.map(({ fencePath: _fencePath, ...cleanupPath }) => ({
            ...cleanupPath,
          })),
        ) === row.cleanup_paths_json,
    );
    if (!entry) {
      throw new Error("Agent deletion journal changed while preparing a database claim.");
    }
    const fences = [
      ...entry.canonicalPaths.map((canonicalPath, index) => ({
        canonicalPath,
        path: [entry.agentDir, entry.workspaceDir, entry.sessionsDir][index],
      })),
      ...entry.databasePaths,
      ...entry.cleanupPaths.map((cleanupPath) => ({
        path: cleanupPath.path,
        canonicalPath: cleanupPath.fencePath,
      })),
    ];
    for (const fence of fences) {
      const blockedPath = snapshot.targetPaths.find(
        (targetPath) =>
          targetPath === fence.canonicalPath || isPathInside(fence.canonicalPath, targetPath),
      );
      if (blockedPath) {
        throw new Error(
          `OpenClaw agent database ${blockedPath} is unavailable while agent ${row.agent_id} deletion owns ${fence.path}.`,
        );
      }
    }
  }
}

function fromRow(row: {
  agent_id: string;
  operation_id: string;
  agent_dir: string;
  workspace_dir: string;
  sessions_dir: string;
  database_paths_json: string;
  cleanup_paths_json: string;
  created_at: number;
  cleanup_completed: number;
  delete_files: number;
}): AgentDeletionJournalEntry {
  return {
    agentId: row.agent_id,
    operationId: row.operation_id,
    agentDir: row.agent_dir,
    workspaceDir: row.workspace_dir,
    sessionsDir: row.sessions_dir,
    databasePaths: parseDatabasePaths(row.database_paths_json),
    cleanupPaths: parseCleanupPaths(row.cleanup_paths_json),
    createdAt: row.created_at,
    cleanupCompleted: row.cleanup_completed === 1,
    deleteFiles: row.delete_files === 1,
  };
}

function parseDatabasePaths(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error("Invalid agent deletion database path journal.");
  }
  return parsed;
}

function parseCleanupPaths(value: string): AgentDeletionJournalCleanupPath[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (entry): entry is AgentDeletionJournalCleanupPath =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === "string" &&
        typeof (entry as { canonicalPath?: unknown }).canonicalPath === "string" &&
        typeof (entry as { parentPath?: unknown }).parentPath === "string" &&
        ((entry as { kind?: unknown }).kind === "target" ||
          (entry as { kind?: unknown }).kind === "symlink") &&
        ((entry as { dev?: unknown }).dev === null ||
          typeof (entry as { dev?: unknown }).dev === "number") &&
        ((entry as { ino?: unknown }).ino === null ||
          typeof (entry as { ino?: unknown }).ino === "number") &&
        typeof (entry as { coversDescendants?: unknown }).coversDescendants === "boolean" &&
        typeof (entry as { done?: unknown }).done === "boolean" &&
        ((entry as { note?: unknown }).note === undefined ||
          typeof (entry as { note?: unknown }).note === "string") &&
        Array.isArray((entry as { sourcePaths?: unknown }).sourcePaths) &&
        (entry as { sourcePaths: unknown[] }).sourcePaths.every(
          (sourcePath) => typeof sourcePath === "string",
        ),
    )
  ) {
    throw new Error("Invalid agent deletion cleanup path journal.");
  }
  return parsed;
}

export function readAgentDeletionJournal(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): AgentDeletionJournalEntry | undefined {
  const id = normalizeAgentId(agentId);
  const databasePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  if (!existsSync(databasePath)) {
    return undefined;
  }
  let entry: AgentDeletionJournalEntry | undefined;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("agent_deletion_journal").selectAll().where("agent_id", "=", id),
    );
    entry = row ? fromRow(row) : undefined;
  }, options);
  return entry;
}

export function beginAgentDeletionJournal(
  entry: Omit<
    AgentDeletionJournalEntry,
    "createdAt" | "cleanupCompleted" | "databasePaths" | "cleanupPaths"
  > & {
    databasePaths?: string[];
    cleanupPaths?: AgentDeletionJournalCleanupPath[];
  },
  options: OpenClawStateDatabaseOptions = {},
): AgentDeletionJournalEntry {
  const normalized = {
    ...entry,
    agentId: normalizeAgentId(entry.agentId),
    databasePaths: [
      ...new Set((entry.databasePaths ?? []).map((entryPath) => path.resolve(entryPath))),
    ],
    cleanupPaths: entry.cleanupPaths ?? [],
  };
  let persisted: AgentDeletionJournalEntry | undefined;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const existing = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("agent_deletion_journal")
        .selectAll()
        .where("agent_id", "=", normalized.agentId),
    );
    const registeredDatabasePaths = executeSqliteQuerySync(
      database.db,
      db.selectFrom("agent_databases").select("path").where("agent_id", "=", normalized.agentId),
    ).rows.flatMap((row) => resolveSqliteDatabaseFilePaths(row.path));
    const databasePaths = [
      ...new Set(
        [
          ...(existing ? fromRow(existing).databasePaths : []),
          ...normalized.databasePaths,
          ...registeredDatabasePaths,
        ].map((entryPath) => path.resolve(entryPath)),
      ),
    ];
    const cleanupPaths = existing ? fromRow(existing).cleanupPaths : normalized.cleanupPaths;
    if (existing) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("agent_deletion_journal")
          .set({
            operation_id: normalized.operationId,
            database_paths_json: JSON.stringify(databasePaths),
            cleanup_paths_json: JSON.stringify(cleanupPaths),
            cleanup_completed: 0,
            delete_files: normalized.deleteFiles ? 1 : 0,
          })
          .where("agent_id", "=", normalized.agentId),
      );
      persisted = {
        ...fromRow(existing),
        operationId: normalized.operationId,
        databasePaths,
        cleanupPaths,
        cleanupCompleted: false,
        deleteFiles: normalized.deleteFiles,
      };
      return;
    }
    const createdAt = Date.now();
    executeSqliteQuerySync(
      database.db,
      db.insertInto("agent_deletion_journal").values({
        agent_id: normalized.agentId,
        operation_id: normalized.operationId,
        agent_dir: normalized.agentDir,
        workspace_dir: normalized.workspaceDir,
        sessions_dir: normalized.sessionsDir,
        database_paths_json: JSON.stringify(databasePaths),
        cleanup_paths_json: JSON.stringify(cleanupPaths),
        created_at: createdAt,
        cleanup_completed: 0,
        delete_files: normalized.deleteFiles ? 1 : 0,
      }),
    );
    persisted = { ...normalized, databasePaths, cleanupPaths, createdAt, cleanupCompleted: false };
  }, options);
  if (!persisted) {
    throw new Error(`Failed to record deletion journal for agent ${normalized.agentId}.`);
  }
  return persisted;
}

export function updateAgentDeletionJournalCleanupPaths(
  agentId: string,
  operationId: string,
  cleanupPaths: readonly AgentDeletionJournalCleanupPath[],
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  let updated = false;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("agent_deletion_journal")
        .set({ cleanup_paths_json: JSON.stringify(cleanupPaths) })
        .where("agent_id", "=", id)
        .where("operation_id", "=", operationId)
        .where("cleanup_completed", "=", 0),
    );
    updated = Number(result.numAffectedRows ?? 0) > 0;
  }, options);
  return updated;
}

export function updateAgentDeletionJournalDatabasePaths(
  agentId: string,
  operationId: string,
  databasePaths: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  const normalizedPaths = [...new Set(databasePaths.map((entryPath) => path.resolve(entryPath)))];
  let updated = false;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("agent_deletion_journal")
        .set({ database_paths_json: JSON.stringify(normalizedPaths) })
        .where("agent_id", "=", id)
        .where("operation_id", "=", operationId)
        .where("cleanup_completed", "=", 0),
    );
    updated = Number(result.numAffectedRows ?? 0) > 0;
  }, options);
  return updated;
}

export function completeAgentDeletionJournal(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  let completed = false;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("agent_deletion_journal")
        .set({ cleanup_completed: 1 })
        .where("agent_id", "=", id)
        .where("operation_id", "=", operationId),
    );
    completed = Number(result.numAffectedRows ?? 0) > 0;
  }, options);
  return completed;
}

export function removeAgentDeletionJournal(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  let removed = false;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("agent_deletion_journal")
        .where("agent_id", "=", id)
        .where("operation_id", "=", operationId),
    );
    removed = Number(result.numAffectedRows ?? 0) > 0;
  }, options);
  return removed;
}

export function claimCompletedAgentDeletionJournal(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(agentId);
  let removed = false;
  runOpenClawStateWriteTransaction((database) => {
    ensureAgentDeletionJournalSchema(database.db);
    const db = getNodeSqliteKysely<AgentDeletionDatabase>(database.db);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("agent_deletion_journal")
        .where("agent_id", "=", id)
        .where("operation_id", "=", operationId)
        .where("cleanup_completed", "=", 1),
    );
    removed = Number(result.numAffectedRows ?? 0) > 0;
  }, options);
  return removed;
}
