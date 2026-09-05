import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createPluginCacheArtifacts,
  createPluginRootArtifacts,
  type PluginSourceCacheRecord,
} from "./plugin-cache-artifacts.js";
import type {
  PluginDirectoryCacheEntry,
  PluginEntryCheck,
  PluginFileCacheEntry,
  PluginPathCacheEntry,
} from "./plugin-cache-files.types.js";
import {
  createPluginCacheManagement,
  type PluginCacheManagement,
} from "./plugin-cache-management.js";
import { createPluginCacheMetadata, type PluginCacheMetadata } from "./plugin-cache-metadata.js";
import { createPluginCacheSdk, type PluginCacheSdk } from "./plugin-cache-sdk.js";

export type PluginRootCacheRecord = ReturnType<typeof createPluginRootArtifacts> & {
  rootDir: string;
  files: Map<string, PluginFileCacheEntry>;
  checkedEntries: Map<string, PluginEntryCheck>;
  paths: Map<string, PluginPathCacheEntry>;
  directory?: PluginDirectoryCacheEntry;
};

export interface PluginCache
  extends
    PluginCacheMetadata,
    PluginCacheManagement<PluginCache>,
    ReturnType<typeof createPluginCacheArtifacts> {
  kind: "process" | "operation";
  roots: Map<string, PluginRootCacheRecord>;
  rootAliases: Map<string, string>;
  sdk: PluginCacheSdk;
}

const state = resolveGlobalSingleton<{
  current?: PluginCache;
  scope: AsyncLocalStorage<PluginCache>;
  snapshotOwners: WeakMap<object, PluginCache>;
}>(Symbol.for("openclaw.pluginCache"), () => ({
  scope: new AsyncLocalStorage<PluginCache>(),
  snapshotOwners: new WeakMap(),
}));

/** A cache generation owns progressively acquired facts, never mutable activation state. */
export function createPluginCache(options: { kind?: PluginCache["kind"] } = {}): PluginCache {
  return {
    kind: options.kind ?? "operation",
    roots: new Map(),
    rootAliases: new Map(),
    sdk: createPluginCacheSdk(),
    ...createPluginCacheMetadata(),
    ...createPluginCacheManagement<PluginCache>(),
    ...createPluginCacheArtifacts(),
  };
}

export function getProcessPluginCache(): PluginCache {
  return (state.current ??= createPluginCache({ kind: "process" }));
}

/** Startup publishes its complete owner, including facts acquired before the kernel existed. */
export function adoptProcessPluginCache(cache: PluginCache): void {
  cache.kind = "process";
  state.current = cache;
}

export function getScopedPluginCache(): PluginCache | undefined {
  return state.scope.getStore();
}

export function getPluginCache(): PluginCache {
  return getScopedPluginCache() ?? getProcessPluginCache();
}

export function withPluginCache<T>(cache: PluginCache, run: () => T): T {
  return state.scope.run(cache, run);
}

/** Frozen views retain their producer so deferred access fills the same generation. */
export function bindPluginMetadataSnapshotCache(snapshot: object, cache = getPluginCache()): void {
  state.snapshotOwners.set(snapshot, cache);
}

export function getPluginMetadataSnapshotCache(snapshot: object): PluginCache {
  return state.snapshotOwners.get(snapshot) ?? getPluginCache();
}

/** Only the lifecycle owner retires the process cache; operation scopes remain independent. */
export function resetPluginCache(): void {
  const previous = state.current;
  state.current = undefined;
  previous?.disposeModules?.();
}

export function getPluginCacheRoot(rootDir: string): PluginRootCacheRecord {
  const cache = getPluginCache();
  // Alias binding can replace the canonical record while older lexical records remain.
  const cached = cache.roots.get(cache.rootAliases.get(rootDir) ?? rootDir);
  if (cached) {
    return cached;
  }
  const lexical = path.resolve(rootDir);
  const key = cache.rootAliases.get(lexical) ?? lexical;
  let root = cache.roots.get(key);
  if (!root) {
    root = {
      rootDir: key,
      files: new Map(),
      checkedEntries: new Map(),
      paths: new Map(),
      ...createPluginRootArtifacts(),
    };
    cache.roots.set(key, root);
  }
  return root;
}

function mergeRootFacts<T>(target: Map<string, T>, source: Map<string, T>): void {
  for (const [key, value] of source) {
    if (!target.has(key)) {
      target.set(key, value);
    }
  }
}

/** Bind aliases only after a checked file establishes their shared package boundary. */
export function bindPluginCacheRoot(rootDir: string, canonicalRoot: string): PluginRootCacheRecord {
  const cache = getPluginCache();
  const lexical = path.resolve(rootDir);
  const canonical = path.resolve(canonicalRoot);
  const root = getPluginCacheRoot(lexical);
  root.rootDir = canonical;
  const existing = cache.roots.get(canonical);
  if (existing && existing !== root) {
    // Preserve the first checked facts while sharing maps with retained root references.
    mergeRootFacts(root.files, existing.files);
    mergeRootFacts(root.checkedEntries, existing.checkedEntries);
    mergeRootFacts(root.paths, existing.paths);
    mergeRootFacts(root.artifacts, existing.artifacts);
    mergeRootFacts(root.runtimeArtifacts, existing.runtimeArtifacts);
    mergeRootFacts(root.entryBoundaries, existing.entryBoundaries);
    mergeRootFacts(root.entryPaths, existing.entryPaths);
    root.directory ??= existing.directory;
    root.publicSurfaceBoundary ??= existing.publicSurfaceBoundary;
    for (const artifact of existing.artifactLoadsInProgress) {
      root.artifactLoadsInProgress.add(artifact);
    }
    Object.assign(existing, root);
  }
  cache.roots.set(canonical, root);
  cache.rootAliases.set(lexical, canonical);
  return root;
}

export function getPluginCacheSource(
  modulePath: string,
  cache = getPluginCache(),
): PluginSourceCacheRecord {
  const lexical = path.resolve(
    modulePath.startsWith("file:") ? fileURLToPath(modulePath) : modulePath,
  );
  const key = cache.sourceAliases.get(lexical) ?? lexical;
  let source = cache.sources.get(key);
  if (!source) {
    source = { variants: new Map(), validatedBoundaries: new Set() };
    cache.sources.set(key, source);
  }
  return source;
}
