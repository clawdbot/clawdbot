import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionDiskBudgetSweepResult } from "./disk-budget.js";
import {
  materializeSqliteSessionStateDeletePlans,
  type SqliteSessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import {
  enforceSqliteSessionDiskBudget,
  type SqliteSessionRowBytes,
} from "./session-accessor.sqlite-disk-budget.js";
import { readSqliteSessionEntryCount } from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionEntryRemovals } from "./session-accessor.sqlite-identity.js";
import {
  collectProjectedReferencedSqliteSessionIds,
  collectSqliteSessionStateIdsForEntry,
  deleteMaterializedSqliteSessionStatePlans,
  deletePlannedSqliteLifecycleArtifactEntries,
  planSqliteSessionStateDeleteIfUnreferenced,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type { SqliteSessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { normalizeSqliteNumber } from "./session-accessor.sqlite-normalize.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { parseSqliteSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { collectSessionMaintenancePreserveKeys } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  shouldRunModelRunPrune,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

// Entry pruning and disk-budget owner. Produces plans inside writes; finalizes archives afterward.

function collectSqliteSessionMaintenanceBaseKeys(
  store: Record<string, SessionEntry>,
  activeSessionKey: string,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  let currentKey = normalizeStoreSessionKey(activeSessionKey);
  while (currentKey && !seen.has(currentKey)) {
    seen.add(currentKey);
    keys.push(currentKey);
    currentKey = normalizeStoreSessionKey(store[currentKey]?.parentSessionKey ?? "");
  }
  return keys;
}

function sumEventJsonBytes() {
  return (
    // kysely-allow-raw: SQLite byte accounting needs LENGTH(CAST(... AS BLOB)),
    // which Kysely does not expose as a typed aggregate helper.
    sql<number | bigint>`COALESCE(SUM(length(CAST(event_json AS BLOB))), 0)`.as("event_json_bytes")
  );
}

function sumSessionEntryJsonBytes() {
  return (
    // kysely-allow-raw: SQLite byte accounting needs LENGTH(CAST(... AS BLOB)),
    // which Kysely does not expose as a typed aggregate helper.
    sql<number | bigint>`COALESCE(SUM(length(CAST(entry_json AS BLOB))), 0)`.as("entry_json_bytes")
  );
}

function readSqliteSessionRowBytes(database: OpenClawAgentDatabase): SqliteSessionRowBytes {
  const db = getSessionKysely(database.db);
  const entryRows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key", "entry_json"]),
  ).rows;
  const transcriptRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select(["session_id"])
      .select(sumEventJsonBytes())
      .groupBy("session_id"),
  ).rows;
  const trajectoryRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("trajectory_runtime_events")
      .select(["session_id"])
      .select(sumEventJsonBytes())
      .groupBy("session_id"),
  ).rows;
  const entryBytesByKey = new Map<string, number>();
  for (const row of entryRows) {
    entryBytesByKey.set(row.session_key, Buffer.byteLength(row.entry_json, "utf8"));
  }
  const transcriptBytesBySessionId = new Map<string, number>();
  for (const row of transcriptRows) {
    const bytes = row.event_json_bytes;
    transcriptBytesBySessionId.set(row.session_id, normalizeSqliteNumber(bytes ?? 0));
  }
  const trajectoryBytesBySessionId = new Map<string, number>();
  for (const row of trajectoryRows) {
    const bytes = row.event_json_bytes;
    trajectoryBytesBySessionId.set(row.session_id, normalizeSqliteNumber(bytes ?? 0));
  }
  return { entryBytesByKey, trajectoryBytesBySessionId, transcriptBytesBySessionId };
}

function hasSqliteSessionDiskBudgetOverflow(
  database: OpenClawAgentDatabase,
  maintenance: ResolvedSessionMaintenanceConfig,
): boolean {
  if (maintenance.maxDiskBytes == null || maintenance.highWaterBytes == null) {
    return false;
  }
  const db = getSessionKysely(database.db);
  const entryRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_entries").select(sumSessionEntryJsonBytes()),
  );
  const transcriptRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("transcript_events").select(sumEventJsonBytes()),
  );
  const trajectoryRow = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("trajectory_runtime_events").select(sumEventJsonBytes()),
  );
  const entryBytes = normalizeSqliteNumber(entryRow?.entry_json_bytes ?? 0);
  const transcriptBytes = normalizeSqliteNumber(transcriptRow?.event_json_bytes ?? 0);
  const trajectoryBytes = normalizeSqliteNumber(trajectoryRow?.event_json_bytes ?? 0);
  return entryBytes + transcriptBytes + trajectoryBytes > maintenance.maxDiskBytes;
}

