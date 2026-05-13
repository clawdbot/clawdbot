import { existsSync } from "node:fs";
import path from "node:path";
import { collectConfiguredAgentHarnessRuntimes } from "../../../agents/harness-runtimes.js";
import {
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelIds,
} from "../../../channels/config-presence.js";
import { listChannelPluginCatalogEntries } from "../../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../../../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../../../infra/npm-registry-spec.js";
import {
  normalizeUpdateChannel,
  resolveRegistryUpdateChannel,
  type UpdateChannel,
} from "../../../infra/update-channels.js";
import { resolveConfiguredChannelPresencePolicy } from "../../../plugins/channel-plugin-ids.js";
import { buildClawHubPluginInstallRecordFields } from "../../../plugins/clawhub-install-records.js";
import { CLAWHUB_INSTALL_ERROR_CODE, installPluginFromClawHub } from "../../../plugins/clawhub.js";
import {
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "../../../plugins/install-channel-specs.js";
import { resolveDefaultPluginExtensionsDir } from "../../../plugins/install-paths.js";
import { installPluginFromNpmSpec } from "../../../plugins/install.js";
import { loadInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { loadInstalledPluginIndex } from "../../../plugins/installed-plugin-index.js";
import { buildNpmResolutionInstallFields } from "../../../plugins/installs.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import type { PluginPackageInstall } from "../../../plugins/manifest.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
} from "../../../plugins/official-external-plugin-catalog.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderInstallCatalogEntries } from "../../../plugins/provider-install-catalog.js";
import { updateNpmInstalledPlugins } from "../../../plugins/update.js";
import { resolveWebSearchInstallCatalogEntry } from "../../../plugins/web-search-install-catalog.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import { resolveUserPath } from "../../../utils.js";
import { VERSION } from "../../../version.js";
import { asObjectRecord } from "./object.js";
import { isUpdatePackageSwapInProgress } from "./update-phase.js";

type DownloadableInstallCandidate = {
  pluginId: string;
  label: string;
  npmSpec?: string;
  clawhubSpec?: string;
  expectedIntegrity?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
  defaultChoice?: PluginPackageInstall["defaultChoice"];
};

type BundledPluginPackageDescriptor = {
  name?: string;
  packageName?: string;
};

const RUNTIME_PLUGIN_INSTALL_CANDIDATES: readonly DownloadableInstallCandidate[] = [
  {
    pluginId: "acpx",
    label: "ACPX Runtime",
    npmSpec: "@openclaw/acpx",
    trustedSourceLinkedOfficialInstall: true,
  },
  // Runtime-only configs do not have a provider/channel integration catalog entry.
  {
    pluginId: "codex",
    label: "Codex",
    npmSpec: "@openclaw/codex",
    trustedSourceLinkedOfficialInstall: true,
  },
];

const MISSING_CHANNEL_CONFIG_DESCRIPTOR_DIAGNOSTIC = "without channelConfigs metadata";
const REPAIRABLE_PACKAGE_ENTRY_DIAGNOSTIC_MARKERS = [
  "extension entry escapes package directory",
  "extension entry unreadable",
] as const;

function shouldFallbackClawHubToNpm(result: { ok: false; code?: string }): boolean {
  return (
    result.code === CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND
  );
}

function resolveCandidateClawHubSpec(install: PluginPackageInstall): string | undefined {
  const explicit = install.clawhubSpec?.trim();
  if (explicit) {
    return explicit;
  }
  return undefined;
}

function addConfiguredPluginId(ids: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const pluginId = value.trim();
  if (pluginId) {
    ids.add(pluginId);
  }
}

function addConfiguredAgentRuntimePluginIds(
  ids: Set<string>,
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): void {
  for (const runtime of collectConfiguredAgentHarnessRuntimes(cfg, env ?? process.env, {
    includeEnvRuntime: false,
    includeLegacyAgentRuntimes: false,
  })) {
    addConfiguredPluginId(ids, runtime);
  }
}

function collectConfiguredPluginIds(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): Set<string> {
  const ids = new Set<string>();
  const plugins = asObjectRecord(cfg.plugins);
  if (plugins?.enabled === false) {
    return ids;
  }
  const entries = asObjectRecord(plugins?.entries);
  for (const [pluginId, entry] of Object.entries(entries ?? {})) {
    if (asObjectRecord(entry)?.enabled === false) {
      continue;
    }
    addConfiguredPluginId(ids, pluginId);
  }
  const searchProvider = cfg.tools?.web?.search?.provider;
  if (cfg.tools?.web?.search?.enabled !== false && typeof searchProvider === "string") {
    const installEntry = resolveWebSearchInstallCatalogEntry({ providerId: searchProvider });
    if (installEntry?.pluginId) {
      ids.add(installEntry.pluginId);
    }
  }
  const acp = asObjectRecord(cfg.acp);
  const acpBackend = typeof acp?.backend === "string" ? acp.backend.trim().toLowerCase() : "";
  if (
    (acpBackend === "acpx" ||
      acp?.enabled === true ||
      asObjectRecord(acp?.dispatch)?.enabled === true) &&
    (!acpBackend || acpBackend === "acpx")
  ) {
    ids.add("acpx");
  }
  addConfiguredAgentRuntimePluginIds(ids, cfg, env);
  return ids;
}

function collectBlockedPluginIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const deny = cfg.plugins?.deny;
  if (Array.isArray(deny)) {
    for (const pluginId of deny) {
      if (typeof pluginId === "string" && pluginId.trim()) {
        ids.add(pluginId.trim());
      }
    }
  }
  const entries = asObjectRecord(cfg.plugins?.entries);
  for (const [pluginId, entry] of Object.entries(entries ?? {})) {
    if (pluginId.trim() && asObjectRecord(entry)?.enabled === false) {
      ids.add(pluginId.trim());
    }
  }
  return ids;
}

