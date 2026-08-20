import type { OpenClawConfig } from "../config/types.openclaw.js";

const DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const DEFAULT_SESSION_WRITE_LOCK_STALE_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS = 5 * 60 * 1000;

/**
 * @deprecated Session write leases were removed. This compatibility type is scheduled for
 * removal in the 2026.10 release train; use the session lane and durable writer claim/fence.
 */
export type SessionWriteLockAcquireTimeoutConfig = OpenClawConfig;

type LockParams = {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
  maxHoldMs?: number;
  signal?: AbortSignal;
} & (
  | { targetKind: "session-key"; allowReentrant?: boolean; reentrantOwner?: never }
  | { targetKind?: "file"; reentrantOwner?: string; allowReentrant?: never }
);

/**
 * @deprecated Session write leases were removed. This compatibility stub is scheduled for
 * removal in the 2026.10 release train; use the session lane and durable writer claim/fence.
 */
export function resolveSessionWriteLockAcquireTimeoutMs(
  _config?: SessionWriteLockAcquireTimeoutConfig,
  _env?: NodeJS.ProcessEnv,
): number {
  return DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS;
}

/**
 * @deprecated Session write leases were removed. This compatibility stub is scheduled for
 * removal in the 2026.10 release train; use the session lane and durable writer claim/fence.
 */
export function resolveSessionWriteLockOptions(
  _config?: SessionWriteLockAcquireTimeoutConfig,
  _params: { env?: NodeJS.ProcessEnv; maxHoldMsFallback?: number } = {},
): { timeoutMs: number; staleMs: number; maxHoldMs: number } {
  return {
    timeoutMs: DEFAULT_SESSION_WRITE_LOCK_ACQUIRE_TIMEOUT_MS,
    staleMs: DEFAULT_SESSION_WRITE_LOCK_STALE_MS,
    maxHoldMs: DEFAULT_SESSION_WRITE_LOCK_MAX_HOLD_MS,
  };
}

/**
 * @deprecated Session write leases were removed. This no-op compatibility stub is scheduled
 * for removal in the 2026.10 release train; use the session lane and durable writer claim/fence.
 */
export async function acquireSessionWriteLock(
  _params: LockParams,
): Promise<{ assertOwned: () => void; release: () => Promise<void> }> {
  return {
    assertOwned: () => undefined,
    release: async () => undefined,
  };
}