function applySqliteSessionDiskBudget(params: {
  database: OpenClawAgentDatabase;
  store: Record<string, SessionEntry>;
  maintenance: ResolvedSessionMaintenanceConfig;
  preserveKeys: ReadonlySet<string>;
  rememberRemovedEntry: (removed: { key: string; entry: SessionEntry }) => void;
}): void {
  enforceSqliteSessionDiskBudgetInStore({
    database: params.database,
    store: params.store,
    maintenance: params.maintenance,
    preserveKeys: params.preserveKeys,
    onRemoveEntry: params.rememberRemovedEntry,
  });
}

function enforceSqliteSessionDiskBudgetInStore(params: {
  database: OpenClawAgentDatabase;
  store: Record<string, SessionEntry>;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "maxDiskBytes" | "highWaterBytes">;
  preserveKeys?: ReadonlySet<string>;
  onRemoveEntry?: (removed: { key: string; entry: SessionEntry }) => void;
}): SessionDiskBudgetSweepResult | null {
  return enforceSqliteSessionDiskBudget({
    collectStateIds: collectSqliteSessionStateIdsForEntry,
    maintenance: params.maintenance,
    onRemoveEntry: params.onRemoveEntry,
    preserveKeys: params.preserveKeys,
    rowBytes: readSqliteSessionRowBytes(params.database),
    store: params.store,
  });
}

export function previewSqliteSessionDiskBudget(params: {
  agentId?: string;
  activeSessionKey?: string;
  store: Record<string, SessionEntry>;
  storePath: string;
  maintenance: Pick<ResolvedSessionMaintenanceConfig, "maxDiskBytes" | "highWaterBytes">;
  preserveKeys?: ReadonlySet<string>;
}): { diskBudget: SessionDiskBudgetSweepResult | null; removedKeys: Set<string> } {
  const removedKeys = new Set<string>();
  if (params.maintenance.maxDiskBytes == null || params.maintenance.highWaterBytes == null) {
    return { diskBudget: null, removedKeys };
  }
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: "",
    storePath: params.storePath,
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const baseKeys = collectSqliteSessionMaintenanceBaseKeys(
    params.store,
    params.activeSessionKey ?? "",
  );
  const preserveKeys =
    baseKeys.length > 0 || params.preserveKeys
      ? new Set([...(params.preserveKeys ?? []), ...baseKeys])
      : undefined;
  const diskBudget = enforceSqliteSessionDiskBudgetInStore({
    database,
    store: params.store,
    maintenance: params.maintenance,
    preserveKeys,
    onRemoveEntry: ({ key }) => {
      removedKeys.add(key);
    },
  });
  return { diskBudget, removedKeys };
}

function hasStaleSqliteSessionEntryCandidate(
  database: OpenClawAgentDatabase,
  pruneAfterMs: number,
  preserveKeys: ReadonlySet<string> | undefined,
): boolean {
  const cutoffMs = Date.now() - pruneAfterMs;
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_entries")
      .select("session_key")
      .where("updated_at", "<", cutoffMs)
      .orderBy("updated_at", "asc"),
  ).rows;
  return rows.some((row) => !preserveKeys?.has(normalizeStoreSessionKey(row.session_key)));
}

