import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listRawChannelPluginCatalogEntries } from "../../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { compareOpenClawReleaseVersions } from "../../../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../../../infra/update-channels.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolvePluginInstallDir,
} from "../../../plugins/install-paths.js";
import { readLegacyNpmPluginDeclaration } from "../../../plugins/legacy-npm-declaration.js";
import type { PluginPackageInstall } from "../../../plugins/manifest.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "../../../plugins/official-external-plugin-catalog.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderInstallCatalogEntries } from "../../../plugins/provider-install-catalog.js";
import { resolveUserPath } from "../../../utils.js";
import { VERSION } from "../../../version.js";
import {
  CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES,
  VERSION_BOUND_RUNTIME_PLUGIN_IDS,
} from "./configured-runtime-plugin-installs.js";
import {
  collectConfiguredChannelIds,
  collectConfiguredPluginIds,
} from "./missing-configured-plugin-install.ids.js";

export type DownloadableInstallCandidate = {
  pluginId: string;
  label: string;
  npmSpec?: string;
  clawhubSpec?: string;
  expectedIntegrity?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
  defaultChoice?: PluginPackageInstall["defaultChoice"];
};

export type BundledPluginPackageDescriptor = {
  name?: string;
  packageName?: string;
};

const MISSING_CHANNEL_CONFIG_DESCRIPTOR_DIAGNOSTIC = "without channelConfigs metadata";
const REPAIRABLE_PACKAGE_ENTRY_DIAGNOSTIC_MARKERS = [
  "extension entry escapes package directory",
  "extension entry unreadable",
  "requires compiled runtime output",
] as const;
const OPENCLAW_BETA_COMPANION_VERSION_RE = /^(\d{4}\.[1-9]\d?\.[1-9]\d?)-beta\.[1-9]\d*$/;
const OPENCLAW_STABLE_OR_BETA_COMPANION_VERSION_RE =
  /^(\d{4}\.[1-9]\d?\.[1-9]\d?)(?:-beta\.[1-9]\d*)?$/;

function resolveCandidateClawHubSpec(install: PluginPackageInstall): string | undefined {
  const explicit = install.clawhubSpec?.trim();
  if (explicit) {
    return explicit;
  }
  return undefined;
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
    const npmSpec = entry.install.npmSpec?.trim();
    const clawhubSpec = resolveCandidateClawHubSpec(entry.install);
    if (!npmSpec && !clawhubSpec) {
      continue;
    }
    candidates.set(pluginId, {
      pluginId,
      label: entry.meta.label,
      ...(npmSpec ? { npmSpec } : {}),
      ...(clawhubSpec ? { clawhubSpec } : {}),
      ...(entry.install.expectedIntegrity
        ? { expectedIntegrity: entry.install.expectedIntegrity }
        : {}),
      ...(entry.trustedSourceLinkedOfficialInstall
        ? { trustedSourceLinkedOfficialInstall: true }
        : {}),
      ...(entry.install.defaultChoice ? { defaultChoice: entry.install.defaultChoice } : {}),
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
    const npmSpec = entry.install.npmSpec?.trim();
    const clawhubSpec = resolveCandidateClawHubSpec(entry.install);
    if (!npmSpec && !clawhubSpec) {
      continue;
    }
    candidates.set(entry.pluginId, {
      pluginId: entry.pluginId,
      label: entry.label,
      ...(npmSpec ? { npmSpec } : {}),
      ...(clawhubSpec ? { clawhubSpec } : {}),
      ...(entry.install.expectedIntegrity
        ? { expectedIntegrity: entry.install.expectedIntegrity }
        : {}),
      ...(entry.origin === "bundled" ? { trustedSourceLinkedOfficialInstall: true } : {}),
      ...(entry.install.defaultChoice ? { defaultChoice: entry.install.defaultChoice } : {}),
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
    const npmSpec = install.npmSpec?.trim();
    const clawhubSpec = resolveCandidateClawHubSpec(install);
    if (!npmSpec && !clawhubSpec) {
      continue;
    }
    candidates.set(pluginId, {
      pluginId,
      label: resolveOfficialExternalPluginLabel(entry),
      ...(npmSpec ? { npmSpec } : {}),
      ...(clawhubSpec ? { clawhubSpec } : {}),
      ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
      trustedSourceLinkedOfficialInstall: true,
      ...(install.defaultChoice ? { defaultChoice: install.defaultChoice } : {}),
    });
  }

  for (const entry of CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES) {
    if (!configuredPluginIds.has(entry.pluginId) && !params.missingPluginIds.has(entry.pluginId)) {
      continue;
    }
    if (params.blockedPluginIds?.has(entry.pluginId)) {
      continue;
    }
    if (!candidates.has(entry.pluginId)) {
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

export function collectConfiguredPluginIdsWithMissingChannelConfigDescriptors(params: {
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

export function collectInstalledPluginIdsWithRepairablePackageDiagnostics(params: {
  snapshot: PluginMetadataSnapshot;
  installRecords: Record<string, PluginInstallRecord>;
}): Set<string> {
  const pluginIds = new Set<string>();
  for (const diagnostic of params.snapshot.diagnostics) {
    const pluginId = diagnostic.pluginId?.trim();
    if (!pluginId || !Object.hasOwn(params.installRecords, pluginId)) {
      continue;
    }
    if (
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
  updateChannel: UpdateChannel;
}): boolean {
  if (!params.installedVersion) {
    return false;
  }
  if (
    params.updateChannel === "beta" &&
    betaCompanionMatchesCurrentStableVersion({
      installedVersion: params.installedVersion,
      currentVersion: params.currentVersion,
    })
  ) {
    return false;
  }
  const comparison = compareOpenClawReleaseVersions(params.installedVersion, params.currentVersion);
  return comparison === null ? params.installedVersion !== params.currentVersion : comparison < 0;
}

function betaCompanionMatchesCurrentStableVersion(params: {
  installedVersion: string;
  currentVersion: string;
}): boolean {
  const installedBase = OPENCLAW_BETA_COMPANION_VERSION_RE.exec(params.installedVersion)?.[1];
  const currentBase = OPENCLAW_STABLE_OR_BETA_COMPANION_VERSION_RE.exec(params.currentVersion)?.[1];
  return Boolean(installedBase && currentBase && installedBase === currentBase);
}

export function collectInstalledPluginIdsWithStaleVersionBoundRuntimePackages(params: {
  snapshot: PluginMetadataSnapshot;
  installRecords: Record<string, PluginInstallRecord>;
  configuredPluginIds: ReadonlySet<string>;
  updateChannel: UpdateChannel;
}): Set<string> {
  const pluginIds = new Set<string>();
  const currentVersion = normalizeOptionalLowercaseString(VERSION);
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
        updateChannel: params.updateChannel,
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

export function collectOfficialReplacementInstallCandidates(params: {
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
