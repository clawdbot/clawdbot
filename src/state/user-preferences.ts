import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import {
  USER_PREFS_ENTRY_LIMIT,
  USER_PREFS_PROFILE_KEY_LIMIT,
  USER_PREFS_VALUE_BYTES,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

type UserPreferencesDatabase = Pick<OpenClawStateKyselyDatabase, "user_preferences">;

const ensuredDatabases = new WeakSet<DatabaseSync>();
const USER_PREFERENCES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_preferences (
  profile_id TEXT NOT NULL,
  pref_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at_ms INT NOT NULL,
  PRIMARY KEY (profile_id, pref_key)
) STRICT;
`;

type UserPreferenceError =
  | { code: "invalid-entry-count" }
  | { code: "invalid-key" | "invalid-value" | "value-too-large"; key: string }
  | {
      code: "profile-key-limit";
      limit: number;
      currentCount: number;
    };

export function ensureUserPreferencesSchema(options: OpenClawStateDatabaseOptions = {}): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- feature-local additive schema DDL; preference rows use Kysely below.
      db.exec(USER_PREFERENCES_SCHEMA_SQL);
    },
    options,
    { operationLabel: "users.preferences.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

export function mutateUserPreference(
  database: DatabaseSync,
  profileId: string,
  key: string,
  value?: boolean,
): void {
  const db = getNodeSqliteKysely<UserPreferencesDatabase>(database);
  if (value === undefined) {
    if (tableExists(database, "user_preferences")) {
      executeSqliteQuerySync(
        database,
        db
          .deleteFrom("user_preferences")
          .where("profile_id", "=", profileId)
          .where("pref_key", "=", key),
      );
    }
    return;
  }
  const updatedAtMs = Date.now();
  const valueJson = JSON.stringify(value);
  executeSqliteQuerySync(
    database,
    db
      .insertInto("user_preferences")
      .values({
        profile_id: profileId,
        pref_key: key,
        value_json: valueJson,
        updated_at_ms: updatedAtMs,
      })
      .onConflict((conflict) =>
        conflict.columns(["profile_id", "pref_key"]).doUpdateSet({
          value_json: valueJson,
          updated_at_ms: updatedAtMs,
        }),
      ),
  );
}

export function selectUserPreferenceValues(
  database: DatabaseSync,
  profileIds: readonly string[],
  key: string,
): Map<string, unknown> {
  if (profileIds.length === 0 || !tableExists(database, "user_preferences")) {
    return new Map();
  }
  const rows = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<UserPreferencesDatabase>(database)
      .selectFrom("user_preferences")
      .select(["profile_id", "value_json"])
      .where("profile_id", "in", [...profileIds])
      .where("pref_key", "=", key),
  ).rows;
  return new Map(
    rows.map((row) => [row.profile_id, JSON.parse(row.value_json) as unknown] as const),
  );
}

function openUserPreferencesDatabase(options: OpenClawStateDatabaseOptions = {}) {
  ensureUserPreferencesSchema(options);
  const state = openOpenClawStateDatabase(options);
  return { sqlite: state.db, kysely: getNodeSqliteKysely<UserPreferencesDatabase>(state.db) };
}

function readPreferenceKeys(database: DatabaseSync, profileId: string): Set<string> {
  const db = getNodeSqliteKysely<UserPreferencesDatabase>(database);
  return new Set(
    executeSqliteQuerySync(
      database,
      db.selectFrom("user_preferences").select("pref_key").where("profile_id", "=", profileId),
    ).rows.map((row) => row.pref_key),
  );
}

/** Moves one retired profile's preferences without overwriting the merge target's choices. */
export function mergeUserPreferences(
  database: DatabaseSync,
  sourceProfileId: string,
  targetProfileId: string,
): void {
  if (sourceProfileId === targetProfileId || !tableExists(database, "user_preferences")) {
    return;
  }
  const db = getNodeSqliteKysely<UserPreferencesDatabase>(database);
  const targetKeys = readPreferenceKeys(database, targetProfileId);
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("user_preferences")
      .selectAll()
      .where("profile_id", "=", sourceProfileId)
      .orderBy("pref_key", "asc"),
  ).rows;
  for (const row of rows) {
    if (targetKeys.has(row.pref_key)) {
      continue;
    }
    if (targetKeys.size >= USER_PREFS_PROFILE_KEY_LIMIT) {
      break;
    }
    executeSqliteQuerySync(
      database,
      db
        .insertInto("user_preferences")
        .values({ ...row, profile_id: targetProfileId })
        .onConflict((conflict) => conflict.columns(["profile_id", "pref_key"]).doNothing()),
    );
    targetKeys.add(row.pref_key);
  }
  executeSqliteQuerySync(
    database,
    db.deleteFrom("user_preferences").where("profile_id", "=", sourceProfileId),
  );
}

export function getUserPreferences(
  profileId: string,
  keys?: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): Record<string, unknown> {
  if (keys?.length === 0) {
    return {};
  }
  const { sqlite, kysely } = openUserPreferencesDatabase(options);
  let query = kysely
    .selectFrom("user_preferences")
    .select(["pref_key", "value_json"])
    .where("profile_id", "=", profileId)
    .orderBy("pref_key", "asc");
  if (keys) {
    query = query.where("pref_key", "in", [...keys]);
  }
  return Object.fromEntries(
    executeSqliteQuerySync(sqlite, query).rows.map((row) => [
      row.pref_key,
      JSON.parse(row.value_json) as unknown,
    ]),
  );
}

export function setUserPreferences(
  profileId: string,
  entries: Record<string, unknown>,
  options: OpenClawStateDatabaseOptions = {},
): Result<void, UserPreferenceError> {
  const rawEntries = Object.entries(entries);
  if (rawEntries.length > USER_PREFS_ENTRY_LIMIT) {
    return err({ code: "invalid-entry-count" });
  }
  const serialized: Array<{ prefKey: string; valueJson: string }> = [];
  const deletionKeys: string[] = [];
  for (const [prefKey, value] of rawEntries) {
    if (!prefKey || prefKey.length > 256) {
      return err({ code: "invalid-key", key: prefKey });
    }
    // JSON null is the additive removal form for this record-shaped RPC.
    if (value === null) {
      deletionKeys.push(prefKey);
      continue;
    }
    let valueJson: string | undefined;
    try {
      valueJson = JSON.stringify(value);
    } catch {
      return err({ code: "invalid-value", key: prefKey });
    }
    if (valueJson === undefined) {
      return err({ code: "invalid-value", key: prefKey });
    }
    if (Buffer.byteLength(valueJson, "utf8") > USER_PREFS_VALUE_BYTES) {
      return err({ code: "value-too-large", key: prefKey });
    }
    serialized.push({ prefKey, valueJson });
  }
  if (serialized.length === 0 && deletionKeys.length === 0) {
    return ok(undefined);
  }
  ensureUserPreferencesSchema(options);
  return runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      const db = getNodeSqliteKysely<UserPreferencesDatabase>(sqlite);
      const currentKeys = readPreferenceKeys(sqlite, profileId);
      const nextKeys = new Set(currentKeys);
      deletionKeys.forEach((key) => nextKeys.delete(key));
      serialized.forEach((entry) => nextKeys.add(entry.prefKey));
      if (serialized.length > 0 && nextKeys.size > USER_PREFS_PROFILE_KEY_LIMIT) {
        return err({
          code: "profile-key-limit",
          limit: USER_PREFS_PROFILE_KEY_LIMIT,
          currentCount: currentKeys.size,
        });
      }
      if (deletionKeys.length > 0) {
        executeSqliteQuerySync(
          sqlite,
          db
            .deleteFrom("user_preferences")
            .where("profile_id", "=", profileId)
            .where("pref_key", "in", deletionKeys),
        );
      }
      const updatedAtMs = Date.now();
      for (const entry of serialized) {
        executeSqliteQuerySync(
          sqlite,
          db
            .insertInto("user_preferences")
            .values({
              profile_id: profileId,
              pref_key: entry.prefKey,
              value_json: entry.valueJson,
              updated_at_ms: updatedAtMs,
            })
            .onConflict((conflict) =>
              conflict.columns(["profile_id", "pref_key"]).doUpdateSet({
                value_json: entry.valueJson,
                updated_at_ms: updatedAtMs,
              }),
            ),
        );
      }
      return ok(undefined);
    },
    options,
    { operationLabel: "users.preferences.set" },
  );
}
