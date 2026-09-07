import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { ClawHubTrustErrorCode } from "../infra/clawhub-install-trust.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { unscopedPackageName } from "../infra/install-safe-path.js";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import { loadNpmPackageVersions, resolveNpmSpecMetadata } from "../infra/install-source-utils.js";
import {
  isExactSemverVersion,
  isPrereleaseResolutionAllowed,
  isPrereleaseSemverVersion,
  parseRegistryNpmSpec,
} from "../infra/npm-registry-spec.js";
import {
  comparePackageUpdateVersions,
  expectedIntegrityForUpdate,
} from "../infra/package-update-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { isUnavailableClawHubTarget } from "./clawhub-error-codes.js";
import type { ExternalizedBundledPluginBridge } from "./externalized-bundled-plugins.js";
import {
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";
import { checkMinHostVersion } from "./min-host-version.js";
import * as officialInstallRecords from "./official-external-install-records.js";
import {
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";
import { satisfiesPluginApiRange, resolvePackagePluginApiRange } from "./package-compat.js";

/** Logger surface used by plugin update flows. */
export type PluginUpdateLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  terminalLinks?: boolean;
};

type PluginUpdateStatus = "updated" | "unchanged" | "skipped" | "error";

export type PluginUpdateChannelFallback = {
  requestedSpec: string;
  usedSpec: string;
  requestedLabel: string;
  usedLabel: string;
  reason: "unavailable" | "failed";
  message: string;
};

type BasePluginUpdateOutcome = {
  pluginId: string;
  message: string;
  currentVersion?: string;
  nextVersion?: string;
  channelFallback?: PluginUpdateChannelFallback;
  warning?: string;
};

export type PluginUpdateOutcome =
  | (BasePluginUpdateOutcome & {
      status: "skipped";
      code?: ClawHubTrustErrorCode;
    })
  | (BasePluginUpdateOutcome & {
      status: Exclude<PluginUpdateStatus, "skipped">;
      code?: string;
    });

export type PluginUpdateSummary = {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: PluginUpdateOutcome[];
};

export type PluginUpdateIntegrityDriftParams = {
  pluginId: string;
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  dryRun: boolean;
};

export type UpdatablePluginInstallRecord = PluginInstallRecord & {
  source: "npm" | "marketplace" | "clawhub" | "git";
};

export function isPluginInstallRecordUpdateSource(
  record: PluginInstallRecord | undefined,
): record is UpdatablePluginInstallRecord {
  return (
    record?.source === "npm" ||
    record?.source === "marketplace" ||
    record?.source === "clawhub" ||
    record?.source === "git"
  );
}

/** Return whether update identity compatibility can migrate an unscoped install key. */
export function pluginInstallRecordMayMigrateConfigId(params: {
  pluginId: string;
  record: PluginInstallRecord | undefined;
  specOverride?: string;
}): boolean {
  if (!isPluginInstallRecordUpdateSource(params.record)) {
    return false;
  }
  if (params.record?.source !== "npm") {
    // Generic package/archive installers can resolve an unscoped tracked key
    // to a scoped package id; the exact package identity is unavailable preflight.
    return !params.pluginId.includes("/");
  }
  const packageName =
    resolveNpmSpecPackageName(params.specOverride ?? params.record.spec) ??
    params.record.resolvedName ??
    resolveNpmSpecPackageName(params.record.resolvedSpec);
  return (
    (packageName !== undefined &&
      packageName !== params.pluginId &&
      unscopedPackageName(packageName) === params.pluginId) ||
    officialInstallRecords.hasOfficialNpmIdReplacement(params)
  );
}

export function shouldSkipUnchangedNpmInstall(params: {
  currentVersion?: string;
  record: {
    integrity?: string;
    shasum?: string;
    resolvedName?: string;
    resolvedSpec?: string;
    resolvedVersion?: string;
  };
  metadata: NpmSpecResolution;
}): boolean {
  if (!params.currentVersion || !params.metadata.version) {
    return false;
  }
  if (params.currentVersion !== params.metadata.version) {
    return false;
  }
  if (
    !params.record.resolvedName ||
    !params.record.resolvedSpec ||
    !params.record.resolvedVersion
  ) {
    return false;
  }
  if (!params.metadata.name || !params.metadata.resolvedSpec) {
    return false;
  }
  if (params.metadata.integrity && !params.record.integrity) {
    return false;
  }
  if (params.metadata.shasum && !params.record.shasum) {
    return false;
  }
  return (
    (!params.metadata.integrity || params.record.integrity === params.metadata.integrity) &&
    (!params.metadata.shasum || params.record.shasum === params.metadata.shasum) &&
    params.record.resolvedName === params.metadata.name &&
    params.record.resolvedSpec === params.metadata.resolvedSpec &&
    params.record.resolvedVersion === params.metadata.version
  );
}

export function shouldBypassTrustedOfficialUnchangedNpmCheck(params: {
  metadata: NpmSpecResolution;
  spec: string;
  trustedSourceLinkedOfficialInstall: boolean;
}): boolean {
  if (!params.trustedSourceLinkedOfficialInstall || !params.metadata.version) {
    return false;
  }
  const parsedSpec = parseRegistryNpmSpec(params.spec);
  return Boolean(
    parsedSpec &&
    !isPrereleaseResolutionAllowed({
      spec: parsedSpec,
      resolvedVersion: params.metadata.version,
    }),
  );
}

export function expectedIntegrityForNpmUpdate(params: {
  effectiveSpec: string | undefined;
  metadata?: NpmSpecResolution;
  record: PluginInstallRecord;
  trustedSourceLinkedOfficialInstall: boolean;
}): string | undefined {
  if (params.record.source !== "npm") {
    return undefined;
  }
  if (params.effectiveSpec === params.record.spec) {
    return expectedIntegrityForUpdate(params.record.spec, params.record.integrity);
  }
  if (!params.trustedSourceLinkedOfficialInstall || !params.metadata) {
    return undefined;
  }
  const metadataName = params.metadata.name ?? resolveNpmSpecPackageName(params.effectiveSpec);
  const recordName =
    params.record.resolvedName ??
    resolveNpmSpecPackageName(params.record.resolvedSpec) ??
    resolveNpmSpecPackageName(params.record.spec);
  if (!metadataName || metadataName !== recordName) {
    return undefined;
  }
  if (!params.metadata.version || params.metadata.version !== params.record.resolvedVersion) {
    return undefined;
  }
  return expectedIntegrityForUpdate(
    params.record.resolvedSpec ?? params.record.spec,
    params.record.integrity,
  );
}

export async function resolveNewerExactPinnedNpmDefaultLine(params: {
  currentVersion: string | undefined;
  recordedSpec: string | undefined;
  probeNpmVersion: string | undefined;
  updateChannel?: UpdateChannel;
  timeoutMs?: number;
}): Promise<{ packageName: string; registryLine: "beta" | "latest"; version: string } | undefined> {
  if (!params.currentVersion || !params.probeNpmVersion || !params.recordedSpec) {
    return undefined;
  }
  // Core alignment can produce an exact install target without changing user intent.
  // Only the recorded selector owns pin diagnostics.
  const packageName = resolveNpmSpecPackageName(params.recordedSpec);
  const exactVersion = resolveExactNpmSpecVersion(params.recordedSpec);
  const probeNpmVersion = normalizeExactNpmVersion(params.probeNpmVersion);
  if (!packageName || !exactVersion || probeNpmVersion !== exactVersion) {
    return undefined;
  }

  const specs = await resolveNpmInstallSpecsForUpdateChannel({
    spec: packageName,
    updateChannel: params.updateChannel,
    timeoutMs: params.timeoutMs,
  }).catch(() => undefined);
  if (!specs) {
    return undefined;
  }
  const registryLine = specs.channelTag ?? "latest";
  const metadataResult = specs.npmResolution
    ? { ok: true as const, metadata: specs.npmResolution }
    : await resolveNpmSpecMetadata({ spec: specs.installSpec, timeoutMs: params.timeoutMs }).catch(
        () => undefined,
      );
  if (
    !metadataResult?.ok ||
    metadataResult.metadata.name !== packageName ||
    !metadataResult.metadata.version
  ) {
    return undefined;
  }
  return comparePackageUpdateVersions(metadataResult.metadata.version, params.currentVersion) > 0
    ? { packageName, registryLine, version: metadataResult.metadata.version }
    : undefined;
}

export async function resolveTrustedOfficialPrereleaseFallbackMetadataForUpdate(params: {
  metadata: NpmSpecResolution;
  spec: string;
  timeoutMs?: number;
}): Promise<
  | {
      kind: "stable" | "prerelease-only";
      metadata: NpmSpecResolution;
    }
  | undefined
> {
  const parsedSpec = parseRegistryNpmSpec(params.spec);
  if (
    !parsedSpec ||
    !parsedSpec.name.startsWith("@openclaw/") ||
    !params.metadata.version ||
    isPrereleaseResolutionAllowed({
      spec: parsedSpec,
      resolvedVersion: params.metadata.version,
    })
  ) {
    return undefined;
  }
  const versions = await loadNpmPackageVersions({
    packageName: parsedSpec.name,
    timeoutMs: params.timeoutMs,
  });
  const stableVersion = versions
    ?.filter((value) => !isPrereleaseSemverVersion(value))
    .toSorted(comparePackageUpdateVersions)
    .at(-1);
  if (stableVersion) {
    const stableMetadata = await resolveNpmSpecMetadata({
      spec: `${parsedSpec.name}@${stableVersion}`,
      timeoutMs: params.timeoutMs,
    });
    return stableMetadata.ok ? { kind: "stable", metadata: stableMetadata.metadata } : undefined;
  }

  const prereleaseVersion = versions
    ?.filter(isPrereleaseSemverVersion)
    .toSorted(comparePackageUpdateVersions)
    .at(-1);
  if (!prereleaseVersion || !versions?.every(isPrereleaseSemverVersion)) {
    return undefined;
  }
  if (prereleaseVersion === params.metadata.version) {
    return { kind: "prerelease-only", metadata: params.metadata };
  }
  const prereleaseMetadata = await resolveNpmSpecMetadata({
    spec: `${parsedSpec.name}@${prereleaseVersion}`,
    timeoutMs: params.timeoutMs,
  });
  return prereleaseMetadata.ok
    ? { kind: "prerelease-only", metadata: prereleaseMetadata.metadata }
    : undefined;
}

export function isNpmMetadataCompatibleWithCurrentHost(metadata: NpmSpecResolution): boolean {
  const hostVersion = resolveCompatibilityHostVersion();
  const installMetadata = metadata.packageOpenClaw?.install;
  const minHostVersionCheck = checkMinHostVersion({
    currentVersion: hostVersion,
    minHostVersion: isRecord(installMetadata) ? installMetadata.minHostVersion : undefined,
  });
  if (!minHostVersionCheck.ok) {
    return false;
  }
  const pluginApiRangeCheck = resolvePackagePluginApiRange(metadata.packageOpenClaw);
  if (!pluginApiRangeCheck.ok) {
    return false;
  }
  const pluginApiRange = pluginApiRangeCheck.range;
  if (!pluginApiRange) {
    return true;
  }
  return satisfiesPluginApiRange(hostVersion, pluginApiRange);
}

export function isBundledVersionNewer(bundledVersion: string, installedVersion: string): boolean {
  return comparePackageUpdateVersions(bundledVersion, installedVersion) > 0;
}

export function shouldFallbackBetaClawHubUpdate(result: { ok: false; code?: string }): boolean {
  return isUnavailableClawHubTarget(result);
}

export function formatBetaChannelFallbackOutcomeSuffix(params: {
  fallbackLabel: string | undefined;
  fallbackSpec: string | undefined;
  verb: "used" | "would use";
}): string {
  if (!params.fallbackSpec) {
    return "";
  }
  const betaTarget = params.fallbackLabel ?? "beta target";
  return ` (warning: beta channel fallback ${params.verb} ${params.fallbackSpec} because ${betaTarget} could not be used).`;
}

export function resolveNpmSpecPackageName(spec: string | undefined): string | undefined {
  return spec ? parseRegistryNpmSpec(spec)?.name : undefined;
}

export function resolveExactNpmSpecVersion(spec: string | undefined): string | undefined {
  const parsed = spec ? parseRegistryNpmSpec(spec) : null;
  return parsed?.selectorKind === "exact-version"
    ? normalizeExactNpmVersion(parsed.selector)
    : undefined;
}

function normalizeExactNpmVersion(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!isExactSemverVersion(trimmed)) {
    return undefined;
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

export function resolveNpmResultVersion(result: {
  npmResolution?: NpmSpecResolution;
}): string | undefined {
  return result.npmResolution?.version;
}

export function isTrustedSourceLinkedOfficialNpmUpdate(params: {
  pluginId: string;
  spec: string | undefined;
  record: PluginInstallRecord;
}): boolean {
  const officialSpec = officialInstallRecords.resolveTrustedSourceLinkedOfficialNpmSpec(params);
  const officialPackageName = resolveNpmSpecPackageName(officialSpec);
  const requestedPackageName = resolveNpmSpecPackageName(params.spec);
  return Boolean(officialPackageName && requestedPackageName === officialPackageName);
}

export function isTrustedSourceLinkedOfficialBridgeNpmInstall(params: {
  targetPluginId: string;
  npmSpec: string | undefined;
}): boolean {
  const entry = getOfficialExternalPluginCatalogEntry(params.targetPluginId);
  if (!entry) {
    return false;
  }
  const officialPackageName = resolveNpmSpecPackageName(
    resolveOfficialExternalPluginInstall(entry)?.npmSpec,
  );
  const requestedPackageName = resolveNpmSpecPackageName(params.npmSpec);
  return Boolean(officialPackageName && requestedPackageName === officialPackageName);
}

/** Shares recorded target and catalog replacement precedence with update admission. */
export function resolveNpmUpdateTarget(params: {
  record: PluginInstallRecord;
  trustedOfficialInstall?: ReturnType<
    typeof officialInstallRecords.resolveTrustedSourceLinkedOfficialNpmInstall
  >;
  specOverride?: string;
  syncOfficialPluginInstalls?: boolean;
  updateChannel?: UpdateChannel;
  coreVersion?: string;
  versionBoundToCore?: boolean;
  timeoutMs?: number;
}) {
  const official = params.trustedOfficialInstall;
  const specOverride =
    params.specOverride ??
    (official?.replacementPluginId || official?.replaceNpmPackage ? official.npmSpec : undefined);
  const spec =
    specOverride ??
    params.record.spec ??
    (params.syncOfficialPluginInstalls ? official?.npmSpec : undefined);
  return {
    specOverride,
    target: spec
      ? {
          spec,
          updateChannel: params.updateChannel,
          officialPackageName: resolveNpmSpecPackageName(official?.npmSpec),
          coreVersion: params.coreVersion,
          versionBoundToCore: params.versionBoundToCore,
          timeoutMs: params.timeoutMs,
        }
      : undefined,
  };
}

export function resolveClawHubUpdateSpecs(params: {
  record: PluginInstallRecord;
  officialSpecOverride?: string;
  updateChannel?: UpdateChannel;
  officialPackageName?: string;
  coreVersion?: string;
  versionBoundToCore?: boolean;
}): {
  installSpec?: string;
  recordSpec?: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
} {
  const clawhubPackage =
    params.record.clawhubPackage ??
    parseClawHubPluginSpec(params.record.spec ?? "")?.name ??
    parseClawHubPluginSpec(params.record.resolvedSpec ?? "")?.name;
  if (!params.officialSpecOverride && !clawhubPackage) {
    return {};
  }
  const recordSpec =
    params.record.spec ??
    params.officialSpecOverride ??
    params.record.resolvedSpec ??
    `clawhub:${clawhubPackage}`;
  return resolveClawHubInstallSpecsForUpdateChannel({
    spec: recordSpec,
    updateChannel: params.updateChannel,
    officialPackageName: params.officialPackageName,
    coreVersion: params.coreVersion,
    versionBoundToCore: params.versionBoundToCore,
  });
}

/** Identity matching permits id/path cleanup, never an implicit registry-source switch. */
export function isBridgeRegistryInstall(
  bridge: ExternalizedBundledPluginBridge,
  record: PluginInstallRecord,
): boolean {
  if (record.source === "npm") {
    const packageName = resolveNpmSpecPackageName(bridge.npmSpec);
    const recordedName =
      record.resolvedName ??
      resolveNpmSpecPackageName(record.spec) ??
      resolveNpmSpecPackageName(record.resolvedSpec);
    return Boolean(packageName && packageName === recordedName);
  }
  const packageName = parseClawHubPluginSpec(bridge.clawhubSpec ?? "")?.name;
  const recordedName = record.clawhubPackage ?? parseClawHubPluginSpec(record.spec ?? "")?.name;
  return record.source === "clawhub" && Boolean(packageName && packageName === recordedName);
}
