import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventsInTransaction,
  ensureTranscriptHeader,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  buildSessionResetBoundaryEvent,
  type SessionResetBoundaryRequest,
} from "./session-reset-boundary-event.js";

/**
 * Appends a reset boundary inside the caller's write transaction. A fresh
 * /new on a session with no stored rows otherwise persists the reset as seq 0
 * and later turns fail the runtime legacy-transcript assertion, so the
 * canonical header initializer runs first. It only writes when the transcript
 * is physically empty, which keeps nonempty headerless transcripts headerless
 * so doctor can still rewrite the header at seq 0.
 */
export function appendSessionResetBoundaryEventsInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  request: SessionResetBoundaryRequest,
  options: { cwd?: string } = {},
): number {
  const event = buildSessionResetBoundaryEvent({
    events: loadTranscriptEventsFromDatabase(database, scope.sessionId, {
      projection: "reset-boundary",
    }),
    ...request,
  });
  ensureTranscriptHeader(database, scope, options.cwd);
  const appended = appendTranscriptEventsInTransaction(database, scope, [event]);
  if (appended !== 1) {
    throw new Error(`Failed to append reset boundary for ${scope.sessionKey}`);
  }
  return appended;
}
