/** Return comparable nonnegative finite counts only when compaction reduced the estimate. */
export function resolveCompactionTokenDecrease(
  tokensBefore: unknown,
  tokensAfter: unknown,
): { before: number; after: number } | undefined {
  return typeof tokensBefore === "number" &&
    Number.isFinite(tokensBefore) &&
    tokensBefore >= 0 &&
    typeof tokensAfter === "number" &&
    Number.isFinite(tokensAfter) &&
    tokensAfter >= 0 &&
    tokensBefore > tokensAfter
    ? { before: tokensBefore, after: tokensAfter }
    : undefined;
}
