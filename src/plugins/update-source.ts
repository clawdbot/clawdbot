import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { ClawHubTrustErrorCode } from "../infra/clawhub-install-trust.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { satisfiesPluginApiRange } from "../infra/clawhub.js";
import { unscopedPackageName } from "../infra/install-safe-path.js";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import { createNpmMetadataEnv, resolveNpmSpecMetadata } from "../infra/install-source-utils.js";
import {
  compareOpenClawReleaseVersions,
  isExactSemverVersion,
  isPrereleaseResolutionAllowed,
  isPrereleaseSemverVersion,
  parseRegistryNpmSpec,
} from "../infra/npm-registry-spec.js";
import { expectedIntegrityForUpdate } from "../infra/package-update-utils.js";
import { compareValidSemver } from "../infra/semver.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-error-codes.js";
import {
  getExternalizedBundledPluginClawHubSpec,
  getExternalizedBundledPluginNpmSpec,
  getExternalizedBundledPluginPreferredSource,
  type ExternalizedBundledPluginBridge,
} from "./externalized-bundled-plugins.js";
import {
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install.js";
import { checkMinHostVersion } from "./min-host-version.js";
import { resolveTrustedSourceLinkedOfficialNpmSpec } from "./official-external-install-records.js";
import {
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";
import { resolvePackagePluginApiRange } from "./package-compat.js";

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
  return Boolean(
    packageName &&
    packageName !== params.pluginId &&
    unscopedPackageName(packageName) === params.pluginId,
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

function compareNpmSemverForUpdate(left: string, right: string): number {
  const releaseCmp = compareOpenClawReleaseVersions(left, right);
  if (releaseCmp !== null) {
    return releaseCmp;
  }
  return compareValidSemver(left, right) ?? 0;
}

export async function resolveNewerExactPinnedNpmDefaultLine(params: {
  currentVersion: string | undefined;
  effectiveSpec: string | undefined;
  probeNpmVersion: string | undefined;
  timeoutMs?: number;
}): Promise<{ packageName: string; version: string } | undefined> {
  if (!params.currentVersion || !params.probeNpmVersion || !params.effectiveSpec) {
    return undefined;
  }
  const packageName = resolveNpmSpecPackageName(params.effectiveSpec);
  const exactVersion = resolveExactNpmSpecVersion(params.effectiveSpec);
  const probeNpmVersion = normalizeExactNpmVersion(params.probeNpmVersion);
  if (!packageName || !exactVersion || probeNpmVersion !== exactVersion) {
    return undefined;
  }

  const metadataResult = await resolveNpmSpecMetadata({
    spec: packageName,
    timeoutMs: params.timeoutMs,
  }).catch(() => undefined);
  if (
    !metadataResult?.ok ||
    metadataResult.metadata.name !== packageName ||
    !metadataResult.metadata.version
  ) {
    return undefined;
  }
  return compareNpmSemverForUpdate(metadataResult.metadata.version, params.currentVersion) > 0
    ? { packageName, version: metadataResult.metadata.version }
    : undefined;
}

async function loadNpmPackageVersionsForUpdate(params: {
  packageName: string;
  timeoutMs?: number;
}): Promise<string[] | null> {
  const versions = await runCommandWithTimeout(
    ["npm", "view", params.packageName, "versions", "--json"],
    {
      timeoutMs: Math.max(params.timeoutMs ?? 0, 60_000),
      env: createNpmMetadataEnv(),
    },
  );
  if (!versions || versions.code !== 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(versions.stdout.trim());
  } catch {
    return null;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (value): value is string => typeof value === "string" && isExactSemverVersion(value),
  );
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
  const versions = await loadNpmPackageVersionsForUpdate({
    packageName: parsedSpec.name,
    timeoutMs: params.timeoutMs,
  });
  const stableVersion = versions
    ?.filter((value) => !isPrereleaseSemverVersion(value))
    .toSorted(compareNpmSemverForUpdate)
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
    .toSorted(compareNpmSemverForUpdate)
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

export async function expectedIntegrityForNpmFallback(params: {
  fallbackSpec: string | undefined;
  record: PluginInstallRecord;
  timeoutMs?: number;
  trustedSourceLinkedOfficialInstall: boolean;
}): Promise<string | undefined> {
  if (params.record.source !== "npm" || !params.fallbackSpec) {
    return undefined;
  }
  if (params.fallbackSpec === params.record.spec) {
    return expectedIntegrityForUpdate(params.record.spec, params.record.integrity);
  }
  if (!params.trustedSourceLinkedOfficialInstall) {
    return undefined;
  }
  const fallbackMetadata = await resolveNpmSpecMetadata({
    spec: params.fallbackSpec,
    timeoutMs: params.timeoutMs,
  });
  if (!fallbackMetadata.ok) {
    return undefined;
  }
  const trustedPrereleaseFallback = await resolveTrustedOfficialPrereleaseFallbackMetadataForUpdate(
    {
      metadata: fallbackMetadata.metadata,
      spec: params.fallbackSpec,
      timeoutMs: params.timeoutMs,
    },
  );
  const expectedIntegrityMetadata =
    trustedPrereleaseFallback?.metadata ?? fallbackMetadata.metadata;
  if (!isNpmMetadataCompatibleWithCurrentHost(expectedIntegrityMetadata)) {
    return undefined;
  }
  return expectedIntegrityForNpmUpdate({
    effectiveSpec: params.fallbackSpec,
    metadata: expectedIntegrityMetadata,
    record: params.record,
    trustedSourceLinkedOfficialInstall: true,
  });
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
  const releaseCmp = compareOpenClawReleaseVersions(bundledVersion, installedVersion);
  if (releaseCmp !== null) {
    return releaseCmp > 0;
  }
  return (compareValidSemver(bundledVersion, installedVersion) ?? 0) > 0;
}

function shouldFallbackClawHubToDefault(result: { ok: false; code?: string }): boolean {
  return (
    result.code === CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND
  );
}

export function shouldFallbackBetaClawHubUpdate(result: { ok: false; code?: string }): boolean {
  return shouldFallbackClawHubToDefault(result);
}

function isUnavailableNpmTarget(result: { ok: false; code?: string; error: string }): boolean {
  return (
    result.code === PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND ||
    /\b(ETARGET|notarget)\b|No matching version found|dist-tag|tag .*not found/i.test(result.error)
  );
}

export function describeBetaNpmFallback(params: {
  pluginId: string;
  betaSpec: string | undefined;
  fallbackSpec: string;
  result: { ok: false; code?: string; error: string };
}): string {
  const betaSpec = params.betaSpec ?? "the beta npm release";
  const missingBeta = isUnavailableNpmTarget(params.result);
  const reason = missingBeta ? "has no beta npm release" : "failed beta npm update";
  return `Plugin "${params.pluginId}" ${reason} for ${betaSpec}; using ${params.fallbackSpec} instead. Core update can still complete.`;
}

function formatNpmSpecSelectorLabel(spec: string | undefined): string {
  const parsed = spec ? parseRegistryNpmSpec(spec) : undefined;
  if (!parsed) {
    return spec ?? "unknown";
  }
  if (parsed.selectorKind === "none") {
    return "@latest";
  }
  return `@${parsed.selector}`;
}

export function describeNpmChannelFallback(params: {
  pluginId: string;
  requestedSpec: string | undefined;
  usedSpec: string;
  result: { ok: false; code?: string; error: string };
  verb: "used" | "would use";
}): PluginUpdateChannelFallback {
  const requestedSpec = params.requestedSpec ?? "unknown";
  const requestedLabel = formatNpmSpecSelectorLabel(params.requestedSpec);
  const usedLabel = formatNpmSpecSelectorLabel(params.usedSpec);
  const reason = isUnavailableNpmTarget(params.result) ? "unavailable" : "failed";
  const message =
    reason === "unavailable"
      ? `plugin channel fallback: ${params.pluginId} ${params.verb} ${usedLabel} because ${requestedLabel} was unavailable`
      : `plugin channel fallback: ${params.pluginId} ${params.verb} ${usedLabel} after ${requestedLabel} failed`;
  return {
    requestedSpec,
    usedSpec: params.usedSpec,
    requestedLabel,
    usedLabel,
    reason,
    message,
  };
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

export function npmUpdateFailureSpec(params: {
  effectiveSpec: string | undefined;
  fallbackSpec: string | undefined;
  usedFallback: boolean;
}): string {
  if (params.usedFallback && params.fallbackSpec) {
    return params.fallbackSpec;
  }
  return params.effectiveSpec ?? params.fallbackSpec ?? "unknown";
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

function resolveClawHubSpecPackageName(spec: string | undefined): string | undefined {
  return spec ? parseClawHubPluginSpec(spec)?.name : undefined;
}

function isOfficialClawHubInstallRecord(record: PluginInstallRecord): boolean {
  if (record.source !== "clawhub" || record.clawhubChannel !== "official") {
    return false;
  }
  return (record.clawhubUrl ?? "").replace(/\/+$/, "") === "https://clawhub.ai";
}

export function resolveTrustedSourceLinkedOfficialNpmFallbackForClawHubUpdate(params: {
  pluginId: string;
  record: PluginInstallRecord;
  effectiveClawHubSpec?: string;
  recordClawHubSpec?: string;
  updateChannel?: UpdateChannel;
  coreVersion?: string;
}): {
  installSpec: string;
  recordSpec: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
} | null {
  if (!isOfficialClawHubInstallRecord(params.record)) {
    return null;
  }
  const entry = getOfficialExternalPluginCatalogEntry(params.pluginId);
  if (!entry) {
    return null;
  }
  const officialSpec = resolveOfficialExternalPluginInstall(entry)?.npmSpec;
  const officialPackageName = resolveNpmSpecPackageName(officialSpec);
  if (!officialSpec || !officialPackageName) {
    return null;
  }
  const recordedPackageNames = [
    params.record.clawhubPackage,
    resolveClawHubSpecPackageName(params.record.spec),
    resolveClawHubSpecPackageName(params.effectiveClawHubSpec),
  ].filter((value): value is string => Boolean(value));
  if (!recordedPackageNames.includes(officialPackageName)) {
    return null;
  }

  const effectiveClawHubVersion = params.effectiveClawHubSpec
    ? parseClawHubPluginSpec(params.effectiveClawHubSpec)?.version
    : undefined;
  const recordClawHubVersion = params.recordClawHubSpec
    ? parseClawHubPluginSpec(params.recordClawHubSpec)?.version
    : undefined;
  if (effectiveClawHubVersion && effectiveClawHubVersion.toLowerCase() !== "latest") {
    return {
      installSpec: `${officialPackageName}@${effectiveClawHubVersion}`,
      recordSpec:
        recordClawHubVersion && recordClawHubVersion.toLowerCase() !== "latest"
          ? `${officialPackageName}@${recordClawHubVersion}`
          : officialSpec,
      ...(params.updateChannel === "beta" && effectiveClawHubVersion.toLowerCase() === "beta"
        ? { fallbackSpec: officialSpec, fallbackLabel: `${officialPackageName}@beta` }
        : {}),
    };
  }
  return resolveNpmInstallSpecsForUpdateChannel({
    spec: officialSpec,
    updateChannel: params.updateChannel,
    officialPackageName,
    coreVersion: params.coreVersion,
  });
}

export function isTrustedSourceLinkedOfficialNpmUpdate(params: {
  pluginId: string;
  spec: string | undefined;
  record: PluginInstallRecord;
}): boolean {
  const officialSpec = resolveTrustedSourceLinkedOfficialNpmSpec(params);
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

function isBridgeNpmInstall(params: {
  bridge: ExternalizedBundledPluginBridge;
  record: PluginInstallRecord;
}): boolean {
  const npmSpec = getExternalizedBundledPluginNpmSpec(params.bridge);
  if (!npmSpec || params.record.source !== "npm") {
    return false;
  }
  const bridgePackageName = resolveNpmSpecPackageName(npmSpec);
  const recordPackageName =
    params.record.resolvedName ??
    resolveNpmSpecPackageName(params.record.spec) ??
    resolveNpmSpecPackageName(params.record.resolvedSpec);
  return Boolean(bridgePackageName && recordPackageName === bridgePackageName);
}

function isBridgeClawHubInstall(params: {
  bridge: ExternalizedBundledPluginBridge;
  record: PluginInstallRecord;
}): boolean {
  if (params.record.source !== "clawhub") {
    return false;
  }
  const clawhubSpec = getExternalizedBundledPluginClawHubSpec(params.bridge);
  const bridgeClawHubPackage = clawhubSpec ? parseClawHubPluginSpec(clawhubSpec)?.name : undefined;
  const recordClawHubPackage =
    params.record.clawhubPackage ?? parseClawHubPluginSpec(params.record.spec ?? "")?.name;
  return Boolean(bridgeClawHubPackage && recordClawHubPackage === bridgeClawHubPackage);
}

export function resolveNpmUpdateSpecs(params: {
  record: PluginInstallRecord;
  specOverride?: string;
  officialSpecOverride?: string;
  updateChannel?: UpdateChannel;
  officialPackageName?: string;
  coreVersion?: string;
}): {
  installSpec?: string;
  recordSpec?: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
} {
  const recordSpec =
    params.specOverride ??
    (params.updateChannel === "extended-stable" && params.record.spec
      ? params.record.spec
      : (params.officialSpecOverride ?? params.record.spec));
  if (!recordSpec) {
    return {};
  }
  if (params.specOverride) {
    return resolveNpmInstallSpecsForUpdateChannel({
      spec: recordSpec,
      updateChannel: params.updateChannel,
      officialPackageName: params.officialPackageName,
      coreVersion: params.coreVersion,
    });
  }
  return resolveNpmInstallSpecsForUpdateChannel({
    spec: recordSpec,
    updateChannel: params.updateChannel,
    officialPackageName: params.officialPackageName,
    coreVersion: params.coreVersion,
  });
}

export function resolveClawHubUpdateSpecs(params: {
  record: PluginInstallRecord;
  officialSpecOverride?: string;
  updateChannel?: UpdateChannel;
}): {
  installSpec?: string;
  recordSpec?: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
} {
  if (!params.officialSpecOverride && !params.record.clawhubPackage) {
    return {};
  }
  const recordSpec =
    params.officialSpecOverride ?? params.record.spec ?? `clawhub:${params.record.clawhubPackage}`;
  return resolveClawHubInstallSpecsForUpdateChannel({
    spec: recordSpec,
    updateChannel: params.updateChannel,
  });
}

export function isBridgeAlreadyInstalledFromPreferredSource(params: {
  bridge: ExternalizedBundledPluginBridge;
  record: PluginInstallRecord;
}): boolean {
  const preferredSource = getExternalizedBundledPluginPreferredSource(params.bridge);
  return preferredSource === "clawhub"
    ? isBridgeClawHubInstall(params)
    : isBridgeNpmInstall(params);
}

export function isBridgeInstalledFromFallbackSource(params: {
  bridge: ExternalizedBundledPluginBridge;
  record: PluginInstallRecord;
}): boolean {
  const preferredSource = getExternalizedBundledPluginPreferredSource(params.bridge);
  return preferredSource === "clawhub"
    ? isBridgeNpmInstall(params)
    : isBridgeClawHubInstall(params);
}
