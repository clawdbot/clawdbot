// Doctor cron repair orchestration for legacy stores, run logs, payloads, and warnings.
import { normalizeOptionalString } from "../../../../packages/normalization-core/src/string-coerce.js";
import { note } from "../../../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadCronQuarantineFile,
  loadCronJobsStoreWithConfigJobs,
  resolveCronQuarantinePath,
  resolveCronJobsStorePath,
  saveCronQuarantineFile,
  saveCronJobsStore,
} from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { shortenHomePath } from "../../../utils.js";
import type { DoctorPrompter, DoctorOptions } from "../../doctor-prompter.js";
import {
  countStaleDreamingJobs,
  migrateLegacyDreamingPayloadShape,
} from "./dreaming-payload-migration.js";
import { migrateLegacyNotifyFallback } from "./legacy-notify.js";
import {
  legacyCronRunLogFilesExist,
  migrateLegacyCronRunLogsToSqlite,
} from "./legacy-run-log-migration.js";
import {
  archiveLegacyCronStoreForMigration,
  legacyCronStoreFilesExist,
  loadLegacyCronStoreForMigration,
} from "./legacy-store-migration.js";
import {
  formatLegacyIssuePreview,
  mergeLegacyCronJobs,
  mergeRuntimeEntryIntoConfigJob,
  needsSqliteProjectionBackfill,
} from "./repair-plan.js";
import { normalizeStoredCronJobs } from "./store-migration.js";
import { noteCronModelOverrides } from "./warnings.js";

export {
  collectLegacyWhatsAppCrontabHealthWarning,
  noteLegacyWhatsAppCrontabHealthCheck,
} from "./warnings.js";

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

type LegacyCronRepairState = {
  storePath: string;
  quarantinePath: string;
  legacyStoreDetected: boolean;
  legacyRunLogDetected: boolean;
  legacyImportCount: number;
  sqliteProjectionBackfillCount: number;
  rawJobs: Array<Record<string, unknown>>;
};

export type LegacyCronRepairResult = {
  changes: string[];
  warnings: string[];
};

async function loadLegacyCronRepairState(params: {
  cfg: OpenClawConfig;
  onlyIfLegacyDetected?: boolean;
}): Promise<LegacyCronRepairState | null> {
  const storePath = resolveCronJobsStorePath(params.cfg.cron?.store);
  const quarantinePath = resolveCronQuarantinePath(storePath);
  const legacyStoreDetected = await legacyCronStoreFilesExist(storePath);
  const legacyRunLogDetected = await legacyCronRunLogFilesExist(storePath);
  if (params.onlyIfLegacyDetected && !legacyStoreDetected && !legacyRunLogDetected) {
    return null;
  }

  const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
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
  if (legacyStoreDetected) {
    const legacyStore = (await loadLegacyCronStoreForMigration(storePath)).store;
    const merged = mergeLegacyCronJobs({
      currentJobs: rawJobs,
      legacyJobs: legacyStore.jobs as unknown as Array<Record<string, unknown>>,
    });
    rawJobs = merged.jobs;
    legacyImportCount = merged.importedCount;
  }

  return {
    storePath,
    quarantinePath,
    legacyStoreDetected,
    legacyRunLogDetected,
    legacyImportCount,
    sqliteProjectionBackfillCount,
    rawJobs,
  };
}

async function applyLegacyCronStoreRepair(params: {
  cfg: OpenClawConfig;
  state: LegacyCronRepairState;
  normalized?: ReturnType<typeof normalizeStoredCronJobs>;
}): Promise<LegacyCronRepairResult> {
  const { state } = params;
  const changes: string[] = [];
  const warnings: string[] = [];
  const normalized = params.normalized ?? normalizeStoredCronJobs(state.rawJobs);
  const legacyWebhook = normalizeOptionalString(params.cfg.cron?.webhook);
  const notifyMigration = migrateLegacyNotifyFallback({
    jobs: state.rawJobs,
    legacyWebhook,
  });
  const dreamingMigration = migrateLegacyDreamingPayloadShape(state.rawJobs);
  warnings.push(...notifyMigration.warnings);

  const changed =
    state.legacyStoreDetected ||
    state.legacyRunLogDetected ||
    state.sqliteProjectionBackfillCount > 0 ||
    normalized.mutated ||
    notifyMigration.changed ||
    dreamingMigration.changed;
  if (!changed && warnings.length === 0) {
    return { changes, warnings };
  }

  if (changed) {
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
      await saveCronJobsStore(state.storePath, {
        version: 1,
        jobs: state.rawJobs as unknown as CronJob[],
      });
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
    await archiveLegacyCronStoreForMigration(state.storePath);
    changes.push(
      `Cron store migrated to SQLite at ${shortenHomePath(state.storePath)}.${formatRunLogMigrationNote(importedRunLogs)}`,
    );
  } else if (state.legacyRunLogDetected && importedRunLogs > 0) {
    changes.push(
      `Cron run logs migrated to SQLite at ${shortenHomePath(state.storePath)}.${formatRunLogMigrationNote(importedRunLogs)}`,
    );
  } else if (changed) {
    changes.push(`Cron store normalized at ${shortenHomePath(state.storePath)}.`);
  }
  if (dreamingMigration.rewrittenCount > 0) {
    changes.push(
      `Rewrote ${pluralize(dreamingMigration.rewrittenCount, "managed dreaming job")} to run as an isolated agent turn so dreaming no longer requires heartbeat.`,
    );
  }

  return { changes, warnings };
}

