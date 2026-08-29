import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { getChildLogger } from "../../logging/logger.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import {
  materializeSessionStateDeletePlans,
  type SessionStateDeletePlan,
} from "./session-accessor.sqlite-archive.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import {
  runSqliteSessionDeletionTransaction as runOpenClawAgentWriteTransaction,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import {
  readSessionEntryCount,
  readSessionEntryStore,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
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
  archiveStaleDashboardEntries,
  capEntryCount,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  normalizeResolvedMaintenanceConfigInput,
  shouldPreserveMaintenanceEntry,
  shouldRunModelRunPrune,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfigInput,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

// Live-entry pruning owner. Produces plans inside writes; finalizes archives afterward.

const MAX_SESSION_MAINTENANCE_BATCH_ENTRIES = 64;
const MAX_SESSION_MAINTENANCE_BATCH_ARCHIVE_BYTES = 64 * 1024 * 1024;
const SESSION_TRANSCRIPT_BYTE_QUERY_BATCH = MAX_SESSION_MAINTENANCE_BATCH_ENTRIES;

type SessionMaintenanceBatch = {
  archiveBytes: number;
  entryRemovals: SessionEntryMaintenancePlan["entryRemovals"];
  stateDeletePlans: SessionStateDeletePlan[];
  workItems: number;
};

function buildSessionMaintenanceBatches(params: {
  archiveBytesBySessionId: ReadonlyMap<string, number>;
  entryRemovals: SessionEntryMaintenancePlan["entryRemovals"];
  stateDeletePlans: readonly SessionStateDeletePlan[];
}): SessionMaintenanceBatch[] {
  const parent = params.entryRemovals.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root] ?? root;
    }
    let current = index;
    while (parent[current] !== current) {
      const next = parent[current] ?? root;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  const removalIndexesBySessionId = new Map<string, number[]>();
  const removalIndexBySessionKey = new Map<string, number>();
  const addRemovalIndex = (sessionId: string, index: number): void => {
    const indexes = removalIndexesBySessionId.get(sessionId) ?? [];
    if (indexes.includes(index)) {
      return;
    }
    if (indexes.length > 0) {
      union(indexes[0] ?? index, index);
    }
    indexes.push(index);
    removalIndexesBySessionId.set(sessionId, indexes);
  };
  for (const [index, removal] of params.entryRemovals.entries()) {
    if (!removal.expectedEntry) {
      continue;
    }
    removalIndexBySessionKey.set(removal.sessionKey, index);
    for (const sessionId of collectSessionStateIdsForEntry(removal.expectedEntry)) {
      addRemovalIndex(sessionId, index);
    }
  }
  for (const plan of params.stateDeletePlans) {
    const ownerIndex = plan.snapshot.sessionKey
      ? removalIndexBySessionKey.get(plan.snapshot.sessionKey)
      : undefined;
    if (ownerIndex !== undefined) {
      addRemovalIndex(plan.sessionId, ownerIndex);
    }
  }

  const groupsByRoot = new Map<number, SessionMaintenanceBatch & { order: number }>();
  for (const [index, removal] of params.entryRemovals.entries()) {
    const root = find(index);
    const group = groupsByRoot.get(root) ?? {
      archiveBytes: 0,
      entryRemovals: [],
      order: index,
      stateDeletePlans: [],
      workItems: 0,
    };
    group.entryRemovals.push(removal);
    group.order = Math.min(group.order, index);
    groupsByRoot.set(root, group);
  }

  const plansBySessionId = new Map<string, SessionStateDeletePlan[]>();
  for (const plan of params.stateDeletePlans) {
    const plans = plansBySessionId.get(plan.sessionId) ?? [];
    plans.push(plan);
    plansBySessionId.set(plan.sessionId, plans);
  }
  const standaloneGroups: Array<SessionMaintenanceBatch & { order: number }> = [];
  let standaloneOrder = params.entryRemovals.length;
  for (const [sessionId, plans] of plansBySessionId) {
    const removalIndex = removalIndexesBySessionId.get(sessionId)?.[0];
    const removalGroup =
      removalIndex === undefined ? undefined : groupsByRoot.get(find(removalIndex));
    const group = removalGroup ?? {
      archiveBytes: 0,
      entryRemovals: [],
      order: standaloneOrder++,
      stateDeletePlans: [],
      workItems: 0,
    };
    group.stateDeletePlans.push(...plans);
    if (plans.some((plan) => plan.archiveTranscript)) {
      group.archiveBytes += params.archiveBytesBySessionId.get(sessionId) ?? 0;
    }
    if (!removalGroup) {
      standaloneGroups.push(group);
    }
  }

  const groups = [...groupsByRoot.values(), ...standaloneGroups]
    .map((group) => {
      group.workItems = Math.max(
        group.entryRemovals.length,
        new Set(group.stateDeletePlans.map((plan) => plan.sessionId)).size,
      );
      return group;
    })
    .toSorted((left, right) => left.order - right.order);
  const batches: SessionMaintenanceBatch[] = [];
  let batch: SessionMaintenanceBatch = {
    archiveBytes: 0,
    entryRemovals: [],
    stateDeletePlans: [],
    workItems: 0,
  };
  const flush = (): void => {
    if (batch.workItems === 0) {
      return;
    }
    batches.push(batch);
    batch = { archiveBytes: 0, entryRemovals: [], stateDeletePlans: [], workItems: 0 };
  };
  // Limits apply between ownership groups. One inseparable group may exceed them so shared or
  // historical session state is never deleted in a different transaction from its last owner.
  for (const group of groups) {
    const exceedsEntryLimit =
      batch.workItems > 0 &&
      batch.workItems + group.workItems > MAX_SESSION_MAINTENANCE_BATCH_ENTRIES;
    const exceedsByteLimit =
      batch.workItems > 0 &&
      batch.archiveBytes + group.archiveBytes > MAX_SESSION_MAINTENANCE_BATCH_ARCHIVE_BYTES;
    if (exceedsEntryLimit || exceedsByteLimit) {
      flush();
    }
    batch.archiveBytes += group.archiveBytes;
    batch.entryRemovals.push(...group.entryRemovals);
    batch.stateDeletePlans.push(...group.stateDeletePlans);
    batch.workItems += group.workItems;
  }
  flush();
  return batches;
}

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
  maxAgeMs: number,
  isCandidate: (key: string, entry: SessionEntry) => boolean,
): boolean {
  if (maxAgeMs <= 0) {
    return false;
  }
  const cutoffMs = Date.now() - maxAgeMs;
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
    return isCandidate(normalizeStoreSessionKey(row.session_key), entry);
  });
}

