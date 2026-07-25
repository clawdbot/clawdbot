// Doctor cron storage repair mechanics for legacy stores, run logs, payloads, and Codex refs.
import { normalizeOptionalString } from "../../../../packages/normalization-core/src/string-coerce.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronQuarantinePath,
  resolveCronJobsStorePath,
  saveCronJobsStore,
  saveCronJobsStoreWithMetadata,
  saveCronQuarantineFile,
} from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { shortenHomePath } from "../../../utils.js";
import type { LegacyCodexModelIdentity } from "../shared/codex-route-model-ref.js";
import { migrateLegacyDreamingPayloadShape } from "./dreaming-payload-migration.js";
import { migrateLegacyNotifyFallback } from "./legacy-notify.js";
import {
  legacyCronRunLogFilesExist,
  migrateLegacyCronRunLogsToSqlite,
} from "./legacy-run-log-migration.js";
import {
  archiveLegacyCronStoreForMigration,
  assertLegacyCronMigrationSourceCurrent,
  legacyCronStoreFilesExist,
  loadLegacyCronStoreForMigration,
  type LegacyCronMigrationSource,
} from "./legacy-store-migration.js";
import {
  acquireLegacyCronMigrationReceipt,
  hasLegacyCronMigrationReceipt,
  hasLegacyCronMigrationReceiptReadOnly,
  markLegacyCronMigrationSourceRemoved,
} from "./migration-ledger.js";
import {
  mergeLegacyCronJobs,
  mergeRuntimeEntryIntoConfigJob,
  needsSqliteProjectionBackfill,
} from "./repair-plan.js";
import { planCronCodexRefRewriteAgainstPersistedConfig } from "./runtime-policy-migration.js";
import {
  collectStoredCronCodexRuntimePolicyTargets,
  cronCodexRuntimePolicyTargetKey,
  normalizeStoredCronJobs,
  type CronCodexRuntimePolicyTarget,
} from "./store-migration.js";

export type LegacyCronRepairState = {
  storePath: string;
  quarantinePath: string;
  legacyStoreDetected: boolean;
  legacyRunLogDetected: boolean;
  legacyMigrationSource?: LegacyCronMigrationSource;
  legacyMigrationAlreadyImported: boolean;
  legacyImportCount: number;
  sqliteProjectionBackfillCount: number;
  rawJobs: Array<Record<string, unknown>>;
};

export type LegacyCronRepairResult = {
  changes: string[];
  warnings: string[];
  codexRuntimePolicyTargets?: CronCodexRuntimePolicyTarget[];
};

