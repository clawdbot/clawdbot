import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "../state/openclaw-state-db-contract.js";
import { resolveRuntimeServiceCommit, VERSION } from "../version.js";
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
 * Name the refusing build from immutable loaded metadata, plus its install root.
 * The path remains actionable when multiple installs share a version or build.
 */
export function describeRunningOpenClawBuild(): string {
  const commit = resolveRuntimeServiceCommit();
  const root = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
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
      "Identify installs by that path when multiple installs share a version or build. " +
      `Run a build that supports schema ${schemaVersion} or newer against this state directory — rebuild or update the install above — or point this build at a different OPENCLAW_STATE_DIR. ` +
      `See ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
  );
}