export async function repairLegacyCronStoreWithoutPrompt(params: {
  cfg: OpenClawConfig;
}): Promise<LegacyCronRepairResult> {
  const storePath = resolveCronJobsStorePath(params.cfg.cron?.store);
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
  return await applyLegacyCronStoreRepair({ cfg: params.cfg, state });
}

function noteLegacyCronRepairResult(result: LegacyCronRepairResult): void {
  if (result.changes.length > 0) {
    note(result.changes.join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.join("\n"), "Doctor warnings");
  }
}

/** Inspect cron storage and optionally repair legacy JSON/SQLite/payload shapes. */
export async function maybeRepairLegacyCronStore(params: {
  cfg: OpenClawConfig;
  options: DoctorOptions;
  prompter: Pick<DoctorPrompter, "confirm">;
}) {
  let state: LegacyCronRepairState | null;
  try {
    state = await loadLegacyCronRepairState({ cfg: params.cfg });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const storePath = resolveCronJobsStorePath(params.cfg.cron?.store);
    note(
      [
        `Unable to read cron job store at ${shortenHomePath(storePath)}.`,
        `- ${reason}`,
        `Fix the file's permissions or contents and re-run ${formatCliCommand("openclaw doctor")}; later health checks will continue.`,
      ].join("\n"),
      "Cron",
    );
    return;
  }
  if (!state) {
    return;
  }
  const {
    storePath,
    quarantinePath,
    legacyStoreDetected,
    legacyRunLogDetected,
    legacyImportCount,
    sqliteProjectionBackfillCount,
    rawJobs,
  } = state;
  try {
    const quarantine = await loadCronQuarantineFile(quarantinePath);
    if (quarantine.jobs.length > 0) {
      note(
        [
          `Quarantined cron job rows found at ${shortenHomePath(quarantinePath)}.`,
          `- ${pluralize(quarantine.jobs.length, "row")} was removed from the active cron store after runtime validation failed.`,
          `- Review or repair the quarantined rows manually before copying any job back into ${shortenHomePath(storePath)}.`,
        ].join("\n"),
        "Cron",
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    note(
      [
        `Unable to read quarantined cron rows at ${shortenHomePath(quarantinePath)}.`,
        `- ${reason}`,
      ].join("\n"),
      "Cron",
    );
  }
  if (rawJobs.length === 0) {
    if (!legacyStoreDetected && !legacyRunLogDetected) {
      return;
    }
    const previewLines: string[] = [];
    if (legacyStoreDetected) {
      previewLines.push("- legacy JSON cron store will be archived after SQLite migration");
    }
    if (legacyRunLogDetected) {
      previewLines.push("- legacy JSON cron run logs will be imported into SQLite");
    }
    note(
      [
        `Legacy cron storage detected at ${shortenHomePath(storePath)}.`,
        ...previewLines,
        `Repair with ${formatCliCommand("openclaw doctor --fix")} to finish the migration.`,
      ].join("\n"),
      "Cron",
    );
    const shouldRepair = await params.prompter.confirm({
      message: "Repair legacy cron jobs now?",
      initialValue: true,
    });
    if (!shouldRepair) {
      return;
    }
    noteLegacyCronRepairResult(await applyLegacyCronStoreRepair({ cfg: params.cfg, state }));
    return;
  }
  noteCronModelOverrides({ cfg: params.cfg, jobs: rawJobs, storePath });

  const normalized = normalizeStoredCronJobs(rawJobs);
  const notifyCount = rawJobs.filter((job) => job.notify === true).length;
  const dreamingStaleCount = countStaleDreamingJobs(rawJobs);
  const previewLines = formatLegacyIssuePreview(normalized.issues);
  if (legacyStoreDetected) {
    previewLines.unshift(
      legacyImportCount > 0
        ? `- ${pluralize(legacyImportCount, "legacy JSON cron job")} will be imported into SQLite`
        : "- legacy JSON cron store will be archived after SQLite migration",
    );
  }
  if (legacyRunLogDetected) {
    previewLines.push("- legacy JSON cron run logs will be imported into SQLite");
  }
  if (sqliteProjectionBackfillCount > 0) {
    previewLines.push(
      `- ${pluralize(sqliteProjectionBackfillCount, "SQLite cron row")} will be backfilled from stored config JSON into split columns`,
    );
  }
  if (notifyCount > 0) {
    previewLines.push(
      `- ${pluralize(notifyCount, "job")} still uses legacy \`notify: true\` webhook fallback`,
    );
  }
  if (dreamingStaleCount > 0) {
    previewLines.push(
      `- ${pluralize(dreamingStaleCount, "managed dreaming job")} still has the legacy heartbeat-coupled shape`,
    );
  }
  if (previewLines.length === 0 && !legacyStoreDetected) {
    return;
  }

  note(
    [
      `Legacy cron job storage detected at ${shortenHomePath(storePath)}.`,
      ...previewLines,
      `Repair with ${formatCliCommand("openclaw doctor --fix")} to normalize the store before the next scheduler run.`,
    ].join("\n"),
    "Cron",
  );

  const shouldRepair = await params.prompter.confirm({
    message: "Repair legacy cron jobs now?",
    initialValue: true,
  });
  if (!shouldRepair) {
    return;
  }

  noteLegacyCronRepairResult(
    await applyLegacyCronStoreRepair({ cfg: params.cfg, state, normalized }),
  );
}
