import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
} from "../../agents/auth-profiles/oauth-refresh-failure.js";
import {
  formatRateLimitOrOverloadedErrorCopy,
  isBillingErrorMessage,
  isCompactionFailureError,
  isLikelyContextOverflowError,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isTransientHttpError,
} from "../../agents/embedded-agent-helpers.js";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { isFailoverError } from "../../agents/failover-error.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { isFallbackSummaryError } from "../../agents/model-fallback.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  resolveAgentRunErrorLifecycleFields,
} from "../../agents/run-termination.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { defaultRuntime } from "../../runtime.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";
import type { AgentRunLoopResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
} from "./agent-runner-failure-copy.js";
import {
  buildAuthProfileFailoverFailureText,
  buildExternalRunFailureReply,
  buildRateLimitCooldownMessage,
  hasBillingAttemptSummary,
  isNonDirectConversationContext,
  isPureTransientRateLimitSummary,
  isVerboseFailureDetailEnabled,
  markAgentRunFailureReplyPayload,
  resolveBillingFailureReplyText,
  resolveExternalRunFailureTextForConversation,
} from "./agent-runner-failure-reply.js";
import type { AgentFallbackCycleState } from "./agent-runner-fallback-cycle.js";
import type { AgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import { classifyProviderRequestError } from "./provider-request-error-classifier.js";
import {
  buildRestartLifecycleReplyText,
  isReplyOperationRestartAbort,
  isReplyOperationUserAbort,
  resolveRestartLifecycleError,
} from "./reply-operation-abort.js";

const MAX_LIVE_SWITCH_RETRIES = 2;
const TRANSIENT_HTTP_RETRY_DELAY_MS = 2_500;

type ErrorAction =
  | { kind: "retry"; liveModelSwitchError?: LiveSessionModelSwitchError }
  | Extract<AgentRunLoopResult, { kind: "final" }>;

export async function handleAgentExecutionError(params: {
  turn: AgentTurnParams;
  error: unknown;
  runtimeConfig: AgentTurnParams["followupRun"]["run"]["config"];
  runId: string;
  state: AgentFallbackCycleState;
  liveModelSwitchRetries: number;
  shouldSurfaceToControlUi: boolean;
  timing: AgentTurnTimingTracker;
  consumeTransientHttpRetry: () => boolean;
  modelPatch: { fail: (error: unknown) => Promise<void> };
}): Promise<ErrorAction> {
  const turn = params.turn;
  const err = params.error;
  const takePendingLifecycleTerminal = () => {
    const terminal = params.state.pendingLifecycleTerminal?.backstop;
    params.state.pendingLifecycleTerminal = undefined;
    return terminal;
  };
  if (err instanceof LiveSessionModelSwitchError) {
    if (params.liveModelSwitchRetries <= MAX_LIVE_SWITCH_RETRIES) {
      params.state.pendingLifecycleTerminal = undefined;
      return { kind: "retry", liveModelSwitchError: err };
    }
    defaultRuntime.error(
      `Live model switch failed after ${MAX_LIVE_SWITCH_RETRIES} retries ` +
        `(${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)}). The requested model may be unavailable.`,
    );
    takePendingLifecycleTerminal()?.emit("error", err);
    const switchErrorText = params.shouldSurfaceToControlUi
      ? "⚠️ Agent failed before reply: model switch could not be completed. " +
        "The requested model may be temporarily unavailable.\n" +
        "Logs: openclaw logs --follow"
      : isVerboseFailureDetailEnabled(turn.resolvedVerboseLevel)
        ? "⚠️ Agent failed before reply: model switch could not be completed. " +
          "The requested model may be temporarily unavailable. Please try again shortly."
        : "⚠️ Model switch could not be completed. The requested model may be temporarily unavailable. Please try again shortly.";
    turn.replyOperation?.fail("run_failed", err);
    await params.modelPatch.fail(err);
    return {
      kind: "final",
      payload: markAgentRunFailureReplyPayload({
        text: resolveExternalRunFailureTextForConversation({
          text: switchErrorText,
          sessionCtx: turn.sessionCtx,
          isGenericRunnerFailure: !params.shouldSurfaceToControlUi,
          cfg: turn.followupRun.run.config,
        }),
      }),
    };
  }
  const message = formatErrorMessage(err);
  params.timing.logIfSlow({
    runId: params.runId,
    sessionId: turn.followupRun.run.sessionId,
    sessionKey: turn.sessionKey,
    outcome: "error",
    error: message,
  });
  const isFallbackSummary = isFallbackSummaryError(err);
  const isBilling = isFallbackSummary
    ? hasBillingAttemptSummary(err)
    : isFailoverError(err)
      ? err.reason === "billing"
      : isBillingErrorMessage(message);
  const isContextOverflow =
    !isBilling &&
    ((isFailoverError(err) && err.reason === "context_overflow") ||
      isLikelyContextOverflowError(message));
  const isCompactionFailure = !isBilling && isCompactionFailureError(message);
  const oauthRefreshFailure =
    classifyOAuthRefreshFailureError(err) ?? classifyOAuthRefreshFailure(message);
  const hasAuthProfileFailoverFailure = buildAuthProfileFailoverFailureText(err) !== null;
  const providerRequestError =
    !isBilling &&
    !oauthRefreshFailure &&
    !hasAuthProfileFailoverFailure &&
    !params.shouldSurfaceToControlUi
      ? classifyProviderRequestError(err)
      : undefined;
  const isTransientHttp =
    isTransientHttpError(message) ||
    (isFailoverError(err) && (err.reason === "timeout" || err.reason === "server_error"));

  if (isReplyOperationRestartAbort(turn.replyOperation)) {
    takePendingLifecycleTerminal()?.emit("end", err);
    return {
      kind: "final",
      payload:
        turn.isRestartRecoveryArmed?.() === true
          ? { text: SILENT_REPLY_TOKEN }
          : markAgentRunFailureReplyPayload({ text: buildRestartLifecycleReplyText() }),
    };
  }
  if (isReplyOperationUserAbort(turn.replyOperation)) {
    takePendingLifecycleTerminal()?.emit("error", err);
    return { kind: "final", payload: { text: SILENT_REPLY_TOKEN } };
  }
  const restartLifecycleError = resolveRestartLifecycleError(err);
  if (
    restartLifecycleError instanceof GatewayDrainingError ||
    restartLifecycleError instanceof CommandLaneClearedError
  ) {
    takePendingLifecycleTerminal()?.emit("error", restartLifecycleError);
    turn.replyOperation?.fail(
      restartLifecycleError instanceof GatewayDrainingError
        ? "gateway_draining"
        : "command_lane_cleared",
      restartLifecycleError,
    );
    return {
      kind: "final",
      payload: markAgentRunFailureReplyPayload({ text: buildRestartLifecycleReplyText() }),
    };
  }
  if (isCompactionFailure) {
    takePendingLifecycleTerminal()?.emit("error", err);
    defaultRuntime.error(
      `Auto-compaction failed (${message}). Preserving existing session mapping for ${turn.sessionKey ?? turn.followupRun.run.sessionId}.`,
    );
    turn.replyOperation?.fail("run_failed", err);
    return {
      kind: "final",
      payload: markAgentRunFailureReplyPayload({
        text: buildContextOverflowRecoveryText({
          duringCompaction: true,
          preserveSessionMapping: true,
          cfg: params.runtimeConfig,
          agentId: turn.followupRun.run.agentId,
          primaryProvider: turn.followupRun.run.provider,
          primaryModel: turn.followupRun.run.model,
          runtimeProvider: params.state.attemptedRuntimeProvider,
          runtimeModel: params.state.attemptedRuntimeModel,
          activeSessionEntry: turn.getActiveSessionEntry(),
        }),
      }),
    };
  }
  if (providerRequestError) {
    takePendingLifecycleTerminal()?.emit("error", err);
    turn.replyOperation?.fail("run_failed", err);
    await params.modelPatch.fail(err);
    return {
      kind: "final",
      payload: markAgentRunFailureReplyPayload({ text: providerRequestError.userMessage }),
    };
  }
  if (isTransientHttp && params.consumeTransientHttpRetry()) {
    params.state.pendingLifecycleTerminal = undefined;
    defaultRuntime.error(
      `Transient HTTP provider error before reply (${message}). Retrying once in ${TRANSIENT_HTTP_RETRY_DELAY_MS}ms.`,
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, TRANSIENT_HTTP_RETRY_DELAY_MS);
    });
    return { kind: "retry" };
  }
  defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
  const isPureTransientSummary = isFallbackSummary ? isPureTransientRateLimitSummary(err) : false;
  const failoverReason = !isFallbackSummary && isFailoverError(err) ? err.reason : undefined;
  const isOverloaded = failoverReason === "overloaded" || isOverloadedErrorMessage(message);
  const isRateLimit = isFallbackSummary
    ? isPureTransientSummary
    : failoverReason
      ? failoverReason === "rate_limit" || failoverReason === "overloaded"
      : isRateLimitErrorMessage(message);
  const rateLimitOrOverloadedCopy =
    !isFallbackSummary || isPureTransientSummary
      ? formatRateLimitOrOverloadedErrorCopy(
          failoverReason === "overloaded" ? "overloaded" : message,
        )
      : undefined;
  const trimmedMessage = (
    isTransientHttp ? sanitizeUserFacingText(message, { errorContext: true }) : message
  ).replace(/\.\s*$/, "");
  const externalRunFailureReply =
    !isBilling &&
    !(isRateLimit && !isOverloaded) &&
    !rateLimitOrOverloadedCopy &&
    !isContextOverflow &&
    !params.shouldSurfaceToControlUi
      ? buildExternalRunFailureReply(
          { message, error: err },
          {
            includeAuthProfileId: !isNonDirectConversationContext(turn.sessionCtx),
            includeDetails: isVerboseFailureDetailEnabled(turn.resolvedVerboseLevel),
            isHeartbeat: turn.isHeartbeat,
          },
        )
      : undefined;
  const fallbackText = isBilling
    ? resolveBillingFailureReplyText(err)
    : isRateLimit && !isOverloaded
      ? buildRateLimitCooldownMessage(err)
      : rateLimitOrOverloadedCopy
        ? rateLimitOrOverloadedCopy
        : isContextOverflow
          ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
          : params.shouldSurfaceToControlUi
            ? `⚠️ Agent failed before reply: ${trimmedMessage}.\nLogs: openclaw logs --follow`
            : (externalRunFailureReply?.text ??
              (turn.isHeartbeat
                ? HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT
                : GENERIC_EXTERNAL_RUN_FAILURE_TEXT));
  const userVisibleFallbackText = resolveExternalRunFailureTextForConversation({
    text: fallbackText,
    sessionCtx: turn.sessionCtx,
    isGenericRunnerFailure: externalRunFailureReply?.isGenericRunnerFailure ?? false,
    cfg: turn.followupRun.run.config,
  });
  const abortedSignal =
    turn.replyOperation?.abortSignal.aborted === true
      ? turn.replyOperation.abortSignal
      : turn.opts?.abortSignal?.aborted === true
        ? turn.opts.abortSignal
        : undefined;
  const abortLifecycleFields = {
    ...resolveAgentRunErrorLifecycleFields(err, abortedSignal),
    ...(isReplyOperationRestartAbort(turn.replyOperation)
      ? { aborted: true as const, stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON }
      : {}),
  };
  const failedLifecycleTerminal = takePendingLifecycleTerminal();
  if (failedLifecycleTerminal) {
    failedLifecycleTerminal.emit("error", err, { fallbackExhaustedFailure: true });
  } else {
    emitAgentEvent({
      runId: params.runId,
      lifecycleGeneration: params.state.lifecycleGeneration,
      ...(turn.sessionKey ? { sessionKey: turn.sessionKey } : {}),
      stream: "lifecycle",
      data: {
        phase: "error",
        error: message,
        endedAt: Date.now(),
        ...abortLifecycleFields,
        fallbackExhaustedFailure: true,
      },
    });
  }
  turn.replyOperation?.fail("run_failed", err);
  await params.modelPatch.fail(err);
  return {
    kind: "final",
    payload: markAgentRunFailureReplyPayload({ text: userVisibleFallbackText }),
  };
}
