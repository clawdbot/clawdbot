// Memory Host SDK module implements read retry behavior.
import { retryAsync } from "./retry-utils.js";

// Retry helper for transient filesystem reads observed on memory stores.

const TRANSIENT_MEMORY_READ_ERRNO = -11;
const TRANSIENT_MEMORY_READ_CODES = new Set(["EAGAIN", "EWOULDBLOCK", "EDEADLK"]);
const TRANSIENT_MEMORY_READ_MESSAGE = /Unknown system error -11\b/i;

/** Extract errno from Node filesystem-style errors. */
function getErrno(error: unknown): number | undefined {
  return typeof (error as NodeJS.ErrnoException | undefined)?.errno === "number"
    ? (error as NodeJS.ErrnoException).errno
    : undefined;
}

/** Extract code from Node filesystem-style errors. */
function getCode(error: unknown): string | undefined {
  return typeof (error as NodeJS.ErrnoException | undefined)?.code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/** Return true for transient memory read failures that should be retried. */
export function isTransientMemoryReadError(error: unknown): boolean {
  const code = getCode(error);
  if (code && TRANSIENT_MEMORY_READ_CODES.has(code)) {
    return true;
  }

  const errno = getErrno(error);
  if (errno === TRANSIENT_MEMORY_READ_ERRNO) {
    return true;
  }

  return error instanceof Error && TRANSIENT_MEMORY_READ_MESSAGE.test(error.message);
}

/** Retry a memory read with the narrow transient error predicate. */
export async function retryTransientMemoryRead<T>(
  read: () => Promise<T>,
  label = "memory read",
): Promise<T> {
  return await retryAsync(read, {
    attempts: 3,
    minDelayMs: 25,
    maxDelayMs: 50,
    label,
    shouldRetry: (error) => isTransientMemoryReadError(error),
  });
}
