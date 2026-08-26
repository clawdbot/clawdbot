// Doctor cron storage repair mechanics for legacy stores, run logs, payloads, and Codex refs.
import { normalizeOptionalString } from "../../../../packages/normalization-core/src/string-coerce.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../../agents/agent-scope-config.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getInvalidPersistedCronJobReason } from "../../../cron/persisted-shape.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronJobsStoreWithConfigJobsReadOnly,
  resolveCronJobsStorePath,
  saveCronJobsStore,
  saveCronJobsStoreWithMetadata,
  saveCronQuarantinedJobs,
  type CronQuarantinedJob,
  type QuarantinedCronConfigJob,
} from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { formatErrorMessage as errorMessage } from "../../../infra/errors.js";
import { parseAgentSessionKey } from "../../../routing/session-key.js";
import { shortenHomePath } from "../../../utils.js";
import type { LegacyCodexModelIdentity } from "../shared/codex-route-model-ref.js";
import { migrateLegacyDreamingPayloadShape } from "./dreaming-payload-migration.js";
import { migrateLegacyNotifyFallback } from "./legacy-notify.js";
import {
  archiveLegacyCronQuarantineForMigration,
  loadLegacyCronQuarantineForMigration,
  type LegacyCronQuarantine,
} from "./legacy-quarantine-migration.js";
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
  assertCronStateSchemaSupported,
  rethrowSqliteSchemaVersionError,
} from "./schema-safety.js";
import {
  collectStoredCronCodexRuntimePolicyTargets,
  cronCodexRuntimePolicyTargetKey,
  normalizeStoredCronJobs,
  type CronCodexRuntimePolicyTarget,
} from "./store-migration.js";

export type CronOwnerProjection =
  | { kind: "explicit"; agentId: string }
  | { kind: "runtime-default"; agentId: string }
  | { kind: "unresolved" };

