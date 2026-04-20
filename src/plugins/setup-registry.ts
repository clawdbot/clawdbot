import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginApi } from "./api-builder.js";
import { collectPluginConfigContractMatches } from "./config-contracts.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { getCachedPluginJitiLoader, type PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import { loadPluginManifestRegistry, type PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
import type { PluginRuntime } from "./runtime/types.js";
import { listSetupCliBackendIds, listSetupProviderIds } from "./setup-descriptors.js";
import type {
  CliBackendPlugin,
  OpenClawPluginModule,
  PluginConfigMigration,
  PluginLogger,
  PluginSetupAutoEnableProbe,
  ProviderPlugin,
} from "./types.js";

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

type PluginSetupRegistry = {
  providers: SetupProviderEntry[];
  cliBackends: SetupCliBackendEntry[];
  configMigrations: SetupConfigMigrationEntry[];
  autoEnableProbes: SetupAutoEnableProbeEntry[];
};

type SetupAutoEnableReason = {
  pluginId: string;
  reason: string;
};

type PluginApiBuildParams = Parameters<typeof buildPluginApi>[0];

const EMPTY_RUNTIME = {} as PluginRuntime;
const NOOP_LOGGER: PluginLogger = {
  info() {},
  warn() {},
  error() {},
};

const MAX_SETUP_LOOKUP_CACHE_ENTRIES = 128;

const jitiLoaders: PluginJitiLoaderCache = new Map();
const setupRegistryCache = new Map<string, PluginSetupRegistry>();
const setupProviderCache = new Map<string, ProviderPlugin | null>();
const setupCliBackendCache = new Map<string, SetupCliBackendEntry | null>();
let setupLookupCacheEntryCap = MAX_SETUP_LOOKUP_CACHE_ENTRIES;

export const __testing = {
  get maxSetupLookupCacheEntries() {
    return setupLookupCacheEntryCap;
  },
  setMaxSetupLookupCacheEntriesForTest(value?: number) {
    setupLookupCacheEntryCap =
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.floor(value))
        : MAX_SETUP_LOOKUP_CACHE_ENTRIES;
  },
  getCacheSizes() {
    return {
      setupRegistry: setupRegistryCache.size,
      setupProvider: setupProviderCache.size,
      setupCliBackend: setupCliBackendCache.size,
    };
  },
} as const;

export function clearPluginSetupRegistryCache(): void {
  jitiLoaders.clear();
  setupRegistryCache.clear();
  setupProviderCache.clear();
  setupCliBackendCache.clear();
}

function getJiti(modulePath: string) {
  return getCachedPluginJitiLoader({
    cache: jitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
  });
}

function getCachedSetupValue<T>(
  cache: Map<string, T>,
  key: string,
): { hit: true; value: T } | { hit: false } {
  if (!cache.has(key)) {
    return { hit: false };
  }
  const cached = cache.get(key) as T;
  cache.delete(key);
  cache.set(key, cached);
  return { hit: true, value: cached };
}

function setCachedSetupValue<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > setupLookupCacheEntryCap) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    cache.delete(oldestKey);
  }
}

