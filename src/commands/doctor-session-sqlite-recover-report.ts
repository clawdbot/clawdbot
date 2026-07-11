/** Builds doctor reports for session SQLite migration recovery mode. */
import fs from "node:fs";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import {
  createSessionSqliteMigrationFailureIssue,
  findLatestFailedSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
  restoreSessionSqliteMigrationRun,
  sessionSqliteMigrationTargetKey,
  writeSessionSqliteMigrationFailureReports,
} from "./doctor-session-sqlite-migration-run.js";
import { readOnlySqliteDbStats, resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import type {
  DoctorSessionSqliteOptions,
  DoctorSessionSqliteReport,
  DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";

export type SessionSqliteRecoverTargetValidator = (
  target: SessionStoreTarget,
) => Promise<DoctorSessionSqliteTargetReport>;

/** Restores the latest failed migration run and validates only selected manifest targets. */
export async function recoverDoctorSessionSqliteTargets(params: {
  env: NodeJS.ProcessEnv;
  options: DoctorSessionSqliteOptions;
  targets: readonly SessionStoreTarget[];
  validateTarget: SessionSqliteRecoverTargetValidator;
}): Promise<DoctorSessionSqliteReport> {
  const selectedTargetKeys = resolveRecoverTargetKeys(params.options, params.targets);
  const failedRun = findLatestFailedSessionSqliteMigrationManifest(params.env, selectedTargetKeys);
  if (!failedRun) {
    const recoveredCorruptTargets = recoverCorruptSqliteTargets(params.targets);
    if (recoveredCorruptTargets.length > 0) {
      return summarizeRecoverReport(recoveredCorruptTargets);
    }
    return summarizeRecoverReport([
      createSyntheticRecoverTargetReport(
        params.env,
        "No failed session SQLite migration manifest found.",
      ),
    ]);
  }
  const restore = restoreSessionSqliteMigrationRun({
    manifestPath: failedRun.manifestPath,
    targetKeys: selectedTargetKeys,
  });
  const targetReports: DoctorSessionSqliteTargetReport[] = [];
  const manifestTargets = filterRecoveryManifestTargets(
    failedRun.manifest.targets,
    selectedTargetKeys,
  );
  for (const manifestTarget of manifestTargets) {
    targetReports.push(
      await params.validateTarget({
        agentId: manifestTarget.agentId,
        storePath: manifestTarget.storePath,
      }),
    );
  }
  const reportTarget =
    targetReports[0] ?? createSyntheticRecoverTargetReport(params.env, failedRun.manifestPath);
  reportTarget.restore = restore;
  reportTarget.issues.push(
    ...restore.conflicts.map((conflict) => ({
      code: "restore_conflict",
      message: `${conflict.sourcePath}: ${conflict.reason}`,
    })),
  );
  const failureReports = writeSessionSqliteMigrationFailureReports(failedRun.manifestPath, {
    reason: "doctor recover restored and validated a failed session SQLite migration run",
  });
  const report = summarizeRecoverReport(targetReports.length > 0 ? targetReports : [reportTarget]);
  report.migrationRun = {
    failureReportJsonPath: failureReports.jsonPath,
    failureReportMarkdownPath: failureReports.markdownPath,
    manifestPath: failedRun.manifestPath,
    runId: failedRun.manifest.runId,
  };
  report.supportIssue = createSessionSqliteMigrationFailureIssue(
    failedRun.manifestPath,
    selectedTargetKeys,
  );
  return report;
}

function recoverCorruptSqliteTargets(
  targets: readonly SessionStoreTarget[],
): DoctorSessionSqliteTargetReport[] {
  return targets.flatMap((target) => {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (!fs.existsSync(sqlitePath)) {
      return [];
    }
    const stats = readOnlySqliteDbStats(target);
    if (stats.ok) {
      if (stats.stats.integrityCheck && stats.stats.integrityCheck !== "ok") {
        return [
          recoverCorruptSqliteTarget(
            target,
            sqlitePath,
            new Error(`SQLite quick_check reported: ${stats.stats.integrityCheck}`),
          ),
        ];
      }
      return [];
    }
    if (!isSqliteCorruptionError(stats.error)) {
      return [createRecoverInspectionFailureTargetReport(target, sqlitePath, stats.error)];
    }
    return [recoverCorruptSqliteTarget(target, sqlitePath, stats.error)];
  });
}

function recoverCorruptSqliteTarget(
  target: SessionStoreTarget,
  sqlitePath: string,
  error: unknown,
): DoctorSessionSqliteTargetReport {
  const report = createEmptyRecoverTargetReport(target, sqlitePath);
  try {
    report.corruptRecovery = moveCorruptSqliteFilesAside(sqlitePath);
  } catch (moveError) {
    report.issues.push({
      code: "sqlite_corrupt_recovery_failed",
      message: `${sqlitePath}: ${String(moveError)}; original error: ${String(error)}`,
    });
  }
  return report;
}

function createRecoverInspectionFailureTargetReport(
  target: SessionStoreTarget,
  sqlitePath: string,
  error: unknown,
): DoctorSessionSqliteTargetReport {
  const report = createEmptyRecoverTargetReport(target, sqlitePath);
  report.issues.push({
    code: "sqlite_recovery_inspect_failed",
    message: `${sqlitePath}: ${String(error)}`,
  });
  return report;
}

function moveCorruptSqliteFilesAside(sqlitePath: string): {
  movedFiles: string[];
  skippedFiles: string[];
} {
  const movedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const suffix = `.corrupt-${Date.now()}`;
  for (const candidate of [sqlitePath, `${sqlitePath}-wal`, `${sqlitePath}-shm`]) {
    if (!fs.existsSync(candidate)) {
      skippedFiles.push(candidate);
      continue;
    }
    const destination = uniqueRecoveryPath(`${candidate}${suffix}`);
    fs.renameSync(candidate, destination);
    movedFiles.push(destination);
  }
  return { movedFiles, skippedFiles };
}

function uniqueRecoveryPath(basePath: string): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? basePath : `${basePath}.${attempt}`;
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not choose recovery path for ${basePath}`);
}

function isSqliteCorruptionError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") {
    return true;
  }
  const message = String(error).toLowerCase();
  return message.includes("database disk image is malformed") || message.includes("not a database");
}

function resolveRecoverTargetKeys(
  options: DoctorSessionSqliteOptions,
  targets: readonly SessionStoreTarget[],
): ReadonlySet<string> | undefined {
  const hasSelector = Boolean(options.agent || options.allAgents || options.store);
  return hasSelector
    ? new Set(targets.map((target) => sessionSqliteMigrationTargetKey(target)))
    : undefined;
}

function filterRecoveryManifestTargets<T extends { agentId: string; storePath: string }>(
  targets: readonly T[],
  selectedTargetKeys: ReadonlySet<string> | undefined,
): T[] {
  if (!selectedTargetKeys) {
    return [...targets];
  }
  return targets.filter((target) =>
    selectedTargetKeys.has(sessionSqliteMigrationTargetKey(target)),
  );
}

function createSyntheticRecoverTargetReport(
  env: NodeJS.ProcessEnv,
  message: string,
): DoctorSessionSqliteTargetReport {
  return {
    agentId: "recover",
    archivedTranscriptFiles: [],
    archivedUnreferencedJsonlFiles: [],
    importedEntries: 0,
    importedTranscriptEvents: 0,
    issues: [{ code: "recover_manifest_missing", message }],
    legacyEntries: 0,
    referencedTranscriptFiles: 0,
    sqliteEntries: 0,
    sqlitePath: "",
    storePath: resolveSessionSqliteMigrationRunsDir(env),
    unreferencedJsonlFiles: [],
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
  };
}

function createEmptyRecoverTargetReport(
  target: SessionStoreTarget,
  sqlitePath: string,
): DoctorSessionSqliteTargetReport {
  return {
    agentId: target.agentId,
    archivedTranscriptFiles: [],
    archivedUnreferencedJsonlFiles: [],
    importedEntries: 0,
    importedTranscriptEvents: 0,
    issues: [],
    legacyEntries: 0,
    referencedTranscriptFiles: 0,
    sqliteEntries: 0,
    sqlitePath,
    storePath: target.storePath,
    unreferencedJsonlFiles: [],
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
  };
}

function summarizeRecoverReport(
  targets: DoctorSessionSqliteTargetReport[],
): DoctorSessionSqliteReport {
  return {
    mode: "recover",
    targets,
    totals: {
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: targets.reduce((total, target) => total + target.issues.length, 0),
      legacyEntries: targets.reduce((total, target) => total + target.legacyEntries, 0),
      sqliteEntries: targets.reduce((total, target) => total + target.sqliteEntries, 0),
      targets: targets.length,
      unreferencedJsonlFiles: targets.reduce(
        (total, target) => total + target.unreferencedJsonlFiles.length,
        0,
      ),
      validatedEntries: targets.reduce((total, target) => total + target.validatedEntries, 0),
      validatedTranscriptEvents: targets.reduce(
        (total, target) => total + target.validatedTranscriptEvents,
        0,
      ),
    },
  };
}
