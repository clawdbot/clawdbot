import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import { resolveNpmSpecMetadata } from "../infra/install-source-utils.js";
import {
  compareOpenClawReleaseVersions,
  isPrereleaseResolutionAllowed,
  parseRegistryNpmSpec,
} from "../infra/npm-registry-spec.js";
import {
  expectedIntegrityForUpdate,
  installedPackageNeedsOpenClawPeerLinkRepair,
  readInstalledPackagePeerDependencies,
  readInstalledPackageVersion,
} from "../infra/package-update-utils.js";
import { compareComparableSemver, parseComparableSemver } from "../infra/semver-compare.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveUserPath } from "../utils.js";
import { resolveBundledPluginSources } from "./bundled-sources.js";
import { buildClawHubPluginInstallRecordFields } from "./clawhub-install-records.js";
import { CLAWHUB_INSTALL_ERROR_CODE, installPluginFromClawHub } from "./clawhub.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import {
  getExternalizedBundledPluginLegacyPathSuffix,
  getExternalizedBundledPluginClawHubSpec,
  getExternalizedBundledPluginLookupIds,
  getExternalizedBundledPluginNpmSpec,
  getExternalizedBundledPluginPreferredSource,
  getExternalizedBundledPluginTargetId,
  type ExternalizedBundledPluginBridge,
} from "./externalized-bundled-plugins.js";
import { installPluginFromGitSpec } from "./git-install.js";
import {
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";
import {
  installPluginFromNpmSpec,
  PLUGIN_INSTALL_ERROR_CODE,
  resolvePluginInstallDir,
} from "./install.js";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "./installs.js";
import { installPluginFromMarketplace } from "./marketplace.js";
import {
  getOfficialExternalPluginCatalogEntry,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";
import { linkOpenClawPeerDependencies } from "./plugin-peer-link.js";

export type PluginUpdateLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export type PluginUpdateStatus = "updated" | "unchanged" | "skipped" | "error";

export type PluginUpdateOutcome = {
  pluginId: string;
  status: PluginUpdateStatus;
  message: string;
  currentVersion?: string;
  nextVersion?: string;
};

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

export type PluginChannelSyncSummary = {
  switchedToBundled: string[];
  switchedToClawHub: string[];
  switchedToNpm: string[];
  warnings: string[];
  errors: string[];
};

export type PluginChannelSyncResult = {
  config: OpenClawConfig;
  changed: boolean;
  summary: PluginChannelSyncSummary;
};

function formatNpmInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  result: { error: string; code?: string };
}): string {
  if (params.result.code === PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) {
    return `Failed to ${params.phase} ${params.pluginId}: npm package not found for ${params.spec}.`;
  }
  return `Failed to ${params.phase} ${params.pluginId}: ${params.result.error}`;
}

function formatMarketplaceInstallFailure(params: {
  pluginId: string;
  marketplaceSource: string;
  marketplacePlugin: string;
  phase: "check" | "update";
  error: string;
}): string {
  return (
    `Failed to ${params.phase} ${params.pluginId}: ` +
    `${params.error} (marketplace plugin ${params.marketplacePlugin} from ${params.marketplaceSource}).`
  );
}

function formatClawHubInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  error: string;
}): string {
  return `Failed to ${params.phase} ${params.pluginId}: ${params.error} (ClawHub ${params.spec}).`;
}

function formatGitInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  error: string;
}): string {
  return `Failed to ${params.phase} ${params.pluginId}: ${params.error} (git ${params.spec}).`;
}

type InstallIntegrityDrift = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: {
    resolvedSpec?: string;
    version?: string;
  };
};