function buildSetupRegistryCacheKey(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): string {
  const { roots, loadPaths } = resolvePluginCacheInputs({
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return JSON.stringify({
    roots,
    loadPaths,
    pluginIds: params.pluginIds ? [...new Set(params.pluginIds)].toSorted() : null,
  });
}

function buildSetupProviderCacheKey(params: {
  provider: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return JSON.stringify({
    provider: normalizeProviderId(params.provider),
    registry: buildSetupRegistryCacheKey(params),
  });
}

function buildSetupCliBackendCacheKey(params: {
  backend: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return JSON.stringify({
    backend: normalizeProviderId(params.backend),
    registry: buildSetupRegistryCacheKey(params),
  });
}

function resolveSetupApiPath(rootDir: string): string | null {
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

  const bundledExtensionDir = path.basename(rootDir);
  const repoRootCandidates = [
    path.resolve(path.dirname(CURRENT_MODULE_PATH), "..", ".."),
    process.cwd(),
  ];
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
  return Object.keys(entries)
    .map((pluginId) => pluginId.trim())
    .filter(Boolean)
    .toSorted();
}

function resolveRelevantSetupMigrationPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const ids = new Set<string>(collectConfiguredPluginEntryIds(params.config));
  const registry = loadPluginManifestRegistry({
    workspaceDir: params.workspaceDir,
    env: params.env,
    cache: true,
  });
  for (const plugin of registry.plugins) {
    const paths = plugin.configContracts?.compatibilityMigrationPaths;
    if (!paths?.length) {
      continue;
    }
    if (
      paths.some(
        (pathPattern) =>
          collectPluginConfigContractMatches({
            root: params.config,
            pathPattern,
          }).length > 0,
      )
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

function resolveSetupRegistration(record: PluginManifestRecord): {
  setupSource: string;
  register: (api: ReturnType<typeof buildPluginApi>) => void | Promise<void>;
} | null {
  const setupSource = record.setupSource ?? resolveSetupApiPath(record.rootDir);
  if (!setupSource) {
    return null;
  }

  let mod: OpenClawPluginModule;
  try {
    mod = getJiti(setupSource)(setupSource) as OpenClawPluginModule;
  } catch {
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
    runtime: EMPTY_RUNTIME,
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

function matchesProvider(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
}

function loadSetupManifestRegistry(params?: { workspaceDir?: string; env?: NodeJS.ProcessEnv }) {
  const env = params?.env ?? process.env;
  const discovery = discoverOpenClawPlugins({
    workspaceDir: params?.workspaceDir,
    env,
    cache: true,
  });
  return loadPluginManifestRegistry({
    workspaceDir: params?.workspaceDir,
    env,
    cache: true,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
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

export function resolvePluginSetupRegistry(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): PluginSetupRegistry {
  const env = params?.env ?? process.env;
  const cacheKey = buildSetupRegistryCacheKey({
    workspaceDir: params?.workspaceDir,
    env,
    pluginIds: params?.pluginIds,
  });
  const cached = getCachedSetupValue(setupRegistryCache, cacheKey);
  if (cached.hit) {
    return cached.value;
  }

  const selectedPluginIds = params?.pluginIds
    ? new Set(params.pluginIds.map((pluginId) => pluginId.trim()).filter(Boolean))
    : null;
  if (selectedPluginIds && selectedPluginIds.size === 0) {
    const empty = {
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
    } satisfies PluginSetupRegistry;
    setCachedSetupValue(setupRegistryCache, cacheKey, empty);
    return empty;
  }

  const providers: SetupProviderEntry[] = [];
  const cliBackends: SetupCliBackendEntry[] = [];
  const configMigrations: SetupConfigMigrationEntry[] = [];
  const autoEnableProbes: SetupAutoEnableProbeEntry[] = [];
  const providerKeys = new Set<string>();
  const cliBackendKeys = new Set<string>();

  const manifestRegistry = loadSetupManifestRegistry({
    workspaceDir: params?.workspaceDir,
    env,
  });

  for (const record of manifestRegistry.plugins) {
    if (selectedPluginIds && !selectedPluginIds.has(record.id)) {
      continue;
    }
    const setupRegistration = resolveSetupRegistration(record);
    if (!setupRegistration) {
      continue;
    }

    const api = buildSetupPluginApi({
      record,
      setupSource: setupRegistration.setupSource,
      handlers: {
        registerProvider(provider) {
          const key = `${record.id}:${normalizeProviderId(provider.id)}`;
          if (providerKeys.has(key)) {
            return;
          }
          providerKeys.add(key);
          providers.push({
            pluginId: record.id,
            provider,
          });
        },
        registerCliBackend(backend) {
          const key = `${record.id}:${normalizeProviderId(backend.id)}`;
          if (cliBackendKeys.has(key)) {
            return;
          }
          cliBackendKeys.add(key);
          cliBackends.push({
            pluginId: record.id,
            backend,
          });
        },
        registerConfigMigration(migrate) {
          configMigrations.push({
            pluginId: record.id,
            migrate,
          });
        },
        registerAutoEnableProbe(probe) {
          autoEnableProbes.push({
            pluginId: record.id,
            probe,
          });
        },
      },
    });

    try {
      const result = setupRegistration.register(api);
      if (result && typeof result.then === "function") {
        // Keep setup registration sync-only.
        ignoreAsyncSetupRegisterResult(result);
      }
    } catch {
      continue;
    }
  }

  const registry = {
    providers,
    cliBackends,
    configMigrations,
    autoEnableProbes,
  } satisfies PluginSetupRegistry;
  setCachedSetupValue(setupRegistryCache, cacheKey, registry);
  return registry;
}

export function resolvePluginSetupProvider(params: {
  provider: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined {
  const cacheKey = buildSetupProviderCacheKey(params);
  const cached = getCachedSetupValue(setupProviderCache, cacheKey);
  if (cached.hit) {
    return cached.value ?? undefined;
  }

  const env = params.env ?? process.env;
  const normalizedProvider = normalizeProviderId(params.provider);
  const manifestRegistry = loadSetupManifestRegistry({
    workspaceDir: params.workspaceDir,
    env,
  });
  const record = findUniqueSetupManifestOwner({
    registry: manifestRegistry,
    normalizedId: normalizedProvider,
    listIds: listSetupProviderIds,
  });
  if (!record) {
    setCachedSetupValue(setupProviderCache, cacheKey, null);
    return undefined;
  }

  const setupRegistration = resolveSetupRegistration(record);
  if (!setupRegistration) {
    setCachedSetupValue(setupProviderCache, cacheKey, null);
    return undefined;
  }

  let matchedProvider: ProviderPlugin | undefined;
  const localProviderKeys = new Set<string>();
  const api = buildSetupPluginApi({
    record,
    setupSource: setupRegistration.setupSource,
    handlers: {
      registerProvider(provider) {
        const key = normalizeProviderId(provider.id);
        if (localProviderKeys.has(key)) {
          return;
        }
        localProviderKeys.add(key);
        if (matchesProvider(provider, normalizedProvider)) {
          matchedProvider = provider;
        }
      },
      registerConfigMigration() {},
      registerAutoEnableProbe() {},
    },
  });

  try {
    const result = setupRegistration.register(api);
    if (result && typeof result.then === "function") {
      // Keep setup registration sync-only.
      ignoreAsyncSetupRegisterResult(result);
    }
  } catch {
    setCachedSetupValue(setupProviderCache, cacheKey, null);
    return undefined;
  }

  setCachedSetupValue(setupProviderCache, cacheKey, matchedProvider ?? null);
  return matchedProvider;
}

export function resolvePluginSetupCliBackend(params: {
  backend: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): SetupCliBackendEntry | undefined {
  const cacheKey = buildSetupCliBackendCacheKey(params);
  const cached = getCachedSetupValue(setupCliBackendCache, cacheKey);
  if (cached.hit) {
    return cached.value ?? undefined;
  }

  const normalized = normalizeProviderId(params.backend);

  const env = params.env ?? process.env;
  // Narrow setup lookup from manifest-owned descriptors before executing any
  // plugin setup module. This avoids booting every setup-api just to find one
  // backend owner.
  const manifestRegistry = loadSetupManifestRegistry({
    workspaceDir: params.workspaceDir,
    env,
  });
  const record = findUniqueSetupManifestOwner({
    registry: manifestRegistry,
    normalizedId: normalized,
    listIds: listSetupCliBackendIds,
  });
  if (!record) {
    setCachedSetupValue(setupCliBackendCache, cacheKey, null);
    return undefined;
  }

  const setupRegistration = resolveSetupRegistration(record);
  if (!setupRegistration) {
    setCachedSetupValue(setupCliBackendCache, cacheKey, null);
    return undefined;
  }

  let matchedBackend: CliBackendPlugin | undefined;
  const localBackendKeys = new Set<string>();
  const api = buildSetupPluginApi({
    record,
    setupSource: setupRegistration.setupSource,
    handlers: {
      registerProvider() {},
      registerConfigMigration() {},
      registerAutoEnableProbe() {},
      registerCliBackend(backend) {
        const key = normalizeProviderId(backend.id);
        if (localBackendKeys.has(key)) {
          return;
        }
        localBackendKeys.add(key);
        if (key === normalized) {
          matchedBackend = backend;
        }
      },
    },
  });

  try {
    const result = setupRegistration.register(api);
    if (result && typeof result.then === "function") {
      // Keep setup registration sync-only.
      ignoreAsyncSetupRegisterResult(result);
    }
  } catch {
    setCachedSetupValue(setupCliBackendCache, cacheKey, null);
    return undefined;
  }

  const resolvedEntry = matchedBackend ? { pluginId: record.id, backend: matchedBackend } : null;
  setCachedSetupValue(setupCliBackendCache, cacheKey, resolvedEntry);
  return resolvedEntry ?? undefined;
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
}): SetupAutoEnableReason[] {
  const env = params.env ?? process.env;
  const reasons: SetupAutoEnableReason[] = [];
  const seen = new Set<string>();

  for (const entry of resolvePluginSetupRegistry({
    workspaceDir: params.workspaceDir,
    env,
    pluginIds: params.pluginIds,
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
