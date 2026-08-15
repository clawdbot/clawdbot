import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
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

export type SessionIdentityEvidenceResult =
  | { status: "current"; sessionKey: string }
  | { status: "absent" }
  | {
      status: "unknown";
      reason: "ambiguous" | "read-failed" | "row-invalid" | "schema-missing" | "table-missing";
    };

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

/** Indexed exact-key/session-id probe that preserves unreadable state as unknown. */
export function readSessionIdentityEvidence(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): SessionIdentityEvidenceResult {
  const resolved = resolveSqliteScope({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  let result:
    | { found: true; value: SessionIdentityEvidenceResult }
    | { found: false; reason: "database-missing" | "schema-missing" | "table-missing" };
  try {
    result = withOpenClawAgentDatabaseReadOnly((database): SessionIdentityEvidenceResult => {
      const exact = readExactSessionEntryRowValidated(database, resolved.sessionKey)?.entry;
      if (exact?.sessionId === params.sessionId) {
        return { status: "current", sessionKey: resolved.sessionKey };
      }
      const rows = executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_nodes")
          .select(["session_key", "entry_valid"])
          .where("current_session_id", "=", params.sessionId)
          .limit(2),
      ).rows;
      if (rows.length === 0) {
        return { status: "absent" };
      }
      if (rows.length !== 1) {
        return { status: "unknown", reason: "ambiguous" };
      }
      const row = rows[0];
      if (row?.entry_valid === -1) {
        return { status: "absent" };
      }
      const sessionKey = row?.session_key;
      if (!sessionKey || row.entry_valid !== 1) {
        return { status: "unknown", reason: "row-invalid" };
      }
      const entry = readExactSessionEntryRowValidated(database, sessionKey)?.entry;
      return entry?.sessionId === params.sessionId
        ? { status: "current", sessionKey }
        : { status: "unknown", reason: "row-invalid" };
    }, toDatabaseOptions(resolved));
  } catch {
    return { status: "unknown", reason: "read-failed" };
  }
  if (result.found) {
    return result.value;
  }
  return result.reason === "database-missing"
    ? { status: "absent" }
    : { status: "unknown", reason: result.reason };
}
