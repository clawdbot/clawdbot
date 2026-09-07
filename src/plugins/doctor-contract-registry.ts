// Loads plugin doctor contracts from manifest-owned metadata.
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { shouldIncludeChannelSetupFeatureForConfig } from "../channels/plugins/bundled-setup-policy.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import { discoverConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { LegacyConfigRule } from "../config/legacy.shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { BundledChannelSetupEntryContract } from "../plugin-sdk/channel-entry-contract.js";
import type { BundledChannelLegacyStateMigrationDetector } from "../plugin-sdk/channel-entry-contract.types.js";
import { definePluginDoctorMigrationFromPlans } from "../plugin-sdk/doctor-migration-plan-adapter.js";
import { areBundledPluginsDisabled } from "./bundled-dir.js";
import { resolveBundledPluginScanDir } from "./bundled-plugin-scan.js";
import { hasPluginConfigMigrationSource } from "./config-contract-matches.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolvePluginDoctorContractArtifactPath } from "./doctor-contract-artifact.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
  type PluginDoctorStateMigration,
} from "./doctor-contract-module.js";
import { pluginDoctorContractRegistryLoaderState } from "./doctor-contract-registry-loader-state.js";
import {
  collectRelevantDoctorPluginIds,
  collectRelevantDoctorPluginIdsForTouchedPaths,
} from "./doctor-contract-relevance.js";
import type { DoctorSessionRouteStateOwner } from "./doctor-session-route-state-owner-types.js";
import { isActivatedManifestOwner } from "./manifest-owner-policy.js";
import {
  loadBundledPluginManifestRegistry,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import type { PluginManifestDoctorContract } from "./manifest-types.js";
import { unwrapDefaultModuleExport } from "./module-export.js";
import { getCachedPluginModuleLoader } from "./plugin-module-loader-cache.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import { loadBundledPluginPublicArtifactModuleFromCandidatesSync } from "./public-surface-loader.js";

export { collectRelevantDoctorPluginIds } from "./doctor-contract-relevance.js";

const log = createSubsystemLogger("plugins/doctor-contracts");

type PluginDoctorContractSurface = keyof PluginManifestDoctorContract;

function declaresPluginDoctorContractSurface(
  declaration: PluginManifestDoctorContract | undefined,
  surface: PluginDoctorContractSurface,
): boolean {
  const value = declaration?.[surface];
  return value === true || (surface === "stateMigrations" && Array.isArray(value));
}

export type {
  PluginDoctorStateMigration,
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
  channelIds: string[];
  /**
   * Mirrors the runtime proxy's durable-store gate: only bundled plugins and trusted
   * official installs may reach channel ingress queues. Doctor must not become a way
   * around that for an activated workspace plugin.
   */
  trustedForDurableStores?: boolean;
  migration: PluginDoctorStateMigration;
};

function isTrustedForDurableStores(record: PluginManifestRegistryRecord): boolean {
  return record.origin === "bundled" || record.trustedOfficialInstall === true;
}

type PluginManifestRegistryRecord = PluginManifestRegistry["plugins"][number];

function loadPluginDoctorContractModule(params: {
  modulePath: string;
  rootDir: string;
}): PluginDoctorContractModule {
  return getCachedPluginModuleLoader({
    modulePath: params.modulePath,
    rootDir: params.rootDir,
    importerUrl: import.meta.url,
    ...(pluginDoctorContractRegistryLoaderState.moduleLoaderFactory
      ? { createLoader: pluginDoctorContractRegistryLoaderState.moduleLoaderFactory }
      : {}),
  })(params.modulePath) as PluginDoctorContractModule;
}

function hasScopedProviderAuthAlias(
  record: PluginManifestRegistryRecord,
  scopedProviderIds: ReadonlySet<string>,
): boolean {
  return Object.entries(record.providerAuthAliases ?? {}).some(([rawAlias, rawTarget]) => {
    const target = normalizeProviderId(rawTarget);
    return (
      scopedProviderIds.has(normalizeProviderId(rawAlias)) &&
      target !== "" &&
      record.providers.some((providerId) => normalizeProviderId(providerId) === target)
    );
  });
}

/** Include manifest-owned legacy roots for config repair, never session ownership. */
export function collectDoctorConfigRepairPluginIds(
  raw: unknown,
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
): string[] {
  const config = asNullableRecord(raw);
  if (!config) {
    return [];
  }
  const ids = new Set(
    touchedPaths
      ? collectRelevantDoctorPluginIdsForTouchedPaths({ raw, touchedPaths })
      : collectRelevantDoctorPluginIds(raw),
  );
  const registry = loadPluginManifestRegistryForPluginRegistry({
    config,
    includeDisabled: true,
  });
  for (const plugin of registry.plugins) {
    if (
      hasPluginConfigMigrationSource({
        root: raw,
        pathPatterns: plugin.configContracts?.compatibilityMigrationPaths,
        touchedPaths,
      })
    ) {
      ids.add(plugin.id);
    }
  }
  return [...ids].toSorted();
}

function loadPluginDoctorContractEntry(
  record: PluginManifestRegistryRecord,
  surface: PluginDoctorContractSurface,
): PluginDoctorContractEntry | null {
  const declaration = record.doctorContract;
  // Declarations gate loading only; modules remain authoritative, while absence preserves loading.
  if (declaration && !declaresPluginDoctorContractSurface(declaration, surface)) {
    return null;
  }
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
  artifactPreservingReadOnly?: boolean;
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
    artifactPreservingReadOnly: params.artifactPreservingReadOnly,
  });

  return filterPluginDoctorRecordsByScope(manifestRegistry.plugins, params.pluginIds);
}

