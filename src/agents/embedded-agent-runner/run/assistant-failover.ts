/**
 * Handles assistant-stage failover decisions during embedded-agent attempts.
 */
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { extractLeadingHttpStatus } from "../../../shared/assistant-error-format.js";
import type { AuthProfileFailureReason } from "../../auth-profiles.js";
import {
  formatAssistantErrorText,
  formatBillingErrorMessage,
  isTimeoutErrorMessage,
  type FailoverReason,
} from "../../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../../failover-error.js";
import {
  mergeRetryFailoverReason,
  resolveRunFailoverDecision,
  type AssistantFailoverDecision,
} from "./failover-policy.js";

type AssistantFailoverOutcome =
  | {
      action: "continue_normal";
      overloadProfileRotations: number;
    }
  | {
      action: "retry";
      overloadProfileRotations: number;
      lastRetryFailoverReason: FailoverReason | null;
      retryKind?: "same_model_idle_timeout" | "same_model_rate_limit";
    }
  | {
      action: "throw";
      overloadProfileRotations: number;
      error: FailoverError;
    };
type ShortWindowRateLimitRetry = {
  retryAfterSeconds?: number;
};

const LONG_WINDOW_RATE_LIMIT_RE =
  /\b(?:daily|weekly|monthly|tokens per day|requests per day|usage limit|subscription|insufficient[_ -]?quota|current quota|quota[_ -]?exceeded|quota exceeded)\b/i;
const SHORT_RATE_LIMIT_WINDOW_RE =
  /\b(?:requests per minute|tokens per minute|per-minute|rpm|tpm)\b/i;
const SHORT_WINDOW_RATE_LIMIT_RE =
  /\b(?:requests per minute|tokens per minute|per-minute|rpm|tpm|model_cooldown)\b|请求过于频繁|调用频率|频率限制/i;
const RETRY_AFTER_VALUE_RE = /\bretry[- ]after\b\s*:?\s*(?:in\s*)?([^\r\n;]+)/i;
const RETRY_AFTER_SECONDS_RE =
  /^(\d+(?:\.\d+)?)(?:\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m))?\b/i;
const MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS = 60;

function parseRetryAfterSeconds(message: string): number | null {
  const valueText = RETRY_AFTER_VALUE_RE.exec(message)?.[1]?.trim();
  if (!valueText) {
    return null;
  }
  const secondsMatch = RETRY_AFTER_SECONDS_RE.exec(valueText);
  if (secondsMatch?.[1]) {
    const value = Number(secondsMatch[1]);
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    const unit = secondsMatch[2]?.toLowerCase();
    if (
      unit?.startsWith("m") &&
      unit !== "ms" &&
      !unit.startsWith("msec") &&
      !unit.startsWith("millisecond")
    ) {
      return value * 60;
    }
    if (unit === "ms" || unit?.startsWith("msec") || unit?.startsWith("millisecond")) {
      return value / 1000;
    }
    return value;
  }
  const retryAtMs = Date.parse(valueText);
  if (!Number.isFinite(retryAtMs)) {
    return null;
  }
  return Math.max(0, (retryAtMs - Date.now()) / 1000);
}

function resolveShortWindowRateLimitRetry(
  message: string | undefined,
): ShortWindowRateLimitRetry | null {
  const raw = message?.trim();
  if (!raw) {
    return null;
  }
  const retryAfterSeconds = parseRetryAfterSeconds(raw);
  if (retryAfterSeconds !== null && retryAfterSeconds > MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS) {
    return null;
  }
  const shortRetryAfter =
    retryAfterSeconds !== null && retryAfterSeconds <= MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS;
  const hasShortWindowSignal = SHORT_RATE_LIMIT_WINDOW_RE.test(raw);
  if (RETRY_AFTER_VALUE_RE.test(raw) && retryAfterSeconds === null && !hasShortWindowSignal) {
    return null;
  }
  if (LONG_WINDOW_RATE_LIMIT_RE.test(raw) && !hasShortWindowSignal && !shortRetryAfter) {
    return null;
  }
  // Providers such as Gemini use quota wording for per-minute RPM/TPM
  // throttles. Treat quota as long-window only when no short-window hint is
  // present; hard daily/usage/subscription limits are filtered above.
  // Some gateways strip throttle details and Retry-After. Preserve the
  // long-window exclusions above before treating a bare 429 as transient.
  const statusPrefixed429 = extractLeadingHttpStatus(raw)?.code === 429;
  if (!SHORT_WINDOW_RATE_LIMIT_RE.test(raw) && !shortRetryAfter && !statusPrefixed429) {
    return null;
  }
  return retryAfterSeconds !== null ? { retryAfterSeconds } : {};
}

export function isShortWindowRateLimitMessage(message: string | undefined): boolean {
  return resolveShortWindowRateLimitRetry(message) !== null;
}

