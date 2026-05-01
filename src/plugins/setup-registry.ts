import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildPluginApi } from "./api-builder.js";
import { collectPluginConfigContractMatches } from "./config-contracts.js";
import { getCachedPluginJitiLoader, type PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
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

export type PluginSetupRegistryDiagnosticCode =
  | "setup-descriptor-runtime-disabled"
  | "setup-descriptor-provider-missing-runtime"
  | "setup-descriptor-provider-runtime-undeclared"
  | "setup-descriptor-cli-backend-missing-runtime"
  | "setup-descriptor-cli-backend-runtime-undeclared";

export type PluginSetupRegistryDiagnostic = {
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

const EMPTY_RUNTIME = {} as PluginRuntime;
const NOOP_LOGGER: PluginLogger = {
  info() {},
  warn() {},
  error() {},
};

const jitiLoaders: PluginJitiLoaderCache = new Map();

export const __testing = {
  get maxSetupLookupCacheEntries() {
    return 0;
  },
  setMaxSetupLookupCacheEntriesForTest(_value?: number) {},
  getCacheSizes() {
    return {
      setupRegistry: 0,
      setupProvider: 0,
      setupCliBackend: 0,
    };
  },
} as const;

export function clearPluginSetupRegistryCache(): void {
  jitiLoaders.clear();
}

function getJiti(modulePath: string) {
  return getCachedPluginJitiLoader({
    cache: jitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
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
  const registry = loadSetupManifestRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
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

function resolveLoadableSetupRuntimeSource(record: PluginManifestRecord): string | null {
  return record.setupSource ?? resolveSetupApiPath(record.rootDir);
}

function resolveDeclaredSetupRuntimeSource(record: PluginManifestRecord): string | null {
  return (
    record.setupSource ??
    resolveSetupApiPath(record.rootDir, {
      includeBundledSourceFallback: false,
    })
  );
}

function resolveSetupRegistration(record: PluginManifestRecord): {
  setupSource: string;
  register: (api: ReturnType<typeof buildPluginApi>) => void | Promise<void>;
} | null {
  if (record.setup?.requiresRuntime === false) {
    return null;
  }
  const setupSource = resolveLoadableSetupRuntimeSource(record);
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

function loadSetupManifestRegistry(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}) {
  const env = params?.env ?? process.env;
  return loadPluginManifestRegistryForPluginRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env,
    pluginIds: params?.pluginIds,
    includeDisabled: true,
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
    for (const declaredId of declaredProviderIds) {
      if (!params.providers.some((provider) => matchesProvider(provider, declaredId))) {
        params.diagnostics.push({
          pluginId: params.record.id,
          code: "setup-descriptor-provider-missing-runtime",
          declaredId,
          message: `setup.providers declares "${declaredId}" but setup runtime did not register a matching provider.`,
        });
      }
    }
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
}): PluginSetupRegistry {
  const env = params?.env ?? process.env;
  const scopedPluginIds = params?.pluginIds
    ? new Set(params.pluginIds.map((pluginId) => pluginId.trim()).filter(Boolean))
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

  const providers: SetupProviderEntry[] = [];
  const cliBackends: SetupCliBackendEntry[] = [];
  const configMigrations: SetupConfigMigrationEntry[] = [];
  const autoEnableProbes: SetupAutoEnableProbeEntry[] = [];
  const diagnostics: PluginSetupRegistryDiagnostic[] = [];
  const providerKeys = new Set<string>();
  const cliBackendKeys = new Set<string>();

  const manifestRegistry = loadSetupManifestRegistry({
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
    const setupRegistration = resolveSetupRegistration(record);
    if (!setupRegistration) {
      continue;
    }

    const recordProviders: ProviderPlugin[] = [];
    const recordCliBackends: CliBackendPlugin[] = [];
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
          recordProviders.push(provider);
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
          recordCliBackends.push(backend);
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
    pushSetupDescriptorDriftDiagnostics({
      record,
      providers: recordProviders,
      cliBackends: recordCliBackends,
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
  return registry;
}

export function resolvePluginSetupProvider(params: {
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

  const setupRegistration = resolveSetupRegistration(record);
  if (!setupRegistration) {
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
    return undefined;
  }

  return matchedProvider;
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

  const setupRegistration = resolveSetupRegistration(record);
  if (!setupRegistration) {
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
    return undefined;
  }

  const resolvedEntry = matchedBackend ? { pluginId: record.id, backend: matchedBackend } : null;
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
}): SetupAutoEnableReason[] {
  const env = params.env ?? process.env;
  const reasons: SetupAutoEnableReason[] = [];
  const seen = new Set<string>();

  for (const entry of resolvePluginSetupRegistry({
    config: params.config,
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
