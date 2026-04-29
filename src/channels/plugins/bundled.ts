import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  BundledChannelLegacySessionSurface,
  BundledChannelLegacyStateMigrationDetector,
  BundledEntryModuleLoadOptions,
} from "../../plugin-sdk/channel-entry-contract.js";
import {
  listBundledChannelPluginMetadata,
  resolveBundledChannelGeneratedPath,
  type BundledChannelPluginMetadata,
} from "../../plugins/bundled-channel-runtime.js";
import {
  isBuiltBundledPluginRuntimeRoot,
  prepareBundledPluginRuntimeRoot,
} from "../../plugins/bundled-runtime-root.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../../plugins/manifest-owner-policy.js";
import { unwrapDefaultModuleExport } from "../../plugins/module-export.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveBundledChannelRootScope, type BundledChannelRootScope } from "./bundled-root.js";
import { normalizeChannelMeta } from "./meta-normalization.js";
import { isJavaScriptModulePath, loadChannelPluginModule } from "./module-loader.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

type BundledChannelEntryRuntimeContract = {
  kind: "bundled-channel-entry";
  id: string;
  name: string;
  description: string;
  features?: {
    accountInspect?: boolean;
  };
  register: (api: unknown) => void;
  loadChannelPlugin: () => ChannelPlugin;
  loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
  loadChannelAccountInspector?: () => NonNullable<ChannelPlugin["config"]["inspectAccount"]>;
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

type GeneratedBundledChannelEntry = {
  id: string;
  entry: BundledChannelEntryRuntimeContract;
};

type BundledChannelLoadContext = {
  pluginLoadInProgressIds: Set<ChannelId>;
  setupPluginLoadInProgressIds: Set<ChannelId>;
  entryLoadInProgressIds: Set<ChannelId>;
  setupEntryLoadInProgressIds: Set<ChannelId>;
  lazyEntriesById: Map<ChannelId, GeneratedBundledChannelEntry | null>;
  lazySetupEntriesById: Map<ChannelId, BundledChannelSetupEntryRuntimeContract | null>;
  lazyPluginsById: Map<ChannelId, ChannelPlugin | null>;
  lazySetupPluginsById: Map<ChannelId, ChannelPlugin | null>;
  lazySecretsById: Map<ChannelId, ChannelPlugin["secrets"] | null>;
  lazySetupSecretsById: Map<ChannelId, ChannelPlugin["secrets"] | null>;
  lazyAccountInspectorsById: Map<
    ChannelId,
    NonNullable<ChannelPlugin["config"]["inspectAccount"]> | null
  >;
};

const log = createSubsystemLogger("channels");
const MAX_BUNDLED_CHANNEL_LOAD_CONTEXTS = 32;
const bundledChannelLoadContextsByRoot = new Map<string, BundledChannelLoadContext>();

function resolveChannelPluginModuleEntry(
  moduleExport: unknown,
): BundledChannelEntryRuntimeContract | null {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelEntryRuntimeContract>;
  if (record.kind !== "bundled-channel-entry") {
    return null;
  }
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.description !== "string" ||
    typeof record.register !== "function" ||
    typeof record.loadChannelPlugin !== "function"
  ) {
    return null;
  }
  return record as BundledChannelEntryRuntimeContract;
}

function resolveChannelSetupModuleEntry(
  moduleExport: unknown,
): BundledChannelSetupEntryRuntimeContract | null {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelSetupEntryRuntimeContract>;
  if (record.kind !== "bundled-channel-setup-entry") {
    return null;
  }
  if (typeof record.loadSetupPlugin !== "function") {
    return null;
  }
  return record as BundledChannelSetupEntryRuntimeContract;
}

function hasSetupEntryFeature(
  entry: BundledChannelSetupEntryRuntimeContract | null | undefined,
  feature: keyof NonNullable<BundledChannelSetupEntryRuntimeContract["features"]>,
): boolean {
  return entry?.features?.[feature] === true;
}

