/**
 * Detects Codex app-server failures that should retry with recovery.
 */
import type { EmbeddedRunAttemptResult } from "./types.js";

export function hasCodexAppServerRecoveryRetryBudget(params: {
  alreadyRetried: boolean;
  runLoopIterations: number;
  maxRunLoopIterations: number;
}): boolean {
  return !params.alreadyRetried && params.runLoopIterations < params.maxRunLoopIterations;
}

/**
 * Decides whether a Codex app-server failure can be retried by replaying the
 * same turn. The retry is intentionally narrow: stdio-only, replay-safe, once
 * per run, and only before any assistant/tool/item side effects escape.
 */
export function resolveCodexAppServerRecoveryRetry(params: {
  attempt: EmbeddedRunAttemptResult;
  retryAvailable: boolean;
}): { retry: boolean; reason?: string } {
  const failure = params.attempt.codexAppServerFailure;
  if (!failure) {
    return { retry: false, reason: "not_codex_app_server_failure" };
  }
  if (
    failure.kind !== "client_closed_before_turn_completed" &&
    failure.kind !== "turn_completion_idle_timeout"
  ) {
    return { retry: false, reason: failure.kind };
  }
  if (
    failure.kind === "turn_completion_idle_timeout" &&
    failure.turnWatchTimeoutKind !== "completion"
  ) {
    return { retry: false, reason: failure.turnWatchTimeoutKind ?? "unknown_turn_watch_timeout" };
  }
  if (failure.transport !== "stdio") {
    return { retry: false, reason: "non_stdio_transport" };
  }
  if (!params.retryAvailable) {
    return { retry: false, reason: "retry_exhausted" };
  }
  if (!failure.replaySafe || !params.attempt.replayMetadata.replaySafe) {
    return { retry: false, reason: failure.replayBlockedReason ?? "replay_unsafe" };
  }
  if (params.attempt.assistantTexts.some((text) => text.trim().length > 0)) {
    return { retry: false, reason: "assistant_output" };
  }
  if (
    params.attempt.toolMetas.length > 0 ||
    params.attempt.clientToolCalls ||
    params.attempt.lastToolError ||
    params.attempt.didSendDeterministicApprovalPrompt
  ) {
    return { retry: false, reason: "tool_activity" };
  }
  if (
    params.attempt.itemLifecycle.startedCount > 0 ||
    params.attempt.itemLifecycle.activeCount > 0
  ) {
    return { retry: false, reason: "active_item" };
  }
  return { retry: true };
}
