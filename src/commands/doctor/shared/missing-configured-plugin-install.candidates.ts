import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listRawChannelPluginCatalogEntries } from "../../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { compareOpenClawReleaseVersions } from "../../../infra/npm-registry-spec.js";
import {
  normalizeUpdateChannel,
  resolveRegistryUpdateChannel,
} from "../../../infra/update-channels.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolvePluginInstallDir,
} from "../../../plugins/install-paths.js";
import {
  loadInstalledPluginIndexInstallRecords,
  removePluginInstallRecordFromRecords,
} from "../../../plugins/installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "../../../plugins/installed-plugin-index.js";
import { readLegacyNpmPluginDeclaration } from "../../../plugins/legacy-npm-declaration.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import type { PluginPackageInstall } from "../../../plugins/manifest.js";
import {
  isExternallyDistributedPlugin,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "../../../plugins/official-external-plugin-catalog.js";
import { safeRealpathSync } from "../../../plugins/path-safety.js";
import { isPayloadMissing } from "../../../plugins/payload-verification.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderInstallCatalogEntries } from "../../../plugins/provider-install-catalog.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveCompatibilityHostVersion } from "../../../version.js";
import {
  CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES,
  VERSION_BOUND_RUNTIME_PLUGIN_IDS,
} from "./configured-runtime-plugin-installs.js";
import {
  collectConfiguredChannelIds,
  collectConfiguredPluginIds,
  collectEffectiveConfiguredChannelOwnerPluginIds,
} from "./missing-configured-plugin-install.ids.js";

export type DownloadableInstallCandidate = {
  pluginId: string;
  label: string;
  npmSpec?: string;
  clawhubSpec?: string;
  expectedIntegrity?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
  defaultChoice?: PluginPackageInstall["defaultChoice"];
  versionBoundToOpenClaw?: boolean;
};

export type BundledPluginPackageDescriptor = {
  name?: string;
  packageName?: string;
};

