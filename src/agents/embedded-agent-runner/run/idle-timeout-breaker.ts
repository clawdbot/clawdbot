/**
 * Cap on consecutive attempts that ended in an idle timeout without completed
 * model progress, before the outer run loop refuses to start another attempt.
 * Distinct from MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES (which gates one extra
 * retry on the same model before failover) and the broad MAX_RUN_LOOP_ITERATIONS
 * backstop in run.ts.
 *
 * This one fires across profile/auth retries inside the same embedded run so a
 * wedged provider cannot fan out paid model calls across every fallback profile
 * in sequence. Resets when an attempt produces completed text or tool-call
 * progress, but not merely because the provider billed partial output tokens.
 *
 * See issue #76293 for the original report (single heartbeat fire generating
 * 761-1384 paid Anthropic calls in 60 seconds, costing $20-30 per incident).
 */
export const MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT = 5;

export type IdleTimeoutBreakerState = {
  consecutiveIdleTimeoutsBeforeOutput: number;
};

export function createIdleTimeoutBreakerState(): IdleTimeoutBreakerState {
  return { consecutiveIdleTimeoutsBeforeOutput: 0 };
}

export type IdleTimeoutBreakerInput = {
  idleTimedOut: boolean;
  completedModelProgress: boolean;
  outputTokens?: number;
};

export type IdleTimeoutBreakerStep = {
  consecutive: number;
  tripped: boolean;
};

/**
 * Update the breaker counter from the latest attempt's outcome and report
 * whether the cap is now tripped. Designed to be called from the outer run
 * loop right after an embedded attempt completes.
 *
 * Pure function modulo the mutable `state.consecutiveIdleTimeoutsBeforeOutput`
 * field, so the caller decides where the state lives (typically a `let` in
 * the outer loop).
 *
 * Decision table:
 *   idleTimedOut  completedModelProgress   action
 *   ------------  ----------------------   ------
 *   true          false                    count += 1   (wedged provider candidate)
 *   true          true                     count = 0    (model is alive but slow tail)
 *   false         true                     count = 0    (clean progress, all good)
 *   false         false                    count unchanged (e.g. non-timeout error;
 *                                                          don't poison or reset)
 *
 * The "false / false" branch matters: a non-timeout error attempt with no
 * completed progress should not reset the breaker (it isn't a sign the
 * provider is healthy), but it also shouldn't increment it (the issue at hand
 * is idle timeouts, not arbitrary errors).
 *
 * `outputTokens` is intentionally not part of the reset condition. Some
 * transports can accumulate billed output tokens from partial tool-call
 * argument deltas before the model stalls; those tokens are cost, not completed
 * progress, so they must not keep the breaker disarmed.
 */
export function stepIdleTimeoutBreaker(
  state: IdleTimeoutBreakerState,
  input: IdleTimeoutBreakerInput,
  options?: { cap?: number },
): IdleTimeoutBreakerStep {
  const cap = options?.cap ?? MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT;

  if (input.idleTimedOut && !input.completedModelProgress) {
    state.consecutiveIdleTimeoutsBeforeOutput += 1;
  } else if (input.completedModelProgress) {
    state.consecutiveIdleTimeoutsBeforeOutput = 0;
  }

  return {
    consecutive: state.consecutiveIdleTimeoutsBeforeOutput,
    tripped: cap > 0 && state.consecutiveIdleTimeoutsBeforeOutput >= cap,
  };
}
