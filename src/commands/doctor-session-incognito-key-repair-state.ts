import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export type ReservedKeyRename = { from: string; to: string };

const REPAIR_JOURNAL_SCOPE = "doctor-session-key-migration";
const REPAIR_JOURNAL_KEY = "reserved-incognito-v1";

type SharedStateSessionKeyColumn = {
  column: string;
  json: boolean;
  table: string;
};

type SharedStateSchemaDatabase = {
  sqlite_schema: { name: string; type: string };
};

type DynamicSharedStateDatabase = Record<string, Record<string, unknown>>;

function sqliteSchemaIdentifier(value: string) {
  return sql.id(value); // kysely-allow-raw -- value comes only from SQLite schema metadata.
}

// Shared state has many owner-specific session-key columns; schema discovery keeps this migration complete.
function listSharedStateSessionKeyColumns(database: DatabaseSync): SharedStateSessionKeyColumn[] {
  const db = getNodeSqliteKysely<SharedStateSchemaDatabase>(database);
  const tables = executeSqliteQuerySync(
    database,
    db
      .selectFrom("sqlite_schema")
      .select("name")
      .where("type", "=", "table")
      .where("name", "not like", "sqlite_%"),
  ).rows;
  return tables.flatMap(({ name: table }) => {
    const columns = executeSqliteQuerySync(
      database,
      db
        .selectFrom(sql`pragma_table_info(${table})`.as("pragma_columns"))
        .select(sql`name`.as("name")),
    ).rows as Array<{ name: string }>;
    return columns.flatMap(({ name: column }): SharedStateSessionKeyColumn[] => {
      if (column === "session_key" || column.endsWith("_session_key")) {
        return [{ table, column, json: false }];
      }
      return column.endsWith("_session_keys_json") ? [{ table, column, json: true }] : [];
    });
  });
}

export function collectSharedStateSessionKeys(database: DatabaseSync): Set<string> {
  const db = getNodeSqliteKysely<DynamicSharedStateDatabase>(database);
  const keys = new Set<string>();
  for (const { table, column, json } of listSharedStateSessionKeyColumns(database)) {
    const columnId = sqliteSchemaIdentifier(column);
    const rows = executeSqliteQuerySync(
      database,
      db
        .selectFrom(sql`${sqliteSchemaIdentifier(table)}`.as("session_key_table"))
        .select(columnId.as("value"))
        .where(columnId, "is not", null),
    ).rows as Array<{ value: unknown }>;
    for (const { value } of rows) {
      if (!json && typeof value === "string") {
        keys.add(value);
      } else if (json && typeof value === "string") {
        try {
          collectJsonStringValues(JSON.parse(value), keys);
        } catch {
          // Existing integrity checks own malformed shared-state JSON.
        }
      }
    }
  }
  return keys;
}

export function rewriteSharedStateSessionKeys(
  database: DatabaseSync,
  renames: ReadonlyMap<string, string>,
): void {
  const db = getNodeSqliteKysely<DynamicSharedStateDatabase>(database);
  const rowId = sql`rowid`;
  for (const { table, column, json } of listSharedStateSessionKeyColumns(database)) {
    const tableId = sqliteSchemaIdentifier(table);
    const columnId = sqliteSchemaIdentifier(column);
    if (!json) {
      for (const [from, to] of renames) {
        executeSqliteQuerySync(
          database,
          db
            .updateTable(sql`${tableId}`.as("session_key_table"))
            .set(columnId, to)
            .where(columnId, "=", from),
        );
      }
      continue;
    }
    const rows = executeSqliteQuerySync(
      database,
      db
        .selectFrom(sql`${tableId}`.as("session_key_table"))
        .select([rowId.as("rowid"), columnId.as("value")]),
    ).rows as Array<{ rowid: number | bigint; value: unknown }>;
    for (const row of rows) {
      if (typeof row.value !== "string") {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        continue;
      }
      const rewritten = JSON.stringify(replaceSessionKeyReferences(parsed, renames));
      if (rewritten !== row.value) {
        executeSqliteQuerySync(
          database,
          db
            .updateTable(sql`${tableId}`.as("session_key_table"))
            .set(columnId, rewritten)
            .where(rowId, "=", row.rowid),
        );
      }
    }
  }
}

function collectJsonStringValues(value: unknown, values: Set<string>): void {
  if (typeof value === "string") {
    values.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonStringValues(item, values);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const item of Object.values(value)) {
    collectJsonStringValues(item, values);
  }
}

export function readRepairJournal(database: DatabaseSync): ReservedKeyRename[] {
  const db = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "state_leases">>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("state_leases")
      .select("payload_json")
      .where("scope", "=", REPAIR_JOURNAL_SCOPE)
      .where("lease_key", "=", REPAIR_JOURNAL_KEY),
  );
  if (!row?.payload_json) {
    return [];
  }
  const parsed = JSON.parse(row.payload_json) as { renames?: unknown; version?: unknown };
  if (parsed.version !== 1 || !Array.isArray(parsed.renames)) {
    throw new Error("Invalid reserved incognito session key repair journal");
  }
  return parsed.renames.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof (item as { from?: unknown }).from !== "string" ||
      typeof (item as { to?: unknown }).to !== "string"
    ) {
      throw new Error("Invalid reserved incognito session key repair journal entry");
    }
    return { from: (item as { from: string }).from, to: (item as { to: string }).to };
  });
}

export function readRepairJournalReadOnly(env: NodeJS.ProcessEnv): ReservedKeyRename[] {
  const statePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(statePath)) {
    return [];
  }
  return withOpenClawStateDatabaseReadOnly((database) => readRepairJournal(database.db), {
    env,
    path: statePath,
  });
}

export function writeRepairJournal(
  database: DatabaseSync,
  renames: readonly ReservedKeyRename[],
): void {
  const now = Date.now();
  const db = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "state_leases">>(database);
  executeSqliteQuerySync(
    database,
    db
      .insertInto("state_leases")
      .values({
        scope: REPAIR_JOURNAL_SCOPE,
        lease_key: REPAIR_JOURNAL_KEY,
        owner: "openclaw-doctor",
        expires_at: null,
        heartbeat_at: null,
        payload_json: JSON.stringify({ version: 1, renames }),
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["scope", "lease_key"]).doUpdateSet({
          owner: "openclaw-doctor",
          payload_json: JSON.stringify({ version: 1, renames }),
          updated_at: now,
        }),
      ),
  );
}

export function deleteRepairJournal(database: DatabaseSync): void {
  const db = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "state_leases">>(database);
  executeSqliteQuerySync(
    database,
    db
      .deleteFrom("state_leases")
      .where("scope", "=", REPAIR_JOURNAL_SCOPE)
      .where("lease_key", "=", REPAIR_JOURNAL_KEY),
  );
}

function replaceSessionKeyReferences(
  value: unknown,
  renames: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    return renames.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceSessionKeyReferences(item, renames));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replaceSessionKeyReferences(item, renames)]),
  );
}
