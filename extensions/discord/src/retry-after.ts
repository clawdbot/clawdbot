const RETRY_AFTER_HEADER_DELAY_RE = /^\d+$/;
const RETRY_AFTER_BODY_SECONDS_RE = /^(?:\d+\.?\d*|\.\d+)$/;
const RETRY_AFTER_HTTP_DATE_RE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export function parseRetryAfterHeaderSeconds(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (RETRY_AFTER_HEADER_DELAY_RE.test(trimmed)) {
    const delaySeconds = Number(trimmed);
    return Number.isFinite(delaySeconds) ? delaySeconds : undefined;
  }
  if (!RETRY_AFTER_HTTP_DATE_RE.test(trimmed)) {
    return undefined;
  }
  const retryAt = Date.parse(trimmed);
  return Number.isFinite(retryAt) ? Math.max(0, (retryAt - now) / 1000) : undefined;
}

export function parseDiscordRetryAfterBodySeconds(value: unknown): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && RETRY_AFTER_BODY_SECONDS_RE.test(value.trim())
        ? Number(value.trim())
        : undefined;
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
