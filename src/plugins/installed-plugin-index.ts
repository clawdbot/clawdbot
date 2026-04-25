import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { listPluginCompatRecords, type PluginCompatCode } from "./compat/registry.js";
import {
  normalizePluginsConfigWithResolver,
  resolveEffectiveEnableState,
} from "./config-policy.js";
import { discoverOpenClawPlugins, type PluginCandidate } from "./discovery.js";
import {
  describePluginInstallSource,
  type PluginInstallSourceInfo,
} from "./install-source-info.js";
import type { PluginManifestCommandAlias } from "./manifest-command-aliases.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
  type PluginManifestRegistry,
} from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";

export const INSTALLED_PLUGIN_INDEX_VERSION = 1;

export type InstalledPluginIndexRefreshReason =
  | "missing"
  | "stale-manifest"
  | "stale-package"
  | "source-changed"
  | "host-contract-changed"
  | "compat-registry-changed"
  | "manual";

export type InstalledPluginIndexContributions = {
  providers: readonly string[];
  channels: readonly string[];
  channelConfigs: readonly string[];
  setupProviders: readonly string[];
  cliBackends: readonly string[];
  modelCatalogProviders: readonly string[];
  commandAliases: readonly string[];
  contracts: readonly string[];
};

export type InstalledPluginInstallRecordInfo = Pick<
  PluginInstallRecord,
  | "source"
  | "spec"
  | "sourcePath"
  | "installPath"
  | "version"
  | "resolvedName"
  | "resolvedVersion"
  | "resolvedSpec"
  | "integrity"
  | "shasum"
  | "resolvedAt"
  | "installedAt"
  | "clawhubUrl"
  | "clawhubPackage"
  | "clawhubFamily"
  | "clawhubChannel"
  | "marketplaceName"
  | "marketplaceSource"
  | "marketplacePlugin"
>;

export type InstalledPluginIndexRecord = {
  pluginId: string;
  packageName?: string;
  packageVersion?: string;
  /**
   * Actual install ledger entry recorded by OpenClaw under
   * cfg.plugins.installs[pluginId]. This is the durable source of truth for
   * what onboarding/update installed.
   */
  installRecord?: InstalledPluginInstallRecordInfo;
  /** Hash of installRecord; used to detect source-changed invalidation. */
  installRecordHash?: string;
  /**
   * Package-authored openclaw.install metadata. This describes catalog/package
   * install intent and must not be treated as the durable install ledger.
   */
  packageInstall?: PluginInstallSourceInfo;
  manifestPath: string;
  manifestHash: string;
  packageJsonPath?: string;
  packageJsonHash?: string;
  rootDir: string;
  origin: PluginManifestRecord["origin"];
  enabled: boolean;
  contributions: InstalledPluginIndexContributions;
  compat: readonly PluginCompatCode[];
};

export type InstalledPluginIndex = {
  version: typeof INSTALLED_PLUGIN_INDEX_VERSION;
  hostContractVersion: string;
  compatRegistryVersion: string;
  generatedAt: string;
  refreshReason?: InstalledPluginIndexRefreshReason;
  plugins: readonly InstalledPluginIndexRecord[];
  diagnostics: readonly PluginDiagnostic[];
};

export type InstalledPluginContributions = {
  providers: ReadonlyMap<string, readonly string[]>;
  channels: ReadonlyMap<string, readonly string[]>;
  channelConfigs: ReadonlyMap<string, readonly string[]>;
  setupProviders: ReadonlyMap<string, readonly string[]>;
  cliBackends: ReadonlyMap<string, readonly string[]>;
  modelCatalogProviders: ReadonlyMap<string, readonly string[]>;
  commandAliases: ReadonlyMap<string, readonly string[]>;
  contracts: ReadonlyMap<string, readonly string[]>;
};

export type LoadInstalledPluginIndexParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  cache?: boolean;
  candidates?: PluginCandidate[];
  diagnostics?: PluginDiagnostic[];
  now?: () => Date;
};

export type RefreshInstalledPluginIndexParams = LoadInstalledPluginIndexParams & {
  reason: InstalledPluginIndexRefreshReason;
};

function hashString(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value));
}

