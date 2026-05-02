import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  restoreRegisteredAgentHarnesses,
} from "../agents/harness/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
} from "../memory-host-sdk/dreaming.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  clearDetachedTaskLifecycleRuntimeRegistration,
  getDetachedTaskLifecycleRuntimeRegistration,
  restoreDetachedTaskLifecycleRuntimeRegistration,
} from "../tasks/detached-task-runtime-state.js";
import { resolveUserPath } from "../utils.js";
import { resolvePluginActivationSourceConfig } from "./activation-source-config.js";
import { buildPluginApi } from "./api-builder.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import {
  clearPluginCommands,
  listRegisteredPluginCommands,
  restorePluginCommands,
} from "./command-registry-state.js";
import {
  clearCompactionProviders,
  listRegisteredCompactionProviders,
  restoreRegisteredCompactionProviders,
} from "./compaction-provider.js";
import {
  applyTestPluginDefaults,
  createPluginActivationSource,
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
  type PluginActivationConfigSource,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "./discovery.js";
import { getGlobalHookRunner, initializeGlobalHookRunner } from "./hook-runner-global.js";
import { toSafeImportPath } from "./import-specifier.js";
import { collectPluginManifestCompatCodes } from "./installed-plugin-index-record-builder.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import {
  clearPluginInteractiveHandlers,
  listPluginInteractiveHandlers,
  restorePluginInteractiveHandlers,
} from "./interactive-registry.js";
import { PluginLoaderCacheState } from "./loader-cache-state.js";
import {
  channelPluginIdBelongsToManifest,
  loadBundledRuntimeChannelPlugin,
  mergeSetupRuntimeChannelPlugin,
  resolveBundledRuntimeChannelRegistration,
  resolveSetupChannelRegistration,
  shouldLoadChannelPluginInSetupRuntime,
} from "./loader-channel-setup.js";
import {
  buildProvenanceIndex,
  compareDuplicateCandidateOrder,
  warnAboutUntrackedLoadedPlugins,
  warnWhenAllowlistIsOpen,
} from "./loader-provenance.js";
import {
  createPluginRecord,
  formatAutoEnabledActivationReason,
  formatMissingPluginRegisterError,
  formatPluginFailureSummary,
  markPluginActivationDisabled,
  recordPluginError,
} from "./loader-records.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  clearMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviders,
  restoreRegisteredMemoryEmbeddingProviders,
} from "./memory-embedding-providers.js";
import {
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryFlushPlanResolver,
  getMemoryPromptSectionBuilder,
  getMemoryRuntime,
  listMemoryCorpusSupplements,
  listMemoryPromptSupplements,
  restoreMemoryPluginState,
} from "./memory-state.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import { tryNativeRequireJavaScriptModule } from "./native-module-require.js";
import {
  fingerprintPluginDiscoveryContext,
  resolvePluginDiscoveryContext,
} from "./plugin-control-plane-context.js";
import { withProfile } from "./plugin-load-profile.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginSourceModuleLoader,
  type PluginModuleLoaderCache,
} from "./plugin-module-loader-cache.js";
import {
  createPluginIdScopeSet,
  hasExplicitPluginIdScope,
  normalizePluginIdScope,
  serializePluginIdScope,
} from "./plugin-scope.js";
import { ensureOpenClawPluginSdkAlias } from "./plugin-sdk-dist-alias.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRuntimeSubagentMode,
  recordImportedPluginId,
  setActivePluginRegistry,
} from "./runtime.js";
import type { CreatePluginRuntimeOptions } from "./runtime/types.js";
import type { PluginRuntime } from "./runtime/types.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  type PluginSdkResolutionPreference,
  resolveExtensionApiAlias,
  resolvePluginSdkAliasCandidateOrder,
  resolvePluginSdkAliasFile,
  resolvePluginRuntimeModulePath,
  resolvePluginSdkScopedAliasMap,
  shouldPreferNativeModuleLoad,
} from "./sdk-alias.js";
import { hasKind, kindsEqual } from "./slots.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  OpenClawPluginModule,
  PluginLogger,
  PluginRegistrationMode,
} from "./types.js";

export type PluginLoadResult = PluginRegistry;
export { PluginLoadReentryError } from "./loader-cache-state.js";

export type PluginLoadOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  autoEnabledReasons?: Readonly<Record<string, string[]>>;
  workspaceDir?: string;
  // Allows callers to resolve plugin roots and load paths against an explicit env
  // instead of the process-global environment.
  env?: NodeJS.ProcessEnv;
  logger?: PluginLogger;
  coreGatewayHandlers?: Record<string, GatewayRequestHandler>;
  coreGatewayMethodNames?: readonly string[];
  runtimeOptions?: CreatePluginRuntimeOptions;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  cache?: boolean;
  mode?: "full" | "validate";
  onlyPluginIds?: string[];
  includeSetupOnlyChannelPlugins?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins?: boolean;
  /**
   * Prefer `setupEntry` for configured channel plugins that explicitly opt in
   * via package metadata because their setup entry covers the pre-listen startup surface.
   */
  preferSetupRuntimeForChannelPlugins?: boolean;
  toolDiscovery?: boolean;
  activate?: boolean;
  loadModules?: boolean;
  throwOnLoadError?: boolean;
  manifestRegistry?: PluginManifestRegistry;
};

const CLI_METADATA_ENTRY_BASENAMES = [
  "cli-metadata.ts",
  "cli-metadata.js",
  "cli-metadata.mjs",
  "cli-metadata.cjs",
] as const;

function resolveDreamingSidecarEngineId(params: {
  cfg: OpenClawConfig;
  memorySlot: string | null | undefined;
}): string | null {
  const normalizedMemorySlot = normalizeLowercaseStringOrEmpty(params.memorySlot);
  if (
    !normalizedMemorySlot ||
    normalizedMemorySlot === "none" ||
    normalizedMemorySlot === DEFAULT_MEMORY_DREAMING_PLUGIN_ID
  ) {
    return null;
  }
  const dreamingConfig = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(params.cfg),
    cfg: params.cfg,
  });
  return dreamingConfig.enabled ? DEFAULT_MEMORY_DREAMING_PLUGIN_ID : null;
}

export class PluginLoadFailureError extends Error {
  readonly pluginIds: string[];
  readonly registry: PluginRegistry;

  constructor(registry: PluginRegistry) {
    const failedPlugins = registry.plugins.filter((entry) => entry.status === "error");
    const summary = failedPlugins
      .map((entry) => `${entry.id}: ${entry.error ?? "unknown plugin load error"}`)
      .join("; ");
    super(`plugin load failed: ${summary}`);
    this.name = "PluginLoadFailureError";
    this.pluginIds = failedPlugins.map((entry) => entry.id);
    this.registry = registry;
  }
}

type CachedPluginState = {
  registry: PluginRegistry;
  detachedTaskRuntimeRegistration: ReturnType<typeof getDetachedTaskLifecycleRuntimeRegistration>;
  commands?: ReturnType<typeof listRegisteredPluginCommands>;
  interactiveHandlers?: ReturnType<typeof listPluginInteractiveHandlers>;
  memoryCapability: ReturnType<typeof getMemoryCapabilityRegistration>;
  memoryCorpusSupplements: ReturnType<typeof listMemoryCorpusSupplements>;
  agentHarnesses: ReturnType<typeof listRegisteredAgentHarnesses>;
  compactionProviders: ReturnType<typeof listRegisteredCompactionProviders>;
  memoryEmbeddingProviders: ReturnType<typeof listRegisteredMemoryEmbeddingProviders>;
  memoryFlushPlanResolver: ReturnType<typeof getMemoryFlushPlanResolver>;
  memoryPromptBuilder: ReturnType<typeof getMemoryPromptSectionBuilder>;
  memoryPromptSupplements: ReturnType<typeof listMemoryPromptSupplements>;
  memoryRuntime: ReturnType<typeof getMemoryRuntime>;
};

const MAX_PLUGIN_REGISTRY_CACHE_ENTRIES = 128;
const pluginLoaderCacheState = new PluginLoaderCacheState<CachedPluginState>(
  MAX_PLUGIN_REGISTRY_CACHE_ENTRIES,
);
const fullWorkspacePluginLoaderCacheState = new PluginLoaderCacheState<CachedPluginState>(
  MAX_PLUGIN_REGISTRY_CACHE_ENTRIES,
);
const LAZY_RUNTIME_REFLECTION_KEYS = [
  "version",
  "config",
  "agent",
  "subagent",
  "system",
  "media",
  "tts",
  "stt",
  "channel",
  "events",
  "logging",
  "state",
  "modelAuth",
] as const satisfies readonly (keyof PluginRuntime)[];

function createPluginCandidatesFromManifestRegistry(
  manifestRegistry: PluginManifestRegistry,
): PluginCandidate[] {
  return manifestRegistry.plugins.map((record) => ({
    idHint: record.id,
    rootDir: record.rootDir,
    source: record.source,
    origin: record.origin,
    ...(record.workspaceDir !== undefined ? { workspaceDir: record.workspaceDir } : {}),
    ...(record.format !== undefined ? { format: record.format } : {}),
    ...(record.bundleFormat !== undefined ? { bundleFormat: record.bundleFormat } : {}),
  }));
}

export function clearPluginLoaderCache(): void {
  pluginLoaderCacheState.clear();
  fullWorkspacePluginLoaderCacheState.clear();
  clearAgentHarnesses();
  clearPluginCommands();
  clearCompactionProviders();
  clearDetachedTaskLifecycleRuntimeRegistration();
  clearPluginInteractiveHandlers();
  clearMemoryEmbeddingProviders();
  clearMemoryPluginState();
}

const defaultLogger = () => createSubsystemLogger("plugins");

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

type PluginRegistrySnapshot = {
  arrays: {
    tools: PluginRegistry["tools"];
    hooks: PluginRegistry["hooks"];
    typedHooks: PluginRegistry["typedHooks"];
    channels: PluginRegistry["channels"];
    channelSetups: PluginRegistry["channelSetups"];
    providers: PluginRegistry["providers"];
    cliBackends: NonNullable<PluginRegistry["cliBackends"]>;
    textTransforms: PluginRegistry["textTransforms"];
    speechProviders: PluginRegistry["speechProviders"];
    realtimeTranscriptionProviders: PluginRegistry["realtimeTranscriptionProviders"];
    realtimeVoiceProviders: PluginRegistry["realtimeVoiceProviders"];
    mediaUnderstandingProviders: PluginRegistry["mediaUnderstandingProviders"];
    imageGenerationProviders: PluginRegistry["imageGenerationProviders"];
    videoGenerationProviders: PluginRegistry["videoGenerationProviders"];
    musicGenerationProviders: PluginRegistry["musicGenerationProviders"];
    webFetchProviders: PluginRegistry["webFetchProviders"];
    webSearchProviders: PluginRegistry["webSearchProviders"];
    migrationProviders: PluginRegistry["migrationProviders"];
    codexAppServerExtensionFactories: PluginRegistry["codexAppServerExtensionFactories"];
    agentToolResultMiddlewares: PluginRegistry["agentToolResultMiddlewares"];
    memoryEmbeddingProviders: PluginRegistry["memoryEmbeddingProviders"];
    agentHarnesses: PluginRegistry["agentHarnesses"];
    httpRoutes: PluginRegistry["httpRoutes"];
    cliRegistrars: PluginRegistry["cliRegistrars"];
    reloads: NonNullable<PluginRegistry["reloads"]>;
    nodeHostCommands: NonNullable<PluginRegistry["nodeHostCommands"]>;
    nodeInvokePolicies: NonNullable<PluginRegistry["nodeInvokePolicies"]>;
    securityAuditCollectors: NonNullable<PluginRegistry["securityAuditCollectors"]>;
    services: PluginRegistry["services"];
    commands: PluginRegistry["commands"];
    conversationBindingResolvedHandlers: PluginRegistry["conversationBindingResolvedHandlers"];
    diagnostics: PluginRegistry["diagnostics"];
  };
  gatewayHandlers: PluginRegistry["gatewayHandlers"];
  gatewayMethodScopes: NonNullable<PluginRegistry["gatewayMethodScopes"]>;
  coreGatewayMethodNames: NonNullable<PluginRegistry["coreGatewayMethodNames"]>;
};