function filterPluginDoctorRecordsByScope(
  records: readonly PluginManifestRegistryRecord[],
  pluginIds?: readonly string[],
): PluginManifestRegistryRecord[] {
  const scopedPluginIds = pluginIds ? new Set(pluginIds) : null;
  const scopedProviderIds = pluginIds
    ? new Set(pluginIds.map(normalizeProviderId).filter(Boolean))
    : null;
  return records.filter(
    (record) =>
      !(
        scopedPluginIds &&
        !scopedPluginIds.has(record.id) &&
        !(record.packageName && scopedPluginIds.has(record.packageName)) &&
        !record.legacyPluginIds?.some((pluginId) => scopedPluginIds.has(pluginId)) &&
        !record.channels.some((channelId) => scopedPluginIds.has(channelId)) &&
        !record.providers.some((providerId) => scopedPluginIds.has(providerId)) &&
        !(scopedProviderIds && hasScopedProviderAuthAlias(record, scopedProviderIds))
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
  const records = resolvePluginDoctorManifestRecords(params);
  const entries = loadPluginDoctorContractEntries({
    records,
    surface: params.surface,
  });
  if (params.surface !== "configRepair") {
    return entries;
  }
  const ownedChannels = new Set(records.flatMap((record) => record.channels));
  const installedPluginIds = new Set(records.map((record) => record.id));
  for (const { channelId, pluginId } of GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA) {
    if (
      (!Object.hasOwn(params.config?.channels ?? {}, channelId) &&
        !Object.hasOwn(params.config?.plugins?.entries ?? {}, pluginId)) ||
      ownedChannels.has(channelId) ||
      installedPluginIds.has(pluginId) ||
      (params.pluginIds &&
        !params.pluginIds.includes(channelId) &&
        !params.pluginIds.includes(pluginId))
    ) {
      continue;
    }
    // Retain the core-version config migration for absent external plugins. An installed
    // owner, including one with a broken contract, is never replaced by this upgrade path.
    const mod = loadBundledPluginPublicArtifactModuleFromCandidatesSync<PluginDoctorContractModule>(
      {
        dirName: channelId,
        artifactCandidates: ["config-doctor-api.js"],
        env: params.env,
      },
    );
    if (!mod) {
      continue;
    }
    const { summary: _summary, ...contract } = coercePluginDoctorContractModule(mod);
    entries.push({ pluginId, ...contract });
  }
  return entries;
}

function loadPluginDoctorContractEntries(params: {
  records: PluginManifestRegistryRecord[];
  surface: PluginDoctorContractSurface;
}): PluginDoctorContractEntry[] {
  const entries: PluginDoctorContractEntry[] = [];
  for (const record of params.records) {
    const entry = loadPluginDoctorContractEntry(record, params.surface);
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

export class PluginDoctorStateMigrationDeclarationError extends Error {}

export function listPluginDoctorStateMigrationEntries(params?: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  validateDeclarations?: boolean;
}): PluginDoctorStateMigrationEntry[] {
  return loadPluginDoctorStateMigrationEntries(
    resolvePluginDoctorStateMigrationRecords(params ?? {}),
    params?.validateDeclarations,
  );
}

function loadPluginDoctorStateMigrationEntries(
  records: readonly PluginManifestRegistryRecord[],
  validateDeclarations = true,
): PluginDoctorStateMigrationEntry[] {
  const entries: PluginDoctorStateMigrationEntry[] = [];
  for (const record of records) {
    const modern = loadPluginDoctorContractEntry(record, "stateMigrations");
    const declaration = record.doctorContract?.stateMigrations;
    const migrations = modern?.stateMigrations ?? [];
    // Validate the whole declaration before callers select a phase or authority.
    // Otherwise an undeclared post-session action can hide behind an empty phase.
    if (
      validateDeclarations &&
      Array.isArray(declaration) &&
      (declaration.length !== migrations.length ||
        declaration.some((action, index) => {
          const migration = migrations[index];
          return (
            action.id !== migration?.id ||
            (action.doctorOnly === true) !== (migration?.doctorOnly === true) ||
            action.phase !== migration?.phase
          );
        }))
    ) {
      throw new PluginDoctorStateMigrationDeclarationError(
        `Refused plugin migrations that do not match the immutable action order and authority declared by ${record.id}.`,
      );
    }
    if (modern?.stateMigrations.length) {
      for (const migration of modern.stateMigrations) {
        entries.push({
          pluginId: modern.pluginId,
          channelIds: record.channels,
          trustedForDurableStores: isTrustedForDurableStores(record),
          migration,
        });
      }
      continue;
    }
    if (declaresPluginDoctorContractSurface(record.doctorContract, "stateMigrations")) {
      continue;
    }
    if (record.channels.length === 0 || record.origin === "bundled") {
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
      channelIds: record.channels,
      trustedForDurableStores: isTrustedForDurableStores(record),
      migration: definePluginDoctorMigrationFromPlans({
        id: `${record.id}-legacy-channel-state`,
        label: `${record.id} legacy channel state`,
        resolvePlans: detector,
      }),
    });
  }
  return entries;
}

function resolvePluginDoctorStateMigrationRecords(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginIds?: readonly string[];
  artifactPreservingReadOnly?: boolean;
}): PluginManifestRegistryRecord[] {
  if (params.pluginIds?.length === 0) {
    return [];
  }
  const registry = discoverConfigWidePluginManifestRegistry(params);
  return filterPluginDoctorStateMigrationRecords(
    filterPluginDoctorRecordsByScope(registry.plugins, params.pluginIds),
    params.config,
  );
}

function filterPluginDoctorStateMigrationRecords(
  candidates: readonly PluginManifestRegistryRecord[],
  config?: OpenClawConfig,
): PluginManifestRegistryRecord[] {
  const records: PluginManifestRegistryRecord[] = [];
  const normalizedConfig = normalizePluginsConfig(config?.plugins);
  for (const record of candidates) {
    const channelOwner = record.channels.length > 0;
    // Config repair intentionally includes disabled plugins; channel state must never be moved
    // after its operator has disabled the owning plugin or every configured channel.
    if (
      channelOwner &&
      !shouldIncludeChannelSetupFeatureForConfig({
        plugin: record,
        config,
        normalizedConfig,
      })
    ) {
      continue;
    }
    // Trusted bundled non-channel migrations remain available while plugins are globally disabled.
    // Every non-bundled owner must pass normal activation before either artifact can execute.
    if (
      record.origin !== "bundled" &&
      !isActivatedManifestOwner({ plugin: record, normalizedConfig, rootConfig: config })
    ) {
      continue;
    }
    records.push(record);
  }
  return records;
}

export type PluginDoctorStateMigrationInventory = {
  knownPluginIds: string[];
  sessionStoreOwnerPluginIds: string[];
  descriptors: Array<{
    pluginId: string;
    id: string;
    doctorOnly?: true;
    phase?: "after-session-repair";
  }>;
  unresolvedPluginIds: string[];
  resolutionFailure?: { code: string; message: string };
};

/**
 * Read candidate-bundled migration identities without importing Doctor contract modules.
 * Installed plugin artifacts are outside the candidate and copied-state identity boundary;
 * candidate staging must bind them before their descriptors can authorize execution.
 */
function listPluginDoctorStateMigrationInventory(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  candidateRoot?: string;
}): PluginDoctorStateMigrationInventory {
  const knownPluginIds: string[] = [];
  const sessionStoreOwnerPluginIds: string[] = [];
  const descriptors: PluginDoctorStateMigrationInventory["descriptors"] = [];
  const unresolvedPluginIds: string[] = [];
  const candidateBundledRoot = params?.candidateRoot
    ? resolveBundledPluginScanDir({
        packageRoot: path.resolve(params.candidateRoot),
        runningFromBuiltArtifact: true,
      })
    : undefined;
  const bundled = params?.candidateRoot
    ? candidateBundledRoot && !areBundledPluginsDisabled(params.env)
      ? loadBundledPluginManifestRegistry({
          env: { ...params.env, OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1" },
          bundledRoot: candidateBundledRoot,
        }).plugins
      : []
    : loadBundledPluginManifestRegistry({ env: params?.env }).plugins;
  knownPluginIds.push(...bundled.map((record) => record.id));
  for (const record of filterPluginDoctorStateMigrationRecords(bundled, params?.config)) {
    if (record.doctorContract?.resolveSessionStoreAgentIds === true) {
      sessionStoreOwnerPluginIds.push(record.id);
    }
    const declaration = record.doctorContract?.stateMigrations;
    if (Array.isArray(declaration)) {
      descriptors.push(
        ...declaration.map((migration) => Object.assign({ pluginId: record.id }, migration)),
      );
      continue;
    }
    if (declaration === true || (record.channels.length > 0 && record.origin !== "bundled")) {
      unresolvedPluginIds.push(record.id);
    }
  }
  return { knownPluginIds, sessionStoreOwnerPluginIds, descriptors, unresolvedPluginIds };
}

/** Resolve the bundled action inventory plus every configured owner that is not identity-bound. */
export function resolvePluginDoctorStateMigrationInventory(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  candidateRoot?: string;
  artifactPreservingReadOnly?: boolean;
}): PluginDoctorStateMigrationInventory {
  const inventory = listPluginDoctorStateMigrationInventory(params);
  const hasConfiguredLoadPaths =
    params.config.plugins?.load?.paths?.some((entry) => entry.trim().length > 0) === true;
  let externallySelectedPluginIds = new Set<string>();
  try {
    externallySelectedPluginIds = new Set(
      // Selection and activation differ: a disabled external winner still shadows
      // the bundled artifact, so its bundled actions cannot authorize a copied plan.
      resolvePluginDoctorManifestRecords(params)
        .filter((record) => record.origin !== "bundled")
        .map((record) => record.id),
    );
  } catch {
    // Shared-state schema repair owns unreadable registry diagnostics. Keep the bundled and
    // explicitly configured inventory stable so that refusal can close every later receipt.
  }
  const relevantPluginIds = collectRelevantDoctorPluginIds(params.config);
  const knownPluginIds = inventory.knownPluginIds.filter(
    (pluginId) => !externallySelectedPluginIds.has(pluginId),
  );
  const sessionStoreOwnerPluginIds = inventory.sessionStoreOwnerPluginIds.filter(
    (pluginId) => !externallySelectedPluginIds.has(pluginId),
  );
  const descriptors = inventory.descriptors.filter(
    (descriptor) => !externallySelectedPluginIds.has(descriptor.pluginId),
  );
  const describedPluginIds = new Set([
    ...knownPluginIds,
    ...descriptors.map((descriptor) => descriptor.pluginId),
    ...inventory.unresolvedPluginIds,
  ]);
  const unresolvedPluginIds = [
    ...inventory.unresolvedPluginIds,
    ...externallySelectedPluginIds,
    ...relevantPluginIds.filter((pluginId) => !describedPluginIds.has(pluginId)),
  ];
  if (hasConfiguredLoadPaths) {
    // A configured path can override any bundled ID. Its manifest bytes are outside the
    // candidate identity, so no bundled descriptor may authorize the selected artifact.
    unresolvedPluginIds.push("configured-load-paths");
  }
  return {
    knownPluginIds,
    sessionStoreOwnerPluginIds,
    descriptors,
    unresolvedPluginIds: [...new Set(unresolvedPluginIds)].toSorted(),
  };
}