async function readSessionTranscriptJsonlBytes(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  sessionIds: readonly string[],
): Promise<Map<string, number>> {
  const bytesBySessionId = new Map<string, number>();
  for (let offset = 0; offset < sessionIds.length; offset += SESSION_TRANSCRIPT_BYTE_QUERY_BATCH) {
    const batch = sessionIds.slice(offset, offset + SESSION_TRANSCRIPT_BYTE_QUERY_BATCH);
    // Give queued writers a turn between bounded read-only sizing batches.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const opened = withOpenClawAgentDatabaseReadOnly((database) => {
      const db = getSessionKysely(database.db);
      return executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select([
            "session_id",
            /* kysely-allow-raw: exact JSONL bytes bound maintenance worker batches. */
            sql<number | bigint>`SUM(OCTET_LENGTH(event_json) + 1)`.as("jsonl_bytes"),
          ])
          .where("session_id", "in", batch)
          .groupBy("session_id"),
      ).rows;
    }, toDatabaseOptions(scope));
    if (!opened.found) {
      throw new Error(
        `Cannot size SQLite session transcripts: ${opened.reason.replaceAll("-", " ")}`,
      );
    }
    for (const row of opened.value) {
      bytesBySessionId.set(row.session_id, Number(row.jsonl_bytes));
    }
  }
  return bytesBySessionId;
}

