import { createHash } from "node:crypto";
import fs from "node:fs";
import { Module } from "node:module";
import path from "node:path";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  restoreRegisteredAgentHarnesses,
} from "../agents/harness/registry.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { isChannelConfigured } from "../config/channel-configured.js";
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
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
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
  ensureBundledPluginRuntimeDeps,
  resolveBundledRuntimeDependencyInstallRoot,
  type BundledRuntimeDepsInstallParams,
} from "./bundled-runtime-deps.js";
import { clearPluginCommands } from "./command-registry-state.js";
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
  type PluginActivationState,
} from "./config-state.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { initializeGlobalHookRunner } from "./hook-runner-global.js";
import { clearPluginInteractiveHandlers } from "./interactive-registry.js";
import { getCachedPluginJitiLoader, type PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginBundleFormat, PluginDiagnostic, PluginFormat } from "./manifest-types.js";
import type { PluginManifestContracts } from "./manifest.js";
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
import { isPathInside, safeStatSync } from "./path-safety.js";
import { withProfile } from "./plugin-load-profile.js";
import {
  createPluginIdScopeSet,
  hasExplicitPluginIdScope,
  normalizePluginIdScope,
  serializePluginIdScope,
} from "./plugin-scope.js";
import { createPluginRegistry, type PluginRecord, type PluginRegistry } from "./registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
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
  shouldPreferNativeJiti,
} from "./sdk-alias.js";
import { hasKind, kindsEqual } from "./slots.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginDefinition,
  OpenClawPluginModule,
  PluginLogger,
} from "./types.js";

export type PluginLoadResult = PluginRegistry;

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
  activate?: boolean;
  loadModules?: boolean;
  throwOnLoadError?: boolean;
  bundledRuntimeDepsInstaller?: (params: BundledRuntimeDepsInstallParams) => void;
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

export class PluginLoadReentryError extends Error {
  readonly cacheKey: string;

  constructor(cacheKey: string) {
    super(`plugin load reentry detected for cache key: ${cacheKey}`);
    this.name = "PluginLoadReentryError";
    this.cacheKey = cacheKey;
  }
}

type CachedPluginState = {
  registry: PluginRegistry;
  detachedTaskRuntimeRegistration: ReturnType<typeof getDetachedTaskLifecycleRuntimeRegistration>;
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
let pluginRegistryCacheEntryCap = MAX_PLUGIN_REGISTRY_CACHE_ENTRIES;
const registryCache = new Map<string, CachedPluginState>();
const inFlightPluginRegistryLoads = new Set<string>();
const openAllowlistWarningCache = new Set<string>();
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

export function clearPluginLoaderCache(): void {
  registryCache.clear();
  inFlightPluginRegistryLoads.clear();
  openAllowlistWarningCache.clear();
  clearBundledRuntimeDependencyNodePaths();
  clearAgentHarnesses();
  clearCompactionProviders();
  clearDetachedTaskLifecycleRuntimeRegistration();
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
    embeddedExtensionFactories: PluginRegistry["embeddedExtensionFactories"];
    codexAppServerExtensionFactories: PluginRegistry["codexAppServerExtensionFactories"];
    memoryEmbeddingProviders: PluginRegistry["memoryEmbeddingProviders"];
    agentHarnesses: PluginRegistry["agentHarnesses"];
    httpRoutes: PluginRegistry["httpRoutes"];
    cliRegistrars: PluginRegistry["cliRegistrars"];
    reloads: NonNullable<PluginRegistry["reloads"]>;
    nodeHostCommands: NonNullable<PluginRegistry["nodeHostCommands"]>;
    securityAuditCollectors: NonNullable<PluginRegistry["securityAuditCollectors"]>;
    services: PluginRegistry["services"];
    commands: PluginRegistry["commands"];
    conversationBindingResolvedHandlers: PluginRegistry["conversationBindingResolvedHandlers"];
    diagnostics: PluginRegistry["diagnostics"];
  };
  gatewayHandlers: PluginRegistry["gatewayHandlers"];
  gatewayMethodScopes: NonNullable<PluginRegistry["gatewayMethodScopes"]>;
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
      embeddedExtensionFactories: [...registry.embeddedExtensionFactories],
      codexAppServerExtensionFactories: [...registry.codexAppServerExtensionFactories],
      memoryEmbeddingProviders: [...registry.memoryEmbeddingProviders],
      agentHarnesses: [...registry.agentHarnesses],
      httpRoutes: [...registry.httpRoutes],
      cliRegistrars: [...registry.cliRegistrars],
      reloads: [...(registry.reloads ?? [])],
      nodeHostCommands: [...(registry.nodeHostCommands ?? [])],
      securityAuditCollectors: [...(registry.securityAuditCollectors ?? [])],
      services: [...registry.services],
      commands: [...registry.commands],
      conversationBindingResolvedHandlers: [...registry.conversationBindingResolvedHandlers],
      diagnostics: [...registry.diagnostics],
    },
    gatewayHandlers: { ...registry.gatewayHandlers },
    gatewayMethodScopes: { ...registry.gatewayMethodScopes },
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
  registry.embeddedExtensionFactories = snapshot.arrays.embeddedExtensionFactories;
  registry.codexAppServerExtensionFactories = snapshot.arrays.codexAppServerExtensionFactories;
  registry.memoryEmbeddingProviders = snapshot.arrays.memoryEmbeddingProviders;
  registry.agentHarnesses = snapshot.arrays.agentHarnesses;
  registry.httpRoutes = snapshot.arrays.httpRoutes;
  registry.cliRegistrars = snapshot.arrays.cliRegistrars;
  registry.reloads = snapshot.arrays.reloads;
  registry.nodeHostCommands = snapshot.arrays.nodeHostCommands;
  registry.securityAuditCollectors = snapshot.arrays.securityAuditCollectors;
  registry.services = snapshot.arrays.services;
  registry.commands = snapshot.arrays.commands;
  registry.conversationBindingResolvedHandlers =
    snapshot.arrays.conversationBindingResolvedHandlers;
  registry.diagnostics = snapshot.arrays.diagnostics;
  registry.gatewayHandlers = snapshot.gatewayHandlers;
  registry.gatewayMethodScopes = snapshot.gatewayMethodScopes;
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