/** Keep doctor diagnostics and actual package repair on the same discovery snapshot. */
export async function resolveConfiguredPluginInstallContext(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  configuredPluginIds: ReadonlySet<string>;
  configuredChannelIds: ReadonlySet<string>;
  blockedPluginIds?: ReadonlySet<string>;
  baselineRecords?: Record<string, PluginInstallRecord>;
  coreVersion?: string;
}) {
  const realpathCache = new Map<string, string>();
  const resolvePathIdentity = (value: string): string => {
    const resolved = path.resolve(resolveUserPath(value, params.env));
    return safeRealpathSync(resolved, realpathCache) ?? resolved;
  };
  const snapshot = loadManifestMetadataSnapshot({ config: params.cfg, env: params.env });
  const currentBundledPlugins = loadInstalledPluginIndex({
    config: params.cfg,
    env: params.env,
    installRecords: {},
  }).plugins.filter((plugin) => plugin.origin === "bundled");
  const knownIds = new Set([
    ...snapshot.plugins.filter((plugin) => plugin.origin !== "bundled").map((plugin) => plugin.id),
    ...currentBundledPlugins.map((plugin) => plugin.pluginId),
  ]);
  const configuredChannelOwnerPluginIds = collectEffectiveConfiguredChannelOwnerPluginIds({
    cfg: params.cfg,
    env: params.env,
    snapshot,
    configuredChannelIds: params.configuredChannelIds,
  });
  const bundledPluginsById = new Map<string, BundledPluginPackageDescriptor>(
    currentBundledPlugins
      .filter((plugin) => !isExternallyDistributedPlugin(plugin))
      .map((plugin) => [plugin.pluginId, { packageName: plugin.packageName }] as const),
  );
  const configuredPluginIdsWithStaleDescriptors =
    collectConfiguredPluginIdsWithMissingChannelConfigDescriptors({
      snapshot,
      configuredPluginIds: params.configuredPluginIds,
      configuredChannelIds: params.configuredChannelIds,
    });
  const records =
    params.baselineRecords ?? (await loadInstalledPluginIndexInstallRecords({ env: params.env }));
  const currentVersion = params.coreVersion ?? resolveCompatibilityHostVersion(params.env);
  const updateChannel = resolveRegistryUpdateChannel({
    configChannel: normalizeUpdateChannel(params.cfg.update?.channel),
    currentVersion,
  });
  const installedPluginIdsWithRepairablePackageDiagnostics =
    collectInstalledPluginIdsWithRepairablePackageDiagnostics({
      snapshot,
      installRecords: records,
      resolvePathIdentity,
    });
  const installedPluginIdsWithStaleVersionBoundRuntimePackages =
    collectInstalledPluginIdsWithStaleVersionBoundRuntimePackages({
      snapshot,
      installRecords: records,
      configuredPluginIds: params.configuredPluginIds,
      currentVersion,
    });
  const installedPluginIdsWithRepairablePackages = new Set([
    ...installedPluginIdsWithRepairablePackageDiagnostics,
    ...installedPluginIdsWithStaleVersionBoundRuntimePackages,
  ]);
  const officialReplacementPluginIds = new Set(
    collectOfficialReplacementInstallCandidates({
      cfg: params.cfg,
      env: params.env,
      repairablePluginIds: installedPluginIdsWithRepairablePackages,
      configuredPluginIds: params.configuredPluginIds,
      configuredChannelIds: params.configuredChannelIds,
      configuredChannelOwnerPluginIds,
      blockedPluginIds: params.blockedPluginIds,
    }).keys(),
  );
  const configuredLoadPathIdentities = new Set(
    snapshot.discovery?.candidates
      .filter((candidate) => candidate.configSelected)
      .flatMap((candidate) => [candidate.rootDir, candidate.source])
      .map(resolvePathIdentity),
  );
  const configuredLoadPathPluginsById = new Map<string, string>();
  for (const plugin of snapshot.plugins) {
    if (
      plugin.origin === "config" ||
      [plugin.rootDir, plugin.source].some((value) =>
        configuredLoadPathIdentities.has(resolvePathIdentity(value)),
      )
    ) {
      configuredLoadPathPluginsById.set(plugin.id, plugin.rootDir);
    }
  }
  const stalePathInstallPluginIds = new Set<string>();
  for (const [pluginId, record] of Object.entries(records)) {
    if (installedPluginIdsWithRepairablePackages.has(pluginId)) {
      continue;
    }
    const configPluginRoot = configuredLoadPathPluginsById.get(pluginId);
    const recordedPaths = [record.installPath, record.sourcePath].filter((value): value is string =>
      Boolean(value?.trim()),
    );
    if (!configPluginRoot || record.source !== "path" || recordedPaths.length === 0) {
      continue;
    }
    const configRootIdentity = resolvePathIdentity(configPluginRoot);
    if (
      isPayloadMissing(params.env, record.installPath) &&
      recordedPaths.every((value) => resolvePathIdentity(value) !== configRootIdentity)
    ) {
      stalePathInstallPluginIds.add(pluginId);
    }
  }
  let effectiveRecords = records;
  for (const pluginId of stalePathInstallPluginIds) {
    effectiveRecords = removePluginInstallRecordFromRecords(effectiveRecords, pluginId);
  }
  return {
    knownIds,
    configuredChannelOwnerPluginIds,
    bundledPluginsById,
    configuredPluginIdsWithStaleDescriptors,
    stalePathInstallPluginIds,
    records: effectiveRecords,
    persistedRecords: records,
    updateChannel,
    installedPluginIdsWithRepairablePackageDiagnostics,
    installedPluginIdsWithStaleVersionBoundRuntimePackages,
    installedPluginIdsWithRepairablePackages,
    officialReplacementPluginIds,
  };
}

