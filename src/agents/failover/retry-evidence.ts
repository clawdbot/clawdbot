import {
  parseRetryAfterHttpDateMs,
  parseRetryAfterErrorSeconds,
} from "@openclaw/ai/internal/retry-after";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import milliseconds from "ms";
import { isTransientNetworkError } from "../../infra/retryable-network-errors.js";
import {
  extractErrorHttpStatus,
  extractLeadingHttpStatus,
  extractProviderWrappedHttpStatus,
  parseApiErrorInfo,
} from "../../shared/assistant-error-format.js";
import { classifyFailoverReasonFromCode } from "./classification-rules.js";
import { INCOMPLETE_ASSISTANT_STREAM_RE } from "./message-patterns.js";
import type { FailoverClassification, FailoverSignal } from "./signal.js";

type RateLimitWindow =
  | { kind: "short"; retryAfterSeconds?: number }
  | { kind: "long" }
  | { kind: "unknown" };

const RETRYABLE_HTTP_STATUS_CODES = new Set([429, 500, 502, 503, 504, 524]);
const RATE_LIMIT_RETRY_CONTEXT_RE =
  /rate.?limit|too many requests|resource[_ -]?exhausted|daily (?:request|usage) limit|requests? per day|tokens? per day|quota[_ -]?exceeded/i;
const TRANSIENT_RETRY_EVIDENCE_RE =
  /overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|resource[_ -]?exhausted/i;
const LONG_WINDOW_RATE_LIMIT_RE =
  /\b(?:daily|weekly|monthly|tokens per day|requests per day|usage limit|subscription|insufficient[_ -]?quota|current quota|quota[_ -]?exceeded|(?:go|free)usagelimiterror|available balance|out of budget)\b/i;
const SHORT_RATE_LIMIT_UNIT_RE =
  /\b(?:requests per minute|tokens per minute|per-minute|rpm|tpm)\b/i;
const SHORT_WINDOW_RATE_LIMIT_RE =
  /\b(?:requests per minute|tokens per minute|per-minute|rpm|tpm|model_cooldown)\b|请求过于频繁|调用频率|频率限制/i;
const RETRY_AFTER_VALUE_RE =
  /\b(?:retry[- ]after\b\s*:?\s*(?:in\b\s*)?|(?:please\s+)?try again in\s+)([^\r\n;]+)/i;
const RETRY_AFTER_NUMBER_RE = /^(\d+(?:\.\d+)?|Infinity)\s*([a-z]+)?\b/i;
const MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS = 60;

/** Extract guarded HTTP status evidence for retry and diagnostic consumers. */
export function extractFailoverHttpStatus(
  message: string | undefined,
  options?: { includeLabeledStatus?: boolean },
): number | undefined {
  if (!message) {
    return undefined;
  }
  const status = options?.includeLabeledStatus
    ? extractErrorHttpStatus(message)
    : (extractLeadingHttpStatus(message.trim()) ??
      extractProviderWrappedHttpStatus(message.trim()));
  return status?.code;
}

function resolveRetrySignalStatus(signal: Pick<FailoverSignal, "message" | "status">) {
  return signal.status ?? extractFailoverHttpStatus(signal.message);
}

/** Narrow evidence that replaying the same assistant request may succeed within this session. */
export function hasTransientRetryEvidence(
  signal: Pick<FailoverSignal, "code" | "message" | "status">,
): boolean {
  const status = resolveRetrySignalStatus(signal);
  return (
    (status !== undefined && RETRYABLE_HTTP_STATUS_CODES.has(status)) ||
    INCOMPLETE_ASSISTANT_STREAM_RE.test(signal.message ?? "") ||
    TRANSIENT_RETRY_EVIDENCE_RE.test(signal.message ?? "") ||
    isTransientNetworkError({ code: signal.code })
  );
}

function hasRateLimitRetryContext(signal: Pick<FailoverSignal, "message" | "status">): boolean {
  return (
    resolveRetrySignalStatus(signal) === 429 ||
    RATE_LIMIT_RETRY_CONTEXT_RE.test(signal.message ?? "")
  );
}

