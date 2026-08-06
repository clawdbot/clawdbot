/** Return comparable finite counts only when compaction reduced the token estimate. */
export function resolveCompactionTokenDecrease(
  tokensBefore: unknown,
  tokensAfter: unknown,
): { before: number; after: number } | undefined {
  return typeof tokensBefore === "number" &&
    Number.isFinite(tokensBefore) &&
    typeof tokensAfter === "number" &&
    Number.isFinite(tokensAfter) &&
    tokensBefore > tokensAfter
    ? { before: tokensBefore, after: tokensAfter }
    : undefined;
}
