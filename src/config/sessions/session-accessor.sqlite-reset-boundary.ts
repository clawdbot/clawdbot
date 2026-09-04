import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  buildSessionResetBoundaryEvent,
  type SessionResetBoundaryRequest,
} from "./session-reset-boundary-event.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";

function hasStoredTranscriptEvents(database: OpenClawAgentDatabase, sessionId: string): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select("seq")
        .where("session_id", "=", sessionId)
        .limit(1),
    ),
  );
}

/**
 * Appends a reset boundary, prepending a canonical session header only when
 * the transcript is empty. Fresh /new resets otherwise persist the reset as
 * seq 0 and later turns fail the runtime legacy-transcript assertion.
 * Nonempty headerless transcripts stay headerless so doctor can rewrite the
 * header at seq 0.
 */
export function appendSessionResetBoundaryEventsInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  request: SessionResetBoundaryRequest,
  options: { cwd?: string } = {},
): number {
  const events = loadTranscriptEventsFromDatabase(database, scope.sessionId, {
    projection: "reset-boundary",
  });
  const event = buildSessionResetBoundaryEvent({
    events,
    ...request,
  });
  // Only physically empty transcripts need a header here. Reset-boundary
  // projection can hide existing rows, and a nonempty headerless transcript
  // must stay headerless so doctor can rewrite the header at seq 0. Probe
  // seq existence instead of hydrating stored payloads.
  const batch = hasStoredTranscriptEvents(database, scope.sessionId)
    ? [event]
    : [createSessionTranscriptHeader({ cwd: options.cwd, sessionId: scope.sessionId }), event];
  const appended = appendTranscriptEventsInTransaction(database, scope, batch);
  if (appended !== batch.length) {
    throw new Error(`Failed to append reset boundary for ${scope.sessionKey}`);
  }
  return appended;
}