function hasChannelEntryFeature(
  entry: BundledChannelEntryRuntimeContract | undefined,
  feature: keyof NonNullable<BundledChannelEntryRuntimeContract["features"]>,
): boolean {
  return entry?.features?.[feature] === true;
}

function resolveBundledChannelBoundaryRoot(params: {
  packageRoot: string;
  pluginsDir?: string;
  metadata: BundledChannelPluginMetadata;
  modulePath: string;
}): string {
  const overrideRoot = params.pluginsDir
    ? path.resolve(params.pluginsDir, params.metadata.dirName)
    : null;
  if (
    overrideRoot &&
    (params.modulePath === overrideRoot ||
      params.modulePath.startsWith(`${overrideRoot}${path.sep}`))
  ) {
    return overrideRoot;
  }
  const distRoot = path.resolve(params.packageRoot, "dist", "extensions", params.metadata.dirName);
  if (params.modulePath === distRoot || params.modulePath.startsWith(`${distRoot}${path.sep}`)) {
    return distRoot;
  }
  return path.resolve(params.packageRoot, "extensions", params.metadata.dirName);
}

function resolveBundledChannelScanDir(rootScope: BundledChannelRootScope): string | undefined {
  return rootScope.pluginsDir;
}

function resolveGeneratedBundledChannelModulePath(params: {
  rootScope: BundledChannelRootScope;
  metadata: BundledChannelPluginMetadata;
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"];
}): string | null {
  if (!params.entry) {
    return null;
  }
  return resolveBundledChannelGeneratedPath(
    params.rootScope.packageRoot,
    params.entry,
    params.metadata.dirName,
    resolveBundledChannelScanDir(params.rootScope),
  );
}

function loadGeneratedBundledChannelModule(params: {
  rootScope: BundledChannelRootScope;
  metadata: BundledChannelPluginMetadata;
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"];
  installRuntimeDeps?: boolean;
}): unknown {
  let modulePath = resolveGeneratedBundledChannelModulePath(params);
  if (!modulePath) {
    throw new Error(`missing generated module for bundled channel ${params.metadata.manifest.id}`);
  }
  const scanDir = resolveBundledChannelScanDir(params.rootScope);
  let boundaryRoot = resolveBundledChannelBoundaryRoot({
    packageRoot: params.rootScope.packageRoot,
    ...(scanDir ? { pluginsDir: scanDir } : {}),
    metadata: params.metadata,
    modulePath,
  });
  if (params.installRuntimeDeps !== false && isBuiltBundledPluginRuntimeRoot(boundaryRoot)) {
    const prepared = prepareBundledPluginRuntimeRoot({
      pluginId: params.metadata.manifest.id,
      pluginRoot: boundaryRoot,
      modulePath,
      env: process.env,
      logInstalled: (installedSpecs) => {
        log.debug(
          `[channels] ${params.metadata.manifest.id} installed bundled runtime deps: ${installedSpecs.join(", ")}`,
        );
      },
    });
    modulePath = prepared.modulePath;
    boundaryRoot = prepared.pluginRoot;
  }
  return loadChannelPluginModule({
    modulePath,
    rootDir: boundaryRoot,
    boundaryRootDir: boundaryRoot,
    shouldTryNativeRequire: (safePath) =>
      safePath.includes(`${path.sep}dist${path.sep}`) && isJavaScriptModulePath(safePath),
  });
}

