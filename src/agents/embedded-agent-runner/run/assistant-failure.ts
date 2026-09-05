import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { isTerminalAssistantError } from "../../../llm/utils/retry.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AuthProfileFailureReason, AuthProfileStore } from "../../auth-profiles.js";
import {
  classifyAssistantFailoverReason,
  type FailoverReason,
  isAuthAssistantError,
  isBillingAssistantError,
  isFailoverAssistantError,
  isRateLimitAssistantError,
  parseImageDimensionError,
  pickFallbackThinkingLevel,
} from "../../embedded-agent-helpers.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import { resolveRetryAfterMs } from "../../failover/retry-evidence.js";
import {
  resolveSessionSuspensionReason,
  type SessionSuspensionParams,
} from "../../session-suspension.js";
import { log } from "../logger.js";
import type { TraceAttempt } from "../types.js";
import { handleAssistantFailover, isShortWindowRateLimitMessage } from "./assistant-failover.js";
import { isCurrentAttemptReplaySafe } from "./attempt-terminal-evidence.js";
import { createFailoverDecisionLogger } from "./failover-observation.js";
import { resolveRunFailoverDecision } from "./failover-policy.js";
import { shouldRetrySilentErrorAssistantTurn } from "./incomplete-turn-recovery.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import {
  isEmbeddedRunTerminalInterrupted,
  type EmbeddedRunTerminalState,
} from "./terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const MAX_EMPTY_ERROR_RETRIES = 3;

type EmbeddedRunAssistantFailureOutcome = {
  action: "retry" | "proceed";
  thinkLevel: ThinkLevel;
  authRetryPending: boolean;
  emptyErrorRetries: number;
  overloadProfileRotations: number;
  lastRetryFailoverReason: FailoverReason | null;
  assistantProfileFailureReason: AuthProfileFailureReason | null;
};

