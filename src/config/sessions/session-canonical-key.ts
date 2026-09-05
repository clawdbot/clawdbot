import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import { sessionEntryMetadataJson } from "./session-accessor.sqlite-status.js";
import { parseSqliteSessionEntryRecord } from "./session-entry-json.js";
import { projectCanonicalSessionEntryShape } from "./store-entry-shape.js";
import {
  normalizeStoreSessionKey,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";
import type { SessionEntry } from "./types.js";

const SESSION_CANONICAL_KEY_REPAIR_COMMAND = "openclaw doctor --fix";
type CanonicalSessionDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "schema_meta" | "session_key_contract" | "session_nodes" | "session_windows"
>;
const validatedDatabases = new WeakSet<DatabaseSync>();

class SessionCanonicalKeyMigrationRequiredError extends Error {
  readonly code = "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED";

  constructor(detail: string) {
    super(`${detail}; stop the Gateway and run ${SESSION_CANONICAL_KEY_REPAIR_COMMAND}`);
    this.name = "SessionCanonicalKeyMigrationRequiredError";
  }
}

function isCanonicalSessionKey(sessionKey: string): boolean {
  const trimmed = sessionKey.trim();
  if (!trimmed || sessionKey !== trimmed) {
    return false;
  }
  if (normalizeStoreSessionKey(sessionKey) !== sessionKey) {
    return false;
  }
  const parsed = parseAgentSessionKey(trimmed);
  return (
    trimmed === "global" ||
    trimmed === "unknown" ||
    (parsed !== null && trimmed.startsWith(`agent:${parsed.agentId}:`))
  );
}

export function assertCanonicalSessionKeyWrite(sessionKey: string, expectedAgentId?: string): void {
  const parsed = parseAgentSessionKey(sessionKey);
  if (
    !isCanonicalSessionKey(sessionKey) ||
    (expectedAgentId && parsed && parsed.agentId !== normalizeAgentId(expectedAgentId))
  ) {
    throw canonicalSessionKeyMigrationRequiredError(
      `refusing non-canonical session key write ${sessionKey}`,
    );
  }
}

function readCanonicalSessionMainKey(database: { db: DatabaseSync }): string {
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  return normalizeMainKey(
    executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
    )?.main_key,
  );
}

function assertCanonicalSessionMainKeyWrite(sessionKey: string, mainKey: string): void {
  if (parseAgentSessionKey(sessionKey)?.rest === "main" && mainKey !== "main") {
    throw canonicalSessionKeyMigrationRequiredError(
      `refusing non-canonical session key write ${sessionKey}`,
    );
  }
}

export function assertCanonicalSessionEntryLineageWrite(
  database: { db: DatabaseSync },
  entry: SessionEntry,
): void {
  const sessionKeys = [
    entry.parentSessionKey,
    entry.spawnedBy,
    entry.forkSource?.sessionKey,
  ].filter((sessionKey): sessionKey is string => sessionKey !== undefined);
  if (sessionKeys.length === 0) {
    return;
  }
  const mainKey = readCanonicalSessionMainKey(database);
  for (const sessionKey of sessionKeys) {
    assertCanonicalSessionKeyWrite(sessionKey);
    assertCanonicalSessionMainKeyWrite(sessionKey, mainKey);
  }
}

export function assertCanonicalSessionKeyWriteMatchesDatabase(
  database: { agentId: string; db: DatabaseSync },
  sessionKey: string,
): void {
  // Exact SQLite locators are shared stores; the outer resolved scope already enforces
  // logical agent ownership before this database-level shape check.
  assertCanonicalSessionKeyWrite(sessionKey);
  assertCanonicalSessionMainKeyWrite(sessionKey, readCanonicalSessionMainKey(database));
}

export function canonicalSessionKeyMigrationRequiredError(
  detail: string,
): SessionCanonicalKeyMigrationRequiredError {
  return new SessionCanonicalKeyMigrationRequiredError(detail);
}

