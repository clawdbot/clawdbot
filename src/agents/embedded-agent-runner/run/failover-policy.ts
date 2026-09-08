import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import { isCliTerminalStopCode } from "../../failover-error.js";

type ProfileDecision = {
  action: "rotate_profile" | "surface_error";
  reason: FailoverReason | null;
};
type ModelFallbackDecision = { action: "fallback_model"; reason: FailoverReason };
export type RetryLimitFailoverDecision = ModelFallbackDecision | { action: "return_error_payload" };
type PromptFailoverDecision = ProfileDecision | ModelFallbackDecision;
export type AssistantFailoverDecision = PromptFailoverDecision | { action: "continue_normal" };
type RunFailoverDecision = RetryLimitFailoverDecision | AssistantFailoverDecision;

type RetryLimitDecisionParams = {
  stage: "retry_limit";
  fallbackConfigured: boolean;
  failoverReason: FailoverReason | null;
};

type PromptDecisionParams = {
  stage: "prompt";
  allowFormatRetry?: boolean;
  externalAbort: boolean;
  fallbackConfigured: boolean;
  failoverCode?: string;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  harnessOwnsTransport?: boolean;
  promptTimeoutFallbackSafe?: boolean;
  timedOutByRunBudget?: boolean;
  profileRotated: boolean;
};

type AssistantDecisionParams = {
  stage: "assistant";
  allowFormatRetry?: boolean;
  terminal: AgentRunAttemptTerminal;
  signalOwnedInterruption?: boolean;
  fallbackConfigured: boolean;
  failoverFailure: boolean;
  failoverReason: FailoverReason | null;
  harnessOwnsTransport?: boolean;
  profileRotated: boolean;
};

type RunFailoverDecisionParams =
  | RetryLimitDecisionParams
  | PromptDecisionParams
  | AssistantDecisionParams;

function shouldEscalateRetryLimit(reason: FailoverReason | null): boolean {
  return Boolean(
    reason && reason !== "timeout" && reason !== "format" && reason !== "session_expired",
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
    params.failoverReason !== "tls_certificate" &&
    !isTerminalFormatFailure(params)
  );
}

function isAssistantTimeoutFailure(params: AssistantDecisionParams): boolean {
  return (
    params.terminal.kind === "timeout" &&
    params.terminal.source !== "observation" &&
    (params.terminal.source === "idle" || params.terminal.phase === "prompt")
  );
}

function isConcreteNonTimeoutAssistantFailure(params: AssistantDecisionParams): boolean {
  return (
    params.failoverFailure && Boolean(params.failoverReason) && params.failoverReason !== "timeout"
  );
}

function shouldRotateAssistant(params: AssistantDecisionParams): boolean {
  if (params.terminal.kind === "timeout" && params.terminal.source === "run_budget") {
    return false;
  }
  const timeoutFailure = isAssistantTimeoutFailure(params);
  const harnessOwnedTimeout =
    params.harnessOwnsTransport && (timeoutFailure || params.failoverReason === "timeout");
  if (harnessOwnedTimeout && !isConcreteNonTimeoutAssistantFailure(params)) {
    return false;
  }
  const aborted =
    (params.terminal.kind === "aborted" && params.terminal.source !== "yield_cleanup") ||
    (params.terminal.kind === "timeout" &&
      params.terminal.source !== "observation" &&
      params.terminal.aborted === true);
  return (!aborted && params.failoverFailure) || timeoutFailure;
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
  return params.failoverReason ?? params.previous ?? (params.timedOut ? "timeout" : null);
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
    // Plugin harnesses can forward CLI terminal codes through failover normalization;
    // normal CLI paths enforce the same stop in model-fallback-runner.
    if (
      isCliTerminalStopCode(params.failoverCode) ||
      params.externalAbort ||
      params.timedOutByRunBudget
    ) {
      return {
        action: "surface_error",
        reason: params.failoverReason,
      };
    }
    if (params.harnessOwnsTransport && params.failoverReason === "timeout") {
      // Plugin harness lifecycle timeouts must stay inside the harness boundary;
      // only prompt request timeouts proven replay-safe may enter model fallback.
      if (params.promptTimeoutFallbackSafe === true && params.fallbackConfigured) {
        return {
          action: "fallback_model",
          reason: "timeout",
        };
      }
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

  if (
    params.signalOwnedInterruption ||
    ((params.terminal.kind === "aborted" || params.terminal.kind === "timeout") &&
      params.terminal.source === "external") ||
    isTerminalFormatFailure(params)
  ) {
    return {
      action: "surface_error",
      reason: params.failoverReason,
    };
  }
  if (params.failoverFailure && params.failoverReason === "tls_certificate") {
    return params.fallbackConfigured
      ? {
          action: "fallback_model",
          reason: "tls_certificate",
        }
      : {
          action: "surface_error",
          reason: "tls_certificate",
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
