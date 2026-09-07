import { clearSessionProgressCardForReset } from "../../session-cards/progress-card-store.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionResetBoundaryWrite } from "./session-accessor.lifecycle-types.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  appendTranscriptEventsInTransaction,
  ensureTranscriptHeader,
} from "./session-accessor.sqlite-transcript-store.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";
import { resolveResetBoundaryHeaderCwd } from "./transcript-header.js";
import type { InternalSessionEntry } from "./types.js";

/** Transcript reset and prior-task retirement share the owning guarded transaction. */
export function appendSessionResetBoundary(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  previousEntry: InternalSessionEntry,
  boundary: SessionResetBoundaryWrite,
): void {
  // Reset may be the first append; a headerless window cannot be read on the next turn.
  ensureTranscriptHeader(
    database,
    scope,
    resolveResetBoundaryHeaderCwd(previousEntry, boundary.cwd),
  );
  const event = buildSessionResetBoundaryEvent({
    events: loadTranscriptEventsFromDatabase(database, scope.sessionId, {
      projection: "reset-boundary",
    }),
    ...boundary,
  });
  if (appendTranscriptEventsInTransaction(database, scope, [event]) !== 1) {
    throw new Error("Failed to append reset boundary for " + scope.sessionKey);
  }
  if (
    boundary.context === "clear" &&
    clearSessionProgressCardForReset(database.db, scope.sessionKey)
  ) {
    const { agentId, sessionKey } = scope;
    deferOpenClawAgentPostCommitPublication(database, () => {
      emitSessionLifecycleEvent({ agentId, sessionKey, reason: "progress-card-reset" });
    });
  }
}
