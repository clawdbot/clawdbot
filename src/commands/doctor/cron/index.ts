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

/** Inspect cron storage and optionally repair legacy JSON/SQLite/payload shapes. */
export async function maybeRepairLegacyCronStore(params: {
  cfg: OpenClawConfig;
  options: DoctorOptions;
  prompter: Pick<DoctorPrompter, "confirm">;
}) {
  const storePath = resolveCronJobsStorePath(params.cfg.cron?.store);
  const quarantinePath = resolveCronQuarantinePath(storePath);
  let store: Awaited<ReturnType<typeof loadCronJobsStoreWithConfigJobs>>["store"];
  let legacyStoreDetected;
  let legacyRunLogDetected;
  let legacyImportCount = 0;
  let sqliteProjectionBackfillCount;
  try {
    legacyStoreDetected = await legacyCronStoreFilesExist(storePath);
    legacyRunLogDetected = await legacyCronRunLogFilesExist(storePath);
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
    sqliteProjectionBackfillCount =
      loaded.configJobs.length > 0
        ? currentJobs.filter((job, index) =>
            needsSqliteProjectionBackfill({
              configJob: job,
              projectedJob: loaded.store.jobs[index],
            }),
          ).length
        : 0;
    store = { version: 1, jobs: currentJobs as unknown as CronJob[] };
    if (legacyStoreDetected) {
      const legacyStore = (await loadLegacyCronStoreForMigration(storePath)).store;
      const merged = mergeLegacyCronJobs({
        currentJobs: store.jobs as unknown as Array<Record<string, unknown>>,
        legacyJobs: legacyStore.jobs as unknown as Array<Record<string, unknown>>,
      });
      legacyImportCount = merged.importedCount;
      store = { version: 1, jobs: merged.jobs as unknown as CronJob[] };
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
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
  const rawJobs = (store.jobs ?? []) as unknown as Array<Record<string, unknown>>;
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
    if (legacyStoreDetected) {
      await saveCronJobsStore(storePath, { version: 1, jobs: [] });
      await archiveLegacyCronStoreForMigration(storePath);
    }
    const runLogMigration = legacyRunLogDetected
      ? await migrateLegacyCronRunLogsToSqlite(storePath)
      : { importedFiles: 0 };
    if (legacyStoreDetected) {
      note(
        `Cron store migrated to SQLite at ${shortenHomePath(storePath)}.${formatRunLogMigrationNote(runLogMigration.importedFiles)}`,
        "Doctor changes",
      );
    } else {
      note(
        `Cron run logs migrated to SQLite at ${shortenHomePath(storePath)}.${formatRunLogMigrationNote(runLogMigration.importedFiles)}`,
        "Doctor changes",
      );
    }
    return;
  }
  noteCronModelOverrides({ cfg: params.cfg, jobs: rawJobs, storePath });

  const normalized = normalizeStoredCronJobs(rawJobs);
  const legacyWebhook = normalizeOptionalString(params.cfg.cron?.webhook);
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

  const notifyMigration = migrateLegacyNotifyFallback({
    jobs: rawJobs,
    legacyWebhook,
  });
  const dreamingMigration = migrateLegacyDreamingPayloadShape(rawJobs);
  const changed =
    legacyStoreDetected ||
    legacyRunLogDetected ||
    sqliteProjectionBackfillCount > 0 ||
    normalized.mutated ||
    notifyMigration.changed ||
    dreamingMigration.changed;
  if (!changed && notifyMigration.warnings.length === 0) {
    return;
  }

  if (changed) {
    if (normalized.removedJobs.length > 0) {
      await saveCronQuarantineFile({
        storePath,
        nowMs: Date.now(),
        entries: normalized.removedJobs.map((entry) => ({
          sourceIndex: entry.sourceIndex,
          reason: entry.reason,
          job: entry.job,
        })),
      });
    }
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: rawJobs as unknown as CronJob[],
    });
    const runLogMigration = legacyRunLogDetected
      ? await migrateLegacyCronRunLogsToSqlite(storePath)
      : { importedFiles: 0 };
    if (legacyStoreDetected) {
      await archiveLegacyCronStoreForMigration(storePath);
      note(
        `Cron store migrated to SQLite at ${shortenHomePath(storePath)}.${formatRunLogMigrationNote(runLogMigration.importedFiles)}`,
        "Doctor changes",
      );
    } else if (legacyRunLogDetected) {
      note(
        `Cron run logs migrated to SQLite at ${shortenHomePath(storePath)}.${formatRunLogMigrationNote(runLogMigration.importedFiles)}`,
        "Doctor changes",
      );
    } else {
      note(`Cron store normalized at ${shortenHomePath(storePath)}.`, "Doctor changes");
    }
    if (dreamingMigration.rewrittenCount > 0) {
      note(
        `Rewrote ${pluralize(dreamingMigration.rewrittenCount, "managed dreaming job")} to run as an isolated agent turn so dreaming no longer requires heartbeat.`,
        "Doctor changes",
      );
    }
  }

  if (notifyMigration.warnings.length > 0) {
    note(notifyMigration.warnings.join("\n"), "Doctor warnings");
  }
}