function safeHashFile(params: {
  filePath: string;
  pluginId?: string;
  diagnostics: PluginDiagnostic[];
  required: boolean;
}): string | undefined {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(params.filePath)).digest("hex");
  } catch (err) {
    if (params.required) {
      params.diagnostics.push({
        level: "warn",
        ...(params.pluginId ? { pluginId: params.pluginId } : {}),
        source: params.filePath,
        message: `installed plugin index could not hash ${params.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    return undefined;
  }
}

function sortUnique(values: readonly string[] | undefined): readonly string[] {
  if (!values || values.length === 0) {
    return [];
  }
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function collectObjectKeys(value: Record<string, unknown> | undefined): readonly string[] {
  return sortUnique(value ? Object.keys(value) : []);
}

function collectCommandAliasNames(
  aliases: readonly PluginManifestCommandAlias[] | undefined,
): readonly string[] {
  return sortUnique(aliases?.map((alias) => alias.name) ?? []);
}

function collectContractKeys(record: PluginManifestRecord): readonly string[] {
  const contracts = record.contracts;
  if (!contracts) {
    return [];
  }
  return sortUnique(
    Object.entries(contracts).flatMap(([key, value]) =>
      Array.isArray(value) && value.length > 0 ? [key] : [],
    ),
  );
}

function collectCompatCodes(record: PluginManifestRecord): readonly PluginCompatCode[] {
  const codes: PluginCompatCode[] = [];
  if (record.providerAuthEnvVars && Object.keys(record.providerAuthEnvVars).length > 0) {
    codes.push("provider-auth-env-vars");
  }
  if (record.channelEnvVars && Object.keys(record.channelEnvVars).length > 0) {
    codes.push("channel-env-vars");
  }
  if (record.activation?.onProviders?.length) {
    codes.push("activation-provider-hint");
  }
  if (record.activation?.onChannels?.length) {
    codes.push("activation-channel-hint");
  }
  if (record.activation?.onCommands?.length) {
    codes.push("activation-command-hint");
  }
  if (record.activation?.onRoutes?.length) {
    codes.push("activation-route-hint");
  }
  if (record.activation?.onCapabilities?.length) {
    codes.push("activation-capability-hint");
  }
  return sortUnique(codes) as readonly PluginCompatCode[];
}

function buildContributions(record: PluginManifestRecord): InstalledPluginIndexContributions {
  return {
    providers: sortUnique(record.providers),
    channels: sortUnique(record.channels),
    channelConfigs: collectObjectKeys(record.channelConfigs),
    setupProviders: sortUnique(record.setup?.providers?.map((provider) => provider.id) ?? []),
    cliBackends: sortUnique([...(record.cliBackends ?? []), ...(record.setup?.cliBackends ?? [])]),
    modelCatalogProviders: collectObjectKeys(record.modelCatalog?.providers),
    commandAliases: collectCommandAliasNames(record.commandAliases),
    contracts: collectContractKeys(record),
  };
}

function resolvePackageJsonPath(candidate: PluginCandidate | undefined): string | undefined {
  if (!candidate?.packageDir) {
    return undefined;
  }
  const packageJsonPath = path.join(candidate.packageDir, "package.json");
  return fs.existsSync(packageJsonPath) ? packageJsonPath : undefined;
}

function describePackageInstallSource(
  candidate: PluginCandidate | undefined,
): PluginInstallSourceInfo | undefined {
  const install = candidate?.packageManifest?.install;
  if (!install) {
    return undefined;
  }
  return describePluginInstallSource(install, {
    expectedPackageName: candidate?.packageName,
  });
}

function setInstallStringField<Key extends keyof Omit<InstalledPluginInstallRecordInfo, "source">>(
  target: InstalledPluginInstallRecordInfo,
  key: Key,
  value: PluginInstallRecord[Key],
): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim();
  if (normalized) {
    target[key] = normalized as InstalledPluginInstallRecordInfo[Key];
  }
}

function normalizeInstallRecord(
  record: PluginInstallRecord | undefined,
): InstalledPluginInstallRecordInfo | undefined {
  if (!record) {
    return undefined;
  }
  const normalized: InstalledPluginInstallRecordInfo = {
    source: record.source,
  };
  setInstallStringField(normalized, "spec", record.spec);
  setInstallStringField(normalized, "sourcePath", record.sourcePath);
  setInstallStringField(normalized, "installPath", record.installPath);
  setInstallStringField(normalized, "version", record.version);
  setInstallStringField(normalized, "resolvedName", record.resolvedName);
  setInstallStringField(normalized, "resolvedVersion", record.resolvedVersion);
  setInstallStringField(normalized, "resolvedSpec", record.resolvedSpec);
  setInstallStringField(normalized, "integrity", record.integrity);
  setInstallStringField(normalized, "shasum", record.shasum);
  setInstallStringField(normalized, "resolvedAt", record.resolvedAt);
  setInstallStringField(normalized, "installedAt", record.installedAt);
  setInstallStringField(normalized, "clawhubUrl", record.clawhubUrl);
  setInstallStringField(normalized, "clawhubPackage", record.clawhubPackage);
  setInstallStringField(normalized, "clawhubFamily", record.clawhubFamily);
  setInstallStringField(normalized, "clawhubChannel", record.clawhubChannel);
  setInstallStringField(normalized, "marketplaceName", record.marketplaceName);
  setInstallStringField(normalized, "marketplaceSource", record.marketplaceSource);
  setInstallStringField(normalized, "marketplacePlugin", record.marketplacePlugin);
  return normalized;
}

function buildCandidateLookup(
  candidates: readonly PluginCandidate[],
): Map<string, PluginCandidate> {
  const byRootDir = new Map<string, PluginCandidate>();
  for (const candidate of candidates) {
    byRootDir.set(candidate.rootDir, candidate);
  }
  return byRootDir;
}

function resolveCompatRegistryVersion(): string {
  return hashJson(
    listPluginCompatRecords().map((record) => ({
      code: record.code,
      status: record.status,
      deprecated: record.deprecated,
      warningStarts: record.warningStarts,
      removeAfter: record.removeAfter,
      replacement: record.replacement,
    })),
  );
}

function resolveRegistry(params: LoadInstalledPluginIndexParams): {
  registry: PluginManifestRegistry;
  candidates: readonly PluginCandidate[];
} {
  if (params.candidates) {
    return {
      candidates: params.candidates,
      registry: loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        cache: false,
        env: params.env,
        candidates: params.candidates,
        diagnostics: params.diagnostics,
      }),
    };
  }

  const normalized = normalizePluginsConfigWithResolver(params.config?.plugins);
  const discovery = discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    extraPaths: normalized.loadPaths,
    cache: params.cache,
    env: params.env,
  });
  return {
    candidates: discovery.candidates,
    registry: loadPluginManifestRegistry({
      config: params.config,
      workspaceDir: params.workspaceDir,
      cache: false,
      env: params.env,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
    }),
  };
}

function buildInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams & { refreshReason?: InstalledPluginIndexRefreshReason },
): InstalledPluginIndex {
  const env = params.env ?? process.env;
  const { candidates, registry } = resolveRegistry(params);
  const candidateByRootDir = buildCandidateLookup(candidates);
  const normalizedConfig = normalizePluginsConfigWithResolver(params.config?.plugins);
  const diagnostics: PluginDiagnostic[] = [...registry.diagnostics];
  const generatedAt = (params.now?.() ?? new Date()).toISOString();
  const plugins = registry.plugins.map((record): InstalledPluginIndexRecord => {
    const candidate = candidateByRootDir.get(record.rootDir);
    const packageJsonPath = resolvePackageJsonPath(candidate);
    const installRecord = normalizeInstallRecord(params.config?.plugins?.installs?.[record.id]);
    const packageInstall = describePackageInstallSource(candidate);
    const manifestHash =
      safeHashFile({
        filePath: record.manifestPath,
        pluginId: record.id,
        diagnostics,
        required: true,
      }) ?? "";
    const packageJsonHash = packageJsonPath
      ? safeHashFile({
          filePath: packageJsonPath,
          pluginId: record.id,
          diagnostics,
          required: false,
        })
      : undefined;
    const enabled = resolveEffectiveEnableState({
      id: record.id,
      origin: record.origin,
      config: normalizedConfig,
      rootConfig: params.config,
      enabledByDefault: record.enabledByDefault,
    }).enabled;

    const indexRecord: InstalledPluginIndexRecord = {
      pluginId: record.id,
      manifestPath: record.manifestPath,
      manifestHash,
      rootDir: record.rootDir,
      origin: record.origin,
      enabled,
      contributions: buildContributions(record),
      compat: collectCompatCodes(record),
    };
    if (candidate?.packageName) {
      indexRecord.packageName = candidate.packageName;
    }
    if (candidate?.packageVersion) {
      indexRecord.packageVersion = candidate.packageVersion;
    }
    if (installRecord) {
      indexRecord.installRecord = installRecord;
      indexRecord.installRecordHash = hashJson(installRecord);
    }
    if (packageInstall) {
      indexRecord.packageInstall = packageInstall;
    }
    if (packageJsonPath) {
      indexRecord.packageJsonPath = packageJsonPath;
    }
    if (packageJsonHash) {
      indexRecord.packageJsonHash = packageJsonHash;
    }
    return indexRecord;
  });

  return {
    version: INSTALLED_PLUGIN_INDEX_VERSION,
    hostContractVersion: resolveCompatibilityHostVersion(env),
    compatRegistryVersion: resolveCompatRegistryVersion(),
    generatedAt,
    ...(params.refreshReason ? { refreshReason: params.refreshReason } : {}),
    plugins,
    diagnostics,
  };
}

export function loadInstalledPluginIndex(
  params: LoadInstalledPluginIndexParams = {},
): InstalledPluginIndex {
  return buildInstalledPluginIndex(params);
}

export function refreshInstalledPluginIndex(
  params: RefreshInstalledPluginIndexParams,
): InstalledPluginIndex {
  return buildInstalledPluginIndex({ ...params, cache: false, refreshReason: params.reason });
}

function addContribution(
  target: Map<string, string[]>,
  contributionId: string,
  pluginId: string,
): void {
  const existing = target.get(contributionId);
  if (existing) {
    existing.push(pluginId);
  } else {
    target.set(contributionId, [pluginId]);
  }
}

function freezeContributionMap(
  source: Map<string, string[]>,
): ReadonlyMap<string, readonly string[]> {
  const frozen = new Map<string, readonly string[]>();
  for (const [key, pluginIds] of source) {
    frozen.set(key, sortUnique(pluginIds));
  }
  return frozen;
}

export function resolveInstalledPluginContributions(
  index: InstalledPluginIndex,
): InstalledPluginContributions {
  const providers = new Map<string, string[]>();
  const channels = new Map<string, string[]>();
  const channelConfigs = new Map<string, string[]>();
  const setupProviders = new Map<string, string[]>();
  const cliBackends = new Map<string, string[]>();
  const modelCatalogProviders = new Map<string, string[]>();
  const commandAliases = new Map<string, string[]>();
  const contracts = new Map<string, string[]>();

  for (const plugin of index.plugins) {
    for (const provider of plugin.contributions.providers) {
      addContribution(providers, provider, plugin.pluginId);
    }
    for (const channel of plugin.contributions.channels) {
      addContribution(channels, channel, plugin.pluginId);
    }
    for (const channelConfig of plugin.contributions.channelConfigs) {
      addContribution(channelConfigs, channelConfig, plugin.pluginId);
    }
    for (const setupProvider of plugin.contributions.setupProviders) {
      addContribution(setupProviders, setupProvider, plugin.pluginId);
    }
    for (const cliBackend of plugin.contributions.cliBackends) {
      addContribution(cliBackends, cliBackend, plugin.pluginId);
    }
    for (const modelCatalogProvider of plugin.contributions.modelCatalogProviders) {
      addContribution(modelCatalogProviders, modelCatalogProvider, plugin.pluginId);
    }
    for (const commandAlias of plugin.contributions.commandAliases) {
      addContribution(commandAliases, commandAlias, plugin.pluginId);
    }
    for (const contract of plugin.contributions.contracts) {
      addContribution(contracts, contract, plugin.pluginId);
    }
  }

  return {
    providers: freezeContributionMap(providers),
    channels: freezeContributionMap(channels),
    channelConfigs: freezeContributionMap(channelConfigs),
    setupProviders: freezeContributionMap(setupProviders),
    cliBackends: freezeContributionMap(cliBackends),
    modelCatalogProviders: freezeContributionMap(modelCatalogProviders),
    commandAliases: freezeContributionMap(commandAliases),
    contracts: freezeContributionMap(contracts),
  };
}

export function diffInstalledPluginIndexInvalidationReasons(
  previous: InstalledPluginIndex,
  current: InstalledPluginIndex,
): readonly InstalledPluginIndexRefreshReason[] {
  const reasons = new Set<InstalledPluginIndexRefreshReason>();
  if (previous.version !== current.version) {
    reasons.add("missing");
  }
  if (previous.hostContractVersion !== current.hostContractVersion) {
    reasons.add("host-contract-changed");
  }
  if (previous.compatRegistryVersion !== current.compatRegistryVersion) {
    reasons.add("compat-registry-changed");
  }

  const previousByPluginId = new Map(previous.plugins.map((plugin) => [plugin.pluginId, plugin]));
  const currentByPluginId = new Map(current.plugins.map((plugin) => [plugin.pluginId, plugin]));
  for (const [pluginId, previousPlugin] of previousByPluginId) {
    const currentPlugin = currentByPluginId.get(pluginId);
    if (!currentPlugin) {
      reasons.add("source-changed");
      continue;
    }
    if (
      previousPlugin.rootDir !== currentPlugin.rootDir ||
      previousPlugin.manifestPath !== currentPlugin.manifestPath ||
      previousPlugin.installRecordHash !== currentPlugin.installRecordHash
    ) {
      reasons.add("source-changed");
    }
    if (previousPlugin.manifestHash !== currentPlugin.manifestHash) {
      reasons.add("stale-manifest");
    }
    if (
      previousPlugin.packageVersion !== currentPlugin.packageVersion ||
      previousPlugin.packageJsonHash !== currentPlugin.packageJsonHash
    ) {
      reasons.add("stale-package");
    }
  }
  for (const pluginId of currentByPluginId.keys()) {
    if (!previousByPluginId.has(pluginId)) {
      reasons.add("source-changed");
    }
  }

  return Array.from(reasons).toSorted((left, right) => left.localeCompare(right));
}
