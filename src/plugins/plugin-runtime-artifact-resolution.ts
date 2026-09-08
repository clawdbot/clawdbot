/** Resolves the exact root and entry selected by the plugin runtime loader. */
import path from "node:path";
import { pluginCacheRealpathSync } from "./plugin-cache-files.js";
import {
  resolveCanonicalDistRuntimeSource,
  resolvePluginRuntimeArtifactSelection,
  type PluginRuntimeArtifactSelectionParams,
} from "./plugin-runtime-artifact-selection.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry, requireActivePluginRegistry } from "./runtime.js";

export function clearPluginRuntimeArtifactResolutionMemo(): void {
  getActivePluginRegistry()?.pluginRuntimeArtifacts.clear();
}

/** Applies both loader selection phases in their runtime order. */
export function resolvePluginRuntimeArtifact(
  params: PluginRuntimeArtifactSelectionParams & {
    pluginId: string;
    registry?: PluginRegistry;
  },
): { source: string; rootDir: string } {
  const rootDir = resolveCanonicalDistRuntimeSource(
    pluginCacheRealpathSync(params.rootDir) ?? path.resolve(params.rootDir),
  );
  const memoKey = JSON.stringify([params.pluginId, rootDir, params.entryKind]);
  const targetRegistry = params.registry ?? requireActivePluginRegistry();
  const cached = targetRegistry.pluginRuntimeArtifacts.get(memoKey);
  if (cached) {
    return { ...cached };
  }
  const resolved = resolvePluginRuntimeArtifactSelection(params);
  // A registry binds hooks and tools to one entry even when callers disagree on
  // source/build preference. Only filesystem selection facts belong to the cache.
  targetRegistry.pluginRuntimeArtifacts.set(memoKey, resolved);
  return { ...resolved };
}