export async function handleEmbeddedAssistantFailure(input: {
  runParams: RunEmbeddedAgentParams;
  attempt: EmbeddedRunAttemptResult;
  attemptAssistant?: AssistantMessage;
  currentAttemptAssistant?: AssistantMessage;
  terminalState: EmbeddedRunTerminalState;
  activeErrorContext: { provider: string; model: string };
  provider: string;
  providerOwner: PreparedProviderFailoverOwner | undefined;
  modelId: string;
  model: string;
  thinkLevel: ThinkLevel;
  // Profile rotation resets thinking inside the runtime; read it after advancing.
  getThinkLevel: () => ThinkLevel;
  attemptedThinking: Set<ThinkLevel>;
  fallbackConfigured: boolean;
  pluginHarnessOwnsTransport: boolean;
  authProfileId?: string;
  authProfileStore: AuthProfileStore;
  runtimeAuthRetry: boolean;
  maybeRefreshRuntimeAuthForAuthError: (errorText: string, retry: boolean) => Promise<boolean>;
  resolveAuthProfileFailureReason: (
    reason: FailoverReason | null,
    options?: { providerStarted?: boolean; transientRateLimit?: boolean },
  ) => AuthProfileFailureReason | null;
  emptyErrorRetries: number;
  overloadProfileRotations: number;
  overloadProfileRotationLimit: number;
  getTransientRetryCount: () => number;
  previousRetryFailoverReason: FailoverReason | null;
  maybeMarkAuthProfileFailure: (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
  }) => Promise<void>;
  maybeRetryTransient: Parameters<typeof handleAssistantFailover>[0]["maybeRetryTransient"];
  advanceAuthProfile: Parameters<typeof handleAssistantFailover>[0]["advanceAuthProfile"];
  advanceRateLimitAuthProfile: Parameters<
    typeof handleAssistantFailover
  >[0]["advanceRateLimitAuthProfile"];
  traceAttempts: TraceAttempt[];
  suspendForFailure: (params: SessionSuspensionParams) => void;
  suspensionSessionId: string;
  agentDir: string;
  isProbeSession: boolean;
}): Promise<EmbeddedRunAssistantFailureOutcome> {
  // Successful responses can retain stale error fields. Only current failures
  // may drive retries, profile health, or failure copy.
  const failedAssistant =
    input.attemptAssistant?.stopReason === "error" ? input.attemptAssistant : undefined;
  const { aborted, idleTimedOut, promptError, timedOut } = projectAgentRunAttemptTerminal(
    input.attempt.terminal,
  );
  const terminalInterrupted = isEmbeddedRunTerminalInterrupted(input.terminalState.outcome);
  const { signalOwnedInterruption } = input.terminalState;
  const fallbackThinking = pickFallbackThinkingLevel({
    message: failedAssistant?.errorMessage,
    attempted: input.attemptedThinking,
  });
  const authFailure = isAuthAssistantError(failedAssistant);
  const rateLimitFailure = isRateLimitAssistantError(failedAssistant);
  const billingFailure = isBillingAssistantError(failedAssistant);
  const failoverFailure = isFailoverAssistantError(failedAssistant);
  const assistantFailoverReason = classifyAssistantFailoverReason(failedAssistant, {
    providerOwner: input.providerOwner,
  });
  const assistantProviderStarted =
    Boolean(input.currentAttemptAssistant?.provider) ||
    input.terminalState.outcome.providerStarted === true;
  const assistantProfileFailoverReason =
    assistantFailoverReason ??
    (assistantProviderStarted && (timedOut || idleTimedOut) ? "timeout" : null);
  const assistantProfileFailureReason = input.resolveAuthProfileFailureReason(
    assistantProfileFailoverReason,
    {
      providerStarted: assistantProviderStarted,
      transientRateLimit:
        assistantProfileFailoverReason === "rate_limit" &&
        isShortWindowRateLimitMessage(failedAssistant?.errorMessage),
    },
  );
  const terminalAssistantError = isTerminalAssistantError(input.attemptAssistant);
  if (terminalAssistantError || !isCurrentAttemptReplaySafe(input.attempt)) {
    return buildOutcome(input, {
      action: "proceed",
      assistantProfileFailureReason: terminalAssistantError ? null : assistantProfileFailureReason,
    });
  }
  if (fallbackThinking && !terminalInterrupted) {
    log.warn(
      `unsupported thinking level for ${input.provider}/${input.modelId}; retrying with ${fallbackThinking}`,
    );
    return buildOutcome(input, {
      action: "retry",
      thinkLevel: fallbackThinking,
      assistantProfileFailureReason,
    });
  }
  const cloudCodeAssistFormatError = input.attempt.cloudCodeAssistFormatError;
  const imageDimensionError = parseImageDimensionError(failedAssistant?.errorMessage ?? "");
  // Classified reasons consult the failover retry controller so a zero-output
  // failure draws from the single transient budget instead of stacking silent
  // retries on top of it; only reasons the controller cannot classify use the
  // bounded local empty-error counter.
  const silentControllerConsultReason =
    assistantFailoverReason === "no_error_details" ||
    assistantFailoverReason === "unclassified" ||
    assistantFailoverReason === "unknown"
      ? null
      : assistantFailoverReason;
  const replaySafeSilentErrorFailure =
    !authFailure &&
    !rateLimitFailure &&
    !billingFailure &&
    !cloudCodeAssistFormatError &&
    !imageDimensionError &&
    !terminalInterrupted &&
    !promptError &&
    shouldRetrySilentErrorAssistantTurn({
      attempt: input.attempt,
      assistant: failedAssistant,
    });
  if (replaySafeSilentErrorFailure) {
    if (silentControllerConsultReason === null) {
      if (input.emptyErrorRetries < MAX_EMPTY_ERROR_RETRIES) {
        const emptyErrorRetries = input.emptyErrorRetries + 1;
        log.warn(
          `[empty-error-retry] stopReason=error non-visible-output; resubmitting ` +
            `attempt=${emptyErrorRetries}/${MAX_EMPTY_ERROR_RETRIES} ` +
            `provider=${failedAssistant?.provider ?? input.provider} ` +
            `model=${failedAssistant?.model ?? input.model} ` +
            `sessionKey=${input.runParams.sessionKey ?? input.runParams.sessionId}`,
        );
        return buildOutcome(input, {
          action: "retry",
          emptyErrorRetries,
          assistantProfileFailureReason,
        });
      }
    } else if (
      await input.maybeRetryTransient({
        reason: silentControllerConsultReason,
        retryAfterMs: resolveRetryAfterMs(failedAssistant?.errorMessage),
      })
    ) {
      log.warn(
        `[empty-error-retry] stopReason=error non-visible-output; transient ` +
          `reason=${silentControllerConsultReason} retrying same model ` +
          `provider=${failedAssistant?.provider ?? input.provider} ` +
          `model=${failedAssistant?.model ?? input.model} ` +
          `sessionKey=${input.runParams.sessionKey ?? input.runParams.sessionId}`,
      );
      return buildOutcome(input, {
        action: "retry",
        assistantProfileFailureReason,
      });
    }
  }

  // The bounded same-model retry already proved this attempt had no visible output
  // or replay-unsafe effects. Once those retries are exhausted, skip profile
  // rotation and let the configured model fallback recover the invisible failure.
  const exhaustedUnclassifiedSilentError =
    input.fallbackConfigured &&
    assistantFailoverReason === null &&
    replaySafeSilentErrorFailure &&
    input.emptyErrorRetries >= MAX_EMPTY_ERROR_RETRIES;
  const effectiveFailoverReason = exhaustedUnclassifiedSilentError
    ? ("unknown" as const)
    : assistantFailoverReason;

  const failedProfileId = input.authProfileId;
  const logFailoverDecision = createFailoverDecisionLogger({
    stage: "assistant",
    runId: input.runParams.runId,
    rawError: failedAssistant?.errorMessage?.trim(),
    failoverReason: effectiveFailoverReason,
    profileFailureReason: assistantProfileFailureReason,
    provider: input.activeErrorContext.provider,
    model: input.activeErrorContext.model,
    sourceProvider: failedAssistant?.provider ?? input.provider,
    sourceModel: failedAssistant?.model ?? input.modelId,
    profileId: failedProfileId,
    fallbackConfigured: input.fallbackConfigured,
    timedOut,
    aborted,
    retryCount: input.getTransientRetryCount(),
    profileRotationCount: input.overloadProfileRotations,
    attemptCount: input.traceAttempts.length + 1,
  });
  if (
    !signalOwnedInterruption &&
    authFailure &&
    (await input.maybeRefreshRuntimeAuthForAuthError(
      failedAssistant?.errorMessage ?? "",
      input.runtimeAuthRetry,
    ))
  ) {
    return buildOutcome(input, {
      action: "retry",
      authRetryPending: true,
      assistantProfileFailureReason,
    });
  }
  if (imageDimensionError && input.authProfileId) {
    const details = [
      imageDimensionError.messageIndex !== undefined
        ? `message=${imageDimensionError.messageIndex}`
        : null,
      imageDimensionError.contentIndex !== undefined
        ? `content=${imageDimensionError.contentIndex}`
        : null,
      imageDimensionError.maxDimensionPx !== undefined
        ? `limit=${imageDimensionError.maxDimensionPx}px`
        : null,
    ]
      .filter(Boolean)
      .join(" ");
    log.warn(
      `Profile ${input.authProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
    );
  }

  const initialDecision = exhaustedUnclassifiedSilentError
    ? ({ action: "fallback_model", reason: "unknown" } as const)
    : resolveRunFailoverDecision({
        stage: "assistant",
        allowFormatRetry: cloudCodeAssistFormatError,
        terminal: input.attempt.terminal,
        signalOwnedInterruption,
        fallbackConfigured: input.fallbackConfigured,
        failoverFailure,
        failoverReason: assistantFailoverReason,
        harnessOwnsTransport: input.pluginHarnessOwnsTransport,
        profileRotated: false,
      });
  const outcome = await handleAssistantFailover({
    initialDecision,
    terminal: input.attempt.terminal,
    signalOwnedInterruption,
    fallbackConfigured: input.fallbackConfigured,
    failoverFailure,
    failoverReason: assistantFailoverReason,
    harnessOwnsTransport: input.pluginHarnessOwnsTransport,
    assistantProfileFailureReason,
    lastProfileId: input.authProfileId,
    modelId: input.modelId,
    provider: input.provider,
    providerOwner: input.providerOwner,
    activeErrorContext: input.activeErrorContext,
    lastAssistant: failedAssistant,
    config: input.runParams.config,
    sessionKey: input.runParams.sessionKey ?? input.runParams.sessionId,
    agentId: input.runParams.agentId,
    authFailure,
    rateLimitFailure,
    billingFailure,
    authMode: input.authProfileId
      ? input.authProfileStore.profiles?.[input.authProfileId]?.type
      : undefined,
    cloudCodeAssistFormatError,
    isProbeSession: input.isProbeSession,
    overloadProfileRotations: input.overloadProfileRotations,
    overloadProfileRotationLimit: input.overloadProfileRotationLimit,
    getTransientRetryCount: input.getTransientRetryCount,
    previousRetryFailoverReason: input.previousRetryFailoverReason,
    logAssistantFailoverDecision: logFailoverDecision,
    warn: (message) => log.warn(message),
    maybeMarkAuthProfileFailure: input.maybeMarkAuthProfileFailure,
    maybeRetryTransient: input.maybeRetryTransient,
    advanceAuthProfile: input.advanceAuthProfile,
    advanceRateLimitAuthProfile: input.advanceRateLimitAuthProfile,
  });
  if (outcome.action === "retry") {
    const retryTraceResult =
      outcome.retryKind === "same_model_transient"
        ? effectiveFailoverReason === "timeout"
          ? "timeout"
          : "same_model_transient"
        : effectiveFailoverReason === "timeout"
          ? "timeout"
          : "rotate_profile";
    input.traceAttempts.push({
      provider: input.activeErrorContext.provider,
      model: input.activeErrorContext.model,
      result: retryTraceResult,
      ...(effectiveFailoverReason ? { reason: effectiveFailoverReason } : {}),
      stage: "assistant",
    });
    return buildOutcome(input, {
      action: "retry",
      thinkLevel:
        outcome.retryKind === "profile_rotation" ? input.getThinkLevel() : input.thinkLevel,
      overloadProfileRotations: outcome.overloadProfileRotations,
      lastRetryFailoverReason: outcome.lastRetryFailoverReason,
      assistantProfileFailureReason,
    });
  }
  if (outcome.action === "throw") {
    input.traceAttempts.push({
      provider: input.activeErrorContext.provider,
      model: input.activeErrorContext.model,
      result:
        effectiveFailoverReason === "timeout"
          ? "timeout"
          : initialDecision.action === "fallback_model"
            ? "fallback_model"
            : "error",
      ...(effectiveFailoverReason ? { reason: effectiveFailoverReason } : {}),
      stage: "assistant",
      ...(typeof outcome.error.status === "number" ? { status: outcome.error.status } : {}),
    });
    if (outcome.error.suspend) {
      input.suspendForFailure({
        cfg: input.runParams.config,
        agentDir: input.agentDir,
        sessionId: input.suspensionSessionId,
        reason: resolveSessionSuspensionReason(outcome.error.reason),
        failedProvider: outcome.error.provider ?? input.provider,
        failedModel: outcome.error.model ?? input.modelId,
      });
    }
    throw outcome.error;
  }
  return buildOutcome(input, {
    action: "proceed",
    overloadProfileRotations: outcome.overloadProfileRotations,
    assistantProfileFailureReason,
  });
}

function buildOutcome(
  input: Parameters<typeof handleEmbeddedAssistantFailure>[0],
  override: Partial<EmbeddedRunAssistantFailureOutcome> &
    Pick<EmbeddedRunAssistantFailureOutcome, "action" | "assistantProfileFailureReason">,
): EmbeddedRunAssistantFailureOutcome {
  return {
    action: override.action,
    thinkLevel: override.thinkLevel ?? input.thinkLevel,
    authRetryPending: override.authRetryPending ?? false,
    emptyErrorRetries: override.emptyErrorRetries ?? input.emptyErrorRetries,
    overloadProfileRotations: override.overloadProfileRotations ?? input.overloadProfileRotations,
    lastRetryFailoverReason: override.lastRetryFailoverReason ?? input.previousRetryFailoverReason,
    assistantProfileFailureReason: override.assistantProfileFailureReason,
  };
}
