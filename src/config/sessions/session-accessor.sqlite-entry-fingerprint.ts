import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SqliteSessionCommitFingerprint } from "./session-accessor.sqlite-entry-equality.js";
import { normalizeLifecycleTarget } from "./session-accessor.sqlite-entry-store.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";

type OpenClawAgentDatabaseReader = Pick<OpenClawAgentDatabase, "agentId" | "db">;

/** Raw persisted columns that define one session row at the commit edge. */
type SqliteSessionRowCommitTuple = [
  sessionKey: string,
  currentSessionId: string,
  entryJson: string,
  updatedAt: number,
];

function readExactSessionRowCommitTuple(
  database: OpenClawAgentDatabaseReader,
  sessionKey: string,
): SqliteSessionRowCommitTuple | undefined {
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select(["session_key", "current_session_id", "entry_json", "updated_at"])
      .where("session_key", "=", sessionKey),
  );
  return row
    ? [row.session_key, row.current_session_id, row.entry_json, row.updated_at]
    : undefined;
}

function toSessionCommitFingerprint(
  tuples: ReadonlyArray<SqliteSessionRowCommitTuple | undefined>,
): SqliteSessionCommitFingerprint {
  return JSON.stringify(tuples);
}

/**
 * Fingerprint mirror of readSessionEntrySelectionSnapshot: both select only the exact
 * canonical row, so commit revalidation can compare raw columns without decoding them.
 */
export function readSessionEntrySelectionCommitFingerprint(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  exact: boolean,
): SqliteSessionCommitFingerprint {
  if (!exact) {
    assertCanonicalSqliteSessionKeysCurrent(database);
  }
  const trimmedKey = sessionKey.trim();
  return toSessionCommitFingerprint([
    trimmedKey ? readExactSessionRowCommitTuple(database, trimmedKey) : undefined,
  ]);
}

/** Fingerprint mirror of readLifecycleTargetSnapshot, keeping its duplicate and alias errors. */
export function readLifecycleTargetCommitFingerprint(
  database: OpenClawAgentDatabase,
  target: { canonicalKey: string; storeKeys: string[] },
  options: { allowCanonicalMove?: boolean } = {},
): SqliteSessionCommitFingerprint {
  assertCanonicalSqliteSessionKeysCurrent(database);
  const normalized = normalizeLifecycleTarget(target);
  const tuples = normalized.storeKeys.map((key) =>
    readExactSessionRowCommitTuple(database, key.trim()),
  );
  const present = tuples.filter((tuple) => tuple !== undefined);
  if (present.length > 1) {
    throw canonicalSessionKeyMigrationRequiredError(
      `duplicate rows resolve to canonical session key ${normalized.canonicalKey}`,
    );
  }
  const [tuple] = present;
  if (tuple && tuple[0] !== normalized.canonicalKey && options.allowCanonicalMove !== true) {
    throw canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${normalized.canonicalKey}`,
    );
  }
  return toSessionCommitFingerprint(tuples);
}