function pluralize(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatRunLogMigrationNote(importedFiles: number): string {
  return importedFiles > 0
    ? ` Imported ${pluralize(importedFiles, "legacy cron run log")} into SQLite.`
    : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readLegacyCronStorePath(cfg: OpenClawConfig): string | undefined {
  return (cfg.cron as (NonNullable<OpenClawConfig["cron"]> & { store?: string }) | undefined)
    ?.store;
}

export async function loadLegacyCronRepairState(params: {
  cfg: OpenClawConfig;
  onlyIfLegacyDetected?: boolean;
  readOnly?: boolean;
}): Promise<LegacyCronRepairState | null> {
  const storePath = resolveCronJobsStorePath(readLegacyCronStorePath(params.cfg));
  const quarantinePath = resolveCronQuarantinePath(storePath);
  const legacyStoreDetected = await legacyCronStoreFilesExist(storePath);
  const legacyRunLogDetected = await legacyCronRunLogFilesExist(storePath);
  if (params.onlyIfLegacyDetected && !legacyStoreDetected && !legacyRunLogDetected) {
    return null;
  }

  const loaded = params.readOnly
    ? await loadCronJobsStoreWithConfigJobsReadOnly(storePath)
    : await loadCronJobsStoreWithConfigJobs(storePath);
  const currentJobs =
    loaded.configJobs.length > 0
      ? loaded.configJobs.map((job, index) =>
          mergeRuntimeEntryIntoConfigJob({
            job,
            runtimeEntry: loaded.configJobRuntimeEntries[index],
          }),
        )
      : (loaded.store.jobs as unknown as Array<Record<string, unknown>>);
  const sqliteProjectionBackfillCount =
    loaded.configJobs.length > 0
      ? currentJobs.filter((job, index) =>
          needsSqliteProjectionBackfill({
            configJob: job,
            projectedJob: loaded.store.jobs[index],
          }),
        ).length
      : 0;
  let rawJobs = currentJobs;
  let legacyImportCount = 0;
  let legacyMigrationSource: LegacyCronMigrationSource | undefined;
  let legacyMigrationAlreadyImported = false;
  if (legacyStoreDetected) {
    const loadedLegacy = await loadLegacyCronStoreForMigration(storePath);
    legacyMigrationSource = loadedLegacy.migrationSource;
    legacyMigrationAlreadyImported = legacyMigrationSource
      ? params.readOnly
        ? hasLegacyCronMigrationReceiptReadOnly(legacyMigrationSource)
        : hasLegacyCronMigrationReceipt(legacyMigrationSource)
      : false;
    if (!legacyMigrationAlreadyImported) {
      const merged = mergeLegacyCronJobs({
        currentJobs: rawJobs,
        legacyJobs: loadedLegacy.store.jobs as unknown as Array<Record<string, unknown>>,
      });
      rawJobs = merged.jobs;
      legacyImportCount = merged.importedCount;
    }
  }

  return {
    storePath,
    quarantinePath,
    legacyStoreDetected,
    legacyRunLogDetected,
    legacyMigrationSource,
    legacyMigrationAlreadyImported,
    legacyImportCount,
    sqliteProjectionBackfillCount,
    rawJobs,
  };
}

export async function applyLegacyCronStoreRepair(params: {
  cfg: OpenClawConfig;
  state: LegacyCronRepairState;
  normalized?: ReturnType<typeof normalizeStoredCronJobs>;
  migrateCodexModelRefs?: boolean;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): Promise<LegacyCronRepairResult> {
  const { state } = params;
  const changes: string[] = [];
  const warnings: string[] = [];
  const runtimePolicyPlan =
    params.migrateCodexModelRefs === true
      ? planCronCodexRefRewriteAgainstPersistedConfig({
          cfg: params.cfg,
          targets: collectStoredCronCodexRuntimePolicyTargets(state.rawJobs),
          blockedModelIdentities: params.blockedModelIdentities,
        })
      : undefined;
  warnings.push(...(runtimePolicyPlan?.warnings ?? []));
  const blockedRuntimePolicyTargets = new Set(
    (runtimePolicyPlan?.blockedTargets ?? []).map(cronCodexRuntimePolicyTargetKey),
  );
  const normalized =
    params.normalized ??
    normalizeStoredCronJobs(state.rawJobs, {
      migrateCodexModelRefs: params.migrateCodexModelRefs,
      shouldMigrateCodexRuntimePolicyTarget: (target) =>
        !blockedRuntimePolicyTargets.has(cronCodexRuntimePolicyTargetKey(target)),
    });
  const legacyWebhook = normalizeOptionalString(
    (params.cfg.cron as Record<string, unknown> | undefined)?.webhook,
  );
  const notifyMigration = migrateLegacyNotifyFallback({
    jobs: state.rawJobs,
    legacyWebhook,
  });
  const dreamingMigration = migrateLegacyDreamingPayloadShape(state.rawJobs);
  warnings.push(...notifyMigration.warnings);

  const storeChanged =
    (state.legacyStoreDetected && !state.legacyMigrationAlreadyImported) ||
    state.sqliteProjectionBackfillCount > 0 ||
    normalized.mutated ||
    notifyMigration.changed ||
    dreamingMigration.changed;
  const changed = state.legacyStoreDetected || state.legacyRunLogDetected || storeChanged;
  if (!changed && warnings.length === 0) {
    return { changes, warnings };
  }

  if (storeChanged) {
    try {
      if (normalized.removedJobs.length > 0) {
        await saveCronQuarantineFile({
          storePath: state.storePath,
          nowMs: Date.now(),
          entries: normalized.removedJobs.map((entry) => ({
            sourceIndex: entry.sourceIndex,
            reason: entry.reason,
            job: entry.job,
          })),
        });
      }
      const store = {
        version: 1,
        jobs: state.rawJobs as unknown as CronJob[],
      } as const;
      const migrationSource = state.legacyMigrationSource;
      if (migrationSource && !state.legacyMigrationAlreadyImported) {
        await assertLegacyCronMigrationSourceCurrent(migrationSource);
        await saveCronJobsStoreWithMetadata(state.storePath, store, (db) => {
          return acquireLegacyCronMigrationReceipt(db, migrationSource);
        });
      } else {
        await saveCronJobsStore(state.storePath, store);
      }
    } catch (err) {
      return {
        changes,
        warnings: [
          ...warnings,
          `Failed writing migrated cron store at ${shortenHomePath(state.storePath)}: ${errorMessage(err)}`,
        ],
      };
    }
  }

  let importedRunLogs = 0;
  if (state.legacyRunLogDetected) {
    try {
      importedRunLogs = (await migrateLegacyCronRunLogsToSqlite(state.storePath)).importedFiles;
    } catch (err) {
      warnings.push(
        `Failed importing legacy cron run logs at ${shortenHomePath(state.storePath)}: ${errorMessage(err)}`,
      );
    }
  }

  if (state.legacyStoreDetected) {
    const archiveResult = await archiveLegacyCronStoreForMigration(
      state.storePath,
      state.legacyMigrationSource,
    );
    if (archiveResult.ok) {
      if (state.legacyMigrationSource) {
        try {
          markLegacyCronMigrationSourceRemoved(state.legacyMigrationSource);
        } catch (err) {
          warnings.push(
            `Cron store was archived, but its migration receipt could not be finalized: ${errorMessage(err)}`,
          );
        }
      }
      changes.push(
        `Cron store migrated to SQLite at ${shortenHomePath(state.storePath)}.${formatRunLogMigrationNote(importedRunLogs)}`,
      );
    } else {
      // SQLite already holds the migrated jobs, but the legacy file could not be
      // archived (e.g. EXDEV copy+unlink failed), so report it honestly instead of
      // claiming a finished migration; doctor re-detects the leftover and retries.
      for (const failure of archiveResult.failures) {
        warnings.push(
          `Migrated cron jobs to SQLite but could not archive the legacy cron file at ${shortenHomePath(failure.path)}: ${failure.reason}. Remove it manually or rerun ${formatCliCommand("openclaw doctor --fix")} to retry.`,
        );
      }
    }
  } else if (state.legacyRunLogDetected && importedRunLogs > 0) {
    changes.push(
      `Cron run logs migrated to SQLite at ${shortenHomePath(state.storePath)}.${formatRunLogMigrationNote(importedRunLogs)}`,
    );
  } else if (storeChanged) {
    changes.push(`Cron store normalized at ${shortenHomePath(state.storePath)}.`);
  }
  if (dreamingMigration.rewrittenCount > 0) {
    changes.push(
      `Rewrote ${pluralize(dreamingMigration.rewrittenCount, "managed dreaming job")} to run as an isolated agent turn so dreaming no longer requires heartbeat.`,
    );
  }

  return {
    changes,
    warnings,
    codexRuntimePolicyTargets: normalized.codexRuntimePolicyTargets,
  };
}

export async function repairLegacyCronStoreWithoutPrompt(params: {
  cfg: OpenClawConfig;
  migrateCodexModelRefs?: boolean;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): Promise<LegacyCronRepairResult> {
  const storePath = resolveCronJobsStorePath(
    normalizeOptionalString(readLegacyCronStorePath(params.cfg)),
  );
  let state: LegacyCronRepairState | null;
  try {
    state = await loadLegacyCronRepairState({
      cfg: params.cfg,
      onlyIfLegacyDetected: true,
    });
  } catch (err) {
    return {
      changes: [],
      warnings: [
        `Failed reading legacy cron storage at ${shortenHomePath(storePath)}: ${errorMessage(err)}`,
      ],
    };
  }
  if (!state) {
    return { changes: [], warnings: [] };
  }
  return await applyLegacyCronStoreRepair({ ...params, state });
}

/** Read legacy Codex cron targets without changing either cron storage or config. */
export async function collectCronCodexRuntimePolicyTargetsReadOnly(params: {
  cfg: OpenClawConfig;
}): Promise<{ targets: CronCodexRuntimePolicyTarget[]; warnings: string[] }> {
  const storePath = resolveCronJobsStorePath(
    normalizeOptionalString(readLegacyCronStorePath(params.cfg)),
  );
  try {
    const state = await loadLegacyCronRepairState({ cfg: params.cfg, readOnly: true });
    return {
      targets: state ? collectStoredCronCodexRuntimePolicyTargets(state.rawJobs) : [],
      warnings: [],
    };
  } catch (err) {
    return {
      targets: [],
      warnings: [
        `Failed reading cron storage at ${shortenHomePath(storePath)} while planning Codex model migration: ${errorMessage(err)}`,
      ],
    };
  }
}

/** Commit Codex cron refs only after their model-scoped config policy is durable. */
export async function repairCronCodexModelRefsAfterConfigWrite(params: {
  cfg: OpenClawConfig;
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
}): Promise<LegacyCronRepairResult> {
  const storePath = resolveCronJobsStorePath(
    normalizeOptionalString(readLegacyCronStorePath(params.cfg)),
  );
  try {
    const state = await loadLegacyCronRepairState({ cfg: params.cfg });
    return state
      ? await applyLegacyCronStoreRepair({
          cfg: params.cfg,
          state,
          migrateCodexModelRefs: true,
          blockedModelIdentities: params.blockedModelIdentities,
        })
      : { changes: [], warnings: [] };
  } catch (err) {
    return {
      changes: [],
      warnings: [
        `Failed reading cron storage at ${shortenHomePath(storePath)} while committing Codex model migration: ${errorMessage(err)}`,
      ],
    };
  }
}