export function applySessionEntryMaintenance(
  database: OpenClawAgentDatabase,
  params: {
    activeSessionKey: string;
    archiveDirectory: string;
    forceMaintenance?: boolean;
    maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
    skipMaintenance?: boolean;
    storePath: string;
  },
): SessionEntryMaintenancePlan {
  if (params.skipMaintenance) {
    return {
      entryRemovals: [],
      stateDeletePlans: [],
      archived: 0,
      modelRunPruned: 0,
      pruned: 0,
      capped: 0,
    };
  }
  const maintenance = params.maintenanceConfig
    ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
    : resolveMaintenanceConfig();
  if (maintenance.mode === "warn") {
    return {
      entryRemovals: [],
      stateDeletePlans: [],
      archived: 0,
      modelRunPruned: 0,
      pruned: 0,
      capped: 0,
    };
  }

  // Count all rows before loading their payloads. Protection controls eviction candidates, not
  // whether a row consumes maxEntries; the full snapshot is needed only when maintenance runs.
  const entryCount = readSessionEntryCount(database);
  const preserveCandidateKeys = collectSessionMaintenancePreserveKeys([params.activeSessionKey]);
  const hasStaleCandidate = hasStaleSqliteSessionEntryCandidate(
    database,
    maintenance.pruneAfterMs,
    (key, entry) =>
      !shouldPreserveMaintenanceEntry({
        key,
        entry,
        preserveKeys: preserveCandidateKeys,
        preserveRecentMs: maintenance.preserveRecentMs ?? null,
      }),
  );
  const hasStaleDashboardCandidate =
    maintenance.archiveDashboardAfterMs != null &&
    hasStaleSqliteSessionEntryCandidate(
      database,
      maintenance.archiveDashboardAfterMs,
      (key, entry) =>
        archiveStaleDashboardEntries({ [key]: entry }, maintenance.archiveDashboardAfterMs, {
          log: false,
          preserveKeys: preserveCandidateKeys,
        }) > 0,
    );
  const shouldMaintainStore =
    params.forceMaintenance === true ||
    entryCount > maintenance.maxEntries ||
    hasStaleDashboardCandidate ||
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
    return {
      entryRemovals: [],
      stateDeletePlans: [],
      archived: 0,
      modelRunPruned: 0,
      pruned: 0,
      capped: 0,
    };
  }

  const store = readSessionEntryStore(database);
  const preserveKeys =
    collectSessionMaintenancePreserveKeysForStore({
      storePath: params.storePath,
      store,
      baseKeys: collectSqliteSessionMaintenanceBaseKeys(store, params.activeSessionKey),
    }) ?? new Set<string>();
  const removals = new Map<string, SessionEntryMaintenancePlan["entryRemovals"][number]>();
  const removedSessionIds = new Set<string>();
  const rememberRemovedEntry =
    (
      maintenanceReason: NonNullable<
        SessionEntryMaintenancePlan["entryRemovals"][number]["maintenanceReason"]
      >,
    ) =>
    (removed: { key: string; entry: SessionEntry }) => {
      removals.set(removed.key, {
        expectedEntry: cloneSessionEntry(removed.entry),
        maintenanceReason,
        sessionKey: removed.key,
      });
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
      onPruned: rememberRemovedEntry("model-run-pruned"),
      preserveKeys,
      preserveRecentMs: maintenance.preserveRecentMs,
    });
    remainingEntryCount -= modelRunPruned;
  }
  const archived = archiveStaleDashboardEntries(store, maintenance.archiveDashboardAfterMs, {
    log: false,
    onArchived: ({ key, entry }) => {
      writeSessionEntry(database, key, entry);
    },
    preserveKeys,
  });
  let pruned = 0;
  if (
    params.forceMaintenance === true ||
    hasStaleCandidate ||
    remainingEntryCount > maintenance.maxEntries
  ) {
    pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, {
      log: false,
      onPruned: rememberRemovedEntry("pruned"),
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
      onCapped: rememberRemovedEntry("capped"),
      preserveKeys,
      preserveRecentMs: maintenance.preserveRecentMs,
    });
  }
  for (const sessionId of readSessionGenerationIdsForKeys(database, removals.keys())) {
    removedSessionIds.add(sessionId);
  }
  const referencedSessionIds = collectProjectedReferencedSessionIds({
    database,
    excludedSessionKeys: removals.keys(),
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
    entryRemovals: [...removals.values()],
    stateDeletePlans: deletePlans,
    archived,
    modelRunPruned,
    pruned,
    capped,
  };
}

