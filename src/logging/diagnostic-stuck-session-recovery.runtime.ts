import { resolveEmbeddedSessionLane } from "../agents/pi-embedded-runner/lanes.js";
import {
  abortAndDrainEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunHandleActive,
  resolveActiveEmbeddedRunSessionId,
  resolveActiveEmbeddedRunHandleSessionId,
} from "../agents/pi-embedded-runner/runs.js";
import { getCommandLaneSnapshot, resetCommandLane } from "../process/command-queue.js";
import { diagnosticLogger as diag } from "./diagnostic-runtime.js";

const STUCK_SESSION_ABORT_SETTLE_MS = 15_000;
const recoveriesInFlight = new Set<string>();

export type StuckSessionRecoveryParams = {
  sessionId?: string;
  sessionKey?: string;
  ageMs: number;
  queueDepth?: number;
  allowActiveAbort?: boolean;
};

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
): Promise<void> {
  const key = recoveryKey(params);
  if (!key || recoveriesInFlight.has(key)) {
    return;
  }

  recoveriesInFlight.add(key);
  try {
    const fallbackActiveSessionId =
      params.sessionId && isEmbeddedPiRunHandleActive(params.sessionId)
        ? params.sessionId
        : undefined;
    const activeSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunHandleSessionId(params.sessionKey) ?? fallbackActiveSessionId)
      : fallbackActiveSessionId;
    const activeWorkSessionId = params.sessionKey
      ? (resolveActiveEmbeddedRunSessionId(params.sessionKey) ?? params.sessionId)
      : params.sessionId;
    const laneKey = params.sessionKey?.trim() || params.sessionId?.trim();
    const sessionLane = laneKey ? resolveEmbeddedSessionLane(laneKey) : null;
    let aborted = false;
    let drained = true;

    if (activeSessionId) {
      if (params.allowActiveAbort !== true) {
        diag.warn(
          `stuck session recovery skipped: reason=active_embedded_run action=observe_only ${formatRecoveryContext(
            params,
            { activeSessionId },
          )}`,
        );
        return;
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
    }

    if (!activeSessionId && activeWorkSessionId && isEmbeddedPiRunActive(activeWorkSessionId)) {
      diag.warn(
        `stuck session recovery skipped: reason=active_reply_work action=keep_lane ${formatRecoveryContext(
          params,
          { activeSessionId: activeWorkSessionId },
        )}`,
      );
      return;
    }

    if (!activeSessionId && sessionLane) {
      const laneSnapshot = getCommandLaneSnapshot(sessionLane);
      if (laneSnapshot.activeCount > 0) {
        diag.warn(
          `stuck session recovery skipped: reason=active_lane_task action=keep_lane ${formatRecoveryContext(
            params,
            {
              lane: sessionLane,
              activeCount: laneSnapshot.activeCount,
              queuedCount: laneSnapshot.queuedCount,
            },
          )}`,
        );
        return;
      }
    }

    const released =
      sessionLane && (!activeSessionId || !aborted || !drained) ? resetCommandLane(sessionLane) : 0;

    if (aborted || released > 0) {
      diag.warn(
        `stuck session recovery: sessionId=${params.sessionId ?? activeSessionId ?? "unknown"} sessionKey=${
          params.sessionKey ?? "unknown"
        } age=${Math.round(params.ageMs / 1000)}s aborted=${aborted} drained=${drained} released=${released}`,
      );
    } else {
      diag.warn(
        `stuck session recovery no-op: reason=no_active_work action=none ${formatRecoveryContext(
          params,
          {
            lane: sessionLane ?? undefined,
          },
        )}`,
      );
    }
  } catch (err) {
    diag.warn(
      `stuck session recovery failed: sessionId=${params.sessionId ?? "unknown"} sessionKey=${
        params.sessionKey ?? "unknown"
      } err=${String(err)}`,
    );
  } finally {
    recoveriesInFlight.delete(key);
  }
}

export const __testing = {
  resetRecoveriesInFlight(): void {
    recoveriesInFlight.clear();
  },
};
