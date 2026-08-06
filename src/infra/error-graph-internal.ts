// Internal error-graph traversal shared by runtime classifiers.
import { collectErrorGraphCandidates, extractErrorCode } from "./errors.js";

export function extractErrorCodeOrErrno(err: unknown): string | undefined {
  const code = extractErrorCode(err);
  if (code) {
    return code.trim().toUpperCase();
  }
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === "string" && errno.trim()) {
    return errno.trim().toUpperCase();
  }
  if (typeof errno === "number" && Number.isFinite(errno)) {
    return String(errno);
  }
  return undefined;
}

export function collectNestedErrorCandidates(err: unknown): unknown[] {
  return collectErrorGraphCandidates(err, (current) => {
    const nested: unknown[] = [
      current.cause,
      current.reason,
      current.original,
      current.error,
      current.data,
    ];
    if (Array.isArray(current.errors)) {
      nested.push(...current.errors);
    }
    return nested;
  });
}