export function applySqliteSessionEntryMaintenance(
  database: OpenClawAgentDatabase,
  params: {
    activeSessionKey: string;
    archiveDirectory: string;
    forceMaintenance?: boolean;
    maintenanceConfig?: ResolvedSessionMaintenanceConfig;
    skipMaintenance?: boolean;
  },
): SqliteSessionEntryMaintenancePlan {
  if (params.skipMaintenance) {
    return { entryRemovals: [], stateDeletePlans: [] };
  }
  const maintenance = params.maintenanceConfig ?? resolveMaintenanceConfig();
  if (maintenance.mode === "warn") {
    return { entryRemovals: [], stateDeletePlans: [] };
  }

  const entryCount = readSqliteSessionEntryCount(database);
  const preserveCandidateKeys = collectSessionMaintenancePreserveKeys([params.activeSessionKey]);
  const hasStaleCandidate = hasStaleSqliteSessionEntryCandidate(
    database,
    maintenance.pruneAfterMs,
    preserveCandidateKeys,
  );
  const hasDiskBudgetOverflow = hasSqliteSessionDiskBudgetOverflow(database, maintenance);
  const shouldLoadStore =
    params.forceMaintenance === true ||
    entryCount > maintenance.maxEntries ||
    hasStaleCandidate ||
    hasDiskBudgetOverflow ||
    shouldRunModelRunPrune({
      maintenance,
      entryCount,
      force: params.forceMaintenance,
    }) ||
    shouldRunSessionEntryMaintenance({
      entryCount,
      maxEntries: maintenance.maxEntries,
      force: params.forceMaintenance,
    });
  if (!shouldLoadStore) {
    return { entryRemovals: [], stateDeletePlans: [] };
  }

  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_entries").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }

  const removedKeys = new Set<string>();
  const removedEntriesByKey = new Map<string, SessionEntry>();
  const removedSessionIds = new Set<string>();
  const rememberRemovedEntry = (removed: { key: string; entry: SessionEntry }) => {
    removedKeys.add(removed.key);
    removedEntriesByKey.set(removed.key, cloneSessionEntry(removed.entry));
    for (const sessionId of collectSqliteSessionStateIdsForEntry(removed.entry)) {
      removedSessionIds.add(sessionId);
    }
  };
  const preserveKeys =
    collectSessionMaintenancePreserveKeys(
      collectSqliteSessionMaintenanceBaseKeys(store, params.activeSessionKey),
    ) ?? new Set<string>();
  if (
    shouldRunModelRunPrune({
      maintenance,
      entryCount: Object.keys(store).length,
      force: params.forceMaintenance,
    })
  ) {
    pruneStaleModelRunEntries(store, maintenance.modelRunPruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry,
      preserveKeys,
    });
  }
  if (
    params.forceMaintenance === true ||
    hasStaleCandidate ||
    Object.keys(store).length > maintenance.maxEntries
  ) {
    pruneStaleEntries(store, maintenance.pruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry,
      preserveKeys,
    });
  }
  if (
    shouldRunSessionEntryMaintenance({
      entryCount: Object.keys(store).length,
      maxEntries: maintenance.maxEntries,
      force: params.forceMaintenance,
    })
  ) {
    capEntryCount(store, maintenance.maxEntries, {
      log: false,
      onCapped: rememberRemovedEntry,
      preserveKeys,
    });
  }
  applySqliteSessionDiskBudget({
    database,
    store,
    maintenance,
    preserveKeys,
    rememberRemovedEntry,
  });

  const referencedSessionIds = collectProjectedReferencedSqliteSessionIds({
    database,
    excludedSessionKeys: removedKeys,
    projectedStore: store,
  });
  const deletePlans: SqliteSessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveTranscript: true,
      archiveDirectory: params.archiveDirectory,
      database,
      referencedSessionIds,
      sessionId,
    });
    if (plan) {
      deletePlans.push(plan);
    }
  }
  return {
    entryRemovals: [...removedKeys].map((sessionKey) => ({
      expectedEntry: removedEntriesByKey.get(sessionKey),
      sessionKey,
    })),
    stateDeletePlans: deletePlans,
  };
}

export function finalizeSqliteSessionEntryMaintenancePlansBestEffort(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  plans: readonly SqliteSessionEntryMaintenancePlan[],
): SessionLifecycleArchivedTranscript[] {
  const entryRemovals = plans.flatMap((plan) => plan.entryRemovals);
  const stateDeletePlans = plans.flatMap((plan) => plan.stateDeletePlans);
  if (entryRemovals.length === 0 && stateDeletePlans.length === 0) {
    return [];
  }
  try {
    const materializedPlans = materializeSqliteSessionStateDeletePlans(stateDeletePlans);
    let archivedTranscripts: SessionLifecycleArchivedTranscript[] = [];
    runOpenClawAgentWriteTransaction((database) => {
      deletePlannedSqliteLifecycleArtifactEntries(database, entryRemovals);
      archivedTranscripts = deleteMaterializedSqliteSessionStatePlans(database, materializedPlans);
    }, toDatabaseOptions(scope));
    emitCommittedSessionEntryRemovals(entryRemovals);
    return archivedTranscripts;
  } catch (error) {
    getChildLogger({ subsystem: "session-sqlite" }).warn(
      "SQLite session maintenance cleanup failed",
      {
        agentId: scope.agentId,
        error,
        path: scope.path,
        sessionIds: uniqueStrings(stateDeletePlans.map((plan) => plan.sessionId)),
      },
    );
    return [];
  }
}

// Revalidates transcript bytes before row deletion so a concurrent append is
// not dropped by an archive prepared from older content.
