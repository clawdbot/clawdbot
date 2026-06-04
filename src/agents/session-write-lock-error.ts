/**
 * Session write-lock error types and guards.
 *
 * Session persistence uses stable error codes so callers can distinguish lock
 * contention or stale lock cleanup from ordinary write failures.
 */
const SESSION_WRITE_LOCK_TIMEOUT_CODE = "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT";
const SESSION_WRITE_LOCK_STALE_CODE = "OPENCLAW_SESSION_WRITE_LOCK_STALE";

/** Error thrown when a session write lock cannot be acquired before timeout. */
export class SessionWriteLockTimeoutError extends Error {
  readonly code = SESSION_WRITE_LOCK_TIMEOUT_CODE;
  readonly timeoutMs: number;
  readonly owner: string;
  readonly lockPath: string;

  constructor(params: { timeoutMs: number; owner: string; lockPath: string }) {
    super(
      `session file locked (timeout ${params.timeoutMs}ms): ${params.owner} ${params.lockPath}`,
    );
    this.name = "SessionWriteLockTimeoutError";
    this.timeoutMs = params.timeoutMs;
    this.owner = params.owner;
    this.lockPath = params.lockPath;
  }
}

/** Error thrown when an existing session write lock is stale and needs cleanup. */
export class SessionWriteLockStaleError extends Error {
  readonly code = SESSION_WRITE_LOCK_STALE_CODE;
  readonly owner: string;
  readonly lockPath: string;
  readonly staleReasons: string[];

  constructor(params: { owner: string; lockPath: string; staleReasons?: string[] }) {
    const staleReasons = params.staleReasons?.length ? params.staleReasons : ["unknown"];
    super(
      `session file lock stale (${staleReasons.join(", ")}): ${params.owner} ${params.lockPath}`,
    );
    this.name = "SessionWriteLockStaleError";
    this.owner = params.owner;
    this.lockPath = params.lockPath;
    this.staleReasons = staleReasons;
  }
}

/** Returns whether an error is a session write-lock timeout. */
export function isSessionWriteLockTimeoutError(err: unknown): boolean {
  return (
    err instanceof SessionWriteLockTimeoutError ||
    Boolean(
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === SESSION_WRITE_LOCK_TIMEOUT_CODE,
    )
  );
}

/** Returns whether an error is a stale session write-lock failure. */
export function isSessionWriteLockStaleError(err: unknown): boolean {
  return (
    err instanceof SessionWriteLockStaleError ||
    Boolean(
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === SESSION_WRITE_LOCK_STALE_CODE,
    )
  );
}

/** Returns whether an error is any session write-lock acquisition failure. */
export function isSessionWriteLockAcquireError(err: unknown): boolean {
  return isSessionWriteLockTimeoutError(err) || isSessionWriteLockStaleError(err);
}