function loadGeneratedBundledChannelEntry(params: {
  rootScope: BundledChannelRootScope;
  metadata: BundledChannelPluginMetadata;
}): GeneratedBundledChannelEntry | null {
  try {
    const entry = resolveChannelPluginModuleEntry(
      loadGeneratedBundledChannelModule({
        rootScope: params.rootScope,
        metadata: params.metadata,
        entry: params.metadata.source,
        installRuntimeDeps: true,
      }),
    );
    if (!entry) {
      log.warn(
        `[channels] bundled channel entry ${params.metadata.manifest.id} missing bundled-channel-entry contract; skipping`,
      );
      return null;
    }
    return {
      id: params.metadata.manifest.id,
      entry,
    };
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load bundled channel ${params.metadata.manifest.id}: ${detail}`);
    return null;
  }
}

function loadGeneratedBundledChannelSetupEntry(params: {
  rootScope: BundledChannelRootScope;
  metadata: BundledChannelPluginMetadata;
}): BundledChannelSetupEntryRuntimeContract | null {
  if (!params.metadata.setupSource) {
    return null;
  }
  try {
    const setupEntry = resolveChannelSetupModuleEntry(
      loadGeneratedBundledChannelModule({
        rootScope: params.rootScope,
        metadata: params.metadata,
        entry: params.metadata.setupSource,
        installRuntimeDeps: false,
      }),
    );
    if (!setupEntry) {
      log.warn(
        `[channels] bundled channel setup entry ${params.metadata.manifest.id} missing bundled-channel-setup-entry contract; skipping`,
      );
      return null;
    }
    return setupEntry;
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(
      `[channels] failed to load bundled channel setup entry ${params.metadata.manifest.id}: ${detail}`,
    );
    return null;
  }
}

function createBundledChannelLoadContext(): BundledChannelLoadContext {
  return {
    pluginLoadInProgressIds: new Set(),
    setupPluginLoadInProgressIds: new Set(),
    entryLoadInProgressIds: new Set(),
    setupEntryLoadInProgressIds: new Set(),
    lazyEntriesById: new Map(),
    lazySetupEntriesById: new Map(),
    lazyPluginsById: new Map(),
    lazySetupPluginsById: new Map(),
    lazySecretsById: new Map(),
    lazySetupSecretsById: new Map(),
    lazyAccountInspectorsById: new Map(),
  };
}

function resolveActiveBundledChannelLoadScope(): {
  rootScope: BundledChannelRootScope;
  loadContext: BundledChannelLoadContext;
} {
  const rootScope = resolveBundledChannelRootScope();
  const cachedContext = bundledChannelLoadContextsByRoot.get(rootScope.cacheKey);
  if (cachedContext) {
    bundledChannelLoadContextsByRoot.delete(rootScope.cacheKey);
    bundledChannelLoadContextsByRoot.set(rootScope.cacheKey, cachedContext);
    return {
      rootScope,
      loadContext: cachedContext,
    };
  }
  const loadContext = createBundledChannelLoadContext();
  bundledChannelLoadContextsByRoot.set(rootScope.cacheKey, loadContext);
  while (bundledChannelLoadContextsByRoot.size > MAX_BUNDLED_CHANNEL_LOAD_CONTEXTS) {
    const oldestKey = bundledChannelLoadContextsByRoot.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    bundledChannelLoadContextsByRoot.delete(oldestKey);
  }
  return {
    rootScope,
    loadContext,
  };
}

function listBundledChannelMetadata(
  rootScope = resolveBundledChannelRootScope(),
): readonly BundledChannelPluginMetadata[] {
  const scanDir = resolveBundledChannelScanDir(rootScope);
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
  const hinted = listBundledChannelMetadata(rootScope)
    .filter(
      (metadata) =>
        metadata.packageManifest?.setupFeatures?.[feature] === true &&
        shouldIncludeBundledChannelSetupFeatureForConfig({
          metadata,
          config: options.config,
        }),
    )
    .map((metadata) => metadata.manifest.id)
    .toSorted((left, right) => left.localeCompare(right));
  return hinted.length > 0
    ? hinted
    : listBundledChannelMetadata(rootScope)
        .filter((metadata) =>
          shouldIncludeBundledChannelSetupFeatureForConfig({
            metadata,
            config: options.config,
          }),
        )
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
  return listBundledChannelMetadata(rootScope).find(
    (metadata) => metadata.manifest.id === id || metadata.manifest.channels?.includes(id),
  );
}

function getLazyGeneratedBundledChannelEntryForRoot(
  id: ChannelId,
  rootScope: BundledChannelRootScope,
  loadContext: BundledChannelLoadContext,
): GeneratedBundledChannelEntry | null {
  const previous = loadContext.lazyEntriesById.get(id);
  if (previous) {
    return previous;
  }
  if (previous === null) {
    return null;
  }
  const metadata = resolveBundledChannelMetadata(id, rootScope);
  if (!metadata) {
    loadContext.lazyEntriesById.set(id, null);
    return null;
  }
  if (loadContext.entryLoadInProgressIds.has(id)) {
    return null;
  }
  loadContext.entryLoadInProgressIds.add(id);
  try {
    const entry = loadGeneratedBundledChannelEntry({
      rootScope,
      metadata,
    });
    loadContext.lazyEntriesById.set(id, entry);
    if (entry?.entry.id && entry.entry.id !== id) {
      loadContext.lazyEntriesById.set(entry.entry.id, entry);
    }
    return entry;
  } finally {
    loadContext.entryLoadInProgressIds.delete(id);
  }
}

function rememberBundledChannelSetupEntry(
  metadata: BundledChannelPluginMetadata,
  loadContext: BundledChannelLoadContext,
  entry: BundledChannelSetupEntryRuntimeContract | null,
  requestedId?: ChannelId,
) {
  const ids = new Set<ChannelId>([
    metadata.manifest.id,
    ...(metadata.manifest.channels ?? []),
    ...(requestedId ? [requestedId] : []),
  ]);
  for (const id of ids) {
    loadContext.lazySetupEntriesById.set(id, entry);
  }
}

function getLazyGeneratedBundledChannelSetupEntryForRoot(
  id: ChannelId,
  rootScope: BundledChannelRootScope,
  loadContext: BundledChannelLoadContext,
): BundledChannelSetupEntryRuntimeContract | null {
  if (loadContext.lazySetupEntriesById.has(id)) {
    return loadContext.lazySetupEntriesById.get(id) ?? null;
  }
  const metadata = resolveBundledChannelMetadata(id, rootScope);
  if (!metadata) {
    loadContext.lazySetupEntriesById.set(id, null);
    return null;
  }
  if (loadContext.setupEntryLoadInProgressIds.has(id)) {
    return null;
  }
  loadContext.setupEntryLoadInProgressIds.add(id);
  try {
    const setupEntry = loadGeneratedBundledChannelSetupEntry({
      rootScope,
      metadata,
    });
    rememberBundledChannelSetupEntry(metadata, loadContext, setupEntry, id);
    return setupEntry;
  } finally {
    loadContext.setupEntryLoadInProgressIds.delete(id);
  }
}

function getBundledChannelPluginForRoot(
  id: ChannelId,
  rootScope: BundledChannelRootScope,
  loadContext: BundledChannelLoadContext,
): ChannelPlugin | undefined {
  if (loadContext.lazyPluginsById.has(id)) {
    return loadContext.lazyPluginsById.get(id) ?? undefined;
  }
  if (loadContext.pluginLoadInProgressIds.has(id)) {
    return undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, loadContext)?.entry;
  if (!entry) {
    return undefined;
  }
  loadContext.pluginLoadInProgressIds.add(id);
  try {
    const metadata = resolveBundledChannelMetadata(id, rootScope);
    const plugin = entry.loadChannelPlugin() as ChannelPlugin | undefined;
    if (!plugin) {
      loadContext.lazyPluginsById.set(id, null);
      return undefined;
    }
    const normalizedPlugin = {
      ...plugin,
      meta: normalizeChannelMeta({
        id: plugin.id,
        meta: plugin.meta,
        existing: metadata?.packageManifest?.channel,
      }),
    };
    loadContext.lazyPluginsById.set(id, normalizedPlugin);
    return normalizedPlugin;
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load bundled channel ${id}: ${detail}`);
    loadContext.lazyPluginsById.set(id, null);
    return undefined;
  } finally {
    loadContext.pluginLoadInProgressIds.delete(id);
  }
}

