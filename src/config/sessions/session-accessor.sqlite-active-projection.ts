import type { TranscriptDisplayPosition } from "../../chat/transcript-display-position.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { hasUnclassifiedSessionTranscriptEvents } from "./session-transcript-projection-rebuild.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

type ActiveTranscriptDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  | "session_transcript_active_events"
  | "transcript_rewrite_watermarks"
  | "session_transcript_index_state"
  | "transcript_event_identities"
  | "transcript_events"
>;

type TranscriptReadDatabase = Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">;

export type CurrentTranscriptProjection = {
  database: TranscriptReadDatabase;
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>;
  state: SessionTranscriptProjectionState;
};

export type SessionTranscriptMessageEvent = {
  event: TranscriptEvent;
  eventSeq: number;
  seq: number;
  displayPosition?: TranscriptDisplayPosition;
};

const EMPTY_PROJECTION_STATE: SessionTranscriptProjectionState = {
  activeEventCount: 0,
  activeMessageCount: 0,
  indexedSeq: -1,
  leafEventId: null,
  needsRebuild: false,
};

export function getActiveTranscriptKysely(database: TranscriptReadDatabase) {
  return getNodeSqliteKysely<ActiveTranscriptDatabase>(database.db);
}

export function parseActiveTranscriptMessageRow(row: {
  event_seq: number;
  event_json: string;
  message_position: number | null;
}): SessionTranscriptMessageEvent {
  if (row.message_position === null) {
    throw new Error("Active transcript message row is missing its message position");
  }
  return {
    // SAFETY: The active projection indexes serialized TranscriptEvent rows.
    event: JSON.parse(row.event_json) as TranscriptEvent,
    eventSeq: row.event_seq,
    // Gateway cursors use the visible-message ordinal, matching the JSONL index.
    // Raw event seq includes headers/control rows and would make pages overlap.
    seq: row.message_position + 1,
  };
}

export function readTranscriptProjectionGeneration(
  projection: CurrentTranscriptProjection,
): string | undefined {
  return executeSqliteQueryTakeFirstSync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", projection.resolved.sessionId),
  )?.generation;
}

function readProjectionSnapshot(
  database: TranscriptReadDatabase,
  sessionId: string,
): { latestSeq: number; state?: SessionTranscriptProjectionState } | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getActiveTranscriptKysely(database)
      .selectFrom("transcript_events as latest")
      .leftJoin("session_transcript_index_state as state", "state.session_id", "latest.session_id")
      .select([
        "latest.seq as latest_seq",
        "state.active_event_count",
        "state.active_message_count",
        "state.indexed_seq",
        "state.leaf_event_id",
        "state.needs_rebuild",
      ])
      .where("latest.session_id", "=", sessionId)
      .orderBy("latest.seq", "desc")
      .limit(1),
  );
  if (!row) {
    return undefined;
  }
  return {
    latestSeq: row.latest_seq,
    ...(typeof row.indexed_seq === "number"
      ? {
          state: {
            activeEventCount: row.active_event_count ?? 0,
            activeMessageCount: row.active_message_count ?? 0,
            indexedSeq: row.indexed_seq,
            leafEventId: row.leaf_event_id,
            needsRebuild: row.needs_rebuild !== 0,
          },
        }
      : {}),
  };
}

export function withCurrentProjectionSnapshot<T>(
  scope: SessionTranscriptReadScope,
  read: (projection: CurrentTranscriptProjection) => T,
  options: { readOnly?: boolean } = {},
): T {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const readSnapshot = (database: TranscriptReadDatabase) =>
    runSqliteDeferredTransactionSync(
      database.db,
      () => {
        const snapshot = readProjectionSnapshot(database, resolved.sessionId);
        if (!snapshot) {
          return {
            kind: "value" as const,
            value: read({ database, resolved, state: EMPTY_PROJECTION_STATE }),
          };
        }
        if (
          snapshot.state &&
          !snapshot.state.needsRebuild &&
          snapshot.state.indexedSeq === snapshot.latestSeq &&
          !hasUnclassifiedSessionTranscriptEvents(database.db, resolved.sessionId)
        ) {
          return {
            kind: "value" as const,
            value: read({ database, resolved, state: snapshot.state }),
          };
        }
        return { kind: "unavailable" as const };
      },
      {
        databaseLabel: database.path,
        operationLabel: "sessions.history.read",
      },
    );
  const result = options.readOnly
    ? withOpenClawAgentDatabaseReadOnly(readSnapshot, databaseOptions, {
        throwOnMissingTable: true,
      })
    : { found: true as const, value: readSnapshot(openOpenClawAgentDatabase(databaseOptions)) };
  if (!result.found) {
    throw new Error(
      "Session transcript storage is unavailable; open the source gateway and retry.",
    );
  }
  if (result.value.kind === "value") {
    return result.value.value;
  }
  // Only the writer lifecycle may rebuild after this stack unwinds. Read-only catalogs
  // report unavailable and leave reconciliation to the source Gateway.
  if (!options.readOnly) {
    startSessionTranscriptIndexReconcile({
      ...databaseOptions,
      preferredSessionId: resolved.sessionId,
    });
  }
  throw new SessionTranscriptProjectionUnavailableError(resolved.sessionId);
}
