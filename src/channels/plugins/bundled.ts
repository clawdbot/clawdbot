/**
 * Bundled channel plugin loader.
 *
 * Loads generated bundled channel entries, setup metadata, secrets, and legacy migration hooks.
 */
import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { extractErrorCode, formatErrorMessage } from "../../infra/errors.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import { isPathInside } from "../../infra/path-guards.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  BundledChannelLegacySessionSurface,
  BundledChannelLegacyStateMigrationDetector,
  BundledEntryModuleLoadOptions,
} from "../../plugin-sdk/channel-entry-contract.types.js";
import {
  listBundledChannelPluginMetadata,
  resolveBundledChannelGeneratedPath,
  type BundledChannelPluginMetadata,
} from "../../plugins/bundled-channel-runtime.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../../plugins/manifest-owner-policy.js";
import { unwrapDefaultModuleExport } from "../../plugins/module-export.js";
import {
  getCachedPluginModuleLoader,
  type PluginModuleLoaderCache,
} from "../../plugins/plugin-module-loader-cache.js";
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
  loadLegacyStateMigrationDetector?: (
    options?: BundledEntryModuleLoadOptions,
  ) => BundledChannelLegacyStateMigrationDetector;
  loadLegacySessionSurface?: (
    options?: BundledEntryModuleLoadOptions,
  ) => BundledChannelLegacySessionSurface;
  features?: {
    legacyStateMigrations?: boolean;
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
type BundledChannelArtifacts = Partial<{
  [Kind in BundledChannelArtifactKind]: BundledChannelArtifactValues[Kind] | null;
}>;

type BundledChannelLoadContext = {
  artifactLoadsInProgress: Set<string>;
  artifactsById: Map<ChannelId, BundledChannelArtifacts>;
  metadataById: Map<ChannelId, BundledChannelPluginMetadata | null>;
  metadataLoaded: boolean;
};

type BundledChannelArtifactLoadParams = {
  id: ChannelId;
  rootScope: BundledChannelRootScope;
  loadContext: BundledChannelLoadContext;
};

const log = createSubsystemLogger("channels");
const MAX_BUNDLED_CHANNEL_LOAD_CONTEXTS = 32;
const MAX_BUNDLED_CHANNEL_BOUNDARY_ROOTS = 256;
const bundledChannelLoadContextsByRoot = new Map<string, BundledChannelLoadContext>();
const bundledChannelBoundaryRoots = new Map<string, string>();
const sourceBundledEntryLoaderCache: PluginModuleLoaderCache = new Map();

function isSourceModulePath(modulePath: string): boolean {
  return /\.(?:c|m)?tsx?$/iu.test(modulePath);
}

function resolveCanonicalPathOrAbsolute(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
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
  const cached = bundledChannelBoundaryRoots.get(cacheKey);
  if (cached) {
    bundledChannelBoundaryRoots.delete(cacheKey);
    bundledChannelBoundaryRoots.set(cacheKey, cached);
    pruneMapToMaxSize(bundledChannelBoundaryRoots, MAX_BUNDLED_CHANNEL_BOUNDARY_ROOTS);
    return cached;
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
  bundledChannelBoundaryRoots.set(cacheKey, boundaryRoot);
  pruneMapToMaxSize(bundledChannelBoundaryRoots, MAX_BUNDLED_CHANNEL_BOUNDARY_ROOTS);
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
  let packageRoot: string;
  let pluginRoot: string;
  try {
    packageRoot = fs.realpathSync.native(params.rootScope.packageRoot);
    pluginRoot = fs.realpathSync.native(params.metadata.rootDir);
  } catch {
    return null;
  }
  if (!isPathInside(packageRoot, pluginRoot)) {
    return null;
  }
  for (const rawEntry of [params.entry.built, params.entry.source]) {
    if (!rawEntry) {
      continue;
    }
    const candidate = path.isAbsolute(rawEntry)
      ? path.normalize(rawEntry)
      : path.resolve(pluginRoot, rawEntry);
    let realCandidate: string;
    try {
      realCandidate = fs.realpathSync.native(candidate);
    } catch {
      continue;
    }
    if (isPathInside(pluginRoot, realCandidate)) {
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
      cache: sourceBundledEntryLoaderCache,
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

function createBundledChannelLoadContext(): BundledChannelLoadContext {
  return {
    artifactLoadsInProgress: new Set(),
    artifactsById: new Map(),
    metadataById: new Map(),
    metadataLoaded: false,
  };
}

function resolveActiveBundledChannelLoadScope(env: NodeJS.ProcessEnv = process.env): {
  rootScope: BundledChannelRootScope;
  loadContext: BundledChannelLoadContext;
} {
  const rootScope = resolveBundledChannelRootScope(env);
  const loadContext =
    bundledChannelLoadContextsByRoot.get(rootScope.cacheKey) ?? createBundledChannelLoadContext();
  bundledChannelLoadContextsByRoot.delete(rootScope.cacheKey);
  bundledChannelLoadContextsByRoot.set(rootScope.cacheKey, loadContext);
  pruneMapToMaxSize(bundledChannelLoadContextsByRoot, MAX_BUNDLED_CHANNEL_LOAD_CONTEXTS);
  return {
    rootScope,
    loadContext,
  };
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

function shouldIncludeBundledChannelSetupFeatureForConfig(params: {
  metadata: BundledChannelPluginMetadata;
  config?: OpenClawConfig;
}): boolean {
  if (!params.config) {
    return true;
  }
  const pluginId = params.metadata.manifest.id;
  if (
    !passesManifestOwnerBasePolicy({
      plugin: { id: pluginId },
      normalizedConfig: normalizePluginsConfig(params.config.plugins),
      allowRestrictiveAllowlistBypass: true,
    })
  ) {
    return false;
  }

  let hasExplicitChannelDisable = false;
  for (const channelId of params.metadata.manifest.channels ?? [pluginId]) {
    const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
    if (!normalizedChannelId) {
      continue;
    }
    const channelConfig = (params.config.channels as Record<string, unknown> | undefined)?.[
      normalizedChannelId
    ];
    if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
      continue;
    }
    if ((channelConfig as { enabled?: unknown }).enabled === false) {
      hasExplicitChannelDisable = true;
      continue;
    }
    return true;
  }

  return !hasExplicitChannelDisable;
}

function listBundledChannelPluginIdsForSetupFeature(
  rootScope: BundledChannelRootScope,
  feature: keyof NonNullable<BundledChannelSetupEntryRuntimeContract["features"]>,
  options: { config?: OpenClawConfig } = {},
): readonly ChannelId[] {
  const eligible = listBundledChannelMetadata(rootScope).filter((metadata) =>
    shouldIncludeBundledChannelSetupFeatureForConfig({ metadata, config: options.config }),
  );
  const hinted = eligible.filter(
    (metadata) => metadata.packageManifest?.setupFeatures?.[feature] === true,
  );
  return (hinted.length > 0 ? hinted : eligible)
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
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return (
    resolveBundledChannelMetadata(id, rootScope, loadContext)?.packageManifest?.setupFeatures?.[
      feature
    ] === true
  );
}

function resolveBundledChannelMetadata(
  id: ChannelId,
  rootScope: BundledChannelRootScope,
  loadContext: BundledChannelLoadContext,
): BundledChannelPluginMetadata | undefined {
  if (loadContext.metadataById.has(id)) {
    return loadContext.metadataById.get(id) ?? undefined;
  }
  if (loadContext.metadataLoaded) {
    loadContext.metadataById.set(id, null);
    return undefined;
  }
  for (const metadata of listBundledChannelMetadata(rootScope)) {
    const ids = new Set<ChannelId>([metadata.manifest.id, ...(metadata.manifest.channels ?? [])]);
    for (const metadataId of ids) {
      loadContext.metadataById.set(metadataId, metadata);
    }
  }
  loadContext.metadataLoaded = true;
  const metadata = loadContext.metadataById.get(id);
  if (metadata) {
    return metadata;
  }
  loadContext.metadataById.set(id, null);
  return undefined;
}

function rememberBundledChannelArtifact<TKind extends BundledChannelArtifactKind>(
  loadContext: BundledChannelLoadContext,
  kind: TKind,
  id: ChannelId,
  artifact: BundledChannelArtifactValues[TKind] | undefined,
): void {
  const artifacts = loadContext.artifactsById.get(id) ?? {};
  artifacts[kind] = artifact ?? null;
  loadContext.artifactsById.set(id, artifacts);
}

function getBundledChannelArtifactForRoot<TKind extends BundledChannelArtifactKind>(
  kind: TKind,
  id: ChannelId,
  rootScope: BundledChannelRootScope,
  loadContext: BundledChannelLoadContext,
): BundledChannelArtifactValues[TKind] | undefined {
  const artifacts = loadContext.artifactsById.get(id);
  if (artifacts && Object.hasOwn(artifacts, kind)) {
    return artifacts[kind] ?? undefined;
  }
  // Keep failure and recursion state separate by artifact kind: broken secrets
  // must never poison the runtime plugin, setup plugin, or entry contracts.
  const loadKey = `${kind}\0${id}`;
  if (loadContext.artifactLoadsInProgress.has(loadKey)) {
    return undefined;
  }
  loadContext.artifactLoadsInProgress.add(loadKey);
  try {
    const artifact = bundledChannelArtifactLoaders[kind]({ id, rootScope, loadContext });
    rememberBundledChannelArtifact(loadContext, kind, id, artifact);
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
    rememberBundledChannelArtifact(loadContext, kind, id, undefined);
    return undefined;
  } finally {
    loadContext.artifactLoadsInProgress.delete(loadKey);
  }
}

const bundledChannelArtifactLoaders: {
  [Kind in BundledChannelArtifactKind]: (
    params: BundledChannelArtifactLoadParams,
  ) => BundledChannelArtifactValues[Kind] | undefined;
} = {
  entry({ id, rootScope, loadContext }) {
    const metadata = resolveBundledChannelMetadata(id, rootScope, loadContext);
    if (!metadata) {
      return undefined;
    }
    const entry = loadGeneratedBundledChannelEntry("entry", rootScope, metadata);
    if (entry && entry.id !== id) {
      rememberBundledChannelArtifact(loadContext, "entry", entry.id, entry);
    }
    return entry;
  },
  setupEntry({ id, rootScope, loadContext }) {
    const metadata = resolveBundledChannelMetadata(id, rootScope, loadContext);
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
      rememberBundledChannelArtifact(loadContext, "setupEntry", alias, entry);
    }
    return entry;
  },
  plugin({ id, rootScope, loadContext }) {
    const entry = getBundledChannelArtifactForRoot("entry", id, rootScope, loadContext);
    if (!entry) {
      return undefined;
    }
    const metadata = resolveBundledChannelMetadata(id, rootScope, loadContext);
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
  setupPlugin({ id, rootScope, loadContext }) {
    return getBundledChannelArtifactForRoot(
      "setupEntry",
      id,
      rootScope,
      loadContext,
    )?.loadSetupPlugin();
  },
  secrets({ id, rootScope, loadContext }) {
    const entry = getBundledChannelArtifactForRoot("entry", id, rootScope, loadContext);
    return entry
      ? (entry.loadChannelSecrets?.() ??
          getBundledChannelArtifactForRoot("plugin", id, rootScope, loadContext)?.secrets)
      : undefined;
  },
  setupSecrets({ id, rootScope, loadContext }) {
    const entry = getBundledChannelArtifactForRoot("setupEntry", id, rootScope, loadContext);
    return entry
      ? (entry.loadSetupSecrets?.() ??
          getBundledChannelArtifactForRoot("setupPlugin", id, rootScope, loadContext)?.secrets)
      : undefined;
  },
  accountInspector({ id, rootScope, loadContext }) {
    return getBundledChannelArtifactForRoot(
      "entry",
      id,
      rootScope,
      loadContext,
    )?.loadChannelAccountInspector?.();
  },
};

export function listBundledChannelPlugins(): readonly ChannelPlugin[] {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return listBundledChannelPluginIdsForRoot(rootScope).flatMap((id) => {
    const plugin = getBundledChannelArtifactForRoot("plugin", id, rootScope, loadContext);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelSetupPlugins(): readonly ChannelPlugin[] {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return listBundledChannelPluginIdsForRoot(rootScope).flatMap((id) => {
    const plugin = getBundledChannelArtifactForRoot("setupPlugin", id, rootScope, loadContext);
    return plugin ? [plugin] : [];
  });
}

function listBundledChannelLegacyArtifacts<TArtifact>(
  feature: keyof NonNullable<BundledChannelSetupEntryRuntimeContract["features"]>,
  options: { config?: OpenClawConfig },
  loadFromEntry: (entry: BundledChannelSetupEntryRuntimeContract) => TArtifact | undefined,
  loadFromPlugin: (plugin: ChannelPlugin) => TArtifact | undefined,
): readonly TArtifact[] {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return listBundledChannelPluginIdsForSetupFeature(rootScope, feature, options).flatMap((id) => {
    const entry = getBundledChannelArtifactForRoot("setupEntry", id, rootScope, loadContext);
    const artifact = entry ? loadFromEntry(entry) : undefined;
    if (artifact) {
      return [artifact];
    }
    if (entry?.features?.[feature] !== true) {
      return [];
    }
    const plugin = getBundledChannelArtifactForRoot("setupPlugin", id, rootScope, loadContext);
    const fallback = plugin ? loadFromPlugin(plugin) : undefined;
    return fallback ? [fallback] : [];
  });
}

export function listBundledChannelLegacySessionSurfaces(
  options: { config?: OpenClawConfig } = {},
): readonly BundledChannelLegacySessionSurface[] {
  return listBundledChannelLegacyArtifacts(
    "legacySessionSurfaces",
    options,
    (entry) => entry.loadLegacySessionSurface?.(),
    (plugin) => plugin.messaging,
  );
}

export function listBundledChannelLegacyStateMigrationDetectors(
  options: { config?: OpenClawConfig } = {},
): readonly BundledChannelLegacyStateMigrationDetector[] {
  return listBundledChannelLegacyArtifacts(
    "legacyStateMigrations",
    options,
    (entry) => entry.loadLegacyStateMigrationDetector?.(),
    (plugin) => plugin.lifecycle?.detectLegacyStateMigrations,
  );
}

export function getBundledChannelAccountInspector(
  id: ChannelId,
): NonNullable<ChannelPlugin["config"]["inspectAccount"]> | undefined {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return getBundledChannelArtifactForRoot("accountInspector", id, rootScope, loadContext);
}

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return getBundledChannelArtifactForRoot("plugin", id, rootScope, loadContext);
}

export function getBundledChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return getBundledChannelArtifactForRoot("secrets", id, rootScope, loadContext);
}

export function getBundledChannelSetupPlugin(
  id: ChannelId,
  env: NodeJS.ProcessEnv = process.env,
): ChannelPlugin | undefined {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope(env);
  return getBundledChannelArtifactForRoot("setupPlugin", id, rootScope, loadContext);
}

export function getBundledChannelSetupSecrets(
  id: ChannelId,
  env: NodeJS.ProcessEnv = process.env,
): ChannelPlugin["secrets"] | undefined {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope(env);
  return getBundledChannelArtifactForRoot("setupSecrets", id, rootScope, loadContext);
}

export function setBundledChannelRuntime(id: ChannelId, runtime: PluginRuntime): void {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  const setter = getBundledChannelArtifactForRoot(
    "entry",
    id,
    rootScope,
    loadContext,
  )?.setChannelRuntime;
  if (!setter) {
    throw new Error(`missing bundled channel runtime setter: ${id}`);
  }
  setter(runtime);
}