/** Freeze the live registry's selected migration actions before state mutation. */
export function resolveLivePluginDoctorStateMigrationInventory(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): PluginDoctorStateMigrationInventory {
  const bundledInventory = listPluginDoctorStateMigrationInventory(params);
  let records: PluginManifestRegistryRecord[];
  try {
    records = resolvePluginDoctorStateMigrationRecords({
      ...params,
      artifactPreservingReadOnly: true,
    });
  } catch (error) {
    // Keep metadata for an early refusal, but never treat failed live discovery as
    // a complete empty inventory. Preparation may refresh it after schema repair.
    return {
      ...bundledInventory,
      unresolvedPluginIds: [],
      resolutionFailure: {
        code: "plugin-inventory-unavailable",
        message: `Could not resolve live plugin migration inventory: ${formatErrorMessage(error)}`,
      },
    };
  }

  const descriptors: PluginDoctorStateMigrationInventory["descriptors"] = [];
  for (const record of records) {
    const declaration = record.doctorContract?.stateMigrations;
    if (Array.isArray(declaration)) {
      descriptors.push(
        ...declaration.map((migration) => Object.assign({ pluginId: record.id }, migration)),
      );
      continue;
    }
    descriptors.push(
      ...loadPluginDoctorStateMigrationEntries([record]).map(({ pluginId, migration }) =>
        Object.assign(
          { pluginId, id: migration.id },
          migration.doctorOnly === true ? { doctorOnly: true as const } : {},
          migration.phase === "after-session-repair" ? { phase: migration.phase } : {},
        ),
      ),
    );
  }

  return {
    knownPluginIds: [...new Set([...bundledInventory.knownPluginIds, ...records.map((r) => r.id)])],
    sessionStoreOwnerPluginIds: records
      .filter((record) => record.doctorContract?.resolveSessionStoreAgentIds === true)
      .map((record) => record.id),
    descriptors,
    unresolvedPluginIds: [],
  };
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
    config: params?.config ?? cfg,
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
