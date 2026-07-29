/** Process-local model context window cache keyed by model id. */
export const MODEL_CONTEXT_TOKEN_CACHE = new Map<string, number>();
export const MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE = new Map<string, number>();
export const MODEL_CONTEXT_WINDOW_CACHE = new Map<string, number>();

const PROVIDER_CONTEXT_TOKEN_CACHE_PREFIX = "\0provider:";

/** Internal cache key for discovery metadata with verified provider ownership. */
export function providerContextTokenCacheKey(provider: string, modelId: string): string {
  return `${PROVIDER_CONTEXT_TOKEN_CACHE_PREFIX}${provider}\0${modelId}`;
}

/** Looks up cached context-token count for a model id. */
export function lookupCachedContextTokens(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  return (
    MODEL_CONFIGURED_CONTEXT_TOKEN_CACHE.get(modelId) ?? MODEL_CONTEXT_TOKEN_CACHE.get(modelId)
  );
}

/** Looks up a configured native context window without treating it as an effective runtime cap. */
export function lookupCachedContextWindow(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  return MODEL_CONTEXT_WINDOW_CACHE.get(modelId);
}

/** Returns the lowest positive context limit from independently sourced metadata. */
export function minPositiveContextTokens(...values: Array<number | undefined>): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (typeof value !== "number" || value <= 0) {
      continue;
    }
    result = result === undefined ? value : Math.min(result, value);
  }
  return result;
}
