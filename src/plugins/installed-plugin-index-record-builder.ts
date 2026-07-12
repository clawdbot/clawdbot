/** Builds installed-index records from normalized plugin manifest registry entries. */
import path from "node:path";
import { normalizeSortedUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginCompatCode } from "./compat/registry.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginCandidate } from "./discovery.js";
import type { PluginInstallSourceInfo } from "./install-source-info.js";
import { describePluginInstallSource } from "./install-source-info.js";
import { hashJson, safeFileSignature, safeHashFile } from "./installed-plugin-index-hash.js";
import { hasOptionalMissingPluginManifestFile } from "./installed-plugin-index-manifest.js";
import type {
  InstalledPluginContributionInfo,
  InstalledPluginIndexRecord,
  InstalledPluginInstallRecordInfo,
  InstalledPluginPackageChannelInfo,
  InstalledPluginStartupInfo,
} from "./installed-plugin-index-types.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginPackageChannel } from "./manifest.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";
import { hasKind } from "./slots.js";

function buildStartupInfo(record: PluginManifestRecord): InstalledPluginStartupInfo {
  return {
    sidecar: record.activation?.onStartup === true,
    memory: hasKind(record.kind, "memory"),
    deferConfiguredChannelFullLoadUntilAfterListen:
      record.startupDeferConfiguredChannelFullLoadUntilAfterListen === true,
    agentHarnesses: normalizeSortedUniqueStringEntries([
      ...(record.activation?.onAgentHarnesses ?? []),
      ...(record.cliBackends ?? []),
    ]),
    configPaths: normalizeSortedUniqueStringEntries(record.activation?.onConfigPaths),
  };
}

function buildContributionInfo(record: PluginManifestRecord): InstalledPluginContributionInfo {
  const contracts = Object.fromEntries(
    Object.entries(record.contracts ?? {}).map(([key, values]) => [
      key,
      normalizeSortedUniqueStringEntries(values),
    ]),
  );
  return {
    channels: normalizeSortedUniqueStringEntries(record.channels),
    channelConfigs: normalizeSortedUniqueStringEntries(Object.keys(record.channelConfigs ?? {})),
    providers: normalizeSortedUniqueStringEntries(record.providers),
    modelCatalogProviders: normalizeSortedUniqueStringEntries([
      ...Object.keys(record.modelCatalog?.providers ?? {}),
      ...Object.keys(record.modelCatalog?.aliases ?? {}),
      ...(record.modelCatalog?.suppressions ?? []).map((entry) => entry.provider),
    ]),
    modelSupportPrefixes: normalizeSortedUniqueStringEntries(record.modelSupport?.modelPrefixes),
    modelSupportPatterns: normalizeSortedUniqueStringEntries(record.modelSupport?.modelPatterns),
    autoEnableProviderIds: normalizeSortedUniqueStringEntries(
      record.autoEnableWhenConfiguredProviders,
    ),
    commandAliases: normalizeSortedUniqueStringEntries(
      record.commandAliases?.map((alias) => alias.name),
    ),
    contracts,
  };
}

