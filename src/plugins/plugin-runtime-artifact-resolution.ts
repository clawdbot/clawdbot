/** Resolves the exact root and entry selected by the plugin runtime loader. */
import path from "node:path";
import type { OpenClawPackageManifest } from "./manifest.js";
import { pluginCacheExistsSync, pluginCacheRealpathSync } from "./plugin-cache-files.js";
import { getPluginCacheRoot } from "./plugin-cache.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { resolvePreferredBuiltRuntimeArtifact } from "./plugin-runtime-artifact-selection.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry, requireActivePluginRegistry } from "./runtime.js";

type PluginRuntimeArtifactEntryKind = "runtime" | "setup" | "provider-discovery";

export function clearPluginRuntimeArtifactResolutionMemo(): void {
  getActivePluginRegistry()?.pluginRuntimeArtifacts.clear();
}

/** Canonical packaged runtime replaces staging-only dist-runtime artifacts. */
export function resolveCanonicalDistRuntimeSource(source: string): string {
  const marker = `${path.sep}dist-runtime${path.sep}extensions${path.sep}`;
  const index = source.indexOf(marker);
  if (index === -1) {
    return source;
  }
  const candidate = `${source.slice(0, index)}${path.sep}dist${path.sep}extensions${path.sep}${source.slice(index + marker.length)}`;
  return pluginCacheExistsSync(candidate) ? candidate : source;
}

/** Applies both loader selection phases in their runtime order. */
export function resolvePluginRuntimeArtifact(params: {
  pluginId: string;
  entryKind: PluginRuntimeArtifactEntryKind;
  source: string;
  rootDir: string;
  origin: PluginOrigin;
  preferBuiltPluginArtifacts: boolean;
  packageManifest?: OpenClawPackageManifest;
  registry?: PluginRegistry;
}): { source: string; rootDir: string } {
  const rootDir = resolveCanonicalDistRuntimeSource(
    pluginCacheRealpathSync(params.rootDir) ?? path.resolve(params.rootDir),
  );
  const memoKey = JSON.stringify([params.pluginId, rootDir, params.entryKind]);
  const targetRegistry = params.registry ?? requireActivePluginRegistry();
  const cached = targetRegistry.pluginRuntimeArtifacts.get(memoKey);
  if (cached) {
    return { ...cached };
  }
  const artifacts = getPluginCacheRoot(rootDir).runtimeArtifacts;
  const selectionKey = JSON.stringify([
    params.source,
    params.entryKind,
    params.origin,
    params.preferBuiltPluginArtifacts,
    params.packageManifest?.build?.bundledDist,
  ]);
  let resolved = artifacts.get(selectionKey);
  if (!resolved) {
    const source = resolveCanonicalDistRuntimeSource(
      pluginCacheRealpathSync(params.source) ?? path.resolve(params.source),
    );
    const preferred = resolvePreferredBuiltRuntimeArtifact({ ...params, source, rootDir });
    resolved = {
      source: resolveCanonicalDistRuntimeSource(preferred.source),
      rootDir: resolveCanonicalDistRuntimeSource(preferred.rootDir),
    };
    artifacts.set(selectionKey, resolved);
  }
  // A registry binds hooks and tools to one entry even when callers disagree on
  // source/build preference. Only filesystem selection facts belong to the cache.
  targetRegistry.pluginRuntimeArtifacts.set(memoKey, resolved);
  return { ...resolved };
}