function parseRetryAfterSeconds(valueText: string, nowMs: number): number | undefined {
  const secondsMatch = RETRY_AFTER_NUMBER_RE.exec(valueText);
  if (secondsMatch?.[1]) {
    const value = /^infinity$/i.test(secondsMatch[1]) ? Infinity : Number(secondsMatch[1]);
    if (Number.isNaN(value) || value < 0) {
      return undefined;
    }
    const unit = secondsMatch[2]?.toLowerCase();
    if (
      unit &&
      !/^(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/.test(
        unit,
      )
    ) {
      return undefined;
    }
    const unitMilliseconds = milliseconds(`1${unit ?? "s"}` as Parameters<typeof milliseconds>[0]);
    return unitMilliseconds === 1 ? value / 1000 : value * (unitMilliseconds / 1000);
  }
  const retryAtMs = parseRetryAfterHttpDateMs(valueText, nowMs);
  return retryAtMs === undefined ? undefined : Math.max(0, (retryAtMs - nowMs) / 1000);
}

function retryTextSeconds(message: string | undefined, nowMs: number): number | undefined {
  let floor: number | undefined;
  for (const match of message?.matchAll(new RegExp(RETRY_AFTER_VALUE_RE, "gi")) ?? []) {
    const seconds = parseRetryAfterSeconds(match[1]?.trim() ?? "", nowMs);
    if (seconds !== undefined) {
      floor = Math.max(floor ?? 0, seconds);
    }
  }
  return floor;
}

/** Extracts the provider retry floor from error text and response headers. */
export function resolveRetryAfterMs(
  message: string | undefined,
  nowMs = Date.now(),
  errorBody?: unknown,
): number | undefined {
  const body = typeof errorBody === "string" ? safeParseJsonRecord(errorBody) : errorBody;
  const headerSeconds = parseRetryAfterErrorSeconds(body, nowMs);
  const seconds = retryTextSeconds(message, nowMs);
  return headerSeconds === undefined && seconds === undefined
    ? undefined
    : Math.ceil(Math.max(headerSeconds ?? 0, seconds ?? 0) * 1000);
}

/** Usage-window evidence is distinct from a temporary throttle's retry floor. */
export function hasLongWindowRateLimitEvidence(message: string | undefined): boolean {
  return Boolean(
    message && LONG_WINDOW_RATE_LIMIT_RE.test(message) && !SHORT_RATE_LIMIT_UNIT_RE.test(message),
  );
}

/** Classify provider rate-limit text without deciding a caller's retry policy. */
export function classifyRateLimitWindow(
  message: string | undefined,
  nowMs = Date.now(),
): RateLimitWindow {
  const raw = message?.trim();
  if (!raw) {
    return { kind: "unknown" };
  }
  const hasShortRateLimitUnit = SHORT_RATE_LIMIT_UNIT_RE.test(raw);
  const retryAfterSeconds = retryTextSeconds(raw, nowMs);

  if (retryAfterSeconds !== undefined) {
    return retryAfterSeconds > MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS
      ? { kind: "long" }
      : { kind: "short", retryAfterSeconds };
  }
  if (RETRY_AFTER_VALUE_RE.test(raw) && !hasShortRateLimitUnit) {
    return { kind: "long" };
  }
  if (hasLongWindowRateLimitEvidence(raw)) {
    return { kind: "long" };
  }
  if (SHORT_WINDOW_RATE_LIMIT_RE.test(raw) || extractLeadingHttpStatus(raw)?.code === 429) {
    return { kind: "short" };
  }
  return { kind: "unknown" };
}

/** Apply the intra-attempt replay policy to one already-classified failover signal. */
export function shouldRetryFailoverSignal(params: {
  classification: FailoverClassification | null;
  hasTransientEvidence: boolean;
  signal: Pick<FailoverSignal, "code" | "message" | "status">;
}): boolean {
  if (!params.hasTransientEvidence) {
    return false;
  }
  const reason =
    params.classification?.kind === "reason" ? params.classification.reason : undefined;
  const status = resolveRetrySignalStatus(params.signal);
  // Preserve 4xx server-error retries unless a validation code proves rejection.
  if (
    reason === "format" &&
    (status === undefined ||
      (status >= 500 && status < 600) ||
      (classifyFailoverReasonFromCode(params.signal.code) ??
        classifyFailoverReasonFromCode(parseApiErrorInfo(params.signal.message)?.code)) ===
        "format")
  ) {
    return false;
  }
  const hasLongLimitWindow = classifyRateLimitWindow(params.signal.message).kind === "long";
  if (
    hasLongLimitWindow &&
    (reason === "billing" || reason === "rate_limit" || hasRateLimitRetryContext(params.signal))
  ) {
    return false;
  }
  return true;
}
