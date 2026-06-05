/**
 * Timer delay normalization for Browser waits and cleanup loops.
 */
/** Largest timeout delay accepted reliably by Node timers. */
export const MAX_SAFE_TIMEOUT_DELAY_MS = 2_147_483_647;

/** Clamps timer delays to Node's safe range with an optional lower bound. */
export function normalizeBrowserTimerDelayMs(timeoutMs: number, opts?: { minMs?: number }): number {
  const rawMinMs = opts?.minMs ?? 1;
  const minMs = Math.min(
    MAX_SAFE_TIMEOUT_DELAY_MS,
    Math.max(0, Number.isFinite(rawMinMs) ? Math.floor(rawMinMs) : 1),
  );
  const candidateMs = Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : minMs;
  return Math.min(MAX_SAFE_TIMEOUT_DELAY_MS, Math.max(minMs, candidateMs));
}
