// Loads plugin doctor contracts from manifest-owned metadata.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import { pluginDoctorContractRegistryLoaderState } from "./doctor-contract-registry-loader-state.js";
import type { DoctorSessionRouteStateOwner } from "./doctor-session-route-state-owner-types.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type PluginDoctorContractModule = {
  legacyConfigRules?: unknown;
  normalizeCompatibilityConfig?: unknown;
  resolveSessionStoreAgentIds?: unknown;
  sessionRouteStateOwners?: unknown;
  stateMigrations?: unknown;
};

type PluginDoctorCompatibilityMutation = {
  config: OpenClawConfig;
  changes: string[];
};

type PluginDoctorCompatibilityNormalizer = (params: {
  cfg: OpenClawConfig;
}) => PluginDoctorCompatibilityMutation;

type PluginDoctorSessionStoreAgentIdsResolver = (params: {
  cfg: OpenClawConfig;
}) => readonly string[];

type PluginDoctorContractEntry = {
  pluginId: string;
  rules: LegacyConfigRule[];
  normalizeCompatibilityConfig?: PluginDoctorCompatibilityNormalizer;
  resolveSessionStoreAgentIds?: PluginDoctorSessionStoreAgentIdsResolver;
  sessionRouteStateOwners: DoctorSessionRouteStateOwner[];
  stateMigrations: PluginDoctorStateMigration[];
};

export type PluginDoctorStateMigrationDetection = {
  preview: string[];
};

export type PluginDoctorStateMigrationContext = {
  openPluginStateKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
};

export type PluginDoctorStateMigration = {
  id: string;
  label: string;
  detectLegacyState: (params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    oauthDir: string;
    context: PluginDoctorStateMigrationContext;
  }) =>
    | Promise<PluginDoctorStateMigrationDetection | null>
    | PluginDoctorStateMigrationDetection
    | null;
  migrateLegacyState: (params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    oauthDir: string;
    context: PluginDoctorStateMigrationContext;
  }) =>
    | Promise<{ changes: string[]; warnings: string[]; notices?: string[] }>
    | { changes: string[]; warnings: string[]; notices?: string[] };
};

type PluginDoctorStateMigrationEntry = {
  pluginId: string;
  migration: PluginDoctorStateMigration;
};

type PluginManifestRegistryRecord = PluginManifestRegistry["plugins"][number];

function loadPluginDoctorContractModule(modulePath: string): PluginDoctorContractModule {
  return getCachedPluginModuleLoader({
    cache: pluginDoctorContractRegistryLoaderState.moduleLoaders,
    modulePath,
    importerUrl: import.meta.url,
    ...(pluginDoctorContractRegistryLoaderState.moduleLoaderFactory
      ? { createLoader: pluginDoctorContractRegistryLoaderState.moduleLoaderFactory }
      : {}),
  })(modulePath) as PluginDoctorContractModule;
}

function resolveContractApiPath(rootDir: string): string | null {
  const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
    ? CONTRACT_API_EXTENSIONS
    : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
  for (const basename of ["doctor-contract-api", "contract-api"]) {
    for (const extension of orderedExtensions) {
      for (const baseDir of [rootDir, path.join(rootDir, "dist")]) {
        const candidate = path.join(baseDir, `${basename}${extension}`);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}

function coerceLegacyConfigRules(value: unknown): LegacyConfigRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    const candidate = entry as { path?: unknown; message?: unknown };
    return Array.isArray(candidate.path) && typeof candidate.message === "string";
  }) as LegacyConfigRule[];
}

function coerceNormalizeCompatibilityConfig(
  value: unknown,
): PluginDoctorCompatibilityNormalizer | undefined {
  return typeof value === "function" ? (value as PluginDoctorCompatibilityNormalizer) : undefined;
}

function coerceSessionStoreAgentIdsResolver(
  value: unknown,
): PluginDoctorSessionStoreAgentIdsResolver | undefined {
  return typeof value === "function"
    ? (value as PluginDoctorSessionStoreAgentIdsResolver)
    : undefined;
}

function isDoctorSessionRouteStateOwner(value: unknown): value is DoctorSessionRouteStateOwner {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    label?: unknown;
    providerIds?: unknown;
    runtimeIds?: unknown;
    cliSessionKeys?: unknown;
    authProfilePrefixes?: unknown;
  };
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    candidate.id.trim().length > 0 &&
    candidate.label.trim().length > 0 &&
    (candidate.providerIds === undefined ||
      normalizeTrimmedStringList(candidate.providerIds).length > 0) &&
    (candidate.runtimeIds === undefined ||
      normalizeTrimmedStringList(candidate.runtimeIds).length > 0) &&
    (candidate.cliSessionKeys === undefined ||
      normalizeTrimmedStringList(candidate.cliSessionKeys).length > 0) &&
    (candidate.authProfilePrefixes === undefined ||
      normalizeTrimmedStringList(candidate.authProfilePrefixes).length > 0)
  );
}

