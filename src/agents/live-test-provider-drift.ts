/**
 * Live-provider drift classifiers for tests and probes.
 *
 * Live lanes call real providers, so these helpers separate acceptable account,
 * quota, model, or upstream drift from product regressions.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isCloudflareOrHtmlErrorPage } from "../shared/assistant-error-format.js";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isServerErrorMessage,
  isTimeoutErrorMessage,
} from "./embedded-agent-helpers/failover-matches.js";
import { isApiKeyRateLimitError } from "./live-auth-keys.js";
import { isModelNotFoundErrorMessage } from "./live-model-errors.js";

type LiveProviderDriftReason =
  | "auth"
  | "billing"
  | "model-not-found"
  | "provider-unavailable"
  | "rate-limit"
  | "timeout";

/** A normalized reason for skipping or soft-failing live provider drift. */
type LiveProviderDriftDecision = {
  label: string;
  reason: LiveProviderDriftReason;
};

/** Classifier options that control which live-provider drift reasons are allowed. */
type LiveProviderDriftOptions = {
  allowAuth?: boolean;
  allowBilling?: boolean;
  allowModelNotFound?: boolean;
  allowProviderUnavailable?: boolean;
  allowRateLimit?: boolean;
  allowTimeout?: boolean;
  error: unknown;
};

/** Converts arbitrary thrown values into text for provider drift matchers. */
function liveProviderErrorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isAnthropicBillingError(message: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  if (
    lower.includes("credit balance") ||
    lower.includes("insufficient credit") ||
    lower.includes("payment required") ||
    (lower.includes("billing") && lower.includes("disabled"))
  ) {
    return true;
  }
  return /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\spayment/i.test(
    lower,
  );
}

/** Returns whether an error is expected live auth/account drift. */
function isLiveAuthDrift(error: unknown): boolean {
  const raw = liveProviderErrorText(error);
  const message = normalizeLowercaseStringOrEmpty(raw);
  return (
    isAuthErrorMessage(raw) ||
    message.includes("invalid x-api-key") ||
    message.includes("incorrect x-api-key")
  );
}

/** Returns whether an error is expected live billing/quota drift. */
function isLiveBillingDrift(error: unknown): boolean {
  const raw = liveProviderErrorText(error);
  return isBillingErrorMessage(raw) || isAnthropicBillingError(raw);
}

/** Returns whether an error is expected live rate-limit drift. */
function isLiveRateLimitDrift(error: unknown): boolean {
  const raw = liveProviderErrorText(error);
  return isRateLimitErrorMessage(raw) || isApiKeyRateLimitError(raw);
}

/** Returns whether an error is expected live timeout drift. */
function isLiveTimeoutDrift(error: unknown): boolean {
  return isTimeoutErrorMessage(liveProviderErrorText(error));
}

/** Returns whether an error is expected live missing-model drift. */
function isLiveModelNotFoundDrift(error: unknown): boolean {
  return isModelNotFoundErrorMessage(liveProviderErrorText(error));
}

/** Returns whether an error is expected upstream/provider availability drift. */
function isLiveProviderUnavailableDrift(error: unknown): boolean {
  const raw = liveProviderErrorText(error);
  const htmlCandidate = raw.trim().replace(/^error:\s*/i, "");
  const msg = normalizeLowercaseStringOrEmpty(raw);
  return (
    isOverloadedErrorMessage(raw) ||
    isServerErrorMessage(raw) ||
    isRawHtmlProviderErrorPage(htmlCandidate) ||
    isCloudflareOrHtmlErrorPage(raw) ||
    isCloudflareOrHtmlErrorPage(htmlCandidate) ||
    msg.includes("no allowed providers are available") ||
    msg.includes("provider unavailable") ||
    msg.includes("upstream provider unavailable") ||
    msg.includes("upstream error from google") ||
    msg.includes("temporarily rate-limited upstream") ||
    (msg.includes("service temporarily unavailable") && msg.includes("capacity")) ||
    msg.includes("unable to access non-serverless model") ||
    msg.includes("create and start a new dedicated endpoint") ||
    msg.includes("no available capacity was found for the model") ||
    (msg.includes("502") && msg.includes("internal server error"))
  );
}

function isRawHtmlProviderErrorPage(raw: string): boolean {
  return /^(?:<!doctype\s+html\b|<html\b)/i.test(raw) && /<\/html>/i.test(raw);
}

/** Returns the allowed live drift decision for an error, or `undefined` for regressions. */
export function shouldSkipLiveProviderDrift(
  options: LiveProviderDriftOptions,
): LiveProviderDriftDecision | undefined {
  if (options.allowBilling && isLiveBillingDrift(options.error)) {
    return { reason: "billing", label: "billing drift" };
  }
  if (options.allowAuth && isLiveAuthDrift(options.error)) {
    return { reason: "auth", label: "auth drift" };
  }
  if (options.allowRateLimit && isLiveRateLimitDrift(options.error)) {
    return { reason: "rate-limit", label: "rate limit" };
  }
  if (options.allowProviderUnavailable && isLiveProviderUnavailableDrift(options.error)) {
    return { reason: "provider-unavailable", label: "provider unavailable" };
  }
  if (options.allowTimeout && isLiveTimeoutDrift(options.error)) {
    return { reason: "timeout", label: "timeout" };
  }
  if (options.allowModelNotFound && isLiveModelNotFoundDrift(options.error)) {
    return { reason: "model-not-found", label: "model not found" };
  }
  return undefined;
}
