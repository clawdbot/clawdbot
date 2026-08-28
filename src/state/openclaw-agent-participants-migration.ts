import type { DatabaseSync } from "node:sqlite";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { sessionParticipantsSchemaSql } from "./openclaw-agent-session-participants-schema.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

const LEGACY_PARTICIPANTS_SCHEMA = `CREATE TABLE IF NOT EXISTS session_participants (
  session_key TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_source TEXT,
  contribution_count INTEGER,
  first_prompted_at INTEGER NOT NULL,
  last_prompted_at INTEGER NOT NULL,
  PRIMARY KEY (session_key, actor_type, actor_id),
  FOREIGN KEY (session_key) REFERENCES session_nodes(session_key) ON DELETE CASCADE
) STRICT;`;
const MIGRATION_TABLE = "session_participants_identity_migration";
export const LEGACY_PARTICIPANT_OPTIONAL_COLUMNS = [
  "session_participants.actor_source",
  "session_participants.contribution_count",
];

/** Historical structural/media validation must not require a future identity key. */
export function withLegacySessionParticipantsSchema(sql: string): string {
  return sql.replace(sessionParticipantsSchemaSql().trim(), LEGACY_PARTICIPANTS_SCHEMA);
}

export function hasLegacySessionParticipantsSchema(database: DatabaseSync): boolean {
  return (
    tableExists(database, "session_participants") &&
    tableHasColumn(database, "session_participants", "actor_type") &&
    !tableHasColumn(database, "session_participants", "identity_namespace")
  );
}

export function migrateSessionParticipantsSchema(database: DatabaseSync, pathname: string): void {
  if (
    !tableExists(database, "session_participants") ||
    tableHasColumn(database, "session_participants", "identity_namespace")
  ) {
    return;
  }
  assertSqliteSchemaContains(database, pathname, LEGACY_PARTICIPANTS_SCHEMA, {
    allowedMissingColumns: LEGACY_PARTICIPANT_OPTIONAL_COLUMNS,
  });
  if (tableExists(database, MIGRATION_TABLE)) {
    throw new Error(`Participant migration table already exists: ${MIGRATION_TABLE}`);
  }
  // Unknown database-local dependents cannot safely survive a destructive table rebuild.
  const dependencies = database // sqlite-allow-raw -- Inspect historical schema dependents before rebuilding.
    .prepare(`SELECT name FROM sqlite_schema
    WHERE (type IN ('trigger', 'index') AND tbl_name = 'session_participants' AND sql IS NOT NULL)
       OR (type IN ('view', 'trigger') AND sql LIKE '%session_participants%')`)
    .all();
  if (dependencies.length > 0) {
    throw new Error("Participant migration cannot rebuild unknown indexes, views, or triggers.");
  }
  for (const table of database // sqlite-allow-raw -- Enumerate historical tables before current Kysely schema exists.
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
    .all()) {
    const foreignKeys = database // sqlite-allow-raw -- PRAGMA requires a quoted database-owned table identifier.
      .prepare(`PRAGMA foreign_key_list("${String(table.name).replaceAll('"', '""')}")`)
      .all();
    if (foreignKeys.some((key) => key.table === "session_participants")) {
      throw new Error(
        "Participant migration cannot rebuild a table referenced by an unknown foreign key.",
      );
    }
  }
  const source = tableHasColumn(database, "session_participants", "actor_source")
    ? "actor_source"
    : "NULL";
  const count = tableHasColumn(database, "session_participants", "contribution_count")
    ? "coalesce(contribution_count, 1)"
    : "1";
  const knownAgent = `actor_type = 'agent' AND ${source} = 'agent' AND actor_id <> ''`;
  const knownObservation = `(${knownAgent}) OR (actor_type = 'human' AND ${source} = 'channel')`;
  // Profile-winning collisions destroyed time provenance, even when a count survived.
  // Keep membership/count, never fabricate the channel row that may have been overwritten.
  database.exec(/* sqlite-allow-raw -- Versioned table rebuild inside the maintenance owner's transaction. */ `
    ${sessionParticipantsSchemaSql().replace("IF NOT EXISTS session_participants", MIGRATION_TABLE)}
    INSERT INTO ${MIGRATION_TABLE}
      (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at)
    SELECT session_key,
      CASE
        WHEN actor_type = 'human' AND ${source} = 'profile' AND actor_id <> '' THEN json_object('type', 'profile')
        WHEN ${knownAgent} THEN json_object('type', 'agent')
        ELSE json_object('type', 'legacy', 'actorType', actor_type, 'source', ${source})
      END,
      actor_id, ${count},
      CASE WHEN ${knownObservation} THEN first_prompted_at ELSE NULL END,
      CASE WHEN ${knownObservation} THEN last_prompted_at ELSE NULL END
    FROM session_participants;
    DROP TABLE session_participants;
    ALTER TABLE ${MIGRATION_TABLE} RENAME TO session_participants;
  `);
}
