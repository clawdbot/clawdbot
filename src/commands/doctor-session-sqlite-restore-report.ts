/** Builds doctor reports for session SQLite migration restore mode. */
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import {
  resolveSessionSqliteMigrationRunsDir,
  restoreSessionSqliteMigrationRuns,
  sessionSqliteMigrationTargetKey,
} from "./doctor-session-sqlite-migration-run.js";
import { readSqliteEntryCount, resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import type {
  DoctorSessionSqliteReport,
  DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";

export async function restoreDoctorSessionSqliteTargets(params: {
  env: NodeJS.ProcessEnv;
  restoreAllManifests: boolean;
  targets: readonly SessionStoreTarget[];
}): Promise<DoctorSessionSqliteReport> {
  const targetReports = params.targets.map((target) => createEmptyTargetReport(target));
  const targetKeys = params.restoreAllManifests
    ? undefined
    : new Set(params.targets.map((target) => sessionSqliteMigrationTargetKey(target)));
  const restore = restoreSessionSqliteMigrationRuns({
    env: params.env,
    targetKeys,
  });
  const reportTarget =
    targetReports[0] ??
    createSyntheticRestoreTargetReport(
      params.env,
      restore.manifestPaths[0] ?? resolveSessionSqliteMigrationRunsDir(params.env),
    );
  reportTarget.restore = restore;
  reportTarget.issues.push(
    ...restore.conflicts.map((conflict) => ({
      code: "restore_conflict",
      message: `${conflict.sourcePath}: ${conflict.reason}`,
    })),
  );
  return summarizeRestoreReport(targetReports.length > 0 ? targetReports : [reportTarget]);
}

function createEmptyTargetReport(target: SessionStoreTarget): DoctorSessionSqliteTargetReport {
  return {
    agentId: target.agentId,
    archivedTranscriptFiles: [],
    archivedUnreferencedJsonlFiles: [],
    importedEntries: 0,
    importedTranscriptEvents: 0,
    issues: [],
    legacyEntries: 0,
    referencedTranscriptFiles: 0,
    sqliteEntries: readSqliteEntryCount(target),
    sqlitePath: resolveTargetSqlitePath(target),
    storePath: target.storePath,
    unreferencedJsonlFiles: [],
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
  };
}

function createSyntheticRestoreTargetReport(
  env: NodeJS.ProcessEnv,
  manifestPath: string,
): DoctorSessionSqliteTargetReport {
  return {
    agentId: "restore",
    archivedTranscriptFiles: [],
    archivedUnreferencedJsonlFiles: [],
    importedEntries: 0,
    importedTranscriptEvents: 0,
    issues: [],
    legacyEntries: 0,
    referencedTranscriptFiles: 0,
    sqliteEntries: 0,
    sqlitePath: "",
    storePath: manifestPath || resolveSessionSqliteMigrationRunsDir(env),
    unreferencedJsonlFiles: [],
    validatedEntries: 0,
    validatedTranscriptEvents: 0,
  };
}

function summarizeRestoreReport(
  targets: DoctorSessionSqliteTargetReport[],
): DoctorSessionSqliteReport {
  return {
    mode: "restore",
    targets,
    totals: {
      archivedTranscriptFiles: 0,
      archivedUnreferencedJsonlFiles: 0,
      importedEntries: 0,
      importedTranscriptEvents: 0,
      issues: targets.reduce((total, target) => total + target.issues.length, 0),
      legacyEntries: 0,
      sqliteEntries: targets.reduce((total, target) => total + target.sqliteEntries, 0),
      targets: targets.length,
      unreferencedJsonlFiles: 0,
      validatedEntries: 0,
      validatedTranscriptEvents: 0,
    },
  };
}
