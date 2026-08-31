// Discord plugin module implements retry after behavior.
import { asFiniteNumberInRange, parseStrictFiniteNumber } from "openclaw/plugin-sdk/number-runtime";

const RETRY_AFTER_BODY_SECONDS_RE = /^(?:\d+\.?\d*|\.\d+)$/;
const MAX_SAFE_RETRY_AFTER_SECONDS = Number.MAX_SAFE_INTEGER / 1000;

export function parseDiscordRetryAfterBodySeconds(value: unknown): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && RETRY_AFTER_BODY_SECONDS_RE.test(value.trim())
        ? parseStrictFiniteNumber(value.trim())
        : undefined;
  return asFiniteNumberInRange(seconds, { min: 0, max: MAX_SAFE_RETRY_AFTER_SECONDS });
}
