/**
 * Absolute minimum prompt budget in tokens.  When the context window is
 * large enough that `contextTokenBudget * MIN_PROMPT_BUDGET_RATIO` exceeds
 * this value, this absolute floor takes precedence.
 */
const MIN_PROMPT_BUDGET_TOKENS = 8_000;

/**
 * Minimum share of the context window that must remain available for prompt
 * content after reserve tokens are subtracted.
 */
const MIN_PROMPT_BUDGET_RATIO = 0.5;

/** Caps compaction headroom so every model retains its minimum usable prompt budget. */
export function resolveEffectiveCompactionReserveTokens(params: {
  contextTokenBudget: number;
  reserveTokens: number;
}): number {
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const minPromptBudget = Math.min(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)),
  );
  return Math.min(
    Math.max(0, Math.floor(params.reserveTokens)),
    Math.max(0, contextTokenBudget - minPromptBudget),
  );
}

export const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
