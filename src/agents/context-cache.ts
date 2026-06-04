/** Process-local model context window cache keyed by model id. */
export const MODEL_CONTEXT_TOKEN_CACHE = new Map<string, number>();

/** Looks up cached context-token count for a model id. */
export function lookupCachedContextTokens(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  return MODEL_CONTEXT_TOKEN_CACHE.get(modelId);
}
