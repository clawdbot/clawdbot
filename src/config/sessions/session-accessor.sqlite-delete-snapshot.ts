import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";

export function sqliteSessionStateDeleteSnapshotsEqual(
  left: SessionStateDeleteSnapshot,
  right: SessionStateDeleteSnapshot,
): boolean {
  return (
    left.acpParentStreamEventCount === right.acpParentStreamEventCount &&
    left.generation === right.generation &&
    left.lastSeq === right.lastSeq &&
    left.sessionKey === right.sessionKey &&
    left.sessionUpdatedAt === right.sessionUpdatedAt &&
    left.trajectoryLastSeq === right.trajectoryLastSeq &&
    left.transcriptUpdatedAt === right.transcriptUpdatedAt
  );
}

type SessionStateDeleteSnapshotDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "acp_parent_stream_events"
  | "session_windows"
  | "trajectory_runtime_events"
  | "transcript_events"
  | "transcript_rewrite_watermarks"
>;

/** Captures the owner window and canonical child state writable outside the lifecycle queue. */
export function readSessionStateDeleteSnapshot(
  database: import("node:sqlite").DatabaseSync,
  sessionId: string,
): SessionStateDeleteSnapshot {
  const db = getNodeSqliteKysely<SessionStateDeleteSnapshotDatabase>(database);
  const window = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("session_windows")
      .select(["session_key", "transcript_updated_at", "updated_at"])
      .where("session_id", "=", sessionId),
  );
  const rewriteWatermark = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", sessionId),
  );
  const lastEvent = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("transcript_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  const lastTrajectory = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("trajectory_runtime_events")
      .select("seq")
      .where("session_id", "=", sessionId)
      .orderBy("seq", "desc")
      .limit(1),
  );
  const acpParentStream = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("acp_parent_stream_events")
      .select((eb) => eb.fn.countAll<number | bigint>().as("event_count"))
      .where("session_id", "=", sessionId),
  );
  return {
    acpParentStreamEventCount: sqliteNumber(acpParentStream?.event_count ?? 0),
    generation: rewriteWatermark?.generation ?? null,
    lastSeq: lastEvent?.seq ?? null,
    sessionKey: window?.session_key ?? null,
    sessionUpdatedAt: window?.updated_at ?? null,
    trajectoryLastSeq: lastTrajectory?.seq ?? null,
    transcriptUpdatedAt: window?.transcript_updated_at ?? null,
  };
}
