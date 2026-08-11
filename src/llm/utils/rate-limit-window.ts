import { parseRetryAfterHttpDateMs } from "@openclaw/ai/internal/retry-after";
import milliseconds from "ms";
import { extractLeadingHttpStatus } from "../../shared/assistant-error-format.js";

type RateLimitWindow =
  | { kind: "short"; retryAfterSeconds?: number }
  | { kind: "long" }
  | { kind: "unknown" };

const LONG_WINDOW_RATE_LIMIT_RE =
  /\b(?:daily|weekly|monthly|tokens per day|requests per day|usage limit|subscription|insufficient[_ -]?quota|current quota|quota[_ -]?exceeded|quota exceeded)\b/i;
const SHORT_RATE_LIMIT_UNIT_RE =
  /\b(?:requests per minute|tokens per minute|per-minute|rpm|tpm)\b/i;
const SHORT_WINDOW_RATE_LIMIT_RE =
  /\b(?:requests per minute|tokens per minute|per-minute|rpm|tpm|model_cooldown)\b|请求过于频繁|调用频率|频率限制|使用上限|限额.*重置/i;
const RETRY_AFTER_VALUE_RE = /\bretry[- ]after\b\s*:?\s*(?:in\s*)?([^\r\n;]+)/i;
const RETRY_AFTER_NUMBER_RE = /^(\d+(?:\.\d+)?)\s*([a-z]+)?\b/i;
const MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS = 60;

function parseRetryAfterSeconds(valueText: string, nowMs: number): number | undefined {
  const secondsMatch = RETRY_AFTER_NUMBER_RE.exec(valueText);
  if (secondsMatch?.[1]) {
    const value = Number(secondsMatch[1]);
    if (!Number.isFinite(value) || value < 0) {
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
    // Preserve division for millisecond inputs; multiplying by 0.001 can change IEEE-754 rounding.
    return unitMilliseconds === 1 ? value / 1000 : value * (unitMilliseconds / 1000);
  }
  const retryAtMs = parseRetryAfterHttpDateMs(valueText, nowMs);
  return retryAtMs === undefined ? undefined : Math.max(0, (retryAtMs - nowMs) / 1000);
}

/** Classifies provider rate-limit text without deciding a caller's retry policy. */
export function classifyRateLimitWindow(
  message: string | undefined,
  nowMs = Date.now(),
): RateLimitWindow {
  const raw = message?.trim();
  if (!raw) {
    return { kind: "unknown" };
  }
  const hasShortRateLimitUnit = SHORT_RATE_LIMIT_UNIT_RE.test(raw);
  const retryAfterValue = RETRY_AFTER_VALUE_RE.exec(raw)?.[1]?.trim();
  const retryAfterSeconds = retryAfterValue
    ? parseRetryAfterSeconds(retryAfterValue, nowMs)
    : undefined;

  if (retryAfterSeconds !== undefined) {
    if (retryAfterSeconds > MAX_SHORT_WINDOW_RETRY_AFTER_SECONDS) {
      return { kind: "long" };
    }
    return { kind: "short", retryAfterSeconds };
  }
  if (retryAfterValue && !hasShortRateLimitUnit) {
    return { kind: "long" };
  }
  if (LONG_WINDOW_RATE_LIMIT_RE.test(raw) && !hasShortRateLimitUnit) {
    return { kind: "long" };
  }
  if (SHORT_WINDOW_RATE_LIMIT_RE.test(raw) || extractLeadingHttpStatus(raw)?.code === 429) {
    return { kind: "short" };
  }
  return { kind: "unknown" };
}
