import { isCloudflareOrHtmlErrorPage } from "../shared/assistant-error-format.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isAnthropicBillingError, isApiKeyRateLimitError } from "./live-auth-keys.js";
import { isModelNotFoundErrorMessage } from "./live-model-errors.js";
import {
  isAuthErrorMessage,
  isBillingErrorMessage,
  isRateLimitErrorMessage,
  isTimeoutErrorMessage,
} from "./pi-embedded-helpers/failover-matches.js";

export type LiveProviderDriftReason =
  | "auth"
  | "billing"
  | "model-not-found"
  | "provider-unavailable"
  | "rate-limit"
  | "timeout";

export type LiveProviderDriftDecision = {
  label: string;
  reason: LiveProviderDriftReason;
};

export type LiveProviderDriftOptions = {
  allowAuth?: boolean;
  allowBilling?: boolean;
  allowModelNotFound?: boolean;
  allowProviderUnavailable?: boolean;
  allowRateLimit?: boolean;
  allowTimeout?: boolean;
  error: unknown;
};

export function liveProviderErrorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function isLiveAuthDrift(error: unknown): boolean {
  return isAuthErrorMessage(liveProviderErrorText(error));
}

export function isLiveBillingDrift(error: unknown): boolean {
  const raw = liveProviderErrorText(error);
  return isBillingErrorMessage(raw) || isAnthropicBillingError(raw);
}

export function isLiveRateLimitDrift(error: unknown): boolean {
  const raw = liveProviderErrorText(error);
  return isRateLimitErrorMessage(raw) || isApiKeyRateLimitError(raw);
}

export function isLiveTimeoutDrift(error: unknown): boolean {
  return isTimeoutErrorMessage(liveProviderErrorText(error));
}

export function isLiveModelNotFoundDrift(error: unknown): boolean {
  return isModelNotFoundErrorMessage(liveProviderErrorText(error));
}

export function isLiveProviderUnavailableDrift(error: unknown): boolean {
  const raw = liveProviderErrorText(error);
  const htmlCandidate = raw.trim().replace(/^error:\s*/i, "");
  const msg = normalizeLowercaseStringOrEmpty(raw);
  return (
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