/**
 * Applies an assistant-stage failover decision and returns the next run action.
 * It owns auth-profile rotation, overload/rate-limit escalation, same-model
 * idle-timeout retry, and FailoverError construction for outer model fallback.
 */
export async function handleAssistantFailover(params: {
  initialDecision: AssistantFailoverDecision;
  aborted: boolean;
  externalAbort: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  timedOut: boolean;
  idleTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  timedOutDuringToolExecution: boolean;
  timedOutByRunBudget: boolean;
  allowSameModelIdleTimeoutRetry: boolean;
  allowSameModelRateLimitRetry: boolean;
  assistantProfileFailureReason: AuthProfileFailureReason | null;
  lastProfileId?: string;
  modelId: string;
  provider: string;
  activeErrorContext: { provider: string; model: string };
  lastAssistant: AssistantMessage | undefined;
  config: OpenClawConfig | undefined;
  sessionKey?: string;
  authFailure: boolean;
  rateLimitFailure: boolean;
  billingFailure: boolean;
  /** Credential auth mode (e.g. "oauth", "token", "api_key") for billing copy (#80877). */
  authMode?: string;
  cloudCodeAssistFormatError: boolean;
  isProbeSession: boolean;
  overloadProfileRotations: number;
  overloadProfileRotationLimit: number;
  previousRetryFailoverReason: FailoverReason | null;
  logAssistantFailoverDecision: (
    decision: "rotate_profile" | "fallback_model" | "surface_error",
    extra?: { status?: number },
  ) => void;
  warn: (message: string) => void;
  maybeMarkAuthProfileFailure: (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
  }) => Promise<void>;
  maybeEscalateRateLimitProfileFallback: (params: {
    failoverProvider: string;
    failoverModel: string;
    logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
  }) => void;
  maybeRetrySameModelRateLimit: (retry?: ShortWindowRateLimitRetry) => Promise<boolean>;
  maybeBackoffBeforeOverloadFailover: (reason: FailoverReason | null) => Promise<void>;
  advanceAuthProfile: () => Promise<boolean>;
}): Promise<AssistantFailoverOutcome> {
  let overloadProfileRotations = params.overloadProfileRotations;
  let decision = params.initialDecision;
  const sameModelIdleTimeoutRetry = (): AssistantFailoverOutcome => {
    params.warn(
      `[llm-idle-timeout] ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.modelId)} produced no reply before the idle watchdog; retrying same model`,
    );
    return {
      action: "retry",
      overloadProfileRotations,
      retryKind: "same_model_idle_timeout",
      lastRetryFailoverReason: mergeRetryFailoverReason({
        previous: params.previousRetryFailoverReason,
        failoverReason: params.failoverReason,
        timedOut: true,
      }),
    };
  };
  const sameModelRateLimitRetry = (): AssistantFailoverOutcome => ({
    action: "retry",
    overloadProfileRotations,
    retryKind: "same_model_rate_limit",
    lastRetryFailoverReason: mergeRetryFailoverReason({
      previous: params.previousRetryFailoverReason,
      failoverReason: params.failoverReason,
      timedOut: params.timedOut || params.idleTimedOut,
    }),
  });

  if (decision.action === "rotate_profile") {
    const failedProfileId = params.lastProfileId;
    const timeoutFailure = params.timedOut || params.idleTimedOut;
    const failureReason = params.assistantProfileFailureReason;
    const markFailedProfile = async () => {
      if (!failedProfileId || !failureReason) {
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
        const status = resolveFailoverStatus("overloaded");
        params.warn(
          `overload profile rotation cap reached for ${sanitizeForLog(params.provider)}/${sanitizeForLog(params.modelId)} after ${overloadProfileRotations} rotations; escalating to model fallback`,
        );
        await markFailedProfile();
        params.logAssistantFailoverDecision("fallback_model", { status });
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

    if (params.failoverReason === "rate_limit") {
      // Minute-scale RPM windows can clear without spending a profile rotation
      // or model fallback. Keep the retry bounded; once exhausted, continue
      // through the existing rate-limit escalation path.
      const shortWindowRetry = resolveShortWindowRateLimitRetry(params.lastAssistant?.errorMessage);
      if (
        params.allowSameModelRateLimitRetry &&
        shortWindowRetry &&
        (await params.maybeRetrySameModelRateLimit(shortWindowRetry))
      ) {
        return sameModelRateLimitRetry();
      }
      params.maybeEscalateRateLimitProfileFallback({
        failoverProvider: params.activeErrorContext.provider,
        failoverModel: params.activeErrorContext.model,
        logFallbackDecision: params.logAssistantFailoverDecision,
      });
    }

    const rotated = await params.advanceAuthProfile();
    const markFailedProfilePromise = markFailedProfile();
    if (timeoutFailure && !params.isProbeSession && failedProfileId) {
      const timeoutLabel = params.idleTimedOut ? "idle timeout (model silent)" : "timed out";
      params.warn(`Profile ${failedProfileId} ${timeoutLabel}. Trying next account...`);
    }
    if (params.cloudCodeAssistFormatError && failedProfileId) {
      params.warn(
        `Profile ${failedProfileId} hit Cloud Code Assist format error. Tool calls will be sanitized on retry.`,
      );
    }
    if (rotated) {
      // Marking the failed profile is non-blocking after rotation succeeds; the
      // retry can proceed with the next profile while the failure record settles.
      void markFailedProfilePromise;
      params.logAssistantFailoverDecision("rotate_profile");
      await params.maybeBackoffBeforeOverloadFailover(params.failoverReason);
      return {
        action: "retry",
        overloadProfileRotations,
        lastRetryFailoverReason: mergeRetryFailoverReason({
          previous: params.previousRetryFailoverReason,
          failoverReason: params.failoverReason,
          timedOut: params.timedOut || params.idleTimedOut,
        }),
      };
    }
    await markFailedProfilePromise;
    if (params.idleTimedOut && params.allowSameModelIdleTimeoutRetry) {
      return sameModelIdleTimeoutRetry();
    }

    decision = resolveRunFailoverDecision({
      stage: "assistant",
      allowFormatRetry: params.cloudCodeAssistFormatError,
      aborted: params.aborted,
      externalAbort: params.externalAbort,
      fallbackConfigured: params.fallbackConfigured,
      failoverFailure: params.failoverFailure,
      failoverReason: params.failoverReason,
      timedOut: params.timedOut,
      idleTimedOut: params.idleTimedOut,
      timedOutDuringCompaction: params.timedOutDuringCompaction,
      timedOutDuringToolExecution: params.timedOutDuringToolExecution,
      timedOutByRunBudget: params.timedOutByRunBudget,
      profileRotated: true,
    });
  }

  if (decision.action === "fallback_model") {
    // Backoff runs before throwing so the outer fallback model starts after the
    // provider-specific overload delay.
    await params.maybeBackoffBeforeOverloadFailover(params.failoverReason);
    const message = resolveAssistantFailoverErrorMessage(params);
    const status =
      resolveFailoverStatus(decision.reason) ?? (isTimeoutErrorMessage(message) ? 408 : undefined);
    params.logAssistantFailoverDecision("fallback_model", { status });
    const shouldSuspend =
      Boolean(params.sessionKey) &&
      (decision.reason === "rate_limit" || decision.reason === "billing");

    return {
      action: "throw",
      overloadProfileRotations,
      error: new FailoverError(message, {
        reason: decision.reason,
        provider: params.activeErrorContext.provider,
        model: params.activeErrorContext.model,
        profileId: params.lastProfileId,
        authMode: params.authMode,
        status,
        rawError: params.lastAssistant?.errorMessage?.trim(),
        suspend: shouldSuspend,
      }),
    };
  }

  if (decision.action === "surface_error") {
    if (!params.externalAbort && params.idleTimedOut && params.allowSameModelIdleTimeoutRetry) {
      return sameModelIdleTimeoutRetry();
    }
    params.logAssistantFailoverDecision("surface_error");
    // Only current provider failures throw here. External aborts, timeout
    // payload synthesis, and stale classified text without failoverFailure
    // keep the normal payload path.
    if (!params.externalAbort && !params.timedOut && params.failoverFailure) {
      const message = resolveAssistantFailoverErrorMessage(params);
      const reason = resolveSurfaceErrorReason(decision.reason, params);
      const status =
        resolveFailoverStatus(reason) ?? (isTimeoutErrorMessage(message) ? 408 : undefined);
      const shouldSuspend =
        Boolean(params.sessionKey) && (reason === "rate_limit" || reason === "billing");

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
          suspend: shouldSuspend,
        }),
      };
    }
  }

  return {
    action: "continue_normal",
    overloadProfileRotations,
  };
}

function resolveAssistantFailoverErrorMessage(params: {
  lastAssistant: AssistantMessage | undefined;
  config: OpenClawConfig | undefined;
  sessionKey?: string;
  activeErrorContext: { provider: string; model: string };
  timedOut: boolean;
  idleTimedOut: boolean;
  rateLimitFailure: boolean;
  billingFailure: boolean;
  authFailure: boolean;
  /** Credential auth mode passed through to billing copy formatter (#80877). */
  authMode?: string;
}): string {
  const timeoutFailure = params.timedOut || params.idleTimedOut;
  return (
    (params.lastAssistant
      ? formatAssistantErrorText(params.lastAssistant, {
          cfg: params.config,
          sessionKey: params.sessionKey,
          provider: params.activeErrorContext.provider,
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
            : "LLM request failed.")
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
