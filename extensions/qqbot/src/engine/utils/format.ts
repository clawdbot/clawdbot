/**
 * General formatting and string utilities.
 * 通用格式化与字符串工具。
 *
 * Pure utility functions with zero external dependencies.
 * Replaces `openclaw/plugin-sdk/error-runtime` and `text-runtime`
 * helpers for use inside engine/.
 *
 * NOTE: The framework `formatErrorMessage` also applies `redactSensitiveText()`
 * for token masking. We intentionally omit that here — the framework's log
 * pipeline handles redaction at a higher level.
 */

/**
 * Format any error object into a readable string.
 * 将任意错误对象格式化为可读字符串。
 *
 * Traverses the `.cause` chain for nested Error objects to include
 * the full error context (e.g. network errors wrapped inside HTTP errors).
 */
export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    let formatted = err.message || err.name || "Error";
    let cause: unknown = err.cause;
    const seen = new Set<unknown>([err]);
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) {
        if (cause.message) {
          formatted += ` | ${cause.message}`;
        }
        cause = cause.cause;
      } else if (typeof cause === "string") {
        formatted += ` | ${cause}`;
        break;
      } else {
        break;
      }
    }
    return formatted;
  }
  if (typeof err === "string") {
    return err;
  }
  if (
    err === null ||
    err === undefined ||
    typeof err === "number" ||
    typeof err === "boolean" ||
    typeof err === "bigint"
  ) {
    return String(err);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

/** Format a millisecond duration into a human-readable string (e.g. "5m 30s"). */
export function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return remainSeconds > 0 ? `${minutes}m ${remainSeconds}s` : `${minutes}m`;
}
