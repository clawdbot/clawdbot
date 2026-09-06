/**
 * Bundled channel plugin loader.
 *
 * Loads generated bundled channel entries, setup metadata, secrets, and legacy migration hooks.
 */
import path from "node:path";
import { extractErrorCode, formatErrorMessage } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  BundledChannelLegacySessionSurface,
  BundledEntryModuleLoadOptions,
} from "../../plugin-sdk/channel-entry-contract.types.js";
import {
  listBundledChannelPluginMetadata,
  resolveBundledChannelGeneratedPath,
  type BundledChannelPluginMetadata,
} from "../../plugins/bundled-channel-runtime.js";
import { unwrapDefaultModuleExport } from "../../plugins/module-export.js";
import { pluginCacheRealpathSync } from "../../plugins/plugin-cache-files.js";
import { getPluginCacheRoot, getPluginCacheSource } from "../../plugins/plugin-cache.js";
import { getCachedPluginModuleLoader } from "../../plugins/plugin-module-loader-cache.js";
import { resolveBundledChannelRootScope, type BundledChannelRootScope } from "./bundled-root.js";
import { normalizeChannelMeta } from "./meta-normalization.js";
import { loadChannelPluginModule } from "./module-loader.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

type PluginRuntime = import("../../plugins/runtime/types.js").PluginRuntime;

