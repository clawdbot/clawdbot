import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "../state/openclaw-state-db-contract.js";
import { VERSION } from "../version.js";
import { resolveCommitHash } from "./git-commit.js";
import { resolveOpenClawPackageRootSync } from "./openclaw-root.js";

type SqliteUserVersionReader = {
  prepare: (sql: string) => { get: () => unknown };
};

const SQLITE_SCHEMA_VERSION_ERROR_NAME = "SqliteSchemaVersionError";

export class SqliteSchemaVersionError extends Error {
  override name = SQLITE_SCHEMA_VERSION_ERROR_NAME;
}

export function isSqliteSchemaVersionError(error: unknown): error is Error {
  return (
    error instanceof SqliteSchemaVersionError ||
    (error instanceof Error && error.name === SQLITE_SCHEMA_VERSION_ERROR_NAME)
  );
}

export function readSqliteUserVersion(db: SqliteUserVersionReader): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * Name the refusing install the way `--version` does, plus the root it runs from.
 * The path is the only part an operator can always act on: one release version
 * string spans many commits, and a linked source checkout reports its git HEAD
 * even when the built output actually executing is older.
 */
export function describeRunningOpenClawBuild(): string {
  const moduleUrl = import.meta.url;
  const commit = resolveCommitHash({ moduleUrl });
  const root = resolveOpenClawPackageRootSync({ moduleUrl });
  const identity = commit ? `OpenClaw ${VERSION} (${commit})` : `OpenClaw ${VERSION}`;
  return root ? `${identity} installed at ${root}` : identity;
}

export function createNewerSqliteSchemaVersionError(
  databaseLabel: string,
  pathname: string,
  schemaVersion: number,
  supportedVersion: number,
): Error {
  return new SqliteSchemaVersionError(
    `${databaseLabel} ${pathname} uses newer schema version ${schemaVersion}; this build supports ${supportedVersion}. ` +
      `Refused by ${describeRunningOpenClawBuild()}. ` +
      "Identify installs by that path: one version string spans many builds, and a linked source checkout reports its git HEAD even when its built output is older. " +
      `Run a build that supports schema ${schemaVersion} or newer against this state directory — rebuild or update the install above — or point this build at a different OPENCLAW_STATE_DIR. ` +
      `See ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
  );
}