function shouldSkipUnchangedNpmInstall(params: {
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

function shouldBypassTrustedOfficialUnchangedNpmCheck(params: {
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

function isBundledVersionNewer(bundledVersion: string, installedVersion: string): boolean {
  const releaseCmp = compareOpenClawReleaseVersions(bundledVersion, installedVersion);
  if (releaseCmp !== null) {
    return releaseCmp > 0;
  }
  const bundled = parseComparableSemver(bundledVersion);
  const installed = parseComparableSemver(installedVersion);
  const cmp = compareComparableSemver(bundled, installed);
  return cmp !== null && cmp > 0;
}

function pathsEqual(
  left: string | undefined,
  right: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!left || !right) {
    return false;
  }
  return resolveUserPath(left, env) === resolveUserPath(right, env);
}

function resolveRecordedExtensionsDir(params: {
  pluginId: string;
  installPath: string;
}): string | undefined {
  const parentDir = path.dirname(params.installPath);
  try {
    const canonicalInstallPath = resolvePluginInstallDir(params.pluginId, parentDir);
    return canonicalInstallPath === params.installPath ? parentDir : undefined;
  } catch {
    return undefined;
  }
}

function buildLoadPathHelpers(existing: string[], env: NodeJS.ProcessEnv = process.env) {
  let paths = [...existing];
  const resolveSet = () => new Set(paths.map((entry) => resolveUserPath(entry, env)));
  let resolved = resolveSet();
  let changed = false;

  const addPath = (value: string) => {
    const normalized = resolveUserPath(value, env);
    if (resolved.has(normalized)) {
      return;
    }
    paths.push(value);
    resolved.add(normalized);
    changed = true;
  };

  const removePath = (value: string) => {
    const normalized = resolveUserPath(value, env);
    if (!resolved.has(normalized)) {
      return;
    }
    paths = paths.filter((entry) => resolveUserPath(entry, env) !== normalized);
    resolved = resolveSet();
    changed = true;
  };

  const removeMatching = (predicate: (value: string) => boolean) => {
    const next = paths.filter((entry) => !predicate(entry));
    if (next.length === paths.length) {
      return;
    }
    paths = next;
    resolved = resolveSet();
    changed = true;
  };

  return {
    addPath,
    removePath,
    removeMatching,
    get changed() {
      return changed;
    },
    get paths() {
      return paths;
    },
  };
}

function normalizePathSegment(value: string | undefined): string {
  return (
    value
      ?.trim()
      .replaceAll("\\", "/")
      .replace(/^\/+|\/+$/g, "") ?? ""
  );
}

function pathEndsWithSegment(params: {
  value: string | undefined;
  segment: string | undefined;
  env: NodeJS.ProcessEnv;
}): boolean {
  const value = normalizePathSegment(params.value ? resolveUserPath(params.value, params.env) : "");
  const segment = normalizePathSegment(params.segment);
  return Boolean(value && segment && (value === segment || value.endsWith(`/${segment}`)));
}

function isBridgeBundledPathRecord(params: {
  bridge: ExternalizedBundledPluginBridge;
  bundledLocalPath?: string;
  record: PluginInstallRecord;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (params.record.source !== "path") {
    return false;
  }
  if (
    params.bundledLocalPath &&
    (pathsEqual(params.record.sourcePath, params.bundledLocalPath, params.env) ||
      pathsEqual(params.record.installPath, params.bundledLocalPath, params.env))
  ) {
    return true;
  }
  const bundledPathSuffix = getExternalizedBundledPluginLegacyPathSuffix(params.bridge);
  return (
    pathEndsWithSegment({
      value: params.record.sourcePath,
      segment: bundledPathSuffix,
      env: params.env,
    }) ||
    pathEndsWithSegment({
      value: params.record.installPath,
      segment: bundledPathSuffix,
      env: params.env,
    })
  );
}

function removeBridgeBundledLoadPaths(params: {
  bridge: ExternalizedBundledPluginBridge;
  loadPaths: ReturnType<typeof buildLoadPathHelpers>;
  env: NodeJS.ProcessEnv;
}) {
  const bundledPathSuffix = getExternalizedBundledPluginLegacyPathSuffix(params.bridge);
  params.loadPaths.removeMatching((entry) =>
    pathEndsWithSegment({
      value: entry,
      segment: bundledPathSuffix,
      env: params.env,
    }),
  );
}

function resolveBridgeInstallRecord(params: {
  installs: Record<string, PluginInstallRecord>;
  bridge: ExternalizedBundledPluginBridge;
}): { pluginId: string; record: PluginInstallRecord } | undefined {
  for (const pluginId of getExternalizedBundledPluginLookupIds(params.bridge)) {
    const record = params.installs[pluginId];
    if (record) {
      return { pluginId, record };
    }
  }
  return undefined;
}

function isBridgeChannelEnabledByConfig(params: {
  config: OpenClawConfig;
  bridge: ExternalizedBundledPluginBridge;
}): boolean {
  const channels = params.config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  for (const channelId of params.bridge.channelIds ?? []) {
    const entry = (channels as Record<string, unknown>)[channelId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    if (Object.is((entry as Record<string, unknown>).enabled, true)) {
      return true;
    }
  }
  return false;
}

function isExternalizedBundledPluginEnabled(params: {
  config: OpenClawConfig;
  bridge: ExternalizedBundledPluginBridge;
}): boolean {
  const normalized = normalizePluginsConfig(params.config.plugins);
  if (!normalized.enabled) {
    return false;
  }
  const pluginIds = getExternalizedBundledPluginLookupIds(params.bridge);
  if (
    pluginIds.some(
      (pluginId) =>
        normalized.deny.includes(pluginId) ||
        Object.is(normalized.entries[pluginId]?.enabled, false),
    )
  ) {
    return false;
  }
  for (const pluginId of pluginIds) {
    if (
      resolveEffectiveEnableState({
        id: pluginId,
        origin: "bundled",
        config: normalized,
        rootConfig: params.config,
        enabledByDefault: params.bridge.enabledByDefault,
      }).enabled
    ) {
      return true;
    }
  }
  if (isBridgeChannelEnabledByConfig(params)) {
    return true;
  }
  return false;
}

function shouldFallbackClawHubBridgeToNpm(result: { ok: false; code?: string }): boolean {
  return (
    result.code === CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND
  );
}

function shouldFallbackBetaClawHubUpdate(result: { ok: false; code?: string }): boolean {
  return shouldFallbackClawHubBridgeToNpm(result);
}

function describeBetaNpmFallback(params: {
  pluginId: string;
  betaSpec: string | undefined;
  fallbackSpec: string;
  result: { ok: false; code?: string; error: string };
}): string {
  const betaSpec = params.betaSpec ?? "the beta npm release";
  const missingBeta =
    params.result.code === PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND ||
    /\b(ETARGET|notarget)\b|No matching version found|dist-tag|tag .*not found/i.test(
      params.result.error,
    );
  const reason = missingBeta ? "has no beta npm release" : "failed beta npm update";
  return `Plugin "${params.pluginId}" ${reason} for ${betaSpec}; using ${params.fallbackSpec} instead. Core update can still complete.`;
}

function formatBetaChannelFallbackOutcomeSuffix(params: {
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

function npmUpdateFailureSpec(params: {
  effectiveSpec: string | undefined;
  fallbackSpec: string | undefined;
  usedFallback: boolean;
}): string {
  if (params.usedFallback && params.fallbackSpec) {
    return params.fallbackSpec;
  }
  return params.effectiveSpec ?? params.fallbackSpec ?? "unknown";
}

function resolveNpmSpecPackageName(spec: string | undefined): string | undefined {
  return spec ? parseRegistryNpmSpec(spec)?.name : undefined;
}

function resolveExactNpmSpecVersion(spec: string | undefined): string | undefined {
  const parsed = spec ? parseRegistryNpmSpec(spec) : null;
  return parsed?.selectorKind === "exact-version" ? parsed.selector : undefined;
}

function resolveClawHubSpecPackageName(spec: string | undefined): string | undefined {
  return spec ? parseClawHubPluginSpec(spec)?.name : undefined;
}

export function resolveTrustedSourceLinkedOfficialNpmSpec(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): string | undefined {
  if (params.record.source !== "npm") {
    return undefined;
  }
  const entry = getOfficialExternalPluginCatalogEntry(params.pluginId);
  if (!entry) {
    return undefined;
  }
  const officialSpec = resolveOfficialExternalPluginInstall(entry)?.npmSpec;
  const officialPackageName = resolveNpmSpecPackageName(officialSpec);
  if (!officialSpec || !officialPackageName) {
    return undefined;
  }
  const recordedPackageNames = [
    params.record.resolvedName,
    resolveNpmSpecPackageName(params.record.spec),
    resolveNpmSpecPackageName(params.record.resolvedSpec),
  ].filter((value): value is string => Boolean(value));
  return recordedPackageNames.includes(officialPackageName) ? officialSpec : undefined;
}

export function resolveTrustedSourceLinkedOfficialClawHubSpec(params: {
  pluginId: string;
  record: PluginInstallRecord;
}): string | undefined {
  if (params.record.source !== "clawhub") {
    return undefined;
  }
  const entry = getOfficialExternalPluginCatalogEntry(params.pluginId);
  if (!entry) {
    return undefined;
  }
  const officialSpec = resolveOfficialExternalPluginInstall(entry)?.clawhubSpec;
  const officialPackageName = resolveClawHubSpecPackageName(officialSpec);
  if (!officialSpec || !officialPackageName) {
    return undefined;
  }
  const recordedPackageNames = [
    params.record.clawhubPackage,
    resolveClawHubSpecPackageName(params.record.spec),
  ].filter((value): value is string => Boolean(value));
  return recordedPackageNames.includes(officialPackageName) ? officialSpec : undefined;
}

function isTrustedSourceLinkedOfficialNpmUpdate(params: {
  pluginId: string;
  spec: string | undefined;
  record: PluginInstallRecord;
}): boolean {
  const officialSpec = resolveTrustedSourceLinkedOfficialNpmSpec(params);
  const officialPackageName = resolveNpmSpecPackageName(officialSpec);
  const requestedPackageName = resolveNpmSpecPackageName(params.spec);
  return Boolean(officialPackageName && requestedPackageName === officialPackageName);
}

function isTrustedSourceLinkedOfficialBridgeNpmInstall(params: {
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

function resolveNpmUpdateSpecs(params: {
  record: PluginInstallRecord;
  specOverride?: string;
  officialSpecOverride?: string;
  updateChannel?: UpdateChannel;
}): {
  installSpec?: string;
  recordSpec?: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
} {
  const recordSpec = params.specOverride ?? params.officialSpecOverride ?? params.record.spec;
  if (!recordSpec) {
    return {};
  }
  if (params.specOverride) {
    return {
      installSpec: recordSpec,
      recordSpec,
    };
  }
  return resolveNpmInstallSpecsForUpdateChannel({
    spec: recordSpec,
    updateChannel: params.updateChannel,
  });
}

function resolveClawHubUpdateSpecs(params: {
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

function isBridgeAlreadyInstalledFromPreferredSource(params: {
  bridge: ExternalizedBundledPluginBridge;
  record: PluginInstallRecord;
}): boolean {
  const preferredSource = getExternalizedBundledPluginPreferredSource(params.bridge);
  return preferredSource === "clawhub"
    ? isBridgeClawHubInstall(params)
    : isBridgeNpmInstall(params);
}

function isBridgeInstalledFromFallbackSource(params: {
  bridge: ExternalizedBundledPluginBridge;
  record: PluginInstallRecord;
}): boolean {
  const preferredSource = getExternalizedBundledPluginPreferredSource(params.bridge);
  return preferredSource === "clawhub"
    ? isBridgeNpmInstall(params)
    : isBridgeClawHubInstall(params);
}

function replacePluginIdInList(
  entries: string[] | undefined,
  fromId: string,
  toId: string,
): string[] | undefined {
  if (!entries || entries.length === 0 || fromId === toId) {
    return entries;
  }
  const next: string[] = [];
  for (const entry of entries) {
    const value = entry === fromId ? toId : entry;
    if (!next.includes(value)) {
      next.push(value);
    }
  }
  return next;
}

function migratePluginConfigId(cfg: OpenClawConfig, fromId: string, toId: string): OpenClawConfig {
  if (fromId === toId) {
    return cfg;
  }

  const installs = cfg.plugins?.installs;
  const entries = cfg.plugins?.entries;
  const slots = cfg.plugins?.slots;
  const allow = replacePluginIdInList(cfg.plugins?.allow, fromId, toId);
  const deny = replacePluginIdInList(cfg.plugins?.deny, fromId, toId);

  const nextInstalls = installs ? { ...installs } : undefined;
  if (nextInstalls && fromId in nextInstalls) {
    const record = nextInstalls[fromId];
    if (record && !(toId in nextInstalls)) {
      nextInstalls[toId] = record;
    }
    delete nextInstalls[fromId];
  }

  const nextEntries = entries ? { ...entries } : undefined;
  if (nextEntries && fromId in nextEntries) {
    const entry = nextEntries[fromId];
    if (entry) {
      nextEntries[toId] = nextEntries[toId]
        ? {
            ...entry,
            ...nextEntries[toId],
          }
        : entry;
    }
    delete nextEntries[fromId];
  }

  const nextSlots = slots
    ? {
        ...slots,
        ...(slots.memory === fromId ? { memory: toId } : {}),
        ...(slots.contextEngine === fromId ? { contextEngine: toId } : {}),
      }
    : undefined;

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow,
      deny,
      entries: nextEntries,
      installs: nextInstalls,
      slots: nextSlots,
    },
  };
}

function createPluginUpdateIntegrityDriftHandler(params: {
  pluginId: string;
  dryRun: boolean;
  logger: PluginUpdateLogger;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}) {
  return async (drift: InstallIntegrityDrift) => {
    const payload: PluginUpdateIntegrityDriftParams = {
      pluginId: params.pluginId,
      spec: drift.spec,
      expectedIntegrity: drift.expectedIntegrity,
      actualIntegrity: drift.actualIntegrity,
      resolvedSpec: drift.resolution.resolvedSpec,
      resolvedVersion: drift.resolution.version,
      dryRun: params.dryRun,
    };
    if (params.onIntegrityDrift) {
      return await params.onIntegrityDrift(payload);
    }
    params.logger.warn?.(
      `Integrity drift for "${params.pluginId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`,
    );
    return false;
  };
}

function disablePluginConfigEntry(config: OpenClawConfig, pluginId: string): OpenClawConfig {
  const existingEntry = config.plugins?.entries?.[pluginId];
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [pluginId]: {
          ...existingEntry,
          enabled: false,
        },
      },
    },
  };
}

async function repairOpenClawPeerLinksForNpmInstalls(params: {
  config: OpenClawConfig;
  logger: PluginUpdateLogger;
}): Promise<boolean> {
  let repaired = false;
  for (const [pluginId, record] of Object.entries(params.config.plugins?.installs ?? {})) {
    if (record.source !== "npm") {
      continue;
    }

    let installPath: string;
    try {
      installPath = resolveUserPath(
        record.installPath?.trim() || resolvePluginInstallDir(pluginId),
      );
    } catch (err) {
      params.logger.warn?.(
        `Could not repair openclaw peer link for "${pluginId}" due to invalid install path: ${String(err)}`,
      );
      continue;
    }

    if (!installedPackageNeedsOpenClawPeerLinkRepair(installPath)) {
      continue;
    }

    const peerDependencies = readInstalledPackagePeerDependencies(installPath);
    if (!Object.hasOwn(peerDependencies, "openclaw")) {
      continue;
    }

    try {
      const warnings: string[] = [];
      const peerLinkRepair = await linkOpenClawPeerDependencies({
        installedDir: installPath,
        peerDependencies,
        logger: {
          info: (message) => params.logger.info?.(message),
          warn: (message) => warnings.push(message),
        },
      });
      if (peerLinkRepair.skipped > 0) {
        params.logger.warn?.(
          `Could not repair openclaw peer link for "${pluginId}" at ${installPath}: ${warnings.join("; ") || "peer link repair was skipped"}`,
        );
        continue;
      }
      repaired = !installedPackageNeedsOpenClawPeerLinkRepair(installPath) || repaired;
    } catch (err) {
      params.logger.warn?.(
        `Could not repair openclaw peer link for "${pluginId}" at ${installPath}: ${String(err)}`,
      );
    }
  }
  return repaired;
}

export async function updateNpmInstalledPlugins(params: {
  config: OpenClawConfig;
  logger?: PluginUpdateLogger;
  pluginIds?: string[];
  skipIds?: Set<string>;
  skipDisabledPlugins?: boolean;
  syncOfficialPluginInstalls?: boolean;
  disableOnFailure?: boolean;
  timeoutMs?: number;
  dryRun?: boolean;
  updateChannel?: UpdateChannel;
  dangerouslyForceUnsafeInstall?: boolean;
  specOverrides?: Record<string, string>;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<PluginUpdateSummary> {
  const logger = params.logger ?? {};
  const installs = params.config.plugins?.installs ?? {};
  const targets = params.pluginIds?.length ? params.pluginIds : Object.keys(installs);
  const normalizedPluginConfig = params.skipDisabledPlugins
    ? normalizePluginsConfig(params.config.plugins)
    : undefined;
  const bundled = resolveBundledPluginSources({});
  const outcomes: PluginUpdateOutcome[] = [];
  let next = params.config;
  let changed = false;
  let ranNpmInstaller = false;
  const installNpmSpecForUpdate = async (
    installParams: Parameters<typeof installPluginFromNpmSpec>[0],
  ): Promise<Awaited<ReturnType<typeof installPluginFromNpmSpec>>> => {
    ranNpmInstaller = true;
    return await installPluginFromNpmSpec(installParams);
  };

  const recordFailure = (pluginId: string, message: string) => {
    if (params.disableOnFailure && !params.dryRun) {
      const disabledMessage =
        `Disabled "${pluginId}" after plugin update failure; OpenClaw will continue without it. ` +
        message;
      logger.warn?.(disabledMessage);
      next = disablePluginConfigEntry(next, pluginId);
      changed = true;
      outcomes.push({
        pluginId,
        status: "skipped",
        message: disabledMessage,
      });
      return;
    }
    outcomes.push({
      pluginId,
      status: "error",
      message,
    });
  };

  for (const pluginId of targets) {
    if (params.skipIds?.has(pluginId)) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (already updated).`,
      });
      continue;
    }

    const record = installs[pluginId];
    if (!record) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `No install record for "${pluginId}".`,
      });
      continue;
    }

    const officialNpmSpec = params.syncOfficialPluginInstalls
      ? resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId, record })
      : undefined;
    const officialClawHubSpec = params.syncOfficialPluginInstalls
      ? resolveTrustedSourceLinkedOfficialClawHubSpec({ pluginId, record })
      : undefined;

    if (normalizedPluginConfig) {
      const enableState = resolveEffectiveEnableState({
        id: pluginId,
        origin: "global",
        config: normalizedPluginConfig,
        rootConfig: params.config,
      });
      if (!enableState.enabled && !officialNpmSpec && !officialClawHubSpec) {
        outcomes.push({
          pluginId,
          status: "skipped",
          message: `Skipping "${pluginId}" (${enableState.reason ?? "disabled by plugin config"}).`,
        });
        continue;
      }
    }

    if (
      record.source !== "npm" &&
      record.source !== "marketplace" &&
      record.source !== "clawhub" &&
      record.source !== "git"
    ) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (source: ${record.source}).`,
      });
      continue;
    }

    const npmSpecs =
      record.source === "npm"
        ? resolveNpmUpdateSpecs({
            record,
            specOverride: params.specOverrides?.[pluginId],
            officialSpecOverride: officialNpmSpec,
            updateChannel: params.updateChannel,
          })
        : undefined;
    const clawhubSpecs =
      record.source === "clawhub"
        ? resolveClawHubUpdateSpecs({
            record,
            officialSpecOverride: officialClawHubSpec,
            updateChannel: params.updateChannel,
          })
        : undefined;
    const effectiveSpec =
      record.source === "npm"
        ? npmSpecs?.installSpec
        : record.source === "clawhub"
          ? clawhubSpecs?.installSpec
          : record.spec;
    const recordSpec =
      record.source === "npm"
        ? npmSpecs?.recordSpec
        : record.source === "clawhub"
          ? clawhubSpecs?.recordSpec
          : record.spec;
    const expectedIntegrity =
      record.source === "npm" && effectiveSpec === record.spec
        ? expectedIntegrityForUpdate(record.spec, record.integrity)
        : undefined;
    const fallbackExpectedIntegrity =
      record.source === "npm" && npmSpecs?.fallbackSpec === record.spec
        ? expectedIntegrityForUpdate(record.spec, record.integrity)
        : undefined;
    const trustedSourceLinkedOfficialInstall = isTrustedSourceLinkedOfficialNpmUpdate({
      pluginId,
      spec: effectiveSpec,
      record,
    });

    if (record.source === "npm" && !effectiveSpec) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing npm spec).`,
      });
      continue;
    }

    if (record.source === "git" && !effectiveSpec) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing git spec).`,
      });
      continue;
    }

    if (record.source === "clawhub" && !record.clawhubPackage && !officialClawHubSpec) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing ClawHub package metadata).`,
      });
      continue;
    }

    if (record.source === "clawhub" || record.source === "marketplace") {
      const bundledSource = bundled.get(pluginId);
      if (
        bundledSource?.version &&
        record.version &&
        isBundledVersionNewer(bundledSource.version, record.version)
      ) {
        logger.warn?.(
          `Skipping "${pluginId}" update: bundled version ${bundledSource.version} is newer than the installed ${record.source} version ${record.version}. ` +
            `Uninstall the ${record.source} plugin to use the bundled version, or pin a newer version explicitly.`,
        );
        outcomes.push({
          pluginId,
          status: "skipped",
          message: `Skipping "${pluginId}": bundled version ${bundledSource.version} is newer than ${record.source} version ${record.version}.`,
        });
        continue;
      }
    }

    if (
      record.source === "marketplace" &&
      (!record.marketplaceSource || !record.marketplacePlugin)
    ) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing marketplace source metadata).`,
      });
      continue;
    }

    let installPath: string;
    try {
      installPath = resolveUserPath(
        record.installPath?.trim() || resolvePluginInstallDir(pluginId),
      );
    } catch (err) {
      recordFailure(pluginId, `Invalid install path for "${pluginId}": ${String(err)}`);
      continue;
    }
    let currentVersion: string | undefined;
    try {
      currentVersion = await readInstalledPackageVersion(installPath);
    } catch (err) {
      recordFailure(
        pluginId,
        `Failed to inspect installed package for ${pluginId}: ${String(err)}`,
      );
      continue;
    }
    const extensionsDir = resolveRecordedExtensionsDir({
      pluginId,
      installPath,
    });

    if (!params.dryRun && record.source === "npm" && currentVersion) {
      const metadataResult = await resolveNpmSpecMetadata({
        spec: effectiveSpec!,
        timeoutMs: params.timeoutMs,
      });
      if (metadataResult.ok) {
        if (
          !shouldBypassTrustedOfficialUnchangedNpmCheck({
            metadata: metadataResult.metadata,
            spec: effectiveSpec!,
            trustedSourceLinkedOfficialInstall,
          }) &&
          !installedPackageNeedsOpenClawPeerLinkRepair(installPath) &&
          shouldSkipUnchangedNpmInstall({
            currentVersion,
            record,
            metadata: metadataResult.metadata,
          })
        ) {
          outcomes.push({
            pluginId,
            status: "unchanged",
            currentVersion,
            nextVersion: metadataResult.metadata.version,
            message: `${pluginId} is up to date (${currentVersion}).`,
          });
          continue;
        }
      } else {
        logger.warn?.(
          `Could not check ${pluginId} before update; falling back to installer path: ${metadataResult.error}`,
        );
      }
    }

    if (params.dryRun) {
      let probe:
        | Awaited<ReturnType<typeof installPluginFromNpmSpec>>
        | Awaited<ReturnType<typeof installPluginFromClawHub>>
        | Awaited<ReturnType<typeof installPluginFromGitSpec>>
        | Awaited<ReturnType<typeof installPluginFromMarketplace>>;
      try {
        probe =
          record.source === "npm"
            ? await installPluginFromNpmSpec({
                spec: effectiveSpec!,
                mode: "update",
                extensionsDir,
                timeoutMs: params.timeoutMs,
                dryRun: true,
                dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                trustedSourceLinkedOfficialInstall,
                expectedPluginId: pluginId,
                expectedIntegrity,
                onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
                  pluginId,
                  dryRun: true,
                  logger,
                  onIntegrityDrift: params.onIntegrityDrift,
                }),
                logger,
              })
            : record.source === "clawhub"
              ? await installPluginFromClawHub({
                  spec: effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                  baseUrl: record.clawhubUrl,
                  mode: "update",
                  extensionsDir,
                  timeoutMs: params.timeoutMs,
                  dryRun: true,
                  dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                  expectedPluginId: pluginId,
                  logger,
                })
              : record.source === "git"
                ? await installPluginFromGitSpec({
                    spec: effectiveSpec!,
                    mode: "update",
                    extensionsDir,
                    timeoutMs: params.timeoutMs,
                    dryRun: true,
                    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                    expectedPluginId: pluginId,
                    logger,
                  })
                : await installPluginFromMarketplace({
                    marketplace: record.marketplaceSource!,
                    plugin: record.marketplacePlugin!,
                    mode: "update",
                    extensionsDir,
                    timeoutMs: params.timeoutMs,
                    dryRun: true,
                    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                    expectedPluginId: pluginId,
                    logger,
                  });
      } catch (err) {
        recordFailure(pluginId, `Failed to check ${pluginId}: ${String(err)}`);
        continue;
      }
      let usedNpmFallback = false;
      let channelFallbackSuffix = "";
      if (!probe.ok && record.source === "npm" && npmSpecs?.fallbackSpec) {
        logger.warn?.(
          describeBetaNpmFallback({
            pluginId,
            betaSpec: npmSpecs.fallbackLabel ?? effectiveSpec,
            fallbackSpec: npmSpecs.fallbackSpec,
            result: probe,
          }),
        );
        usedNpmFallback = true;
        channelFallbackSuffix = formatBetaChannelFallbackOutcomeSuffix({
          fallbackLabel: npmSpecs.fallbackLabel ?? effectiveSpec,
          fallbackSpec: npmSpecs.fallbackSpec,
          verb: "would use",
        });
        probe = await installPluginFromNpmSpec({
          spec: npmSpecs.fallbackSpec,
          mode: "update",
          extensionsDir,
          timeoutMs: params.timeoutMs,
          dryRun: true,
          dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
          trustedSourceLinkedOfficialInstall,
          expectedPluginId: pluginId,
          expectedIntegrity: fallbackExpectedIntegrity,
          onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
            pluginId,
            dryRun: true,
            logger,
            onIntegrityDrift: params.onIntegrityDrift,
          }),
          logger,
        });
      }
      if (
        !probe.ok &&
        record.source === "clawhub" &&
        clawhubSpecs?.fallbackSpec &&
        shouldFallbackBetaClawHubUpdate(probe)
      ) {
        channelFallbackSuffix = formatBetaChannelFallbackOutcomeSuffix({
          fallbackLabel: clawhubSpecs.fallbackLabel ?? effectiveSpec,
          fallbackSpec: clawhubSpecs.fallbackSpec,
          verb: "would use",
        });
        logger.warn?.(
          `Plugin "${pluginId}" has no beta ClawHub release for ${clawhubSpecs.fallbackLabel ?? effectiveSpec}; using ${clawhubSpecs.fallbackSpec} instead. Core update can still complete.`,
        );
        probe = await installPluginFromClawHub({
          spec: clawhubSpecs.fallbackSpec,
          baseUrl: record.clawhubUrl,
          mode: "update",
          extensionsDir,
          timeoutMs: params.timeoutMs,
          dryRun: true,
          dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
          expectedPluginId: pluginId,
          logger,
        });
      }
      if (!probe.ok) {
        recordFailure(
          pluginId,
          record.source === "npm"
            ? formatNpmInstallFailure({
                pluginId,
                spec: npmUpdateFailureSpec({
                  effectiveSpec,
                  fallbackSpec: npmSpecs?.fallbackSpec,
                  usedFallback: usedNpmFallback,
                }),
                phase: "check",
                result: probe,
              })
            : record.source === "clawhub"
              ? formatClawHubInstallFailure({
                  pluginId,
                  spec: effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                  phase: "check",
                  error: probe.error,
                })
              : record.source === "git"
                ? formatGitInstallFailure({
                    pluginId,
                    spec: effectiveSpec!,
                    phase: "check",
                    error: probe.error,
                  })
                : formatMarketplaceInstallFailure({
                    pluginId,
                    marketplaceSource: record.marketplaceSource!,
                    marketplacePlugin: record.marketplacePlugin!,
                    phase: "check",
                    error: probe.error,
                  }),
        );
        continue;
      }

      const probeSpec = usedNpmFallback ? npmSpecs?.fallbackSpec : effectiveSpec;
      const resolvedProbeVersion =
        probe.version ??
        (record.source === "npm" ? resolveExactNpmSpecVersion(probeSpec) : undefined);
      const nextVersion = resolvedProbeVersion ?? "unknown";
      const currentLabel = currentVersion ?? "unknown";
      const gitProbe =
        record.source === "git"
          ? (probe as Extract<Awaited<ReturnType<typeof installPluginFromGitSpec>>, { ok: true }>)
              .git
          : undefined;
      const unchanged =
        record.source === "git" && record.gitCommit && gitProbe?.commit
          ? record.gitCommit === gitProbe.commit
          : Boolean(
              currentVersion && resolvedProbeVersion && currentVersion === resolvedProbeVersion,
            );
      if (unchanged) {
        outcomes.push({
          pluginId,
          status: "unchanged",
          currentVersion: currentVersion ?? undefined,
          nextVersion: resolvedProbeVersion,
          message: `${pluginId} is up to date (${currentLabel}).${channelFallbackSuffix}`,
        });
      } else {
        outcomes.push({
          pluginId,
          status: "updated",
          currentVersion: currentVersion ?? undefined,
          nextVersion: resolvedProbeVersion,
          message: `Would update ${pluginId}: ${currentLabel} -> ${nextVersion}.${channelFallbackSuffix}`,
        });
      }
      continue;
    }

    let result:
      | Awaited<ReturnType<typeof installPluginFromNpmSpec>>
      | Awaited<ReturnType<typeof installPluginFromClawHub>>
      | Awaited<ReturnType<typeof installPluginFromGitSpec>>
      | Awaited<ReturnType<typeof installPluginFromMarketplace>>;
    try {
      result =
        record.source === "npm"
          ? await installNpmSpecForUpdate({
              spec: effectiveSpec!,
              mode: "update",
              extensionsDir,
              timeoutMs: params.timeoutMs,
              dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
              trustedSourceLinkedOfficialInstall,
              expectedPluginId: pluginId,
              expectedIntegrity,
              onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
                pluginId,
                dryRun: false,
                logger,
                onIntegrityDrift: params.onIntegrityDrift,
              }),
              logger,
            })
          : record.source === "clawhub"
            ? await installPluginFromClawHub({
                spec: effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                baseUrl: record.clawhubUrl,
                mode: "update",
                extensionsDir,
                timeoutMs: params.timeoutMs,
                dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                expectedPluginId: pluginId,
                logger,
              })
            : record.source === "git"
              ? await installPluginFromGitSpec({
                  spec: effectiveSpec!,
                  mode: "update",
                  extensionsDir,
                  timeoutMs: params.timeoutMs,
                  dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                  expectedPluginId: pluginId,
                  logger,
                })
              : await installPluginFromMarketplace({
                  marketplace: record.marketplaceSource!,
                  plugin: record.marketplacePlugin!,
                  mode: "update",
                  extensionsDir,
                  timeoutMs: params.timeoutMs,
                  dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                  expectedPluginId: pluginId,
                  logger,
                });
    } catch (err) {
      recordFailure(pluginId, `Failed to update ${pluginId}: ${String(err)}`);
      continue;
    }
    let usedNpmFallback = false;
    let channelFallbackSuffix = "";
    if (!result.ok && record.source === "npm" && npmSpecs?.fallbackSpec) {
      logger.warn?.(
        describeBetaNpmFallback({
          pluginId,
          betaSpec: npmSpecs.fallbackLabel ?? effectiveSpec,
          fallbackSpec: npmSpecs.fallbackSpec,
          result,
        }),
      );
      usedNpmFallback = true;
      channelFallbackSuffix = formatBetaChannelFallbackOutcomeSuffix({
        fallbackLabel: npmSpecs.fallbackLabel ?? effectiveSpec,
        fallbackSpec: npmSpecs.fallbackSpec,
        verb: "used",
      });
      result = await installNpmSpecForUpdate({
        spec: npmSpecs.fallbackSpec,
        mode: "update",
        extensionsDir,
        timeoutMs: params.timeoutMs,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        trustedSourceLinkedOfficialInstall,
        expectedPluginId: pluginId,
        expectedIntegrity: fallbackExpectedIntegrity,
        onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
          pluginId,
          dryRun: false,
          logger,
          onIntegrityDrift: params.onIntegrityDrift,
        }),
        logger,
      });
    }
    if (
      !result.ok &&
      record.source === "clawhub" &&
      clawhubSpecs?.fallbackSpec &&
      shouldFallbackBetaClawHubUpdate(result)
    ) {
      channelFallbackSuffix = formatBetaChannelFallbackOutcomeSuffix({
        fallbackLabel: clawhubSpecs.fallbackLabel ?? effectiveSpec,
        fallbackSpec: clawhubSpecs.fallbackSpec,
        verb: "used",
      });
      logger.warn?.(
        `Plugin "${pluginId}" has no beta ClawHub release for ${clawhubSpecs.fallbackLabel ?? effectiveSpec}; using ${clawhubSpecs.fallbackSpec} instead. Core update can still complete.`,
      );
      result = await installPluginFromClawHub({
        spec: clawhubSpecs.fallbackSpec,
        baseUrl: record.clawhubUrl,
        mode: "update",
        extensionsDir,
        timeoutMs: params.timeoutMs,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        expectedPluginId: pluginId,
        logger,
      });
    }
    if (!result.ok) {
      recordFailure(
        pluginId,
        record.source === "npm"
          ? formatNpmInstallFailure({
              pluginId,
              spec: npmUpdateFailureSpec({
                effectiveSpec,
                fallbackSpec: npmSpecs?.fallbackSpec,
                usedFallback: usedNpmFallback,
              }),
              phase: "update",
              result: result,
            })
          : record.source === "clawhub"
            ? formatClawHubInstallFailure({
                pluginId,
                spec: effectiveSpec ?? `clawhub:${record.clawhubPackage!}`,
                phase: "update",
                error: result.error,
              })
            : record.source === "git"
              ? formatGitInstallFailure({
                  pluginId,
                  spec: effectiveSpec!,
                  phase: "update",
                  error: result.error,
                })
              : formatMarketplaceInstallFailure({
                  pluginId,
                  marketplaceSource: record.marketplaceSource!,
                  marketplacePlugin: record.marketplacePlugin!,
                  phase: "update",
                  error: result.error,
                }),
      );
      continue;
    }

    const resolvedPluginId = result.pluginId;
    if (resolvedPluginId !== pluginId) {
      next = migratePluginConfigId(next, pluginId, resolvedPluginId);
    }

    const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
    if (record.source === "npm") {
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        source: "npm",
        spec: recordSpec,
        installPath: result.targetDir,
        version: nextVersion,
        ...buildNpmResolutionInstallFields(result.npmResolution),
      });
    } else if (record.source === "clawhub") {
      const clawhubResult = result as Extract<
        Awaited<ReturnType<typeof installPluginFromClawHub>>,
        { ok: true }
      >;
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        ...buildClawHubPluginInstallRecordFields(clawhubResult.clawhub),
        spec: recordSpec ?? record.spec ?? `clawhub:${record.clawhubPackage!}`,
        installPath: result.targetDir,
        version: nextVersion,
      });
    } else if (record.source === "git") {
      const gitResult = result as Extract<
        Awaited<ReturnType<typeof installPluginFromGitSpec>>,
        { ok: true }
      >;
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        source: "git",
        spec: effectiveSpec ?? record.spec,
        installPath: result.targetDir,
        version: nextVersion,
        resolvedAt: gitResult.git.resolvedAt,
        gitUrl: gitResult.git.url,
        gitRef: gitResult.git.ref,
        gitCommit: gitResult.git.commit,
      });
    } else {
      const marketplaceResult = result as Extract<
        Awaited<ReturnType<typeof installPluginFromMarketplace>>,
        { ok: true }
      >;
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        source: "marketplace",
        installPath: result.targetDir,
        version: nextVersion,
        marketplaceName: marketplaceResult.marketplaceName ?? record.marketplaceName,
        marketplaceSource: record.marketplaceSource,
        marketplacePlugin: record.marketplacePlugin,
      });
    }
    changed = true;

    const currentLabel = currentVersion ?? "unknown";
    const nextLabel = nextVersion ?? "unknown";
    if (currentVersion && nextVersion && currentVersion === nextVersion) {
      outcomes.push({
        pluginId,
        status: "unchanged",
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        message: `${pluginId} already at ${currentLabel}.${channelFallbackSuffix}`,
      });
    } else {
      outcomes.push({
        pluginId,
        status: "updated",
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        message: `Updated ${pluginId}: ${currentLabel} -> ${nextLabel}.${channelFallbackSuffix}`,
      });
    }
  }

  if (ranNpmInstaller) {
    changed =
      (await repairOpenClawPeerLinksForNpmInstalls({
        config: next,
        logger,
      })) || changed;
  }

  return { config: next, changed, outcomes };
}

