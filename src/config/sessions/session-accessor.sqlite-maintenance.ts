import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import {
  materializeSessionStateDeletePlans,
  type SessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryCount } from "./session-accessor.sqlite-entry-store.js";
import { emitCommittedSessionEntryRemovals } from "./session-accessor.sqlite-identity.js";
import {
  assertPlannedLifecycleArtifactEntriesUnchanged,
  collectProjectedReferencedSessionIds,
  collectSessionStateIdsForEntry,
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
  planSessionStateDeleteIfUnreferenced,
  readSessionGenerationIdsForKeys,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  SessionEntryMaintenancePlan,
  SessionEntryMaintenanceResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson as parseSessionEntryRow } from "./session-accessor.sqlite-status.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import {
  collectSessionMaintenancePreserveKeys,
  collectSessionMaintenancePreserveKeysForStore,
} from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  shouldPreserveMaintenanceEntry,
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
  preserveRecentMs: number | null,
): boolean {
  const cutoffMs = Date.now() - pruneAfterMs;
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["entry_json", "session_key"])
      .where("updated_at", "<", cutoffMs)
      .where("archived_at", "is", null)
      .orderBy("updated_at", "asc"),
  ).rows;
  return rows.some((row) => {
    const entry = parseSessionEntryRow(row);
    if (!entry) {
      return false;
    }
    return !shouldPreserveMaintenanceEntry({
      key: normalizeStoreSessionKey(row.session_key),
      entry,
      preserveKeys,
      preserveRecentMs,
    });
  });
}

function loadSqliteSessionMaintenanceStore(
  database: OpenClawAgentDatabase,
): Record<string, SessionEntry> {
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select(["session_key", "entry_json"]).orderBy("session_key"),
  ).rows;
  const store: Record<string, SessionEntry> = {};
  for (const row of rows) {
    const entry = parseSessionEntryRow(row);
    if (entry) {
      store[row.session_key] = entry;
    }
  }
  return store;
}

export function applySessionEntryMaintenance(
  database: OpenClawAgentDatabase,
  params: {
    activeSessionKey: string;
    archiveDirectory: string;
    forceMaintenance?: boolean;
    maintenanceConfig?: ResolvedSessionMaintenanceConfig;
    skipMaintenance?: boolean;
    storePath: string;
  },
): SessionEntryMaintenancePlan {
  if (params.skipMaintenance) {
    return { entryRemovals: [], stateDeletePlans: [], modelRunPruned: 0, pruned: 0, capped: 0 };
  }
  const maintenance = params.maintenanceConfig ?? resolveMaintenanceConfig();
  if (maintenance.mode === "warn") {
    return { entryRemovals: [], stateDeletePlans: [], modelRunPruned: 0, pruned: 0, capped: 0 };
  }

  // Count all rows before loading their payloads. Protection controls eviction candidates, not
  // whether a row consumes maxEntries; the full snapshot is needed only when maintenance runs.
  const entryCount = readSessionEntryCount(database);
  const preserveCandidateKeys = collectSessionMaintenancePreserveKeys([params.activeSessionKey]);
  const hasStaleCandidate = hasStaleSqliteSessionEntryCandidate(
    database,
    maintenance.pruneAfterMs,
    preserveCandidateKeys,
    maintenance.preserveRecentMs ?? null,
  );
  const shouldMaintainStore =
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
  if (!shouldMaintainStore) {
    return { entryRemovals: [], stateDeletePlans: [], modelRunPruned: 0, pruned: 0, capped: 0 };
  }

  const store = loadSqliteSessionMaintenanceStore(database);
  const preserveKeys =
    collectSessionMaintenancePreserveKeysForStore({
      storePath: params.storePath,
      store,
      baseKeys: collectSqliteSessionMaintenanceBaseKeys(store, params.activeSessionKey),
    }) ?? new Set<string>();
  const removedKeys = new Set<string>();
  const removedEntriesByKey = new Map<string, SessionEntry>();
  const removedSessionIds = new Set<string>();
  const rememberRemovedEntry = (removed: { key: string; entry: SessionEntry }) => {
    removedKeys.add(removed.key);
    removedEntriesByKey.set(removed.key, cloneSessionEntry(removed.entry));
    for (const sessionId of collectSessionStateIdsForEntry(removed.entry)) {
      removedSessionIds.add(sessionId);
    }
  };
  let remainingEntryCount = entryCount;
  let modelRunPruned = 0;
  if (
    shouldRunModelRunPrune({
      maintenance,
      entryCount: remainingEntryCount,
      force: params.forceMaintenance,
    })
  ) {
    modelRunPruned = pruneStaleModelRunEntries(store, maintenance.modelRunPruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry,
      preserveKeys,
      preserveRecentMs: maintenance.preserveRecentMs,
    });
    remainingEntryCount -= modelRunPruned;
  }
  let pruned = 0;
  if (
    params.forceMaintenance === true ||
    hasStaleCandidate ||
    remainingEntryCount > maintenance.maxEntries
  ) {
    pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry,
      preserveKeys,
      preserveRecentMs: maintenance.preserveRecentMs,
    });
    remainingEntryCount -= pruned;
  }
  let capped = 0;
  if (
    shouldRunSessionEntryMaintenance({
      entryCount: remainingEntryCount,
      maxEntries: maintenance.maxEntries,
      force: params.forceMaintenance,
    })
  ) {
    capped = capEntryCount(store, maintenance.maxEntries, {
      log: false,
      onCapped: rememberRemovedEntry,
      preserveKeys,
      preserveRecentMs: maintenance.preserveRecentMs,
    });
  }
  for (const sessionId of readSessionGenerationIdsForKeys(database, removedKeys)) {
    removedSessionIds.add(sessionId);
  }
  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database,
    excludedSessionKeys: removedKeys,
    projectedStore: store,
  });
  const deletePlans: SessionStateDeletePlan[] = [];
  for (const sessionId of removedSessionIds) {
    const plan = planSessionStateDeleteIfUnreferenced({
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
    entryRemovals: [...removedEntriesByKey].map(([sessionKey, entry]) => ({
      expectedEntry: entry,
      sessionKey,
    })),
    stateDeletePlans: deletePlans,
    modelRunPruned,
    pruned,
    capped,
  };
}

export async function finalizeSessionEntryMaintenancePlansBestEffort(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  plans: readonly SessionEntryMaintenancePlan[],
): Promise<SessionEntryMaintenanceResult> {
  return await finalizeSqliteSessionEntryMaintenancePlansWithCommit(scope, plans, async (commit) =>
    commit(),
  );
}

/** Finalizes maintenance after its caller releases the per-store writer lane. */
export async function finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  plans: readonly SessionEntryMaintenancePlan[],
): Promise<SessionEntryMaintenanceResult> {
  return await finalizeSqliteSessionEntryMaintenancePlansWithCommit(
    scope,
    plans,
    async (commit) => await runExclusiveSqliteSessionWrite(scope, async () => commit()),
  );
}

