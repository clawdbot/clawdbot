// Records the canonical interrupted terminal event for sessions whose state
// owner marks them aborted outside the normal attempt-settle path (restart
// markers, force-cleared runs, admitted-recovery restorations). Callers must
// only invoke this after their state transition has committed, so a failed
// transition never fabricates one.
//
// Callers inside a session SQLite write transaction must pre-resolve the
// physical trajectory database target (agentDatabasePath + agentDatabaseAgentId)
// before BEGIN and pass it here, so filesystem and registry inspection does not
// extend the critical section or roll back an otherwise valid state mutation.
import { appendSqliteTrajectoryRuntimeEvents } from "./runtime-store.sqlite.js";
import { sanitizeTrajectoryPayload } from "./runtime.js";
import type { TrajectoryEvent } from "./types.js";

function buildInterruptedSessionTrajectoryEvent(params: {
  reason?: string;
  runId?: string;
  sessionId: string;
  sessionKey: string;
}): TrajectoryEvent {
  const data = sanitizeTrajectoryPayload({
    status: "interrupted",
    aborted: true,
    ...(params.reason ? { reason: params.reason } : {}),
  });
  const now = new Date();
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: params.sessionId,
    source: "runtime",
    type: "session.ended",
    ts: now.toISOString(),
    seq: 0,
    sourceSeq: 0,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runId: params.runId,
    data,
  };
}

/**
 * Synchronously appends the interrupted terminal event inside an already-open
 * session/trajectory SQLite write transaction. Use this when the event must be
 * atomic with the state transition that produced it.
 *
 * Callers inside a session write transaction must supply
 * `agentDatabasePath`/`agentDatabaseAgentId` resolved before the transaction
 * began, so target discovery does not run while the session write lock is held.
 * The event's `sessionKey`/`sessionId`/`runId` still describe the logical
 * session row; the database target is purely the physical owner of the SQLite
 * file that should receive the event.
 */
export function appendInterruptedSessionTrajectoryEndSync(params: {
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  agentId?: string;
  runId?: string;
  reason?: string;
  agentDatabasePath?: string;
  agentDatabaseAgentId?: string;
}): void {
  const agentId = params.agentDatabaseAgentId ?? params.agentId;
  if (!agentId) {
    return;
  }
  appendSqliteTrajectoryRuntimeEvents(
    {
      agentId,
      agentDatabasePath: params.agentDatabasePath,
      env: params.env ?? process.env,
      sessionId: params.sessionId,
      storePath: params.storePath,
    },
    [buildInterruptedSessionTrajectoryEvent(params)],
  );
}
