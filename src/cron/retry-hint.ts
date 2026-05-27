import type { CronRetryOn } from "../config/types.cron.js";

export type CronRetryHint = {
  retryable: boolean;
  category?: CronRetryOn;
};

const TRANSIENT_PATTERNS: Record<CronRetryOn, RegExp> = {
  rate_limit:
    /(rate[_ ]limit|too many requests|429|resource has been exhausted|cloudflare|tokens per day)/i,
  overloaded:
    /\b529\b|\boverloaded(?:_error)?\b|high demand|temporar(?:ily|y) overloaded|capacity exceeded/i,
  network:
    /(network|fetch failed|socket|econnreset|econnrefused|eai_again|enetdown|ehostunreach|ehostdown|enetreset|enetunreach|epipe)/i,
  timeout: /(timeout|etimedout)/i,
  server_error: /\b5\d{2}\b/,
};

export function resolveCronExecutionRetryHint(
  error: string | undefined,
  retryOn?: CronRetryOn[],
  classifiedReason?: string | null,
): CronRetryHint {
  if (!error || typeof error !== "string") {
    return { retryable: false };
  }
  const keys = retryOn?.length ? retryOn : (Object.keys(TRANSIENT_PATTERNS) as CronRetryOn[]);
  const classified = classifiedReason ?? undefined;
  if (classified && keys.includes(classified as CronRetryOn)) {
    return { retryable: true, category: classified as CronRetryOn };
  }
  for (const key of keys) {
    if (TRANSIENT_PATTERNS[key]?.test(error)) {
      return { retryable: true, category: key };
    }
  }
  return { retryable: false };
}
