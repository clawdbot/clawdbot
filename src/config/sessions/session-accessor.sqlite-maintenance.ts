import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  materializeSqliteSessionStateDeletePlans,
  type SqliteSessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
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
import {
  cloneSessionEntry,
  getSessionKysely,
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

// Live-entry pruning owner. Produces plans inside writes; finalizes archives afterward.

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
  const shouldLoadStore =
    params.forceMaintenance === true ||
    entryCount > maintenance.maxEntries ||
    hasStaleCandidate ||
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
