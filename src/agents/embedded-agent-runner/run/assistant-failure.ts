import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import { classifyGatewayStorageFailure } from "../../../infra/sqlite-error-diagnostics.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { isTerminalAssistantError } from "../../../llm/utils/retry.js";
import { projectAgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { AuthProfileFailureReason, AuthProfileStore } from "../../auth-profiles.js";
import {
  classifyAssistantFailoverReason,
  type FailoverReason,
  formatBillingErrorMessage,
  formatUserFacingAssistantErrorText,
  GENERIC_ASSISTANT_ERROR_TEXT,
  isTimeoutErrorMessage,
  isAuthAssistantError,
  isBillingAssistantError,
  isFailoverAssistantError,
  isRateLimitAssistantError,
  parseImageDimensionError,
  pickFallbackThinkingLevel,
} from "../../embedded-agent-helpers.js";
import { buildAssistantFailoverSignal } from "../../embedded-agent-helpers/assistant-message-failures.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import { classifyRateLimitWindow } from "../../failover/retry-evidence.js";
import {
  resolveSessionSuspensionReason,
  type SessionSuspensionParams,
} from "../../session-suspension.js";
import { log } from "../logger.js";
import type { TraceAttempt } from "../types.js";
import { isCurrentAttemptReplaySafe } from "./attempt-terminal-evidence.js";
import { createFailoverDecisionLogger } from "./failover-observation.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./failover-policy.js";
import type { EmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";
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
  failover: Pick<
    EmbeddedRunFailoverRetryController,
    | "resolveAuthProfileFailureReason"
    | "maybeMarkAuthProfileFailure"
    | "advanceAuthProfile"
    | "advanceRateLimitAuthProfile"
    | "transientRetryCount"
    | "overloadProfileRotationLimit"
  >;
  emptyErrorRetries: number;
  overloadProfileRotations: number;
  previousRetryFailoverReason: FailoverReason | null;
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
  if (classifyGatewayStorageFailure(failedAssistant)) {
    return buildOutcome(input, { action: "proceed", assistantProfileFailureReason: null });
  }
  const {
    aborted,
    externalAbort: projectedExternalAbort,
    idleTimedOut,
    promptError,
    timedOut,
  } = projectAgentRunAttemptTerminal(input.attempt.terminal);
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
  const assistantProfileFailureReason = input.failover.resolveAuthProfileFailureReason(
    assistantProfileFailoverReason,
    {
      providerStarted: assistantProviderStarted,
      transientRateLimit:
        assistantProfileFailoverReason === "rate_limit" &&
        classifyRateLimitWindow(failedAssistant?.errorMessage).kind === "short",
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
  // Transient failures already consumed their recovery budget. Only unclassified
  // empty errors use this separate response-repair limit.
  const unclassifiedError =
    assistantFailoverReason === null ||
    assistantFailoverReason === "no_error_details" ||
    assistantFailoverReason === "unclassified" ||
    assistantFailoverReason === "unknown";
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
  if (
    replaySafeSilentErrorFailure &&
    unclassifiedError &&
    input.emptyErrorRetries < MAX_EMPTY_ERROR_RETRIES
  ) {
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
    profileId: input.authProfileId,
    fallbackConfigured: input.fallbackConfigured,
    timedOut,
    aborted,
    retryCount: input.failover.transientRetryCount,
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
  const authMode = input.authProfileId
    ? input.authProfileStore.profiles?.[input.authProfileId]?.type
    : undefined;
  const terminalOutcome = input.terminalState.outcome;
  // Routing reasons group several HTTP failures; retain the provider's status
  // when constructing the error so fallback summaries do not invent a timeout.
  const assistantStatus = failedAssistant
    ? buildAssistantFailoverSignal(failedAssistant).status
    : undefined;
  const externalAbort = projectedExternalAbort || signalOwnedInterruption;
  let overloadProfileRotations = input.overloadProfileRotations;
  let decision = initialDecision;
  const logDecision = (
    action: Parameters<typeof logFailoverDecision>[0],
    extra?: { status?: number },
  ) =>
    logFailoverDecision(action, {
      ...extra,
      retryCount: input.failover.transientRetryCount,
      profileRotationCount: overloadProfileRotations,
    });
  const throwFailure = (error: FailoverError): never => {
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
      ...(typeof error.status === "number" ? { status: error.status } : {}),
    });
    if (error.suspend) {
      input.suspendForFailure({
        cfg: input.runParams.config,
        agentDir: input.agentDir,
        sessionId: input.suspensionSessionId,
        reason: resolveSessionSuspensionReason(error.reason),
        failedProvider: error.provider ?? input.provider,
        failedModel: error.model ?? input.modelId,
      });
    }
    throw error;
  };

  if (decision.action === "rotate_profile") {
    const failedProfileId = input.authProfileId;
    const failureReason = assistantProfileFailureReason;
    const markFailedProfile = async () => {
      if (!failureReason) {
        return;
      }
      try {
        await input.failover.maybeMarkAuthProfileFailure({
          profileId: failedProfileId,
          reason: failureReason,
          modelId: input.modelId,
        });
      } catch (err) {
        log.warn(`profile failure mark failed: ${String(err)}`);
      }
    };

    if (assistantFailoverReason === "overloaded") {
      overloadProfileRotations += 1;
      if (
        overloadProfileRotations > input.failover.overloadProfileRotationLimit &&
        input.fallbackConfigured
      ) {
        const status = assistantStatus ?? resolveFailoverStatus("overloaded");
        log.warn(
          `overload profile rotation cap reached for ${sanitizeForLog(input.provider)}/${sanitizeForLog(input.modelId)} after ${overloadProfileRotations} rotations; escalating to model fallback`,
        );
        await markFailedProfile();
        logDecision("fallback_model", { status });
        throwFailure(
          new FailoverError(
            "The AI service is temporarily overloaded. Please try again in a moment.",
            {
              reason: "overloaded",
              provider: input.activeErrorContext.provider,
              model: input.activeErrorContext.model,
              profileId: input.authProfileId,
              status,
              rawError: failedAssistant?.errorMessage?.trim(),
            },
          ),
        );
      }
    }

    let rotated: boolean;
    if (assistantFailoverReason === "rate_limit") {
      rotated = await input.failover.advanceRateLimitAuthProfile({
        failoverProvider: input.activeErrorContext.provider,
        failoverModel: input.activeErrorContext.model,
        logFallbackDecision: logFailoverDecision,
      });
    } else {
      rotated = await input.failover.advanceAuthProfile();
    }

    const markFailedProfilePromise = markFailedProfile();
    if (timedOut && !input.isProbeSession && failedProfileId) {
      const timeoutLabel = idleTimedOut ? "idle timeout (model silent)" : "timed out";
      // Only promise a next account when one was actually selected. Credentials
      // that config does not authorize are not rotation targets, so this can end
      // with no further account even when one exists in the environment.
      log.warn(
        rotated
          ? `Profile ${failedProfileId} ${timeoutLabel}. Trying next account...`
          : `Profile ${failedProfileId} ${timeoutLabel}. No further authorized account for this provider; create a backup auth profile and add its id to auth.order to enable failover.`,
      );
    }
    if (cloudCodeAssistFormatError && failedProfileId) {
      log.warn(
        `Profile ${failedProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
      );
    }
    if (rotated) {
      // Marking the failed profile is non-blocking after rotation succeeds; the
      // retry can proceed with the next profile while the failure record settles.
      logDecision("rotate_profile");
      input.traceAttempts.push({
        provider: input.activeErrorContext.provider,
        model: input.activeErrorContext.model,
        result: effectiveFailoverReason === "timeout" ? "timeout" : "rotate_profile",
        ...(effectiveFailoverReason ? { reason: effectiveFailoverReason } : {}),
        stage: "assistant",
      });
      return buildOutcome(input, {
        action: "retry",
        thinkLevel: input.getThinkLevel(),
        overloadProfileRotations,
        lastRetryFailoverReason: mergeRetryFailoverReason({
          previous: input.previousRetryFailoverReason,
          failoverReason: assistantFailoverReason,
          timedOut,
        }),
        assistantProfileFailureReason,
      });
    }
    await markFailedProfilePromise;
    decision = resolveRunFailoverDecision({
      stage: "assistant",
      allowFormatRetry: cloudCodeAssistFormatError,
      terminal: input.attempt.terminal,
      signalOwnedInterruption,
      fallbackConfigured: input.fallbackConfigured,
      failoverFailure,
      failoverReason: assistantFailoverReason,
      harnessOwnsTransport: input.pluginHarnessOwnsTransport,
      profileRotated: true,
    });
  }

  if (decision.action === "surface_error") {
    logDecision("surface_error");
  }
  // Surface only current provider failures; aborts, timeout payload synthesis,
  // and stale classified text retain the normal payload path.
  if (
    decision.action === "fallback_model" ||
    (decision.action === "surface_error" && !externalAbort && !timedOut && failoverFailure)
  ) {
    const message =
      (failedAssistant
        ? formatUserFacingAssistantErrorText(failedAssistant, {
            cfg: input.runParams.config,
            sessionKey: input.runParams.sessionKey ?? input.runParams.sessionId,
            agentId: input.runParams.agentId,
            provider: input.activeErrorContext.provider,
            providerOwner: input.providerOwner,
            model: input.activeErrorContext.model,
            authMode,
          })
        : undefined) ||
      failedAssistant?.errorMessage?.trim() ||
      (timedOut
        ? "LLM request timed out."
        : rateLimitFailure
          ? "LLM request rate limited."
          : billingFailure
            ? formatBillingErrorMessage(
                input.activeErrorContext.provider,
                input.activeErrorContext.model,
                authMode,
              )
            : authFailure
              ? "LLM request unauthorized."
              : GENERIC_ASSISTANT_ERROR_TEXT);
    const reason =
      decision.reason ??
      (billingFailure
        ? "billing"
        : authFailure
          ? "auth"
          : rateLimitFailure
            ? "rate_limit"
            : "unknown");
    const status =
      assistantStatus ??
      resolveFailoverStatus(reason) ??
      (isTimeoutErrorMessage(message) ? 408 : undefined);
    if (decision.action === "fallback_model") {
      logDecision("fallback_model", { status });
    }
    throwFailure(
      new FailoverError(message, {
        reason,
        provider: input.activeErrorContext.provider,
        model: input.activeErrorContext.model,
        profileId: input.authProfileId,
        authMode,
        status,
        rawError: failedAssistant?.errorMessage?.trim(),
        // Retry reason "timeout" also includes 5xx; only the terminal owner records a deadline.
        timeout:
          terminalOutcome.status === "timeout"
            ? {
                timeoutPhase: terminalOutcome.timeoutPhase,
                providerStarted: terminalOutcome.providerStarted,
              }
            : undefined,
        suspend:
          Boolean(input.runParams.sessionKey ?? input.runParams.sessionId) &&
          (reason === "rate_limit" || reason === "billing"),
      }),
    );
  }

  logDecision("continue_normal");
  return buildOutcome(input, {
    action: "proceed",
    overloadProfileRotations,
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
