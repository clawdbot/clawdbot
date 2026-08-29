import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import {
  compareOpenClawReleaseVersions,
  parseRegistryNpmSpec,
} from "../../../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../../../infra/update-channels.js";
import { safeRealpathSync } from "../../../plugins/path-safety.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { resolveUserPath } from "../../../utils.js";
import { VERSION } from "../../../version.js";
import {
  CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES,
  resolveConfiguredRuntimePluginInstallCandidate,
  VERSION_BOUND_RUNTIME_PLUGIN_IDS,
} from "./configured-runtime-plugin-installs.js";

const OPENCLAW_BETA_COMPANION_VERSION_RE = /^(\d{4}\.[1-9]\d?\.[1-9]\d?)-beta\.[1-9]\d*$/;
const OPENCLAW_STABLE_OR_BETA_COMPANION_VERSION_RE =
  /^(\d{4}\.[1-9]\d?\.[1-9]\d?)(?:-beta\.[1-9]\d*)?$/;

export function activePluginMatchesRepairableInstallRecord(params: {
  rootDir: string;
  record: PluginInstallRecord | undefined;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (params.record?.source !== "npm") {
    return false;
  }
  const recordInstallPath = params.record.installPath?.trim();
  if (!recordInstallPath) {
    return false;
  }
  // Canonical-identity match: only repair the tree the persisted record owns,
  // never a same-id plugin loaded from an unrelated path.
  const installPath = resolveUserPath(recordInstallPath, params.env);
  const pluginRoot = resolveUserPath(params.rootDir, params.env);
  const canonicalPluginRoot = safeRealpathSync(pluginRoot) ?? path.resolve(pluginRoot);
  const canonicalInstallPath = safeRealpathSync(installPath) ?? path.resolve(installPath);
  return canonicalPluginRoot === canonicalInstallPath;
}

export function resolveVersionBoundRuntimeNpmSpecForActivePackage(params: {
  pluginId: string;
  activePackageName: string | undefined;
  record: PluginInstallRecord | undefined;
}): string | undefined {
  if (params.record?.source !== "npm") {
    return undefined;
  }
  const candidate = resolveConfiguredRuntimePluginInstallCandidate(params.pluginId);
  const candidatePackageName = candidate?.npmSpec
    ? parseRegistryNpmSpec(candidate.npmSpec)?.name
    : undefined;
  const selectorPackageName = params.record.spec
    ? parseRegistryNpmSpec(params.record.spec)?.name
    : undefined;
  if (
    !candidate?.versionBoundToOpenClaw ||
    !candidate.npmSpec ||
    !candidatePackageName ||
    params.activePackageName?.trim() !== candidatePackageName ||
    selectorPackageName !== candidatePackageName
  ) {
    return undefined;
  }
  return candidate.npmSpec;
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

function betaCompanionMatchesCurrentStableVersion(params: {
  installedVersion: string;
  currentVersion: string;
}): boolean {
  const installedBase = OPENCLAW_BETA_COMPANION_VERSION_RE.exec(params.installedVersion)?.[1];
  const currentBase = OPENCLAW_STABLE_OR_BETA_COMPANION_VERSION_RE.exec(params.currentVersion)?.[1];
  return Boolean(installedBase && currentBase && installedBase === currentBase);
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

export function collectInstalledPluginIdsWithStaleVersionBoundRuntimePackages(params: {
  snapshot: PluginMetadataSnapshot;
  installRecords: Record<string, PluginInstallRecord>;
  configuredPluginIds: ReadonlySet<string>;
  updateChannel: UpdateChannel;
  env: NodeJS.ProcessEnv;
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
    const activePlugin = params.snapshot.byPluginId?.get(candidate.pluginId);
    if (
      !record ||
      !activePlugin ||
      !activePluginMatchesRepairableInstallRecord({
        rootDir: activePlugin.rootDir,
        record,
        env: params.env,
      }) ||
      !resolveVersionBoundRuntimeNpmSpecForActivePackage({
        pluginId: candidate.pluginId,
        activePackageName: activePlugin.packageName,
        record,
      })
    ) {
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