/** Finalizes maintenance after its caller releases the per-store writer lane. */
export async function finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  plans: readonly SessionEntryMaintenancePlan[],
): Promise<SessionEntryMaintenanceResult> {
  const entryRemovals = plans.flatMap((plan) => plan.entryRemovals);
  const stateDeletePlans = plans.flatMap((plan) => plan.stateDeletePlans);
  const warn = (
    message: string,
    error: unknown,
    warnedStateDeletePlans: readonly SessionStateDeletePlan[],
  ) => {
    getChildLogger({ subsystem: "session-sqlite" }).warn(message, {
      agentId: scope.agentId,
      error,
      path: scope.path,
      sessionIds: uniqueStrings(warnedStateDeletePlans.map((plan) => plan.sessionId)),
    });
  };
  const committedCounts = {
    archived: plans.reduce((count, plan) => count + plan.archived, 0),
    modelRunPruned: 0,
    pruned: 0,
    capped: 0,
  };
  if (entryRemovals.length === 0 && stateDeletePlans.length === 0) {
    return { archivedTranscripts: [], ...committedCounts };
  }
  let archiveBytesBySessionId: Map<string, number>;
  try {
    archiveBytesBySessionId = await readSessionTranscriptJsonlBytes(
      scope,
      stateDeletePlans.filter((plan) => plan.archiveTranscript).map((plan) => plan.sessionId),
    );
  } catch (error) {
    warn("SQLite session maintenance archive sizing failed", error, stateDeletePlans);
    return { archivedTranscripts: [], ...committedCounts };
  }
  const publishedTranscripts: SessionLifecycleArchivedTranscript[] = [];
  for (const batch of buildSessionMaintenanceBatches({
    archiveBytesBySessionId,
    entryRemovals,
    stateDeletePlans,
  })) {
    let archivedTranscripts: SessionLifecycleArchivedTranscript[];
    try {
      const materializedPlans = await materializeSessionStateDeletePlans(batch.stateDeletePlans);
      archivedTranscripts = await withSqliteSessionDeletions(
        scope,
        batch.entryRemovals.flatMap(({ expectedEntry: entry, sessionKey }) =>
          entry ? [{ entry, sessionKey }] : [],
        ),
        async () =>
          await runExclusiveSqliteSessionWrite(scope, async () => {
            let committed: SessionLifecycleArchivedTranscript[] = [];
            runOpenClawAgentWriteTransaction((database) => {
              assertPlannedLifecycleArtifactEntriesUnchanged(database, batch.entryRemovals);
              committed = deleteMaterializedSessionStatePlans(
                database,
                materializedPlans,
                undefined,
                new Set(batch.entryRemovals.map((removal) => removal.sessionKey)),
              );
              deletePlannedLifecycleArtifactEntries(database, batch.entryRemovals);
            }, toDatabaseOptions(scope));
            return committed;
          }),
      );
    } catch (error) {
      warn("SQLite session maintenance cleanup failed", error, batch.stateDeletePlans);
      break;
    }
    emitCommittedSessionEntryRemovals(batch.entryRemovals);
    for (const removal of batch.entryRemovals) {
      if (removal.maintenanceReason === "model-run-pruned") {
        committedCounts.modelRunPruned += 1;
      } else if (removal.maintenanceReason === "pruned") {
        committedCounts.pruned += 1;
      } else if (removal.maintenanceReason === "capped") {
        committedCounts.capped += 1;
      }
    }
    try {
      publishedTranscripts.push(...(await publishSessionStateArchives(scope, archivedTranscripts)));
    } catch (error) {
      warn("SQLite session maintenance archive publication failed", error, batch.stateDeletePlans);
    }
  }
  return { archivedTranscripts: publishedTranscripts, ...committedCounts };
}
