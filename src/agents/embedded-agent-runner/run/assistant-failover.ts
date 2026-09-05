import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AssistantMessage } from "../../../llm/types.js";
import {
  projectAgentRunAttemptTerminal,
  type AgentRunAttemptTerminal,
} from "../../agent-run-terminal-outcome.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import {
  formatBillingErrorMessage,
  formatUserFacingAssistantErrorText,
  GENERIC_ASSISTANT_ERROR_TEXT,
  isTimeoutErrorMessage,
  type FailoverReason,
} from "../../embedded-agent-helpers.js";
import { buildAssistantFailoverSignal } from "../../embedded-agent-helpers/assistant-message-failures.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import { classifyRateLimitWindow, resolveRetryAfterMs } from "../../failover/retry-evidence.js";
import {
  mergeRetryFailoverReason,
  resolveRunFailoverDecision,
  type AssistantFailoverDecision,
} from "./failover-policy.js";
import type { EmbeddedRunTerminalState } from "./terminal-outcome.js";

type AssistantFailoverOutcome =
  | {
      action: "continue_normal";
      overloadProfileRotations: number;
    }
  | {
      action: "retry";
      overloadProfileRotations: number;
      lastRetryFailoverReason: FailoverReason | null;
      retryKind: "profile_rotation" | "same_model_transient";
    }
  | {
      action: "throw";
      overloadProfileRotations: number;
      error: FailoverError;
    };
export function isShortWindowRateLimitMessage(message: string | undefined): boolean {
  return classifyRateLimitWindow(message).kind === "short";
}

/**
 * Applies an assistant-stage failover decision and returns the next run action.
 * It owns auth-profile rotation, overload/rate-limit escalation, same-model
 * idle-timeout retry, and FailoverError construction for outer model fallback.
 */
