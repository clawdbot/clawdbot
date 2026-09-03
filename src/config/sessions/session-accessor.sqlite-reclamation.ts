import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../../state/openclaw-state-db.paths.js";
import {
  runSqliteTranscriptArchiveWorkerOperation,
  type MaterializedSessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import type {
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  SessionLifecycleArchivedTranscript,
} from "./session-accessor.sqlite-contract.js";
import { runSqliteSessionDeletionTransaction } from "./session-accessor.sqlite-deletion.js";
import {
  sqliteLifecycleTargetSnapshotsEqual,
  sqliteSessionEntriesEqual,
  type SqliteLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteLifecycleTargetRows,
  readLifecycleTargetSnapshot,
} from "./session-accessor.sqlite-entry-store.js";
import {
  assertPlannedLifecycleArtifactEntriesUnchanged,
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type { SessionEntryRemovalPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { deleteSessionDeliveryArtifacts } from "./session-accessor.sqlite-node-artifacts.js";
import { cloneSessionEntry, getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionBoardCleanupDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "board_tabs" | "board_widgets"
> & {
  sqlite_schema: { name: string | null; type: string };
};

type ReclamationDatabaseOptions = OpenClawAgentDatabaseOptions & {
  env: NodeJS.ProcessEnv;
  path: string;
};

type WorkerDeleteParams = Omit<DeleteSessionEntryLifecycleParams, "commitGuard">;

type SessionReclamationPlanBase = {
  databaseOptions: ReclamationDatabaseOptions;
  materializedPlans: MaterializedSessionStateDeletePlan[];
};

export type SqliteSessionReclamationPlan =
  | (SessionReclamationPlanBase & {
      deleteParams: WorkerDeleteParams;
      kind: "entry";
      preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
    })
  | (SessionReclamationPlanBase & {
      entries: SessionEntryRemovalPlan[];
      kind: "lifecycle-artifacts";
    })
  | (SessionReclamationPlanBase & {
      kind: "history-eviction";
      protectedSessionIds: string[];
      sessionId: string;
    })
  | (SessionReclamationPlanBase & {
      deleteParams: WorkerDeleteParams;
      kind: "historical-generation";
      preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
      protectedSessionIds: string[];
      sessionId: string;
    });

export type SqliteSessionReclamationResult =
  | { kind: "entry"; value: DeleteSessionEntryLifecycleResult }
  | {
      kind: "lifecycle-artifacts";
      value: {
        archivedTranscripts: SessionLifecycleArchivedTranscript[];
        removedEntries: number;
      };
    }
  | {
      kind: "history-eviction";
      value: { archivedTranscripts: SessionLifecycleArchivedTranscript[]; deleted: boolean };
    }
  | {
      kind: "historical-generation";
      value: {
        archivedTranscripts: SessionLifecycleArchivedTranscript[];
        deleted: boolean;
        expectedEntryMismatch?: true;
      };
    };

export type SqliteSessionReclamationWorkerData = {
  operation: "reclaim";
  plan: SqliteSessionReclamationPlan;
  type: "sqlite-transcript-archive-v2";
};

export type SqliteSessionReclamationWorkerResult = {
  cleanupIncomplete?: true;
  cleanupWarnings?: string[];
  result: SqliteSessionReclamationResult;
};

const reclamationLog = createSubsystemLogger("sessions/reclamation");
const reclamationQueue = new KeyedAsyncQueue();

/** Bounds materialized archive bytes through the matching reclamation commit. */
export function runExclusiveSqliteSessionReclamation<T>(run: () => Promise<T>): Promise<T> {
  return reclamationQueue.enqueue("session-reclamation", run);
}

function toWorkerDatabaseOptions(
  options: OpenClawAgentDatabaseOptions,
): ReclamationDatabaseOptions {
  const sourceEnv = options.env ?? process.env;
  const sharedStatePath = options.database?.path ?? resolveOpenClawStateSqlitePath(sourceEnv);
  return {
    agentId: options.agentId,
    env: { OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(sharedStatePath) },
    path: resolveOpenClawAgentSqlitePath(options),
  };
}

function toWorkerDeleteParams(params: DeleteSessionEntryLifecycleParams): WorkerDeleteParams {
  const deleteParams = { ...params };
  delete deleteParams.commitGuard;
  return deleteParams;
}

function deleteSessionBoardRows(
  database: OpenClawAgentDatabase,
  sessionKeys: readonly string[],
): void {
  const keys = [...new Set(sessionKeys)];
  if (keys.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<SessionBoardCleanupDatabase>(database.db);
  const tables = new Set(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "in", ["board_tabs", "board_widgets"]),
    ).rows.map((row) => row.name),
  );
  if (!tables.has("board_tabs") || !tables.has("board_widgets")) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("board_widgets").where("session_key", "in", keys),
  );
  executeSqliteQuerySync(database.db, db.deleteFrom("board_tabs").where("session_key", "in", keys));
}

export function shouldDeleteSqliteSessionEntryLifecycle(
  database: OpenClawAgentDatabase,
  entry: SessionEntry | undefined,
  params: WorkerDeleteParams,
): entry is SessionEntry {
  if (!entry || (params.expectedEntry && !sqliteSessionEntriesEqual(entry, params.expectedEntry))) {
    return false;
  }
  if (
    params.expectedSessionId !== undefined &&
    (params.expectedSessionId === null
      ? entry.sessionId !== undefined
      : entry.sessionId !== params.expectedSessionId)
  ) {
    return false;
  }
  if (
    (params.expectedLifecycleRevision !== undefined &&
      entry.lifecycleRevision !== params.expectedLifecycleRevision) ||
    (params.expectedUpdatedAt !== undefined && entry.updatedAt !== params.expectedUpdatedAt)
  ) {
    return false;
  }
  const expectedTranscript = params.expectedTranscript;
  if (!expectedTranscript) {
    return true;
  }
  const rows = executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", expectedTranscript.sessionId)
      .orderBy("seq", "asc"),
  ).rows;
  return (
    entry.sessionId === expectedTranscript.sessionId &&
    rows.length === expectedTranscript.eventJson.length &&
    rows.every((row, index) => row.event_json === expectedTranscript.eventJson[index])
  );
}

function expectedEntryMismatchResult(): DeleteSessionEntryLifecycleResult {
  return { archivedTranscripts: [], deleted: false, expectedEntryMismatch: true };
}

export function reclaimSqliteSessionInTransaction(
  plan: SqliteSessionReclamationPlan,
  callbacks: {
    beforeMutation?: () => void;
    onCommit?: (database: OpenClawAgentDatabase) => void;
  } = {},
): SqliteSessionReclamationResult {
  if (plan.kind === "entry") {
    const value = runSqliteSessionDeletionTransaction<DeleteSessionEntryLifecycleResult>(
      (transactionDb) => {
        callbacks.beforeMutation?.();
        const snapshot = readLifecycleTargetSnapshot(transactionDb, plan.deleteParams.target);
        const entry = snapshot[0]?.entry;
        if (
          !sqliteLifecycleTargetSnapshotsEqual(plan.preparedTargetSnapshot, snapshot) ||
          !shouldDeleteSqliteSessionEntryLifecycle(transactionDb, entry, plan.deleteParams)
        ) {
          return expectedEntryMismatchResult();
        }
        const sessionKeys = [
          plan.deleteParams.target.canonicalKey,
          ...plan.deleteParams.target.storeKeys,
          ...snapshot.map((row) => row.sessionKey),
        ];
        const archivedTranscripts = deleteMaterializedSessionStatePlans(
          transactionDb,
          plan.materializedPlans,
          undefined,
          new Set(sessionKeys),
        );
        deleteLifecycleTargetRows(transactionDb, plan.deleteParams.target);
        if (plan.deleteParams.deleteDeliveryArtifacts === true) {
          deleteSessionDeliveryArtifacts(
            transactionDb,
            plan.deleteParams.target.canonicalKey,
            sessionKeys,
          );
        }
        deleteSessionBoardRows(transactionDb, sessionKeys);
        callbacks.onCommit?.(transactionDb);
        if (!entry) {
          throw new Error("SQLite reclamation plan lost its prepared entry");
        }
        return {
          archivedTranscripts,
          deleted: true,
          deletedEntry: cloneSessionEntry(entry),
          ...(entry.sessionId ? { deletedSessionId: entry.sessionId } : {}),
        };
      },
      plan.databaseOptions,
    );
    return { kind: plan.kind, value };
  }

  if (plan.kind === "lifecycle-artifacts") {
    const value = runSqliteSessionDeletionTransaction((transactionDb) => {
      callbacks.beforeMutation?.();
      assertPlannedLifecycleArtifactEntriesUnchanged(transactionDb, plan.entries);
      const archivedTranscripts = deleteMaterializedSessionStatePlans(
        transactionDb,
        plan.materializedPlans,
        undefined,
        new Set(plan.entries.map((entry) => entry.sessionKey)),
      );
      const removedEntries = deletePlannedLifecycleArtifactEntries(transactionDb, plan.entries);
      callbacks.onCommit?.(transactionDb);
      return { archivedTranscripts, removedEntries };
    }, plan.databaseOptions);
    return { kind: plan.kind, value };
  }

  if (plan.kind === "history-eviction") {
    const value = runOpenClawAgentWriteTransaction((transactionDb) => {
      callbacks.beforeMutation?.();
      const archivedTranscripts = deleteMaterializedSessionStatePlans(
        transactionDb,
        plan.materializedPlans,
        new Set(plan.protectedSessionIds),
      );
      const db = getSessionKysely(transactionDb.db);
      const deleted =
        executeSqliteQuerySync(
          transactionDb.db,
          db
            .selectFrom("session_windows")
            .select("session_id")
            .where("session_id", "=", plan.sessionId),
        ).rows.length === 0;
      if (deleted) {
        callbacks.onCommit?.(transactionDb);
      }
      return { archivedTranscripts: deleted ? archivedTranscripts : [], deleted };
    }, plan.databaseOptions);
    if (value.deleted) {
      reclaimSqliteFreePagesBestEffort(plan.databaseOptions);
    }
    return { kind: plan.kind, value };
  }

  const value = runOpenClawAgentWriteTransaction((transactionDb) => {
    callbacks.beforeMutation?.();
    const snapshot = readLifecycleTargetSnapshot(transactionDb, plan.deleteParams.target);
    if (
      !sqliteLifecycleTargetSnapshotsEqual(plan.preparedTargetSnapshot, snapshot) ||
      !shouldDeleteSqliteSessionEntryLifecycle(transactionDb, snapshot[0]?.entry, plan.deleteParams)
    ) {
      return { archivedTranscripts: [], deleted: false, expectedEntryMismatch: true as const };
    }
    const archivedTranscripts = deleteMaterializedSessionStatePlans(
      transactionDb,
      plan.materializedPlans,
      new Set(plan.protectedSessionIds),
    );
    const db = getSessionKysely(transactionDb.db);
    const deleted =
      executeSqliteQuerySync(
        transactionDb.db,
        db
          .selectFrom("session_windows")
          .select("session_id")
          .where("session_id", "=", plan.sessionId),
      ).rows.length === 0;
    if (deleted) {
      callbacks.onCommit?.(transactionDb);
    }
    return { archivedTranscripts: deleted ? archivedTranscripts : [], deleted };
  }, plan.databaseOptions);
  return { kind: plan.kind, value };
}

function reclaimSqliteFreePagesBestEffort(databaseOptions: ReclamationDatabaseOptions): void {
  try {
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.walMaintenance.checkpoint();
    const row = database.db /* sqlite-allow-raw: page accounting is exposed only via PRAGMA */
      .prepare("PRAGMA freelist_count")
      .get() as { freelist_count: number | bigint }; // SAFETY: fixed numeric PRAGMA column.
    const freePages = Number(row.freelist_count);
    if (Number.isSafeInteger(freePages) && freePages > 0) {
      // sqlite-allow-raw -- incremental vacuum is a maintenance PRAGMA, not a data query.
      database.db.exec(`PRAGMA incremental_vacuum(${freePages});`);
    }
    database.walMaintenance.checkpoint();
  } catch {
    // Deletion is already durable. The next budget pass can reclaim pages.
  }
}

function prepareReclamationWorkerTransferList(plan: SqliteSessionReclamationPlan): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  for (const materializedPlan of plan.materializedPlans) {
    const archive = materializedPlan.archive;
    if (!archive) {
      continue;
    }
    const bytes = archive.bytes;
    let owned = bytes;
    let buffer: ArrayBuffer;
    if (
      bytes.buffer instanceof ArrayBuffer &&
      bytes.byteOffset === 0 &&
      bytes.byteLength === bytes.buffer.byteLength
    ) {
      buffer = bytes.buffer;
    } else {
      buffer = new ArrayBuffer(bytes.byteLength);
      owned = new Uint8Array(buffer);
      owned.set(bytes);
    }
    materializedPlan.archive = { ...archive, bytes: owned };
    buffers.add(buffer);
  }
  return [...buffers];
}

