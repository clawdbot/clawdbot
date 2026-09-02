type ContextWindowCacheState = {
  configuredTokenCache: Map<string, number>;
  discoveredTokenCache: Map<string, number>;
  contextWindowCache: Map<string, number>;
};

const CONTEXT_WINDOW_CACHE_STATE_KEY = Symbol.for("openclaw.contextWindowCacheState");
const contextWindowCacheGlobal = globalThis as typeof globalThis & {
  [CONTEXT_WINDOW_CACHE_STATE_KEY]?: ContextWindowCacheState;
};
export const REUSED_CONTEXT_WINDOW_CACHE_STATE =
  contextWindowCacheGlobal[CONTEXT_WINDOW_CACHE_STATE_KEY] !== undefined;
const CONTEXT_WINDOW_CACHE_STATE = (contextWindowCacheGlobal[CONTEXT_WINDOW_CACHE_STATE_KEY] ??= {
  configuredTokenCache: new Map(),
  discoveredTokenCache: new Map(),
  contextWindowCache: new Map(),
});

/** Returns the current process-global cache generation. */
export function getContextWindowCaches(): ContextWindowCacheState {
  return CONTEXT_WINDOW_CACHE_STATE;
}

/** Publish one complete context generation without copying it on the gateway thread. */
export function replaceContextWindowCaches(params: ContextWindowCacheState): void {
  CONTEXT_WINDOW_CACHE_STATE.configuredTokenCache = params.configuredTokenCache;
  CONTEXT_WINDOW_CACHE_STATE.discoveredTokenCache = params.discoveredTokenCache;
  CONTEXT_WINDOW_CACHE_STATE.contextWindowCache = params.contextWindowCache;
}

/** Publish one complete discovered-metadata generation. */
export function replaceDiscoveredContextTokenCache(cache: Map<string, number>): void {
  CONTEXT_WINDOW_CACHE_STATE.discoveredTokenCache = cache;
}

/** Clear the current process-global cache generation. */
export function clearContextWindowCaches(): void {
  CONTEXT_WINDOW_CACHE_STATE.configuredTokenCache.clear();
  CONTEXT_WINDOW_CACHE_STATE.discoveredTokenCache.clear();
  CONTEXT_WINDOW_CACHE_STATE.contextWindowCache.clear();
}

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
    CONTEXT_WINDOW_CACHE_STATE.configuredTokenCache.get(modelId) ??
    CONTEXT_WINDOW_CACHE_STATE.discoveredTokenCache.get(modelId)
  );
}

/** Looks up a configured native context window without treating it as an effective runtime cap. */
export function lookupCachedContextWindow(modelId?: string): number | undefined {
  if (!modelId) {
    return undefined;
  }
  return CONTEXT_WINDOW_CACHE_STATE.contextWindowCache.get(modelId);
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