const MISSING_CHANNEL_CONFIG_DESCRIPTOR_DIAGNOSTIC = "without channelConfigs metadata";
const REPAIRABLE_PACKAGE_ENTRY_DIAGNOSTIC_MARKERS = [
  "extension entry not found",
  "extension entry escapes package directory",
  "extension entry unreadable",
  "requires compiled runtime output",
] as const;

function setDownloadableInstallCandidate(params: {
  candidates: Map<string, DownloadableInstallCandidate>;
  pluginId: string;
  label: string;
  install: PluginPackageInstall;
  trustedSourceLinkedOfficialInstall?: boolean;
}): void {
  const npmSpec = params.install.npmSpec?.trim();
  const clawhubSpec = params.install.clawhubSpec?.trim();
  if (!npmSpec && !clawhubSpec) {
    return;
  }
  params.candidates.set(params.pluginId, {
    pluginId: params.pluginId,
    label: params.label,
    ...(npmSpec ? { npmSpec } : {}),
    ...(clawhubSpec ? { clawhubSpec } : {}),
    ...(params.install.expectedIntegrity
      ? { expectedIntegrity: params.install.expectedIntegrity }
      : {}),
    ...(params.trustedSourceLinkedOfficialInstall
      ? { trustedSourceLinkedOfficialInstall: true }
      : {}),
    ...(params.install.defaultChoice ? { defaultChoice: params.install.defaultChoice } : {}),
  });
}

export function collectDownloadableInstallCandidates(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  missingPluginIds: ReadonlySet<string>;
  configuredPluginIds?: ReadonlySet<string>;
  configuredChannelIds?: ReadonlySet<string>;
  configuredChannelOwnerPluginIds?: ReadonlyMap<string, ReadonlySet<string>>;
  blockedPluginIds?: ReadonlySet<string>;
}): DownloadableInstallCandidate[] {
  const configuredPluginIds = params.configuredPluginIds ?? collectConfiguredPluginIds(params.cfg);
  const configuredChannelIds =
    params.configuredChannelIds ?? collectConfiguredChannelIds(params.cfg, params.env);
  const candidates = new Map<string, DownloadableInstallCandidate>();

  for (const entry of listRawChannelPluginCatalogEntries({
    env: params.env,
    excludeWorkspace: true,
  })) {
    if (entry.origin === "bundled") {
      continue;
    }
    const pluginId = entry.pluginId ?? entry.id;
    const channelId = normalizeOptionalLowercaseString(entry.id);
    if (params.blockedPluginIds?.has(pluginId)) {
      continue;
    }
    const selectedOnlyByChannel =
      !params.missingPluginIds.has(pluginId) &&
      !configuredPluginIds.has(pluginId) &&
      (channelId ? configuredChannelIds.has(channelId) : configuredChannelIds.has(entry.id));
    const configuredChannelOwnerPluginIds = channelId
      ? params.configuredChannelOwnerPluginIds?.get(channelId)
      : undefined;
    if (
      selectedOnlyByChannel &&
      configuredChannelOwnerPluginIds &&
      configuredChannelOwnerPluginIds.size > 0 &&
      !configuredChannelOwnerPluginIds.has(pluginId)
    ) {
      continue;
    }
    if (
      !params.missingPluginIds.has(pluginId) &&
      !configuredPluginIds.has(pluginId) &&
      !configuredChannelIds.has(entry.id)
    ) {
      continue;
    }
    setDownloadableInstallCandidate({
      candidates,
      pluginId,
      label: entry.meta.label,
      install: entry.install,
      trustedSourceLinkedOfficialInstall: entry.trustedSourceLinkedOfficialInstall,
    });
  }

  for (const entry of resolveProviderInstallCatalogEntries({
    config: params.cfg,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  })) {
    if (!configuredPluginIds.has(entry.pluginId) && !params.missingPluginIds.has(entry.pluginId)) {
      continue;
    }
    if (params.blockedPluginIds?.has(entry.pluginId)) {
      continue;
    }
    setDownloadableInstallCandidate({
      candidates,
      pluginId: entry.pluginId,
      label: entry.label,
      install: entry.install,
      trustedSourceLinkedOfficialInstall: entry.origin === "bundled",
    });
  }

  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    if (!pluginId || candidates.has(pluginId) || params.blockedPluginIds?.has(pluginId)) {
      continue;
    }
    if (!configuredPluginIds.has(pluginId) && !params.missingPluginIds.has(pluginId)) {
      continue;
    }
    const install = resolveOfficialExternalPluginInstall(entry);
    if (!install) {
      continue;
    }
    setDownloadableInstallCandidate({
      candidates,
      pluginId,
      label: resolveOfficialExternalPluginLabel(entry),
      install,
      trustedSourceLinkedOfficialInstall: true,
    });
  }

  for (const entry of CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES) {
    if (!configuredPluginIds.has(entry.pluginId) && !params.missingPluginIds.has(entry.pluginId)) {
      continue;
    }
    if (params.blockedPluginIds?.has(entry.pluginId)) {
      continue;
    }
    const existing = candidates.get(entry.pluginId);
    if (existing && entry.versionBoundToOpenClaw) {
      candidates.set(entry.pluginId, { ...existing, versionBoundToOpenClaw: true });
    } else if (!existing) {
      candidates.set(entry.pluginId, entry);
    }
  }

  for (const candidate of collectLegacyNpmDeclarationInstallCandidates({
    cfg: params.cfg,
    env: params.env,
    configuredPluginIds,
    missingPluginIds: params.missingPluginIds,
    blockedPluginIds: params.blockedPluginIds,
  })) {
    if (!candidates.has(candidate.pluginId)) {
      candidates.set(candidate.pluginId, candidate);
    }
  }

  return [...candidates.values()].toSorted((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  );
}