export async function runSqliteSessionReclamation(params: {
  beforeInProcessMutation?: () => void;
  forceInProcess: boolean;
  onInProcessCommit?: (database: OpenClawAgentDatabase) => void;
  plan: SqliteSessionReclamationPlan;
}): Promise<SqliteSessionReclamationResult> {
  if (
    params.forceInProcess ||
    isIncognitoOpenClawAgentSqlitePath(params.plan.databaseOptions.path, {
      agentId: params.plan.databaseOptions.agentId,
      env: params.plan.databaseOptions.env,
    })
  ) {
    return reclaimSqliteSessionInTransaction(params.plan, {
      beforeMutation: params.beforeInProcessMutation,
      onCommit: params.onInProcessCommit,
    });
  }
  const [workerResult] =
    await runSqliteTranscriptArchiveWorkerOperation<SqliteSessionReclamationWorkerResult>({
      expectedMessageType: "reclaimed",
      transferList: prepareReclamationWorkerTransferList(params.plan),
      workerData: {
        operation: "reclaim",
        plan: params.plan,
        type: "sqlite-transcript-archive-v2",
      } satisfies SqliteSessionReclamationWorkerData,
    });
  if (!workerResult) {
    throw new Error("SQLite session reclamation Worker returned no result");
  }
  if (workerResult.cleanupIncomplete) {
    reclamationLog.error("SQLite session reclamation committed but Worker cleanup is incomplete", {
      errors: workerResult.cleanupWarnings ?? [],
      path: params.plan.databaseOptions.path,
      recovery: "restart OpenClaw before deleting the owning agent",
    });
  } else if (workerResult.cleanupWarnings?.length) {
    reclamationLog.warn("SQLite session reclamation Worker recovered cleanup failures", {
      errors: workerResult.cleanupWarnings,
      path: params.plan.databaseOptions.path,
    });
  }
  return workerResult.result;
}

