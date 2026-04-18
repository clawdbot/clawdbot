import type { FileLockOptions } from "openclaw/plugin-sdk/file-lock";

export const MATRIX_IDB_PERSIST_INTERVAL_MS = 60_000;

const IDB_SNAPSHOT_LOCK_STALE_MS = 5 * 60_000;
const IDB_SNAPSHOT_LOCK_RETRY_BASE = {
  factor: 2,
  minTimeout: 50,
  maxTimeout: 5_000,
  randomize: true,
} satisfies Omit<FileLockOptions["retries"], "retries">;

function computeRetryDelayMs(retries: FileLockOptions["retries"], attempt: number): number {
  return Math.min(
    retries.maxTimeout,
    Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt),
  );
}

export function computeMinimumRetryWindowMs(retries: FileLockOptions["retries"]): number {
  let total = 0;
  const attempts = Math.max(1, retries.retries + 1);
  for (let attempt = 0; attempt < attempts - 1; attempt += 1) {
    total += computeRetryDelayMs(retries, attempt);
  }
  return total;
}

function resolveRetriesForMinimumWindowMs(
  retries: Omit<FileLockOptions["retries"], "retries">,
  minimumWindowMs: number,
): FileLockOptions["retries"] {
  const resolved: FileLockOptions["retries"] = {
    ...retries,
    retries: 0,
  };
  while (computeMinimumRetryWindowMs(resolved) < minimumWindowMs) {
    resolved.retries += 1;
  }
  return resolved;
}

export const MATRIX_IDB_SNAPSHOT_LOCK_OPTIONS: FileLockOptions = {
  // Wait longer than one periodic persist interval so a concurrent restore
  // or large snapshot dump finishes instead of forcing warn-and-continue.
  retries: resolveRetriesForMinimumWindowMs(
    IDB_SNAPSHOT_LOCK_RETRY_BASE,
    MATRIX_IDB_PERSIST_INTERVAL_MS,
  ),
  stale: IDB_SNAPSHOT_LOCK_STALE_MS,
};
