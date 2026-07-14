// Storage-neutral session maintenance operations for the file-backed session store.
import path from "node:path";
import { enforceSessionDiskBudget, type SessionDiskBudgetSweepResult } from "./disk-budget.js";
import { collectSessionMaintenancePreserveKeysForStore } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  getActiveSessionMaintenanceWarning,
  pruneStaleModelRunEntries,
  pruneStaleEntries,
  shouldRunModelRunPrune,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
  type SessionMaintenanceWarning,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

export type SessionMaintenanceApplyReport = {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  beforeCount: number;
  afterCount: number;
  modelRunPruned: number;
  pruned: number;
  capped: number;
  diskBudget: SessionDiskBudgetSweepResult | null;
};

type SessionMaintenanceLogger = {
  warn: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
};

type RemovedSessionFiles = Map<string, string | undefined>;

type RemovedSessionArtifactCleanup = {
  archiveRemovedSessionTranscripts: (params: {
    removedSessionFiles: Iterable<[string, string | undefined]>;
    referencedSessionIds: ReadonlySet<string>;
    storePath: string;
    reason: "deleted";
    restrictToStoreDir: true;
  }) => Promise<Set<string>>;
  removeRemovedSessionTrajectoryArtifacts: (params: {
    removedSessionFiles: RemovedSessionFiles;
    referencedSessionIds: ReadonlySet<string>;
    storePath: string;
    restrictToStoreDir: true;
  }) => Promise<void>;
  cleanupArchivedSessionTranscripts: (params: {
    directories: string[];
    rules: Array<{ reason: "deleted" | "reset"; olderThanMs: number }>;
  }) => Promise<void>;
};

type FileBackedSessionStoreMaintenanceParams = {
  storePath: string;
  store: Record<string, SessionEntry>;
  activeSessionKey?: string;
  onWarn?: (warning: SessionMaintenanceWarning) => void | Promise<void>;
  onMaintenanceApplied?: (report: SessionMaintenanceApplyReport) => void | Promise<void>;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  log: SessionMaintenanceLogger;
  artifacts: RemovedSessionArtifactCleanup;
};

type FileBackedSessionStoreMaintenanceResult = {
  changedStore: boolean;
};

function resolveMaintenanceForOperation(
  params: Pick<
    FileBackedSessionStoreMaintenanceParams,
    "maintenanceConfig" | "maintenanceOverride"
  >,
): ResolvedSessionMaintenanceConfig {
  return params.maintenanceConfig
    ? { ...params.maintenanceConfig, ...params.maintenanceOverride }
    : { ...resolveMaintenanceConfig(), ...params.maintenanceOverride };
}

function collectReferencedSessionIds(store: Record<string, SessionEntry>): Set<string> {
  return new Set(
    Object.values(store)
      .map((entry) => entry?.sessionId)
      .filter((id): id is string => Boolean(id)),
  );
}

function rememberRemovedSessionFile(
  removedSessionFiles: RemovedSessionFiles,
  entry: SessionEntry,
): void {
  if (!removedSessionFiles.has(entry.sessionId) || entry.sessionFile) {
    removedSessionFiles.set(entry.sessionId, entry.sessionFile);
  }
}

async function applyWarnOnlyMaintenance(params: {
  operation: FileBackedSessionStoreMaintenanceParams;
  maintenance: ResolvedSessionMaintenanceConfig;
  beforeCount: number;
  shouldRunEntryMaintenance: boolean;
}): Promise<void> {
  const activeSessionKey = params.operation.activeSessionKey?.trim();
  if (activeSessionKey && params.shouldRunEntryMaintenance) {
    const warning = getActiveSessionMaintenanceWarning({
      store: params.operation.store,
      activeSessionKey,
      pruneAfterMs: params.maintenance.pruneAfterMs,
      maxEntries: params.maintenance.maxEntries,
    });
    if (warning) {
      params.operation.log.warn(
        "session maintenance would evict active session; skipping enforcement",
        {
          activeSessionKey: warning.activeSessionKey,
          wouldPrune: warning.wouldPrune,
          wouldCap: warning.wouldCap,
          pruneAfterMs: warning.pruneAfterMs,
          maxEntries: warning.maxEntries,
        },
      );
      await params.operation.onWarn?.(warning);
    }
  }
  const diskBudget = await enforceSessionDiskBudget({
    store: params.operation.store,
    storePath: params.operation.storePath,
    activeSessionKey: params.operation.activeSessionKey,
    maintenance: params.maintenance,
    warnOnly: true,
    log: params.operation.log,
  });
  await params.operation.onMaintenanceApplied?.({
    mode: params.maintenance.mode,
    beforeCount: params.beforeCount,
    afterCount: Object.keys(params.operation.store).length,
    modelRunPruned: 0,
    pruned: 0,
    capped: 0,
    diskBudget,
  });
}

