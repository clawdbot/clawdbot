type SqliteUserVersionReader = {
  prepare: (sql: string) => { get: () => unknown };
};

export function readSqliteUserVersion(db: SqliteUserVersionReader): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
  return Number(row?.user_version ?? 0);
}

export function createNewerSqliteSchemaVersionError(
  databaseLabel: string,
  pathname: string,
  schemaVersion: number,
  supportedVersion: number,
): Error {
  return new Error(
    `${databaseLabel} ${pathname} uses newer schema version ${schemaVersion}; this OpenClaw build supports ${supportedVersion}. Upgrade OpenClaw before opening this database. Do not downgrade OpenClaw or modify the database. To run this older build, use a separate state directory or restore a compatible backup.`,
  );
}
