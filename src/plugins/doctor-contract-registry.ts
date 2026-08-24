// Loads plugin doctor contracts from manifest-owned metadata.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { isChannelConfigMetadataKey } from "../channels/config-metadata.js";
import { shouldIncludeChannelSetupFeatureForConfig } from "../channels/plugins/bundled-setup-policy.js";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { BundledChannelSetupEntryContract } from "../plugin-sdk/channel-entry-contract.js";
import type { BundledChannelLegacyStateMigrationDetector } from "../plugin-sdk/channel-entry-contract.types.js";
import { definePluginDoctorMigrationFromPlans } from "../plugin-sdk/doctor-migration-plan-adapter.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolvePluginDoctorContractArtifactPath } from "./doctor-contract-artifact.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
  type PluginDoctorStateMigration,
} from "./doctor-contract-module.js";
import { pluginDoctorContractRegistryLoaderState } from "./doctor-contract-registry-loader-state.js";
import type { DoctorSessionRouteStateOwner } from "./doctor-session-route-state-owner-types.js";
import { isActivatedManifestOwner } from "./manifest-owner-policy.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginManifestDoctorContract } from "./manifest-types.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

const log = createSubsystemLogger("plugins/doctor-contracts");

type PluginDoctorContractSurface = keyof PluginManifestDoctorContract;

export type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
  PluginDoctorStateMigrationDetection,
} from "./doctor-contract-module.js";

type PluginDoctorContractEntry = {
  pluginId: string;
  rules: LegacyConfigRule[];
  normalizeCompatibilityConfig?: ReturnType<
    typeof coercePluginDoctorContractModule
  >["normalizeCompatibilityConfig"];
  resolveSessionStoreAgentIds?: ReturnType<
    typeof coercePluginDoctorContractModule
  >["resolveSessionStoreAgentIds"];
  sessionRouteStateOwners: DoctorSessionRouteStateOwner[];
  stateMigrations: PluginDoctorStateMigration[];
};

type PluginDoctorStateMigrationEntry = {
  pluginId: string;
  migration: PluginDoctorStateMigration;
};

type PluginManifestRegistryRecord = PluginManifestRegistry["plugins"][number];