type BundledChannelEntryRuntimeContract = {
  kind: "bundled-channel-entry";
  id: string;
  name: string;
  description: string;
  features?: {
    accountInspect?: boolean;
  };
  register: (api: unknown) => void;
  loadChannelPlugin: (options?: BundledEntryModuleLoadOptions) => ChannelPlugin;
  loadChannelSecrets?: (
    options?: BundledEntryModuleLoadOptions,
  ) => ChannelPlugin["secrets"] | undefined;
  loadChannelAccountInspector?: (
    options?: BundledEntryModuleLoadOptions,
  ) => NonNullable<ChannelPlugin["config"]["inspectAccount"]>;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

type BundledChannelSetupEntryRuntimeContract = {
  kind: "bundled-channel-setup-entry";
  loadSetupPlugin: (options?: BundledEntryModuleLoadOptions) => ChannelPlugin;
  loadSetupSecrets?: (
    options?: BundledEntryModuleLoadOptions,
  ) => ChannelPlugin["secrets"] | undefined;
  loadLegacySessionSurface?: (
    options?: BundledEntryModuleLoadOptions,
  ) => BundledChannelLegacySessionSurface;
  features?: {
    legacySessionSurfaces?: boolean;
  };
};

type BundledChannelPackageSetupFeature =
  | "configPromotion"
  | "legacyStateMigrations"
  | "legacySessionSurfaces";

type BundledChannelArtifactValues = {
  entry: BundledChannelEntryRuntimeContract;
  setupEntry: BundledChannelSetupEntryRuntimeContract;
  plugin: ChannelPlugin;
  setupPlugin: ChannelPlugin;
  secrets: NonNullable<ChannelPlugin["secrets"]>;
  setupSecrets: NonNullable<ChannelPlugin["secrets"]>;
  accountInspector: NonNullable<ChannelPlugin["config"]["inspectAccount"]>;
};

type BundledChannelArtifactKind = keyof BundledChannelArtifactValues;
type BundledChannelEntryKind = "entry" | "setupEntry";
type BundledChannelArtifactLoadParams = {
  id: ChannelId;
  rootScope: BundledChannelRootScope;
};

const log = createSubsystemLogger("channels");

function isSourceModulePath(modulePath: string): boolean {
  return /\.(?:c|m)?tsx?$/iu.test(modulePath);
}

function resolveCanonicalPathOrAbsolute(targetPath: string): string {
  return pluginCacheRealpathSync(targetPath, true) ?? path.resolve(targetPath);
}

function isPathInsideCanonicalRoot(rootPath: string, targetPath: string): boolean {
  return isPathInside(
    resolveCanonicalPathOrAbsolute(rootPath),
    resolveCanonicalPathOrAbsolute(targetPath),
  );
}

function isPackageLocalBundledDistModulePath(params: {
  rootScope: BundledChannelRootScope;
  metadata: BundledChannelPluginMetadata;
  modulePath: string;
}): boolean {
  const distRoots = [
    ...(params.rootScope.pluginsDir
      ? [path.join(params.rootScope.pluginsDir, params.metadata.dirName, "dist")]
      : []),
    path.join(params.rootScope.packageRoot, "extensions", params.metadata.dirName, "dist"),
  ];
  return distRoots.some((root) => isPathInsideCanonicalRoot(root, params.modulePath));
}

function resolveBundledChannelModuleEntry<TKind extends BundledChannelEntryKind>(
  moduleExport: unknown,
  kind: TKind,
): BundledChannelArtifactValues[TKind] | null {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Record<string, unknown>;
  const setup = kind === "setupEntry";
  if (record.kind !== (setup ? "bundled-channel-setup-entry" : "bundled-channel-entry")) {
    return null;
  }
  const stringFields = setup ? [] : ["id", "name", "description"];
  const functionFields = setup ? ["loadSetupPlugin"] : ["register", "loadChannelPlugin"];
  if (
    stringFields.some((field) => typeof record[field] !== "string") ||
    functionFields.some((field) => typeof record[field] !== "function")
  ) {
    return null;
  }
  return record as BundledChannelArtifactValues[TKind];
}

function resolveBundledChannelBoundaryRoot(params: {
  packageRoot: string;
  pluginsDir?: string;
  metadata: BundledChannelPluginMetadata;
  modulePath: string;
}): string {
  const cacheKey = [
    params.packageRoot,
    params.pluginsDir ?? "",
    params.metadata.dirName,
    params.modulePath,
  ].join("\0");
  const artifacts = getPluginCacheRoot(params.packageRoot).artifacts;
  const cached = artifacts.get(`bundled-channel-boundary:${cacheKey}`);
  if (cached) {
    return cached.boundaryRoot;
  }
  const canonicalModulePath = resolveCanonicalPathOrAbsolute(params.modulePath);
  const sourceRoot = path.resolve(params.packageRoot, "extensions", params.metadata.dirName);
  const candidates = [
    ...(params.pluginsDir ? [path.resolve(params.pluginsDir, params.metadata.dirName)] : []),
    ...["dist", "dist-runtime"].map((layout) =>
      path.resolve(params.packageRoot, layout, "extensions", params.metadata.dirName),
    ),
    sourceRoot,
  ];
  const boundaryRoot =
    candidates
      .map(resolveCanonicalPathOrAbsolute)
      .find((root) => isPathInside(root, canonicalModulePath)) ??
    resolveCanonicalPathOrAbsolute(sourceRoot);
  artifacts.set(`bundled-channel-boundary:${cacheKey}`, {
    modulePath: params.modulePath,
    boundaryRoot,
  });
  return boundaryRoot;
}

function resolveGeneratedBundledChannelModulePath(params: {
  rootScope: BundledChannelRootScope;
  metadata: BundledChannelPluginMetadata;
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"];
}): string | null {
  if (!params.entry) {
    return null;
  }
  const generatedPath = resolveBundledChannelGeneratedPath(
    params.rootScope.packageRoot,
    params.entry,
    params.metadata.dirName,
    params.rootScope.pluginsDir,
  );
  if (generatedPath) {
    return generatedPath;
  }

  // Persisted registries can preserve a valid source-only bundled channel root while the
  // active mixed checkout prefers dist/extensions for other plugins. Resolve that authoritative
  // root directly, but keep the fallback inside the active package and plugin boundaries.
  const packageRoot = pluginCacheRealpathSync(params.rootScope.packageRoot, true);
  const pluginRoot = pluginCacheRealpathSync(params.metadata.rootDir, true);
  if (!packageRoot || !pluginRoot || !isPathInside(packageRoot, pluginRoot)) {
    return null;
  }
  for (const rawEntry of [params.entry.built, params.entry.source]) {
    if (!rawEntry) {
      continue;
    }
    const candidate = path.isAbsolute(rawEntry)
      ? path.normalize(rawEntry)
      : path.resolve(pluginRoot, rawEntry);
    const realCandidate = pluginCacheRealpathSync(candidate, true);
    if (realCandidate && isPathInside(pluginRoot, realCandidate)) {
      return realCandidate;
    }
  }
  return null;
}

function loadGeneratedBundledChannelModule(params: {
  rootScope: BundledChannelRootScope;
  metadata: BundledChannelPluginMetadata;
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"];
}): unknown {
  const modulePath = resolveGeneratedBundledChannelModulePath(params);
  if (!modulePath) {
    throw new Error(`missing generated module for bundled channel ${params.metadata.manifest.id}`);
  }
  const scanDir = params.rootScope.pluginsDir;
  const boundaryRoot = resolveBundledChannelBoundaryRoot({
    packageRoot: params.rootScope.packageRoot,
    ...(scanDir ? { pluginsDir: scanDir } : {}),
    metadata: params.metadata,
    modulePath,
  });
  try {
    return loadChannelPluginModule({
      modulePath,
      rootDir: boundaryRoot,
    });
  } catch (error) {
    const canRetryWithCachedLoader =
      isSourceModulePath(modulePath) ||
      (isPackageLocalBundledDistModulePath({
        rootScope: params.rootScope,
        metadata: params.metadata,
        modulePath,
      }) &&
        findMissingModuleCodeInChain(error) !== undefined);
    if (!canRetryWithCachedLoader) {
      throw error;
    }
    const loader = getCachedPluginModuleLoader({
      modulePath,
      importerUrl: import.meta.url,
      preferBuiltDist: true,
      cacheScopeKey: "bundled-channel-entry",
    });
    return loader(modulePath);
  }
}

// Walk the `.cause` chain looking for a Node-style "module not found" code.
// Native-require failures inside `module-loader.ts` rewrap the original Node
// error in a new Error with `{ cause }`, so the missing-module code lives on
// the cause rather than the top-level error.
function findMissingModuleCodeInChain(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const code = extractErrorCode(current);
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      return code;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function describeBundledChannelLoadError(error: unknown, channelId: string): string {
  const detail = formatErrorMessage(error);
  if (findMissingModuleCodeInChain(error) !== undefined) {
    return `${detail} (run \`openclaw doctor --fix\` to install missing bundled runtime dependencies for channel ${channelId})`;
  }
  return detail;
}

function loadGeneratedBundledChannelEntry<TKind extends BundledChannelEntryKind>(
  kind: TKind,
  rootScope: BundledChannelRootScope,
  metadata: BundledChannelPluginMetadata,
): BundledChannelArtifactValues[TKind] | undefined {
  const setup = kind === "setupEntry";
  const source = setup ? metadata.setupSource : metadata.source;
  if (setup && !source) {
    return undefined;
  }
  try {
    const entry = resolveBundledChannelModuleEntry(
      loadGeneratedBundledChannelModule({
        rootScope,
        metadata,
        entry: source,
      }),
      kind,
    );
    if (!entry) {
      const description = setup ? "setup entry" : "entry";
      const contract = setup ? "bundled-channel-setup-entry" : "bundled-channel-entry";
      log.warn(
        `[channels] bundled channel ${description} ${metadata.manifest.id} missing ${contract} contract; skipping`,
      );
    }
    return entry ?? undefined;
  } catch (error) {
    const detail = describeBundledChannelLoadError(error, metadata.manifest.id);
    const description = setup ? " setup entry" : "";
    log.warn(
      `[channels] failed to load bundled channel${description} ${metadata.manifest.id}: ${detail}`,
    );
    return undefined;
  }
}

function listBundledChannelMetadata(
  rootScope = resolveBundledChannelRootScope(),
): readonly BundledChannelPluginMetadata[] {
  const scanDir = rootScope.pluginsDir;
  return listBundledChannelPluginMetadata({
    rootDir: rootScope.packageRoot,
    ...(scanDir ? { scanDir } : {}),
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  }).filter((metadata) => (metadata.manifest.channels?.length ?? 0) > 0);
}

function listBundledChannelPluginIdsForRoot(
  rootScope: BundledChannelRootScope,
): readonly ChannelId[] {
  return listBundledChannelMetadata(rootScope)
    .map((metadata) => metadata.manifest.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function listBundledChannelPluginIds(): readonly ChannelId[] {
  return listBundledChannelPluginIdsForRoot(resolveBundledChannelRootScope());
}

export function hasBundledChannelPackageSetupFeature(
  id: ChannelId,
  feature: BundledChannelPackageSetupFeature,
): boolean {
  const rootScope = resolveBundledChannelRootScope();
  return (
    resolveBundledChannelMetadata(id, rootScope)?.packageManifest?.setupFeatures?.[feature] === true
  );
}

function resolveBundledChannelMetadata(
  id: ChannelId,
  rootScope: BundledChannelRootScope,
): BundledChannelPluginMetadata | undefined {
  return listBundledChannelMetadata(rootScope).findLast(
    (metadata) => metadata.manifest.id === id || metadata.manifest.channels?.includes(id),
  );
}

function rememberBundledChannelArtifact<TKind extends BundledChannelArtifactKind>(
  rootScope: BundledChannelRootScope,
  kind: TKind,
  id: ChannelId,
  artifact: BundledChannelArtifactValues[TKind] | undefined,
): void {
  const metadata = resolveBundledChannelMetadata(id, rootScope);
  if (metadata) {
    getPluginCacheSource(path.resolve(metadata.rootDir, metadata.source.source)).variants.set(
      `bundled-channel:${kind}:${id}`,
      { exports: { value: artifact } },
    );
  }
}

function getBundledChannelArtifactForRoot<TKind extends BundledChannelArtifactKind>(
  kind: TKind,
  id: ChannelId,
  rootScope: BundledChannelRootScope,
): BundledChannelArtifactValues[TKind] | undefined {
  const metadata = resolveBundledChannelMetadata(id, rootScope);
  if (!metadata) {
    return undefined;
  }
  const cached = getPluginCacheSource(
    path.resolve(metadata.rootDir, metadata.source.source),
  ).variants.get(`bundled-channel:${kind}:${id}`)?.exports;
  if (cached) {
    // SAFETY: rememberBundledChannelArtifact writes this key from the matching typed kind loader.
    return cached.value as BundledChannelArtifactValues[TKind] | undefined;
  }
  // Keep failure and recursion state separate by artifact kind: broken secrets
  // must never poison the runtime plugin, setup plugin, or entry contracts.
  const loadKey = `${kind}\0${id}`;
  const { artifactLoadsInProgress } = getPluginCacheRoot(metadata.rootDir);
  if (artifactLoadsInProgress.has(loadKey)) {
    return undefined;
  }
  artifactLoadsInProgress.add(loadKey);
  try {
    const artifact = bundledChannelArtifactLoaders[kind]({ id, rootScope });
    rememberBundledChannelArtifact(rootScope, kind, id, artifact);
    return artifact;
  } catch (error) {
    if (kind === "entry" || kind === "setupEntry") {
      throw error;
    }
    const descriptions: Record<BundledChannelArtifactKind, string> = {
      entry: "",
      setupEntry: " setup entry",
      plugin: "",
      setupPlugin: " setup",
      secrets: " secrets",
      setupSecrets: " setup secrets",
      accountInspector: " account inspector",
    };
    const detail = describeBundledChannelLoadError(error, id);
    log.warn(`[channels] failed to load bundled channel${descriptions[kind]} ${id}: ${detail}`);
    rememberBundledChannelArtifact(rootScope, kind, id, undefined);
    return undefined;
  } finally {
    artifactLoadsInProgress.delete(loadKey);
  }
}

const bundledChannelArtifactLoaders: {
  [Kind in BundledChannelArtifactKind]: (
    params: BundledChannelArtifactLoadParams,
  ) => BundledChannelArtifactValues[Kind] | undefined;
} = {
  entry({ id, rootScope }) {
    const metadata = resolveBundledChannelMetadata(id, rootScope);
    if (!metadata) {
      return undefined;
    }
    const entry = loadGeneratedBundledChannelEntry("entry", rootScope, metadata);
    if (entry && entry.id !== id) {
      rememberBundledChannelArtifact(rootScope, "entry", entry.id, entry);
    }
    return entry;
  },
  setupEntry({ id, rootScope }) {
    const metadata = resolveBundledChannelMetadata(id, rootScope);
    if (!metadata) {
      return undefined;
    }
    const entry = loadGeneratedBundledChannelEntry("setupEntry", rootScope, metadata);
    const aliases = new Set<ChannelId>([
      metadata.manifest.id,
      ...(metadata.manifest.channels ?? []),
      id,
    ]);
    for (const alias of aliases) {
      rememberBundledChannelArtifact(rootScope, "setupEntry", alias, entry);
    }
    return entry;
  },
  plugin({ id, rootScope }) {
    const entry = getBundledChannelArtifactForRoot("entry", id, rootScope);
    if (!entry) {
      return undefined;
    }
    const metadata = resolveBundledChannelMetadata(id, rootScope);
    const plugin = entry.loadChannelPlugin() as ChannelPlugin | undefined;
    return plugin
      ? {
          ...plugin,
          meta: normalizeChannelMeta({
            id: plugin.id,
            meta: plugin.meta,
            existing: metadata?.packageManifest?.channel,
          }),
        }
      : undefined;
  },
  setupPlugin({ id, rootScope }) {
    return getBundledChannelArtifactForRoot("setupEntry", id, rootScope)?.loadSetupPlugin();
  },
  secrets({ id, rootScope }) {
    const entry = getBundledChannelArtifactForRoot("entry", id, rootScope);
    return entry
      ? (entry.loadChannelSecrets?.() ??
          getBundledChannelArtifactForRoot("plugin", id, rootScope)?.secrets)
      : undefined;
  },
  setupSecrets({ id, rootScope }) {
    const entry = getBundledChannelArtifactForRoot("setupEntry", id, rootScope);
    return entry
      ? (entry.loadSetupSecrets?.() ??
          getBundledChannelArtifactForRoot("setupPlugin", id, rootScope)?.secrets)
      : undefined;
  },
  accountInspector({ id, rootScope }) {
    return getBundledChannelArtifactForRoot(
      "entry",
      id,
      rootScope,
    )?.loadChannelAccountInspector?.();
  },
};

export function listBundledChannelPlugins(): readonly ChannelPlugin[] {
  const rootScope = resolveBundledChannelRootScope();
  return listBundledChannelPluginIdsForRoot(rootScope).flatMap((id) => {
    const plugin = getBundledChannelArtifactForRoot("plugin", id, rootScope);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelSetupPlugins(): readonly ChannelPlugin[] {
  const rootScope = resolveBundledChannelRootScope();
  return listBundledChannelPluginIdsForRoot(rootScope).flatMap((id) => {
    const plugin = getBundledChannelArtifactForRoot("setupPlugin", id, rootScope);
    return plugin ? [plugin] : [];
  });
}

export function getBundledChannelAccountInspector(
  id: ChannelId,
): NonNullable<ChannelPlugin["config"]["inspectAccount"]> | undefined {
  const rootScope = resolveBundledChannelRootScope();
  return getBundledChannelArtifactForRoot("accountInspector", id, rootScope);
}

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const rootScope = resolveBundledChannelRootScope();
  return getBundledChannelArtifactForRoot("plugin", id, rootScope);
}

export function getBundledChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const rootScope = resolveBundledChannelRootScope();
  return getBundledChannelArtifactForRoot("secrets", id, rootScope);
}

export function getBundledChannelSetupPlugin(
  id: ChannelId,
  env: NodeJS.ProcessEnv = process.env,
): ChannelPlugin | undefined {
  const rootScope = resolveBundledChannelRootScope(env);
  return getBundledChannelArtifactForRoot("setupPlugin", id, rootScope);
}

export function getBundledChannelSetupSecrets(
  id: ChannelId,
  env: NodeJS.ProcessEnv = process.env,
): ChannelPlugin["secrets"] | undefined {
  const rootScope = resolveBundledChannelRootScope(env);
  return getBundledChannelArtifactForRoot("setupSecrets", id, rootScope);
}

export function setBundledChannelRuntime(id: ChannelId, runtime: PluginRuntime): void {
  const rootScope = resolveBundledChannelRootScope();
  const setter = getBundledChannelArtifactForRoot("entry", id, rootScope)?.setChannelRuntime;
  if (!setter) {
    throw new Error(`missing bundled channel runtime setter: ${id}`);
  }
  setter(runtime);
}