function coerceDoctorSessionRouteStateOwners(value: unknown): DoctorSessionRouteStateOwner[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isDoctorSessionRouteStateOwner).map((owner) => ({
    id: owner.id.trim(),
    label: owner.label.trim(),
    providerIds: normalizeTrimmedStringList(owner.providerIds),
    runtimeIds: normalizeTrimmedStringList(owner.runtimeIds),
    cliSessionKeys: normalizeTrimmedStringList(owner.cliSessionKeys),
    authProfilePrefixes: normalizeTrimmedStringList(owner.authProfilePrefixes),
  }));
}

function isPluginDoctorStateMigration(value: unknown): value is PluginDoctorStateMigration {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    id?: unknown;
    label?: unknown;
    detectLegacyState?: unknown;
    migrateLegacyState?: unknown;
  };
  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    typeof candidate.label === "string" &&
    candidate.label.trim().length > 0 &&
    typeof candidate.detectLegacyState === "function" &&
    typeof candidate.migrateLegacyState === "function"
  );
}

function coercePluginDoctorStateMigrations(value: unknown): PluginDoctorStateMigration[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isPluginDoctorStateMigration).map((migration) => ({
    id: migration.id.trim(),
    label: migration.label.trim(),
    detectLegacyState: migration.detectLegacyState,
    migrateLegacyState: migration.migrateLegacyState,
  }));
}

function hasLegacyElevenLabsTalkFields(raw: unknown): boolean {
  const talk = asNullableRecord(asNullableRecord(raw)?.talk);
  if (!talk) {
    return false;
  }
  return ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"].some((key) =>
    Object.hasOwn(talk, key),
  );
}

function collectMediaProviderIds(root: Record<string, unknown>, ids: Set<string>): void {
  const media = asNullableRecord(asNullableRecord(root.tools)?.media);
  if (!media) {
    return;
  }
  const modelLists = [
    media.models,
    asNullableRecord(media.audio)?.models,
    asNullableRecord(media.image)?.models,
    asNullableRecord(media.video)?.models,
  ];
  for (const models of modelLists) {
    if (!Array.isArray(models)) {
      continue;
    }
    for (const model of models) {
      const provider = asNullableRecord(model)?.provider;
      if (typeof provider === "string" && provider.trim()) {
        ids.add(normalizeProviderId(provider));
      }
    }
  }
}

export function collectRelevantDoctorPluginIds(raw: unknown): string[] {
  const ids = new Set<string>();
  const root = asNullableRecord(raw);
  if (!root) {
    return [];
  }

  const channels = asNullableRecord(root.channels);
  if (channels) {
    for (const channelId of Object.keys(channels)) {
      if (channelId !== "defaults") {
        ids.add(channelId);
      }
    }
  }

  const pluginsEntries = asNullableRecord(asNullableRecord(root.plugins)?.entries);
  if (pluginsEntries) {
    for (const pluginId of Object.keys(pluginsEntries)) {
      ids.add(pluginId);
    }
  }

  const modelProviders = asNullableRecord(asNullableRecord(root.models)?.providers);
  if (modelProviders) {
    for (const providerId of Object.keys(modelProviders)) {
      ids.add(providerId);
    }
  }

  collectMediaProviderIds(root, ids);

  if (hasLegacyElevenLabsTalkFields(root)) {
    ids.add("elevenlabs");
  }

  return [...ids].toSorted();
}

export function collectRelevantDoctorPluginIdsForTouchedPaths(params: {
  raw: unknown;
  touchedPaths: ReadonlyArray<ReadonlyArray<string>>;
}): string[] {
  const root = asNullableRecord(params.raw);
  if (!root) {
    return [];
  }

  const ids = new Set<string>();
  for (const touchedPath of params.touchedPaths) {
    const [first, second, third] = touchedPath;
    if (first === "channels") {
      if (!second) {
        return collectRelevantDoctorPluginIds(params.raw);
      }
      if (second !== "defaults") {
        ids.add(second);
      }
      continue;
    }
    if (first === "plugins") {
      if (second !== "entries" || !third) {
        return collectRelevantDoctorPluginIds(params.raw);
      }
      ids.add(third);
      continue;
    }
    if (first === "models") {
      if (second !== "providers" || !third) {
        return collectRelevantDoctorPluginIds(params.raw);
      }
      ids.add(third);
      continue;
    }
    if (first === "tools" && second === "media") {
      collectMediaProviderIds(root, ids);
      continue;
    }
    if (first === "talk" && hasLegacyElevenLabsTalkFields(root)) {
      ids.add("elevenlabs");
    }
  }

  return [...ids].toSorted();
}

