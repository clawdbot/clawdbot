// Storage-neutral session registry maintenance for task-owned cron run cleanup.
import fs from "node:fs";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntries,
  type SessionEntryLifecycleRemoval,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { collectActiveSessionWorkAdmissionKeys } from "./store-maintenance-preserve.js";
import { pruneStaleEntries } from "./store.js";
import type { SessionEntry } from "./types.js";

export type SessionRegistryMaintenanceStoreSummary = {
  afterCount: number;
  beforeCount: number;
  preservedRunning: number;
  pruned: number;
};

export type SessionRegistryMaintenanceStoreOptions = {
  /** Apply pruning to the backing store; false previews against a clone. */
  apply: boolean;
  /** Retention window for cron-run session entries. */
  retentionMs: number;
  /** Currently running cron job ids, normalized to lowercase. */
  runningCronJobIds: ReadonlySet<string>;
  /** Resolved session registry store path for one agent. */
  storePath: string;
};

function parseCronRunSessionJobId(sessionKey: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return undefined;
  }
  return /^cron:([^:]+):run:[^:]+$/u.exec(parsed.rest)?.[1];
}

function buildSessionRegistryPreserveKeys(params: {
  runningCronJobIds: ReadonlySet<string>;
  storePath: string;
  store: Record<string, SessionEntry>;
}): { preserveKeys: Set<string>; preservedRunning: number } {
  const preserveKeys =
    collectActiveSessionWorkAdmissionKeys({
      storePath: params.storePath,
      store: params.store,
    }) ?? new Set<string>();
  let preservedRunning = 0;
  for (const key of Object.keys(params.store)) {
    const jobId = parseCronRunSessionJobId(key);
    if (!jobId) {
      // This sweep owns only cron-run rows; all ordinary sessions are preserved.
      preserveKeys.add(key);
      continue;
    }
    if (params.runningCronJobIds.has(jobId)) {
      preserveKeys.add(key);
      preservedRunning += 1;
    }
  }
  return { preserveKeys, preservedRunning };
}

function pruneSessionRegistryStore(params: {
  retentionMs: number;
  removals?: SessionEntryLifecycleRemoval[];
  runningCronJobIds: ReadonlySet<string>;
  storePath: string;
  store: Record<string, SessionEntry>;
}): Omit<SessionRegistryMaintenanceStoreSummary, "beforeCount"> {
  const { preserveKeys, preservedRunning } = buildSessionRegistryPreserveKeys({
    runningCronJobIds: params.runningCronJobIds,
    storePath: params.storePath,
    store: params.store,
  });
  const pruned = pruneStaleEntries(params.store, params.retentionMs, {
    log: false,
    onPruned: params.removals
      ? ({ key, entry }) => {
          params.removals?.push({ sessionKey: key, expectedEntry: entry });
        }
      : undefined,
    preserveKeys,
  });
  return {
    afterCount: Object.keys(params.store).length,
    preservedRunning,
    pruned,
  };
}

/**
 * Runs task session-registry maintenance for one resolved agent store.
 * Preview prunes a clone; apply uses one store-sized write transaction and
 * skips generic session maintenance so non-cron rows stay outside this sweep.
 */
export async function runSessionRegistryMaintenanceForStore(
  params: SessionRegistryMaintenanceStoreOptions,
): Promise<SessionRegistryMaintenanceStoreSummary> {
  const sqliteTarget = resolveSqliteTargetFromSessionStorePath(params.storePath);
  if (sqliteTarget.path && !fs.existsSync(sqliteTarget.path)) {
    return {
      beforeCount: 0,
      afterCount: 0,
      preservedRunning: 0,
      pruned: 0,
    };
  }
  const beforeStore = Object.fromEntries(
    listSessionEntries({ storePath: params.storePath }).map(({ sessionKey, entry }) => [
      sessionKey,
      entry,
    ]),
  );
  const beforeCount = Object.keys(beforeStore).length;
  if (!params.apply) {
    const previewStore = structuredClone(beforeStore);
    return {
      beforeCount,
      ...pruneSessionRegistryStore({
        retentionMs: params.retentionMs,
        runningCronJobIds: params.runningCronJobIds,
        storePath: params.storePath,
        store: previewStore,
      }),
    };
  }

  const applyStore = structuredClone(beforeStore);
  const removals: SessionEntryLifecycleRemoval[] = [];
  const applied = pruneSessionRegistryStore({
    retentionMs: params.retentionMs,
    removals,
    runningCronJobIds: params.runningCronJobIds,
    storePath: params.storePath,
    store: applyStore,
  });
  if (removals.length > 0) {
    const mutation = await applySessionEntryLifecycleMutation({
      storePath: params.storePath,
      removals,
      skipMaintenance: true,
    });
    return {
      afterCount: mutation.afterCount,
      beforeCount,
      preservedRunning: applied.preservedRunning,
      pruned: mutation.removedEntries,
    };
  }
  return {
    beforeCount,
    ...applied,
  };
}
