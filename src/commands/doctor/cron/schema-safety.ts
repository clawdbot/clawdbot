import { isSqliteSchemaVersionError } from "../../../infra/sqlite-user-version.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../../../state/openclaw-state-db-readonly.js";

export function assertCronStateSchemaSupported(env?: NodeJS.ProcessEnv): void {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(() => undefined, { env });
}

export function rethrowSqliteSchemaVersionError(error: unknown): void {
  if (isSqliteSchemaVersionError(error)) {
    throw error;
  }
}
