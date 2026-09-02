import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import {
  classifyOAuthRefreshFailure,
  classifyOAuthRefreshFailureError,
} from "../../agents/auth-profiles/oauth-refresh-failure.js";
import {
  isCompactionFailureError,
  isLikelyContextOverflowError,
} from "../../agents/embedded-agent-helpers.js";
import { sanitizeUserFacingText } from "../../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { findCliTimeoutError, isFailoverError } from "../../agents/failover-error.js";
import {
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
  HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
  renderBillingReplyCopy,
  renderControlUiAgentFailureCopy,
  renderFailoverCodeUserCopy,
  renderRateLimitOrOverloadedCopy,
  renderRateLimitReplyCopy,
} from "../../agents/failover/user-copy.js";
import { isAgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { defaultRuntime } from "../../runtime.js";
import type { ReplyPayload } from "../types.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";
import type { AgentTurnInternalResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  buildAuthProfileFailoverFailureText,
  buildExternalRunFailureReply,
  isNonDirectConversationContext,
  isVerboseFailureDetailEnabled,
  markAgentRunFailureReplyPayload,
  resolveExternalRunFailureTextForConversation,
  resolveReplyFailoverFacts,
} from "./agent-runner-failure-reply.js";
import type { AgentFallbackCycleState } from "./agent-runner-fallback-cycle.js";
import type { AgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import {
  buildRestartLifecycleReplyText,
  resolveReplyOperationAbortReason,
  resolveReplyOperationTerminationFields,
  resolveRestartLifecycleError,
} from "./reply-operation-abort.js";

const MAX_LIVE_SWITCH_RETRIES = 2;

type ErrorAction =
  | { kind: "retry"; liveModelSwitchError?: LiveSessionModelSwitchError }
  | Extract<AgentTurnInternalResult, { kind: "final" | "aborted" }>;

export async function handleAgentExecutionError(params: {
  turn: AgentTurnParams;
  error: unknown;
  runtimeConfig: AgentTurnParams["followupRun"]["run"]["config"];
  runId: string;
  state: AgentFallbackCycleState;
  liveModelSwitchRetries: number;
  shouldSurfaceToControlUi: boolean;
  timing: AgentTurnTimingTracker;
  modelPatch: { fail: (error: unknown) => Promise<void> };
}): Promise<ErrorAction> {
  const turn = params.turn;
  const err = params.error;
  // A failed candidate leaves its backstop pending; settlement takes it before later work.
  // This keeps session-override failures from being mislabeled as model failures.
  const postCompactionModelFailure =
    params.state.postCompactionModelAttempted && params.state.pendingLifecycleTerminal
      ? true
      : undefined;
  const takePendingLifecycleTerminal = () => {
    const terminal =
      params.state.pendingLifecycleTerminal?.backstop ??
      createAgentLifecycleTerminalBackstop({
        runId: params.runId,
        sessionKey: turn.sessionKey,
        startedAt: params.state.turnStartedAtMs,
        getLifecycleGeneration: () => params.state.lifecycleGeneration,
        resolveTerminationFields: (error) =>
          resolveReplyOperationTerminationFields(
            error,
            turn.replyOperation?.abortSignal ?? turn.opts?.abortSignal,
            turn.replyOperation,
          ),
      });
    params.state.pendingLifecycleTerminal = undefined;
    return terminal;
  };
  const settleFailure = async (
    payload: ReplyPayload,
    terminalMetadata?: { fallbackExhaustedFailure: true },
  ): Promise<Extract<AgentTurnInternalResult, { kind: "final" }>> => {
    takePendingLifecycleTerminal().emit("error", err, terminalMetadata);
    turn.replyOperation?.fail("run_failed", err);
    await params.modelPatch.fail(err);
    return {
      kind: "final",
      payload: markAgentRunFailureReplyPayload(payload),
      postCompactionModelFailure,
    };
  };
  const resolveReplyOperationAbortAction = (abortError: unknown): ErrorAction | undefined => {
    const reason = resolveReplyOperationAbortReason(turn.replyOperation, abortError);
    if (!reason) {
      return undefined;
    }
    // Preserve signal-owned timeout attribution; only normalized restart/supersession need metadata.
    const terminalMetadata = reason === "user" ? undefined : { aborted: true, stopReason: reason };
    takePendingLifecycleTerminal().emit(
      reason === "restart" ? "end" : "error",
      abortError,
      terminalMetadata,
    );
    return { kind: "aborted", reason };
  };
  const replyOperationAbortAction = resolveReplyOperationAbortAction(err);
  if (replyOperationAbortAction) {
    return replyOperationAbortAction;
  }
  if (err instanceof LiveSessionModelSwitchError) {
    if (params.liveModelSwitchRetries <= MAX_LIVE_SWITCH_RETRIES) {
      params.state.pendingLifecycleTerminal = undefined;
      return { kind: "retry", liveModelSwitchError: err };
    }
    const visibleReplyDelivered = await turn.resolveVisibleReplyDelivery?.();
    defaultRuntime.error(
      `Live model switch failed after ${MAX_LIVE_SWITCH_RETRIES} retries ` +
        `(${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)}). The requested model may be unavailable.`,
    );
    takePendingLifecycleTerminal().emit("error", err);
    const switchErrorText = params.shouldSurfaceToControlUi
      ? renderControlUiAgentFailureCopy(
          "model switch could not be completed. The requested model may be temporarily unavailable.",
        )
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
          visibleReplyDelivered,
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
  // The exhausted preflight is deliberate, even if its diagnostic cause looks
  // like HTTP/overload. Settle delivery and normal diagnostic policy without replay.
  if (isAgentHarnessPreflightError(err)) {
    const externalReply = buildExternalRunFailureReply(
      { message, error: err },
      {
        includeDetails: isVerboseFailureDetailEnabled(turn.resolvedVerboseLevel),
        isHeartbeat: turn.isHeartbeat,
      },
    );
    const text = resolveExternalRunFailureTextForConversation({
      text: params.shouldSurfaceToControlUi
        ? renderControlUiAgentFailureCopy(message)
        : externalReply.text,
      visibleReplyDelivered: await turn.resolveVisibleReplyDelivery?.(),
      sessionCtx: turn.sessionCtx,
      isGenericRunnerFailure: externalReply.isGenericRunnerFailure,
      cfg: turn.followupRun.run.config,
    });
    return await settleFailure({ text });
  }
  const failoverFacts = resolveReplyFailoverFacts(err, message);
  const fallbackAttempts = isFailoverError(err) ? err.attempts : undefined;
  const hasFallbackAttempts = Boolean(fallbackAttempts?.length);
  const isPureOverloadSummary =
    hasFallbackAttempts && fallbackAttempts?.every((attempt) => attempt.reason === "overloaded");
  const failoverReason = failoverFacts.reason;
  const isOverloaded = hasFallbackAttempts
    ? isPureOverloadSummary
    : failoverReason === "overloaded";
  const isBilling = hasFallbackAttempts
    ? fallbackAttempts?.some((attempt) => attempt.reason === "billing")
    : failoverReason === "billing";
  const isContextOverflow =
    !isBilling && (failoverReason === "context_overflow" || isLikelyContextOverflowError(message));
  const isCompactionFailure = !isBilling && isCompactionFailureError(message);
  const oauthRefreshFailure =
    classifyOAuthRefreshFailureError(err) ?? classifyOAuthRefreshFailure(message);
  const hasAuthProfileFailoverFailure = buildAuthProfileFailoverFailureText(err) !== null;
  const providerRequestError =
    !isBilling &&
    !oauthRefreshFailure &&
    !hasAuthProfileFailoverFailure &&
    !params.shouldSurfaceToControlUi
      ? failoverFacts.providerRequestError
      : undefined;
  const restartLifecycleError = resolveRestartLifecycleError(err);
  if (
    restartLifecycleError instanceof GatewayDrainingError ||
    restartLifecycleError instanceof CommandLaneClearedError
  ) {
    takePendingLifecycleTerminal().emit("error", restartLifecycleError);
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
    takePendingLifecycleTerminal().emit("error", err);
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
  const replayPrevented = findCliTimeoutError(err)?.cliTimeout.observedActivity === true;
  if (providerRequestError) {
    return await settleFailure({
      // Curated facet copy beats the generic classified summary; see
      // buildExternalRunFailureReply for the same priority.
      text: providerRequestError.userMessage,
    });
  }
  defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
  const isPureTransientSummary = Boolean(
    hasFallbackAttempts &&
    fallbackAttempts?.every(
      (attempt) => attempt.reason === "rate_limit" || attempt.reason === "overloaded",
    ),
  );
  const isRateLimit = hasFallbackAttempts
    ? isPureTransientSummary
    : failoverReason === "rate_limit" || failoverReason === "overloaded";
  const rateLimitOrOverloadedCopy =
    (!hasFallbackAttempts &&
      (failoverReason === "rate_limit" || failoverReason === "overloaded")) ||
    isPureTransientSummary
      ? renderRateLimitOrOverloadedCopy({
          reason: isOverloaded ? "overloaded" : "rate_limit",
          raw: message,
        })
      : undefined;
  const userFacingMessage = message;
  const externalRunFailureCandidate =
    !isBilling &&
    !(isRateLimit && !isOverloaded) &&
    !rateLimitOrOverloadedCopy &&
    !isContextOverflow
      ? buildExternalRunFailureReply(
          { message, error: err },
          {
            includeAuthProfileId: !isNonDirectConversationContext(turn.sessionCtx),
            includeDetails: isVerboseFailureDetailEnabled(turn.resolvedVerboseLevel),
            isHeartbeat: turn.isHeartbeat,
            replayPrevented,
            failoverFacts,
          },
        )
      : undefined;
  const externalRunFailureReply =
    !params.shouldSurfaceToControlUi ||
    externalRunFailureCandidate?.presentation ||
    renderFailoverCodeUserCopy(failoverFacts.code)
      ? externalRunFailureCandidate
      : undefined;
  const fallbackText = isBilling
    ? renderBillingReplyCopy({
        attempts: fallbackAttempts,
        ...(isFailoverError(err)
          ? { provider: err.provider, model: err.model, authMode: err.authMode }
          : {}),
      })
    : isRateLimit && !isOverloaded
      ? renderRateLimitReplyCopy({
          message,
          reason: failoverReason,
          attempts: fallbackAttempts,
          provider: isFailoverError(err) ? err.provider : undefined,
          cooldownExpiry: isFailoverError(err) ? err.soonestCooldownExpiry : undefined,
          sanitizeText: (text) => sanitizeUserFacingText(text, { errorContext: true }),
        })
      : rateLimitOrOverloadedCopy
        ? rateLimitOrOverloadedCopy
        : isContextOverflow
          ? "⚠️ Context overflow — prompt too large for this model. Try a shorter message or a larger-context model."
          : (externalRunFailureReply?.text ??
            (params.shouldSurfaceToControlUi
              ? renderControlUiAgentFailureCopy(userFacingMessage)
              : turn.isHeartbeat
                ? HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT
                : GENERIC_EXTERNAL_RUN_FAILURE_TEXT));
  const userVisibleFallbackText = resolveExternalRunFailureTextForConversation({
    text: fallbackText,
    visibleReplyDelivered: await turn.resolveVisibleReplyDelivery?.(),
    sessionCtx: turn.sessionCtx,
    isGenericRunnerFailure: externalRunFailureReply?.isGenericRunnerFailure ?? false,
    cfg: turn.followupRun.run.config,
  });
  return await settleFailure(
    {
      text: userVisibleFallbackText,
      ...(externalRunFailureReply?.presentation
        ? { presentation: externalRunFailureReply.presentation }
        : {}),
    },
    { fallbackExhaustedFailure: true },
  );
}
