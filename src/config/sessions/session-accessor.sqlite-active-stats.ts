import { sql } from "kysely";
import type { SessionReplayWindow } from "../../../packages/agent-core/src/harness/session/session.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

type ActiveStatsDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_active_events" | "transcript_events"
>;

function getActiveStatsKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<ActiveStatsDatabase>(database.db);
}

export function readActiveTranscriptStats(
  database: OpenClawAgentDatabase,
  sessionId: string,
): { eventCount: number; sizeBytes: number } {
  const db = getActiveStatsKysely(database);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select((eb) => [
        eb.fn.count<number>("active.event_seq").as("event_count"),
        /* kysely-allow-raw: JSONL size includes one terminating newline per event. */
        sql<number>`COALESCE(SUM(LENGTH(CAST(event.event_json AS BLOB))), 0)
          + COUNT(*)`.as("size_bytes"),
      ])
      .where("active.session_id", "=", sessionId),
  );
  return {
    eventCount: row?.event_count ?? 0,
    sizeBytes: row?.size_bytes ?? 0,
  };
}

export function readActiveTranscriptReplayByteSize(
  database: OpenClawAgentDatabase,
  sessionId: string,
  window: SessionReplayWindow | null,
): number {
  const db = getActiveStatsKysely(database);
  let query = db
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select(
      /* kysely-allow-raw: JSONL size includes one terminating newline per replayed event. */
      sql<number>`COALESCE(SUM(LENGTH(CAST(event.event_json AS BLOB))), 0)
        + COUNT(*)`.as("size_bytes"),
    )
    .where("active.session_id", "=", sessionId);
  if (window?.boundaryType === "reset") {
    // Reset's retained tail intentionally replays only user and assistant rows;
    // post-boundary entries retain their normal richer replay semantics.
    query = query.where(
      /* kysely-allow-raw: Reset replay combines position ranges with a JSON message-role predicate. */
      sql<boolean>`(
        active.active_position >= ${window.postBoundaryPosition}
        OR (
          active.active_position >= ${window.retainedStartPosition}
          AND active.active_position < ${window.boundaryPosition}
          AND json_extract(event.event_json, '$.message.role') IN ('user', 'assistant')
        )
      )`,
    );
  } else if (window) {
    query = query.where("active.active_position", ">=", window.retainedStartPosition);
  }
  return executeSqliteQueryTakeFirstSync(database.db, query)?.size_bytes ?? 0;
}