function snapshotPluginRegistry(registry: PluginRegistry): PluginRegistrySnapshot {
  return {
    arrays: {
      tools: [...registry.tools],
      hooks: [...registry.hooks],
      typedHooks: [...registry.typedHooks],
      channels: [...registry.channels],
      channelSetups: [...registry.channelSetups],
      providers: [...registry.providers],
      cliBackends: [...(registry.cliBackends ?? [])],
      textTransforms: [...registry.textTransforms],
      speechProviders: [...registry.speechProviders],
      realtimeTranscriptionProviders: [...registry.realtimeTranscriptionProviders],
      realtimeVoiceProviders: [...registry.realtimeVoiceProviders],
      mediaUnderstandingProviders: [...registry.mediaUnderstandingProviders],
      imageGenerationProviders: [...registry.imageGenerationProviders],
      videoGenerationProviders: [...registry.videoGenerationProviders],
      musicGenerationProviders: [...registry.musicGenerationProviders],
      webFetchProviders: [...registry.webFetchProviders],
      webSearchProviders: [...registry.webSearchProviders],
      migrationProviders: [...registry.migrationProviders],
      codexAppServerExtensionFactories: [...registry.codexAppServerExtensionFactories],
      agentToolResultMiddlewares: [...registry.agentToolResultMiddlewares],
      memoryEmbeddingProviders: [...registry.memoryEmbeddingProviders],
      agentHarnesses: [...registry.agentHarnesses],
      httpRoutes: [...registry.httpRoutes],
      cliRegistrars: [...registry.cliRegistrars],
      reloads: [...(registry.reloads ?? [])],
      nodeHostCommands: [...(registry.nodeHostCommands ?? [])],
      nodeInvokePolicies: [...(registry.nodeInvokePolicies ?? [])],
      securityAuditCollectors: [...(registry.securityAuditCollectors ?? [])],
      services: [...registry.services],
      commands: [...registry.commands],
      conversationBindingResolvedHandlers: [...registry.conversationBindingResolvedHandlers],
      diagnostics: [...registry.diagnostics],
    },
    gatewayHandlers: { ...registry.gatewayHandlers },
    gatewayMethodScopes: { ...registry.gatewayMethodScopes },
    coreGatewayMethodNames: [...(registry.coreGatewayMethodNames ?? [])],
  };
}

function restorePluginRegistry(registry: PluginRegistry, snapshot: PluginRegistrySnapshot): void {
  registry.tools = snapshot.arrays.tools;
  registry.hooks = snapshot.arrays.hooks;
  registry.typedHooks = snapshot.arrays.typedHooks;
  registry.channels = snapshot.arrays.channels;
  registry.channelSetups = snapshot.arrays.channelSetups;
  registry.providers = snapshot.arrays.providers;
  registry.cliBackends = snapshot.arrays.cliBackends;
  registry.textTransforms = snapshot.arrays.textTransforms;
  registry.speechProviders = snapshot.arrays.speechProviders;
  registry.realtimeTranscriptionProviders = snapshot.arrays.realtimeTranscriptionProviders;
  registry.realtimeVoiceProviders = snapshot.arrays.realtimeVoiceProviders;
  registry.mediaUnderstandingProviders = snapshot.arrays.mediaUnderstandingProviders;
  registry.imageGenerationProviders = snapshot.arrays.imageGenerationProviders;
  registry.videoGenerationProviders = snapshot.arrays.videoGenerationProviders;
  registry.musicGenerationProviders = snapshot.arrays.musicGenerationProviders;
  registry.webFetchProviders = snapshot.arrays.webFetchProviders;
  registry.webSearchProviders = snapshot.arrays.webSearchProviders;
  registry.migrationProviders = snapshot.arrays.migrationProviders;
  registry.codexAppServerExtensionFactories = snapshot.arrays.codexAppServerExtensionFactories;
  registry.agentToolResultMiddlewares = snapshot.arrays.agentToolResultMiddlewares;
  registry.memoryEmbeddingProviders = snapshot.arrays.memoryEmbeddingProviders;
  registry.agentHarnesses = snapshot.arrays.agentHarnesses;
  registry.httpRoutes = snapshot.arrays.httpRoutes;
  registry.cliRegistrars = snapshot.arrays.cliRegistrars;
  registry.reloads = snapshot.arrays.reloads;
  registry.nodeHostCommands = snapshot.arrays.nodeHostCommands;
  registry.nodeInvokePolicies = snapshot.arrays.nodeInvokePolicies;
  registry.securityAuditCollectors = snapshot.arrays.securityAuditCollectors;
  registry.services = snapshot.arrays.services;
  registry.commands = snapshot.arrays.commands;
  registry.conversationBindingResolvedHandlers =
    snapshot.arrays.conversationBindingResolvedHandlers;
  registry.diagnostics = snapshot.arrays.diagnostics;
  registry.gatewayHandlers = snapshot.gatewayHandlers;
  registry.gatewayMethodScopes = snapshot.gatewayMethodScopes;
  registry.coreGatewayMethodNames = snapshot.coreGatewayMethodNames;
}

function createGuardedPluginRegistrationApi(api: OpenClawPluginApi): {
  api: OpenClawPluginApi;
  close: () => void;
} {
  let closed = false;
  return {
    api: new Proxy(api, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          if (closed) {
            return undefined;
          }
          return Reflect.apply(value, target, args);
        };
      },
    }),
    close: () => {
      closed = true;
    },
  };
}

function runPluginRegisterSync(
  register: NonNullable<OpenClawPluginDefinition["register"]>,
  api: Parameters<NonNullable<OpenClawPluginDefinition["register"]>>[0],
): void {
  const guarded = createGuardedPluginRegistrationApi(api);
  try {
    const result = register(guarded.api);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("plugin register must be synchronous");
    }
  } finally {
    guarded.close();
  }
}

function createPluginModuleLoader(options: Pick<PluginLoadOptions, "pluginSdkResolution">) {
  const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();
  const loadSourceModule = (modulePath: string) => {
    return getCachedPluginSourceModuleLoader({
      cache: moduleLoaders,
      modulePath,
      importerUrl: import.meta.url,
      loaderFilename: modulePath,
      aliasMap: buildPluginLoaderAliasMap(
        modulePath,
        process.argv[1],
        import.meta.url,
        options.pluginSdkResolution,
      ),
      pluginSdkResolution: options.pluginSdkResolution,
    });
  };
  return (modulePath: string): unknown => {
    if (shouldPreferNativeModuleLoad(modulePath)) {
      const native = tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true });
      if (native.ok) {
        return native.moduleExport;
      }
    }
    // Source .ts runtime shims import sibling ".js" specifiers that only exist
    // after build. Jiti remains the dev/source fallback because it rewrites those
    // imports against the source graph and applies SDK aliases.
    return loadSourceModule(modulePath)(toSafeImportPath(modulePath));
  };
}

function resolveCanonicalDistRuntimeSource(source: string): string {
  const marker = `${path.sep}dist-runtime${path.sep}extensions${path.sep}`;
  const index = source.indexOf(marker);
  if (index === -1) {
    return source;
  }
  const candidate = `${source.slice(0, index)}${path.sep}dist${path.sep}extensions${path.sep}${source.slice(index + marker.length)}`;
  return fs.existsSync(candidate) ? candidate : source;
}

export const __testing = {
  buildPluginLoaderJitiOptions,
  buildPluginLoaderAliasMap,
  listPluginSdkAliasCandidates,
  listPluginSdkExportedSubpaths,
  resolveExtensionApiAlias,
  resolvePluginSdkScopedAliasMap,
  resolvePluginSdkAliasCandidateOrder,
  resolvePluginSdkAliasFile,
  resolvePluginRuntimeModulePath,
  ensureOpenClawPluginSdkAlias,
  shouldLoadChannelPluginInSetupRuntime,
  shouldPreferNativeModuleLoad,
  toSafeImportPath,
  getCompatibleActivePluginRegistry,
  resolvePluginLoadCacheContext,
  get maxPluginRegistryCacheEntries() {
    return pluginLoaderCacheState.maxEntries;
  },
  setMaxPluginRegistryCacheEntriesForTest(value?: number) {
    pluginLoaderCacheState.setMaxEntriesForTest(value);
    fullWorkspacePluginLoaderCacheState.setMaxEntriesForTest(value);
  },
};

function getPluginRegistryCache(onlyPluginIds?: string[]) {
  return onlyPluginIds ? pluginLoaderCacheState : fullWorkspacePluginLoaderCacheState;
}

function getCachedPluginRegistry(
  cacheKey: string,
  onlyPluginIds?: string[],
): CachedPluginState | undefined {
  return getPluginRegistryCache(onlyPluginIds).get(cacheKey);
}

function setCachedPluginRegistry(
  cacheKey: string,
  state: CachedPluginState,
  onlyPluginIds?: string[],
): void {
  getPluginRegistryCache(onlyPluginIds).set(cacheKey, state);
}

function resolveBundledPackageRootForCache(stockRoot?: string): string | undefined {
  if (!stockRoot) {
    return undefined;
  }
  const resolved = path.resolve(stockRoot);
  const parent = path.dirname(resolved);
  if (
    path.basename(resolved) === "extensions" &&
    (path.basename(parent) === "dist" || path.basename(parent) === "dist-runtime")
  ) {
    return path.dirname(parent);
  }
  const sourcePackageRoot = parent;
  if (fs.existsSync(path.join(sourcePackageRoot, "package.json"))) {
    return sourcePackageRoot;
  }
  return undefined;
}

function readPackageVersionForCache(packageJsonPath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "unknown";
    }
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.trim() ? version.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