function loadPluginDoctorContractModule(params: {
  modulePath: string;
  rootDir: string;
}): PluginDoctorContractModule {
  pluginDoctorContractRegistryLoaderState.moduleRoots.set(params.modulePath, params.rootDir);
  return getCachedPluginModuleLoader({
    cache: pluginDoctorContractRegistryLoaderState.moduleLoaders,
    modulePath: params.modulePath,
    importerUrl: import.meta.url,
    ...(pluginDoctorContractRegistryLoaderState.moduleLoaderFactory
      ? { createLoader: pluginDoctorContractRegistryLoaderState.moduleLoaderFactory }
      : {}),
  })(params.modulePath) as PluginDoctorContractModule;
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
  // Keep legacy lists visible until the doctor migration window closes so
  // provider-owned repairs can run in the same pass as core consolidation.
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

function collectConfiguredModelProviderIds(params: {
  root: Record<string, unknown>;
  ids: Set<string>;
}): void {
  const addRef = (value: unknown) => {
    const parsed = typeof value === "string" ? parseProviderModelRef(value) : null;
    if (parsed) {
      params.ids.add(normalizeProviderId(parsed.provider));
    }
  };
  for (const ref of collectConfiguredModelRefs(params.root)) {
    addRef(ref.value);
  }
  const collectAgentPolicy = (value: unknown) => {
    const allow = asNullableRecord(asNullableRecord(value)?.modelPolicy)?.allow;
    if (Array.isArray(allow)) {
      allow.forEach(addRef);
    }
  };
  const agents = asNullableRecord(params.root.agents) ?? {};
  collectAgentPolicy(agents.defaults);
  if (Object.hasOwn(agents, "entries")) {
    const entries = asNullableRecord(agents.entries);
    if (entries) {
      Object.values(entries).forEach(collectAgentPolicy);
    }
  } else if (Array.isArray(agents.list)) {
    agents.list.forEach(collectAgentPolicy);
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
    for (const rawChannelId of Object.keys(channels)) {
      const channelId = rawChannelId.trim();
      if (channelId && !isChannelConfigMetadataKey(channelId)) {
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
  collectConfiguredModelProviderIds({ root, ids });

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
  collectConfiguredModelProviderIds({ root, ids });
  for (const touchedPath of params.touchedPaths) {
    const [first, second, third] = touchedPath;
    if (first === "channels") {
      if (!second) {
        return collectRelevantDoctorPluginIds(params.raw);
      }
      const channelId = second.trim();
      if (channelId && !isChannelConfigMetadataKey(channelId)) {
        ids.add(channelId);
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
  const contractSource = resolvePluginDoctorContractArtifactPath(record.rootDir);
  if (!contractSource) {
    return null;
  }
  let mod: PluginDoctorContractModule;
  try {
    mod = loadPluginDoctorContractModule({ modulePath: contractSource, rootDir: record.rootDir });
  } catch (error) {
    log.warn(
      `failed to load doctor contract for ${record.id} from ${contractSource}: ${formatErrorMessage(error)}`,
    );
    return null;
  }
  const { summary, ...contract } = coercePluginDoctorContractModule(mod);
  if (!Object.values(summary).some(Boolean)) {
    return null;
  }
  return {
    pluginId: record.id,
    ...contract,
  };
}

function resolvePluginDoctorManifestRecords(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): PluginManifestRegistryRecord[] {
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

  const scopedPluginIds = params?.pluginIds ? new Set(params.pluginIds) : null;
  return manifestRegistry.plugins.filter(
    (record) =>
      !(
        scopedPluginIds &&
        !scopedPluginIds.has(record.id) &&
        !(record.packageName && scopedPluginIds.has(record.packageName)) &&
        !record.legacyPluginIds?.some((pluginId) => scopedPluginIds.has(pluginId)) &&
        !record.channels.some((channelId) => scopedPluginIds.has(channelId)) &&
        !record.providers.some((providerId) => scopedPluginIds.has(providerId))
      ),
  );
}

function resolvePluginDoctorContracts(params: {
  surface: PluginDoctorContractSurface;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): PluginDoctorContractEntry[] {
  return loadPluginDoctorContractEntries({
    records: resolvePluginDoctorManifestRecords(params),
    surface: params.surface,
  });
}

function loadPluginDoctorContractEntries(params: {
  records: PluginManifestRegistryRecord[];
  surface: PluginDoctorContractSurface;
}): PluginDoctorContractEntry[] {
  const entries: PluginDoctorContractEntry[] = [];
  for (const record of params.records) {
    const declaration = record.doctorContract;
    // Declarations gate loading only; modules remain authoritative, while absence preserves loading.
    if (declaration && declaration[params.surface] !== true) {
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
  return resolvePluginDoctorContracts({
    ...params,
    surface: "configRepair",
  }).flatMap((entry) => entry.rules);
}

export function listPluginDoctorSessionRouteStateOwners(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): DoctorSessionRouteStateOwner[] {
  const owners = new Map<string, DoctorSessionRouteStateOwner>();
  const records = resolvePluginDoctorManifestRecords(params ?? {});
  const manifestOwners = records.flatMap((record) => record.sessionRouteStateOwners ?? []);
  const legacyModuleOwners = loadPluginDoctorContractEntries({
    records: records.filter((record) => record.sessionRouteStateOwners === undefined),
    surface: "sessionRouteStateOwners",
  }).flatMap((entry) => entry.sessionRouteStateOwners);
  for (const owner of [...manifestOwners, ...legacyModuleOwners]) {
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
  for (const entry of resolvePluginDoctorContracts({
    ...params,
    surface: "resolveSessionStoreAgentIds",
  })) {
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

function loadLegacyChannelStateMigrationDetector(
  record: PluginManifestRegistryRecord,
): BundledChannelLegacyStateMigrationDetector | null {
  if (!record.setupSource) {
    return null;
  }
  try {
    const entry = unwrapDefaultModuleExport(
      loadPluginDoctorContractModule({
        modulePath: record.setupSource,
        rootDir: record.rootDir,
      }),
    ) as Partial<BundledChannelSetupEntryContract> | null;
    if (
      entry?.kind !== "bundled-channel-setup-entry" ||
      typeof entry.loadSetupPlugin !== "function"
    ) {
      return null;
    }
    const directDetector =
      typeof entry.loadLegacyStateMigrationDetector === "function"
        ? entry.loadLegacyStateMigrationDetector()
        : undefined;
    if (typeof directDetector === "function") {
      return directDetector;
    }
    if (entry.features?.legacyStateMigrations !== true) {
      return null;
    }
    const lifecycleDetector = entry.loadSetupPlugin().lifecycle?.detectLegacyStateMigrations;
    return typeof lifecycleDetector === "function" ? lifecycleDetector : null;
  } catch (error) {
    log.warn(
      `failed to load legacy state migration for ${record.id} from ${record.setupSource}: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}

export function listPluginDoctorStateMigrationEntries(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
}): PluginDoctorStateMigrationEntry[] {
  const entries: PluginDoctorStateMigrationEntry[] = [];
  const normalizedConfig = normalizePluginsConfig(params?.config?.plugins);
  for (const record of resolvePluginDoctorManifestRecords(params ?? {})) {
    const channelOwner = record.channels.length > 0;
    // Config repair intentionally includes disabled plugins; channel state must never be moved
    // after its operator has disabled the owning plugin or every configured channel.
    if (
      channelOwner &&
      !shouldIncludeChannelSetupFeatureForConfig({ plugin: record, config: params?.config })
    ) {
      continue;
    }
    // Trusted bundled non-channel migrations remain available while plugins are globally disabled.
    // Every non-bundled owner must pass normal activation before either artifact can execute.
    if (
      record.origin !== "bundled" &&
      !isActivatedManifestOwner({ plugin: record, normalizedConfig, rootConfig: params?.config })
    ) {
      continue;
    }

    const modernEntries = loadPluginDoctorContractEntries({
      records: [record],
      surface: "stateMigrations",
    }).flatMap((entry) =>
      entry.stateMigrations.map((migration) => ({ pluginId: entry.pluginId, migration })),
    );
    if (modernEntries.length > 0) {
      entries.push(...modernEntries);
      continue;
    }
    if (record.doctorContract?.stateMigrations === true) {
      continue;
    }
    if (!channelOwner) {
      continue;
    }

    // Released external plugins retain their own setup-entry detector through 2027.1; resolving
    // the winning manifest's validated setupSource avoids loading a shadowed bundled plugin.
    const detector = loadLegacyChannelStateMigrationDetector(record);
    if (!detector) {
      continue;
    }
    entries.push({
      pluginId: record.id,
      migration: definePluginDoctorMigrationFromPlans({
        id: `${record.id}-legacy-channel-state`,
        label: `${record.id} legacy channel state`,
        resolvePlans: detector,
      }),
    });
  }
  return entries;
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
  for (const entry of resolvePluginDoctorContracts({
    ...params,
    surface: "configRepair",
  })) {
    const mutation = entry.normalizeCompatibilityConfig?.({ cfg: nextCfg });
    if (!mutation || mutation.changes.length === 0) {
      continue;
    }
    nextCfg = mutation.config;
    changes.push(...mutation.changes);
  }
  return { config: nextCfg, changes };
}
