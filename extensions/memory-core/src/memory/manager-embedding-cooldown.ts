// Memory Core plugin module implements embedding-provider billing cooldown state.

export type MemoryEmbeddingCooldownState = {
  providerId: string;
  untilMs: number;
  reason: string;
  consecutiveFailures: number;
};

const BASE_COOLDOWN_MS = 30 * 60_000;
const MAX_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Compute the next cooldown window for a repeated billing-exhausted embedding failure.
 * Exponential (30m, 1h, 2h, ... capped at 6h) since a quota/billing failure means "will
 * keep failing until the next cycle" — there is no signal for exactly when that is, so
 * the schedule only needs to bound how often a known-dead provider gets re-attempted.
 */
export function computeNextMemoryEmbeddingCooldown(params: {
  providerId: string;
  reason: string;
  previous?: MemoryEmbeddingCooldownState;
  nowMs: number;
}): MemoryEmbeddingCooldownState {
  const consecutiveFailures =
    params.previous?.providerId === params.providerId ? params.previous.consecutiveFailures + 1 : 1;
  const durationMs = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** (consecutiveFailures - 1));
  return {
    providerId: params.providerId,
    untilMs: params.nowMs + durationMs,
    reason: params.reason,
    consecutiveFailures,
  };
}

/** Whether the given cooldown state (if any) is still active for this provider. */
export function isMemoryEmbeddingCoolingDown(
  state: MemoryEmbeddingCooldownState | undefined,
  providerId: string,
  nowMs: number,
): boolean {
  return state !== undefined && state.providerId === providerId && nowMs < state.untilMs;
}