function collectConfiguredChannelIds(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): Set<string> {
  const ids = new Set<string>();
  if (asObjectRecord(cfg.plugins)?.enabled === false) {
    return ids;
  }
  const disabled = new Set(listExplicitlyDisabledChannelIdsForConfig(cfg));
  const candidateChannelIds = listChannelPluginCatalogEntries({
    env,
    excludeWorkspace: true,
  }).map((entry) => entry.id);
  for (const channelId of listPotentialConfiguredChannelIds(cfg, env, {
    channelIds: candidateChannelIds,
    includePersistedAuthState: false,
  })) {
    const normalized = channelId.trim();
    if (normalized && !disabled.has(normalized.toLowerCase())) {
      ids.add(normalized);
    }
  }
  return ids;
}

function collectEffectiveConfiguredChannelOwnerPluginIds(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  snapshot: PluginMetadataSnapshot;
  configuredChannelIds: ReadonlySet<string>;
}): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  const configuredChannelIds = new Set(
    [...params.configuredChannelIds]
      .map((channelId) => normalizeOptionalLowercaseString(channelId))
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
  if (configuredChannelIds.size === 0) {
    return owners;
  }
  for (const entry of resolveConfiguredChannelPresencePolicy({
    config: params.cfg,
    env: params.env,
    includePersistedAuthState: false,
    manifestRecords: params.snapshot.plugins,
  })) {
    if (!entry.effective || !configuredChannelIds.has(entry.channelId)) {
      continue;
    }
    const pluginIds = new Set(entry.pluginIds);
    if (pluginIds.size > 0) {
      owners.set(entry.channelId, pluginIds);
    }
  }
  return owners;
}

