// Maintains plugin setup entries discovered from manifests and light exports.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeStringEntries,
  normalizeUniqueStringEntries,
} from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildPluginApi, createUnavailableRuntime } from "./api-builder.js";
import { hasPluginConfigMigrationSource } from "./config-contract-matches.js";
import { getCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { createPluginCacheKey, PluginLruCache } from "./plugin-cache-primitives.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import { resolvePluginMetadataEnvFingerprint } from "./plugin-metadata-snapshot.js";
import {
  clearPluginModuleLoaderLifecycleCache,
  getCachedPluginModuleLoader,
} from "./plugin-module-loader-cache.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import { resolvePreferredBundledRootArtifact } from "./plugin-runtime-artifact-selection.js";
import { listSetupCliBackendIds, listSetupProviderIds } from "./setup-descriptors.js";
import { pluginSetupRegistryLoaderState } from "./setup-registry-loader-state.js";
import type {
  CliBackendPlugin,
  OpenClawPluginModule,
  PluginConfigMigration,
  PluginLogger,
  PluginSetupAutoEnableProbe,
  ProviderPlugin,
} from "./types.js";

const log = createSubsystemLogger("plugins/setup-registry");

const SETUP_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type SetupProviderEntry = {
  pluginId: string;
  provider: ProviderPlugin;
};

type SetupCliBackendEntry = {
  pluginId: string;
  backend: CliBackendPlugin;
};

type SetupConfigMigrationEntry = {
  pluginId: string;
  migrate: PluginConfigMigration;
};

type SetupAutoEnableProbeEntry = {
  pluginId: string;
  probe: PluginSetupAutoEnableProbe;
};

type PluginSetupRegistryDiagnosticCode =
  | "setup-descriptor-runtime-disabled"
  | "setup-descriptor-provider-runtime-undeclared"
  | "setup-descriptor-cli-backend-missing-runtime"
  | "setup-descriptor-cli-backend-runtime-undeclared"
  | "setup-entry-load-failed"
  | "setup-registration-failed";

type PluginSetupRegistryDiagnostic = {
  pluginId: string;
  code: PluginSetupRegistryDiagnosticCode;
  declaredId?: string;
  runtimeId?: string;
  message: string;
};

type PluginSetupRegistry = {
  providers: SetupProviderEntry[];
  cliBackends: SetupCliBackendEntry[];
  configMigrations: SetupConfigMigrationEntry[];
  autoEnableProbes: SetupAutoEnableProbeEntry[];
  diagnostics: PluginSetupRegistryDiagnostic[];
};

type SetupAutoEnableReason = {
  pluginId: string;
  reason: string;
};

type PluginApiBuildParams = Parameters<typeof buildPluginApi>[0];

const NOOP_LOGGER: PluginLogger = {
  info() {},
  warn() {},
  error() {},
};

const MAX_SETUP_REGISTRY_CACHE_ENTRIES = 16;
let setupRegistrySnapshotIdSeq = 0;
let setupRegistrySnapshotIds = new WeakMap<object, string>();
const setupManifestRegistryCache = new PluginLruCache<PluginManifestRegistry>(
  MAX_SETUP_REGISTRY_CACHE_ENTRIES,
);
const pluginSetupRegistryCache = new PluginLruCache<PluginSetupRegistry>(
  MAX_SETUP_REGISTRY_CACHE_ENTRIES,
);

function clearPluginSetupRegistryCache(): void {
  clearPluginModuleLoaderLifecycleCache(pluginSetupRegistryLoaderState);
  setupRegistrySnapshotIds = new WeakMap();
  setupManifestRegistryCache.clear();
  pluginSetupRegistryCache.clear();
}

registerPluginMetadataProcessMemoLifecycleClear(clearPluginSetupRegistryCache);
function getModuleLoader(modulePath: string, rootDir: string) {
  pluginSetupRegistryLoaderState.moduleRoots.set(modulePath, rootDir);
  return getCachedPluginModuleLoader({
    cache: pluginSetupRegistryLoaderState.moduleLoaders,
    modulePath,
    importerUrl: import.meta.url,
    ...(pluginSetupRegistryLoaderState.moduleLoaderFactory
      ? { createLoader: pluginSetupRegistryLoaderState.moduleLoaderFactory }
      : {}),
  });
}

function resolveSetupApiPath(
  rootDir: string,
  options?: { includeBundledSourceFallback?: boolean },
): string | null {
  const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
    ? SETUP_API_EXTENSIONS
    : ([...SETUP_API_EXTENSIONS.slice(3), ...SETUP_API_EXTENSIONS.slice(0, 3)] as const);

  const findSetupApi = (candidateRootDir: string): string | null => {
    for (const extension of orderedExtensions) {
      const candidate = path.join(candidateRootDir, `setup-api${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  const direct = findSetupApi(rootDir);
  if (direct) {
    return direct;
  }

  if (options?.includeBundledSourceFallback === false) {
    return null;
  }

  const bundledExtensionDir = path.basename(rootDir);
  const repoRootCandidates = [path.resolve(path.dirname(CURRENT_MODULE_PATH), "..", "..")];
  for (const repoRoot of repoRootCandidates) {
    const sourceExtensionRoot = path.join(repoRoot, "extensions", bundledExtensionDir);
    if (sourceExtensionRoot === rootDir) {
      continue;
    }
    const sourceFallback = findSetupApi(sourceExtensionRoot);
    if (sourceFallback) {
      return sourceFallback;
    }
  }

  return null;
}

function collectConfiguredPluginEntryIds(config: OpenClawConfig): string[] {
  const entries = config.plugins?.entries;
  if (!entries || typeof entries !== "object") {
    return [];
  }
  return normalizeStringEntries(Object.keys(entries)).toSorted();
}

function resolveRelevantSetupMigrationPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const ids = new Set<string>(collectConfiguredPluginEntryIds(params.config));
  const registry = loadSetupManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  for (const plugin of registry.plugins) {
    if (
      hasPluginConfigMigrationSource({
        root: params.config,
        pathPatterns: plugin.configContracts?.compatibilityMigrationPaths,
      })
    ) {
      ids.add(plugin.id);
    }
  }
  return [...ids].toSorted();
}

function resolveRegister(mod: OpenClawPluginModule): {
  definition?: { id?: string };
  register?: (api: ReturnType<typeof buildPluginApi>) => void | Promise<void>;
} {
  if (typeof mod === "function") {
    return { register: mod };
  }
  if (mod && typeof mod === "object" && typeof mod.register === "function") {
    return {
      definition: mod as { id?: string },
      register: mod.register.bind(mod),
    };
  }
  return {};
}

function resolveLoadableSetupRuntimeSource(
  record: PluginManifestRecord,
): { source: string; rootDir: string } | null {
  const source = record.setupSource ?? resolveSetupApiPath(record.rootDir);
  if (!source) {
    return null;
  }
  if (record.origin !== "bundled") {
    return { source, rootDir: record.rootDir };
  }
  return resolvePreferredBundledRootArtifact({
    source,
    rootDir: record.rootDir,
    packageManifest: record.packageManifest,
  });
}

function resolveDeclaredSetupRuntimeSource(record: PluginManifestRecord): string | null {
  return (
    record.setupSource ??
    resolveSetupApiPath(record.rootDir, {
      includeBundledSourceFallback: false,
    })
  );
}

function resolveSetupRegistration(
  record: PluginManifestRecord,
  diagnostics: PluginSetupRegistryDiagnostic[],
): {
  setupSource: string;
  register: (api: ReturnType<typeof buildPluginApi>) => void | Promise<void>;
} | null {
  if (record.setup?.requiresRuntime === false) {
    return null;
  }
  const setupArtifact = resolveLoadableSetupRuntimeSource(record);
  if (!setupArtifact) {
    return null;
  }
  const setupSource = setupArtifact.source;

  let mod: OpenClawPluginModule;
  try {
    mod = getModuleLoader(setupSource, setupArtifact.rootDir)(setupSource) as OpenClawPluginModule;
  } catch (error) {
    // A broken setup entry silently removes the plugin's providers/CLI
    // backends/migrations from onboarding; record why instead of vanishing.
    diagnostics.push({
      pluginId: record.id,
      code: "setup-entry-load-failed",
      message: `setup entry failed to load from ${setupSource}: ${String(error)}`,
    });
    return null;
  }

  const resolved = resolveRegister((mod as { default?: OpenClawPluginModule }).default ?? mod);
  if (!resolved.register) {
    return null;
  }
  if (resolved.definition?.id && resolved.definition.id !== record.id) {
    return null;
  }
  return {
    setupSource,
    register: resolved.register,
  };
}

function buildSetupPluginApi(params: {
  record: PluginManifestRecord;
  setupSource: string;
  handlers: PluginApiBuildParams["handlers"];
}): ReturnType<typeof buildPluginApi> {
  return buildPluginApi({
    id: params.record.id,
    name: params.record.name ?? params.record.id,
    version: params.record.version,
    description: params.record.description,
    source: params.setupSource,
    rootDir: params.record.rootDir,
    registrationMode: "setup-only",
    config: {} as OpenClawConfig,
    runtime: createUnavailableRuntime("setup-only", params.record.id),
    logger: NOOP_LOGGER,
    resolvePath: (input) => input,
    handlers: params.handlers,
  });
}

function ignoreAsyncSetupRegisterResult(result: void | Promise<void>): void {
  if (!result || typeof result.then !== "function") {
    return;
  }
  // Setup-only registration is sync-only. Swallow async rejections so they do
  // not trip the global unhandledRejection fatal path.
  void Promise.resolve(result).catch(() => undefined);
}

function runSetupRegistration(
  register: (api: ReturnType<typeof buildPluginApi>) => void | Promise<void>,
  api: ReturnType<typeof buildPluginApi>,
  onError: (error: unknown) => void,
): boolean {
  try {
    ignoreAsyncSetupRegisterResult(register(api));
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

function matchesProvider(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

function resolveSetupRegistryCacheKey(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): string | null {
  const env = params?.env ?? process.env;
  if (env !== process.env) {
    return null;
  }
  return createPluginCacheKey([
    "setup-registry",
    resolvePluginControlPlaneFingerprint({
      config: params?.config,
      env,
      workspaceDir: params?.workspaceDir,
    }),
    resolvePluginMetadataEnvFingerprint(env),
    resolveCurrentSetupSnapshotCacheId(),
    process.cwd(),
    params?.pluginIds ? [...params.pluginIds].toSorted() : null,
  ]);
}

function resolveCurrentSetupSnapshotCacheId(): string {
  const { snapshot } = getCurrentPluginMetadataSnapshotState();
  if (!snapshot || typeof snapshot !== "object") {
    return "nosnap";
  }
  let id = setupRegistrySnapshotIds.get(snapshot);
  if (id === undefined) {
    id = `s${++setupRegistrySnapshotIdSeq}`;
    setupRegistrySnapshotIds.set(snapshot, id);
  }
  return id;
}

function cloneSetupRegistryValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  const cached = seen.get(value);
  if (cached !== undefined) {
    return cached as T;
  }
  if (value instanceof Date) {
    const clone = new Date(value);
    seen.set(value, clone);
    return clone as T;
  }
  if (value instanceof RegExp) {
    const clone = new RegExp(value.source, value.flags);
    clone.lastIndex = value.lastIndex;
    seen.set(value, clone);
    return clone as T;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    clone.push(...value.map((entry) => cloneSetupRegistryValue(entry, seen)));
    return clone as T;
  }
  if (value instanceof Map) {
    const clone = new Map<unknown, unknown>();
    seen.set(value, clone);
    for (const [key, entry] of value.entries()) {
      clone.set(cloneSetupRegistryValue(key, seen), cloneSetupRegistryValue(entry, seen));
    }
    return clone as T;
  }
  if (value instanceof Set) {
    const clone = new Set<unknown>();
    seen.set(value, clone);
    for (const entry of value.values()) {
      clone.add(cloneSetupRegistryValue(entry, seen));
    }
    return clone as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Class-prototyped values are shared by reference: setup registrations must
    // treat them as immutable, or a caller mutation corrupts later cache hits.
    return value;
  }
  const clone = Object.create(prototype) as Record<PropertyKey, unknown>;
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      continue;
    }
    if ("value" in descriptor) {
      descriptor.value = cloneSetupRegistryValue(descriptor.value, seen);
    }
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as T;
}

function cloneSetupRegistry(registry: PluginSetupRegistry): PluginSetupRegistry {
  return cloneSetupRegistryValue(registry);
}

function loadSetupManifestRegistry(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}) {
  const env = params?.env ?? process.env;
  const cacheKey = resolveSetupRegistryCacheKey(params);
  if (cacheKey !== null) {
    const cached = setupManifestRegistryCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env,
    pluginIds: params?.pluginIds,
    includeDisabled: true,
  });
  if (cacheKey !== null) {
    setupManifestRegistryCache.set(cacheKey, registry);
  }
  return registry;
}

function findUniqueSetupManifestOwner(params: {
  registry: ReturnType<typeof loadSetupManifestRegistry>;
  normalizedId: string;
  listIds: (record: PluginManifestRecord) => readonly string[];
}): PluginManifestRecord | undefined {
  const matches = params.registry.plugins.filter((entry) =>
    params.listIds(entry).some((id) => normalizeProviderId(id) === params.normalizedId),
  );
  if (matches.length === 0) {
    return undefined;
  }
  // Setup lookup can execute plugin code. Refuse ambiguous ownership instead of
  // depending on manifest ordering across bundled/workspace/global sources.
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveSetupRegistryForManifestOwner(record: PluginManifestRecord): PluginSetupRegistry {
  return resolvePluginSetupRegistry({
    manifestRegistry: { plugins: [record], diagnostics: [] },
  });
}

function mapNormalizedIds(ids: readonly string[]): Map<string, string> {
  const mapped = new Map<string, string>();
  for (const id of ids) {
    const normalized = normalizeProviderId(id);
    if (!normalized || mapped.has(normalized)) {
      continue;
    }
    mapped.set(normalized, id);
  }
  return mapped;
}

function pushDescriptorRuntimeDisabledDiagnostic(params: {
  record: PluginManifestRecord;
  diagnostics: PluginSetupRegistryDiagnostic[];
}): void {
  if (!resolveDeclaredSetupRuntimeSource(params.record)) {
    return;
  }
  params.diagnostics.push({
    pluginId: params.record.id,
    code: "setup-descriptor-runtime-disabled",
    message:
      "setup.requiresRuntime is false, so OpenClaw ignored the plugin setup runtime entry. Remove setup-api/openclaw.setupEntry or set requiresRuntime true if setup lookup still needs plugin code.",
  });
}

function pushSetupDescriptorDriftDiagnostics(params: {
  record: PluginManifestRecord;
  providers: readonly ProviderPlugin[];
  cliBackends: readonly CliBackendPlugin[];
  diagnostics: PluginSetupRegistryDiagnostic[];
}): void {
  const declaredProviderIds = params.record.setup?.providers?.map((entry) => entry.id);
  if (declaredProviderIds) {
    for (const provider of params.providers) {
      if (!declaredProviderIds.some((declaredId) => matchesProvider(provider, declaredId))) {
        params.diagnostics.push({
          pluginId: params.record.id,
          code: "setup-descriptor-provider-runtime-undeclared",
          runtimeId: provider.id,
          message: `setup runtime registered provider "${provider.id}" but setup.providers does not declare it.`,
        });
      }
    }
  }

  const declaredCliBackendIds = params.record.setup?.cliBackends;
  if (declaredCliBackendIds) {
    const declaredCliBackends = mapNormalizedIds(declaredCliBackendIds);
    const runtimeCliBackends = mapNormalizedIds(params.cliBackends.map((backend) => backend.id));
    for (const [normalized, declaredId] of declaredCliBackends) {
      if (!runtimeCliBackends.has(normalized)) {
        params.diagnostics.push({
          pluginId: params.record.id,
          code: "setup-descriptor-cli-backend-missing-runtime",
          declaredId,
          message: `setup.cliBackends declares "${declaredId}" but setup runtime did not register a matching CLI backend.`,
        });
      }
    }
    for (const [normalized, runtimeId] of runtimeCliBackends) {
      if (!declaredCliBackends.has(normalized)) {
        params.diagnostics.push({
          pluginId: params.record.id,
          code: "setup-descriptor-cli-backend-runtime-undeclared",
          runtimeId,
          message: `setup runtime registered CLI backend "${runtimeId}" but setup.cliBackends does not declare it.`,
        });
      }
    }
  }
}

export function resolvePluginSetupRegistry(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  manifestRegistry?: PluginManifestRegistry;
}): PluginSetupRegistry {
  const env = params?.env ?? process.env;
  const scopedPluginIds = params?.pluginIds
    ? new Set(normalizeUniqueStringEntries(params.pluginIds))
    : null;
  if (scopedPluginIds && scopedPluginIds.size === 0) {
    const empty = {
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    } satisfies PluginSetupRegistry;
    return empty;
  }

  // Cache only self-scanned results; a caller-supplied manifestRegistry owns the derivation.
  const resultCacheKey = params?.manifestRegistry ? null : resolveSetupRegistryCacheKey(params);
  if (resultCacheKey !== null) {
    const cached = pluginSetupRegistryCache.get(resultCacheKey);
    if (cached) {
      return cloneSetupRegistry(cached);
    }
  }

  const providers: SetupProviderEntry[] = [];
  const cliBackends: SetupCliBackendEntry[] = [];
  const configMigrations: SetupConfigMigrationEntry[] = [];
  const autoEnableProbes: SetupAutoEnableProbeEntry[] = [];
  const diagnostics: PluginSetupRegistryDiagnostic[] = [];
  let providerKeys = new Set<string>();
  let cliBackendKeys = new Set<string>();

  const manifestRegistry =
    params?.manifestRegistry ??
    loadSetupManifestRegistry({
      config: params?.config,
      workspaceDir: params?.workspaceDir,
      env,
      pluginIds: params?.pluginIds,
    });

  for (const record of manifestRegistry.plugins) {
    if (scopedPluginIds && !scopedPluginIds.has(record.id)) {
      continue;
    }
    if (record.setup?.requiresRuntime === false) {
      pushDescriptorRuntimeDisabledDiagnostic({
        record,
        diagnostics,
      });
      continue;
    }
    const setupRegistration = resolveSetupRegistration(record, diagnostics);
    if (!setupRegistration) {
      continue;
    }

    const recordProviders: SetupProviderEntry[] = [];
    const recordCliBackends: SetupCliBackendEntry[] = [];
    const recordConfigMigrations: SetupConfigMigrationEntry[] = [];
    const recordAutoEnableProbes: SetupAutoEnableProbeEntry[] = [];
    const recordProviderKeys = new Set(providerKeys);
    const recordCliBackendKeys = new Set(cliBackendKeys);
    let acceptingRegistrations = true;
    const api = buildSetupPluginApi({
      record,
      setupSource: setupRegistration.setupSource,
      handlers: {
        registerProvider(provider) {
          const key = `${record.id}:${normalizeProviderId(provider.id)}`;
          if (!acceptingRegistrations || recordProviderKeys.has(key)) {
            return;
          }
          recordProviderKeys.add(key);
          recordProviders.push({
            pluginId: record.id,
            provider,
          });
        },
        registerCliBackend(backend) {
          const key = `${record.id}:${normalizeProviderId(backend.id)}`;
          if (!acceptingRegistrations || recordCliBackendKeys.has(key)) {
            return;
          }
          recordCliBackendKeys.add(key);
          recordCliBackends.push({
            pluginId: record.id,
            backend,
          });
        },
        registerConfigMigration(migrate) {
          if (!acceptingRegistrations) {
            return;
          }
          recordConfigMigrations.push({
            pluginId: record.id,
            migrate,
          });
        },
        registerAutoEnableProbe(probe) {
          if (!acceptingRegistrations) {
            return;
          }
          recordAutoEnableProbes.push({
            pluginId: record.id,
            probe,
          });
        },
      },
    });

    const registered = runSetupRegistration(setupRegistration.register, api, (error) => {
      diagnostics.push({
        pluginId: record.id,
        code: "setup-registration-failed",
        message: `setup registration threw: ${String(error)}`,
      });
    });
    acceptingRegistrations = false;
    if (!registered) {
      continue;
    }
    providers.push(...recordProviders);
    cliBackends.push(...recordCliBackends);
    configMigrations.push(...recordConfigMigrations);
    autoEnableProbes.push(...recordAutoEnableProbes);
    providerKeys = recordProviderKeys;
    cliBackendKeys = recordCliBackendKeys;
    pushSetupDescriptorDriftDiagnostics({
      record,
      providers: recordProviders.map((entry) => entry.provider),
      cliBackends: recordCliBackends.map((entry) => entry.backend),
      diagnostics,
    });
  }

  const registry = {
    providers,
    cliBackends,
    configMigrations,
    autoEnableProbes,
    diagnostics,
  } satisfies PluginSetupRegistry;
  // The diagnostics array has no other operator surface; warn once per
  // (uncached) build so broken setup entries and descriptor drift are
  // visible instead of silently narrowing onboarding.
  for (const diagnostic of diagnostics) {
    log.warn(`plugin setup [${diagnostic.pluginId}] ${diagnostic.code}: ${diagnostic.message}`);
  }
  if (resultCacheKey === null) {
    return registry;
  }
  pluginSetupRegistryCache.set(resultCacheKey, cloneSetupRegistry(registry));
  return registry;
}

export function resolvePluginSetupProviderCore(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): ProviderPlugin | undefined {
  const env = params.env ?? process.env;
  const normalizedProvider = normalizeProviderId(params.provider);
  const manifestRegistry = loadSetupManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    pluginIds: params.pluginIds,
  });
  const record = findUniqueSetupManifestOwner({
    registry: manifestRegistry,
    normalizedId: normalizedProvider,
    listIds: listSetupProviderIds,
  });
  if (!record) {
    return undefined;
  }
  return resolveSetupRegistryForManifestOwner(record).providers.findLast((entry) =>
    matchesProvider(entry.provider, normalizedProvider),
  )?.provider;
}

export function resolvePluginSetupCliBackend(params: {
  backend: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): SetupCliBackendEntry | undefined {
  const normalized = normalizeProviderId(params.backend);

  const env = params.env ?? process.env;
  // Narrow setup lookup from manifest-owned descriptors before executing any
  // plugin setup module. This avoids booting every setup-api just to find one
  // backend owner.
  const manifestRegistry = loadSetupManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
  });
  const record = findUniqueSetupManifestOwner({
    registry: manifestRegistry,
    normalizedId: normalized,
    listIds: listSetupCliBackendIds,
  });
  if (!record) {
    return undefined;
  }
  return resolveSetupRegistryForManifestOwner(record).cliBackends.find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
}

export function runPluginSetupConfigMigrations(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): {
  config: OpenClawConfig;
  changes: string[];
} {
  let next = params.config;
  const changes: string[] = [];
  const pluginIds = resolveRelevantSetupMigrationPluginIds(params);
  if (pluginIds.length === 0) {
    return { config: next, changes };
  }

  for (const entry of resolvePluginSetupRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    pluginIds,
  }).configMigrations) {
    const migration = entry.migrate(next);
    if (!migration || migration.changes.length === 0) {
      continue;
    }
    next = migration.config;
    changes.push(...migration.changes);
  }

  return { config: next, changes };
}

export function resolvePluginSetupAutoEnableReasons(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  manifestRegistry?: PluginManifestRegistry;
}): SetupAutoEnableReason[] {
  const env = params.env ?? process.env;
  const reasons: SetupAutoEnableReason[] = [];
  const seen = new Set<string>();

  for (const entry of resolvePluginSetupRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env,
    pluginIds: params.pluginIds,
    manifestRegistry: params.manifestRegistry,
  }).autoEnableProbes) {
    const raw = entry.probe({
      config: params.config,
      env,
    });
    const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const reason of values) {
      const normalized = reason.trim();
      if (!normalized) {
        continue;
      }
      const key = `${entry.pluginId}:${normalized}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      reasons.push({
        pluginId: entry.pluginId,
        reason: normalized,
      });
    }
  }

  return reasons;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
