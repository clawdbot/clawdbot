// QQBot plugin module classifies durable ingress failures.
export function isQQBotAuthenticationFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      httpStatus?: unknown;
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    if (
      candidate.httpStatus === 401 ||
      candidate.httpStatus === 403 ||
      candidate.status === 401 ||
      candidate.status === 403 ||
      candidate.statusCode === 401 ||
      candidate.statusCode === 403
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
