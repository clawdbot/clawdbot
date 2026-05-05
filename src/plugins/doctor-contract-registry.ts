import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { asNullableRecord } from "../shared/record-coerce.js";
import type { DoctorSessionRouteStateOwner } from "./doctor-session-route-state-owner-types.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
  type PluginModuleLoaderCache,
} from "./plugin-module-loader-cache.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"] as const;
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT =
  CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
  CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);

type PluginDoctorContractModule = {
  legacyConfigRules?: unknown;
  normalizeCompatibilityConfig?: unknown;
  sessionRouteStateOwners?: unknown;
};

type PluginDoctorCompatibilityMutation = {
  config: OpenClawConfig;
  changes: string[];
};

type PluginDoctorCompatibilityNormalizer = (params: {
  cfg: OpenClawConfig;
}) => PluginDoctorCompatibilityMutation;

type PluginDoctorContractEntry = {
  pluginId: string;
  rules: LegacyConfigRule[];
  normalizeCompatibilityConfig?: PluginDoctorCompatibilityNormalizer;
  sessionRouteStateOwners: DoctorSessionRouteStateOwner[];
};

type PluginManifestRegistryRecord = PluginManifestRegistry["plugins"][number];

const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();

function loadPluginDoctorContractModule(modulePath: string): PluginDoctorContractModule {
  return getCachedPluginModuleLoader({
    cache: moduleLoaders,
    modulePath,
    importerUrl: import.meta.url,
  })(modulePath) as PluginDoctorContractModule;
}

function resolveContractApiPath(rootDir: string): string | null {
  const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
    ? CONTRACT_API_EXTENSIONS
    : ([...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)] as const);
  for (const extension of orderedExtensions) {
    const candidate = path.join(rootDir, `doctor-contract-api${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  for (const extension of orderedExtensions) {
    const candidate = path.join(rootDir, `contract-api${extension}`);
    if (fs.existsSync(candidate)) {
      return candidate;
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

function normalizeTrimmedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim());
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

function hasLegacyElevenLabsTalkFields(raw: unknown): boolean {
  const talk = asNullableRecord(asNullableRecord(raw)?.talk);
  if (!talk) {
    return false;
  }
  return ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"].some((key) =>
    Object.prototype.hasOwnProperty.call(talk, key),
  );
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
  const sessionRouteStateOwners = coerceDoctorSessionRouteStateOwners(
    mod.sessionRouteStateOwners ??
      (mod as { default?: PluginDoctorContractModule }).default?.sessionRouteStateOwners,
  );
  if (rules.length === 0 && !normalizeCompatibilityConfig && sessionRouteStateOwners.length === 0) {
    return null;
  }
  return {
    pluginId: record.id,
    rules,
    normalizeCompatibilityConfig,
    sessionRouteStateOwners,
  };
}

function resolvePluginDoctorContracts(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): PluginDoctorContractEntry[] {
  const env = params?.env ?? process.env;
  if (params?.pluginIds && params.pluginIds.length === 0) {
    return [];
  }

  const manifestRegistry = loadPluginManifestRegistryForPluginRegistry({
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

export function clearPluginDoctorContractRegistryCache(): void {
  moduleLoaders.clear();
}

export function listPluginDoctorLegacyConfigRules(params?: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): LegacyConfigRule[] {
  return resolvePluginDoctorContracts(params).flatMap((entry) => entry.rules);
}

export function listPluginDoctorSessionRouteStateOwners(params?: {
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

export function applyPluginDoctorCompatibilityMigrations(
  cfg: OpenClawConfig,
  params?: {
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