/**
 * On Windows, the Node.js ESM loader requires absolute paths to be expressed
 * as file:// URLs (e.g. file:///C:/Users/...). Raw drive-letter paths like
 * C:\... are rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME because the loader
 * mistakes the drive letter for an unknown URL scheme.
 *
 * This helper converts Windows absolute import specifiers to file:// URLs and
 * leaves everything else unchanged.
 */
function toSafeImportPath(specifier: string): string {
  if (process.platform !== "win32") {
    return specifier;
  }
  if (specifier.startsWith("file://")) {
    return specifier;
  }
  if (path.win32.isAbsolute(specifier)) {
    const normalizedSpecifier = specifier.replaceAll("\\", "/");
    if (normalizedSpecifier.startsWith("//")) {
      return new URL(`file:${encodeURI(normalizedSpecifier)}`).href;
    }
    return new URL(`file:///${encodeURI(normalizedSpecifier)}`).href;
  }
  return specifier;
}

function createPluginJitiLoader(options: Pick<PluginLoadOptions, "pluginSdkResolution">) {
  const jitiLoaders: PluginJitiLoaderCache = new Map();
  return (modulePath: string) => {
    const tryNative =
      shouldPreferNativeJiti(modulePath) && !isBundledRuntimeDependencyMirrorPath(modulePath);
    return getCachedPluginJitiLoader({
      cache: jitiLoaders,
      modulePath,
      importerUrl: import.meta.url,
      jitiFilename: modulePath,
      pluginSdkResolution: options.pluginSdkResolution,
      // Source .ts runtime shims import sibling ".js" specifiers that only exist
      // after build. Disable native loading for source entries so Jiti rewrites
      // those imports against the source graph, while keeping native dist/*.js
      // loading for the canonical built module graph.
      tryNative,
    });
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

const registeredBundledRuntimeDepNodePaths = new Set<string>();

function isBundledRuntimeDependencyMirrorPath(modulePath: string): boolean {
  const resolvedModulePath = path.resolve(modulePath);
  for (const nodeModulesDir of registeredBundledRuntimeDepNodePaths) {
    const installRoot = path.dirname(nodeModulesDir);
    if (
      resolvedModulePath === installRoot ||
      resolvedModulePath.startsWith(`${installRoot}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}

function registerBundledRuntimeDependencyNodePath(installRoot: string): void {
  const nodeModulesDir = path.join(installRoot, "node_modules");
  if (registeredBundledRuntimeDepNodePaths.has(nodeModulesDir) || !fs.existsSync(nodeModulesDir)) {
    return;
  }
  const currentPaths = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  process.env.NODE_PATH = [
    nodeModulesDir,
    ...currentPaths.filter((entry) => entry !== nodeModulesDir),
  ].join(path.delimiter);
  (Module as unknown as { _initPaths?: () => void })._initPaths?.();
  registeredBundledRuntimeDepNodePaths.add(nodeModulesDir);
}

function clearBundledRuntimeDependencyNodePaths(): void {
  if (registeredBundledRuntimeDepNodePaths.size === 0) {
    return;
  }
  const retainedPaths = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && !registeredBundledRuntimeDepNodePaths.has(entry));
  if (retainedPaths.length > 0) {
    process.env.NODE_PATH = retainedPaths.join(path.delimiter);
  } else {
    delete process.env.NODE_PATH;
  }
  registeredBundledRuntimeDepNodePaths.clear();
  (Module as unknown as { _initPaths?: () => void })._initPaths?.();
}

function mirrorBundledPluginRuntimeRoot(params: {
  pluginId: string;
  pluginRoot: string;
  installRoot: string;
}): string {
  const mirrorParent = prepareBundledPluginRuntimeDistMirror({
    installRoot: params.installRoot,
    pluginRoot: params.pluginRoot,
  });
  const mirrorRoot = path.join(mirrorParent, params.pluginId);
  fs.mkdirSync(params.installRoot, { recursive: true });
  try {
    fs.chmodSync(params.installRoot, 0o755);
  } catch {
    // Best-effort only: staged roots may live on filesystems that reject chmod.
  }
  fs.mkdirSync(mirrorParent, { recursive: true });
  try {
    fs.chmodSync(mirrorParent, 0o755);
  } catch {
    // Best-effort only: the access check below will surface non-writable dirs.
  }
  fs.accessSync(mirrorParent, fs.constants.W_OK);
  const tempDir = fs.mkdtempSync(path.join(mirrorParent, `.plugin-${params.pluginId}-`));
  const stagedRoot = path.join(tempDir, "plugin");
  try {
    copyBundledPluginRuntimeRoot(params.pluginRoot, stagedRoot);
    fs.rmSync(mirrorRoot, { recursive: true, force: true });
    fs.renameSync(stagedRoot, mirrorRoot);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return mirrorRoot;
}

function prepareBundledPluginRuntimeDistMirror(params: {
  installRoot: string;
  pluginRoot: string;
}): string {
  const sourceExtensionsRoot = path.dirname(params.pluginRoot);
  const sourceDistRoot = path.dirname(sourceExtensionsRoot);
  const sourceDistRootName = path.basename(sourceDistRoot);
  const mirrorDistRoot = path.join(params.installRoot, sourceDistRootName);
  const mirrorExtensionsRoot = path.join(mirrorDistRoot, "extensions");
  fs.mkdirSync(mirrorExtensionsRoot, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(sourceDistRoot, { withFileTypes: true })) {
    if (entry.name === "extensions") {
      continue;
    }
    const sourcePath = path.join(sourceDistRoot, entry.name);
    const targetPath = path.join(mirrorDistRoot, entry.name);
    if (fs.existsSync(targetPath)) {
      continue;
    }
    try {
      fs.symlinkSync(sourcePath, targetPath, entry.isDirectory() ? "junction" : "file");
    } catch {
      if (entry.isDirectory()) {
        copyBundledPluginRuntimeRoot(sourcePath, targetPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }
  if (sourceDistRootName === "dist-runtime") {
    const sourceCanonicalDistRoot = path.join(path.dirname(sourceDistRoot), "dist");
    const targetCanonicalDistRoot = path.join(params.installRoot, "dist");
    if (fs.existsSync(sourceCanonicalDistRoot)) {
      const targetMatchesSource =
        fs.existsSync(targetCanonicalDistRoot) &&
        safeRealpathOrResolve(targetCanonicalDistRoot) ===
          safeRealpathOrResolve(sourceCanonicalDistRoot);
      if (!targetMatchesSource) {
        fs.rmSync(targetCanonicalDistRoot, { recursive: true, force: true });
        try {
          fs.symlinkSync(sourceCanonicalDistRoot, targetCanonicalDistRoot, "junction");
        } catch {
          copyBundledPluginRuntimeRoot(sourceCanonicalDistRoot, targetCanonicalDistRoot);
        }
      }
    }
  }
  ensureOpenClawPluginSdkAlias(mirrorDistRoot);
  return mirrorExtensionsRoot;
}

function copyBundledPluginRuntimeRoot(sourceRoot: string, targetRoot: string): void {
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      copyBundledPluginRuntimeRoot(sourcePath, targetPath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
    try {
      const sourceMode = fs.statSync(sourcePath).mode;
      fs.chmodSync(targetPath, sourceMode | 0o600);
    } catch {
      // Readable copied files are enough for plugin loading.
    }
  }
}

function writeRuntimeJsonFile(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hasRuntimeDefaultExport(sourcePath: string): boolean {
  const text = fs.readFileSync(sourcePath, "utf8");
  return /\bexport\s+default\b/u.test(text) || /\bas\s+default\b/u.test(text);
}

function writeRuntimeModuleWrapper(sourcePath: string, targetPath: string): void {
  const specifier = path.relative(path.dirname(targetPath), sourcePath).replaceAll(path.sep, "/");
  const normalizedSpecifier = specifier.startsWith(".") ? specifier : `./${specifier}`;
  const defaultForwarder = hasRuntimeDefaultExport(sourcePath)
    ? [
        `import defaultModule from ${JSON.stringify(normalizedSpecifier)};`,
        `let defaultExport = defaultModule;`,
        `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
        `  defaultExport = defaultExport.default;`,
        `}`,
      ]
    : [
        `import * as module from ${JSON.stringify(normalizedSpecifier)};`,
        `let defaultExport = "default" in module ? module.default : module;`,
        `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
        `  defaultExport = defaultExport.default;`,
        `}`,
      ];
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    targetPath,
    [
      `export * from ${JSON.stringify(normalizedSpecifier)};`,
      ...defaultForwarder,
      "export { defaultExport as default };",
      "",
    ].join("\n"),
    "utf8",
  );
}

function ensureOpenClawPluginSdkAlias(distRoot: string): void {
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  if (!fs.existsSync(pluginSdkDir)) {
    return;
  }

  const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw");
  const pluginSdkAliasDir = path.join(aliasDir, "plugin-sdk");
  writeRuntimeJsonFile(path.join(aliasDir, "package.json"), {
    name: "openclaw",
    type: "module",
    exports: {
      "./plugin-sdk": "./plugin-sdk/index.js",
      "./plugin-sdk/*": "./plugin-sdk/*.js",
    },
  });
  fs.rmSync(pluginSdkAliasDir, { recursive: true, force: true });
  fs.mkdirSync(pluginSdkAliasDir, { recursive: true });
  for (const entry of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".js") {
      continue;
    }
    writeRuntimeModuleWrapper(
      path.join(pluginSdkDir, entry.name),
      path.join(pluginSdkAliasDir, entry.name),
    );
  }
}

function remapBundledPluginRuntimePath(params: {
  source: string | undefined;
  pluginRoot: string;
  mirroredRoot: string;
}): string | undefined {
  if (!params.source) {
    return undefined;
  }
  const relative = path.relative(params.pluginRoot, params.source);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return params.source;
  }
  return path.join(params.mirroredRoot, relative);
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
  shouldLoadChannelPluginInSetupRuntime,
  shouldPreferNativeJiti,
  toSafeImportPath,
  getCompatibleActivePluginRegistry,
  resolvePluginLoadCacheContext,
  get maxPluginRegistryCacheEntries() {
    return pluginRegistryCacheEntryCap;
  },
  setMaxPluginRegistryCacheEntriesForTest(value?: number) {
    pluginRegistryCacheEntryCap =
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.floor(value))
        : MAX_PLUGIN_REGISTRY_CACHE_ENTRIES;
  },
};

function getCachedPluginRegistry(cacheKey: string): CachedPluginState | undefined {
  const cached = registryCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  // Refresh insertion order so frequently reused registries survive eviction.
  registryCache.delete(cacheKey);
  registryCache.set(cacheKey, cached);
  return cached;
}

function setCachedPluginRegistry(cacheKey: string, state: CachedPluginState): void {
  if (registryCache.has(cacheKey)) {
    registryCache.delete(cacheKey);
  }
  registryCache.set(cacheKey, state);
  while (registryCache.size > pluginRegistryCacheEntryCap) {
    const oldestKey = registryCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    registryCache.delete(oldestKey);
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
  loadModules?: boolean;
  runtimeSubagentMode?: "default" | "explicit" | "gateway-bindable";
  pluginSdkResolution?: PluginSdkResolutionPreference;
  coreGatewayMethodNames?: string[];
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    loadPaths: params.plugins.loadPaths,
    env: params.env,
  });
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
  const runtimeSubagentMode = params.runtimeSubagentMode ?? "default";
  const gatewayMethodsKey = JSON.stringify(params.coreGatewayMethodNames ?? []);
  return `${roots.workspace ?? ""}::${roots.global ?? ""}::${roots.stock ?? ""}::${JSON.stringify({
    ...params.plugins,
    installs,
    loadPaths,
    activationMetadataKey: params.activationMetadataKey ?? "",
  })}::${scopeKey}::${setupOnlyKey}::${setupOnlyModeKey}::${setupOnlyRequirementKey}::${startupChannelMode}::${moduleLoadMode}::${runtimeSubagentMode}::${params.pluginSdkResolution ?? "auto"}::${gatewayMethodsKey}`;
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
  const coreGatewayMethodNames = Object.keys(options.coreGatewayHandlers ?? {}).toSorted();
  const cacheKey = buildCacheKey({
    workspaceDir: options.workspaceDir,
    plugins: trustNormalized,
    activationMetadataKey: buildActivationMetadataHash({
      activationSource,
      autoEnabledReasons: options.autoEnabledReasons ?? {},
    }),
    installs: cfg.plugins?.installs,
    env,
    onlyPluginIds,
    includeSetupOnlyChannelPlugins,
    forceSetupOnlyChannelPlugins,
    requireSetupEntryForSetupOnlyChannelPlugins,
    preferSetupRuntimeForChannelPlugins,
    loadModules: options.loadModules,
    runtimeSubagentMode,
    pluginSdkResolution: options.pluginSdkResolution,
    coreGatewayMethodNames,
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
  if (loadContext.cacheKey === activeCacheKey) {
    return activeRegistry;
  }
  if (
    loadContext.runtimeSubagentMode === "default" &&
    getActivePluginRuntimeSubagentMode() === "gateway-bindable"
  ) {
    const gatewayBindableCacheKey = resolvePluginLoadCacheContext({
      ...options,
      runtimeOptions: {
        ...options.runtimeOptions,
        allowGatewaySubagentBinding: true,
      },
    }).cacheKey;
    if (gatewayBindableCacheKey === activeCacheKey) {
      return activeRegistry;
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
  return inFlightPluginRegistryLoads.has(resolvePluginRegistryLoadCacheKey(options));
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

function isPluginLoadDebugEnabled(env: NodeJS.ProcessEnv): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(env.OPENCLAW_PLUGIN_LOAD_DEBUG);
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function describePluginModuleExportShape(
  value: unknown,
  label = "export",
  seen: Set<unknown> = new Set(),
): string[] {
  if (value === null) {
    return [`${label}:null`];
  }
  if (typeof value !== "object") {
    return [`${label}:${typeof value}`];
  }
  if (seen.has(value)) {
    return [`${label}:circular`];
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  const visibleKeys = keys.slice(0, 8);
  const extraCount = keys.length - visibleKeys.length;
  const keySummary =
    visibleKeys.length > 0
      ? `${visibleKeys.join(",")}${extraCount > 0 ? `,+${extraCount}` : ""}`
      : "none";
  const details = [`${label}:object keys=${keySummary}`];

  for (const key of ["default", "module", "register", "activate"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      details.push(...describePluginModuleExportShape(record[key], `${label}.${key}`, seen));
    }
  }
  return details;
}

function formatMissingPluginRegisterError(moduleExport: unknown, env: NodeJS.ProcessEnv): string {
  const message = "plugin export missing register/activate";
  if (!isPluginLoadDebugEnabled(env)) {
    return message;
  }
  return `${message} (module shape: ${describePluginModuleExportShape(moduleExport).join("; ")})`;
}

function mergeChannelPluginSection<T>(
  baseValue: T | undefined,
  overrideValue: T | undefined,
): T | undefined {
  if (
    baseValue &&
    overrideValue &&
    typeof baseValue === "object" &&
    typeof overrideValue === "object"
  ) {
    const merged = {
      ...(baseValue as Record<string, unknown>),
    };
    for (const [key, value] of Object.entries(overrideValue as Record<string, unknown>)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    return {
      ...merged,
    } as T;
  }
  return overrideValue ?? baseValue;
}

function mergeSetupRuntimeChannelPlugin(
  runtimePlugin: ChannelPlugin,
  setupPlugin: ChannelPlugin,
): ChannelPlugin {
  return {
    ...runtimePlugin,
    ...setupPlugin,
    meta: mergeChannelPluginSection(runtimePlugin.meta, setupPlugin.meta),
    capabilities: mergeChannelPluginSection(runtimePlugin.capabilities, setupPlugin.capabilities),
    commands: mergeChannelPluginSection(runtimePlugin.commands, setupPlugin.commands),
    doctor: mergeChannelPluginSection(runtimePlugin.doctor, setupPlugin.doctor),
    reload: mergeChannelPluginSection(runtimePlugin.reload, setupPlugin.reload),
    config: mergeChannelPluginSection(runtimePlugin.config, setupPlugin.config),
    setup: mergeChannelPluginSection(runtimePlugin.setup, setupPlugin.setup),
    messaging: mergeChannelPluginSection(runtimePlugin.messaging, setupPlugin.messaging),
    actions: mergeChannelPluginSection(runtimePlugin.actions, setupPlugin.actions),
    secrets: mergeChannelPluginSection(runtimePlugin.secrets, setupPlugin.secrets),
  } as ChannelPlugin;
}

function resolveBundledRuntimeChannelRegistration(moduleExport: unknown): {
  id?: string;
  loadChannelPlugin?: () => ChannelPlugin;
  loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
} {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return {};
  }
  const entryRecord = resolved as {
    kind?: unknown;
    id?: unknown;
    loadChannelPlugin?: unknown;
    loadChannelSecrets?: unknown;
    setChannelRuntime?: unknown;
  };
  if (
    entryRecord.kind !== "bundled-channel-entry" ||
    typeof entryRecord.id !== "string" ||
    typeof entryRecord.loadChannelPlugin !== "function"
  ) {
    return {};
  }
  return {
    id: entryRecord.id,
    loadChannelPlugin: entryRecord.loadChannelPlugin as () => ChannelPlugin,
    ...(typeof entryRecord.loadChannelSecrets === "function"
      ? {
          loadChannelSecrets: entryRecord.loadChannelSecrets as () =>
            | ChannelPlugin["secrets"]
            | undefined,
        }
      : {}),
    ...(typeof entryRecord.setChannelRuntime === "function"
      ? {
          setChannelRuntime: entryRecord.setChannelRuntime as (runtime: PluginRuntime) => void,
        }
      : {}),
  };
}

function loadBundledRuntimeChannelPlugin(params: {
  registration: ReturnType<typeof resolveBundledRuntimeChannelRegistration>;
}): {
  plugin?: ChannelPlugin;
  loadError?: unknown;
} {
  if (typeof params.registration.loadChannelPlugin !== "function") {
    return {};
  }
  try {
    const loadedPlugin = params.registration.loadChannelPlugin();
    const loadedSecrets = params.registration.loadChannelSecrets?.();
    if (!loadedPlugin || typeof loadedPlugin !== "object") {
      return {};
    }
    const mergedSecrets = mergeChannelPluginSection(loadedPlugin.secrets, loadedSecrets);
    return {
      plugin: {
        ...loadedPlugin,
        ...(mergedSecrets !== undefined ? { secrets: mergedSecrets } : {}),
      },
    };
  } catch (err) {
    return { loadError: err };
  }
}

function resolveSetupChannelRegistration(
  moduleExport: unknown,
  params: { installRuntimeDeps?: boolean } = {},
): {
  plugin?: ChannelPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
  usesBundledSetupContract?: boolean;
  loadError?: unknown;
} {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return {};
  }
  const setupEntryRecord = resolved as {
    kind?: unknown;
    loadSetupPlugin?: unknown;
    loadSetupSecrets?: unknown;
    setChannelRuntime?: unknown;
  };
  if (
    setupEntryRecord.kind === "bundled-channel-setup-entry" &&
    typeof setupEntryRecord.loadSetupPlugin === "function"
  ) {
    try {
      const setupLoadOptions =
        params.installRuntimeDeps === false ? { installRuntimeDeps: false } : undefined;
      const loadedPlugin = setupEntryRecord.loadSetupPlugin(setupLoadOptions);
      const loadedSecrets =
        typeof setupEntryRecord.loadSetupSecrets === "function"
          ? (setupEntryRecord.loadSetupSecrets(setupLoadOptions) as
              | ChannelPlugin["secrets"]
              | undefined)
          : undefined;
      if (loadedPlugin && typeof loadedPlugin === "object") {
        const mergedSecrets = mergeChannelPluginSection(
          (loadedPlugin as ChannelPlugin).secrets,
          loadedSecrets,
        );
        return {
          plugin: {
            ...(loadedPlugin as ChannelPlugin),
            ...(mergedSecrets !== undefined ? { secrets: mergedSecrets } : {}),
          },
          usesBundledSetupContract: true,
          ...(typeof setupEntryRecord.setChannelRuntime === "function"
            ? {
                setChannelRuntime: setupEntryRecord.setChannelRuntime as (
                  runtime: PluginRuntime,
                ) => void,
              }
            : {}),
        };
      }
    } catch (err) {
      return { loadError: err };
    }
  }
  const setup = resolved as {
    plugin?: unknown;
  };
  if (!setup.plugin || typeof setup.plugin !== "object") {
    return {};
  }
  return {
    plugin: setup.plugin as ChannelPlugin,
  };
}

function shouldLoadChannelPluginInSetupRuntime(params: {
  manifestChannels: string[];
  setupSource?: string;
  startupDeferConfiguredChannelFullLoadUntilAfterListen?: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  preferSetupRuntimeForChannelPlugins?: boolean;
}): boolean {
  if (!params.setupSource || params.manifestChannels.length === 0) {
    return false;
  }
  if (
    params.preferSetupRuntimeForChannelPlugins &&
    params.startupDeferConfiguredChannelFullLoadUntilAfterListen === true
  ) {
    return true;
  }
  return !params.manifestChannels.some((channelId) =>
    isChannelConfigured(params.cfg, channelId, params.env),
  );
}

function channelPluginIdBelongsToManifest(params: {
  channelId: string | undefined;
  pluginId: string;
  manifestChannels: readonly string[];
}): boolean {
  if (!params.channelId) {
    return true;
  }
  return params.channelId === params.pluginId || params.manifestChannels.includes(params.channelId);
}

function createPluginRecord(params: {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  source: string;
  rootDir?: string;
  origin: PluginRecord["origin"];
  workspaceDir?: string;
  enabled: boolean;
  activationState?: PluginActivationState;
  configSchema: boolean;
  contracts?: PluginManifestContracts;
}): PluginRecord {
  return {
    id: params.id,
    name: params.name ?? params.id,
    description: params.description,
    version: params.version,
    format: params.format ?? "openclaw",
    bundleFormat: params.bundleFormat,
    bundleCapabilities: params.bundleCapabilities,
    source: params.source,
    rootDir: params.rootDir,
    origin: params.origin,
    workspaceDir: params.workspaceDir,
    enabled: params.enabled,
    explicitlyEnabled: params.activationState?.explicitlyEnabled,
    activated: params.activationState?.activated,
    activationSource: params.activationState?.source,
    activationReason: params.activationState?.reason,
    status: params.enabled ? "loaded" : "disabled",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    contextEngineIds: [],
    memoryEmbeddingProviderIds: [],
    agentHarnessIds: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: params.configSchema,
    configUiHints: undefined,
    configJsonSchema: undefined,
    contracts: params.contracts,
  };
}

function markPluginActivationDisabled(record: PluginRecord, reason?: string): void {
  record.activated = false;
  record.activationSource = "disabled";
  record.activationReason = reason;
}

function formatAutoEnabledActivationReason(
  reasons: readonly string[] | undefined,
): string | undefined {
  if (!reasons || reasons.length === 0) {
    return undefined;
  }
  return reasons.join("; ");
}

function recordPluginError(params: {
  logger: PluginLogger;
  registry: PluginRegistry;
  record: PluginRecord;
  seenIds: Map<string, PluginRecord["origin"]>;
  pluginId: string;
  origin: PluginRecord["origin"];
  phase: PluginRecord["failurePhase"];
  error: unknown;
  logPrefix: string;
  diagnosticMessagePrefix: string;
}) {
  const errorText =
    process.env.OPENCLAW_PLUGIN_LOADER_DEBUG_STACKS === "1" &&
    params.error instanceof Error &&
    typeof params.error.stack === "string"
      ? params.error.stack
      : String(params.error);
  const deprecatedApiHint =
    errorText.includes("api.registerHttpHandler") && errorText.includes("is not a function")
      ? "deprecated api.registerHttpHandler(...) was removed; use api.registerHttpRoute(...) for plugin-owned routes or registerPluginHttpRoute(...) for dynamic lifecycle routes"
      : null;
  const displayError = deprecatedApiHint ? `${deprecatedApiHint} (${errorText})` : errorText;
  params.logger.error(`${params.logPrefix}${displayError}`);
  params.record.status = "error";
  params.record.error = displayError;
  params.record.failedAt = new Date();
  params.record.failurePhase = params.phase;
  params.registry.plugins.push(params.record);
  params.seenIds.set(params.pluginId, params.origin);
  params.registry.diagnostics.push({
    level: "error",
    pluginId: params.record.id,
    source: params.record.source,
    message: `${params.diagnosticMessagePrefix}${displayError}`,
  });
}

function formatPluginFailureSummary(failedPlugins: PluginRecord[]): string {
  const grouped = new Map<NonNullable<PluginRecord["failurePhase"]>, string[]>();
  for (const plugin of failedPlugins) {
    const phase = plugin.failurePhase ?? "load";
    const ids = grouped.get(phase);
    if (ids) {
      ids.push(plugin.id);
      continue;
    }
    grouped.set(phase, [plugin.id]);
  }
  return [...grouped.entries()].map(([phase, ids]) => `${phase}: ${ids.join(", ")}`).join("; ");
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

type PathMatcher = {
  exact: Set<string>;
  dirs: string[];
};

type InstallTrackingRule = {
  trackedWithoutPaths: boolean;
  matcher: PathMatcher;
};

type PluginProvenanceIndex = {
  loadPathMatcher: PathMatcher;
  installRules: Map<string, InstallTrackingRule>;
};

function createPathMatcher(): PathMatcher {
  return { exact: new Set<string>(), dirs: [] };
}

function addPathToMatcher(
  matcher: PathMatcher,
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return;
  }
  const resolved = resolveUserPath(trimmed, env);
  if (!resolved) {
    return;
  }
  if (matcher.exact.has(resolved) || matcher.dirs.includes(resolved)) {
    return;
  }
  const stat = safeStatSync(resolved);
  if (stat?.isDirectory()) {
    matcher.dirs.push(resolved);
    return;
  }
  matcher.exact.add(resolved);
}

function matchesPathMatcher(matcher: PathMatcher, sourcePath: string): boolean {
  if (matcher.exact.has(sourcePath)) {
    return true;
  }
  return matcher.dirs.some((dirPath) => isPathInside(dirPath, sourcePath));
}

function buildProvenanceIndex(params: {
  config: OpenClawConfig;
  normalizedLoadPaths: string[];
  env: NodeJS.ProcessEnv;
}): PluginProvenanceIndex {
  const loadPathMatcher = createPathMatcher();
  for (const loadPath of params.normalizedLoadPaths) {
    addPathToMatcher(loadPathMatcher, loadPath, params.env);
  }

  const installRules = new Map<string, InstallTrackingRule>();
  const installs = params.config.plugins?.installs ?? {};
  for (const [pluginId, install] of Object.entries(installs)) {
    const rule: InstallTrackingRule = {
      trackedWithoutPaths: false,
      matcher: createPathMatcher(),
    };
    const trackedPaths = [install.installPath, install.sourcePath]
      .map((entry) => normalizeOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (trackedPaths.length === 0) {
      rule.trackedWithoutPaths = true;
    } else {
      for (const trackedPath of trackedPaths) {
        addPathToMatcher(rule.matcher, trackedPath, params.env);
      }
    }
    installRules.set(pluginId, rule);
  }

  return { loadPathMatcher, installRules };
}

function isTrackedByProvenance(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): boolean {
  const sourcePath = resolveUserPath(params.source, params.env);
  const installRule = params.index.installRules.get(params.pluginId);
  if (installRule) {
    if (installRule.trackedWithoutPaths) {
      return true;
    }
    if (matchesPathMatcher(installRule.matcher, sourcePath)) {
      return true;
    }
  }
  return matchesPathMatcher(params.index.loadPathMatcher, sourcePath);
}

function matchesExplicitInstallRule(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): boolean {
  const sourcePath = resolveUserPath(params.source, params.env);
  const installRule = params.index.installRules.get(params.pluginId);
  if (!installRule || installRule.trackedWithoutPaths) {
    return false;
  }
  return matchesPathMatcher(installRule.matcher, sourcePath);
}

function resolveCandidateDuplicateRank(params: {
  candidate: ReturnType<typeof discoverOpenClawPlugins>["candidates"][number];
  manifestByRoot: Map<string, ReturnType<typeof loadPluginManifestRegistry>["plugins"][number]>;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const manifestRecord = params.manifestByRoot.get(params.candidate.rootDir);
  const pluginId = manifestRecord?.id;
  const isExplicitInstall =
    params.candidate.origin === "global" &&
    pluginId !== undefined &&
    matchesExplicitInstallRule({
      pluginId,
      source: params.candidate.source,
      index: params.provenance,
      env: params.env,
    });

  if (params.candidate.origin === "config") {
    return 0;
  }
  if (params.candidate.origin === "global" && isExplicitInstall) {
    return 1;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids stay reserved unless the operator configured an override.
    return 2;
  }
  if (params.candidate.origin === "workspace") {
    return 3;
  }
  return 4;
}

function compareDuplicateCandidateOrder(params: {
  left: ReturnType<typeof discoverOpenClawPlugins>["candidates"][number];
  right: ReturnType<typeof discoverOpenClawPlugins>["candidates"][number];
  manifestByRoot: Map<string, ReturnType<typeof loadPluginManifestRegistry>["plugins"][number]>;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const leftPluginId = params.manifestByRoot.get(params.left.rootDir)?.id;
  const rightPluginId = params.manifestByRoot.get(params.right.rootDir)?.id;
  if (!leftPluginId || leftPluginId !== rightPluginId) {
    return 0;
  }
  return (
    resolveCandidateDuplicateRank({
      candidate: params.left,
      manifestByRoot: params.manifestByRoot,
      provenance: params.provenance,
      env: params.env,
    }) -
    resolveCandidateDuplicateRank({
      candidate: params.right,
      manifestByRoot: params.manifestByRoot,
      provenance: params.provenance,
      env: params.env,
    })
  );
}

function warnWhenAllowlistIsOpen(params: {
  emitWarning: boolean;
  logger: PluginLogger;
  pluginsEnabled: boolean;
  allow: string[];
  warningCacheKey: string;
  discoverablePlugins: Array<{ id: string; source: string; origin: PluginRecord["origin"] }>;
}) {
  if (!params.emitWarning) {
    return;
  }
  if (!params.pluginsEnabled) {
    return;
  }
  if (params.allow.length > 0) {
    return;
  }
  const autoDiscoverable = params.discoverablePlugins.filter(
    (entry) => entry.origin === "workspace" || entry.origin === "global",
  );
  if (autoDiscoverable.length === 0) {
    return;
  }
  if (openAllowlistWarningCache.has(params.warningCacheKey)) {
    return;
  }
  const preview = autoDiscoverable
    .slice(0, 6)
    .map((entry) => `${entry.id} (${entry.source})`)
    .join(", ");
  const extra = autoDiscoverable.length > 6 ? ` (+${autoDiscoverable.length - 6} more)` : "";
  openAllowlistWarningCache.add(params.warningCacheKey);
  params.logger.warn(
    `[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: ${preview}${extra}. Set plugins.allow to explicit trusted ids.`,
  );
}

function warnAboutUntrackedLoadedPlugins(params: {
  registry: PluginRegistry;
  provenance: PluginProvenanceIndex;
  allowlist: string[];
  emitWarning: boolean;
  logger: PluginLogger;
  env: NodeJS.ProcessEnv;
}) {
  const allowSet = new Set(params.allowlist);
  for (const plugin of params.registry.plugins) {
    if (plugin.status !== "loaded" || plugin.origin === "bundled") {
      continue;
    }
    if (allowSet.has(plugin.id)) {
      continue;
    }
    if (
      isTrackedByProvenance({
        pluginId: plugin.id,
        source: plugin.source,
        index: params.provenance,
        env: params.env,
      })
    ) {
      continue;
    }
    const message =
      "loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records";
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: plugin.id,
      source: plugin.source,
      message,
    });
    if (params.emitWarning) {
      params.logger.warn(`[plugins] ${plugin.id}: ${message} (${plugin.source})`);
    }
  }
}

function activatePluginRegistry(
  registry: PluginRegistry,
  cacheKey: string,
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable",
  workspaceDir?: string,
): void {
  setActivePluginRegistry(registry, cacheKey, runtimeSubagentMode, workspaceDir);
  initializeGlobalHookRunner(registry);
}

export function loadOpenClawPlugins(options: PluginLoadOptions = {}): PluginRegistry {
  // Snapshot (non-activating) loads must disable the cache to avoid storing a registry
  // whose commands were never globally registered.
  if (options.activate === false && options.cache !== false) {
    throw new Error(
      "loadOpenClawPlugins: activate:false requires cache:false to prevent command registry divergence",
    );
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
  } = resolvePluginLoadCacheContext(options);
  const logger = options.logger ?? defaultLogger();
  const validateOnly = options.mode === "validate";
  const onlyPluginIdSet = createPluginIdScopeSet(onlyPluginIds);
  const cacheEnabled = options.cache !== false;
  if (cacheEnabled) {
    const cached = getCachedPluginRegistry(cacheKey);
    if (cached) {
      restoreRegisteredAgentHarnesses(cached.agentHarnesses);
      restoreRegisteredCompactionProviders(cached.compactionProviders);
      restoreDetachedTaskLifecycleRuntimeRegistration(cached.detachedTaskRuntimeRegistration);
      restoreRegisteredMemoryEmbeddingProviders(cached.memoryEmbeddingProviders);
      restoreMemoryPluginState({
        capability: cached.memoryCapability,
        corpusSupplements: cached.memoryCorpusSupplements,
        promptBuilder: cached.memoryPromptBuilder,
        promptSupplements: cached.memoryPromptSupplements,
        flushPlanResolver: cached.memoryFlushPlanResolver,
        runtime: cached.memoryRuntime,
      });
      if (shouldActivate) {
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
  if (inFlightPluginRegistryLoads.has(cacheKey)) {
    throw new PluginLoadReentryError(cacheKey);
  }
  inFlightPluginRegistryLoads.add(cacheKey);
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

    // Lazy: avoid creating the Jiti loader when all plugins are disabled (common in unit tests).
    const getJiti = createPluginJitiLoader(options);

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
      const safeRuntimePath = toSafeImportPath(runtimeModulePath);
      const runtimeModule = withProfile(
        { source: runtimeModulePath },
        "runtime-module",
        () =>
          getJiti(runtimeModulePath)(safeRuntimePath) as {
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
      activateGlobalSideEffects: shouldActivate,
    });

    const discovery = discoverOpenClawPlugins({
      workspaceDir: options.workspaceDir,
      extraPaths: normalized.loadPaths,
      cache: options.cache,
      env,
    });
    const manifestRegistry = loadPluginManifestRegistry({
      config: cfg,
      workspaceDir: options.workspaceDir,
      cache: options.cache,
      env,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
    });
    pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
    warnWhenAllowlistIsOpen({
      emitWarning: shouldActivate,
      logger,
      pluginsEnabled: normalized.enabled,
      allow: normalized.allow,
      warningCacheKey: cacheKey,
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
      config: cfg,
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
    const bundledRuntimeDepsRetainSpecsByInstallRoot = new Map<string, string[]>();
    const memorySlot = normalized.slots.memory;
    let selectedMemoryPluginId: string | null = null;
    let memorySlotMatched = false;
    const dreamingEngineId = resolveDreamingSidecarEngineId({ cfg, memorySlot });

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
          activationState,
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
        activationState,
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
      let runtimeCandidateSource = candidate.source;
      let runtimeSetupSource = manifestRecord.setupSource;

      const scopedSetupOnlyChannelPluginRequested =
        includeSetupOnlyChannelPlugins &&
        !validateOnly &&
        onlyPluginIdSet &&
        manifestRecord.channels.length > 0 &&
        (!enableState.enabled || forceSetupOnlyChannelPlugins);
      const canLoadScopedSetupOnlyChannelPlugin =
        scopedSetupOnlyChannelPluginRequested &&
        (!requireSetupEntryForSetupOnlyChannelPlugins || Boolean(manifestRecord.setupSource));
      const registrationMode = canLoadScopedSetupOnlyChannelPlugin
        ? "setup-only"
        : scopedSetupOnlyChannelPluginRequested && requireSetupEntryForSetupOnlyChannelPlugins
          ? null
          : enableState.enabled
            ? shouldLoadModules &&
              !validateOnly &&
              shouldLoadChannelPluginInSetupRuntime({
                manifestChannels: manifestRecord.channels,
                setupSource: manifestRecord.setupSource,
                startupDeferConfiguredChannelFullLoadUntilAfterListen:
                  manifestRecord.startupDeferConfiguredChannelFullLoadUntilAfterListen,
                cfg,
                env,
                preferSetupRuntimeForChannelPlugins,
              })
              ? "setup-runtime"
              : "full"
            : null;

      if (!registrationMode) {
        record.status = "disabled";
        record.error = enableState.reason;
        markPluginActivationDisabled(record, enableState.reason);
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }
      if (!enableState.enabled) {
        record.status = "disabled";
        record.error = enableState.reason;
        markPluginActivationDisabled(record, enableState.reason);
      }

      if (shouldLoadModules && candidate.origin === "bundled" && enableState.enabled) {
        try {
          const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
          const retainSpecs = bundledRuntimeDepsRetainSpecsByInstallRoot.get(installRoot) ?? [];
          const depsInstallResult = ensureBundledPluginRuntimeDeps({
            pluginId: record.id,
            pluginRoot,
            env,
            config: cfg,
            retainSpecs,
            installDeps: options.bundledRuntimeDepsInstaller,
          });
          if (depsInstallResult.installedSpecs.length > 0) {
            bundledRuntimeDepsRetainSpecsByInstallRoot.set(
              installRoot,
              [...new Set([...retainSpecs, ...depsInstallResult.retainSpecs])].toSorted(
                (left, right) => left.localeCompare(right),
              ),
            );
            if (shouldActivate) {
              logger.info(
                `[plugins] ${record.id} installed bundled runtime deps: ${depsInstallResult.installedSpecs.join(", ")}`,
              );
            }
          }
          ensureOpenClawPluginSdkAlias(path.dirname(path.dirname(pluginRoot)));
          if (path.resolve(installRoot) !== path.resolve(pluginRoot)) {
            registerBundledRuntimeDependencyNodePath(installRoot);
            runtimePluginRoot = mirrorBundledPluginRuntimeRoot({
              pluginId: record.id,
              pluginRoot,
              installRoot,
            });
            runtimeCandidateSource =
              remapBundledPluginRuntimePath({
                source: candidate.source,
                pluginRoot,
                mirroredRoot: runtimePluginRoot,
              }) ?? candidate.source;
            runtimeSetupSource = remapBundledPluginRuntimePath({
              source: manifestRecord.setupSource,
              pluginRoot,
              mirroredRoot: runtimePluginRoot,
            });
          }
        } catch (error) {
          pushPluginLoadError(`failed to install bundled runtime deps: ${String(error)}`);
          continue;
        }
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
        registrationMode === "full" &&
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

      if (!shouldLoadModules && registrationMode === "full") {
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
        registry.plugins.push(record);
        seenIds.set(pluginId, candidate.origin);
        continue;
      }

      const loadSource =
        (registrationMode === "setup-only" || registrationMode === "setup-runtime") &&
        runtimeSetupSource
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
      const safeImportSource = toSafeImportPath(safeSource);

      let mod: OpenClawPluginModule | null = null;
      try {
        // Track the plugin as imported once module evaluation begins. Top-level
        // code may have already executed even if evaluation later throws.
        recordImportedPluginId(record.id);
        mod = withProfile(
          { pluginId: record.id, source: safeSource },
          registrationMode,
          () => getJiti(safeSource)(safeImportSource) as OpenClawPluginModule,
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

      if (
        (registrationMode === "setup-only" || registrationMode === "setup-runtime") &&
        manifestRecord.setupSource
      ) {
        const setupRegistration = resolveSetupChannelRegistration(mod, {
          installRuntimeDeps: enableState.enabled,
        });
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
            registrationMode === "setup-runtime" &&
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
            const safeRuntimeImportSource = toSafeImportPath(safeRuntimeSource);
            let runtimeMod: OpenClawPluginModule | null = null;
            try {
              runtimeMod = withProfile(
                { pluginId: record.id, source: safeRuntimeSource },
                "load-setup-runtime-entry",
                () => getJiti(safeRuntimeSource)(safeRuntimeImportSource) as OpenClawPluginModule,
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

      if (registrationMode === "full") {
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

      if (registrationMode === "full") {
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
      setCachedPluginRegistry(cacheKey, {
        detachedTaskRuntimeRegistration: getDetachedTaskLifecycleRuntimeRegistration(),
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
      });
    }
    if (shouldActivate) {
      activatePluginRegistry(registry, cacheKey, runtimeSubagentMode, options.workspaceDir);
    }
    return registry;
  } finally {
    inFlightPluginRegistryLoads.delete(cacheKey);
  }
}

export async function loadOpenClawPluginCliRegistry(
  options: PluginLoadOptions = {},
): Promise<PluginRegistry> {
  const { env, cfg, normalized, activationSource, autoEnabledReasons, onlyPluginIds, cacheKey } =
    resolvePluginLoadCacheContext({
      ...options,
      activate: false,
      cache: false,
    });
  const logger = options.logger ?? defaultLogger();
  const onlyPluginIdSet = createPluginIdScopeSet(onlyPluginIds);
  const getJiti = createPluginJitiLoader(options);
  const { registry, registerCli } = createPluginRegistry({
    logger,
    runtime: {} as PluginRuntime,
    coreGatewayHandlers: options.coreGatewayHandlers as Record<string, GatewayRequestHandler>,
    activateGlobalSideEffects: false,
  });

  const discovery = discoverOpenClawPlugins({
    workspaceDir: options.workspaceDir,
    extraPaths: normalized.loadPaths,
    cache: false,
    env,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir: options.workspaceDir,
    cache: false,
    env,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  pushDiagnostics(registry.diagnostics, manifestRegistry.diagnostics);
  warnWhenAllowlistIsOpen({
    emitWarning: false,
    logger,
    pluginsEnabled: normalized.enabled,
    allow: normalized.allow,
    warningCacheKey: `${cacheKey}::cli-metadata`,
    discoverablePlugins: manifestRegistry.plugins
      .filter((plugin) => !onlyPluginIdSet || onlyPluginIdSet.has(plugin.id))
      .map((plugin) => ({
        id: plugin.id,
        source: plugin.source,
        origin: plugin.origin,
      })),
  });
  const provenance = buildProvenanceIndex({
    config: cfg,
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
        activationState,
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
      activationState,
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
      candidate.origin === "bundled" ? cliMetadataSource : (cliMetadataSource ?? candidate.source);
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
    const safeImportSource = toSafeImportPath(safeSource);

    let mod: OpenClawPluginModule | null = null;
    try {
      mod = withProfile(
        { pluginId: record.id, source: safeSource },
        "cli-metadata",
        () => getJiti(safeSource)(safeImportSource) as OpenClawPluginModule,
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