export function scanCanonicalSqliteSessionEntries(
  database: { agentId: string; db: DatabaseSync },
  visit?: (summary: { entry: SessionEntry; sessionKey: string }) => void,
  mainKey?: string,
): number {
  // This connection validates once. External direct-SQLite edits surface at the next
  // process start, not the next topology change; doctor owns live repair.
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  const storedMainKey = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
  )?.main_key;
  const canonicalMainKey = normalizeMainKey(mainKey ?? storedMainKey);
  let count = 0;
  for (const row of iterateSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .leftJoin("session_windows as retained_window", (join) =>
        join
          .onRef("retained_window.session_id", "=", "session_nodes.current_session_id")
          .onRef("retained_window.session_key", "=", "session_nodes.session_key"),
      )
      .select([
        "session_nodes.session_key",
        "session_nodes.current_session_id",
        "session_nodes.entry_valid",
        "session_nodes.fork_source_session_key",
        "session_nodes.parent_session_key",
        "session_nodes.spawned_by",
        "retained_window.session_id as retained_window_id",
      ])
      // Key validation needs metadata; Doctor visitors still own complete saved entries.
      .select(visit ? "session_nodes.entry_json" : sessionEntryMetadataJson)
      .orderBy("session_nodes.session_key"),
  )) {
    if (
      row.entry_json === "{}" &&
      row.entry_valid === -1 &&
      row.retained_window_id === row.current_session_id
    ) {
      continue;
    }
    const record = row.entry_valid === 1 ? parseSqliteSessionEntryRecord(row) : null;
    if (!record) {
      throw canonicalSessionKeyMigrationRequiredError(
        `invalid persisted session row requires repair for ${row.session_key}`,
      );
    }
    const entry = projectCanonicalSessionEntryShape(record);
    if (
      (row.parent_session_key ?? undefined) !==
        (entry.parentSessionKey ?? entry.spawnedBy ?? undefined) ||
      (row.spawned_by ?? undefined) !== (entry.spawnedBy ?? undefined) ||
      (row.fork_source_session_key ?? undefined) !== (entry.forkSource?.sessionKey ?? undefined)
    ) {
      throw canonicalSessionKeyMigrationRequiredError(
        `invalid persisted session row requires repair for ${row.session_key}`,
      );
    }
    const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(row.session_key, entry);
    if (deliveryCanonicalKey !== row.session_key) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
      );
    }
    const trimmed = row.session_key.trim();
    const parsed = parseAgentSessionKey(trimmed);
    if (
      row.session_key !== trimmed ||
      normalizeStoreSessionKey(trimmed) !== trimmed ||
      (!parsed && trimmed !== "global" && trimmed !== "unknown") ||
      (parsed && parsed.rest === "main" && canonicalMainKey !== "main")
    ) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${trimmed || row.session_key}`,
      );
    }
    for (const lineageKey of [
      row.parent_session_key,
      row.spawned_by,
      row.fork_source_session_key,
    ]) {
      if (!lineageKey) {
        continue;
      }
      const normalized = normalizeStoreSessionKey(lineageKey);
      const lineageParsed = parseAgentSessionKey(normalized);
      if (
        normalized !== lineageKey ||
        (!lineageParsed && normalized !== "global" && normalized !== "unknown") ||
        (lineageParsed?.rest === "main" && canonicalMainKey !== "main")
      ) {
        throw canonicalSessionKeyMigrationRequiredError(
          `non-canonical persisted row resolves to session key ${normalized || lineageKey}`,
        );
      }
    }
    visit?.({ entry, sessionKey: row.session_key });
    count += 1;
  }
  validatedDatabases.add(database.db);
  return count;
}

export function assertCanonicalSqliteSessionKeysCurrent(
  database: { agentId: string; db: DatabaseSync },
  mainKey?: string,
): void {
  if (!validatedDatabases.has(database.db)) {
    scanCanonicalSqliteSessionEntries(database, undefined, mainKey);
  }
}

export function setCanonicalSqliteSessionMainKey(
  database: { db: DatabaseSync },
  mainKey: string | undefined,
): void {
  const canonicalMainKey = normalizeMainKey(mainKey);
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  const currentMainKey = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
  )?.main_key;
  if (currentMainKey === canonicalMainKey) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_key_contract")
      .values({ id: 1, main_key: canonicalMainKey, updated_at: Date.now() })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          main_key: canonicalMainKey,
          updated_at: Date.now(),
        }),
      ),
  );
  validatedDatabases.delete(database.db);
}

/** Checks the startup contract without joining the writable database lifecycle. */
export function isCanonicalSqliteSessionMainKeyCurrent(
  options: OpenClawAgentDatabaseOptions,
  mainKey: string | undefined,
): boolean {
  const canonicalMainKey = normalizeMainKey(mainKey);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
    const schema = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("schema_meta").select("schema_version").where("meta_key", "=", "primary"),
    );
    if (schema?.schema_version !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      return false;
    }
    return (
      executeSqliteQueryTakeFirstSync(
        database.db,
        db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
      )?.main_key === canonicalMainKey
    );
  }, options);
  return result.found && result.value;
}
