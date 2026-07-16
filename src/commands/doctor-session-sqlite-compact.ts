/** Runs doctor-owned SQLite file compaction for migrated session stores. */
import fs from "node:fs";
import type { SessionStoreTarget } from "../config/sessions/targets.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  ensureOpenClawAgentDatabasePermissions,
  isOpenClawAgentDatabaseOpen,
  migrateOpenClawAgentDatabaseForMaintenance,
} from "../state/openclaw-agent-db.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";
import type { DoctorSessionSqliteCompactReport } from "./doctor-session-sqlite-types.js";
import { compactDoctorSqliteFile } from "./doctor-sqlite-compact.js";

/** Reclaim free pages from one agent session SQLite database. */
export function compactDoctorSessionSqliteTarget(
  target: SessionStoreTarget,
  options: { migrateOlderSchema?: boolean } = {},
): DoctorSessionSqliteCompactReport {
  const sqlitePath = resolveTargetSqlitePath(target);
  const beforeFileSizes = readSqliteFileSizes(sqlitePath);
  const stat = readSessionDatabaseStat(sqlitePath);
  if (!stat) {
    return {
      dbSizeAfterBytes: 0,
      dbSizeBeforeBytes: 0,
      freelistAfterPages: 0,
      freelistBeforePages: 0,
      pageSizeBytes: 0,
      reclaimedBytes: 0,
      skipped: true,
      walSizeAfterBytes: beforeFileSizes.walSizeBytes,
      walSizeBeforeBytes: beforeFileSizes.walSizeBytes,
    };
  }
  if (!stat.isFile()) {
    throw new Error(`OpenClaw agent database is not a regular file: ${sqlitePath}`);
  }
  if (isOpenClawAgentDatabaseOpen(sqlitePath)) {
    throw new Error(
      `OpenClaw agent database ${sqlitePath} is already open in this process. Stop OpenClaw and retry.`,
    );
  }
  if (options.migrateOlderSchema) {
    migrateOpenClawAgentDatabaseForMaintenance({
      agentId: target.agentId,
      pathname: sqlitePath,
    });
  }

  const compact = compactDoctorSqliteFile({
    afterMutation: () =>
      ensureOpenClawAgentDatabasePermissions(sqlitePath, {
        agentId: target.agentId,
        path: sqlitePath,
      }),
    sqlitePath,
    validateBeforeMutation: (database) =>
      assertOpenClawAgentDatabaseForMaintenance(database, {
        agentId: target.agentId,
        pathname: sqlitePath,
      }),
  });
  return {
    dbSizeAfterBytes: compact.after.dbSizeBytes,
    dbSizeBeforeBytes: compact.before.dbSizeBytes,
    freelistAfterPages: compact.after.freelistPages,
    freelistBeforePages: compact.before.freelistPages,
    pageSizeBytes: compact.before.pageSizeBytes || compact.after.pageSizeBytes,
    reclaimedBytes: compact.reclaimedBytes,
    skipped: false,
    walSizeAfterBytes: compact.after.walSizeBytes,
    walSizeBeforeBytes: compact.before.walSizeBytes,
  };
}

function readSessionDatabaseStat(sqlitePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(sqlitePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readSqliteFileSizes(sqlitePath: string): { dbSizeBytes: number; walSizeBytes: number } {
  return {
    dbSizeBytes: fileSize(sqlitePath),
    walSizeBytes: fileSize(`${sqlitePath}-wal`),
  };
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
