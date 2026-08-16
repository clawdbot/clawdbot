/** Builds doctor reports for session SQLite migration restore mode. */
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import {
  resolveSessionSqliteMigrationRunsDir,
  restoreSessionSqliteMigrationRuns,
} from "./doctor-session-sqlite-migration-run.js";
import { readSqliteEntryCount, resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import {
  createDoctorSessionSqliteTargetReport,
  createDoctorSessionSqliteTotals,
  type DoctorSessionSqliteReport,
  type DoctorSessionSqliteTargetReport,
} from "./doctor-session-sqlite-types.js";

export async function restoreDoctorSessionSqliteTargets(params: {
  env: NodeJS.ProcessEnv;
  targets: readonly SessionStoreTarget[];
}): Promise<DoctorSessionSqliteReport> {
  const targetReports = params.targets.map((target) => createEmptyTargetReport(target));
  const trustedTargets = params.targets.map((target) => ({
    ...target,
    sqlitePath: resolveTargetSqlitePath(target),
  }));
  const restore = restoreSessionSqliteMigrationRuns({
    env: params.env,
    trustedTargets,
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
  return createDoctorSessionSqliteTargetReport({
    agentId: target.agentId,
    sqliteEntries: readSqliteEntryCount(target),
    sqlitePath: resolveTargetSqlitePath(target),
    storePath: target.storePath,
  });
}

function createSyntheticRestoreTargetReport(
  env: NodeJS.ProcessEnv,
  manifestPath: string,
): DoctorSessionSqliteTargetReport {
  return createDoctorSessionSqliteTargetReport({
    agentId: "restore",
    sqlitePath: "",
    storePath: manifestPath || resolveSessionSqliteMigrationRunsDir(env),
  });
}

function summarizeRestoreReport(
  targets: DoctorSessionSqliteTargetReport[],
): DoctorSessionSqliteReport {
  return {
    mode: "restore",
    targets,
    totals: createDoctorSessionSqliteTotals(targets),
  };
}
