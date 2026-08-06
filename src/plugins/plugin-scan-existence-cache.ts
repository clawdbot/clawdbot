/** Scan-scoped existence cache for plugin discovery hot paths.
 *
 * Plugin metadata is process-stable: installs, manifests, and catalogs change
 * only on restart or an explicit owner reload/install/doctor flow (see
 * AGENTS.md). A single cold-start discovery scan still re-probes the same paths
 * many times — `detectBundleManifestFormat` checks `skills/`, `.mcp.json`,
 * `settings.json`, ... and `loadBundleManifest`'s capability builders check
 * them again. Across bundled plugins that is thousands of synchronous
 * `fs.existsSync` calls; the issue reports 25.4s of self-time on Windows cold
 * start.
 *
 * This memoizes existence results for the lifetime of ONE scan pass only. A
 * later install/repair pass runs without an active cache (or under a fresh
 * cache), so marker files that appear mid-process are never served stale — the
 * freshness bug a process-global cache would reintroduce. Outside a scan,
 * `pluginScanExistsSync` falls back to plain `fs.existsSync`, so one-off
 * callers (install, hooks, doctor) stay correct and uncached. */
import fs from "node:fs";

// Stack so nested wrapped scans get isolated caches and always pop on exit.
// Discovery scans are synchronous, so a single active cache is safe; an async
// scan would need its own scope rather than sharing this module state.
const scanExistenceCacheStack: Map<string, boolean>[] = [];

/** Runs `fn` with a scan-scoped existence cache active. Sync-only. */
export function withPluginScanExistenceCache<T>(fn: () => T): T {
  scanExistenceCacheStack.push(new Map());
  try {
    return fn();
  } finally {
    scanExistenceCacheStack.pop();
  }
}

/** `fs.existsSync` memoized for the active scan pass, if any.
 *
 * Outside `withPluginScanExistenceCache` this is plain `fs.existsSync`, so
 * callers that are not part of a scan pay no caching cost or staleness. */
export function pluginScanExistsSync(targetPath: string): boolean {
  const cache = scanExistenceCacheStack[scanExistenceCacheStack.length - 1];
  if (!cache) {
    return fs.existsSync(targetPath);
  }
  const cached = cache.get(targetPath);
  if (cached !== undefined) {
    return cached;
  }
  const result = fs.existsSync(targetPath);
  cache.set(targetPath, result);
  return result;
}
