// Stuck session recovery runtime helpers inspect embedded sessions for recovery.
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import {
  abortAndDrainEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
} from "../agents/embedded-agent-runner/runs.js";
import {
  getCommandLaneActiveTaskIds,
  getCommandLaneSnapshot,
  resetCommandLane,
} from "../process/command-queue.js";
import { getDiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";
import {
  formatStoppedCronSessionDiagnosticFields,
  resolveCronSessionDiagnosticContext,
} from "./diagnostic-session-context.js";
import {
  formatRecoveryOutcome,
  resolveStuckSessionRecoveryRef,
  type StuckSessionRecoveryOutcome,
  type StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
import { isDiagnosticSessionStateCurrent } from "./diagnostic-session-state.js";

// Runtime repair path for diagnostic sessions that appear stuck in processing/waiting states.
const STUCK_SESSION_ABORT_SETTLE_MS = 15_000;
const STUCK_SESSION_PROGRESS_STALE_MS = 5 * 60_000;
// Ownerless lane release shares the no-progress abort floor, then extends for
// compaction because queued compaction owns the session lane without a run handle.
const STALE_ACTIVE_LANE_TASK_RELEASE_MS = STUCK_SESSION_PROGRESS_STALE_MS;
const recoveriesInFlight = new Set<string>();

/** Request parameters accepted by the stuck-session recovery runtime. */
type StuckSessionRecoveryParams = StuckSessionRecoveryRequest;

function resolveStaleActiveProgressAbortMs(params: StuckSessionRecoveryParams): number {
  const configured = params.staleActiveProgressAbortMs;
  return typeof configured === "number" && configured > 0
    ? configured
    : STUCK_SESSION_PROGRESS_STALE_MS;
}

function resolveStaleActiveLaneTaskReleaseMs(params: StuckSessionRecoveryParams): number {
  const compactionSafetyTimeoutMs = params.compactionSafetyTimeoutMs;
  const compactionReleaseMs =
    typeof compactionSafetyTimeoutMs === "number" && compactionSafetyTimeoutMs > 0
      ? compactionSafetyTimeoutMs + STUCK_SESSION_ABORT_SETTLE_MS
      : 0;
  return Math.max(STALE_ACTIVE_LANE_TASK_RELEASE_MS, compactionReleaseMs);
}

function isActiveRunProgressStale(params: {
  sessionId?: string;
  sessionKey?: string;
  queueDepth?: number;
  staleAbortMs: number;
}): boolean {
  if ((params.queueDepth ?? 0) <= 0) {
    return false;
  }
  const activity = getDiagnosticSessionActivitySnapshot({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  const lastProgressAgeMs = activity.lastProgressAgeMs;
  return typeof lastProgressAgeMs === "number" && lastProgressAgeMs >= params.staleAbortMs;
}

function formatRecoveryContext(
  params: StuckSessionRecoveryParams,
  extra?: { activeSessionId?: string; lane?: string; activeCount?: number; queuedCount?: number },
): string {
  const fields = [
    `sessionId=${params.sessionId ?? extra?.activeSessionId ?? "unknown"}`,
    `sessionKey=${params.sessionKey ?? "unknown"}`,
    `age=${Math.round(params.ageMs / 1000)}s`,
    `queueDepth=${params.queueDepth ?? 0}`,
  ];
  if (extra?.activeSessionId) {
    fields.push(`activeSessionId=${extra.activeSessionId}`);
  }
  if (extra?.lane) {
    fields.push(`lane=${extra.lane}`);
  }
  if (extra?.activeCount !== undefined) {
    fields.push(`laneActive=${extra.activeCount}`);
  }
  if (extra?.queuedCount !== undefined) {
    fields.push(`laneQueued=${extra.queuedCount}`);
  }
  return fields.join(" ");
}

export async function recoverStuckDiagnosticSession(
  params: StuckSessionRecoveryParams,
): Promise<StuckSessionRecoveryOutcome> {
  const key = resolveStuckSessionRecoveryRef(params);
  if (!key || recoveriesInFlight.has(key)) {
    return {
      status: "skipped",
      action: "observe_only",
      reason: key ? "already_in_flight" : "missing_session_ref",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    };
  }

  recoveriesInFlight.add(key);
  try {
    // Abort only the generation/state that triggered recovery; stale warnings become observe-only.
    if (
      !isDiagnosticSessionStateCurrent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        generation: params.stateGeneration,
        state: params.expectedState ?? "processing",
      })
    ) {
      return {
        status: "skipped",
        action: "observe_only",
        reason: "stale_session_state",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      };
    }
    const fallbackActiveSessionId =
      params.sessionId && isEmbeddedAgentRunHandleActive(params.sessionId)
        ? params.sessionId
        : undefined;
    const fileActiveSessionId = params.sessionFile
      ? resolveActiveEmbeddedRunHandleSessionIdBySessionFile(params.sessionFile)
      : undefined;
    let activeSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunHandleSessionId(params.sessionKey) ??
        fileActiveSessionId ??
        fallbackActiveSessionId)
      : (fileActiveSessionId ?? fallbackActiveSessionId);
    const fileActiveWorkSessionId = params.sessionFile
      ? resolveActiveEmbeddedRunSessionIdBySessionFile(params.sessionFile)
      : undefined;
    const activeWorkSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunSessionId(params.sessionKey) ??
        fileActiveWorkSessionId ??
        params.sessionId)
      : (fileActiveWorkSessionId ?? params.sessionId);
    const sessionLane = key ? resolveEmbeddedSessionLane(key) : null;
    const preAbortActiveTaskIds = new Set(
      sessionLane ? getCommandLaneActiveTaskIds(sessionLane) : [],
    );
    let aborted = false;
    let drained = true;
    let forceCleared = false;
    const staleActiveProgressAbortMs = resolveStaleActiveProgressAbortMs(params);
    const staleActiveLaneTaskReleaseMs = resolveStaleActiveLaneTaskReleaseMs(params);

    if (activeSessionId) {
      const reclaimStaleActiveRun =
        params.allowActiveAbort !== true &&
        isActiveRunProgressStale({
          sessionId: activeSessionId,
          sessionKey: params.sessionKey,
          queueDepth: params.queueDepth,
          staleAbortMs: staleActiveProgressAbortMs,
        });
      if (params.allowActiveAbort !== true && !reclaimStaleActiveRun) {
        const outcome: StuckSessionRecoveryOutcome = {
          status: "skipped",
          action: "observe_only",
          reason: "active_embedded_run",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          activeSessionId,
          activeWorkKind: "embedded_run",
        };
        diag.warn(
          `stuck session recovery skipped: ${formatRecoveryContext(params, { activeSessionId })}`,
        );
        diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
        return outcome;
      }
      if (reclaimStaleActiveRun) {
        diag.warn(
          `stuck session recovery reclaiming stale active run: ${formatRecoveryContext(params, { activeSessionId })}`,
        );
      }
      // Active embedded runs own their cleanup; registry terminal settle bounds
      // lane release if the owner never drains after this abort.
      const result = await abortAndDrainEmbeddedAgentRun({
        sessionId: activeSessionId,
        sessionKey: params.sessionKey,
        settleMs: STUCK_SESSION_ABORT_SETTLE_MS,
        forceClear: true,
        reason: "stuck_recovery",
      });
      aborted = result.aborted;
      drained = result.drained;
      forceCleared = result.forceCleared;
    }

    if (!activeSessionId && activeWorkSessionId && isEmbeddedAgentRunActive(activeWorkSessionId)) {
      const reclaimStaleReplyWork =
        params.allowActiveAbort !== true &&
        isActiveRunProgressStale({
          sessionId: activeWorkSessionId,
          sessionKey: params.sessionKey,
          queueDepth: params.queueDepth,
          staleAbortMs: staleActiveProgressAbortMs,
        });
      if (params.allowActiveAbort === true || reclaimStaleReplyWork) {
        if (reclaimStaleReplyWork) {
          diag.warn(
            `stuck session recovery reclaiming stale active reply work: ${formatRecoveryContext(
              params,
              { activeSessionId: activeWorkSessionId },
            )}`,
          );
        }
        const result = await abortAndDrainEmbeddedAgentRun({
          sessionId: activeWorkSessionId,
          sessionKey: params.sessionKey,
          settleMs: STUCK_SESSION_ABORT_SETTLE_MS,
          forceClear: true,
          reason: "stuck_recovery",
        });
        aborted = result.aborted;
        drained = result.drained;
        forceCleared = result.forceCleared;
        activeSessionId = activeWorkSessionId;
      } else {
        const outcome: StuckSessionRecoveryOutcome = {
          status: "skipped",
          action: "keep_lane",
          reason: "active_reply_work",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          activeSessionId: activeWorkSessionId,
          activeWorkKind: "embedded_run",
        };
        diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
        return outcome;
      }
    }

    if (!activeSessionId && sessionLane) {
      const laneSnapshot = getCommandLaneSnapshot(sessionLane);
      if (laneSnapshot.activeCount > 0) {
        const laneStartedFreshTask = getCommandLaneActiveTaskIds(sessionLane).some(
          (id) => !preAbortActiveTaskIds.has(id),
        );
        // Orphaned active lane tasks have no run handle to abort. Release only
        // after the ownerless-lane window and only if no fresh task appeared.
        if (!laneStartedFreshTask && params.ageMs >= staleActiveLaneTaskReleaseMs) {
          const released = resetCommandLane(sessionLane);
          const outcome: StuckSessionRecoveryOutcome = {
            status: "released",
            action: "release_lane",
            reason: "stale_lane_task",
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            lane: sessionLane,
            released,
            queuedCount: laneSnapshot.queuedCount,
          };
          diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
          return outcome;
        }
        const outcome: StuckSessionRecoveryOutcome = {
          status: "skipped",
          action: "keep_lane",
          reason: "active_lane_task",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          lane: sessionLane,
          activeCount: laneSnapshot.activeCount,
          queuedCount: laneSnapshot.queuedCount,
        };
        diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
        return outcome;
      }
    }

    const queuedCount = sessionLane ? getCommandLaneSnapshot(sessionLane).queuedCount : 0;
    // A task id active now but not before the abort means the lane already
    // unwedged and pumped fresh work; resetting it would double-run the lane.
    const laneStartedFreshTask =
      sessionLane !== null &&
      getCommandLaneActiveTaskIds(sessionLane).some((id) => !preAbortActiveTaskIds.has(id));
    // Queued turns ride the session queue (params.queueDepth), not only the lane
    // queue; without this signal a cleanly aborted wedged lane never resets.
    const hasQueuedSessionWork = (params.queueDepth ?? 0) > 0;
    const released =
      sessionLane &&
      !laneStartedFreshTask &&
      (queuedCount > 0 || hasQueuedSessionWork || !activeSessionId || !aborted || !drained)
        ? resetCommandLane(sessionLane)
        : 0;

    const clearStaleQueuedSession = !aborted && released === 0 && (params.queueDepth ?? 0) > 0;

    if (aborted || forceCleared || released > 0 || clearStaleQueuedSession) {
      const action = aborted || forceCleared ? "abort_embedded_run" : "release_lane";
      const stoppedFields = formatStoppedCronSessionDiagnosticFields(
        resolveCronSessionDiagnosticContext({ sessionKey: params.sessionKey, activeSessionId }),
      );
      diag.warn(
        `stuck session recovery: sessionId=${params.sessionId ?? activeSessionId ?? "unknown"} sessionKey=${
          params.sessionKey ?? "unknown"
        } age=${Math.round(params.ageMs / 1000)}s action=${action} aborted=${aborted} drained=${drained} released=${released}${
          stoppedFields ? ` ${stoppedFields}` : ""
        }`,
      );
      const outcome: StuckSessionRecoveryOutcome =
        aborted || forceCleared
          ? {
              status: "aborted",
              action: "abort_embedded_run",
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              activeSessionId,
              activeWorkKind: "embedded_run",
              aborted,
              drained,
              forceCleared,
              released,
              lane: sessionLane ?? undefined,
              ...(queuedCount > 0 ? { queuedCount } : {}),
            }
          : {
              status: "released",
              action: "release_lane",
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              released,
              lane: sessionLane ?? undefined,
            };
      diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
      return outcome;
    }
    const outcome: StuckSessionRecoveryOutcome = {
      status: "noop",
      action: "none",
      reason: "no_active_work",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      lane: sessionLane ?? undefined,
    };
    diag.warn(`stuck session recovery outcome: ${formatRecoveryOutcome(outcome)}`);
    return outcome;
  } catch (err) {
    const outcome: StuckSessionRecoveryOutcome = {
      status: "failed",
      action: "none",
      reason: "exception",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      error: String(err),
    };
    diag.warn(
      `stuck session recovery failed: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
        params.sessionKey ?? "unknown"
      } err=${String(err)}`,
    );
    return outcome;
  } finally {
    recoveriesInFlight.delete(key);
  }
}

/** Test hooks for clearing in-flight recovery guards. */
export const testing = {
  resetRecoveriesInFlight(): void {
    recoveriesInFlight.clear();
  },
};
export { testing as __testing };