export type LegacyCronRepairState = {
  storePath: string;
  legacyStoreDetected: boolean;
  legacyRunLogDetected: boolean;
  legacyQuarantine?: LegacyCronQuarantine;
  legacyMigrationSource?: LegacyCronMigrationSource;
  legacyMigrationAlreadyImported: boolean;
  legacyImportCount: number;
  sqliteProjectionBackfillCount: number;
  invalidConfigRows: QuarantinedCronConfigJob[];
  projectedOwnersByJobId: ReadonlyMap<string, CronOwnerProjection>;
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

function readLegacyCronStorePath(cfg: OpenClawConfig): string | undefined {
  return (cfg.cron as (NonNullable<OpenClawConfig["cron"]> & { store?: string }) | undefined)
    ?.store;
}

function projectCronOwner(
  job: { agentId?: unknown; sessionKey?: unknown },
  runtimeDefaultAgentId: string | undefined,
): CronOwnerProjection {
  const explicitAgentId =
    normalizeOptionalString(job.agentId) ??
    parseAgentSessionKey(normalizeOptionalString(job.sessionKey))?.agentId;
  if (explicitAgentId) {
    return { kind: "explicit", agentId: explicitAgentId };
  }
  return runtimeDefaultAgentId
    ? { kind: "runtime-default", agentId: runtimeDefaultAgentId }
    : { kind: "unresolved" };
}

export async function loadLegacyCronRepairState(params: {
  cfg: OpenClawConfig;
  storePath?: string;
  env?: NodeJS.ProcessEnv;
  onlyIfLegacyDetected?: boolean;
  readOnly?: boolean;
}): Promise<LegacyCronRepairState | null> {
  const storePath =
    params.storePath ?? resolveCronJobsStorePath(readLegacyCronStorePath(params.cfg), params.env);
  const legacyStoreDetected = await legacyCronStoreFilesExist(storePath);
  const legacyRunLogDetected = await legacyCronRunLogFilesExist(storePath);
  const legacyQuarantine = await loadLegacyCronQuarantineForMigration(storePath);
  assertCronStateSchemaSupported(params.env);
  if (
    params.onlyIfLegacyDetected &&
    !legacyStoreDetected &&
    !legacyRunLogDetected &&
    !legacyQuarantine
  ) {
    return null;
  }

  const loaded = params.readOnly
    ? await loadCronJobsStoreWithConfigJobsReadOnly(storePath, params.env)
    : await loadCronJobsStoreWithConfigJobs(storePath);
  const runtimeDefaultAgentId = tryResolveLegacyCompatibilityAgentId(params.cfg);
  const projectedOwnersByJobId = new Map(
    loaded.store.jobs.map((job) => [job.id, projectCronOwner(job, runtimeDefaultAgentId)]),
  );
  const currentEntries = loaded.configJobs.map((job, index) => ({
    sourceIndex: loaded.configJobIndexes[index] ?? index,
    job: mergeRuntimeEntryIntoConfigJob({
      job,
      runtimeEntry: loaded.configJobRuntimeEntries[index],
    }),
    projectedJob: loaded.store.jobs[index],
  }));
  const invalidConfigRows: QuarantinedCronConfigJob[] = [];
  for (const row of loaded.invalidConfigRows) {
    if (row.job && !getInvalidPersistedCronJobReason(row.job)) {
      // Early SQLite builds omitted projection columns but retained a complete
      // job_json definition; doctor must backfill that job instead of deleting it.
      currentEntries.push({
        sourceIndex: row.sourceIndex,
        job: mergeRuntimeEntryIntoConfigJob({
          job: row.job,
          runtimeEntry: { state: row.state, updatedAtMs: row.updatedAtMs },
        }),
        projectedJob: undefined,
      });
      continue;
    }
    invalidConfigRows.push(row);
  }
  currentEntries.sort((left, right) => left.sourceIndex - right.sourceIndex);
  const currentJobs =
    currentEntries.length > 0
      ? currentEntries.map((entry) => entry.job)
      : (loaded.store.jobs as unknown as Array<Record<string, unknown>>);
  const sqliteProjectionBackfillCount = currentEntries.filter((entry) =>
    needsSqliteProjectionBackfill({
      configJob: entry.job,
      projectedJob: entry.projectedJob,
    }),
  ).length;
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
      invalidConfigRows.push(...loadedLegacy.invalidConfigRows);
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
    legacyStoreDetected,
    legacyRunLogDetected,
    legacyQuarantine,
    legacyMigrationSource,
    legacyMigrationAlreadyImported,
    legacyImportCount,
    sqliteProjectionBackfillCount,
    invalidConfigRows,
    projectedOwnersByJobId,
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
  assertCronStateSchemaSupported();
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
  warnings.push(
    ...normalized.unsupportedLegacyTriggerScriptJobs.map(
      (job) =>
        `Cron trigger script for ${job} uses legacy Code Mode APIs that cannot be safely converted; inspect the automation and update its trigger script manually to use direct tool calls.`,
    ),
  );
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
    state.invalidConfigRows.length > 0 ||
    normalized.mutated ||
    notifyMigration.changed ||
    dreamingMigration.changed;
  const changed =
    state.legacyStoreDetected ||
    state.legacyRunLogDetected ||
    state.legacyQuarantine !== undefined ||
    storeChanged;
  if (!changed && warnings.length === 0) {
    return { changes, warnings };
  }

  const quarantineEntries: (QuarantinedCronConfigJob | CronQuarantinedJob)[] = [
    ...(state.legacyQuarantine?.jobs ?? []),
    ...state.invalidConfigRows,
    ...normalized.removedJobs.map((entry) => ({
      sourceIndex: entry.sourceIndex,
      reason: entry.reason,
      job: entry.job,
    })),
  ];
  const quarantine =
    quarantineEntries.length > 0 ? { entries: quarantineEntries, nowMs: Date.now() } : undefined;

  if (storeChanged || quarantine) {
    try {
      if (storeChanged) {
        const store = {
          version: 1,
          jobs: state.rawJobs as unknown as CronJob[],
        } as const;
        const migrationSource = state.legacyMigrationSource;
        if (migrationSource && !state.legacyMigrationAlreadyImported) {
          await assertLegacyCronMigrationSourceCurrent(migrationSource);
          await saveCronJobsStoreWithMetadata(
            state.storePath,
            store,
            (db) => acquireLegacyCronMigrationReceipt(db, migrationSource),
            quarantine,
          );
        } else {
          await saveCronJobsStore(state.storePath, store, quarantine ? { quarantine } : undefined);
        }
      } else if (quarantine) {
        saveCronQuarantinedJobs({ storePath: state.storePath, ...quarantine });
      }
    } catch (err) {
      rethrowSqliteSchemaVersionError(err);
      return {
        changes,
        warnings: [
          ...warnings,
          `Failed writing migrated cron store at ${shortenHomePath(state.storePath)}: ${errorMessage(err)}`,
        ],
      };
    }
  }

  if (state.legacyQuarantine) {
    const archiveResult = await archiveLegacyCronQuarantineForMigration(state.legacyQuarantine);
    if (archiveResult.ok) {
      changes.push(
        `Cron quarantine migrated to SQLite from ${shortenHomePath(state.legacyQuarantine.path)}.`,
      );
    } else {
      warnings.push(
        `Migrated quarantined automations to SQLite but could not archive the legacy cron file at ${shortenHomePath(state.legacyQuarantine.path)}: ${archiveResult.reason}. Remove it manually or rerun ${formatCliCommand("openclaw doctor --fix")} to retry.`,
      );
    }
  }

  let importedRunLogs = 0;
  if (state.legacyRunLogDetected) {
    try {
      importedRunLogs = (await migrateLegacyCronRunLogsToSqlite(state.storePath)).importedFiles;
    } catch (err) {
      rethrowSqliteSchemaVersionError(err);
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
          rethrowSqliteSchemaVersionError(err);
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
          `Migrated automations to SQLite but could not archive the legacy cron file at ${shortenHomePath(failure.path)}: ${failure.reason}. Remove it manually or rerun ${formatCliCommand("openclaw doctor --fix")} to retry.`,
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
  if (normalized.legacyTriggerScriptJobs.length > 0) {
    changes.push(
      `Rewrote ${pluralize(normalized.legacyTriggerScriptJobs.length, "legacy cron trigger script")} to canonical direct tool calls: ${normalized.legacyTriggerScriptJobs.join(", ")}.`,
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
    rethrowSqliteSchemaVersionError(err);
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
    rethrowSqliteSchemaVersionError(err);
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
    rethrowSqliteSchemaVersionError(err);
    return {
      changes: [],
      warnings: [
        `Failed reading cron storage at ${shortenHomePath(storePath)} while committing Codex model migration: ${errorMessage(err)}`,
      ],
    };
  }
}
