/** Builds doctor reports for session SQLite migration recovery mode. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import {
  createSessionSqliteMigrationFailureIssue,
  findLatestFailedSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
  restoreSessionSqliteMigrationRun,
  writeSessionSqliteMigrationFailureReports,
  type SessionSqliteMigrationTargetInput,
} from "./doctor-session-sqlite-migration-run.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
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
  const trustedTargets = resolveRecoverTargets(params.targets);
  const failedRun = findLatestFailedSessionSqliteMigrationManifest(params.env, trustedTargets);
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
    trustedTargets,
  });
  const targetReports: DoctorSessionSqliteTargetReport[] = [];
  for (const manifestTarget of failedRun.targets) {
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
    trustedTargets,
  );
  return report;
}

function recoverCorruptSqliteTargets(
  targets: readonly SessionStoreTarget[],
): DoctorSessionSqliteTargetReport[] {
  return targets.flatMap((target) => {
    const sqlitePath = resolveTargetSqlitePath(target);
    let recoveryFiles: ReturnType<typeof inspectSqliteRecoveryFiles>;
    try {
      recoveryFiles = inspectSqliteRecoveryFiles(sqlitePath);
    } catch (error) {
      return [createRecoverInspectionFailureTargetReport(target, sqlitePath, error)];
    }
    if (recoveryFiles.existing.length === 0) {
      return [];
    }
    if (!recoveryFiles.existing.includes(sqlitePath)) {
      return [
        recoverCorruptSqliteTarget(
          target,
          sqlitePath,
          new Error(`SQLite sidecars exist without their main database: ${sqlitePath}`),
        ),
      ];
    }
    const inspection = inspectSqliteForRecovery(sqlitePath, recoveryFiles.existing);
    if (inspection.ok) {
      return [];
    }
    if (!isSqliteCorruptionError(inspection.error)) {
      return [createRecoverInspectionFailureTargetReport(target, sqlitePath, inspection.error)];
    }
    return [recoverCorruptSqliteTarget(target, sqlitePath, inspection.error)];
  });
}

function inspectSqliteForRecovery(
  sqlitePath: string,
  sourcePaths: readonly string[],
): { ok: true } | { error: unknown; ok: false } {
  let inspectionDir: string | undefined;
  let database: DatabaseSync | undefined;
  let inspectionError: unknown;
  try {
    const sqlite = requireNodeSqlite();
    inspectionDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-recovery-"));
    const inspectionPath = path.join(inspectionDir, path.basename(sqlitePath));
    for (const sourcePath of sourcePaths) {
      const suffix = sourcePath.slice(sqlitePath.length);
      const inspectionFilePath = `${inspectionPath}${suffix}`;
      fs.copyFileSync(sourcePath, inspectionFilePath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(inspectionFilePath, 0o600);
    }
    // Writable inspection of the disposable copy lets SQLite roll back a hot
    // journal without changing the original forensic file set.
    database = new sqlite.DatabaseSync(inspectionPath);
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    database.exec("PRAGMA trusted_schema = OFF;");
    assertSqliteIntegrity(database, inspectionPath);
  } catch (error) {
    inspectionError = error;
  }
  try {
    database?.close();
  } catch (error) {
    inspectionError ??= error;
  }
  try {
    if (inspectionDir) {
      fs.rmSync(inspectionDir, { force: true, recursive: true });
    }
  } catch (error) {
    inspectionError ??= error;
  }
  return inspectionError === undefined ? { ok: true } : { error: inspectionError, ok: false };
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
  const recoveryFiles = inspectSqliteRecoveryFiles(sqlitePath);
  const moves = planCorruptSqliteMoves(recoveryFiles.existing);
  const completed: typeof moves = [];
  try {
    // Preserve every journal before removing the main pathname. Recovery is
    // offline; rollback restores the set after a caught rename failure.
    for (const move of moves.toSorted((left, right) => {
      if (left.sourcePath === sqlitePath) {
        return 1;
      }
      if (right.sourcePath === sqlitePath) {
        return -1;
      }
      return left.sourcePath.localeCompare(right.sourcePath);
    })) {
      fs.renameSync(move.sourcePath, move.destinationPath);
      completed.push(move);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const move of completed.toReversed()) {
      try {
        if (pathExists(move.sourcePath)) {
          throw new Error(`rollback source was recreated: ${move.sourcePath}`, {
            cause: error,
          });
        }
        fs.renameSync(move.destinationPath, move.sourcePath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      const rollbackDetails = rollbackErrors
        .map((rollbackError) => String(rollbackError))
        .join("; ");
      throw new Error(
        `Could not move corrupt SQLite file set aside or restore it: ${sqlitePath}; rollback failures: ${rollbackDetails}`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    movedFiles: moves.map((move) => move.destinationPath),
    skippedFiles: recoveryFiles.missing,
  };
}

function inspectSqliteRecoveryFiles(sqlitePath: string): {
  existing: string[];
  missing: string[];
} {
  const existing: string[] = [];
  const missing: string[] = [];
  for (const candidate of resolveSqliteDatabaseFilePaths(sqlitePath)) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile()) {
        throw new Error(`SQLite recovery path is not a regular file: ${candidate}`);
      }
      existing.push(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(candidate);
        continue;
      }
      throw error;
    }
  }
  return { existing, missing };
}

function planCorruptSqliteMoves(
  sourcePaths: readonly string[],
): Array<{ destinationPath: string; sourcePath: string }> {
  const timestampSuffix = `.corrupt-${Date.now()}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? timestampSuffix : `${timestampSuffix}.${attempt}`;
    const moves = sourcePaths.map((sourcePath) => ({
      destinationPath: `${sourcePath}${suffix}`,
      sourcePath,
    }));
    if (moves.every((move) => !pathExists(move.destinationPath))) {
      return moves;
    }
  }
  throw new Error(`Could not choose recovery paths for ${sourcePaths[0] ?? "SQLite files"}`);
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isSqliteCorruptionError(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") {
    return true;
  }
  const message = String(error).toLowerCase();
  return (
    message.includes("database disk image is malformed") ||
    message.includes("not a database") ||
    message.includes("sqlite quick_check failed") ||
    message.includes("sqlite integrity_check failed") ||
    message.includes("sqlite foreign_key_check failed")
  );
}

function resolveRecoverTargets(
  targets: readonly SessionStoreTarget[],
): SessionSqliteMigrationTargetInput[] {
  return targets.map((target) => ({
    ...target,
    sqlitePath: resolveTargetSqlitePath(target),
  }));
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
