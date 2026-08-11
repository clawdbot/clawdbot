import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "../../logging/diagnostic-run-activity.js";
import { type CliTimeoutContext, FailoverError, resolveFailoverStatus } from "../failover-error.js";

type ClaudeLiveTimeoutTurn = {
  startedAtMs: number;
  rawLines: { length: number };
  noOutputTimer: NodeJS.Timeout | null;
  lastOutputAtMs: number | null;
  timeoutTimer: NodeJS.Timeout | null;
  activeTools: { size: number };
  observedStdout: boolean;
  useResume: boolean;
  hasReplayUnsafeActivity: boolean;
  toolEventCount: number;
};

type ClaudeLiveTimeoutHost = {
  providerId: string;
  modelId: string;
  noOutputTimeoutMs: number;
  stdoutBuffer: { pending: string };
  outstandingBackgroundTaskIds: { size: number };
  close(reason: "idle" | "restart" | "abort" | "mcp-capture-rotation", error?: unknown): void;
};

function createClaudeTimeoutError(
  host: ClaudeLiveTimeoutHost,
  message: string,
  code?: string,
  cliTimeout?: CliTimeoutContext,
): FailoverError {
  return new FailoverError(message, {
    reason: "timeout",
    provider: host.providerId,
    model: host.modelId,
    status: resolveFailoverStatus("timeout"),
    code,
    cliTimeout,
  });
}

function armNoOutputTimer(
  host: ClaudeLiveTimeoutHost,
  turn: ClaudeLiveTimeoutTurn,
  delayMs: number,
): void {
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
  }
  turn.noOutputTimer = setTimeout(() => {
    const quietSinceMs = turn.lastOutputAtMs ?? turn.startedAtMs;
    const hasOutstandingWork =
      turn.activeTools.size > 0 || host.outstandingBackgroundTaskIds.size > 0;
    if (hasOutstandingWork) {
      const remainingMs =
        quietSinceMs +
        Math.max(host.noOutputTimeoutMs, BLOCKED_TOOL_CALL_ABORT_FLOOR_MS) -
        Date.now();
      if (remainingMs > 0) {
        armNoOutputTimer(host, turn, remainingMs);
        return;
      }
    }
    const retryableResumeStall =
      turn.useResume &&
      host.stdoutBuffer.pending.trim().length === 0 &&
      !turn.hasReplayUnsafeActivity &&
      turn.toolEventCount === 0 &&
      turn.activeTools.size === 0 &&
      host.outstandingBackgroundTaskIds.size === 0;
    host.close(
      "abort",
      createClaudeTimeoutError(
        host,
        `CLI produced no output for ${Math.round((Date.now() - quietSinceMs) / 1000)}s and was terminated.`,
        turn.lastOutputAtMs === null || retryableResumeStall ? "cli_no_output_timeout" : undefined,
        {
          mode: "no-output",
          timeoutSeconds: Math.round((Date.now() - quietSinceMs) / 1000),
          observedActivity:
            turn.lastOutputAtMs !== null || turn.toolEventCount > 0 || turn.rawLines.length > 0,
          activeToolCount: turn.activeTools.size,
          backgroundTaskCount: host.outstandingBackgroundTaskIds.size,
        },
      ),
    );
  }, delayMs);
}

export function clearClaudeTurnTimers(turn: ClaudeLiveTimeoutTurn): void {
  if (turn.noOutputTimer) {
    clearTimeout(turn.noOutputTimer);
    turn.noOutputTimer = null;
  }
  if (turn.timeoutTimer) {
    clearTimeout(turn.timeoutTimer);
    turn.timeoutTimer = null;
  }
}

export function resetClaudeNoOutputTimer(
  host: ClaudeLiveTimeoutHost,
  turn: ClaudeLiveTimeoutTurn | null,
): void {
  if (!turn) {
    return;
  }
  turn.lastOutputAtMs = Date.now();
  armNoOutputTimer(host, turn, host.noOutputTimeoutMs);
}

export function armClaudeTurnTimers(
  host: ClaudeLiveTimeoutHost,
  turn: ClaudeLiveTimeoutTurn,
  overallTimeoutMs: number,
): void {
  armNoOutputTimer(host, turn, host.noOutputTimeoutMs);
  turn.timeoutTimer = setTimeout(() => {
    host.close(
      "abort",
      createClaudeTimeoutError(
        host,
        `CLI exceeded timeout (${Math.round(overallTimeoutMs / 1000)}s) and was terminated.`,
        "cli_overall_timeout",
        {
          mode: "overall",
          timeoutSeconds: Math.round(overallTimeoutMs / 1000),
          observedActivity:
            turn.observedStdout || turn.rawLines.length > 0 || turn.toolEventCount > 0,
          activeToolCount: turn.activeTools.size,
          backgroundTaskCount: host.outstandingBackgroundTaskIds.size,
        },
      ),
    );
  }, overallTimeoutMs);
}
