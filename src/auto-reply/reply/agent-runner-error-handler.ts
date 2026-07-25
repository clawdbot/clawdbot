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
import { logVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { CommandLaneClearedError, GatewayDrainingError } from "../../process/command-queue.js";
import { defaultRuntime } from "../../runtime.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";
import type { AgentRunLoopResult, AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  buildControlUiAgentFailureText,
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
// Overload recovery stays inside one turn: bounded backoff absorbs short provider incidents,
// while the delayed notice prevents a long silent wait without becoming assistant content.
const MAX_OVERLOAD_RETRIES = 10;
const OVERLOAD_RETRY_BASE_DELAY_MS = 2_500;
const OVERLOAD_RETRY_MAX_DELAY_MS = 30_000;
const OVERLOAD_RETRY_NOTICE_AFTER_MS = 30_000;
const OVERLOAD_RETRY_NOTICE_DELIVERY_TIMEOUT_MS = 5_000;
const OVERLOAD_RETRY_NOTICE_TEXT =
  "The AI service is temporarily overloaded. I’m still retrying; this may take a few minutes.";

export type OverloadRetryState = {
  retryCount: number;
  turnStartedAtMs: number;
  unsafeToReplay: boolean;
  noticeSent: boolean;
  noticeTimer?: ReturnType<typeof setTimeout>;
  noticeDelivery?: Promise<void>;
  noticeAbortController?: AbortController;
  noticeAbortCleanup?: () => void;
  completed: boolean;
};

function stopOverloadRetryNotice(state: OverloadRetryState, reason: Error) {
  if (state.noticeTimer) {
    clearTimeout(state.noticeTimer);
    state.noticeTimer = undefined;
  }
  state.noticeAbortCleanup?.();
  state.noticeAbortCleanup = undefined;
  state.noticeAbortController?.abort(reason);
}

/** Prevents a full-turn replay or stale retry notice after observable work begins. */
export function markOverloadRetryUnsafeToReplay(state: OverloadRetryState): void {
  state.unsafeToReplay = true;
  stopOverloadRetryNotice(state, new Error("overload retry became unsafe to replay"));
}

/** Stops the turn-owned overload notice once no retry can still be running. */
export async function cancelOverloadRetryNotice(state: OverloadRetryState): Promise<void> {
  state.completed = true;
  stopOverloadRetryNotice(state, new Error("overload retry finished"));
  await state.noticeDelivery;
}

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
  overloadRetryState: OverloadRetryState;
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
  const resolveReplyOperationAbortAction = (abortError: unknown): ErrorAction | undefined => {
    if (isReplyOperationRestartAbort(turn.replyOperation)) {
      takePendingLifecycleTerminal()?.emit("end", abortError);
      return {
        kind: "final",
        payload:
          turn.isRestartRecoveryArmed?.() === true
            ? { text: SILENT_REPLY_TOKEN }
            : markAgentRunFailureReplyPayload({ text: buildRestartLifecycleReplyText() }),
      };
    }
    if (isReplyOperationUserAbort(turn.replyOperation)) {
      takePendingLifecycleTerminal()?.emit("error", abortError);
      return { kind: "final", payload: { text: SILENT_REPLY_TOKEN } };
    }
    return undefined;
  };
  const waitForRetryBackoff = async (delayMs: number, abortSignal?: AbortSignal) => {
    try {
      await sleepWithAbort(delayMs, abortSignal);
    } catch (error) {
      const abortAction = resolveReplyOperationAbortAction(error);
      if (!abortAction) {
        throw error;
      }
      return abortAction;
    }
    return undefined;
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
      ? buildControlUiAgentFailureText(
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
  const isPureOverloadSummary =
    isFallbackSummary &&
    err.attempts.length > 0 &&
    err.attempts.every((attempt) => attempt.reason === "overloaded");
  const failoverReason = !isFallbackSummary && isFailoverError(err) ? err.reason : undefined;
  const isOverloaded = isFallbackSummary
    ? isPureOverloadSummary
    : failoverReason === "overloaded" || isOverloadedErrorMessage(message);
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

  const replyOperationAbortAction = resolveReplyOperationAbortAction(err);
  if (replyOperationAbortAction) {
    return replyOperationAbortAction;
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
  if (
    isOverloaded &&
    !params.overloadRetryState.unsafeToReplay &&
    params.overloadRetryState.retryCount < MAX_OVERLOAD_RETRIES
  ) {
    params.overloadRetryState.retryCount += 1;
    const retryCount = params.overloadRetryState.retryCount;
    const retryDelayMs = Math.min(
      OVERLOAD_RETRY_BASE_DELAY_MS * 2 ** (retryCount - 1),
      OVERLOAD_RETRY_MAX_DELAY_MS,
    );
    const retryAbortSignal = turn.replyOperation?.abortSignal ?? turn.opts?.abortSignal;
    const scheduleRetryNotice = () => {
      if (
        params.overloadRetryState.noticeSent ||
        params.overloadRetryState.noticeTimer ||
        params.overloadRetryState.completed ||
        retryAbortSignal?.aborted ||
        turn.isHeartbeat ||
        !turn.opts?.onBlockReply
      ) {
        return;
      }
      const deliver = turn.opts.onBlockReply;
      if (!deliver) {
        return;
      }
      const sendRetryNotice = () => {
        params.overloadRetryState.noticeTimer = undefined;
        if (
          params.overloadRetryState.noticeSent ||
          params.overloadRetryState.completed ||
          params.overloadRetryState.unsafeToReplay ||
          retryAbortSignal?.aborted
        ) {
          return;
        }
        params.overloadRetryState.noticeSent = true;
        turn.replyOperation?.recordActivity();
        const currentMessageId = turn.sessionCtx.MessageSidFull ?? turn.sessionCtx.MessageSid;
        const noticePayload = markReplyPayloadForSourceSuppressionDelivery(
          turn.applyReplyToMode({
            text: OVERLOAD_RETRY_NOTICE_TEXT,
            ...(currentMessageId ? { replyToId: currentMessageId } : {}),
            replyToCurrent: true,
            isStatusNotice: true,
          }),
        );
        const deliveryAbortController = new AbortController();
        params.overloadRetryState.noticeAbortController = deliveryAbortController;
        let deliveryTimeout: ReturnType<typeof setTimeout> | undefined;
        const deliveryAborted = new Promise<void>((resolve) => {
          deliveryAbortController.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        const deliveryTimedOut = new Promise<void>((resolve) => {
          deliveryTimeout = setTimeout(() => {
            deliveryAbortController.abort(new Error("overload retry notice delivery timed out"));
            resolve();
          }, OVERLOAD_RETRY_NOTICE_DELIVERY_TIMEOUT_MS);
        });
        const deliveryAttempt = Promise.resolve()
          .then(async () => {
            if (params.overloadRetryState.completed || deliveryAbortController.signal.aborted) {
              return;
            }
            await deliver(noticePayload, {
              abortSignal: deliveryAbortController.signal,
              timeoutMs: OVERLOAD_RETRY_NOTICE_DELIVERY_TIMEOUT_MS,
            });
          })
          .catch((noticeError: unknown) => {
            logVerbose(`overload retry notice delivery failed (non-fatal): ${String(noticeError)}`);
          });
        params.overloadRetryState.noticeDelivery = Promise.race([
          deliveryAttempt,
          deliveryAborted,
          deliveryTimedOut,
        ]).finally(() => {
          if (deliveryTimeout) {
            clearTimeout(deliveryTimeout);
          }
          if (params.overloadRetryState.noticeAbortController === deliveryAbortController) {
            params.overloadRetryState.noticeAbortController = undefined;
          }
        });
      };
      const noticeDelayMs = Math.max(
        0,
        OVERLOAD_RETRY_NOTICE_AFTER_MS - (Date.now() - params.overloadRetryState.turnStartedAtMs),
      );
      if (retryAbortSignal) {
        const abortNotice = () => {
          if (params.overloadRetryState.noticeTimer) {
            clearTimeout(params.overloadRetryState.noticeTimer);
            params.overloadRetryState.noticeTimer = undefined;
          }
          params.overloadRetryState.noticeAbortController?.abort(
            retryAbortSignal.reason ?? new Error("overload retry aborted"),
          );
        };
        retryAbortSignal.addEventListener("abort", abortNotice, { once: true });
        params.overloadRetryState.noticeAbortCleanup = () => {
          retryAbortSignal.removeEventListener("abort", abortNotice);
        };
      }
      if (noticeDelayMs === 0) {
        sendRetryNotice();
        return;
      }
      params.overloadRetryState.noticeTimer = setTimeout(() => {
        sendRetryNotice();
      }, noticeDelayMs);
    };
    scheduleRetryNotice();
    turn.replyOperation?.recordActivity();
    defaultRuntime.error(
      `Overloaded provider before reply (${sanitizeForLog(message)}). ` +
        `Retrying ${retryCount}/${MAX_OVERLOAD_RETRIES} in ${retryDelayMs}ms.`,
    );
    const abortAction = await waitForRetryBackoff(retryDelayMs, retryAbortSignal);
    if (abortAction) {
      return abortAction;
    }
    params.state.pendingLifecycleTerminal = undefined;
    turn.replyOperation?.recordActivity();
    return { kind: "retry" };
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
  if (
    isTransientHttp &&
    !params.overloadRetryState.unsafeToReplay &&
    params.consumeTransientHttpRetry()
  ) {
    params.state.pendingLifecycleTerminal = undefined;
    defaultRuntime.error(
      `Transient HTTP provider error before reply (${message}). Retrying once in ${TRANSIENT_HTTP_RETRY_DELAY_MS}ms.`,
    );
    const retryAbortSignal = turn.replyOperation?.abortSignal ?? turn.opts?.abortSignal;
    const abortAction = await waitForRetryBackoff(TRANSIENT_HTTP_RETRY_DELAY_MS, retryAbortSignal);
    if (abortAction) {
      return abortAction;
    }
    return { kind: "retry" };
  }
  defaultRuntime.error(`Embedded agent failed before reply: ${message}`);
  const isPureTransientSummary = isFallbackSummary ? isPureTransientRateLimitSummary(err) : false;
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
  const userFacingMessage = isTransientHttp
    ? sanitizeUserFacingText(message, { errorContext: true })
    : message;
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
            replayPrevented: params.overloadRetryState.unsafeToReplay,
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
            ? buildControlUiAgentFailureText(userFacingMessage)
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
