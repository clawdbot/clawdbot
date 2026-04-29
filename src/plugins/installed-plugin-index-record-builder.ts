import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginCompatCode } from "./compat/registry.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import type { PluginCandidate } from "./discovery.js";
import type { PluginInstallSourceInfo } from "./install-source-info.js";
import { describePluginInstallSource } from "./install-source-info.js";
import { hashJson, safeHashFile } from "./installed-plugin-index-hash.js";
import { hasOptionalMissingPluginManifestFile } from "./installed-plugin-index-manifest.js";
import type {
  InstalledPluginIndexRecord,
  InstalledPluginInstallRecordInfo,
  InstalledPluginPackageChannelInfo,
  InstalledPluginStartupInfo,
} from "./installed-plugin-index-types.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import type { PluginPackageChannel } from "./manifest.js";
import { safeRealpathSync } from "./path-safety.js";
import { hasKind } from "./slots.js";

function sortUnique(values: readonly string[] | undefined): readonly string[] {
  if (!values || values.length === 0) {
    return [];
  }
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function hasRuntimeContractSurface(record: PluginManifestRecord): boolean {
  const providers = record.providers ?? [];
  const cliBackends = record.cliBackends ?? [];
  return Boolean(
    providers.length > 0 ||
    cliBackends.length > 0 ||
    record.contracts?.speechProviders?.length ||
    record.contracts?.mediaUnderstandingProviders?.length ||
    record.contracts?.documentExtractors?.length ||
    record.contracts?.imageGenerationProviders?.length ||
    record.contracts?.videoGenerationProviders?.length ||
    record.contracts?.musicGenerationProviders?.length ||
    record.contracts?.webContentExtractors?.length ||
    record.contracts?.webFetchProviders?.length ||
    record.contracts?.webSearchProviders?.length ||
    record.contracts?.migrationProviders?.length ||
    record.contracts?.memoryEmbeddingProviders?.length ||
    hasKind(record.kind, "memory"),
  );
}

/**
 * @deprecated Compatibility classification for plugins that predate explicit
 * `activation.onStartup`. Every plugin manifest should move to an explicit
 * startup decision so Gateway boot can avoid importing inert plugins.
 */
function isLegacyImplicitStartupSidecar(record: PluginManifestRecord): boolean {
  const channels = Array.isArray(record.channels) ? record.channels : [];
  return (
    channels.length === 0 &&
    !hasRuntimeContractSurface(record) &&
    record.activation?.onStartup === undefined
  );
}

function buildStartupInfo(record: PluginManifestRecord): InstalledPluginStartupInfo {
  return {
    sidecar: record.activation?.onStartup === true || isLegacyImplicitStartupSidecar(record),
    memory: hasKind(record.kind, "memory"),
    deferConfiguredChannelFullLoadUntilAfterListen:
      record.startupDeferConfiguredChannelFullLoadUntilAfterListen === true,
    agentHarnesses: sortUnique([
      ...(record.activation?.onAgentHarnesses ?? []),
      ...(record.cliBackends ?? []),
    ]),
  };
}

export function collectPluginManifestCompatCodes(
  record: PluginManifestRecord,
): readonly PluginCompatCode[] {
  const codes: PluginCompatCode[] = [];
  if (isLegacyImplicitStartupSidecar(record)) {
    codes.push("legacy-implicit-startup-sidecar");
  }
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
  return sortUnique(codes) as readonly PluginCompatCode[];
}

function resolvePackageJsonPath(candidate: PluginCandidate | undefined): string | undefined {
  if (!candidate?.packageDir) {
    return undefined;
  }
  const packageDir = safeRealpathSync(candidate.packageDir) ?? path.resolve(candidate.packageDir);
  const packageJsonPath = path.join(packageDir, "package.json");
  return fs.existsSync(packageJsonPath) ? packageJsonPath : undefined;
}

function resolvePackageJsonRelativePath(rootDir: string, packageJsonPath: string): string {
  const resolvedRootDir = safeRealpathSync(rootDir) ?? path.resolve(rootDir);
  const relativePath = path.relative(resolvedRootDir, packageJsonPath) || "package.json";
  return relativePath.split(path.sep).join("/");
}

function resolvePackageJsonRecord(params: {
  candidate: PluginCandidate | undefined;
  packageJsonPath: string | undefined;
  diagnostics: PluginDiagnostic[];
  pluginId: string;
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
  return {
    path: resolvePackageJsonRelativePath(params.candidate.rootDir, params.packageJsonPath),
    hash,
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

function normalizeStringListField(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .flatMap((entry) => {
      const normalizedEntry = normalizeStringField(entry);
      return normalizedEntry ? [normalizedEntry] : [];
    })
    .filter((entry, index, all) => all.indexOf(entry) === index);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePackageChannel(
  channel: PluginPackageChannel | undefined,
): InstalledPluginPackageChannelInfo | undefined {
  const id = normalizeStringField(channel?.id);
  if (!id) {
    return undefined;
  }
  const label = normalizeStringField(channel?.label);
  const blurb = normalizeStringField(channel?.blurb);
  const preferOver = normalizeStringListField(channel?.preferOver);
  const commands =
    channel?.commands &&
    typeof channel.commands === "object" &&
    !Array.isArray(channel.commands) &&
    (typeof channel.commands.nativeCommandsAutoEnabled === "boolean" ||
      typeof channel.commands.nativeSkillsAutoEnabled === "boolean")
      ? {
          ...(typeof channel.commands.nativeCommandsAutoEnabled === "boolean"
            ? { nativeCommandsAutoEnabled: channel.commands.nativeCommandsAutoEnabled }
            : {}),
          ...(typeof channel.commands.nativeSkillsAutoEnabled === "boolean"
            ? { nativeSkillsAutoEnabled: channel.commands.nativeSkillsAutoEnabled }
            : {}),
        }
      : undefined;
  return {
    id,
    ...(label ? { label } : {}),
    ...(blurb ? { blurb } : {}),
    ...(preferOver ? { preferOver } : {}),
    ...(commands ? { commands } : {}),
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
  return params.registry.plugins.map((record): InstalledPluginIndexRecord => {
    const candidate = candidateByRootDir.get(record.rootDir);
    const packageJsonPath = resolvePackageJsonPath(candidate);
    const installRecord = params.installRecords[record.id];
    const packageInstall = describePackageInstallSource(candidate);
    const packageChannel = normalizePackageChannel(candidate?.packageManifest?.channel);
    const manifestHash = resolveManifestHash({ record, diagnostics: params.diagnostics });
    const packageJson = resolvePackageJsonRecord({
      candidate,
      packageJsonPath,
      diagnostics: params.diagnostics,
      pluginId: record.id,
    });
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
      source: record.source,
      rootDir: record.rootDir,
      origin: record.origin,
      enabled,
      startup: buildStartupInfo(record),
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
    if (packageJson) {
      indexRecord.packageJson = packageJson;
    }
    return indexRecord;
  });
}
