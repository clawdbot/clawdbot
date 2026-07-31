import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
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
  "session_key_contract" | "session_nodes" | "session_windows"
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

export function assertCanonicalSqliteSessionKeysCurrent(
  database: { agentId: string; db: DatabaseSync },
  mainKey?: string,
): void {
  if (validatedDatabases.has(database.db)) {
    return;
  }
  // This connection validates once. External direct-SQLite edits surface at the next
  // process start, not the next topology change; doctor owns live repair.
  const db = getNodeSqliteKysely<CanonicalSessionDatabase>(database.db);
  const storedMainKey = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_key_contract").select("main_key").where("id", "=", 1),
  )?.main_key;
  const canonicalMainKey = normalizeMainKey(mainKey ?? storedMainKey);
  for (const row of executeSqliteQuerySync(
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
        "session_nodes.entry_json",
        "session_nodes.entry_valid",
        "session_nodes.fork_source_session_key",
        "session_nodes.parent_session_key",
        "session_nodes.spawned_by",
        "retained_window.session_id as retained_window_id",
      ]),
  ).rows) {
    if (
      row.entry_json === "{}" &&
      row.entry_valid === -1 &&
      row.retained_window_id === row.current_session_id
    ) {
      continue;
    }
    if (row.entry_valid !== 1) {
      throw canonicalSessionKeyMigrationRequiredError(
        `invalid persisted session row requires repair for ${row.session_key}`,
      );
    }
    const record = parseSqliteSessionEntryRecord(row);
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
  }
  validatedDatabases.add(database.db);
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
