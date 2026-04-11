import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginApi } from "./api-builder.js";
import { collectPluginConfigContractMatches } from "./config-contracts.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { getCachedPluginJitiLoader, type PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
import type { PluginRuntime } from "./runtime/types.js";
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

const EMPTY_RUNTIME = {} as PluginRuntime;
const NOOP_LOGGER: PluginLogger = {
  info() {},
  warn() {},
  error() {},
};

const jitiLoaders: PluginJitiLoaderCache = new Map();
const setupRegistryCache = new Map<string, PluginSetupRegistry>();
const setupProviderCache = new Map<string, ProviderPlugin | null>();

export function clearPluginSetupRegistryCache(): void {
  jitiLoaders.clear();
  setupRegistryCache.clear();
  setupProviderCache.clear();
}

function getJiti(modulePath: string) {
  return getCachedPluginJitiLoader({
    cache: jitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
  });
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

function matchesProvider(provider: ProviderPlugin, providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  if (normalizeProviderId(provider.id) === normalized) {
    return true;
  }
  return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some(
    (alias) => normalizeProviderId(alias) === normalized,
  );
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
  const cached = setupRegistryCache.get(cacheKey);
  if (cached) {
    return cached;
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
    setupRegistryCache.set(cacheKey, empty);
    return empty;
  }

  const providers: SetupProviderEntry[] = [];
  const cliBackends: SetupCliBackendEntry[] = [];
  const configMigrations: SetupConfigMigrationEntry[] = [];
  const autoEnableProbes: SetupAutoEnableProbeEntry[] = [];
  const providerKeys = new Set<string>();
  const cliBackendKeys = new Set<string>();

  const discovery = discoverOpenClawPlugins({
    workspaceDir: params?.workspaceDir,
    env,
    cache: true,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    workspaceDir: params?.workspaceDir,
    env,
    cache: true,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });

  for (const record of manifestRegistry.plugins) {
    if (selectedPluginIds && !selectedPluginIds.has(record.id)) {
      continue;
    }
    const setupSource = record.setupSource ?? resolveSetupApiPath(record.rootDir);
    if (!setupSource) {
      continue;
    }

    let mod: OpenClawPluginModule;
    try {
      mod = getJiti(setupSource)(setupSource) as OpenClawPluginModule;
    } catch {
      continue;
    }

    const resolved = resolveRegister((mod as { default?: OpenClawPluginModule }).default ?? mod);
    if (!resolved.register) {
      continue;
    }
    if (resolved.definition?.id && resolved.definition.id !== record.id) {
      continue;
    }

    const api = buildPluginApi({
      id: record.id,
      name: record.name ?? record.id,
      version: record.version,
      description: record.description,
      source: setupSource,
      rootDir: record.rootDir,
      registrationMode: "setup-only",
      config: {} as OpenClawConfig,
      runtime: EMPTY_RUNTIME,
      logger: NOOP_LOGGER,
      resolvePath: (input) => input,
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
      const result = resolved.register(api);
      if (result && typeof result.then === "function") {
        // Keep setup registration sync-only.
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
  setupRegistryCache.set(cacheKey, registry);
  return registry;
}

export function resolvePluginSetupProvider(params: {
  provider: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin | undefined {
  const cacheKey = buildSetupProviderCacheKey(params);
  if (setupProviderCache.has(cacheKey)) {
    return setupProviderCache.get(cacheKey) ?? undefined;
  }

  const env = params.env ?? process.env;
  const normalizedProvider = normalizeProviderId(params.provider);
  const discovery = discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    env,
    cache: true,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    workspaceDir: params.workspaceDir,
    env,
    cache: true,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  const record = manifestRegistry.plugins.find((entry) =>
    entry.providers.some((providerId) => normalizeProviderId(providerId) === normalizedProvider),
  );
  if (!record) {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }

  const setupSource = record.setupSource ?? resolveSetupApiPath(record.rootDir);
  if (!setupSource) {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }

  let mod: OpenClawPluginModule;
  try {
    mod = getJiti(setupSource)(setupSource) as OpenClawPluginModule;
  } catch {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }

  const resolved = resolveRegister((mod as { default?: OpenClawPluginModule }).default ?? mod);
  if (!resolved.register) {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }
  if (resolved.definition?.id && resolved.definition.id !== record.id) {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }

  let matchedProvider: ProviderPlugin | undefined;
  const localProviderKeys = new Set<string>();
  const api = buildPluginApi({
    id: record.id,
    name: record.name ?? record.id,
    version: record.version,
    description: record.description,
    source: setupSource,
    rootDir: record.rootDir,
    registrationMode: "setup-only",
    config: {} as OpenClawConfig,
    runtime: EMPTY_RUNTIME,
    logger: NOOP_LOGGER,
    resolvePath: (input) => input,
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
    const result = resolved.register(api);
    if (result && typeof result.then === "function") {
      // Keep setup registration sync-only.
    }
  } catch {
    setupProviderCache.set(cacheKey, null);
    return undefined;
  }

  setupProviderCache.set(cacheKey, matchedProvider ?? null);
  return matchedProvider;
}

export function resolvePluginSetupCliBackend(params: {
  backend: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): SetupCliBackendEntry | undefined {
  const normalized = normalizeProviderId(params.backend);
  const direct = resolvePluginSetupRegistry(params).cliBackends.find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
  if (direct) {
    return direct;
  }

  const env = params.env ?? process.env;
  const discovery = discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    env,
    cache: true,
  });
  const manifestRegistry = loadPluginManifestRegistry({
    workspaceDir: params.workspaceDir,
    env,
    cache: true,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  const record = manifestRegistry.plugins.find((entry) =>
    entry.cliBackends.some((backendId) => normalizeProviderId(backendId) === normalized),
  );
  if (!record) {
    return undefined;
  }

  const setupSource = record.setupSource ?? resolveSetupApiPath(record.rootDir);
  if (!setupSource) {
    return undefined;
  }

  let mod: OpenClawPluginModule;
  try {
    mod = getJiti(setupSource)(setupSource) as OpenClawPluginModule;
  } catch {
    return undefined;
  }
  const resolved = resolveRegister((mod as { default?: OpenClawPluginModule }).default ?? mod);
  if (!resolved.register) {
    return undefined;
  }
  if (resolved.definition?.id && resolved.definition.id !== record.id) {
    return undefined;
  }

  let matchedBackend: CliBackendPlugin | undefined;
  const localBackendKeys = new Set<string>();
  const api = buildPluginApi({
    id: record.id,
    name: record.name ?? record.id,
    version: record.version,
    description: record.description,
    source: setupSource,
    rootDir: record.rootDir,
    registrationMode: "setup-only",
    config: {} as OpenClawConfig,
    runtime: EMPTY_RUNTIME,
    logger: NOOP_LOGGER,
    resolvePath: (input) => input,
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
    const result = resolved.register(api);
    if (result && typeof result.then === "function") {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return matchedBackend ? { pluginId: record.id, backend: matchedBackend } : undefined;
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
}): SetupAutoEnableReason[] {
  const env = params.env ?? process.env;
  const reasons: SetupAutoEnableReason[] = [];
  const seen = new Set<string>();

  for (const entry of resolvePluginSetupRegistry({
    workspaceDir: params.workspaceDir,
    env,
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
