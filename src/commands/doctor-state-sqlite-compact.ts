/** Explicit doctor maintenance for the canonical shared state SQLite database. */
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import {
  ensureOpenClawStatePermissions,
  isOpenClawStateDatabaseOpen,
  OPENCLAW_STATE_SCHEMA_VERSION,
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
    validateBeforeMutation: (database) => validateCanonicalStateDatabase(database, sqlitePath),
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

function validateCanonicalStateDatabase(database: DatabaseSync, sqlitePath: string): void {
  const userVersion = readSqliteUserVersion(database);
  if (userVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw state database",
      sqlitePath,
      userVersion,
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
  }
  if (userVersion !== OPENCLAW_STATE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw state database ${sqlitePath} uses schema version ${userVersion}; run openclaw doctor --fix before compacting it.`,
    );
  }

  const metadata = database
    .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
    .get() as { role?: unknown; schema_version?: unknown } | undefined;
  if (metadata?.role !== "global") {
    const role = typeof metadata?.role === "string" ? metadata.role : "missing";
    throw new Error(
      `OpenClaw state database ${sqlitePath} has schema role ${role}; expected global.`,
    );
  }
  if (metadata.schema_version !== OPENCLAW_STATE_SCHEMA_VERSION) {
    const schemaVersion =
      typeof metadata.schema_version === "number" ? metadata.schema_version : "invalid";
    throw new Error(
      `OpenClaw state database ${sqlitePath} metadata schema version ${schemaVersion} does not match ${OPENCLAW_STATE_SCHEMA_VERSION}; run openclaw doctor --fix before compacting it.`,
    );
  }
}
