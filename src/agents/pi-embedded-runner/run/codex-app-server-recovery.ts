import type { EmbeddedRunAttemptResult } from "./types.js";

export function resolveCodexAppServerClientCloseRetry(params: {
  attempt: EmbeddedRunAttemptResult;
  alreadyRetried: boolean;
}): { retry: boolean; reason?: string } {
  const failure = params.attempt.codexAppServerFailure;
  if (!failure) {
    return { retry: false, reason: "not_codex_app_server_failure" };
  }
  if (failure.kind !== "client_closed_before_turn_completed") {
    return { retry: false, reason: failure.kind };
  }
  if (failure.transport !== "stdio") {
    return { retry: false, reason: "non_stdio_transport" };
  }
  if (params.alreadyRetried) {
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
