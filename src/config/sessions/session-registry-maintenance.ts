// Storage-neutral session registry maintenance for task-owned cron run cleanup.
import fs from "node:fs";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { collectActiveSessionWorkAdmissionKeys } from "./store-maintenance-preserve.js";
import { loadSessionStore, pruneStaleEntries, updateSessionStore } from "./store.js";
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
  if (!fs.existsSync(params.storePath)) {
    return {
      afterCount: 0,
      beforeCount: 0,
      preservedRunning: 0,
      pruned: 0,
    };
  }

  const beforeStore = loadSessionStore(params.storePath, { skipCache: true });
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

  const applied = await updateSessionStore(
    params.storePath,
    (store) =>
      pruneSessionRegistryStore({
        retentionMs: params.retentionMs,
        runningCronJobIds: params.runningCronJobIds,
        storePath: params.storePath,
        store,
      }),
    { skipMaintenance: true },
  );
  return {
    beforeCount,
    ...applied,
  };
}
