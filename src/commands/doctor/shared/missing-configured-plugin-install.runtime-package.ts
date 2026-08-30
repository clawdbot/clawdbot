import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import type { NpmSpecResolution } from "../../../infra/install-source-utils.js";
import {
  compareOpenClawReleaseVersions,
  parseRegistryNpmSpec,
  resolveOpenClawReleaseCohortVersion,
} from "../../../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../../../infra/update-channels.js";
import { safeRealpathSync } from "../../../plugins/path-safety.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { resolveUserPath } from "../../../utils.js";
import {
  CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES,
  resolveConfiguredRuntimePluginInstallCandidate,
  VERSION_BOUND_RUNTIME_PLUGIN_IDS,
} from "./configured-runtime-plugin-installs.js";

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

function resolveActiveRuntimePackageVersion(params: {
  pluginId: string;
  snapshot: PluginMetadataSnapshot;
  record: PluginInstallRecord;
}): string | undefined {
  const plugin =
    params.snapshot.byPluginId?.get(params.pluginId) ??
    params.snapshot.plugins.find((entry) => entry.id === params.pluginId);
  return normalizeOptionalLowercaseString(
    plugin?.packageVersion ??
      plugin?.version ??
      params.record.resolvedVersion ??
      params.record.version,
  );
}

function resolveOpenClawCompanionReleaseBase(version: string): string | undefined {
  const cohortVersion = resolveOpenClawReleaseCohortVersion(version);
  return OPENCLAW_STABLE_OR_BETA_COMPANION_VERSION_RE.exec(cohortVersion)?.[1];
}

function versionBoundRuntimePackageVersionMatchesReleaseCohort(params: {
  version: string | undefined;
  currentVersion: string;
  updateChannel: UpdateChannel;
}): boolean {
  const version = normalizeOptionalLowercaseString(params.version);
  const currentVersion = normalizeOptionalLowercaseString(params.currentVersion);
  if (!version || !currentVersion) {
    return false;
  }
  const currentCohortVersion = resolveOpenClawReleaseCohortVersion(currentVersion);
  if (params.updateChannel !== "beta") {
    return version === currentCohortVersion;
  }
  const installedBase = resolveOpenClawCompanionReleaseBase(version);
  const currentBase = resolveOpenClawCompanionReleaseBase(currentCohortVersion);
  return Boolean(installedBase && currentBase && installedBase === currentBase);
}

export function describeVersionBoundRuntimeReleaseCohort(params: {
  currentVersion: string;
  updateChannel: UpdateChannel;
}): string {
  const currentCohortVersion = resolveOpenClawReleaseCohortVersion(params.currentVersion.trim());
  if (params.updateChannel !== "beta") {
    return currentCohortVersion;
  }
  const currentBase = resolveOpenClawCompanionReleaseBase(currentCohortVersion);
  return currentBase ? `${currentBase} beta` : currentCohortVersion;
}

async function readRuntimePackageVersion(params: {
  installPath: string | undefined;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const installPath = params.installPath?.trim();
  if (!installPath) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(resolveUserPath(installPath, params.env), "package.json"), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
      return undefined;
    }
    const version = parsed.version;
    return typeof version === "string" && version.trim() ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function versionBoundRuntimeNpmArtifactMatchesReleaseCohort(params: {
  npmResolution: NpmSpecResolution;
  stagedArtifactDir: string;
  env: NodeJS.ProcessEnv;
  currentVersion: string;
  updateChannel: UpdateChannel;
}): Promise<boolean> {
  const payloadVersion = await readRuntimePackageVersion({
    installPath: params.stagedArtifactDir,
    env: params.env,
  });
  return [params.npmResolution.version, payloadVersion].every((version) =>
    versionBoundRuntimePackageVersionMatchesReleaseCohort({
      version,
      currentVersion: params.currentVersion,
      updateChannel: params.updateChannel,
    }),
  );
}

export async function versionBoundRuntimeInstallRecordMatchesReleaseCohort(params: {
  record: PluginInstallRecord | undefined;
  env: NodeJS.ProcessEnv;
  currentVersion: string;
  updateChannel: UpdateChannel;
}): Promise<boolean> {
  const payloadVersion = await readRuntimePackageVersion({
    installPath: params.record?.source === "npm" ? params.record.installPath?.trim() : undefined,
    env: params.env,
  });
  return [params.record?.version, params.record?.resolvedVersion, payloadVersion].every((version) =>
    versionBoundRuntimePackageVersionMatchesReleaseCohort({
      version,
      currentVersion: params.currentVersion,
      updateChannel: params.updateChannel,
    }),
  );
}

export function preserveExactVersionBoundRuntimeSelector(params: {
  previousRecord: PluginInstallRecord | undefined;
  repairedRecord: PluginInstallRecord;
}): PluginInstallRecord | undefined {
  const previousSpec = params.previousRecord?.spec
    ? parseRegistryNpmSpec(params.previousRecord.spec)
    : null;
  if (previousSpec?.selectorKind !== "exact-version") {
    return params.repairedRecord;
  }
  const resolvedSpec = params.repairedRecord.resolvedSpec
    ? parseRegistryNpmSpec(params.repairedRecord.resolvedSpec)
    : null;
  if (
    resolvedSpec?.selectorKind !== "exact-version" ||
    resolvedSpec.name !== previousSpec.name ||
    !params.repairedRecord.resolvedSpec
  ) {
    return undefined;
  }
  return {
    ...params.repairedRecord,
    spec: params.repairedRecord.resolvedSpec,
  };
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
    versionBoundRuntimePackageVersionMatchesReleaseCohort({
      version: params.installedVersion,
      currentVersion: params.currentVersion,
      updateChannel: params.updateChannel,
    })
  ) {
    return false;
  }
  const currentCohortVersion = resolveOpenClawReleaseCohortVersion(params.currentVersion);
  const comparison = compareOpenClawReleaseVersions(params.installedVersion, currentCohortVersion);
  return comparison === null ? params.installedVersion !== currentCohortVersion : comparison < 0;
}

export function collectInstalledPluginIdsWithStaleVersionBoundRuntimePackages(params: {
  snapshot: PluginMetadataSnapshot;
  installRecords: Record<string, PluginInstallRecord>;
  configuredPluginIds: ReadonlySet<string>;
  currentVersion: string;
  updateChannel: UpdateChannel;
  env: NodeJS.ProcessEnv;
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
    const installedVersion = resolveActiveRuntimePackageVersion({
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