function getBundledChannelSecretsForRoot(
  id: ChannelId,
  rootScope: BundledChannelRootScope,
  loadContext: BundledChannelLoadContext,
): ChannelPlugin["secrets"] | undefined {
  if (loadContext.lazySecretsById.has(id)) {
    return loadContext.lazySecretsById.get(id) ?? undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, loadContext)?.entry;
  if (!entry) {
    return undefined;
  }
  try {
    const secrets =
      entry.loadChannelSecrets?.() ??
      getBundledChannelPluginForRoot(id, rootScope, loadContext)?.secrets;
    loadContext.lazySecretsById.set(id, secrets ?? null);
    return secrets;
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load bundled channel secrets ${id}: ${detail}`);
    loadContext.lazySecretsById.set(id, null);
    return undefined;
  }
}

function getBundledChannelAccountInspectorForRoot(
  id: ChannelId,
  rootScope: BundledChannelRootScope,
  loadContext: BundledChannelLoadContext,
): NonNullable<ChannelPlugin["config"]["inspectAccount"]> | undefined {
  if (loadContext.lazyAccountInspectorsById.has(id)) {
    return loadContext.lazyAccountInspectorsById.get(id) ?? undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, loadContext)?.entry;
  if (!entry?.loadChannelAccountInspector) {
    loadContext.lazyAccountInspectorsById.set(id, null);
    return undefined;
  }
  try {
    const inspector = entry.loadChannelAccountInspector();
    loadContext.lazyAccountInspectorsById.set(id, inspector);
    return inspector;
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load bundled channel account inspector ${id}: ${detail}`);
    loadContext.lazyAccountInspectorsById.set(id, null);
    return undefined;
  }
}

