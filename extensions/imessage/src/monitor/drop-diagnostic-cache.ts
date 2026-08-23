import { createDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";

const THROTTLED_DROP_DIAGNOSTIC_CACHE_MAX_SIZE = 512;

export function createIMessageThrottledDropDiagnosticCache() {
  // Bound monitor-lifetime warn-once state; evicted conversations may log again.
  return createDedupeCache({
    maxSize: THROTTLED_DROP_DIAGNOSTIC_CACHE_MAX_SIZE,
    ttlMs: 0,
  });
}