function addLegacyNpmDeclarationInstallCandidate(params: {
  candidates: Map<string, DownloadableInstallCandidate>;
  pluginDir: string;
  configuredPluginIds: ReadonlySet<string>;
  missingPluginIds: ReadonlySet<string>;
  blockedPluginIds?: ReadonlySet<string>;
}): void {
  const declaration = readLegacyNpmPluginDeclaration(params.pluginDir);
  if (!declaration) {
    return;
  }
  if (
    params.blockedPluginIds?.has(declaration.pluginId) ||
    (!params.configuredPluginIds.has(declaration.pluginId) &&
      !params.missingPluginIds.has(declaration.pluginId))
  ) {
    return;
  }
  params.candidates.set(declaration.pluginId, {
    pluginId: declaration.pluginId,
    label: declaration.pluginId,
    npmSpec: declaration.npmSpec,
    defaultChoice: "npm",
  });
}

function collectLegacyNpmDeclarationInstallCandidates(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  configuredPluginIds: ReadonlySet<string>;
  missingPluginIds: ReadonlySet<string>;
  blockedPluginIds?: ReadonlySet<string>;
}): DownloadableInstallCandidate[] {
  const candidates = new Map<string, DownloadableInstallCandidate>();
  const env = params.env ?? process.env;
  const loadPaths = params.cfg.plugins?.load?.paths;
  if (Array.isArray(loadPaths)) {
    for (const rawPath of loadPaths) {
      if (typeof rawPath !== "string" || !rawPath.trim()) {
        continue;
      }
      addLegacyNpmDeclarationInstallCandidate({
        candidates,
        pluginDir: resolveUserPath(rawPath, env),
        configuredPluginIds: params.configuredPluginIds,
        missingPluginIds: params.missingPluginIds,
        blockedPluginIds: params.blockedPluginIds,
      });
    }
  }

  const extensionsDir = resolveDefaultPluginExtensionsDir(env);
  const configuredOrMissingPluginIds = new Set([
    ...params.configuredPluginIds,
    ...params.missingPluginIds,
  ]);
  for (const pluginId of configuredOrMissingPluginIds) {
    try {
      addLegacyNpmDeclarationInstallCandidate({
        candidates,
        pluginDir: resolvePluginInstallDir(pluginId, extensionsDir),
        configuredPluginIds: params.configuredPluginIds,
        missingPluginIds: params.missingPluginIds,
        blockedPluginIds: params.blockedPluginIds,
      });
    } catch {
      continue;
    }
  }

  return [...candidates.values()].toSorted((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  );
}

export function collectUpdateDeferredPluginIds(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  configuredPluginIds: ReadonlySet<string>;
  configuredChannelIds: ReadonlySet<string>;
  configuredChannelOwnerPluginIds?: ReadonlyMap<string, ReadonlySet<string>>;
  blockedPluginIds?: ReadonlySet<string>;
}): Set<string> {
  const pluginIds = new Set(params.configuredPluginIds);
  for (const candidate of collectDownloadableInstallCandidates({
    cfg: params.cfg,
    env: params.env,
    missingPluginIds: new Set(),
    configuredPluginIds: params.configuredPluginIds,
    configuredChannelIds: params.configuredChannelIds,
    configuredChannelOwnerPluginIds: params.configuredChannelOwnerPluginIds,
    blockedPluginIds: params.blockedPluginIds,
  })) {
    pluginIds.add(candidate.pluginId);
  }
  return pluginIds;
}

