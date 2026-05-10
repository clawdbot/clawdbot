import { redactSensitiveText } from "../logging/redact.js";

export function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }
  if (typeof code === "number") {
    return String(code);
  }
  return undefined;
}

export function readErrorName(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

export function collectErrorGraphCandidates(
  err: unknown,
  resolveNested?: (current: Record<string, unknown>) => Iterable<unknown>,
): unknown[] {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (!current || typeof current !== "object" || !resolveNested) {
      continue;
    }
    for (const nested of resolveNested(current as Record<string, unknown>)) {
      if (nested != null && !seen.has(nested)) {
        queue.push(nested);
      }
    }
  }

  return candidates;
}

/**
 * Type guard for NodeJS.ErrnoException (any error with a `code` property).
 */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

/**
 * Check if an error has a specific errno code.
 */
export function hasErrnoCode(err: unknown, code: string): boolean {
  return isErrno(err) && err.code === code;
}

export function formatErrorMessage(err: unknown): string {
  let formatted: string;
  if (err instanceof Error) {
    formatted = err.message || err.name || "Error";
    // Traverse .cause chain to include nested error messages (e.g. grammY HttpError wraps network errors in .cause)
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
  } else if (typeof err === "string") {
    formatted = err;
  } else if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    formatted = String(err);
  } else {
    try {
      formatted = JSON.stringify(err);
    } catch {
      formatted = Object.prototype.toString.call(err);
    }
  }
  // Security: best-effort token redaction before returning/logging.
  return redactSensitiveText(formatted);
}

/**
 * Render a non-Error `cause` value (string, number, plain object, etc.) for inclusion in
 * a flattened error chain. Returns `[object Object]`-free text without throwing.
 */
export function stringifyNonErrorCause(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function formatUncaughtError(err: unknown): string {
  if (extractErrorCode(err) === "INVALID_CONFIG") {
    return formatErrorMessage(err);
  }
  if (err instanceof Error) {
    const stack = err.stack ?? err.message ?? err.name;
    return redactSensitiveText(stack);
  }
  return formatErrorMessage(err);
}

export type ErrorKind = "refusal" | "timeout" | "rate_limit" | "context_length" | "unknown";

export function detectErrorKind(err: unknown): ErrorKind | undefined {
  if (err === undefined) {
    return undefined;
  }
  const message = formatErrorMessage(err).toLowerCase();
  const code = extractErrorCode(err)?.toLowerCase();

  if (
    message.includes("refusal") ||
    message.includes("content_filter") ||
    message.includes("sensitive") ||
    message.includes("unhandled stop reason: refusal_policy")
  ) {
    return "refusal";
  }
  if (message.includes("timeout") || code === "etimedout" || code === "timeout") {
    return "timeout";
  }
  if (
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("429") ||
    code === "429"
  ) {
    return "rate_limit";
  }
  if (
    message.includes("context length") ||
    message.includes("too many tokens") ||
    message.includes("token limit") ||
    message.includes("context_window")
  ) {
    return "context_length";
  }
  return undefined;
}