async function finalizeSqliteSessionEntryMaintenancePlansWithCommit(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  plans: readonly SessionEntryMaintenancePlan[],
  commit: (
    fn: () => SessionLifecycleArchivedTranscript[],
  ) => Promise<SessionLifecycleArchivedTranscript[]>,
): Promise<SessionEntryMaintenanceResult> {
  const entryRemovals = plans.flatMap((plan) => plan.entryRemovals);
  const stateDeletePlans = plans.flatMap((plan) => plan.stateDeletePlans);
  const warn = (message: string, error: unknown) => {
    getChildLogger({ subsystem: "session-sqlite" }).warn(message, {
      agentId: scope.agentId,
      error,
      path: scope.path,
      sessionIds: uniqueStrings(stateDeletePlans.map((plan) => plan.sessionId)),
    });
  };
  const emptyResult: SessionEntryMaintenanceResult = {
    archivedTranscripts: [],
    modelRunPruned: 0,
    pruned: 0,
    capped: 0,
  };
  if (entryRemovals.length === 0 && stateDeletePlans.length === 0) {
    return emptyResult;
  }
  let archivedTranscripts: SessionLifecycleArchivedTranscript[];
  try {
    const materializedPlans = await materializeSessionStateDeletePlans(stateDeletePlans);
    archivedTranscripts = await commit(() => {
      let committed: SessionLifecycleArchivedTranscript[] = [];
      runOpenClawAgentWriteTransaction((database) => {
        assertPlannedLifecycleArtifactEntriesUnchanged(database, entryRemovals);
        committed = deleteMaterializedSessionStatePlans(
          database,
          materializedPlans,
          undefined,
          new Set(entryRemovals.map((removal) => removal.sessionKey)),
        );
        deletePlannedLifecycleArtifactEntries(database, entryRemovals);
      }, toDatabaseOptions(scope));
      return committed;
    });
  } catch (error) {
    warn("SQLite session maintenance cleanup failed", error);
    return emptyResult;
  }
  const committedCounts = plans.reduce(
    (counts, plan) => ({
      modelRunPruned: counts.modelRunPruned + plan.modelRunPruned,
      pruned: counts.pruned + plan.pruned,
      capped: counts.capped + plan.capped,
    }),
    { modelRunPruned: 0, pruned: 0, capped: 0 },
  );
  emitCommittedSessionEntryRemovals(entryRemovals);
  try {
    return {
      archivedTranscripts: await publishSessionStateArchives(scope, archivedTranscripts),
      ...committedCounts,
    };
  } catch (error) {
    warn("SQLite session maintenance archive publication failed", error);
    return { archivedTranscripts: [], ...committedCounts };
  }
}