function collectConfiguredPluginIdsWithMissingChannelConfigDescriptors(params: {
  snapshot: PluginMetadataSnapshot;
  configuredPluginIds: ReadonlySet<string>;
  configuredChannelIds: ReadonlySet<string>;
}): Set<string> {
  const stalePluginIds = new Set<string>();
  const pluginsById = new Map(params.snapshot.plugins.map((plugin) => [plugin.id, plugin]));
  for (const diagnostic of params.snapshot.diagnostics) {
    const pluginId = diagnostic.pluginId?.trim();
    if (!pluginId || !diagnostic.message.includes(MISSING_CHANNEL_CONFIG_DESCRIPTOR_DIAGNOSTIC)) {
      continue;
    }
    const plugin = pluginsById.get(pluginId);
    const ownsConfiguredChannel = plugin?.channels.some((channelId) =>
      params.configuredChannelIds.has(channelId),
    );
    if (params.configuredPluginIds.has(pluginId) || ownsConfiguredChannel) {
      stalePluginIds.add(pluginId);
    }
  }
  return stalePluginIds;
}

function collectInstalledPluginIdsWithRepairablePackageDiagnostics(params: {
  snapshot: PluginMetadataSnapshot;
  installRecords: Record<string, PluginInstallRecord>;
  resolvePathIdentity: (value: string) => string;
}): Set<string> {
  const pluginIds = new Set<string>();
  for (const diagnostic of params.snapshot.diagnostics) {
    const pluginId = diagnostic.pluginId?.trim();
    if (!pluginId || !Object.hasOwn(params.installRecords, pluginId)) {
      continue;
    }
    const installPath = params.installRecords[pluginId]?.installPath;
    // A same-id source copy must never authorize replacing the recorded package.
    if (
      installPath &&
      diagnostic.source &&
      params.resolvePathIdentity(diagnostic.source) === params.resolvePathIdentity(installPath) &&
      REPAIRABLE_PACKAGE_ENTRY_DIAGNOSTIC_MARKERS.some((marker) =>
        diagnostic.message.includes(marker),
      )
    ) {
      pluginIds.add(pluginId);
    }
  }
  return pluginIds;
}

function resolveInstalledRuntimePackageVersion(params: {
  pluginId: string;
  snapshot: PluginMetadataSnapshot;
  record: PluginInstallRecord;
}): string | undefined {
  const plugin =
    params.snapshot.byPluginId?.get(params.pluginId) ??
    params.snapshot.plugins.find((entry) => entry.id === params.pluginId);
  return normalizeOptionalLowercaseString(
    params.record.resolvedVersion ??
      params.record.version ??
      plugin?.packageVersion ??
      plugin?.version,
  );
}