function getBundledChannelSetupPluginForRoot(
  id: ChannelId,
  rootScope: BundledChannelRootScope,
  loadContext: BundledChannelLoadContext,
): ChannelPlugin | undefined {
  if (loadContext.lazySetupPluginsById.has(id)) {
    return loadContext.lazySetupPluginsById.get(id) ?? undefined;
  }
  if (loadContext.setupPluginLoadInProgressIds.has(id)) {
    return undefined;
  }
  const entry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, loadContext);
  if (!entry) {
    return undefined;
  }
  loadContext.setupPluginLoadInProgressIds.add(id);
  try {
    const plugin = entry.loadSetupPlugin({ installRuntimeDeps: false });
    loadContext.lazySetupPluginsById.set(id, plugin);
    return plugin;
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load bundled channel setup ${id}: ${detail}`);
    loadContext.lazySetupPluginsById.set(id, null);
    return undefined;
  } finally {
    loadContext.setupPluginLoadInProgressIds.delete(id);
  }
}

function getBundledChannelSetupSecretsForRoot(
  id: ChannelId,
  rootScope: BundledChannelRootScope,
  loadContext: BundledChannelLoadContext,
): ChannelPlugin["secrets"] | undefined {
  if (loadContext.lazySetupSecretsById.has(id)) {
    return loadContext.lazySetupSecretsById.get(id) ?? undefined;
  }
  const entry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, loadContext);
  if (!entry) {
    return undefined;
  }
  try {
    const secrets =
      entry.loadSetupSecrets?.() ??
      getBundledChannelSetupPluginForRoot(id, rootScope, loadContext)?.secrets;
    loadContext.lazySetupSecretsById.set(id, secrets ?? null);
    return secrets;
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load bundled channel setup secrets ${id}: ${detail}`);
    loadContext.lazySetupSecretsById.set(id, null);
    return undefined;
  }
}

