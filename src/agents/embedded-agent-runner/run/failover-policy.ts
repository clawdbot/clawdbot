/**
 * Resolves retry, fallback, and terminal failover decisions for a run.
 */
import type { FailoverReason } from "../../embedded-agent-helpers.js";

/** Failover action selected for one embedded run failure decision point. */
export type RunFailoverDecision =
  | {
      action: "continue_normal";
    }
  | {
      action: "rotate_profile" | "surface_error";
      reason: FailoverReason | null;
    }
  | {
      action: "fallback_model";
      reason: FailoverReason;
    }
  | {
      action: "return_error_payload";
    };

export type RetryLimitFailoverDecision = Extract<
  RunFailoverDecision,
  { action: "fallback_model" | "return_error_payload" }
>;

export type PromptFailoverDecision = Extract<
  RunFailoverDecision,
  { action: "rotate_profile" | "fallback_model" | "surface_error" }
>;

export type AssistantFailoverDecision = Extract<
  RunFailoverDecision,
  { action: "continue_normal" | "rotate_profile" | "fallback_model" | "surface_error" }
>;

type RetryLimitDecisionParams = {
  stage: "retry_limit";
  fallbackConfigured: boolean;
  failoverReason: FailoverReason | null;
};

type PromptDecisionParams = {
  stage: "prompt";
  allowFormatRetry?: boolean;
  aborted: boolean;
  externalAbort: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  harnessOwnsTransport?: boolean;
  profileRotated: boolean;
};

type AssistantDecisionParams = {
  stage: "assistant";
  allowFormatRetry?: boolean;
  aborted: boolean;
  externalAbort: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  timedOut: boolean;
  idleTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  timedOutDuringToolExecution: boolean;
  harnessOwnsTransport?: boolean;
  profileRotated: boolean;
};

export type RunFailoverDecisionParams =
  | RetryLimitDecisionParams
  | PromptDecisionParams
  | AssistantDecisionParams;

function shouldEscalateRetryLimit(reason: FailoverReason | null): boolean {
  return Boolean(
    reason &&
    reason !== "timeout" &&
    reason !== "model_not_found" &&
    reason !== "format" &&
    reason !== "session_expired",
  );
}

function isTerminalFormatFailure(params: {
  allowFormatRetry?: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
}): boolean {
  return (
    params.failoverFailure && params.failoverReason === "format" && params.allowFormatRetry !== true
  );
}

function shouldRotatePrompt(params: PromptDecisionParams): boolean {
  return (
    params.failoverFailure &&
    params.failoverReason !== "timeout" &&
    !isTerminalFormatFailure(params)
  );
}

function isAssistantTimeoutFailure(params: AssistantDecisionParams): boolean {
  return (
    params.idleTimedOut ||
    (params.timedOut && !params.timedOutDuringCompaction && !params.timedOutDuringToolExecution)
  );
}

function isConcreteNonTimeoutAssistantFailure(params: AssistantDecisionParams): boolean {
  return (
    params.failoverFailure && Boolean(params.failoverReason) && params.failoverReason !== "timeout"
  );
}

function shouldRotateAssistant(params: AssistantDecisionParams): boolean {
  if (isTerminalFormatFailure(params)) {
    return false;
  }
  const timeoutFailure = isAssistantTimeoutFailure(params);
  const harnessOwnedTimeout =
    params.harnessOwnsTransport && (timeoutFailure || params.failoverReason === "timeout");
  if (harnessOwnedTimeout && !isConcreteNonTimeoutAssistantFailure(params)) {
    return false;
  }
  return (!params.aborted && params.failoverFailure) || timeoutFailure;
}

function assistantFallbackReason(params: AssistantDecisionParams): FailoverReason {
  const failoverReason = params.failoverReason;
  if (params.failoverFailure && failoverReason && failoverReason !== "timeout") {
    return failoverReason;
  }
  return isAssistantTimeoutFailure(params) ? "timeout" : (failoverReason ?? "unknown");
}

/** Preserves an existing retry reason unless the current attempt produced a stronger signal. */
export function mergeRetryFailoverReason(params: {
  previous: FailoverReason | null;
  failoverReason: FailoverReason | null;
  timedOut?: boolean;
}): FailoverReason | null {
  return params.failoverReason ?? (params.timedOut ? "timeout" : null) ?? params.previous;
}

export function resolveRunFailoverDecision(
  params: RetryLimitDecisionParams,
): RetryLimitFailoverDecision;
export function resolveRunFailoverDecision(params: PromptDecisionParams): PromptFailoverDecision;
export function resolveRunFailoverDecision(
  params: AssistantDecisionParams,
): AssistantFailoverDecision;
/**
 * Chooses whether a run should rotate auth profile, switch model fallback,
 * surface the error, continue normally, or return an error payload. Prompt,
 * assistant, and retry-limit stages intentionally use different action sets.
 */
export function resolveRunFailoverDecision(params: RunFailoverDecisionParams): RunFailoverDecision {
  if (params.stage === "retry_limit") {
    if (params.fallbackConfigured && shouldEscalateRetryLimit(params.failoverReason)) {
      const fallbackReason = params.failoverReason ?? "unknown";
      return {
        action: "fallback_model",
        reason: fallbackReason,
      };
    }
    return {
      action: "return_error_payload",
    };
  }

  if (params.stage === "prompt") {
    if (params.externalAbort) {
      return {
        action: "surface_error",
        reason: params.failoverReason,
      };
    }
    if (params.harnessOwnsTransport && params.failoverReason === "timeout") {
      return {
        action: "surface_error",
        reason: params.failoverReason,
      };
    }
    if (!params.profileRotated && shouldRotatePrompt(params)) {
      return {
        action: "rotate_profile",
        reason: params.failoverReason,
      };
    }
    if (params.fallbackConfigured && params.failoverFailure && !isTerminalFormatFailure(params)) {
      return {
        action: "fallback_model",
        reason: params.failoverReason ?? "unknown",
      };
    }
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }

  if (params.externalAbort) {
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }
  if (isTerminalFormatFailure(params)) {
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }
  const assistantShouldRotate = shouldRotateAssistant(params);
  if (!params.profileRotated && assistantShouldRotate) {
    return {
      action: "rotate_profile",
      reason: params.failoverReason,
    };
  }
  if (assistantShouldRotate && params.fallbackConfigured) {
    return {
      action: "fallback_model",
      reason: assistantFallbackReason(params),
    };
  }
  if (!assistantShouldRotate) {
    return {
      action: "continue_normal",
    };
  }
  return {
    action: "surface_error",
    reason: params.failoverReason,
  };
}