function resolveBundledPackageCacheIdentity(stockRoot?: string):
  | {
      packageJson: string;
      packageRoot: string;
      packageVersion: string;
      size: number;
      mtimeMs: number;
    }
  | undefined {
  const packageRoot = resolveBundledPackageRootForCache(stockRoot);
  if (!packageRoot) {
    return undefined;
  }
  const packageJsonPath = path.join(packageRoot, "package.json");
  try {
    const stat = fs.statSync(packageJsonPath);
    return {
      packageJson: safeRealpathOrResolve(packageJsonPath),
      packageRoot: safeRealpathOrResolve(packageRoot),
      packageVersion: readPackageVersionForCache(packageJsonPath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return {
      packageJson: path.resolve(packageJsonPath),
      packageRoot: safeRealpathOrResolve(packageRoot),
      packageVersion: "missing",
      size: -1,
      mtimeMs: -1,
    };
  }
}

function buildCacheKey(params: {
  workspaceDir?: string;
  plugins: NormalizedPluginsConfig;
  activationMetadataKey?: string;
  installs?: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeSetupOnlyChannelPlugins?: boolean;
  forceSetupOnlyChannelPlugins?: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins?: boolean;
  preferSetupRuntimeForChannelPlugins?: boolean;
  toolDiscovery?: boolean;
  loadModules?: boolean;
  runtimeSubagentMode?: "default" | "explicit" | "gateway-bindable";
  pluginSdkResolution?: PluginSdkResolutionPreference;
  coreGatewayMethodNames?: string[];
  activate?: boolean;
}): string {
  const discoveryContext = resolvePluginDiscoveryContext({
    workspaceDir: params.workspaceDir,
    loadPaths: params.plugins.loadPaths,
    env: params.env,
  });
  const { roots, loadPaths } = discoveryContext;
  const bundledPackage = resolveBundledPackageCacheIdentity(roots.stock);
  const installs = Object.fromEntries(
    Object.entries(params.installs ?? {}).map(([pluginId, install]) => [
      pluginId,
      {
        ...install,
        installPath:
          typeof install.installPath === "string"
            ? resolveUserPath(install.installPath, params.env)
            : install.installPath,
        sourcePath:
          typeof install.sourcePath === "string"
            ? resolveUserPath(install.sourcePath, params.env)
            : install.sourcePath,
      },
    ]),
  );
  const scopeKey = serializePluginIdScope(params.onlyPluginIds);
  const setupOnlyKey = params.includeSetupOnlyChannelPlugins === true ? "setup-only" : "runtime";
  const setupOnlyModeKey =
    params.forceSetupOnlyChannelPlugins === true ? "force-setup" : "normal-setup";
  const setupOnlyRequirementKey =
    params.requireSetupEntryForSetupOnlyChannelPlugins === true
      ? "require-setup-entry"
      : "allow-full-fallback";
  const startupChannelMode =
    params.preferSetupRuntimeForChannelPlugins === true ? "prefer-setup" : "full";
  const moduleLoadMode = params.loadModules === false ? "manifest-only" : "load-modules";
  const discoveryMode = params.toolDiscovery === true ? "tool-discovery" : "default-discovery";
  const runtimeSubagentMode = params.runtimeSubagentMode ?? "default";
  const gatewayMethodsKey = JSON.stringify(params.coreGatewayMethodNames ?? []);
  const activationMode = params.activate === false ? "snapshot" : "active";
  return `${roots.workspace ?? ""}::${roots.global ?? ""}::${roots.stock ?? ""}::${JSON.stringify({
    bundledPackage,
    discoveryFingerprint: fingerprintPluginDiscoveryContext(discoveryContext),
    ...params.plugins,
    installs,
    loadPaths,
    activationMetadataKey: params.activationMetadataKey ?? "",
  })}::${scopeKey}::${setupOnlyKey}::${setupOnlyModeKey}::${setupOnlyRequirementKey}::${startupChannelMode}::${moduleLoadMode}::${discoveryMode}::${runtimeSubagentMode}::${params.pluginSdkResolution ?? "auto"}::${gatewayMethodsKey}::${activationMode}`;
}

function matchesScopedPluginRequest(params: {
  onlyPluginIdSet: ReadonlySet<string> | null;
  pluginId: string;
}): boolean {
  const scopedIds = params.onlyPluginIdSet;
  if (!scopedIds) {
    return true;
  }
  return scopedIds.has(params.pluginId);
}

function resolveRuntimeSubagentMode(
  runtimeOptions: PluginLoadOptions["runtimeOptions"],
): "default" | "explicit" | "gateway-bindable" {
  if (runtimeOptions?.allowGatewaySubagentBinding === true) {
    return "gateway-bindable";
  }
  if (runtimeOptions?.subagent) {
    return "explicit";
  }
  return "default";
}

function buildActivationMetadataHash(params: {
  activationSource: PluginActivationConfigSource;
  autoEnabledReasons: Readonly<Record<string, string[]>>;
}): string {
  const enabledSourceChannels = Object.entries(
    (params.activationSource.rootConfig?.channels as Record<string, unknown>) ?? {},
  )
    .filter(([, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      return (value as { enabled?: unknown }).enabled === true;
    })
    .map(([channelId]) => channelId)
    .toSorted((left, right) => left.localeCompare(right));
  const pluginEntryStates = Object.entries(params.activationSource.plugins.entries)
    .map(([pluginId, entry]) => [pluginId, entry?.enabled ?? null] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
  const autoEnableReasonEntries = Object.entries(params.autoEnabledReasons)
    .map(([pluginId, reasons]) => [pluginId, [...reasons]] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));

  return createHash("sha256")
    .update(
      JSON.stringify({
        enabled: params.activationSource.plugins.enabled,
        allow: params.activationSource.plugins.allow,
        deny: params.activationSource.plugins.deny,
        memorySlot: params.activationSource.plugins.slots.memory,
        entries: pluginEntryStates,
        enabledChannels: enabledSourceChannels,
        autoEnabledReasons: autoEnableReasonEntries,
      }),
    )
    .digest("hex");
}

function hasExplicitCompatibilityInputs(options: PluginLoadOptions): boolean {
  return (
    options.config !== undefined ||
    options.activationSourceConfig !== undefined ||
    options.autoEnabledReasons !== undefined ||
    options.workspaceDir !== undefined ||
    options.env !== undefined ||
    hasExplicitPluginIdScope(options.onlyPluginIds) ||
    options.runtimeOptions !== undefined ||
    options.pluginSdkResolution !== undefined ||
    options.coreGatewayHandlers !== undefined ||
    options.includeSetupOnlyChannelPlugins === true ||
    options.forceSetupOnlyChannelPlugins === true ||
    options.requireSetupEntryForSetupOnlyChannelPlugins === true ||
    options.preferSetupRuntimeForChannelPlugins === true ||
    options.loadModules === false
  );
}

function resolveCoreGatewayMethodNames(options: PluginLoadOptions): string[] {
  const names = new Set(options.coreGatewayMethodNames ?? []);
  for (const name of Object.keys(options.coreGatewayHandlers ?? {})) {
    names.add(name);
  }
  return Array.from(names).toSorted();
}

function pluginLoadOptionsMatchCacheKey(
  options: PluginLoadOptions,
  expectedCacheKey: string,
): boolean {
  return resolvePluginLoadCacheContext(options).cacheKey === expectedCacheKey;
}

function pluginToolDiscoveryOptionsMatchActiveCacheKey(
  options: PluginLoadOptions,
  expectedCacheKey: string,
): boolean {
  if (options.toolDiscovery !== true) {
    return false;
  }
  const fullRuntimeOptions = {
    ...options,
    toolDiscovery: undefined,
  };
  if (pluginLoadOptionsMatchCacheKey(fullRuntimeOptions, expectedCacheKey)) {
    return true;
  }
  if (options.activate !== false) {
    return false;
  }
  return pluginLoadOptionsMatchCacheKey(
    {
      ...fullRuntimeOptions,
      activate: true,
    },
    expectedCacheKey,
  );
}

function registryContainsPluginScope(
  registry: PluginRegistry,
  onlyPluginIds: readonly string[] | undefined,
): boolean {
  if (!onlyPluginIds || onlyPluginIds.length === 0) {
    return false;
  }
  const loadedPluginIds = new Set(registry.plugins.map((plugin) => plugin.id));
  return onlyPluginIds.every((pluginId) => loadedPluginIds.has(pluginId));
}

function scopedPluginLoadOptionsMatchWiderActiveCacheKey(
  options: PluginLoadOptions,
  expectedCacheKey: string,
  activeRegistry: PluginRegistry,
): boolean {
  const { onlyPluginIds } = resolvePluginLoadCacheContext(options);
  if (!registryContainsPluginScope(activeRegistry, onlyPluginIds)) {
    return false;
  }
  return pluginLoadOptionsMatchCacheKey(
    {
      ...options,
      onlyPluginIds: undefined,
    },
    expectedCacheKey,
  );
}

type PluginRegistrationPlan = {
  /** Public compatibility label passed to plugin register(api). */
  mode: PluginRegistrationMode;
  /** Load a setup entry instead of the normal runtime entry. */
  loadSetupEntry: boolean;
  /** Setup flow also needs the runtime channel entry for runtime setters/plugin shape. */
  loadSetupRuntimeEntry: boolean;
  /** Apply runtime capability policy such as memory-slot selection. */
  runRuntimeCapabilityPolicy: boolean;
  /** Register metadata that only belongs to live activation, not discovery snapshots. */
  runFullActivationOnlyRegistrations: boolean;
};

/**
 * Convert loader intent into explicit behavior flags.
 *
 * Registration modes are plugin-facing labels; this plan is the internal source
 * of truth for which entrypoint to load and which activation-only policies run.
 */
function resolvePluginRegistrationPlan(params: {
  canLoadScopedSetupOnlyChannelPlugin: boolean;
  scopedSetupOnlyChannelPluginRequested: boolean;
  requireSetupEntryForSetupOnlyChannelPlugins: boolean;
  enableStateEnabled: boolean;
  shouldLoadModules: boolean;
  validateOnly: boolean;
  shouldActivate: boolean;
  manifestRecord: PluginManifestRecord;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  preferSetupRuntimeForChannelPlugins: boolean;
  toolDiscovery: boolean;
}): PluginRegistrationPlan | null {
  if (params.canLoadScopedSetupOnlyChannelPlugin) {
    return {
      mode: "setup-only",
      loadSetupEntry: true,
      loadSetupRuntimeEntry: false,
      runRuntimeCapabilityPolicy: false,
      runFullActivationOnlyRegistrations: false,
    };
  }
  if (
    params.scopedSetupOnlyChannelPluginRequested &&
    params.requireSetupEntryForSetupOnlyChannelPlugins
  ) {
    return null;
  }
  if (!params.enableStateEnabled) {
    return null;
  }
  if (params.toolDiscovery) {
    return {
      mode: "tool-discovery",
      loadSetupEntry: false,
      loadSetupRuntimeEntry: false,
      runRuntimeCapabilityPolicy: true,
      runFullActivationOnlyRegistrations: false,
    };
  }
  const loadSetupRuntimeEntry =
    params.shouldLoadModules &&
    !params.validateOnly &&
    shouldLoadChannelPluginInSetupRuntime({
      manifestChannels: params.manifestRecord.channels,
      setupSource: params.manifestRecord.setupSource,
      startupDeferConfiguredChannelFullLoadUntilAfterListen:
        params.manifestRecord.startupDeferConfiguredChannelFullLoadUntilAfterListen,
      cfg: params.cfg,
      env: params.env,
      preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
    });
  if (loadSetupRuntimeEntry) {
    return {
      mode: "setup-runtime",
      loadSetupEntry: true,
      loadSetupRuntimeEntry: true,
      runRuntimeCapabilityPolicy: false,
      runFullActivationOnlyRegistrations: false,
    };
  }
  const mode = params.shouldActivate ? "full" : "discovery";
  return {
    mode,
    loadSetupEntry: false,
    loadSetupRuntimeEntry: false,
    runRuntimeCapabilityPolicy: true,
    runFullActivationOnlyRegistrations: mode === "full",
  };
}

function applyManifestSnapshotMetadata(
  record: PluginRecord,
  manifestRecord: PluginManifestRecord,
): void {
  record.channelIds = [...(manifestRecord.channels ?? [])];
  record.providerIds = [...(manifestRecord.providers ?? [])];
  record.cliBackendIds = [
    ...(manifestRecord.cliBackends ?? []),
    ...(manifestRecord.setup?.cliBackends ?? []),
  ];
  record.commands = (manifestRecord.commandAliases ?? []).map((alias) => alias.name);
}

function resolvePluginLoadCacheContext(options: PluginLoadOptions = {}) {
  const env = options.env ?? process.env;
  const cfg = applyTestPluginDefaults(options.config ?? {}, env);
  const activationSourceConfig = resolvePluginActivationSourceConfig({
    config: options.config,
    activationSourceConfig: options.activationSourceConfig,
  });
  const normalized = normalizePluginsConfig(cfg.plugins);
  const activationSource = createPluginActivationSource({
    config: activationSourceConfig,
  });
  const trustNormalized = mergeTrustPluginConfigFromActivationSource({
    normalized,
    activationSource,
  });
  const onlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
  const includeSetupOnlyChannelPlugins = options.includeSetupOnlyChannelPlugins === true;
  const forceSetupOnlyChannelPlugins = options.forceSetupOnlyChannelPlugins === true;
  const requireSetupEntryForSetupOnlyChannelPlugins =
    options.requireSetupEntryForSetupOnlyChannelPlugins === true;
  const preferSetupRuntimeForChannelPlugins = options.preferSetupRuntimeForChannelPlugins === true;
  const runtimeSubagentMode = resolveRuntimeSubagentMode(options.runtimeOptions);
  const coreGatewayMethodNames = resolveCoreGatewayMethodNames(options);
  const installRecords = {
    ...loadInstalledPluginIndexInstallRecordsSync({ env }),
    ...cfg.plugins?.installs,
  };
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: trustNormalized,
    activationMetadataKey: buildActivationMetadataHash({
      activationSource,
      autoEnabledReasons: options.autoEnabledReasons ?? {},
    }),
    installs: installRecords,
    env,
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    requireSetupEntryForSetupOnlyChannelPlugins,
    preferSetupRuntimeForChannelPlugins,
    toolDiscovery: options.toolDiscovery,
    loadModules: options.loadModules,
    runtimeSubagentMode,
    pluginSdkResolution: options.pluginSdkResolution,
    coreGatewayMethodNames,
    activate: options.activate,
  });
  return {
    env,
    cfg,
    normalized: trustNormalized,
    activationSourceConfig,
    activationSource,
    autoEnabledReasons: options.autoEnabledReasons ?? {},
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    requireSetupEntryForSetupOnlyChannelPlugins,
    preferSetupRuntimeForChannelPlugins,
    shouldActivate: options.activate !== false,
    shouldLoadModules: options.loadModules !== false,
    runtimeSubagentMode,
    installRecords,
    cacheKey,
  };
}

function mergeTrustPluginConfigFromActivationSource(params: {
  normalized: NormalizedPluginsConfig;
  activationSource: PluginActivationConfigSource;
}): NormalizedPluginsConfig {
  const source = params.activationSource.plugins;
  const allow = mergePluginTrustList(params.normalized.allow, source.allow);
  const deny = mergePluginTrustList(params.normalized.deny, source.deny);
  const loadPaths = mergePluginTrustList(params.normalized.loadPaths, source.loadPaths);
  if (
    allow === params.normalized.allow &&
    deny === params.normalized.deny &&
    loadPaths === params.normalized.loadPaths
  ) {
    return params.normalized;
  }
  return {
    ...params.normalized,
    allow,
    deny,
    loadPaths,
  };
}

function mergePluginTrustList(runtimeList: string[], sourceList: readonly string[]): string[] {
  if (sourceList.length === 0) {
    return runtimeList;
  }
  const merged = [...runtimeList];
  const seen = new Set(merged);
  for (const entry of sourceList) {
    if (!seen.has(entry)) {
      merged.push(entry);
      seen.add(entry);
    }
  }
  return merged.length === runtimeList.length ? runtimeList : merged;
}

function getCompatibleActivePluginRegistry(
  options: PluginLoadOptions = {},
): PluginRegistry | undefined {
  const activeRegistry = getActivePluginRegistry() ?? undefined;
  if (!activeRegistry) {
    return undefined;
  }
  if (!hasExplicitCompatibilityInputs(options)) {
    return activeRegistry;
  }
  const activeCacheKey = getActivePluginRegistryKey();
  if (!activeCacheKey) {
    return undefined;
  }
  const loadContext = resolvePluginLoadCacheContext(options);
  const matchesActiveCacheKey = (candidate: PluginLoadOptions): boolean => {
    if (pluginLoadOptionsMatchCacheKey(candidate, activeCacheKey)) {
      return true;
    }
    if (candidate.coreGatewayMethodNames !== undefined) {
      return false;
    }
    return pluginLoadOptionsMatchCacheKey(
      {
        ...candidate,
        coreGatewayMethodNames: activeRegistry.coreGatewayMethodNames ?? [],
      },
      activeCacheKey,
    );
  };

  if (matchesActiveCacheKey(options)) {
    return activeRegistry;
  }
  if (scopedPluginLoadOptionsMatchWiderActiveCacheKey(options, activeCacheKey, activeRegistry)) {
    return activeRegistry;
  }
  if (!loadContext.shouldActivate) {
    const activatingOptions = {
      ...options,
      activate: true,
    };
    if (matchesActiveCacheKey(activatingOptions)) {
      return activeRegistry;
    }
    if (
      scopedPluginLoadOptionsMatchWiderActiveCacheKey(
        activatingOptions,
        activeCacheKey,
        activeRegistry,
      )
    ) {
      return activeRegistry;
    }
  }
  if (pluginToolDiscoveryOptionsMatchActiveCacheKey(options, activeCacheKey)) {
    return activeRegistry;
  }
  if (
    loadContext.runtimeSubagentMode === "default" &&
    getActivePluginRuntimeSubagentMode() === "gateway-bindable"
  ) {
    const gatewayBindableOptions = {
      ...options,
      runtimeOptions: {
        ...options.runtimeOptions,
        allowGatewaySubagentBinding: true,
      },
    };
    if (matchesActiveCacheKey(gatewayBindableOptions)) {
      return activeRegistry;
    }
    if (
      scopedPluginLoadOptionsMatchWiderActiveCacheKey(
        gatewayBindableOptions,
        activeCacheKey,
        activeRegistry,
      )
    ) {
      return activeRegistry;
    }
    if (pluginToolDiscoveryOptionsMatchActiveCacheKey(gatewayBindableOptions, activeCacheKey)) {
      return activeRegistry;
    }
    if (!loadContext.shouldActivate) {
      const activatingGatewayBindableOptions = {
        ...options,
        activate: true,
        runtimeOptions: {
          ...options.runtimeOptions,
          allowGatewaySubagentBinding: true,
        },
      };
      if (matchesActiveCacheKey(activatingGatewayBindableOptions)) {
        return activeRegistry;
      }
      if (
        scopedPluginLoadOptionsMatchWiderActiveCacheKey(
          activatingGatewayBindableOptions,
          activeCacheKey,
          activeRegistry,
        )
      ) {
        return activeRegistry;
      }
    }
  }
  return undefined;
}

export function resolveRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  if (!options || !hasExplicitCompatibilityInputs(options)) {
    return getCompatibleActivePluginRegistry();
  }
  const compatible = getCompatibleActivePluginRegistry(options);
  if (compatible) {
    return compatible;
  }
  // Helper/runtime callers should not recurse into the same snapshot load while
  // plugin registration is still in flight. Let direct loadOpenClawPlugins(...)
  // callers surface the hard error instead.
  if (isPluginRegistryLoadInFlight(options)) {
    return undefined;
  }
  return loadOpenClawPlugins(options);
}

