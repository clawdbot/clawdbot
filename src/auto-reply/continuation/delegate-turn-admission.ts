/**
 * Ephemeral per-provider-turn admission budget for `continue_delegate`.
 *
 * `maxDelegatesPerTurn` is a per-turn cap, but the embedded runner builds the
 * OpenClaw tool list once per agent run, so a closure counter on the tool would
 * accumulate across every assistant turn in that run and wrongly reject a later
 * turn's first delegate. The budget therefore lives here, keyed by session, and
 * is reset once for the actual provider turn before the embedded run starts
 * (not on assistant stream item changes) so each turn starts fresh while still
 * capping fan-out within a single turn.
 *
 * This is deliberately volatile: the budget is turn-scoped rate state, not
 * durable delegate substrate (that stays in the TaskFlow-backed delegate-store).
 * A lost budget on restart simply means the next turn starts at zero, which is
 * the correct post-restart state.
 */

const delegatesScheduledThisTurn = new Map<string, number>();

/**
 * Reset a session's per-turn delegate budget. Called at the provider-turn
 * boundary so a later turn in the same run gets a fresh `maxDelegatesPerTurn`.
 */
export function resetContinueDelegateTurnBudget(sessionKey: string): void {
  delegatesScheduledThisTurn.delete(sessionKey);
}

/** Current count of delegates scheduled by `continue_delegate` this turn. */
export function peekContinueDelegatesScheduledThisTurn(sessionKey: string): number {
  return delegatesScheduledThisTurn.get(sessionKey) ?? 0;
}

/**
 * Record one delegate scheduled this turn and return the new count. Call only
 * after the delegate has been staged/enqueued so the count matches durable work.
 */
export function recordContinueDelegateScheduledThisTurn(sessionKey: string): number {
  const next = (delegatesScheduledThisTurn.get(sessionKey) ?? 0) + 1;
  delegatesScheduledThisTurn.set(sessionKey, next);
  return next;
}

/** Clears all per-turn budgets. Test-only. */
export function resetContinueDelegateTurnAdmissionForTests(): void {
  delegatesScheduledThisTurn.clear();
}
