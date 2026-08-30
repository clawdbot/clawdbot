import { requireNodeSqlite } from "./node-sqlite.js";

export function readDatabaseSnapshot(databasePath: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
    const rows = database
      .prepare(
        "SELECT session_id,seq,event_json,created_at FROM transcript_events ORDER BY session_id,seq",
      )
      .all() as Array<{
      session_id: string;
      seq: number;
      event_json: string;
      created_at: number;
    }>;
    const identities = database
      .prepare(
        "SELECT session_id,event_id,seq,event_type,parent_id,message_idempotency_key,created_at FROM transcript_event_identities ORDER BY session_id,seq",
      )
      .all();
    const activeBranch = database
      .prepare(
        "SELECT session_id,active_position,event_seq,message_position FROM session_transcript_active_events ORDER BY session_id,active_position",
      )
      .all();
    const windows = database
      .prepare(
        "SELECT session_id,session_key,created_at,updated_at,transcript_observed_at FROM session_windows ORDER BY session_id",
      )
      .all();
    const generations = database
      .prepare(
        "SELECT session_id,generation FROM transcript_rewrite_watermarks ORDER BY session_id",
      )
      .all();
    const trajectoryCount = database
      .prepare("SELECT count(*) AS count FROM trajectory_runtime_events")
      .get() as { count: number };
    const trajectoryRows = database
      .prepare(
        "SELECT session_id,seq,run_id,event_json,created_at FROM trajectory_runtime_events ORDER BY session_id,seq",
      )
      .all() as Array<{
      session_id: string;
      seq: number;
      run_id: string | null;
      event_json: string;
      created_at: number;
    }>;
    return {
      activeBranch,
      generations,
      identities,
      rows,
      trajectoryCount: trajectoryCount.count,
      trajectoryRows,
      version,
      windows,
    };
  } finally {
    database.close();
  }
}
