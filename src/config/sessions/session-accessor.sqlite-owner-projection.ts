import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type { SessionActor } from "./session-entry-provenance.js";
import type { SessionEntry } from "./types.js";

export type SqliteSessionOwnerRow = {
  owner_actor_type?: string | null;
  owner_actor_id?: string | null;
  owner_assigned_by_type?: string | null;
  owner_assigned_by_id?: string | null;
  owner_assigned_at?: number | null;
};

const ownerColumnAvailability = new WeakMap<
  DatabaseSync,
  { available: boolean; schemaVersion: number }
>();

function actorFromColumns(type: unknown, id: unknown): SessionActor | undefined {
  const normalizedType = type === "human" || type === "agent" || type === "system" ? type : null;
  const normalizedId = normalizeOptionalString(id);
  return normalizedType && normalizedId ? { type: normalizedType, id: normalizedId } : undefined;
}

export function projectSqliteSessionOwner(
  entry: SessionEntry,
  row: SqliteSessionOwnerRow,
): SessionEntry {
  const actor = actorFromColumns(row.owner_actor_type, row.owner_actor_id);
  if (!actor) {
    return entry;
  }
  const assignedBy = actorFromColumns(row.owner_assigned_by_type, row.owner_assigned_by_id);
  const assignedAt =
    typeof row.owner_assigned_at === "number" && Number.isFinite(row.owner_assigned_at)
      ? row.owner_assigned_at
      : undefined;
  return {
    ...entry,
    owner: {
      actor,
      ...(assignedBy ? { assignedBy } : {}),
      ...(assignedAt !== undefined ? { assignedAt } : {}),
    },
  };
}

export function hasSqliteSessionOwnerColumns(database: DatabaseSync): boolean {
  const db = getSessionKysely(database);
  const schema = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom(sql`pragma_schema_version`.as("pragma_schema"))
      .select(sql`schema_version`.as("schema_version")),
  );
  const schemaVersion = typeof schema?.schema_version === "number" ? schema.schema_version : -1;
  const cached = ownerColumnAvailability.get(database);
  if (cached?.schemaVersion === schemaVersion) {
    return cached.available;
  }
  const tableInfoRows = executeSqliteQuerySync(
    database,
    db
      .selectFrom(sql`pragma_table_info('session_nodes')`.as("pragma_columns"))
      .select(sql`name`.as("name")),
  ).rows;
  const columns = new Set(
    tableInfoRows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
  const available = FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS.every(({ columnName }) =>
    columns.has(columnName),
  );
  ownerColumnAvailability.set(database, { available, schemaVersion });
  return available;
}
