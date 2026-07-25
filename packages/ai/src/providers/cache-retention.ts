import type { CacheRetention } from "../types.js";

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses OPENCLAW_CACHE_RETENTION for backward compatibility.
 */
export function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
  if (cacheRetention) {
    return cacheRetention;
  }
  if (typeof process !== "undefined" && process.env.OPENCLAW_CACHE_RETENTION === "long") {
    return "long";
  }
  return "short";
}