export async function handleAssistantFailover(params: {
  initialDecision: AssistantFailoverDecision;
  terminal: AgentRunAttemptTerminal;
  terminalState: EmbeddedRunTerminalState;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  harnessOwnsTransport: boolean;
  assistantProfileFailureReason: AuthProfileFailureReason | null;
  lastProfileId?: string;
  modelId: string;
  provider: string;
  providerOwner?: PreparedProviderFailoverOwner;
  activeErrorContext: { provider: string; model: string };
  lastAssistant: AssistantMessage | undefined;
  config: OpenClawConfig | undefined;
  sessionKey?: string;
  agentId?: string;
  authFailure: boolean;
  rateLimitFailure: boolean;
  billingFailure: boolean;
  /** Credential auth mode (e.g. "oauth", "token", "api_key") for billing copy (#80877). */
  authMode?: string;
  cloudCodeAssistFormatError: boolean;
  isProbeSession: boolean;
  overloadProfileRotations: number;
  overloadProfileRotationLimit: number;
  getTransientRetryCount: () => number;
  previousRetryFailoverReason: FailoverReason | null;
  logAssistantFailoverDecision: (
    decision:
      | "rotate_profile"
      | "fallback_model"
      | "surface_error"
      | "retry_same_model"
      | "continue_normal",
    extra?: { status?: number; retryCount?: number; profileRotationCount?: number },
  ) => void;
  warn: (message: string) => void;
  maybeMarkAuthProfileFailure: (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
  }) => Promise<void>;
  maybeRetryTransient: (retry: {
    reason: FailoverReason;
    retryAfterMs?: number;
  }) => Promise<boolean>;
  advanceAuthProfile: () => Promise<boolean>;
  advanceRateLimitAuthProfile: (context: {
    failoverProvider: string;
    failoverModel: string;
    logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
  }) => Promise<boolean>;
}): Promise<AssistantFailoverOutcome> {
  const terminal = projectAgentRunAttemptTerminal(params.terminal);
  const { outcome: terminalOutcome, signalOwnedInterruption } = params.terminalState;
  // Routing reasons group several HTTP failures; retain the provider's status
  // when constructing the error so fallback summaries do not invent a timeout.
  const assistantStatus = params.lastAssistant
    ? buildAssistantFailoverSignal(params.lastAssistant).status
    : undefined;
  const externalAbort = terminal.externalAbort || signalOwnedInterruption;
  let overloadProfileRotations = params.overloadProfileRotations;
  let decision = params.initialDecision;
  const logDecision = (
    action: Parameters<typeof params.logAssistantFailoverDecision>[0],
    extra?: { status?: number },
  ) =>
    params.logAssistantFailoverDecision(action, {
      ...extra,
      retryCount: params.getTransientRetryCount(),
      profileRotationCount: overloadProfileRotations,
    });
  const retryOutcome = (
    retryKind: "profile_rotation" | "same_model_transient",
  ): AssistantFailoverOutcome => ({
    action: "retry",
    overloadProfileRotations,
    retryKind,
    lastRetryFailoverReason: mergeRetryFailoverReason({
      previous: params.previousRetryFailoverReason,
      failoverReason: params.failoverReason,
      timedOut: terminal.timedOut,
    }),
  });

  const canRetryRateLimit =
    params.failoverReason !== "rate_limit" ||
    isShortWindowRateLimitMessage(params.lastAssistant?.errorMessage);
  // A silent idle timeout carries no classifiable provider error, so it
  // arrives with a null reason; consult the retry owner as a timeout so the
  // quiet same-model replay stays budgeted by the single transient owner
  // (the idle-timeout breaker still caps consecutive silent attempts).
  const transientConsultReason =
    params.failoverReason ?? (terminal.idleTimedOut ? "timeout" : null);
  if (
    !externalAbort &&
    canRetryRateLimit &&
    transientConsultReason &&
    decision.action !== "continue_normal" &&
    (await params.maybeRetryTransient({
      reason: transientConsultReason,
      retryAfterMs: resolveRetryAfterMs(params.lastAssistant?.errorMessage),
    }))
  ) {
    logDecision("retry_same_model");
    return retryOutcome("same_model_transient");
  }

  if (decision.action === "rotate_profile") {
    const failedProfileId = params.lastProfileId;
    const failureReason = params.assistantProfileFailureReason;
    const markFailedProfile = async () => {
      if (!failureReason) {
        return;
      }
      try {
        await params.maybeMarkAuthProfileFailure({
          profileId: failedProfileId,
          reason: failureReason,
          modelId: params.modelId,
        });
      } catch (err) {
        params.warn(`profile failure mark failed: ${String(err)}`);
      }
    };

    if (params.failoverReason === "overloaded") {
      overloadProfileRotations += 1;
      if (
        overloadProfileRotations > params.overloadProfileRotationLimit &&
        params.fallbackConfigured
      ) {
        const status = assistantStatus ?? resolveFailoverStatus("overloaded");
        params.warn(
          `overload profile rotation cap reached for ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.modelId)} after ${overloadProfileRotations} rotations; escalating to model fallback`,
        );
        await markFailedProfile();
        logDecision("fallback_model", { status });
        return {
          action: "throw",
          overloadProfileRotations,
          error: new FailoverError(
            "The AI service is temporarily overloaded. Please try again in a moment.",
            {
              reason: "overloaded",
              provider: params.activeErrorContext.provider,
              model: params.activeErrorContext.model,
              profileId: params.lastProfileId,
              status,
              rawError: params.lastAssistant?.errorMessage?.trim(),
            },
          ),
        };
      }
    }

    let rotated: boolean;
    if (params.failoverReason === "rate_limit") {
      // Minute-scale RPM windows can clear without spending a profile rotation
      // or model fallback. Keep the retry bounded; once exhausted, continue
      // through the existing rate-limit escalation path.
      rotated = await params.advanceRateLimitAuthProfile({
        failoverProvider: params.activeErrorContext.provider,
        failoverModel: params.activeErrorContext.model,
        logFallbackDecision: params.logAssistantFailoverDecision,
      });
    } else {
      rotated = await params.advanceAuthProfile();
    }

    const markFailedProfilePromise = markFailedProfile();
    if (terminal.timedOut && !params.isProbeSession && failedProfileId) {
      const timeoutLabel = terminal.idleTimedOut ? "idle timeout (model silent)" : "timed out";
      // Only promise a next account when one was actually selected. Credentials
      // that config does not authorize are not rotation targets, so this can end
      // with no further account even when one exists in the environment.
      params.warn(
        rotated
          ? `Profile ${failedProfileId} ${timeoutLabel}. Trying next account...`
          : `Profile ${failedProfileId} ${timeoutLabel}. No further authorized account for this provider; create a backup auth profile and add its id to auth.order to enable failover.`,
      );
    }
    if (params.cloudCodeAssistFormatError && failedProfileId) {
      params.warn(
        `Profile ${failedProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
      );
    }
    if (rotated) {
      // Marking the failed profile is non-blocking after rotation succeeds; the
      // retry can proceed with the next profile while the failure record settles.
      logDecision("rotate_profile");
      return retryOutcome("profile_rotation");
    }
    await markFailedProfilePromise;
    decision = resolveRunFailoverDecision({
      stage: "assistant",
      allowFormatRetry: params.cloudCodeAssistFormatError,
      terminal: params.terminal,
      signalOwnedInterruption,
      fallbackConfigured: params.fallbackConfigured,
      failoverFailure: params.failoverFailure,
      failoverReason: params.failoverReason,
      harnessOwnsTransport: params.harnessOwnsTransport,
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
    (decision.action === "surface_error" &&
      !externalAbort &&
      !terminal.timedOut &&
      params.failoverFailure)
  ) {
    const message = resolveAssistantFailoverErrorMessage(params);
    const reason = resolveSurfaceErrorReason(decision.reason, params);
    const status =
      assistantStatus ??
      resolveFailoverStatus(reason) ??
      (isTimeoutErrorMessage(message) ? 408 : undefined);
    if (decision.action === "fallback_model") {
      logDecision("fallback_model", { status });
    }
    return {
      action: "throw",
      overloadProfileRotations,
      error: new FailoverError(message, {
        reason,
        provider: params.activeErrorContext.provider,
        model: params.activeErrorContext.model,
        profileId: params.lastProfileId,
        authMode: params.authMode,
        status,
        rawError: params.lastAssistant?.errorMessage?.trim(),
        // Retry reason "timeout" also includes 5xx; only the terminal owner records a deadline.
        timeout:
          terminalOutcome.status === "timeout"
            ? {
                timeoutPhase: terminalOutcome.timeoutPhase,
                providerStarted: terminalOutcome.providerStarted,
              }
            : undefined,
        suspend: Boolean(params.sessionKey) && (reason === "rate_limit" || reason === "billing"),
      }),
    };
  }

  logDecision("continue_normal");
  return {
    action: "continue_normal",
    overloadProfileRotations,
  };
}

function resolveAssistantFailoverErrorMessage(params: {
  lastAssistant: AssistantMessage | undefined;
  config: OpenClawConfig | undefined;
  sessionKey?: string;
  agentId?: string;
  activeErrorContext: { provider: string; model: string };
  providerOwner?: PreparedProviderFailoverOwner;
  terminal: AgentRunAttemptTerminal;
  rateLimitFailure: boolean;
  billingFailure: boolean;
  authFailure: boolean;
  /** Credential auth mode passed through to billing copy formatter (#80877). */
  authMode?: string;
}): string {
  const timeoutFailure =
    params.terminal.kind === "timeout" && params.terminal.source !== "observation";
  return (
    (params.lastAssistant
      ? formatUserFacingAssistantErrorText(params.lastAssistant, {
          cfg: params.config,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          provider: params.activeErrorContext.provider,
          providerOwner: params.providerOwner,
          model: params.activeErrorContext.model,
          authMode: params.authMode,
        })
      : undefined) ||
    params.lastAssistant?.errorMessage?.trim() ||
    (timeoutFailure
      ? "LLM request timed out."
      : params.rateLimitFailure
        ? "LLM request rate limited."
        : params.billingFailure
          ? formatBillingErrorMessage(
              params.activeErrorContext.provider,
              params.activeErrorContext.model,
              params.authMode,
            )
          : params.authFailure
            ? "LLM request unauthorized."
            : GENERIC_ASSISTANT_ERROR_TEXT)
  );
}

function resolveSurfaceErrorReason(
  declared: FailoverReason | null,
  params: {
    billingFailure: boolean;
    authFailure: boolean;
    rateLimitFailure: boolean;
  },
): FailoverReason {
  if (declared) {
    return declared;
  }
  if (params.billingFailure) {
    return "billing";
  }
  if (params.authFailure) {
    return "auth";
  }
  if (params.rateLimitFailure) {
    return "rate_limit";
  }
  return "unknown";
}