export function listBundledChannelPlugins(): readonly ChannelPlugin[] {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return listBundledChannelPluginIdsForRoot(rootScope).flatMap((id) => {
    const plugin = getBundledChannelPluginForRoot(id, rootScope, loadContext);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelSetupPlugins(): readonly ChannelPlugin[] {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return listBundledChannelPluginIdsForRoot(rootScope).flatMap((id) => {
    const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, loadContext);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelSetupPluginsByFeature(
  feature: keyof NonNullable<BundledChannelSetupEntryRuntimeContract["features"]>,
  options: { config?: OpenClawConfig } = {},
): readonly ChannelPlugin[] {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return listBundledChannelPluginIdsForSetupFeature(rootScope, feature, {
    config: options.config,
  }).flatMap((id) => {
    const setupEntry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, loadContext);
    if (!hasSetupEntryFeature(setupEntry, feature)) {
      return [];
    }
    const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, loadContext);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelLegacySessionSurfaces(
  options: {
    config?: OpenClawConfig;
  } = {},
): readonly BundledChannelLegacySessionSurface[] {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return listBundledChannelPluginIdsForSetupFeature(rootScope, "legacySessionSurfaces", {
    config: options.config,
  }).flatMap((id) => {
    const setupEntry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, loadContext);
    const surface = setupEntry?.loadLegacySessionSurface?.({ installRuntimeDeps: false });
    if (surface) {
      return [surface];
    }
    if (!hasSetupEntryFeature(setupEntry, "legacySessionSurfaces")) {
      return [];
    }
    const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, loadContext);
    return plugin?.messaging ? [plugin.messaging] : [];
  });
}

export function listBundledChannelLegacyStateMigrationDetectors(
  options: {
    config?: OpenClawConfig;
  } = {},
): readonly BundledChannelLegacyStateMigrationDetector[] {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return listBundledChannelPluginIdsForSetupFeature(rootScope, "legacyStateMigrations", {
    config: options.config,
  }).flatMap((id) => {
    const setupEntry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, loadContext);
    const detector = setupEntry?.loadLegacyStateMigrationDetector?.({ installRuntimeDeps: false });
    if (detector) {
      return [detector];
    }
    if (!hasSetupEntryFeature(setupEntry, "legacyStateMigrations")) {
      return [];
    }
    const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, loadContext);
    return plugin?.lifecycle?.detectLegacyStateMigrations
      ? [plugin.lifecycle.detectLegacyStateMigrations]
      : [];
  });
}

export function hasBundledChannelEntryFeature(
  id: ChannelId,
  feature: keyof NonNullable<BundledChannelEntryRuntimeContract["features"]>,
): boolean {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, loadContext)?.entry;
  return hasChannelEntryFeature(entry, feature);
}

export function getBundledChannelAccountInspector(
  id: ChannelId,
): NonNullable<ChannelPlugin["config"]["inspectAccount"]> | undefined {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return getBundledChannelAccountInspectorForRoot(id, rootScope, loadContext);
}

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return getBundledChannelPluginForRoot(id, rootScope, loadContext);
}

export function getBundledChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return getBundledChannelSecretsForRoot(id, rootScope, loadContext);
}

export function getBundledChannelSetupPlugin(id: ChannelId): ChannelPlugin | undefined {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return getBundledChannelSetupPluginForRoot(id, rootScope, loadContext);
}

export function getBundledChannelSetupSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  return getBundledChannelSetupSecretsForRoot(id, rootScope, loadContext);
}

export function requireBundledChannelPlugin(id: ChannelId): ChannelPlugin {
  const plugin = getBundledChannelPlugin(id);
  if (!plugin) {
    throw new Error(`missing bundled channel plugin: ${id}`);
  }
  return plugin;
}

export function setBundledChannelRuntime(id: ChannelId, runtime: PluginRuntime): void {
  const { rootScope, loadContext } = resolveActiveBundledChannelLoadScope();
  const setter = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, loadContext)?.entry
    .setChannelRuntime;
  if (!setter) {
    throw new Error(`missing bundled channel runtime setter: ${id}`);
  }
  setter(runtime);
}
