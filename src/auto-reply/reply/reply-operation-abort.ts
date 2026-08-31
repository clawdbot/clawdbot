import { isFallbackSummaryError } from "../../agents/model-fallback-attempt.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";

export function buildRestartLifecycleReplyText(): string {
  return "⚠️ Gateway is restarting. Please wait a few seconds and try again.";
}

function isReplyOperationUserAbort(replyOperation?: ReplyOperation): boolean {
  if (
    replyOperation?.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_by_user"
  ) {
    return true;
  }
  const abortSignal = replyOperation?.abortSignal;
  return (
    abortSignal?.aborted === true &&
    !isAgentRunRestartAbortReason(abortSignal.reason) &&
    !isAgentRunSupersededAbortReason(abortSignal.reason)
  );
}

function isReplyOperationRestartAbort(replyOperation?: ReplyOperation): boolean {
  if (
    replyOperation?.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_for_restart"
  ) {
    return true;
  }
  const abortSignal = replyOperation?.abortSignal;
  return abortSignal?.aborted === true && isAgentRunRestartAbortReason(abortSignal.reason);
}

export function resolveReplyOperationTerminationFields(
  error: unknown,
  signal: AbortSignal | undefined,
  replyOperation?: ReplyOperation,
) {
  return {
    ...resolveAgentRunErrorLifecycleFields(error, signal),
    ...(isReplyOperationRestartAbort(replyOperation)
      ? { aborted: true as const, stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON }
      : {}),
  };
}

export function isReplyOperationSuperseded(replyOperation?: ReplyOperation): boolean {
  if (
    replyOperation?.result?.kind === "aborted" &&
    replyOperation.result.code === "aborted_for_supersession"
  ) {
    return true;
  }
  const abortSignal = replyOperation?.abortSignal;
  return abortSignal?.aborted === true && isAgentRunSupersededAbortReason(abortSignal.reason);
}

export function resolveReplyOperationAbortReason(
  replyOperation?: ReplyOperation,
): "user" | "restart" | "superseded" | undefined {
  return isReplyOperationRestartAbort(replyOperation)
    ? "restart"
    : isReplyOperationSuperseded(replyOperation)
      ? "superseded"
      : isReplyOperationUserAbort(replyOperation)
        ? "user"
        : undefined;
}

export function resolveRestartLifecycleError(
  error: unknown,
): GatewayDrainingError | CommandLaneClearedError | undefined {
  const pending = [error];
  const seen = new Set<unknown>();
  for (const candidate of pending) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (candidate instanceof GatewayDrainingError || candidate instanceof CommandLaneClearedError) {
      return candidate;
    }
    if (isFallbackSummaryError(candidate)) {
      pending.push(...candidate.attempts.map((attempt) => attempt.error));
    }
    if (candidate instanceof Error && "cause" in candidate) {
      pending.push(candidate.cause);
    }
  }
  return undefined;
}