function collectDownloadableInstallCandidates(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  missingPluginIds: ReadonlySet<string>;
  configuredPluginIds?: ReadonlySet<string>;
  configuredChannelIds?: ReadonlySet<string>;
  configuredChannelOwnerPluginIds?: ReadonlyMap<string, ReadonlySet<string>>;
  blockedPluginIds?: ReadonlySet<string>;
}): DownloadableInstallCandidate[] {
  const configuredPluginIds =
    params.configuredPluginIds ?? collectConfiguredPluginIds(params.cfg, params.env);
  const configuredChannelIds =
    params.configuredChannelIds ?? collectConfiguredChannelIds(params.cfg, params.env);
  const candidates = new Map<string, DownloadableInstallCandidate>();

  for (const entry of listChannelPluginCatalogEntries({
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

  for (const entry of RUNTIME_PLUGIN_INSTALL_CANDIDATES) {
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

  return [...candidates.values()].toSorted((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  );
}

function collectUpdateDeferredPluginIds(params: {
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

function forceNpmInstallRecordRepair(record: PluginInstallRecord): PluginInstallRecord {
  if (record.source !== "npm") {
    return record;
  }
  const next = { ...record };
  delete next.resolvedSpec;
  delete next.resolvedVersion;
  return next;
}

function isInstalledRecordMissingOnDisk(
  record: PluginInstallRecord | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const installPath = record?.installPath?.trim();
  if (!installPath) {
    return true;
  }
  const resolved = resolveUserPath(installPath, env);
  return !existsSync(path.join(resolved, "package.json"));
}

function recordMatchesBundledPackage(
  record: PluginInstallRecord,
  bundled: BundledPluginPackageDescriptor,
): boolean {
  const packageName = bundled.packageName?.trim() || bundled.name?.trim();
  if (!packageName) {
    return false;
  }
  if (record.source === "npm") {
    return [record.spec, record.resolvedName, record.resolvedSpec].some(
      (value) => recordNpmPackageName(value) === packageName,
    );
  }
  if (record.source === "clawhub") {
    return [record.clawhubPackage, record.spec].some(
      (value) => recordClawHubPackageName(value) === packageName,
    );
  }
  return false;
}

function recordNpmPackageName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? parseRegistryNpmSpec(trimmed)?.name : undefined;
}

function recordClawHubPackageName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return parseClawHubPluginSpec(trimmed)?.name ?? trimmed;
}

async function installCandidate(params: {
  candidate: DownloadableInstallCandidate;
  records: Record<string, PluginInstallRecord>;
  updateChannel?: UpdateChannel;
}): Promise<{
  records: Record<string, PluginInstallRecord>;
  changes: string[];
  warnings: string[];
}> {
  const { candidate } = params;
  const extensionsDir = resolveDefaultPluginExtensionsDir();
  const changes: string[] = [];
  const warnings: string[] = [];
  const clawhubSpecs = candidate.clawhubSpec
    ? resolveClawHubInstallSpecsForUpdateChannel({
        spec: candidate.clawhubSpec,
        updateChannel: params.updateChannel,
      })
    : null;
  const npmSpecs = candidate.npmSpec
    ? resolveNpmInstallSpecsForUpdateChannel({
        spec: candidate.npmSpec,
        updateChannel: params.updateChannel,
      })
    : null;
  const clawhubInstallSpec = clawhubSpecs?.installSpec ?? candidate.clawhubSpec;
  const npmInstallSpec = npmSpecs?.installSpec ?? candidate.npmSpec;
  if (clawhubInstallSpec && candidate.defaultChoice !== "npm") {
    const clawhubResult = await installPluginFromClawHub({
      spec: clawhubInstallSpec,
      extensionsDir,
      expectedPluginId: candidate.pluginId,
      mode: "install",
      logger: {
        warn: (message) => warnings.push(message),
      },
    });
    if (clawhubResult.ok) {
      const pluginId = clawhubResult.pluginId;
      return {
        records: {
          ...params.records,
          [pluginId]: {
            ...buildClawHubPluginInstallRecordFields(clawhubResult.clawhub),
            spec: clawhubSpecs?.recordSpec ?? clawhubInstallSpec,
            installPath: clawhubResult.targetDir,
            installedAt: new Date().toISOString(),
          },
        },
        changes: [`Installed missing configured plugin "${pluginId}" from ${clawhubInstallSpec}.`],
        warnings,
      };
    }
    if (!npmInstallSpec || !shouldFallbackClawHubToNpm(clawhubResult)) {
      return {
        records: params.records,
        changes: [],
        warnings: [
          ...warnings,
          `Failed to install missing configured plugin "${candidate.pluginId}" from ${clawhubInstallSpec}: ${clawhubResult.error}`,
        ],
      };
    }
    changes.push(
      `ClawHub ${clawhubInstallSpec} unavailable for "${candidate.pluginId}"; falling back to npm ${npmInstallSpec}.`,
    );
  }
  if (!npmInstallSpec) {
    return {
      records: params.records,
      changes: [],
      warnings: [
        ...warnings,
        `Failed to install missing configured plugin "${candidate.pluginId}": missing npm spec.`,
      ],
    };
  }
  const result = await installPluginFromNpmSpec({
    spec: npmInstallSpec,
    extensionsDir,
    expectedPluginId: candidate.pluginId,
    expectedIntegrity: candidate.expectedIntegrity,
    ...(candidate.trustedSourceLinkedOfficialInstall
      ? { trustedSourceLinkedOfficialInstall: true }
      : {}),
    mode: "install",
  });
  if (!result.ok) {
    return {
      records: params.records,
      changes: [],
      warnings: [
        ...warnings,
        `Failed to install missing configured plugin "${candidate.pluginId}" from ${npmInstallSpec}: ${result.error}`,
      ],
    };
  }
  const pluginId = result.pluginId;
  return {
    records: {
      ...params.records,
      [pluginId]: {
        source: "npm",
        spec: npmSpecs?.recordSpec ?? npmInstallSpec,
        installPath: result.targetDir,
        version: result.version,
        installedAt: new Date().toISOString(),
        ...buildNpmResolutionInstallFields(result.npmResolution),
      },
    },
    changes: [
      ...changes,
      `Installed missing configured plugin "${pluginId}" from ${npmInstallSpec}.`,
    ],
    warnings,
  };
}

export type RepairMissingPluginInstallsResult = {
  changes: string[];
  warnings: string[];
  /**
   * The full install-record map after repair. Equal to the input
   * `baselineRecords` (or the disk-loaded records when no baseline was
   * provided) plus any mutations (newly-installed payloads, removed stale
   * bundled records). Callers that need to subsequently overwrite the
   * persisted index MUST seed their write from this map — the disk has
   * already been written to with the same set, but the in-memory caller
   * state is stale otherwise.
   */
  records: Record<string, PluginInstallRecord>;
};

export async function repairMissingConfiguredPluginInstalls(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /**
   * Optional pre-seeded records. When provided, this map is used instead of
   * the disk-loaded install-record snapshot. Pass the in-memory records
   * from earlier post-core steps (sync/npm) so this repair pass can layer
   * its mutations on top of them rather than reading a stale disk
   * snapshot. The merged result is persisted before this function returns.
   */
  baselineRecords?: Record<string, PluginInstallRecord>;
}): Promise<RepairMissingPluginInstallsResult> {
  return repairMissingPluginInstalls({
    cfg: params.cfg,
    env: params.env,
    pluginIds: collectConfiguredPluginIds(params.cfg, params.env),
    channelIds: collectConfiguredChannelIds(params.cfg, params.env),
    blockedPluginIds: collectBlockedPluginIds(params.cfg),
    ...(params.baselineRecords ? { baselineRecords: params.baselineRecords } : {}),
  });
}

export async function repairMissingPluginInstallsForIds(params: {
  cfg: OpenClawConfig;
  pluginIds: Iterable<string>;
  channelIds?: Iterable<string>;
  blockedPluginIds?: Iterable<string>;
  env?: NodeJS.ProcessEnv;
  baselineRecords?: Record<string, PluginInstallRecord>;
}): Promise<RepairMissingPluginInstallsResult> {
  return repairMissingPluginInstalls({
    cfg: params.cfg,
    env: params.env,
    pluginIds: new Set(
      [...params.pluginIds].map((pluginId) => pluginId.trim()).filter((pluginId) => pluginId),
    ),
    channelIds: new Set(
      [...(params.channelIds ?? [])]
        .map((channelId) => channelId.trim())
        .filter((channelId) => channelId),
    ),
    blockedPluginIds: new Set(
      [...(params.blockedPluginIds ?? [])]
        .map((pluginId) => pluginId.trim())
        .filter((pluginId) => pluginId),
    ),
    ...(params.baselineRecords ? { baselineRecords: params.baselineRecords } : {}),
  });
}

async function repairMissingPluginInstalls(params: {
  cfg: OpenClawConfig;
  pluginIds: ReadonlySet<string>;
  channelIds: ReadonlySet<string>;
  blockedPluginIds?: ReadonlySet<string>;
  env?: NodeJS.ProcessEnv;
  baselineRecords?: Record<string, PluginInstallRecord>;
}): Promise<RepairMissingPluginInstallsResult> {
  const env = params.env ?? process.env;
  const snapshot = loadManifestMetadataSnapshot({
    config: params.cfg,
    env,
  });
  const currentBundledPlugins = loadInstalledPluginIndex({
    config: params.cfg,
    env,
    installRecords: {},
  }).plugins.filter((plugin) => plugin.origin === "bundled");
  const knownIds = new Set([
    ...snapshot.plugins.map((plugin) => plugin.id),
    ...currentBundledPlugins.map((plugin) => plugin.pluginId),
  ]);
  const configuredChannelOwnerPluginIds = collectEffectiveConfiguredChannelOwnerPluginIds({
    cfg: params.cfg,
    env,
    snapshot,
    configuredChannelIds: params.channelIds,
  });
  const bundledPluginsById = new Map<string, BundledPluginPackageDescriptor>([
    ...snapshot.plugins
      .filter((plugin) => plugin.origin === "bundled")
      .map((plugin) => [plugin.id, plugin] as const),
    ...currentBundledPlugins.map(
      (plugin) =>
        [
          plugin.pluginId,
          {
            packageName: plugin.packageName,
          },
        ] as const,
    ),
  ]);
  const configuredPluginIdsWithStaleDescriptors =
    collectConfiguredPluginIdsWithMissingChannelConfigDescriptors({
      snapshot,
      configuredPluginIds: params.pluginIds,
      configuredChannelIds: params.channelIds,
    });
  const records = params.baselineRecords ?? (await loadInstalledPluginIndexInstallRecords({ env }));
  const installedPluginIdsWithRepairablePackageDiagnostics =
    collectInstalledPluginIdsWithRepairablePackageDiagnostics({
      snapshot,
      installRecords: records,
    });
  const changes: string[] = [];
  const warnings: string[] = [];
  const deferredPluginIds = new Set<string>();
  const updateChannel = resolveRegistryUpdateChannel({
    configChannel: normalizeUpdateChannel(params.cfg.update?.channel),
    currentVersion: VERSION,
  });
  let nextRecords = records;

  for (const [pluginId, record] of Object.entries(records)) {
    const bundled = bundledPluginsById.get(pluginId);
    if (!bundled || !recordMatchesBundledPackage(record, bundled)) {
      continue;
    }
    if (nextRecords === records) {
      nextRecords = { ...records };
    }
    delete nextRecords[pluginId];
    changes.push(`Removed stale managed install record for bundled plugin "${pluginId}".`);
  }

  if (isUpdatePackageSwapInProgress(env)) {
    const updateDeferredPluginIds = collectUpdateDeferredPluginIds({
      cfg: params.cfg,
      env,
      configuredPluginIds: params.pluginIds,
      configuredChannelIds: params.channelIds,
      configuredChannelOwnerPluginIds,
      blockedPluginIds: params.blockedPluginIds,
    });
    for (const pluginId of updateDeferredPluginIds) {
      deferredPluginIds.add(pluginId);
      const record = nextRecords[pluginId];
      if (!record || !isInstalledRecordMissingOnDisk(record, env)) {
        continue;
      }
      changes.push(
        `Skipped package-manager repair for configured plugin "${pluginId}" during package update; rerun "openclaw doctor --fix" after the update completes.`,
      );
    }
  }

  const missingRecordedPluginIds = Object.keys(records).filter(
    (pluginId) =>
      !deferredPluginIds.has(pluginId) &&
      Object.hasOwn(nextRecords, pluginId) &&
      !bundledPluginsById.has(pluginId) &&
      ((params.pluginIds.has(pluginId) &&
        (!knownIds.has(pluginId) || isInstalledRecordMissingOnDisk(nextRecords[pluginId], env))) ||
        configuredPluginIdsWithStaleDescriptors.has(pluginId) ||
        installedPluginIdsWithRepairablePackageDiagnostics.has(pluginId)),
  );

  if (missingRecordedPluginIds.length > 0) {
    for (const pluginId of missingRecordedPluginIds) {
      const record = nextRecords[pluginId];
      if (!record) {
        continue;
      }
      const forced = forceNpmInstallRecordRepair(record);
      if (forced !== record) {
        if (nextRecords === records) {
          nextRecords = { ...records };
        }
        nextRecords[pluginId] = forced;
      }
    }
    const updateResult = await updateNpmInstalledPlugins({
      config: {
        ...params.cfg,
        plugins: {
          ...params.cfg.plugins,
          installs: nextRecords,
        },
      },
      pluginIds: missingRecordedPluginIds,
      updateChannel,
      logger: {
        warn: (message) => warnings.push(message),
        error: (message) => warnings.push(message),
      },
    });
    for (const outcome of updateResult.outcomes) {
      if (outcome.status === "updated" || outcome.status === "unchanged") {
        changes.push(
          installedPluginIdsWithRepairablePackageDiagnostics.has(outcome.pluginId)
            ? `Repaired broken installed plugin "${outcome.pluginId}".`
            : `Repaired missing configured plugin "${outcome.pluginId}".`,
        );
      } else if (outcome.status === "error") {
        warnings.push(outcome.message);
      }
    }
    nextRecords = updateResult.config.plugins?.installs ?? nextRecords;
  }

  const missingPluginIds = new Set(
    [...params.pluginIds].filter((pluginId) => {
      if (deferredPluginIds.has(pluginId)) {
        return false;
      }
      const hasRecord = Object.hasOwn(nextRecords, pluginId);
      return (
        (!knownIds.has(pluginId) && !hasRecord && !bundledPluginsById.has(pluginId)) ||
        (hasRecord &&
          !bundledPluginsById.has(pluginId) &&
          isInstalledRecordMissingOnDisk(nextRecords[pluginId], env))
      );
    }),
  );
  for (const candidate of collectDownloadableInstallCandidates({
    cfg: params.cfg,
    env,
    missingPluginIds,
    configuredPluginIds: params.pluginIds,
    configuredChannelIds: params.channelIds,
    configuredChannelOwnerPluginIds,
    blockedPluginIds:
      deferredPluginIds.size > 0
        ? new Set([...(params.blockedPluginIds ?? []), ...deferredPluginIds])
        : params.blockedPluginIds,
  })) {
    if (bundledPluginsById.has(candidate.pluginId)) {
      continue;
    }
    const hasUsableRecord =
      Object.hasOwn(nextRecords, candidate.pluginId) &&
      !isInstalledRecordMissingOnDisk(nextRecords[candidate.pluginId], env);
    if (knownIds.has(candidate.pluginId) && hasUsableRecord) {
      continue;
    }
    if (hasUsableRecord) {
      continue;
    }
    const installed = await installCandidate({ candidate, records: nextRecords, updateChannel });
    nextRecords = installed.records;
    changes.push(...installed.changes);
    warnings.push(...installed.warnings);
  }

  if (nextRecords !== records) {
    await writePersistedInstalledPluginIndexInstallRecords(nextRecords, { env });
  } else if (params.baselineRecords) {
    // The caller seeded us from in-memory state that may not yet have been
    // persisted (e.g. earlier sync/npm record mutations). Even if repair
    // itself made no further changes, persist the baseline so the disk
    // matches what we are about to return — otherwise the next reader gets
    // a stale snapshot.
    await writePersistedInstalledPluginIndexInstallRecords(nextRecords, { env });
  }
  return { changes, warnings, records: nextRecords };
}
