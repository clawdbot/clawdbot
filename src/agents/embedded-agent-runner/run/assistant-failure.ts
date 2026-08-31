import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { isReplayUnsafeAssistantError } from "../../../llm/utils/retry.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AuthProfileFailureReason, AuthProfileStore } from "../../auth-profiles.js";
import {
  classifyAssistantFailoverReason,
  type FailoverReason,
  isAuthAssistantError,
  isBillingAssistantError,
  isFailoverAssistantError,
  isGenericUnknownStreamErrorMessage,
  isRateLimitAssistantError,
  parseImageDimensionError,
  pickFallbackThinkingLevel,
} from "../../embedded-agent-helpers.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import { hasOnlyAssistantReasoningContent } from "../../replay-turn-classification.js";
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
const MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 1;

type EmbeddedRunAssistantFailureOutcome = {
  action: "retry" | "proceed";
  thinkLevel: ThinkLevel;
  authRetryPending: boolean;
  emptyErrorRetries: number;
  overloadProfileRotations: number;
  sameModelIdleTimeoutRetries: number;
  lastRetryFailoverReason: FailoverReason | null;
  preserveSameModelRateLimitRetryCount: boolean;
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
  canRestartForLiveSwitch: boolean;
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
  sameModelIdleTimeoutRetries: number;
  previousRetryFailoverReason: FailoverReason | null;
  maybeMarkAuthProfileFailure: (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
  }) => Promise<void>;
  maybeRetrySameModelRateLimit: (retry?: { retryAfterSeconds?: number }) => Promise<boolean>;
  maybeBackoffBeforeOverloadFailover: (reason: FailoverReason | null) => Promise<void>;
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
  const { aborted, idleTimedOut, promptError, timedOut, timedOutDuringCompaction } =
    projectAgentRunAttemptTerminal(input.attempt.terminal);
  const terminalInterrupted = isEmbeddedRunTerminalInterrupted(input.terminalState.outcome);
  const { signalOwnedInterruption } = input.terminalState;
  const fallbackThinking = pickFallbackThinkingLevel({
    message: input.attemptAssistant?.errorMessage,
    attempted: input.attemptedThinking,
  });
  const authFailure = isAuthAssistantError(input.attemptAssistant);
  const rateLimitFailure = isRateLimitAssistantError(input.attemptAssistant);
  const billingFailure = isBillingAssistantError(input.attemptAssistant);
  const failoverFailure = isFailoverAssistantError(input.attemptAssistant);
  const assistantFailoverReason = classifyAssistantFailoverReason(input.attemptAssistant, {
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
        isShortWindowRateLimitMessage(input.attemptAssistant?.errorMessage),
    },
  );
  const replayUnsafeAssistantError = isReplayUnsafeAssistantError(input.attemptAssistant);
  if (replayUnsafeAssistantError || !isCurrentAttemptReplaySafe(input.attempt)) {
    return buildOutcome(input, {
      action: "proceed",
      assistantProfileFailureReason: replayUnsafeAssistantError
        ? null
        : assistantProfileFailureReason,
    });
  }
  if (fallbackThinking && !terminalInterrupted) {
    log.warn(
      `unsupported thinking level for ${input.provider}/${input.modelId}; retrying with ${fallbackThinking}`,
    );
    return buildOutcome(input, {
      action: "retry",
      thinkLevel: fallbackThinking,
      preserveSameModelRateLimitRetryCount: true,
      assistantProfileFailureReason,
    });
  }
  const cloudCodeAssistFormatError = input.attempt.cloudCodeAssistFormatError;
  const imageDimensionError = parseImageDimensionError(input.attemptAssistant?.errorMessage ?? "");
  const genericUnknownReasoningError =
    assistantFailoverReason === "timeout" &&
    isGenericUnknownStreamErrorMessage(input.attemptAssistant?.errorMessage ?? "") &&
    Boolean(input.attemptAssistant && hasOnlyAssistantReasoningContent(input.attemptAssistant));
  const silentErrorRetryReason =
    assistantFailoverReason === null ||
    genericUnknownReasoningError ||
    assistantFailoverReason === "no_error_details" ||
    assistantFailoverReason === "unclassified" ||
    assistantFailoverReason === "unknown" ||
    assistantFailoverReason === "server_error";
  const replaySafeSilentErrorFailure =
    !authFailure &&
    !rateLimitFailure &&
    !billingFailure &&
    !cloudCodeAssistFormatError &&
    !imageDimensionError &&
    !terminalInterrupted &&
    !promptError &&
    silentErrorRetryReason &&
    shouldRetrySilentErrorAssistantTurn({
      attempt: input.attempt,
      assistant: input.attemptAssistant,
    });
  if (replaySafeSilentErrorFailure && input.emptyErrorRetries < MAX_EMPTY_ERROR_RETRIES) {
    const emptyErrorRetries = input.emptyErrorRetries + 1;
    log.warn(
      `[empty-error-retry] stopReason=error non-visible-output; resubmitting ` +
        `attempt=${emptyErrorRetries}/${MAX_EMPTY_ERROR_RETRIES} ` +
        `provider=${input.attemptAssistant?.provider ?? input.provider} ` +
        `model=${input.attemptAssistant?.model ?? input.model} ` +
        `sessionKey=${input.runParams.sessionKey ?? input.runParams.sessionId}`,
    );
    return buildOutcome(input, {
      action: "retry",
      emptyErrorRetries,
      preserveSameModelRateLimitRetryCount: true,
      assistantProfileFailureReason,
    });
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
    rawError: input.attemptAssistant?.errorMessage?.trim(),
    failoverReason: effectiveFailoverReason,
    profileFailureReason: assistantProfileFailureReason,
    provider: input.activeErrorContext.provider,
    model: input.activeErrorContext.model,
    sourceProvider: input.attemptAssistant?.provider ?? input.provider,
    sourceModel: input.attemptAssistant?.model ?? input.modelId,
    profileId: failedProfileId,
    fallbackConfigured: input.fallbackConfigured,
    timedOut,
    aborted,
  });
  if (
    !signalOwnedInterruption &&
    authFailure &&
    (await input.maybeRefreshRuntimeAuthForAuthError(
      input.attemptAssistant?.errorMessage ?? "",
      input.runtimeAuthRetry,
    ))
  ) {
    return buildOutcome(input, {
      action: "retry",
      authRetryPending: true,
      preserveSameModelRateLimitRetryCount: true,
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
    allowSameModelIdleTimeoutRetry:
      timedOut &&
      idleTimedOut &&
      !timedOutDuringCompaction &&
      !input.fallbackConfigured &&
      input.canRestartForLiveSwitch &&
      input.sameModelIdleTimeoutRetries < MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES,
    assistantProfileFailureReason,
    lastProfileId: input.authProfileId,
    modelId: input.modelId,
    provider: input.provider,
    providerOwner: input.providerOwner,
    activeErrorContext: input.activeErrorContext,
    lastAssistant: input.attemptAssistant,
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
    previousRetryFailoverReason: input.previousRetryFailoverReason,
    logAssistantFailoverDecision: logFailoverDecision,
    warn: (message) => log.warn(message),
    maybeMarkAuthProfileFailure: input.maybeMarkAuthProfileFailure,
    maybeRetrySameModelRateLimit: input.maybeRetrySameModelRateLimit,
    maybeBackoffBeforeOverloadFailover: input.maybeBackoffBeforeOverloadFailover,
    advanceAuthProfile: input.advanceAuthProfile,
    advanceRateLimitAuthProfile: input.advanceRateLimitAuthProfile,
  });
  if (outcome.action === "retry") {
    const retryTraceResult =
      outcome.retryKind === "same_model_rate_limit"
        ? "same_model_rate_limit"
        : outcome.retryKind === "same_model_idle_timeout" || effectiveFailoverReason === "timeout"
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
      sameModelIdleTimeoutRetries:
        input.sameModelIdleTimeoutRetries +
        (outcome.retryKind === "same_model_idle_timeout" ? 1 : 0),
      lastRetryFailoverReason: outcome.lastRetryFailoverReason,
      preserveSameModelRateLimitRetryCount: outcome.retryKind === "same_model_rate_limit",
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
    sameModelIdleTimeoutRetries:
      override.sameModelIdleTimeoutRetries ?? input.sameModelIdleTimeoutRetries,
    lastRetryFailoverReason: override.lastRetryFailoverReason ?? input.previousRetryFailoverReason,
    preserveSameModelRateLimitRetryCount: override.preserveSameModelRateLimitRetryCount ?? false,
    assistantProfileFailureReason: override.assistantProfileFailureReason,
  };
}
