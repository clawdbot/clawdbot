/** Classifies cron run failures for retry policy decisions. */
import type { CronRetryOn } from "../config/types.cron.js";

/** Cron retry classifier output consumed by scheduler retry policy. */
type CronRetryHint = {
  retryable: boolean;
  category?: CronRetryOn;
};

type CronRetryHintInput = {
  error: string | undefined;
  retryOn?: CronRetryOn[];
  classifiedReason?: string | null;
  executionStarted?: boolean;
};

// A bare 5xx-looking number embedded in prose is not an HTTP server error: cron
// failure messages routinely contain such numbers ("context limit 512 exceeded",
// "exited with 503 lines", "pid 511 killed", a "...-540.sock" path), and
// /\b5\d{2}\b/ matched all of them, wrongly marking permanent failures retryable.
// Match a 5xx number only with HTTP/status context, a canonical 5xx phrase, or
// when it is the entire message (a terse "503"), so genuine
// "500 Internal Server Error" / "502 Bad Gateway" / "5xx" still classify while
// incidental numbers in longer messages do not.
const SERVER_ERROR_PATTERN =
  /\b(?:https?|status(?:[ _]code)?|response(?:[ _]code)?|http(?:[ _]status)?)\b[\s:=#"']{0,4}5\d{2}\b|\b5\d{2}\b[\s:)\].,-]*(?:internal server error|server error|bad gateway|service unavailable|gateway time-?out)\b|\binternal server error\b|\bbad gateway\b|\bservice unavailable\b|\bgateway time-?out\b|\b5xx\b|^\s*5\d{2}\s*$/i;

// Lifecycle claims can lose a race before provider execution. Retry only before
// execution starts; afterward, tools may have produced non-idempotent effects.
const SESSION_LIFECYCLE_CLAIM_ERROR_PATTERN =
  /^(?:(?:CronSessionLifecycleClaimError|Error): )?Session "[^"\n]+" (?:changed|was deleted) while starting work\. Retry\.$/;

const TRANSIENT_PATTERNS: Record<CronRetryOn, RegExp> = {
  rate_limit:
    /(rate[_ ]limit|too many requests|429|resource has been exhausted|cloudflare|tokens per day)/i,
  overloaded:
    /\b529\b|\boverloaded(?:_error)?\b|high demand|temporar(?:ily|y) overloaded|capacity exceeded/i,
  network:
    /(network|fetch failed|socket|econnreset|econnrefused|eai_again|enetdown|ehostunreach|ehostdown|enetreset|enetunreach|epipe)/i,
  timeout: /(timeout|timed out|stalled before execution start|etimedout)/i,
  server_error: SERVER_ERROR_PATTERN,
};

/** Classifies cron execution errors against the configured retryable transient categories. */
export function resolveCronExecutionRetryHint(input: CronRetryHintInput): CronRetryHint {
  const { error, retryOn, classifiedReason, executionStarted } = input;
  if (!error || typeof error !== "string") {
    return { retryable: false };
  }
  if (SESSION_LIFECYCLE_CLAIM_ERROR_PATTERN.test(error)) {
    return { retryable: executionStarted !== true };
  }
  const keys = retryOn?.length ? retryOn : (Object.keys(TRANSIENT_PATTERNS) as CronRetryOn[]);
  const classified = classifiedReason ?? undefined;
  if (classified && keys.includes(classified as CronRetryOn)) {
    // Structured provider classifications win over brittle message regexes when allowed.
    return { retryable: true, category: classified as CronRetryOn };
  }
  for (const key of keys) {
    if (TRANSIENT_PATTERNS[key]?.test(error)) {
      return { retryable: true, category: key };
    }
  }
  return { retryable: false };
}
