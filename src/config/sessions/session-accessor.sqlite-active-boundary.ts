import { sql } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

type ActiveBoundaryDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_active_events" | "transcript_event_identities" | "transcript_events"
>;

type ActiveBoundaryProjection = {
  database: OpenClawAgentDatabase;
  resolved: { sessionId: string };
};

type ActiveBoundaryEventType = "compaction" | "reset";

type SessionTranscriptActiveBoundary = {
  active_position: number;
  event_json: string;
  event_type: ActiveBoundaryEventType;
};

export type SessionTranscriptGuardState = { hasTranscriptEvents: boolean } & (
  | {
      kind: "empty";
      expectedEntryOnGuardPath: false;
      guardLeafEntryId: null;
    }
  | {
      kind: "identified";
      expectedEntryOnGuardPath: boolean;
      guardLeafEntryId: string;
    }
  | {
      kind: "unavailable";
      expectedEntryOnGuardPath: false;
      guardLeafEntryId: null;
    }
);

function getActiveBoundaryKysely(database: OpenClawAgentDatabase) {
  return getNodeSqliteKysely<ActiveBoundaryDatabase>(database.db);
}

function sqliteActiveBoundaryEventType() {
  return /* kysely-allow-raw: boundary type lives inside canonical transcript JSON. */ sql<string>`json_extract(event.event_json, '$.type')`;
}

export function findLatestSessionTranscriptActiveBoundary(
  projection: ActiveBoundaryProjection,
  eventTypes: readonly ActiveBoundaryEventType[],
): SessionTranscriptActiveBoundary | undefined {
  const db = getActiveBoundaryKysely(projection.database);
  // Persisted boundary rows can omit ids, so the identity index is incomplete.
  // Read the canonical event on the selected path or an upgrade can cross a reset.
  const row = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select([
        "active.active_position",
        "event.event_json",
        sqliteActiveBoundaryEventType().as("event_type"),
      ])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.message_position", "is", null)
      .where(sqliteActiveBoundaryEventType(), "in", eventTypes)
      .orderBy("active.active_position", "desc")
      .limit(1),
  );
  return row && (row.event_type === "reset" || row.event_type === "compaction")
    ? { ...row, event_type: row.event_type }
    : undefined;
}

function readSessionTranscriptEventExistence(projection: ActiveBoundaryProjection): boolean {
  // The guard distinguishes no transcript from an explicitly empty active path.
  // Callers hold the same read snapshot, so this fact cannot race the guard row.
  return (
    executeSqliteQueryTakeFirstSync(
      projection.database.db,
      getActiveBoundaryKysely(projection.database)
        .selectFrom("transcript_events")
        .select("seq")
        .where("session_id", "=", projection.resolved.sessionId)
        .limit(1),
    ) !== undefined
  );
}

/** Resolves the history/send guard from the logical selected active-event leaf. */
export function resolveSessionTranscriptGuardState(
  projection: ActiveBoundaryProjection,
  expectedEntryId?: string,
): SessionTranscriptGuardState {
  const db = getActiveBoundaryKysely(projection.database);
  const guardRow = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .leftJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
      .select("identity.event_id")
      .where("active.session_id", "=", projection.resolved.sessionId)
      .orderBy("active.active_position", "desc")
      .limit(1),
  );
  if (!guardRow) {
    return {
      kind: "empty",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId: null,
      hasTranscriptEvents: readSessionTranscriptEventExistence(projection),
    };
  }
  const hasTranscriptEvents = true;
  // The selected leaf is the final logical active row. Keep an identity gap
  // distinct from an empty branch so callers fail closed instead of accepting null.
  if (guardRow.event_id === null) {
    return {
      kind: "unavailable",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId: null,
      hasTranscriptEvents,
    };
  }
  const guardLeafEntryId = guardRow.event_id;
  if (!expectedEntryId) {
    return {
      kind: "identified",
      expectedEntryOnGuardPath: false,
      guardLeafEntryId,
      hasTranscriptEvents,
    };
  }
  const active = executeSqliteQueryTakeFirstSync(
    projection.database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("active.session_id", "=", "identity.session_id")
          .onRef("active.event_seq", "=", "identity.seq"),
      )
      .select("active.active_position")
      .where("identity.session_id", "=", projection.resolved.sessionId)
      .where("identity.event_id", "=", expectedEntryId)
      .limit(1),
  );
  const latestReset = findLatestSessionTranscriptActiveBoundary(projection, ["reset"]);
  return {
    kind: "identified",
    expectedEntryOnGuardPath:
      active !== undefined &&
      (latestReset === undefined || active.active_position >= latestReset.active_position),
    guardLeafEntryId,
    hasTranscriptEvents,
  };
}
