import {
  extractLeadingHttpStatus,
  extractProviderWrappedHttpStatus,
} from "../../shared/assistant-error-format.js";
import type { AssistantMessage } from "../types.js";
import { classifyRateLimitWindow } from "./rate-limit-window.js";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "available balance",
  "insufficient_quota",
  "out of budget",
]);

const RETRYABLE_HTTP_STATUS_CODES = new Set([429, 500, 502, 503, 504, 524]);
const RATE_LIMIT_CONTEXT_PATTERN = buildProviderErrorPattern([
  "rate.?limit",
  "too many requests",
  "resource[_ -]?exhausted",
  "daily (?:request|usage) limit",
  "requests? per day",
  "tokens? per day",
  "quota[_ -]?exceeded",
  "quota exceeded",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
  "overloaded",
  "rate.?limit",
  "too many requests",
  "service.?unavailable",
  "server.?error",
  "internal.?error",
  "provider.?returned.?error",
  "network.?error",
  "connection.?error",
  "connection.?refused",
  "connection.?lost",
  "other side closed",
  "fetch failed",
  "upstream.?connect",
  "reset before headers",
  "socket hang up",
  "socket connection was closed",
  "timed? out",
  "timeout",
  "terminated",
  "websocket.?closed",
  "websocket.?error",
  "ended without",
  "stream ended before message_stop",
  "http2 request did not get a response",
  "retry delay",
  "you can retry your request",
  "try your request again",
  "please retry your request",
  "resource[_ -]?exhausted",
]);

/** Classify transient provider/transport failures for outer retry policy. */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) {
    return false;
  }
  const errorMessage = message.errorMessage.trim();
  if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) {
    return false;
  }
  const status =
    extractLeadingHttpStatus(errorMessage)?.code ??
    extractProviderWrappedHttpStatus(errorMessage)?.code;
  if (status && status !== 429 && RETRYABLE_HTTP_STATUS_CODES.has(status)) {
    return true;
  }
  const hasRateLimitContext = status === 429 || RATE_LIMIT_CONTEXT_PATTERN.test(errorMessage);
  if (hasRateLimitContext && classifyRateLimitWindow(errorMessage).kind === "long") {
    return false;
  }
  if (status === 429) {
    return true;
  }
  return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