/** Collects compatibility codes implied by a manifest's legacy or activation surfaces. */
export function collectPluginManifestCompatCodes(
  record: PluginManifestRecord,
): readonly PluginCompatCode[] {
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
  if (record.activation?.onAgentHarnesses?.length) {
    codes.push("activation-agent-harness-hint");
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
  if (record.activation?.onConfigPaths?.length) {
    codes.push("activation-config-path-hint");
  }
  if (record.activation?.onCapabilities?.length) {
    codes.push("activation-capability-hint");
  }
  return normalizeSortedUniqueStringEntries(codes) as readonly PluginCompatCode[];
}

function resolvePackageJsonPath(
  candidate: PluginCandidate | undefined,
  realpathCache: Map<string, string>,
): string | undefined {
  if (!candidate?.packageDir) {
    return undefined;
  }
  const packageDir =
    safeRealpathSync(candidate.packageDir, realpathCache) ?? path.resolve(candidate.packageDir);
  const packageJsonPath = path.join(packageDir, "package.json");
  const rootDir =
    candidate.rootDir === candidate.packageDir
      ? packageDir
      : (safeRealpathSync(candidate.rootDir, realpathCache) ?? path.resolve(candidate.rootDir));
  const packageJsonRealPath = safeRealpathSync(packageJsonPath, realpathCache);
  return packageJsonRealPath && isPathInside(rootDir, packageJsonRealPath)
    ? packageJsonPath
    : undefined;
}

function resolvePackageJsonRelativePath(
  rootDir: string,
  packageJsonPath: string,
  realpathCache: Map<string, string>,
): string {
  const resolvedRootDir =
    rootDir === path.dirname(packageJsonPath)
      ? path.dirname(packageJsonPath)
      : (safeRealpathSync(rootDir, realpathCache) ?? path.resolve(rootDir));
  const relativePath = path.relative(resolvedRootDir, packageJsonPath) || "package.json";
  return relativePath.split(path.sep).join("/");
}

function resolvePackageJsonRecord(params: {
  candidate: PluginCandidate | undefined;
  packageJsonPath: string | undefined;
  diagnostics: PluginDiagnostic[];
  pluginId: string;
  realpathCache: Map<string, string>;
}): InstalledPluginIndexRecord["packageJson"] | undefined {
  if (!params.candidate?.packageDir || !params.packageJsonPath) {
    return undefined;
  }
  const hash = safeHashFile({
    filePath: params.packageJsonPath,
    pluginId: params.pluginId,
    diagnostics: params.diagnostics,
    required: false,
  });
  if (!hash) {
    return undefined;
  }
  const fileSignature = safeFileSignature(params.packageJsonPath);
  return {
    path: resolvePackageJsonRelativePath(
      params.candidate.rootDir,
      params.packageJsonPath,
      params.realpathCache,
    ),
    hash,
    ...(fileSignature ? { fileSignature } : {}),
  };
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

function normalizeStringField(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function normalizePackageChannel(
  channel: PluginPackageChannel | undefined,
): InstalledPluginPackageChannelInfo | undefined {
  const id = normalizeStringField(channel?.id);
  if (!id) {
    return undefined;
  }
  return {
    ...structuredClone(channel),
    id,
  };
}

function hashManifestlessBundleRecord(record: PluginManifestRecord): string {
  return hashJson({
    id: record.id,
    name: record.name,
    description: record.description,
    version: record.version,
    format: record.format,
    bundleFormat: record.bundleFormat,
    bundleCapabilities: record.bundleCapabilities ?? [],
    skills: record.skills ?? [],
    settingsFiles: record.settingsFiles ?? [],
    hooks: record.hooks ?? [],
  });
}

function resolveManifestHash(params: {
  record: PluginManifestRecord;
  diagnostics: PluginDiagnostic[];
}): string {
  if (hasOptionalMissingPluginManifestFile(params.record)) {
    return hashManifestlessBundleRecord(params.record);
  }
  const hash = safeHashFile({
    filePath: params.record.manifestPath,
    pluginId: params.record.id,
    diagnostics: params.diagnostics,
    required: true,
  });
  if (hash) {
    return hash;
  }
  return "";
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

export function buildInstalledPluginIndexRecords(params: {
  candidates: readonly PluginCandidate[];
  registry: PluginManifestRegistry;
  config?: OpenClawConfig;
  diagnostics: PluginDiagnostic[];
  installRecords: Record<string, InstalledPluginInstallRecordInfo>;
}): InstalledPluginIndexRecord[] {
  const candidateByRootDir = buildCandidateLookup(params.candidates);
  const normalizedConfig = normalizePluginsConfig(params.config?.plugins);
  const realpathCache = new Map<string, string>();
  return params.registry.plugins.map((record): InstalledPluginIndexRecord => {
    const candidate = candidateByRootDir.get(record.rootDir);
    const packageJsonPath = resolvePackageJsonPath(candidate, realpathCache);
    const installRecord = params.installRecords[record.id];
    const packageInstall = describePackageInstallSource(candidate);
    const packageChannel = normalizePackageChannel(
      record.packageChannel ?? candidate?.packageManifest?.channel,
    );
    const manifestHash = resolveManifestHash({ record, diagnostics: params.diagnostics });
    const manifestFile = hasOptionalMissingPluginManifestFile(record)
      ? undefined
      : safeFileSignature(record.manifestPath);
    const packageJson = resolvePackageJsonRecord({
      candidate,
      packageJsonPath,
      diagnostics: params.diagnostics,
      pluginId: record.id,
      realpathCache,
    });
    const enabled = resolveEffectiveEnableState({
      id: record.id,
      origin: record.origin,
      config: normalizedConfig,
      rootConfig: params.config,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(record),
    }).enabled;
    const indexRecord: InstalledPluginIndexRecord = {
      pluginId: record.id,
      manifestPath: record.manifestPath,
      manifestHash,
      ...(manifestFile ? { manifestFile } : {}),
      source: record.source,
      rootDir: record.rootDir,
      origin: record.origin,
      enabled,
      startup: buildStartupInfo(record),
      contributions: buildContributionInfo(record),
      compat: collectPluginManifestCompatCodes(record),
    };
    if (record.format && record.format !== "openclaw") {
      indexRecord.format = record.format;
    }
    if (record.bundleFormat) {
      indexRecord.bundleFormat = record.bundleFormat;
    }
    if (record.enabledByDefault === true) {
      indexRecord.enabledByDefault = true;
    }
    if (record.enabledByDefaultOnPlatforms?.length) {
      indexRecord.enabledByDefaultOnPlatforms = [...record.enabledByDefaultOnPlatforms];
    }
    if (record.syntheticAuthRefs?.length) {
      indexRecord.syntheticAuthRefs = [...record.syntheticAuthRefs];
    }
    if (record.setupSource) {
      indexRecord.setupSource = record.setupSource;
    }
    if (candidate?.packageName) {
      indexRecord.packageName = candidate.packageName;
    }
    if (candidate?.packageVersion) {
      indexRecord.packageVersion = candidate.packageVersion;
    }
    if (installRecord) {
      indexRecord.installRecordHash = hashJson(installRecord);
    }
    if (packageInstall) {
      indexRecord.packageInstall = packageInstall;
    }
    if (packageChannel) {
      indexRecord.packageChannel = packageChannel;
    }
    if (candidate?.packageManifest?.build) {
      indexRecord.packageBuild = structuredClone(candidate.packageManifest.build);
    }
    if (packageJson) {
      indexRecord.packageJson = packageJson;
    }
    return indexRecord;
  });
}
