/** Stable session ownership errors shared by runtime and public harness adapters. */
const TIMEOUT_CODE = "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT";
const STALE_CODE = "OPENCLAW_SESSION_WRITE_LOCK_STALE";

export class SessionWriteLockTimeoutError extends Error {
  readonly code = TIMEOUT_CODE;
  declare readonly timeoutMs: number;
  declare readonly owner: string;
  declare readonly lockPath: string;

  constructor(params: { timeoutMs: number; owner: string; lockPath: string }) {
    super(
      `session file locked (timeout ${params.timeoutMs}ms): ${params.owner} ${params.lockPath}`,
    );
    this.name = "SessionWriteLockTimeoutError";
    Object.assign(this, params);
  }
}

export class SessionWriteLockStaleError extends Error {
  readonly code = STALE_CODE;
  declare readonly owner: string;
  declare readonly lockPath: string;
  declare readonly staleReasons: string[];

  constructor(params: { owner: string; lockPath: string; staleReasons?: string[] }) {
    const staleReasons = params.staleReasons?.length ? params.staleReasons : ["unknown"];
    super(
      `session file lock stale (${staleReasons.join(", ")}): ${params.owner} ${params.lockPath}`,
    );
    this.name = "SessionWriteLockStaleError";
    Object.assign(this, params, { staleReasons });
  }
}

/** Returns whether another owner replaced the active SQLite session lease. */
export function isSessionWriteLockLeaseLostError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const staleReasons = (error as { staleReasons?: unknown } | null)?.staleReasons;
  return (
    (error instanceof SessionWriteLockStaleError || code === STALE_CODE) &&
    Array.isArray(staleReasons) &&
    staleReasons.includes("lease-lost")
  );
}

export function isSessionWriteLockAcquireError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    error instanceof SessionWriteLockTimeoutError ||
    error instanceof SessionWriteLockStaleError ||
    code === TIMEOUT_CODE ||
    code === STALE_CODE
  );
}
