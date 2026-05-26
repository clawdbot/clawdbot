import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import {
  abortAndDrainEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunHandleActive,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunHandleSessionId,
} from "../agents/pi-embedded-runner/runs.js";
import { getCommandLaneSnapshot, resetCommandLane } from "../process/command-queue.js";
import { getDiagnosticSessionActivitySnapshot } from "./diagnostic-run-activity.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";
import {
  formatStoppedCronSessionDiagnosticFields,
  resolveCronSessionDiagnosticContext,
} from "./diagnostic-session-context.js";
import {
  formatRecoveryOutcome,
  type StuckSessionRecoveryOutcome,
  type StuckSessionRecoveryRequest,
} from "./diagnostic-session-recovery.js";
import { isDiagnosticSessionStateCurrent } from "./diagnostic-session-state.js";

const STUCK_SESSION_ABORT_SETTLE_MS = 15_000;
// Default no-forward-progress age used only when the caller does not carry a
// resolved `diagnostics.stuckSessionAbortMs`. A run flagged "active" that has made
// no forward progress (tool/model/chunk events) for at least the resolved window,
// while queued work waits, is treated as a leaked/dead handle and reclaimed even
// without an explicit active-abort grant. `lastProgressAgeMs` tracks real progress
// (not incoming queued messages), so it keeps growing while a lane is wedged.
const STUCK_SESSION_PROGRESS_STALE_MS = 5 * 60_000;

function resolveStaleActiveProgressAbortMs(params: StuckSessionRecoveryParams): number {
  const configured = params.staleActiveProgressAbortMs;
  // Honor the resolved `diagnostics.stuckSessionAbortMs` as-is — an operator can
  // raise it to protect slow active work (it is the same threshold the existing
  // `session.stalled` abort uses). It is floored at the warn threshold upstream,
  // not necessarily 5 min, so we only apply the 5-min default when no value is
  // carried (e.g. direct callers).
  return typeof configured === "number" && configured > 0
    ? configured
    : STUCK_SESSION_PROGRESS_STALE_MS;
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
const recoveriesInFlight = new Set<string>();

export type StuckSessionRecoveryParams = StuckSessionRecoveryRequest;

function recoveryKey(params: StuckSessionRecoveryParams): string | undefined {
  return params.sessionKey?.trim() || params.sessionId?.trim() || undefined;
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
  const key = recoveryKey(params);
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
      params.sessionId && isEmbeddedPiRunHandleActive(params.sessionId)
        ? params.sessionId
        : undefined;
    let activeSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunHandleSessionId(params.sessionKey) ?? fallbackActiveSessionId)
      : fallbackActiveSessionId;
    const activeWorkSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunSessionId(params.sessionKey) ?? params.sessionId)
      : params.sessionId;
    const laneKey = params.sessionKey?.trim() || params.sessionId?.trim();
    const sessionLane = laneKey ? resolveEmbeddedSessionLane(laneKey) : null;
    let aborted = false;
    let drained = true;
    let forceCleared = false;
    const staleActiveProgressAbortMs = resolveStaleActiveProgressAbortMs(params);

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
      const result = await abortAndDrainEmbeddedPiRun({
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

    if (!activeSessionId && activeWorkSessionId && isEmbeddedPiRunActive(activeWorkSessionId)) {
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
        const result = await abortAndDrainEmbeddedPiRun({
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
    const released =
      sessionLane && (!activeSessionId || !aborted || !drained) ? resetCommandLane(sessionLane) : 0;

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

export const testing = {
  resetRecoveriesInFlight(): void {
    recoveriesInFlight.clear();
  },
};
export { testing as __testing };