export function createSessionEntryReclamationPlan(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  deleteParams: DeleteSessionEntryLifecycleParams;
  materializedPlans: MaterializedSessionStateDeletePlan[];
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
}): Extract<SqliteSessionReclamationPlan, { kind: "entry" }> {
  return {
    databaseOptions: toWorkerDatabaseOptions(params.databaseOptions),
    deleteParams: toWorkerDeleteParams(params.deleteParams),
    kind: "entry",
    materializedPlans: params.materializedPlans,
    preparedTargetSnapshot: params.preparedTargetSnapshot,
  };
}

export function createLifecycleArtifactReclamationPlan(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  entries: SessionEntryRemovalPlan[];
  materializedPlans: MaterializedSessionStateDeletePlan[];
}): Extract<SqliteSessionReclamationPlan, { kind: "lifecycle-artifacts" }> {
  return {
    databaseOptions: toWorkerDatabaseOptions(params.databaseOptions),
    entries: params.entries,
    kind: "lifecycle-artifacts",
    materializedPlans: params.materializedPlans,
  };
}

export function createHistoryEvictionReclamationPlan(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  materializedPlans: MaterializedSessionStateDeletePlan[];
  protectedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): Extract<SqliteSessionReclamationPlan, { kind: "history-eviction" }> {
  return {
    databaseOptions: toWorkerDatabaseOptions(params.databaseOptions),
    kind: "history-eviction",
    materializedPlans: params.materializedPlans,
    protectedSessionIds: [...params.protectedSessionIds],
    sessionId: params.sessionId,
  };
}

export function createHistoricalGenerationReclamationPlan(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  deleteParams: DeleteSessionEntryLifecycleParams;
  materializedPlans: MaterializedSessionStateDeletePlan[];
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
  protectedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): Extract<SqliteSessionReclamationPlan, { kind: "historical-generation" }> {
  return {
    databaseOptions: toWorkerDatabaseOptions(params.databaseOptions),
    deleteParams: toWorkerDeleteParams(params.deleteParams),
    kind: "historical-generation",
    materializedPlans: params.materializedPlans,
    preparedTargetSnapshot: params.preparedTargetSnapshot,
    protectedSessionIds: [...params.protectedSessionIds],
    sessionId: params.sessionId,
  };
}