export async function syncPluginsForUpdateChannel(params: {
  config: OpenClawConfig;
  channel: UpdateChannel;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginUpdateLogger;
  externalizedBundledPluginBridges?: readonly ExternalizedBundledPluginBridge[];
}): Promise<PluginChannelSyncResult> {
  const env = params.env ?? process.env;
  const logger = params.logger ?? {};
  const summary: PluginChannelSyncSummary = {
    switchedToBundled: [],
    switchedToClawHub: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  };
  const bundled = resolveBundledPluginSources({
    workspaceDir: params.workspaceDir,
    env,
  });

  let next = params.config;
  const loadHelpers = buildLoadPathHelpers(next.plugins?.load?.paths ?? [], env);
  let installs = next.plugins?.installs ?? {};
  let changed = false;

  if (params.channel === "dev") {
    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) {
        continue;
      }

      loadHelpers.addPath(bundledInfo.localPath);

      const alreadyBundled =
        record.source === "path" && pathsEqual(record.sourcePath, bundledInfo.localPath, env);
      if (alreadyBundled) {
        continue;
      }

      next = recordPluginInstall(next, {
        pluginId,
        source: "path",
        sourcePath: bundledInfo.localPath,
        installPath: bundledInfo.localPath,
        spec: record.spec ?? bundledInfo.npmSpec,
        version: record.version,
      });
      summary.switchedToBundled.push(pluginId);
      changed = true;
    }
  } else {
    const bridges = params.externalizedBundledPluginBridges ?? [];
    for (const bridge of bridges) {
      const targetPluginId = getExternalizedBundledPluginTargetId(bridge);
      const bundledInfo = bundled.get(bridge.bundledPluginId);
      if (bundledInfo) {
        continue;
      }
      const existing = resolveBridgeInstallRecord({ installs, bridge });
      if (
        !existing &&
        !isExternalizedBundledPluginEnabled({
          config: next,
          bridge,
        })
      ) {
        continue;
      }
      if (
        existing &&
        !isExternalizedBundledPluginEnabled({
          config: next,
          bridge,
        })
      ) {
        continue;
      }

      if (
        existing &&
        isBridgeAlreadyInstalledFromPreferredSource({
          bridge,
          record: existing.record,
        })
      ) {
        if (existing.pluginId !== targetPluginId) {
          next = migratePluginConfigId(next, existing.pluginId, targetPluginId);
          installs = next.plugins?.installs ?? {};
          changed = true;
        }
        removeBridgeBundledLoadPaths({ bridge, loadPaths: loadHelpers, env });
        continue;
      }

      if (
        existing &&
        !isBridgeBundledPathRecord({
          bridge,
          record: existing.record,
          env,
        }) &&
        !isBridgeInstalledFromFallbackSource({
          bridge,
          record: existing.record,
        })
      ) {
        continue;
      }

      const preferredSource = getExternalizedBundledPluginPreferredSource(bridge);
      const npmSpec = getExternalizedBundledPluginNpmSpec(bridge);
      const clawhubSpec = getExternalizedBundledPluginClawHubSpec(bridge);
      const trustedSourceLinkedOfficialInstall = isTrustedSourceLinkedOfficialBridgeNpmInstall({
        targetPluginId,
        npmSpec,
      });
      let installSource = preferredSource;
      let installSpec = preferredSource === "clawhub" ? clawhubSpec : npmSpec;
      let result:
        | Awaited<ReturnType<typeof installPluginFromNpmSpec>>
        | Awaited<ReturnType<typeof installPluginFromClawHub>>;

      if (!installSpec) {
        const message = `Failed to update ${targetPluginId}: missing ${preferredSource} install spec for externalized bundled plugin.`;
        summary.errors.push(message);
        logger.error?.(message);
        continue;
      }

      if (preferredSource === "clawhub") {
        result = await installPluginFromClawHub({
          spec: clawhubSpec,
          ...(bridge.clawhubUrl ? { baseUrl: bridge.clawhubUrl } : {}),
          mode: "update",
          expectedPluginId: targetPluginId,
          logger,
        });
        if (!result.ok && npmSpec && shouldFallbackClawHubBridgeToNpm(result)) {
          const warning = `ClawHub ${clawhubSpec} unavailable for ${targetPluginId}; falling back to npm ${npmSpec}.`;
          summary.warnings.push(warning);
          logger.warn?.(warning);
          installSource = "npm";
          installSpec = npmSpec;
          result = await installPluginFromNpmSpec({
            spec: npmSpec,
            mode: "update",
            expectedPluginId: targetPluginId,
            trustedSourceLinkedOfficialInstall,
            logger,
          });
        }
      } else {
        result = await installPluginFromNpmSpec({
          spec: npmSpec,
          mode: "update",
          expectedPluginId: targetPluginId,
          trustedSourceLinkedOfficialInstall,
          logger,
        });
      }

      if (!result.ok) {
        const message =
          installSource === "clawhub"
            ? formatClawHubInstallFailure({
                pluginId: targetPluginId,
                spec: installSpec,
                phase: "update",
                error: result.error,
              })
            : formatNpmInstallFailure({
                pluginId: targetPluginId,
                spec: installSpec,
                phase: "update",
                result,
              });
        summary.errors.push(message);
        logger.error?.(message);
        continue;
      }

      const resolvedPluginId = result.pluginId;
      if (existing && existing.pluginId !== resolvedPluginId) {
        next = migratePluginConfigId(next, existing.pluginId, resolvedPluginId);
      }
      const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
      if (installSource === "clawhub") {
        const clawhubResult = result as Extract<
          Awaited<ReturnType<typeof installPluginFromClawHub>>,
          { ok: true }
        >;
        next = recordPluginInstall(next, {
          pluginId: resolvedPluginId,
          ...buildClawHubPluginInstallRecordFields(clawhubResult.clawhub),
          spec: installSpec,
          installPath: result.targetDir,
          version: nextVersion,
        });
      } else {
        const npmResult = result as Extract<
          Awaited<ReturnType<typeof installPluginFromNpmSpec>>,
          { ok: true }
        >;
        next = recordPluginInstall(next, {
          pluginId: resolvedPluginId,
          source: "npm",
          spec: installSpec,
          installPath: result.targetDir,
          version: nextVersion,
          ...buildNpmResolutionInstallFields(npmResult.npmResolution),
        });
      }
      installs = next.plugins?.installs ?? {};
      if (existing?.record.sourcePath) {
        loadHelpers.removePath(existing.record.sourcePath);
      }
      if (existing?.record.installPath) {
        loadHelpers.removePath(existing.record.installPath);
      }
      removeBridgeBundledLoadPaths({ bridge, loadPaths: loadHelpers, env });
      if (installSource === "clawhub") {
        summary.switchedToClawHub.push(resolvedPluginId);
      } else {
        summary.switchedToNpm.push(resolvedPluginId);
      }
      changed = true;
    }

    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) {
        continue;
      }

      if (record.source === "npm") {
        loadHelpers.removePath(bundledInfo.localPath);
        continue;
      }

      if (record.source !== "path") {
        continue;
      }
      if (!pathsEqual(record.sourcePath, bundledInfo.localPath, env)) {
        continue;
      }
      // Keep explicit bundled installs on release channels. Replacing them with
      // npm installs can reintroduce duplicate-id shadowing and packaging drift.
      loadHelpers.addPath(bundledInfo.localPath);
      const alreadyBundled =
        record.source === "path" &&
        pathsEqual(record.sourcePath, bundledInfo.localPath, env) &&
        pathsEqual(record.installPath, bundledInfo.localPath, env);
      if (alreadyBundled) {
        continue;
      }

      next = recordPluginInstall(next, {
        pluginId,
        source: "path",
        sourcePath: bundledInfo.localPath,
        installPath: bundledInfo.localPath,
        spec: record.spec ?? bundledInfo.npmSpec,
        version: record.version,
      });
      changed = true;
    }
  }

  if (loadHelpers.changed) {
    next = {
      ...next,
      plugins: {
        ...next.plugins,
        load: {
          ...next.plugins?.load,
          paths: loadHelpers.paths,
        },
      },
    };
    changed = true;
  }

  return { config: next, changed, summary };
}
