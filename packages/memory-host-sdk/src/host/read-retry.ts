import { retryAsync } from "./retry-utils.js";

const TRANSIENT_MEMORY_READ_ERRNO = -11;
const TRANSIENT_MEMORY_READ_CODES = new Set(["EAGAIN", "EWOULDBLOCK", "EDEADLK"]);
const TRANSIENT_MEMORY_READ_MESSAGE = /Unknown system error -11\b/i;

function getErrno(error: unknown): number | undefined {
  return typeof (error as NodeJS.ErrnoException | undefined)?.errno === "number"
    ? (error as NodeJS.ErrnoException).errno
    : undefined;
}

function getCode(error: unknown): string | undefined {
  return typeof (error as NodeJS.ErrnoException | undefined)?.code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

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