function installedRuntimePackageVersionIsStale(params: {
  installedVersion: string | undefined;
  currentVersion: string;
}): boolean {
  if (!params.installedVersion) {
    return false;
  }
  const comparison = compareOpenClawReleaseVersions(params.installedVersion, params.currentVersion);
  return comparison === null ? params.installedVersion !== params.currentVersion : comparison < 0;
}

function collectInstalledPluginIdsWithStaleVersionBoundRuntimePackages(params: {
  snapshot: PluginMetadataSnapshot;
  installRecords: Record<string, PluginInstallRecord>;
  configuredPluginIds: ReadonlySet<string>;
  currentVersion: string;
}): Set<string> {
  const pluginIds = new Set<string>();
  const currentVersion = normalizeOptionalLowercaseString(params.currentVersion);
  if (!currentVersion) {
    return pluginIds;
  }
  for (const candidate of CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES) {
    if (
      !VERSION_BOUND_RUNTIME_PLUGIN_IDS.has(candidate.pluginId) ||
      !params.configuredPluginIds.has(candidate.pluginId)
    ) {
      continue;
    }
    const record = params.installRecords[candidate.pluginId];
    if (!record) {
      continue;
    }
    const installedVersion = resolveInstalledRuntimePackageVersion({
      pluginId: candidate.pluginId,
      snapshot: params.snapshot,
      record,
    });
    if (
      installedRuntimePackageVersionIsStale({
        installedVersion,
        currentVersion,
      })
    ) {
      pluginIds.add(candidate.pluginId);
    }
  }
  return pluginIds;
}

function isConfiguredPluginRepairTarget(params: {
  pluginId: string;
  configuredPluginIds: ReadonlySet<string>;
  configuredChannelIds: ReadonlySet<string>;
  configuredChannelOwnerPluginIds: ReadonlyMap<string, ReadonlySet<string>>;
}): boolean {
  if (params.configuredPluginIds.has(params.pluginId)) {
    return true;
  }
  if (params.configuredChannelIds.has(params.pluginId)) {
    return true;
  }
  for (const ownerIds of params.configuredChannelOwnerPluginIds.values()) {
    if (ownerIds.has(params.pluginId)) {
      return true;
    }
  }
  return false;
}

function collectOfficialReplacementInstallCandidates(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  repairablePluginIds: ReadonlySet<string>;
  configuredPluginIds: ReadonlySet<string>;
  configuredChannelIds: ReadonlySet<string>;
  configuredChannelOwnerPluginIds: ReadonlyMap<string, ReadonlySet<string>>;
  blockedPluginIds?: ReadonlySet<string>;
}): Map<string, DownloadableInstallCandidate> {
  const repairableConfiguredPluginIds = new Set(
    [...params.repairablePluginIds].filter((pluginId) =>
      isConfiguredPluginRepairTarget({
        pluginId,
        configuredPluginIds: params.configuredPluginIds,
        configuredChannelIds: params.configuredChannelIds,
        configuredChannelOwnerPluginIds: params.configuredChannelOwnerPluginIds,
      }),
    ),
  );
  if (repairableConfiguredPluginIds.size === 0) {
    return new Map();
  }
  const candidates = collectDownloadableInstallCandidates({
    cfg: params.cfg,
    env: params.env,
    missingPluginIds: repairableConfiguredPluginIds,
    configuredPluginIds: params.configuredPluginIds,
    configuredChannelIds: params.configuredChannelIds,
    configuredChannelOwnerPluginIds: params.configuredChannelOwnerPluginIds,
    blockedPluginIds: params.blockedPluginIds,
  });
  return new Map(
    candidates
      .filter(
        (candidate) =>
          repairableConfiguredPluginIds.has(candidate.pluginId) &&
          candidate.trustedSourceLinkedOfficialInstall,
      )
      .map((candidate) => [candidate.pluginId, candidate] as const),
  );
}