export function resolvePluginRegistryLoadCacheKey(options: PluginLoadOptions = {}): string {
  return resolvePluginLoadCacheContext(options).cacheKey;
}

export function isPluginRegistryLoadInFlight(options: PluginLoadOptions = {}): boolean {
  return pluginLoaderCacheState.isLoadInFlight(resolvePluginRegistryLoadCacheKey(options));
}

export function resolveCompatibleRuntimePluginRegistry(
  options?: PluginLoadOptions,
): PluginRegistry | undefined {
  // Check whether the active runtime registry is already compatible with these
  // load options. Unlike resolveRuntimePluginRegistry, this never triggers a
  // fresh plugin load on cache miss.
  return getCompatibleActivePluginRegistry(options);
}

function validatePluginConfig(params: {
  schema?: Record<string, unknown>;
  cacheKey?: string;
  value?: unknown;
}): { ok: boolean; value?: Record<string, unknown>; errors?: string[] } {
  const schema = params.schema;
  if (!schema) {
    return { ok: true, value: params.value as Record<string, unknown> | undefined };
  }
  const cacheKey = params.cacheKey ?? JSON.stringify(schema);
  const result = validateJsonSchemaValue({
    schema,
    cacheKey,
    value: params.value ?? {},
    applyDefaults: true,
  });
  if (result.ok) {
    return { ok: true, value: result.value as Record<string, unknown> | undefined };
  }
  return { ok: false, errors: result.errors.map((error) => error.text) };
}

function resolvePluginModuleExport(moduleExport: unknown): {
  definition?: OpenClawPluginDefinition;
  register?: OpenClawPluginDefinition["register"];
} {
  const seen = new Set<unknown>();
  const candidates: unknown[] = [unwrapDefaultModuleExport(moduleExport), moduleExport];
  for (let index = 0; index < candidates.length && index < 12; index += 1) {
    const resolved = candidates[index];
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    if (typeof resolved === "function") {
      return {
        register: resolved as OpenClawPluginDefinition["register"],
      };
    }
    if (resolved && typeof resolved === "object") {
      const def = resolved as OpenClawPluginDefinition;
      const register = def.register ?? def.activate;
      if (typeof register === "function") {
        return { definition: def, register };
      }
      for (const key of ["default", "module"]) {
        if (key in def) {
          candidates.push((def as Record<string, unknown>)[key]);
        }
      }
    }
  }
  const resolved = candidates[0];
  if (typeof resolved === "function") {
    return {
      register: resolved as OpenClawPluginDefinition["register"],
    };
  }
  if (resolved && typeof resolved === "object") {
    const def = resolved as OpenClawPluginDefinition;
    const register = def.register ?? def.activate;
    return { definition: def, register };
  }
  return {};
}

function pushDiagnostics(diagnostics: PluginDiagnostic[], append: PluginDiagnostic[]) {
  diagnostics.push(...append);
}

function maybeThrowOnPluginLoadError(
  registry: PluginRegistry,
  throwOnLoadError: boolean | undefined,
): void {
  if (!throwOnLoadError) {
    return;
  }
  if (!registry.plugins.some((entry) => entry.status === "error")) {
    return;
  }
  throw new PluginLoadFailureError(registry);
}

