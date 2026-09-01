type FallbackSkipCacheState = {
  buckets: Map<string, Map<string, unknown>>;
  lastGlobalPruneAtMs: number;
};

function getFallbackSkipCacheGlobals() {
  return globalThis as typeof globalThis & {
    openclawFallbackSkipCache?: Map<string, Map<string, unknown>>;
    openclawFallbackSkipCacheState?: FallbackSkipCacheState;
  };
}

export function resetFallbackSkipCacheForTest(): void {
  const globals = getFallbackSkipCacheGlobals();
  globals.openclawFallbackSkipCache?.clear();
  globals.openclawFallbackSkipCacheState?.buckets.clear();
  if (globals.openclawFallbackSkipCacheState) {
    globals.openclawFallbackSkipCacheState.lastGlobalPruneAtMs = 0;
  }
}

export function listFallbackSkipCacheSessionIdsForTest(): string[] {
  const globals = getFallbackSkipCacheGlobals();
  return [...(globals.openclawFallbackSkipCacheState?.buckets.keys() ?? [])];
}