function loadPluginDoctorContractEntry(
  record: PluginManifestRegistryRecord,
): PluginDoctorContractEntry | null {
  const contractSource = resolveContractApiPath(record.rootDir);
  if (!contractSource) {
    return null;
  }
  let mod: PluginDoctorContractModule;
  try {
    mod = loadPluginDoctorContractModule(contractSource);
  } catch {
    return null;
  }
  const rules = coerceLegacyConfigRules(
    (mod as { default?: PluginDoctorContractModule }).default?.legacyConfigRules ??
      mod.legacyConfigRules,
  );
  const normalizeCompatibilityConfig = coerceNormalizeCompatibilityConfig(
    mod.normalizeCompatibilityConfig ??
      (mod as { default?: PluginDoctorContractModule }).default?.normalizeCompatibilityConfig,
  );
  const resolveSessionStoreAgentIds = coerceSessionStoreAgentIdsResolver(
    mod.resolveSessionStoreAgentIds ??
      (mod as { default?: PluginDoctorContractModule }).default?.resolveSessionStoreAgentIds,
  );
  const sessionRouteStateOwners = coerceDoctorSessionRouteStateOwners(
    mod.sessionRouteStateOwners ??
      (mod as { default?: PluginDoctorContractModule }).default?.sessionRouteStateOwners,
  );
  const stateMigrations = coercePluginDoctorStateMigrations(
    mod.stateMigrations ??
      (mod as { default?: PluginDoctorContractModule }).default?.stateMigrations,
  );
  if (
    rules.length === 0 &&
    !normalizeCompatibilityConfig &&
    !resolveSessionStoreAgentIds &&
    sessionRouteStateOwners.length === 0 &&
    stateMigrations.length === 0
  ) {
    return null;
  }
  return {
    pluginId: record.id,
    rules,
    normalizeCompatibilityConfig,
    resolveSessionStoreAgentIds,
    sessionRouteStateOwners,
    stateMigrations,
  };
}

function resolvePluginDoctorContracts(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): PluginDoctorContractEntry[] {
  const env = params?.env ?? process.env;
  if (params?.pluginIds && params.pluginIds.length === 0) {
    return [];
  }

  const manifestRegistry = loadPluginManifestRegistryForPluginRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env,
    includeDisabled: true,
  });

  const entries: PluginDoctorContractEntry[] = [];
  const scopedPluginIds = params?.pluginIds ? new Set(params.pluginIds) : null;
  for (const record of manifestRegistry.plugins) {
    if (
      scopedPluginIds &&
      !scopedPluginIds.has(record.id) &&
      !(record.packageName && scopedPluginIds.has(record.packageName)) &&
      !record.legacyPluginIds?.some((pluginId) => scopedPluginIds.has(pluginId)) &&
      !record.channels.some((channelId) => scopedPluginIds.has(channelId)) &&
      !record.providers.some((providerId) => scopedPluginIds.has(providerId))
    ) {
      continue;
    }
    const entry = loadPluginDoctorContractEntry(record);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}
export function listPluginDoctorLegacyConfigRules(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): LegacyConfigRule[] {
  return resolvePluginDoctorContracts(params).flatMap((entry) => entry.rules);
}

export function listPluginDoctorSessionRouteStateOwners(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): DoctorSessionRouteStateOwner[] {
  const owners = new Map<string, DoctorSessionRouteStateOwner>();
  for (const owner of resolvePluginDoctorContracts(params).flatMap(
    (entry) => entry.sessionRouteStateOwners,
  )) {
    if (!owners.has(owner.id)) {
      owners.set(owner.id, owner);
    }
  }
  return [...owners.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

/** Resolve plugin-owned agent IDs whose core session stores need migration. */
export function listPluginDoctorSessionStoreAgentIds(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): string[] {
  const cfg = params?.config ?? {};
  const agentIds = new Set<string>();
  for (const entry of resolvePluginDoctorContracts(params)) {
    let resolved: readonly string[] | undefined;
    try {
      resolved = entry.resolveSessionStoreAgentIds?.({ cfg });
    } catch {
      // A plugin-owned hint must never block core startup migration.
      continue;
    }
    for (const agentId of normalizeTrimmedStringList(resolved)) {
      agentIds.add(agentId);
    }
  }
  return [...agentIds].toSorted();
}

export function listPluginDoctorStateMigrationEntries(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): PluginDoctorStateMigrationEntry[] {
  return resolvePluginDoctorContracts(params).flatMap((entry) =>
    entry.stateMigrations.map((migration) => ({
      pluginId: entry.pluginId,
      migration,
    })),
  );
}

export function applyPluginDoctorCompatibilityMigrations(
  cfg: OpenClawConfig,
  params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    pluginIds?: readonly string[];
  },
): {
  config: OpenClawConfig;
  changes: string[];
} {
  let nextCfg = cfg;
  const changes: string[] = [];
  for (const entry of resolvePluginDoctorContracts(params)) {
    const mutation = entry.normalizeCompatibilityConfig?.({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    nextCfg = mutation.config;
    changes.push(...mutation.changes);
  }
  return { config: nextCfg, changes };
}
