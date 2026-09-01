import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { ExactSessionEntry, SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  parseReadableSqliteSessionEntryRow,
  readExactSessionEntryRowValidated,
} from "./session-accessor.sqlite-entry-store.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  resolveSqliteScope,
  toDatabaseOptions,
  type SessionSqliteTargetResolutionCache,
} from "./session-accessor.sqlite-scope.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
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
      entry: result.value.entry,
    },
  };
}

type SessionIdentityEvidenceProbe = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  /** Omit for identity-only repair: no exact key may override ambiguous physical ownership. */
  sessionKey?: string;
  storePath: string;
};

const SESSION_IDENTITY_EVIDENCE_QUERY_CHUNK_SIZE = 400;

type SessionIdentityEvidenceItem = {
  index: number;
  sessionId: string;
  sessionKey?: string;
};

type SessionIdentityEvidenceRow = {
  current_session_id: string;
  entry_json: string;
  entry_valid: number;
  session_key: string;
  updated_at: number;
};

function readSessionIdentityEvidenceRows(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  items: readonly SessionIdentityEvidenceItem[],
): SessionIdentityEvidenceResult[] {
  assertCanonicalSqliteSessionKeysCurrent(database);
  const db = getSessionKysely(database.db);
  const rowsByKey = new Map<string, SessionIdentityEvidenceRow>();
  const readChunks = (values: readonly string[], column: "current_session_id" | "session_key") => {
    for (
      let offset = 0;
      offset < values.length;
      offset += SESSION_IDENTITY_EVIDENCE_QUERY_CHUNK_SIZE
    ) {
      const chunk = values.slice(offset, offset + SESSION_IDENTITY_EVIDENCE_QUERY_CHUNK_SIZE);
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select(["current_session_id", "entry_json", "entry_valid", "session_key", "updated_at"])
          .where(column, "in", chunk),
      ).rows;
      for (const row of rows) {
        rowsByKey.set(row.session_key, row);
      }
    }
  };
  readChunks(
    [...new Set(items.flatMap((item) => (item.sessionKey ? [item.sessionKey] : [])))],
    "session_key",
  );
  readChunks([...new Set(items.map((item) => item.sessionId))], "current_session_id");

  const rowsBySessionId = new Map<string, SessionIdentityEvidenceRow[]>();
  const readableKeys = new Set<string>();
  for (const row of rowsByKey.values()) {
    const rows = rowsBySessionId.get(row.current_session_id) ?? [];
    rows.push(row);
    rowsBySessionId.set(row.current_session_id, rows);
    if (row.entry_valid === 1) {
      try {
        if (parseReadableSqliteSessionEntryRow(database, row)) {
          readableKeys.add(row.session_key);
        }
      } catch {
        // A corrupt row must not make unrelated placements in this store indeterminate.
      }
    }
  }
  return items.map((item): SessionIdentityEvidenceResult => {
    const exactRow = item.sessionKey ? rowsByKey.get(item.sessionKey) : undefined;
    if (exactRow && exactRow.entry_valid !== -1 && !readableKeys.has(exactRow.session_key)) {
      return { status: "unknown", reason: "row-invalid" };
    }
    if (
      exactRow &&
      readableKeys.has(exactRow.session_key) &&
      exactRow.current_session_id === item.sessionId
    ) {
      return { status: "current", sessionKey: exactRow.session_key };
    }
    const fallbackRows = rowsBySessionId.get(item.sessionId) ?? [];
    if (fallbackRows.length !== 1) {
      return fallbackRows.length === 0
        ? { status: "absent" }
        : { status: "unknown", reason: "ambiguous" };
    }
    const fallbackRow = fallbackRows[0];
    if (fallbackRow?.entry_valid === 1 && readableKeys.has(fallbackRow.session_key)) {
      return { status: "current", sessionKey: fallbackRow.session_key };
    }
    return fallbackRow?.entry_valid === -1
      ? { status: "absent" }
      : { status: "unknown", reason: "row-invalid" };
  });
}

/** Reads indexed identity evidence once per physical store and in SQLite-sized chunks. */
export function readSessionIdentityEvidenceBatch(
  probes: readonly SessionIdentityEvidenceProbe[],
): SessionIdentityEvidenceResult[] {
  const results: SessionIdentityEvidenceResult[] = probes.map(() => ({
    status: "unknown",
    reason: "read-failed",
  }));
  const groups = new Map<
    string,
    {
      items: SessionIdentityEvidenceItem[];
      options: ReturnType<typeof toDatabaseOptions>;
    }
  >();
  const targetCache: SessionSqliteTargetResolutionCache = new Map();
  for (const [index, probe] of probes.entries()) {
    try {
      const resolved = resolveSqliteReadScope(probe, targetCache);
      const options = toDatabaseOptions(resolved);
      const databasePath = resolveOpenClawAgentSqlitePath(options);
      const group = groups.get(databasePath) ?? { items: [], options };
      group.items.push({
        index,
        sessionId: probe.sessionId,
        sessionKey: resolved.sessionKey,
      });
      groups.set(databasePath, group);
    } catch {
      // The initialized conservative result applies only to this malformed probe.
    }
  }
  for (const group of groups.values()) {
    let read:
      | { found: true; value: SessionIdentityEvidenceResult[] }
      | { found: false; reason: "database-missing" | "schema-missing" | "table-missing" };
    try {
      read = withOpenClawAgentDatabaseReadOnly(
        (database) => readSessionIdentityEvidenceRows(database, group.items),
        group.options,
      );
    } catch {
      continue;
    }
    if (read.found) {
      for (const [itemIndex, item] of group.items.entries()) {
        results[item.index] = read.value[itemIndex] ?? {
          status: "unknown",
          reason: "read-failed",
        };
      }
      continue;
    }
    const unavailable: SessionIdentityEvidenceResult =
      read.reason === "database-missing"
        ? { status: "absent" }
        : { status: "unknown", reason: read.reason };
    for (const item of group.items) {
      results[item.index] = unavailable;
    }
  }
  return results;
}
