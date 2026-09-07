import { sql } from "kysely";
import { getSessionKysely } from "../../src/config/sessions/session-accessor.sqlite-scope.js";
import { executeSqliteQuerySync } from "../../src/infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../src/state/openclaw-agent-db.js";

export function readSessionStoreFingerprint(database: OpenClawAgentDatabase): string {
  const db = getSessionKysely(database.db);
  const nodes = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .select([
        "session_key",
        "current_session_id",
        "entry_json",
        "updated_at",
        "parent_session_key",
        "spawned_by",
        "fork_source_session_key",
        "fork_source_session_id",
        "last_read_at",
        "last_interaction_at",
        "last_activity_at",
        "pinned_at",
        "archived_at",
      ])
      .orderBy("session_key", "asc"),
  ).rows;
  const windows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select([
        "session_id",
        "session_key",
        "previous_session_id",
        "reason",
        "created_at",
        "updated_at",
        "transcript_updated_at",
        "parent_session_key",
        "spawned_by",
        "status",
      ])
      .orderBy("session_id", "asc"),
  ).rows;
  const transcriptEvents = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select([
        "session_id",
        (eb) => eb.fn.countAll<number | bigint>().as("event_count"),
        (eb) => eb.fn.max<number | bigint>("seq").as("max_seq"),
        /* kysely-allow-raw: compact mutation fingerprint without loading event payloads. */
        sql<number | bigint>`COALESCE(SUM(LENGTH(CAST(event_json AS BLOB))), 0)`.as(
          "event_json_bytes",
        ),
      ])
      .groupBy("session_id")
      .orderBy("session_id", "asc"),
  ).rows;
  const identities = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("transcript_event_identities")
      .select([
        "session_id",
        (eb) => eb.fn.countAll<number | bigint>().as("identity_count"),
        /* kysely-allow-raw: detect identity changes without materializing every identity. */
        sql<
          number | bigint
        >`COALESCE(SUM(LENGTH(event_id) + LENGTH(COALESCE(parent_id, ''))), 0)`.as(
          "identity_bytes",
        ),
      ])
      .groupBy("session_id")
      .orderBy("session_id", "asc"),
  ).rows;
  const archives = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_transcript_archives")
      .select([
        "session_id",
        "generation",
        "session_key",
        "reason",
        "encoding",
        "archive_sha256",
        "created_at",
        "published_at",
        "publish_attempts",
        "last_publish_attempt_at",
        "last_publish_error",
        "archive_name",
      ])
      .orderBy("session_id", "asc")
      .orderBy("generation", "asc"),
  ).rows;
  return JSON.stringify({ nodes, windows, transcriptEvents, identities, archives });
}
