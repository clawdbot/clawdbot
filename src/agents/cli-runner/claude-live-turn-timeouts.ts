import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "../../logging/diagnostic-run-activity.js";
import {
  createCliTimeoutError,
  resolveCliNoOutputTimeoutDecision,
} from "./no-output-timeout-policy.js";

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
    const quietDurationMs = Date.now() - quietSinceMs;
    const decision = resolveCliNoOutputTimeoutDecision({
      context: { provider: host.providerId, model: host.modelId },
      timeoutMs: host.noOutputTimeoutMs,
      quietDurationMs,
      cliTimeout: {
        mode: "no-output",
        timeoutSeconds: Math.round(quietDurationMs / 1000),
        observedActivity:
          turn.lastOutputAtMs !== null || turn.toolEventCount > 0 || turn.rawLines.length > 0,
        activeToolCount: turn.activeTools.size,
        backgroundTaskCount: host.outstandingBackgroundTaskIds.size,
      },
      hasOutputText: host.stdoutBuffer.pending.trim().length > 0,
      useResume: turn.useResume,
      hasReplayUnsafeActivity: turn.hasReplayUnsafeActivity,
      allowResumeControlOnlyRetry: true,
      outstandingWorkGraceMs: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
    });
    if (decision.deferMs !== undefined) {
      armNoOutputTimer(host, turn, decision.deferMs);
      return;
    }
    host.close("abort", decision.error);
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
    const timeoutSeconds = Math.round(overallTimeoutMs / 1000);
    host.close(
      "abort",
      createCliTimeoutError(
        { provider: host.providerId, model: host.modelId },
        {
          mode: "overall",
          timeoutSeconds,
          observedActivity:
            turn.observedStdout || turn.rawLines.length > 0 || turn.toolEventCount > 0,
          activeToolCount: turn.activeTools.size,
          backgroundTaskCount: host.outstandingBackgroundTaskIds.size,
        },
        "cli_overall_timeout",
      ),
    );
  }, overallTimeoutMs);
}
