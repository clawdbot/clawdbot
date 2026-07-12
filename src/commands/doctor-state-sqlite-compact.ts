/** Explicit doctor maintenance for the canonical shared state SQLite database. */
import fs from "node:fs";
import {
  assertOpenClawStateDatabaseForMaintenance,
  ensureOpenClawStatePermissions,
  isOpenClawStateDatabaseOpen,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  compactDoctorSqliteFile,
  type DoctorSqliteCompactSnapshot,
} from "./doctor-sqlite-compact.js";

export type DoctorStateSqliteCompactReport =
  | {
      mode: "compact";
      path: string;
      reason: "missing";
      skipped: true;
    }
  | {
      after: DoctorSqliteCompactSnapshot;
      before: DoctorSqliteCompactSnapshot;
      integrityCheck: "ok";
      mode: "compact";
      path: string;
      quickCheck: "ok";
      reclaimedBytes: number;
      skipped: false;
    };

type DoctorStateSqliteCompactOptions = {
  env?: NodeJS.ProcessEnv;
};

/** Compact only the canonical shared state database resolved for this invocation. */
export function runDoctorStateSqliteCompact(
  options: DoctorStateSqliteCompactOptions = {},
): DoctorStateSqliteCompactReport {
  const env = options.env ?? process.env;
  const sqlitePath = resolveOpenClawStateSqlitePath(env);
  const stat = readCanonicalStateDatabaseStat(sqlitePath);
  if (!stat) {
    return {
      mode: "compact",
      path: sqlitePath,
      reason: "missing",
      skipped: true,
    };
  }
  if (!stat.isFile()) {
    throw new Error(`Canonical OpenClaw state database is not a regular file: ${sqlitePath}`);
  }
  if (isOpenClawStateDatabaseOpen()) {
    throw new Error(
      "The shared OpenClaw state database is already open in this process. Stop OpenClaw and retry.",
    );
  }

  const compact = compactDoctorSqliteFile({
    afterMutation: () => ensureOpenClawStatePermissions(sqlitePath, env),
    sqlitePath,
    validateBeforeMutation: (database) =>
      assertOpenClawStateDatabaseForMaintenance(database, { pathname: sqlitePath }),
  });
  return {
    ...compact,
    mode: "compact",
    path: sqlitePath,
    skipped: false,
  };
}

function readCanonicalStateDatabaseStat(sqlitePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(sqlitePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
