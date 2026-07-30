// Keep connection retry policy aligned across provider reads and gateway waits.
const RETRYABLE_CONNECTION_ERROR_CODE_RE =
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b/i;

export function hasRetryableConnectionErrorCode(message: string): boolean {
  return RETRYABLE_CONNECTION_ERROR_CODE_RE.test(message);
}
