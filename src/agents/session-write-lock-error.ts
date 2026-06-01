const SESSION_WRITE_LOCK_TIMEOUT_CODE = "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT";
const SESSION_WRITE_LOCK_STALE_CODE = "OPENCLAW_SESSION_WRITE_LOCK_STALE";

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

export function isSessionWriteLockAcquireError(err: unknown): boolean {
  return isSessionWriteLockTimeoutError(err) || isSessionWriteLockStaleError(err);
}