function activatePluginRegistry(
  registry: PluginRegistry,
  cacheKey: string,
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable",
  workspaceDir?: string,
): void {
  const preserveGatewayHookRunner =
    runtimeSubagentMode === "default" &&
    getActivePluginRuntimeSubagentMode() === "gateway-bindable" &&
    getGlobalHookRunner() !== null;
  setActivePluginRegistry(registry, cacheKey, runtimeSubagentMode, workspaceDir);
  if (!preserveGatewayHookRunner) {
    initializeGlobalHookRunner(registry);
  }
}

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  const requestedOnlyPluginIds = normalizePluginIdScope(options.onlyPluginIds);
  const requestedOnlyPluginIdSet = createPluginIdScopeSet(requestedOnlyPluginIds);
  if (requestedOnlyPluginIdSet && requestedOnlyPluginIdSet.size === 0) {
    const emptyRegistry = createEmptyPluginRegistry();
    if (options.activate !== false) {
      clearAgentHarnesses();
      clearPluginCommands();
      clearPluginInteractiveHandlers();
      clearDetachedTaskLifecycleRuntimeRegistration();
      clearMemoryPluginState();
      activatePluginRegistry(
        emptyRegistry,
        `empty-plugin-scope::${resolveRuntimeSubagentMode(options.runtimeOptions)}::${options.workspaceDir ?? ""}`,
        resolveRuntimeSubagentMode(options.runtimeOptions),
        options.workspaceDir,
      );
    }
    return emptyRegistry;
  }

  const {
    env,
    cfg,
    normalized,
    activationSource,
    autoEnabledReasons,
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    requireSetupEntryForSetupOnlyChannelPlugins,
    preferSetupRuntimeForChannelPlugins,
    shouldActivate,
    shouldLoadModules,
    cacheKey,
    runtimeSubagentMode,
    installRecords,
  } = resolvePluginLoadCacheContext(options);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const onlyPluginIdSet = createPluginIdScopeSet(onlyPluginIds);

  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = getCachedPluginRegistry(cacheKey, onlyPluginIds);
    if (cached) {
      if (shouldActivate) {
        restoreRegisteredAgentHarnesses(cached.agentHarnesses);
        restorePluginCommands(cached.commands ?? []);
        restoreRegisteredCompactionProviders(cached.compactionProviders);
        restoreDetachedTaskLifecycleRuntimeRegistration(cached.detachedTaskRuntimeRegistration);
        restorePluginInteractiveHandlers(cached.interactiveHandlers ?? []);
        restoreRegisteredMemoryEmbeddingProviders(cached.memoryEmbeddingProviders);
        restoreMemoryPluginState({
          capability: cached.memoryCapability,
          corpusSupplements: cached.memoryCorpusSupplements,
          promptBuilder: cached.memoryPromptBuilder,
          promptSupplements: cached.memoryPromptSupplements,
          flushPlanResolver: cached.memoryFlushPlanResolver,
          runtime: cached.memoryRuntime,
        });
        activatePluginRegistry(
          cached.registry,
          cacheKey,
          runtimeSubagentMode,
          options.workspaceDir,
        );
      }
      return cached.registry;
    }
  }
  pluginLoaderCacheState.beginLoad(cacheKey);
  try {
    // Clear previously registered plugin state before reloading.
    // Skip for non-activating (snapshot) loads to avoid wiping commands from other plugins.
    if (shouldActivate) {
      clearAgentHarnesses();
      clearPluginCommands();
      clearPluginInteractiveHandlers();
      clearDetachedTaskLifecycleRuntimeRegistration();
      clearMemoryPluginState();
    }

    // Lazy: avoid creating module loaders when all plugins are disabled (common in unit tests).
    const loadPluginModule = createPluginModuleLoader(options);

    let createPluginRuntimeFactory:
      | ((options?: CreatePluginRuntimeOptions) => PluginRuntime)
      | null = null;
    const resolveCreatePluginRuntime = (): ((
      options?: CreatePluginRuntimeOptions,
    ) => PluginRuntime) => {
      if (createPluginRuntimeFactory) {
        return createPluginRuntimeFactory;
      }
      const runtimeModulePath = resolvePluginRuntimeModulePath({
        pluginSdkResolution: options.pluginSdkResolution,
      });
      if (!runtimeModulePath) {
        throw new Error("Unable to resolve plugin runtime module");
      }
      const runtimeModule = withProfile(
        { source: runtimeModulePath },
        "runtime-module",
        () =>
          loadPluginModule(runtimeModulePath) as {
            createPluginRuntime?: (options?: CreatePluginRuntimeOptions) => PluginRuntime;
          },
      );
      if (typeof runtimeModule.createPluginRuntime !== "function") {
        throw new Error("Plugin runtime module missing createPluginRuntime export");
      }
      createPluginRuntimeFactory = runtimeModule.createPluginRuntime;
      return createPluginRuntimeFactory;
    };

    // Lazily initialize the runtime so startup paths that discover/skip plugins do
    // not eagerly load every channel/runtime dependency tree.
    let resolvedRuntime: PluginRuntime | null = null;
    const resolveRuntime = (): PluginRuntime => {
      resolvedRuntime ??= resolveCreatePluginRuntime()(options.runtimeOptions);
      return resolvedRuntime;
    };
    const lazyRuntimeReflectionKeySet = new Set<PropertyKey>(LAZY_RUNTIME_REFLECTION_KEYS);
    const resolveLazyRuntimeDescriptor = (prop: PropertyKey): PropertyDescriptor | undefined => {
      if (!lazyRuntimeReflectionKeySet.has(prop)) {
        return Reflect.getOwnPropertyDescriptor(resolveRuntime() as object, prop);
      }
      return {
        configurable: true,
        enumerable: true,
        get() {
          return Reflect.get(resolveRuntime() as object, prop);
        },
        set(value: unknown) {
          Reflect.set(resolveRuntime() as object, prop, value);
        },
      };
    };
    const runtime = new Proxy({} as PluginRuntime, {
      get(_target, prop, receiver) {
        return Reflect.get(resolveRuntime(), prop, receiver);
      },
      set(_target, prop, value, receiver) {
        return Reflect.set(resolveRuntime(), prop, value, receiver);
      },
      has(_target, prop) {
        return lazyRuntimeReflectionKeySet.has(prop) || Reflect.has(resolveRuntime(), prop);
      },
      ownKeys() {
        return [...LAZY_RUNTIME_REFLECTION_KEYS];
      },
      getOwnPropertyDescriptor(_target, prop) {
        return resolveLazyRuntimeDescriptor(prop);
      },
      defineProperty(_target, prop, attributes) {
        return Reflect.defineProperty(resolveRuntime() as object, prop, attributes);
      },
      deleteProperty(_target, prop) {
        return Reflect.deleteProperty(resolveRuntime() as object, prop);
      },
      getPrototypeOf() {
        return Reflect.getPrototypeOf(resolveRuntime() as object);
      },
    });

    const {
      registry,
      createApi,
      rollbackPluginGlobalSideEffects,
      registerReload,
      registerNodeHostCommand,
      registerSecurityAuditCollector,
    } = createPluginRegistry({
      logger,
      runtime,
      coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
      ...(options.coreGatewayMethodNames !== undefined && {
        coreGatewayMethodNames: options.coreGatewayMethodNames,
      }),
      activateGlobalSideEffects: shouldActivate,
    });

    const suppliedManifestRegistry = options.manifestRegistry;
    const discovery = suppliedManifestRegistry
      ? {
          candidates: createPluginCandidatesFromManifestRegistry(suppliedManifestRegistry),
          diagnostics: [] as PluginDiagnostic[],
        }
      : discoverOpenClawPlugins({
          workspaceDir: options.workspaceDir,
          extraPaths: normalized.loadPaths,
          env,
          installRecords,
        });
    const manifestRegistry =
      suppliedManifestRegistry ??
      loadPluginManifestRegistry({
        config: cfg,
        workspaceDir: options.workspaceDir,
        env,
        candidates: discovery.candidates,
        diagnostics: discovery.diagnostics,
        installRecords: Object.keys(installRecords).length > 0 ? installRecords : undefined,
      });
    pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
    warnWhenAllowlistIsOpen({
      emitWarning: shouldActivate,
      logger,
      pluginsEnabled: normalized.enabled,
      allow: normalized.allow,
      warningCacheKey: cacheKey,
      warningCache: pluginLoaderCacheState,
      // Keep warning input scoped as well so partial snapshot loads only mention the
      // plugins that were intentionally requested for this registry.
      discoverablePlugins: manifestRegistry.plugins
        .filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id))
        .map((plugin) => ({
          id: plugin.id,
          source: plugin.source,
          origin: plugin.origin,
        })),
    });
    const provenance = buildProvenanceIndex({
      normalizedLoadPaths: normalized.loadPaths,
      env,
    });

    const manifestByRoot = new Map(
      manifestRegistry.plugins.map((record) => [record.rootDir, record]),
    );
    const orderedCandidates = [...discovery.candidates].toSorted((left, right) => {
      return compareDuplicateCandidateOrder({
        left,
        right,
        manifestByRoot,
        provenance,
        env,
      });
    });

    const seenIds = new Map<string, PluginRecord["origin"]>();
    const memorySlot = normalized.slots.memory;
    let selectedMemoryPluginId: string | null = null;
    let memorySlotMatched = false;
    const dreamingEngineId = resolveDreamingSidecarEngineId({ cfg, memorySlot });
    const pluginLoadStartMs = performance.now();
    let pluginLoadAttemptCount = 0;

    for (const candidate of orderedCandidates) {
      const manifestRecord = manifestByRoot.get(candidate.rootDir);
      if (!manifestRecord) {
        continue;
      }
      const pluginId = manifestRecord.id;
      const matchesRequestedScope = matchesScopedPluginRequest({
        onlyPluginIdSet,
        pluginId,
      });
      // Filter again at import time as a final guard. The earlier manifest filter keeps
      // warnings scoped; this one prevents loading/registering anything outside the scope.
      if (!matchesRequestedScope) {
        continue;
      }
      const activationState = resolveEffectivePluginActivationState({
        id: pluginId,
        origin: candidate.origin,
        config: normalized,
        rootConfig: cfg,
        enabledByDefault: manifestRecord.enabledByDefault,
        activationSource,
        autoEnabledReason: formatAutoEnabledActivationReason(autoEnabledReasons[pluginId]),
      });
      const existingOrigin = seenIds.get(pluginId);
      if (existingOrigin) {
        const record = createPluginRecord({
          id: pluginId,
          name: manifestRecord.name ?? pluginId,
          description: manifestRecord.description,
          version: manifestRecord.version,
          format: manifestRecord.format,
          bundleFormat: manifestRecord.bundleFormat,
          bundleCapabilities: manifestRecord.bundleCapabilities,
          source: candidate.source,
          rootDir: candidate.rootDir,
          origin: candidate.origin,
          workspaceDir: candidate.workspaceDir,
          enabled: false,
          compat: collectPluginManifestCompatCodes(manifestRecord),
          activationState,
          syntheticAuthRefs: manifestRecord.syntheticAuthRefs,
          channelIds: manifestRecord.channels,
          providerIds: manifestRecord.providers,
          configSchema: Boolean(manifestRecord.configSchema),
          contracts: manifestRecord.contracts,
        });
        record.status = "disabled";
        record.error = `overridden by ${existingOrigin} plugin`;
        markPluginActivationDisabled(record, record.error);
        registry.plugins.push(record);
        continue;
      }

      const enableState = resolveEffectiveEnableState({
        id: pluginId,
        origin: candidate.origin,
        config: normalized,
        rootConfig: cfg,
        enabledByDefault: manifestRecord.enabledByDefault,
        activationSource,
      });
      const entry = normalized.entries[pluginId];
      const record = createPluginRecord({
        id: pluginId,
        name: manifestRecord.name ?? pluginId,
        description: manifestRecord.description,
        version: manifestRecord.version,
        format: manifestRecord.format,
        bundleFormat: manifestRecord.bundleFormat,
        bundleCapabilities: manifestRecord.bundleCapabilities,
        source: candidate.source,
        rootDir: candidate.rootDir,
        origin: candidate.origin,
        workspaceDir: candidate.workspaceDir,
        enabled: enableState.enabled,
        compat: collectPluginManifestCompatCodes(manifestRecord),
        activationState,
        syntheticAuthRefs: manifestRecord.syntheticAuthRefs,
        channelIds: manifestRecord.channels,
        providerIds: manifestRecord.providers,
        configSchema: Boolean(manifestRecord.configSchema),
        contracts: manifestRecord.contracts,
      });
      record.kind = manifestRecord.kind;
      record.configUiHints = manifestRecord.configUiHints;
      record.configJsonSchema = manifestRecord.configSchema;
      const pushPluginLoadError = (message: string) => {
        record.status = "error";
        record.error = message;
        record.failedAt = new Date();
        record.failurePhase = "validation";
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        registry.diagnostics.push({
          level: "error",
          pluginId: record.id,
          source: record.source,
          message: record.error,
        });
      };
      const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
      let runtimePluginRoot = pluginRoot;
      let runtimeCandidateSource =
        candidate.origin === "bundled" ? safeRealpathOrResolve(candidate.source) : candidate.source;
      let runtimeSetupSource =
        candidate.origin === "bundled" && manifestRecord.setupSource
          ? safeRealpathOrResolve(manifestRecord.setupSource)
          : manifestRecord.setupSource;

      const scopedSetupOnlyChannelPluginRequested =
        includeSetupOnlyChannelPlugins &&
        !validateOnly &&
        Boolean(onlyPluginIdSet) &&
        manifestRecord.channels.length > 0 &&
        (!enableState.enabled || forceSetupOnlyChannelPlugins);
      const canLoadScopedSetupOnlyChannelPlugin =
        scopedSetupOnlyChannelPluginRequested &&
        (!requireSetupEntryForSetupOnlyChannelPlugins || Boolean(manifestRecord.setupSource));
      const registrationPlan = resolvePluginRegistrationPlan({
        canLoadScopedSetupOnlyChannelPlugin,
        scopedSetupOnlyChannelPluginRequested,
        requireSetupEntryForSetupOnlyChannelPlugins,
        enableStateEnabled: enableState.enabled,
        shouldLoadModules,
        validateOnly,
        shouldActivate,
        manifestRecord,
        cfg,
        env,
        preferSetupRuntimeForChannelPlugins,
        toolDiscovery: options.toolDiscovery === true,
      });

      if (!registrationPlan) {
        record.status = "disabled";
        record.error = enableState.reason;
        markPluginActivationDisabled(record, enableState.reason);
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }
      const registrationMode = registrationPlan.mode;
      if (!enableState.enabled) {
        record.status = "disabled";
        record.error = enableState.reason;
        markPluginActivationDisabled(record, enableState.reason);
      }

      if (record.format === "bundle") {
        const unsupportedCapabilities = (record.bundleCapabilities ?? []).filter(
          (capability) =>
            capability !== "skills" &&
            capability !== "mcpServers" &&
            capability !== "settings" &&
            !(
              (capability === "commands" ||
                capability === "agents" ||
                capability === "outputStyles" ||
                capability === "lspServers") &&
              (record.bundleFormat === "claude" || record.bundleFormat === "cursor")
            ) &&
            !(
              capability === "hooks" &&
              (record.bundleFormat === "codex" || record.bundleFormat === "claude")
            ),
        );
        for (const capability of unsupportedCapabilities) {
          registry.diagnostics.push({
            level: "warn",
            pluginId: record.id,
            source: record.source,
            message: `bundle capability detected but not wired into OpenClaw yet: ${capability}`,
          });
        }
        if (
          enableState.enabled &&
          record.rootDir &&
          record.bundleFormat &&
          (record.bundleCapabilities ?? []).includes("mcpServers")
        ) {
          const runtimeSupport = inspectBundleMcpRuntimeSupport({
            pluginId: record.id,
            rootDir: record.rootDir,
            bundleFormat: record.bundleFormat,
          });
          for (const message of runtimeSupport.diagnostics) {
            registry.diagnostics.push({
              level: "warn",
              pluginId: record.id,
              source: record.source,
              message,
            });
          }
          if (runtimeSupport.unsupportedServerNames.length > 0) {
            registry.diagnostics.push({
              level: "warn",
              pluginId: record.id,
              source: record.source,
              message:
                "bundle MCP servers use unsupported transports or incomplete configs " +
                `(stdio only today): ${runtimeSupport.unsupportedServerNames.join(", ")}`,
            });
          }
        }
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }
      // Fast-path bundled memory plugins that are guaranteed disabled by slot policy.
      // This avoids opening/importing heavy memory plugin modules that will never register.
      // Exception: the dreaming engine (memory-core by default) must load alongside the
      // selected memory slot plugin so dreaming can run even when lancedb holds the slot.
      if (
        registrationPlan.runRuntimeCapabilityPolicy &&
        candidate.origin === "bundled" &&
        hasKind(manifestRecord.kind, "memory")
      ) {
        if (pluginId !== dreamingEngineId) {
          const earlyMemoryDecision = resolveMemorySlotDecision({
            id: record.id,
            kind: manifestRecord.kind,
            slot: memorySlot,
            selectedId: selectedMemoryPluginId,
          });
          if (!earlyMemoryDecision.enabled) {
            record.enabled = false;
            record.status = "disabled";
            record.error = earlyMemoryDecision.reason;
            markPluginActivationDisabled(record, earlyMemoryDecision.reason);
            registry.plugins.push(record);
            seenIds.set(pluginId, candidate.origin);
            continue;
          }
        }
      }

      if (!manifestRecord.configSchema) {
        pushPluginLoadError("missing config schema");
        continue;
      }

      if (!shouldLoadModules && registrationPlan.runRuntimeCapabilityPolicy) {
        const memoryDecision = resolveMemorySlotDecision({
          id: record.id,
          kind: record.kind,
          slot: memorySlot,
          selectedId: selectedMemoryPluginId,
        });

        if (!memoryDecision.enabled && pluginId !== dreamingEngineId) {
          record.enabled = false;
          record.status = "disabled";
          record.error = memoryDecision.reason;
          markPluginActivationDisabled(record, memoryDecision.reason);
          registry.plugins.push(record);
          seenIds.set(pluginId, candidate.origin);
          continue;
        }

        if (memoryDecision.selected && hasKind(record.kind, "memory")) {
          selectedMemoryPluginId = record.id;
          memorySlotMatched = true;
          record.memorySlotSelected = true;
        }
      }

      const validatedConfig = validatePluginConfig({
        schema: manifestRecord.configSchema,
        cacheKey: manifestRecord.schemaCacheKey,
        value: entry?.config,
      });

      if (!validatedConfig.ok) {
        logger.error(
          `[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`,
        );
        pushPluginLoadError(`invalid config: ${validatedConfig.errors?.join(", ")}`);
        continue;
      }

      if (!shouldLoadModules) {
        applyManifestSnapshotMetadata(record, manifestRecord);
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }

      const loadSource =
        registrationPlan.loadSetupEntry && runtimeSetupSource
          ? runtimeSetupSource
          : runtimeCandidateSource;
      const moduleLoadSource = resolveCanonicalDistRuntimeSource(loadSource);
      const moduleRoot = resolveCanonicalDistRuntimeSource(runtimePluginRoot);
      const opened = openBoundaryFileSync({
        absolutePath: moduleLoadSource,
        rootPath: moduleRoot,
        boundaryLabel: "plugin root",
        rejectHardlinks: candidate.origin !== "bundled",
        skipLexicalRootCheck: true,
      });
      if (!opened.ok) {
        pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
        continue;
      }
      const safeSource = opened.path;
      fs.closeSync(opened.fd);

      let mod: OpenClawPluginModule | null = null;
      try {
        // Track the plugin as imported once module evaluation begins. Top-level
        // code may have already executed even if evaluation later throws.
        recordImportedPluginId(record.id);
        pluginLoadAttemptCount++;
        logger.debug?.(`[plugins] loading ${record.id} from ${safeSource}`);
        mod = withProfile(
          { pluginId: record.id, source: safeSource },
          registrationMode,
          () => loadPluginModule(safeSource) as OpenClawPluginModule,
        );
      } catch (err) {
        recordPluginError({
          logger,
          registry,
          record,
          seenIds,
          pluginId,
          origin: candidate.origin,
          phase: "load",
          error: err,
          logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
          diagnosticMessagePrefix: "failed to load plugin: ",
        });
        continue;
      }

      if (registrationPlan.loadSetupEntry && manifestRecord.setupSource) {
        const setupRegistration = resolveSetupChannelRegistration(mod);
        if (setupRegistration.loadError) {
          recordPluginError({
            logger,
            registry,
            record,
            seenIds,
            pluginId,
            origin: candidate.origin,
            phase: "load",
            error: setupRegistration.loadError,
            logPrefix: `[plugins] ${record.id} failed to load setup entry from ${record.source}: `,
            diagnosticMessagePrefix: "failed to load setup entry: ",
          });
          continue;
        }
        if (setupRegistration.plugin) {
          if (
            !channelPluginIdBelongsToManifest({
              channelId: setupRegistration.plugin.id,
              pluginId: record.id,
              manifestChannels: manifestRecord.channels,
            })
          ) {
            pushPluginLoadError(
              `plugin id mismatch (config uses "${record.id}", setup export uses "${setupRegistration.plugin.id}")`,
            );
            continue;
          }
          const api = createApi(record, {
            config: cfg,
            pluginConfig: {},
            hookPolicy: entry?.hooks,
            registrationMode,
          });
          let mergedSetupRegistration = setupRegistration;
          let runtimeSetterApplied = false;
          if (
            registrationPlan.loadSetupRuntimeEntry &&
            setupRegistration.usesBundledSetupContract &&
            runtimeCandidateSource !== safeSource
          ) {
            const runtimeOpened = openBoundaryFileSync({
              absolutePath: runtimeCandidateSource,
              rootPath: runtimePluginRoot,
              boundaryLabel: "plugin root",
              rejectHardlinks: candidate.origin !== "bundled",
              skipLexicalRootCheck: true,
            });
            if (!runtimeOpened.ok) {
              pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
              continue;
            }
            const safeRuntimeSource = runtimeOpened.path;
            fs.closeSync(runtimeOpened.fd);
            let runtimeMod: OpenClawPluginModule | null = null;
            try {
              runtimeMod = withProfile(
                { pluginId: record.id, source: safeRuntimeSource },
                "load-setup-runtime-entry",
                () => loadPluginModule(safeRuntimeSource) as OpenClawPluginModule,
              );
            } catch (err) {
              recordPluginError({
                logger,
                registry,
                record,
                seenIds,
                pluginId,
                origin: candidate.origin,
                phase: "load",
                error: err,
                logPrefix: `[plugins] ${record.id} failed to load setup-runtime entry from ${record.source}: `,
                diagnosticMessagePrefix: "failed to load setup-runtime entry: ",
              });
              continue;
            }
            const runtimeRegistration = resolveBundledRuntimeChannelRegistration(runtimeMod);
            if (runtimeRegistration.id && runtimeRegistration.id !== record.id) {
              pushPluginLoadError(
                `plugin id mismatch (config uses "${record.id}", runtime entry uses "${runtimeRegistration.id}")`,
              );
              continue;
            }
            if (runtimeRegistration.setChannelRuntime) {
              try {
                runtimeRegistration.setChannelRuntime(api.runtime);
                runtimeSetterApplied = true;
              } catch (err) {
                recordPluginError({
                  logger,
                  registry,
                  record,
                  seenIds,
                  pluginId,
                  origin: candidate.origin,
                  phase: "load",
                  error: err,
                  logPrefix: `[plugins] ${record.id} failed to apply setup-runtime channel runtime from ${record.source}: `,
                  diagnosticMessagePrefix: "failed to apply setup-runtime channel runtime: ",
                });
                continue;
              }
            }
            const runtimePluginRegistration = loadBundledRuntimeChannelPlugin({
              registration: runtimeRegistration,
            });
            if (runtimePluginRegistration.loadError) {
              recordPluginError({
                logger,
                registry,
                record,
                seenIds,
                pluginId,
                origin: candidate.origin,
                phase: "load",
                error: runtimePluginRegistration.loadError,
                logPrefix: `[plugins] ${record.id} failed to load setup-runtime channel entry from ${record.source}: `,
                diagnosticMessagePrefix: "failed to load setup-runtime channel entry: ",
              });
              continue;
            }
            if (runtimePluginRegistration.plugin) {
              if (
                runtimePluginRegistration.plugin.id &&
                runtimePluginRegistration.plugin.id !== record.id
              ) {
                pushPluginLoadError(
                  `plugin id mismatch (config uses "${record.id}", runtime export uses "${runtimePluginRegistration.plugin.id}")`,
                );
                continue;
              }
              mergedSetupRegistration = {
                ...setupRegistration,
                plugin: mergeSetupRuntimeChannelPlugin(
                  runtimePluginRegistration.plugin,
                  setupRegistration.plugin,
                ),
                setChannelRuntime:
                  runtimeRegistration.setChannelRuntime ?? setupRegistration.setChannelRuntime,
              };
            }
          }
          const mergedSetupPlugin = mergedSetupRegistration.plugin;
          if (!mergedSetupPlugin) {
            continue;
          }
          if (
            !channelPluginIdBelongsToManifest({
              channelId: mergedSetupPlugin.id,
              pluginId: record.id,
              manifestChannels: manifestRecord.channels,
            })
          ) {
            pushPluginLoadError(
              `plugin id mismatch (config uses "${record.id}", setup export uses "${mergedSetupPlugin.id}")`,
            );
            continue;
          }
          if (!runtimeSetterApplied) {
            try {
              mergedSetupRegistration.setChannelRuntime?.(api.runtime);
            } catch (err) {
              recordPluginError({
                logger,
                registry,
                record,
                seenIds,
                pluginId,
                origin: candidate.origin,
                phase: "load",
                error: err,
                logPrefix: `[plugins] ${record.id} failed to apply setup channel runtime from ${record.source}: `,
                diagnosticMessagePrefix: "failed to apply setup channel runtime: ",
              });
              continue;
            }
          }
          api.registerChannel(mergedSetupPlugin);
          registry.plugins.push(record);
          seenIds.set(pluginId, candidate.origin);
          continue;
        }
      }

      const resolved = resolvePluginModuleExport(mod);
      const definition = resolved.definition;
      const register = resolved.register;

      if (definition?.id && definition.id !== record.id) {
        pushPluginLoadError(
          `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
        );
        continue;
      }

      record.name = definition?.name ?? record.name;
      record.description = definition?.description ?? record.description;
      record.version = definition?.version ?? record.version;
      const manifestKind = record.kind;
      const exportKind = definition?.kind;
      if (manifestKind && exportKind && !kindsEqual(manifestKind, exportKind)) {
        registry.diagnostics.push({
          level: "warn",
          pluginId: record.id,
          source: record.source,
          message: `plugin kind mismatch (manifest uses "${String(manifestKind)}", export uses "${String(exportKind)}")`,
        });
      }
      record.kind = definition?.kind ?? record.kind;

      if (hasKind(record.kind, "memory") && memorySlot === record.id) {
        memorySlotMatched = true;
      }

      if (registrationPlan.runRuntimeCapabilityPolicy) {
        if (pluginId !== dreamingEngineId) {
          const memoryDecision = resolveMemorySlotDecision({
            id: record.id,
            kind: record.kind,
            slot: memorySlot,
            selectedId: selectedMemoryPluginId,
          });

          if (!memoryDecision.enabled) {
            record.enabled = false;
            record.status = "disabled";
            record.error = memoryDecision.reason;
            markPluginActivationDisabled(record, memoryDecision.reason);
            registry.plugins.push(record);
            seenIds.set(pluginId, candidate.origin);
            continue;
          }

          if (memoryDecision.selected && hasKind(record.kind, "memory")) {
            selectedMemoryPluginId = record.id;
            record.memorySlotSelected = true;
          }
        }
      }

      if (registrationPlan.runFullActivationOnlyRegistrations) {
        if (definition?.reload) {
          registerReload(record, definition.reload);
        }
        for (const nodeHostCommand of definition?.nodeHostCommands ?? []) {
          registerNodeHostCommand(record, nodeHostCommand);
        }
        for (const collector of definition?.securityAuditCollectors ?? []) {
          registerSecurityAuditCollector(record, collector);
        }
      }

      if (validateOnly) {
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }

      if (typeof register !== "function") {
        logger.error(`[plugins] ${record.id} missing register/activate export`);
        pushPluginLoadError(formatMissingPluginRegisterError(mod, env));
        continue;
      }

      const api = createApi(record, {
        config: cfg,
        pluginConfig: validatedConfig.value,
        hookPolicy: entry?.hooks,
        registrationMode,
      });
      const registrySnapshot = snapshotPluginRegistry(registry);
      const previousAgentHarnesses = listRegisteredAgentHarnesses();
      const previousCompactionProviders = listRegisteredCompactionProviders();
      const previousDetachedTaskRuntimeRegistration = getDetachedTaskLifecycleRuntimeRegistration();
      const previousMemoryCapability = getMemoryCapabilityRegistration();
      const previousMemoryEmbeddingProviders = listRegisteredMemoryEmbeddingProviders();
      const previousMemoryFlushPlanResolver = getMemoryFlushPlanResolver();
      const previousMemoryPromptBuilder = getMemoryPromptSectionBuilder();
      const previousMemoryCorpusSupplements = listMemoryCorpusSupplements();
      const previousMemoryPromptSupplements = listMemoryPromptSupplements();
      const previousMemoryRuntime = getMemoryRuntime();

      try {
        withProfile(
          { pluginId: record.id, source: record.source },
          `${registrationMode}:register`,
          () => runPluginRegisterSync(register, api),
        );
        // Snapshot loads should not replace process-global runtime prompt state.
        if (!shouldActivate) {
          restoreRegisteredAgentHarnesses(previousAgentHarnesses);
          restoreRegisteredCompactionProviders(previousCompactionProviders);
          restoreDetachedTaskLifecycleRuntimeRegistration(previousDetachedTaskRuntimeRegistration);
          restoreRegisteredMemoryEmbeddingProviders(previousMemoryEmbeddingProviders);
          restoreMemoryPluginState({
            capability: previousMemoryCapability,
            corpusSupplements: previousMemoryCorpusSupplements,
            promptBuilder: previousMemoryPromptBuilder,
            promptSupplements: previousMemoryPromptSupplements,
            flushPlanResolver: previousMemoryFlushPlanResolver,
            runtime: previousMemoryRuntime,
          });
        }
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
      } catch (err) {
        rollbackPluginGlobalSideEffects(record.id);
        restorePluginRegistry(registry, registrySnapshot);
        restoreRegisteredAgentHarnesses(previousAgentHarnesses);
        restoreRegisteredCompactionProviders(previousCompactionProviders);
        restoreDetachedTaskLifecycleRuntimeRegistration(previousDetachedTaskRuntimeRegistration);
        restoreRegisteredMemoryEmbeddingProviders(previousMemoryEmbeddingProviders);
        restoreMemoryPluginState({
          capability: previousMemoryCapability,
          corpusSupplements: previousMemoryCorpusSupplements,
          promptBuilder: previousMemoryPromptBuilder,
          promptSupplements: previousMemoryPromptSupplements,
          flushPlanResolver: previousMemoryFlushPlanResolver,
          runtime: previousMemoryRuntime,
        });
        recordPluginError({
          logger,
          registry,
          record,
          seenIds,
          pluginId,
          origin: candidate.origin,
          phase: "register",
          error: err,
          logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
          diagnosticMessagePrefix: "plugin failed during register: ",
        });
      }
    }

    const pluginLoadElapsedMs = performance.now() - pluginLoadStartMs;
    if (pluginLoadAttemptCount > 0) {
      logger.debug?.(
        `[plugins] loaded ${registry.plugins.length} plugin(s) (${pluginLoadAttemptCount} attempted) in ${pluginLoadElapsedMs.toFixed(1)}ms`,
      );
    }

    // Scoped snapshot loads may intentionally omit the configured memory plugin, so only
    // emit the missing-memory diagnostic for full registry loads.
    if (!onlyPluginIdSet && typeof memorySlot === "string" && !memorySlotMatched) {
      registry.diagnostics.push({
        level: "warn",
        message: `memory slot plugin not found or not marked as memory: ${memorySlot}`,
      });
    }

    warnAboutUntrackedLoadedPlugins({
      registry,
      provenance,
      allowlist: normalized.allow,
      emitWarning: shouldActivate,
      logger,
      env,
    });

    maybeThrowOnPluginLoadError(registry, options.throwOnLoadError);

    if (shouldActivate && options.mode !== "validate") {
      const failedPlugins = registry.plugins.filter((plugin) => plugin.failedAt != null);
      if (failedPlugins.length > 0) {
        logger.warn(
          `[plugins] ${failedPlugins.length} plugin(s) failed to initialize (${formatPluginFailureSummary(
            failedPlugins,
          )}). Run 'openclaw plugins list' for details.`,
        );
      }
    }

    if (cacheEnabled) {
      setCachedPluginRegistry(
        cacheKey,
        {
          commands: listRegisteredPluginCommands(),
          detachedTaskRuntimeRegistration: getDetachedTaskLifecycleRuntimeRegistration(),
          interactiveHandlers: listPluginInteractiveHandlers(),
          memoryCapability: getMemoryCapabilityRegistration(),
          memoryCorpusSupplements: listMemoryCorpusSupplements(),
          registry,
          agentHarnesses: listRegisteredAgentHarnesses(),
          compactionProviders: listRegisteredCompactionProviders(),
          memoryEmbeddingProviders: listRegisteredMemoryEmbeddingProviders(),
          memoryFlushPlanResolver: getMemoryFlushPlanResolver(),
          memoryPromptBuilder: getMemoryPromptSectionBuilder(),
          memoryPromptSupplements: listMemoryPromptSupplements(),
          memoryRuntime: getMemoryRuntime(),
        },
        onlyPluginIds,
      );
    }
    if (shouldActivate) {
      activatePluginRegistry(registry, cacheKey, runtimeSubagentMode, options.workspaceDir);
    }
    return registry;
  } finally {
    pluginLoaderCacheState.finishLoad(cacheKey);
  }
}

export async function loadOpenClawPluginCliRegistry(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  const {
    env,
    cfg,
    normalized,
    activationSource,
    autoEnabledReasons,
    onlyPluginIds,
    cacheKey,
    installRecords,
  } = resolvePluginLoadCacheContext({
    ...options,
    activate: false,
  });
  const logger = options.logger ?? defaultLogger();
  const onlyPluginIdSet = createPluginIdScopeSet(onlyPluginIds);
  const loadPluginModule = createPluginModuleLoader(options);
  const { registry, registerCli } = createPluginRegistry({
    logger,
    runtime: {} as PluginRuntime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
    ...(options.coreGatewayMethodNames !== undefined && {
      coreGatewayMethodNames: options.coreGatewayMethodNames,
    }),
    activateGlobalSideEffects: false,
  });

  const discovery = discoverOpenClawPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
    env,
    installRecords,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
    installRecords: Object.keys(installRecords).length > 0 ? installRecords : undefined,
  });
  pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
  warnWhenAllowlistIsOpen({
    emitWarning: false,
    logger,
    pluginsEnabled: normalized.enabled,
    allow: normalized.allow,
    warningCacheKey: `${cacheKey}::cli-metadata`,
    warningCache: pluginLoaderCacheState,
    discoverablePlugins: manifestRegistry.plugins
      .filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id))
      .map((plugin) => ({
        id: plugin.id,
        source: plugin.source,
        origin: plugin.origin,
      })),
  });
  const provenance = buildProvenanceIndex({
    normalizedLoadPaths: normalized.loadPaths,
    env,
  });
  const manifestByRoot = new Map(
    manifestRegistry.plugins.map((record) => [record.rootDir, record]),
  );
  const orderedCandidates = [...discovery.candidates].toSorted((left, right) => {
    return compareDuplicateCandidateOrder({
      left,
      right,
      manifestByRoot,
      provenance,
      env,
    });
  });

  const seenIds = new Map<string, PluginRecord["origin"]>();
  const memorySlot = normalized.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  const dreamingEngineId = resolveDreamingSidecarEngineId({ cfg, memorySlot });

  for (const candidate of orderedCandidates) {
    const manifestRecord = manifestByRoot.get(candidate.rootDir);
    if (!manifestRecord) {
      continue;
    }
    const pluginId = manifestRecord.id;
    if (
      !matchesScopedPluginRequest({
        onlyPluginIdSet,
        pluginId,
      })
    ) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: pluginId,
      origin: candidate.origin,
      config: normalized,
      rootConfig: cfg,
      enabledByDefault: manifestRecord.enabledByDefault,
      activationSource,
      autoEnabledReason: formatAutoEnabledActivationReason(autoEnabledReasons[pluginId]),
    });
    const existingOrigin = seenIds.get(pluginId);
    if (existingOrigin) {
      const record = createPluginRecord({
        id: pluginId,
        name: manifestRecord.name ?? pluginId,
        description: manifestRecord.description,
        version: manifestRecord.version,
        format: manifestRecord.format,
        bundleFormat: manifestRecord.bundleFormat,
        bundleCapabilities: manifestRecord.bundleCapabilities,
        source: candidate.source,
        rootDir: candidate.rootDir,
        origin: candidate.origin,
        workspaceDir: candidate.workspaceDir,
        enabled: false,
        compat: collectPluginManifestCompatCodes(manifestRecord),
        activationState,
        syntheticAuthRefs: manifestRecord.syntheticAuthRefs,
        channelIds: manifestRecord.channels,
        providerIds: manifestRecord.providers,
        configSchema: Boolean(manifestRecord.configSchema),
        contracts: manifestRecord.contracts,
      });
      record.status = "disabled";
      record.error = `overridden by ${existingOrigin} plugin`;
      markPluginActivationDisabled(record, record.error);
      registry.plugins.push(record);
      continue;
    }

    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: candidate.origin,
      config: normalized,
      rootConfig: cfg,
      enabledByDefault: manifestRecord.enabledByDefault,
      activationSource,
    });
    const entry = normalized.entries[pluginId];
    const record = createPluginRecord({
      id: pluginId,
      name: manifestRecord.name ?? pluginId,
      description: manifestRecord.description,
      version: manifestRecord.version,
      format: manifestRecord.format,
      bundleFormat: manifestRecord.bundleFormat,
      bundleCapabilities: manifestRecord.bundleCapabilities,
      source: candidate.source,
      rootDir: candidate.rootDir,
      origin: candidate.origin,
      workspaceDir: candidate.workspaceDir,
      enabled: enableState.enabled,
      compat: collectPluginManifestCompatCodes(manifestRecord),
      activationState,
      syntheticAuthRefs: manifestRecord.syntheticAuthRefs,
      channelIds: manifestRecord.channels,
      providerIds: manifestRecord.providers,
      configSchema: Boolean(manifestRecord.configSchema),
      contracts: manifestRecord.contracts,
    });
    record.kind = manifestRecord.kind;
    record.configUiHints = manifestRecord.configUiHints;
    record.configJsonSchema = manifestRecord.configSchema;
    const pushPluginLoadError = (message: string) => {
      record.status = "error";
      record.error = message;
      record.failedAt = new Date();
      record.failurePhase = "validation";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      registry.diagnostics.push({
        level: "error",
        pluginId: record.id,
        source: record.source,
        message: record.error,
      });
    };

    if (!enableState.enabled) {
      record.status = "disabled";
      record.error = enableState.reason;
      markPluginActivationDisabled(record, enableState.reason);
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (record.format === "bundle") {
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }

    if (!manifestRecord.configSchema) {
      pushPluginLoadError("missing config schema");
      continue;
    }

    const validatedConfig = validatePluginConfig({
      schema: manifestRecord.configSchema,
      cacheKey: manifestRecord.schemaCacheKey,
      value: entry?.config,
    });
    if (!validatedConfig.ok) {
      logger.error(`[plugins] ${record.id} invalid config: ${validatedConfig.errors?.join(", ")}`);
      pushPluginLoadError(`invalid config: ${validatedConfig.errors?.join(", ")}`);
      continue;
    }

    const pluginRoot = safeRealpathOrResolve(candidate.rootDir);
    const cliMetadataSource = resolveCliMetadataEntrySource(candidate.rootDir);
    const sourceForCliMetadata =
      candidate.origin === "bundled"
        ? cliMetadataSource
          ? safeRealpathOrResolve(cliMetadataSource)
          : null
        : (cliMetadataSource ?? candidate.source);
    if (!sourceForCliMetadata) {
      record.status = "loaded";
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
      continue;
    }
    const opened = openBoundaryFileSync({
      absolutePath: sourceForCliMetadata,
      rootPath: pluginRoot,
      boundaryLabel: "plugin root",
      rejectHardlinks: candidate.origin !== "bundled",
      skipLexicalRootCheck: true,
    });
    if (!opened.ok) {
      pushPluginLoadError("plugin entry path escapes plugin root or fails alias checks");
      continue;
    }
    const safeSource = opened.path;
    fs.closeSync(opened.fd);

    let mod: OpenClawPluginModule | null = null;
    try {
      mod = withProfile(
        { pluginId: record.id, source: safeSource },
        "cli-metadata",
        () => loadPluginModule(safeSource) as OpenClawPluginModule,
      );
    } catch (err) {
      recordPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        phase: "load",
        error: err,
        logPrefix: `[plugins] ${record.id} failed to load from ${record.source}: `,
        diagnosticMessagePrefix: "failed to load plugin: ",
      });
      continue;
    }

    const resolved = resolvePluginModuleExport(mod);
    const definition = resolved.definition;
    const register = resolved.register;

    if (definition?.id && definition.id !== record.id) {
      pushPluginLoadError(
        `plugin id mismatch (config uses "${record.id}", export uses "${definition.id}")`,
      );
      continue;
    }

    record.name = definition?.name ?? record.name;
    record.description = definition?.description ?? record.description;
    record.version = definition?.version ?? record.version;
    const manifestKind = record.kind;
    const exportKind = definition?.kind;
    if (manifestKind && exportKind && !kindsEqual(manifestKind, exportKind)) {
      registry.diagnostics.push({
        level: "warn",
        pluginId: record.id,
        source: record.source,
        message: `plugin kind mismatch (manifest uses "${String(manifestKind)}", export uses "${String(exportKind)}")`,
      });
    }
    record.kind = definition?.kind ?? record.kind;

    if (pluginId !== dreamingEngineId) {
      const memoryDecision = resolveMemorySlotDecision({
        id: record.id,
        kind: record.kind,
        slot: memorySlot,
        selectedId: selectedMemoryPluginId,
      });
      if (!memoryDecision.enabled) {
        record.enabled = false;
        record.status = "disabled";
        record.error = memoryDecision.reason;
        markPluginActivationDisabled(record, memoryDecision.reason);
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }
      if (memoryDecision.selected && hasKind(record.kind, "memory")) {
        selectedMemoryPluginId = record.id;
        record.memorySlotSelected = true;
      }
    }

    if (typeof register !== "function") {
      logger.error(`[plugins] ${record.id} missing register/activate export`);
      pushPluginLoadError(formatMissingPluginRegisterError(mod, env));
      continue;
    }

    const api = buildPluginApi({
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description,
      source: record.source,
      rootDir: record.rootDir,
      registrationMode: "cli-metadata",
      config: cfg,
      pluginConfig: validatedConfig.value,
      runtime: {} as PluginRuntime,
      logger,
      resolvePath: (input) => resolveUserPath(input),
      handlers: {
        registerCli: (registrar, opts) => registerCli(record, registrar, opts),
      },
    });

    const registrySnapshot = snapshotPluginRegistry(registry);
    try {
      withProfile({ pluginId: record.id, source: record.source }, "cli-metadata:register", () =>
        runPluginRegisterSync(register, api),
      );
      registry.plugins.push(record);
      seenIds.set(pluginId, candidate.origin);
    } catch (err) {
      restorePluginRegistry(registry, registrySnapshot);
      recordPluginError({
        logger,
        registry,
        record,
        seenIds,
        pluginId,
        origin: candidate.origin,
        phase: "register",
        error: err,
        logPrefix: `[plugins] ${record.id} failed during register from ${record.source}: `,
        diagnosticMessagePrefix: "plugin failed during register: ",
      });
    }
  }

  return registry;
}

function safeRealpathOrResolve(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function resolveCliMetadataEntrySource(rootDir: string): string | null {
  for (const basename of CLI_METADATA_ENTRY_BASENAMES) {
    const candidate = path.join(rootDir, basename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
