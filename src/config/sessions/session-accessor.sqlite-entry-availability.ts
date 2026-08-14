import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { ExactSessionEntry, SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-store.js";
import {
  cloneSessionEntry,
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

type ExactSessionEntryReadOnlyResult =
  | { found: true; value: ExactSessionEntry | undefined }
  | {
      found: false;
      reason: "database-missing" | "schema-missing" | "table-missing" | "row-invalid";
    };

/** Exact persisted-key probe that preserves database and row availability. */
export function loadExactSessionEntryReadOnlyResult(
  scope: SessionAccessScope,
): ExactSessionEntryReadOnlyResult {
  const sessionKey = scope.sessionKey.trim();
  if (!sessionKey) {
    return { found: true, value: undefined };
  }
  const resolved = resolveSqliteScope(scope);
  let result:
    | { found: true; value: { entry: SessionEntry | undefined; rowExists: boolean } }
    | { found: false; reason: "database-missing" | "schema-missing" | "table-missing" };
  try {
    result = withOpenClawAgentDatabaseReadOnly((database) => {
      const entry = readExactSessionEntryRowValidated(database, sessionKey)?.entry;
      const rowExists = entry
        ? true
        : Boolean(
            executeSqliteQueryTakeFirstSync(
              database.db,
              getSessionKysely(database.db)
                .selectFrom("session_nodes")
                .select("session_key")
                .where("session_key", "=", sessionKey),
            ),
          );
      return { entry, rowExists };
    }, toDatabaseOptions(resolved));
  } catch (error) {
    if (
      error instanceof Error &&
      (error as { code?: unknown }).code === "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED"
    ) {
      return { found: false, reason: "row-invalid" };
    }
    throw error;
  }
  if (!result.found) {
    return result;
  }
  if (!result.value.entry) {
    return result.value.rowExists
      ? { found: false, reason: "row-invalid" }
      : { found: true, value: undefined };
  }
  return {
    found: true,
    value: {
      sessionKey,
      entry: scope.clone === false ? result.value.entry : cloneSessionEntry(result.value.entry),
    },
  };
}
