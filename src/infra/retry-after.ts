import { parseRetryAfterHttpDateMs } from "@openclaw/ai/internal/retry-after";
import { asFiniteNumberInRange, parseStrictNonNegativeInteger } from "../shared/number-coercion.js";

const RETRY_AFTER_HEADER_DELAY_RE = /^\d+$/;
const MAX_SAFE_RETRY_AFTER_SECONDS = Number.MAX_SAFE_INTEGER / 1000;

/** Parses an RFC Retry-After header as delay seconds or any valid HTTP-date form. */
export function parseRetryAfterHeaderSeconds(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (RETRY_AFTER_HEADER_DELAY_RE.test(trimmed)) {
    return asFiniteNumberInRange(parseStrictNonNegativeInteger(trimmed), {
      min: 0,
      max: MAX_SAFE_RETRY_AFTER_SECONDS,
    });
  }
  if (!Number.isFinite(now)) {
    return undefined;
  }
  const retryAt = parseRetryAfterHttpDateMs(trimmed, now);
  return retryAt === undefined ? undefined : Math.max(0, (retryAt - now) / 1000);
}