async function cleanupRemovedSessionArtifacts(params: {
  operation: FileBackedSessionStoreMaintenanceParams;
  maintenance: ResolvedSessionMaintenanceConfig;
  removedSessionFiles: RemovedSessionFiles;
  referencedSessionIds: ReadonlySet<string>;
}): Promise<void> {
  // SQLite should commit entry-retention rows before this named artifact cleanup.
  // The cleanup needs the final referenced-session set so shared transcripts and
  // trajectory sidecars survive until the last referring row is gone.
  const archivedDirs = await params.operation.artifacts.archiveRemovedSessionTranscripts({
    removedSessionFiles: params.removedSessionFiles,
    referencedSessionIds: params.referencedSessionIds,
    storePath: params.operation.storePath,
    reason: "deleted",
    restrictToStoreDir: true,
  });
  if (params.removedSessionFiles.size > 0) {
    await params.operation.artifacts.removeRemovedSessionTrajectoryArtifacts({
      removedSessionFiles: params.removedSessionFiles,
      referencedSessionIds: params.referencedSessionIds,
      storePath: params.operation.storePath,
      restrictToStoreDir: true,
    });
  }
  // null retention keeps archived transcripts: they are conversation history,
  // and the disk budget (not a wall-clock timer) is the only eviction path.
  if (params.maintenance.resetArchiveRetentionMs == null) {
    return;
  }
  const targetDirs =
    archivedDirs.size > 0
      ? [...archivedDirs]
      : [path.dirname(path.resolve(params.operation.storePath))];
  // Both retention reasons ride one cleanup call so each save enumerates the
  // sessions dir at most once; a listing per reason would scan twice per save.
  await params.operation.artifacts.cleanupArchivedSessionTranscripts({
    directories: targetDirs,
    rules: [
      { reason: "deleted", olderThanMs: params.maintenance.resetArchiveRetentionMs },
      { reason: "reset", olderThanMs: params.maintenance.resetArchiveRetentionMs },
    ],
  });
}

async function applyEnforcedMaintenance(params: {
  operation: FileBackedSessionStoreMaintenanceParams;
  maintenance: ResolvedSessionMaintenanceConfig;
  beforeCount: number;
  forceMaintenance: boolean;
}): Promise<FileBackedSessionStoreMaintenanceResult> {
  const preserveSessionKeys = collectSessionMaintenancePreserveKeysForStore({
    storePath: params.operation.storePath,
    store: params.operation.store,
    baseKeys: [params.operation.activeSessionKey],
  });
  const removedSessionFiles = new Map<string, string | undefined>();
  const modelRunPruned = shouldRunModelRunPrune({
    maintenance: params.maintenance,
    entryCount: params.beforeCount,
    force: params.forceMaintenance,
  })
    ? pruneStaleModelRunEntries(params.operation.store, params.maintenance.modelRunPruneAfterMs, {
        onPruned: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
        preserveKeys: preserveSessionKeys,
      })
    : 0;
  const pruned = pruneStaleEntries(params.operation.store, params.maintenance.pruneAfterMs, {
    onPruned: ({ entry }) => {
      rememberRemovedSessionFile(removedSessionFiles, entry);
    },
    preserveKeys: preserveSessionKeys,
  });
  const countAfterPrune = Object.keys(params.operation.store).length;
  const shouldRunCapMaintenance =
    params.forceMaintenance ||
    shouldRunSessionEntryMaintenance({
      entryCount: countAfterPrune,
      maxEntries: params.maintenance.maxEntries,
    });
  const capped = shouldRunCapMaintenance
    ? capEntryCount(params.operation.store, params.maintenance.maxEntries, {
        onCapped: ({ entry }) => {
          rememberRemovedSessionFile(removedSessionFiles, entry);
        },
        preserveKeys: preserveSessionKeys,
      })
    : 0;
  const referencedSessionIds = collectReferencedSessionIds(params.operation.store);
  await cleanupRemovedSessionArtifacts({
    operation: params.operation,
    maintenance: params.maintenance,
    removedSessionFiles,
    referencedSessionIds,
  });

  // Disk-budget eviction is its own transaction-sized boundary: it may delete
  // additional rows plus owned artifacts after prune/cap has settled, while
  // preserving the active session and protected runtime-provided keys.
  const diskBudget = await enforceSessionDiskBudget({
    store: params.operation.store,
    storePath: params.operation.storePath,
    activeSessionKey: params.operation.activeSessionKey,
    preserveKeys: preserveSessionKeys,
    maintenance: params.maintenance,
    warnOnly: false,
    log: params.operation.log,
  });
  await params.operation.onMaintenanceApplied?.({
    mode: params.maintenance.mode,
    beforeCount: params.beforeCount,
    afterCount: Object.keys(params.operation.store).length,
    modelRunPruned,
    pruned,
    capped,
    diskBudget,
  });
  return {
    changedStore:
      modelRunPruned > 0 || pruned > 0 || capped > 0 || (diskBudget?.removedEntries ?? 0) > 0,
  };
}

/**
 * Applies automatic session-store maintenance to the in-memory file-store image.
 *
 * Future SQLite adapters should map this into named boundaries: entry retention,
 * removed-session artifact cleanup, disk-budget eviction, and archive retention cleanup.
 */
export async function applyFileBackedSessionStoreMaintenance(
  params: FileBackedSessionStoreMaintenanceParams,
): Promise<FileBackedSessionStoreMaintenanceResult> {
  const maintenance = resolveMaintenanceForOperation(params);
  const beforeCount = Object.keys(params.store).length;
  const forceMaintenance = params.maintenanceOverride !== undefined;
  const shouldRunEntryMaintenance = shouldRunSessionEntryMaintenance({
    entryCount: beforeCount,
    maxEntries: maintenance.maxEntries,
    force: forceMaintenance,
  });

  if (maintenance.mode === "warn") {
    await applyWarnOnlyMaintenance({
      operation: params,
      maintenance,
      beforeCount,
      shouldRunEntryMaintenance,
    });
    return { changedStore: false };
  }

  return await applyEnforcedMaintenance({
    operation: params,
    maintenance,
    beforeCount,
    forceMaintenance,
  });
}
