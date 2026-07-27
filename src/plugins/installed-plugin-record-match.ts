import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import type { PluginCandidate } from "./discovery.js";
import { resolveTrustedSourceLinkedOfficialClawHubInstall } from "./official-external-install-records.js";
import {
  getOfficialExternalPluginCatalogEntryForPackage,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "./official-external-plugin-catalog.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";

export function matchesInstalledPluginRecord(params: {
  pluginId: string;
  candidate: PluginCandidate;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
  installPathOnly?: boolean;
}): boolean {
  if (params.candidate.origin !== "global" && params.candidate.origin !== "config") {
    return false;
  }
  const record = params.installRecords[params.pluginId];
  if (!record) {
    return false;
  }
  const candidatePaths = [
    params.candidate.rootDir,
    params.candidate.packageDir,
    params.candidate.source,
    params.candidate.setupSource,
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const resolved = resolveUserPath(entry, params.env);
      return safeRealpathSync(resolved) ?? resolved;
    });
  // Security decisions must bind to the current install output. sourcePath can
  // legitimately identify path installs, but it can also survive a source switch.
  const trackedPaths = (
    params.installPathOnly ? [record.installPath] : [record.installPath, record.sourcePath]
  )
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const resolved = resolveUserPath(entry, params.env);
      return safeRealpathSync(resolved) ?? resolved;
    });
  if (candidatePaths.length === 0 || trackedPaths.length === 0) {
    return false;
  }
  return trackedPaths.some((trackedPath) =>
    candidatePaths.some(
      (candidatePath) =>
        candidatePath === trackedPath ||
        isPathInside(trackedPath, candidatePath) ||
        (!params.installPathOnly && isPathInside(candidatePath, trackedPath)),
    ),
  );
}

function npmSpecMatchesPackage(value: string | undefined, packageName: string): boolean {
  const normalized = value?.trim();
  if (!normalized) {
    return false;
  }
  return normalized === packageName || normalized.startsWith(`${packageName}@`);
}

export function isTrustedOfficialPluginInstall(params: {
  pluginId: string;
  candidate: PluginCandidate;
  env: NodeJS.ProcessEnv;
  installRecords: Record<string, PluginInstallRecord>;
}): boolean {
  if (
    (params.candidate.origin !== "global" && params.candidate.origin !== "config") ||
    !matchesInstalledPluginRecord({ ...params, installPathOnly: true })
  ) {
    return false;
  }
  const packageName = params.candidate.packageName?.trim();
  if (!packageName) {
    return false;
  }
  const catalogEntry = getOfficialExternalPluginCatalogEntryForPackage(packageName);
  if (!catalogEntry || resolveOfficialExternalPluginId(catalogEntry) !== params.pluginId) {
    return false;
  }
  const officialInstall = resolveOfficialExternalPluginInstall(catalogEntry);
  const installRecord = params.installRecords[params.pluginId];
  if (!installRecord) {
    return false;
  }
  if (
    installRecord.source === "npm" &&
    installRecord.artifactKind === undefined &&
    installRecord.sourcePath === undefined &&
    officialInstall?.npmSpec === packageName &&
    [
      installRecord.resolvedName,
      installRecord.spec,
      installRecord.resolvedSpec,
      params.candidate.packageName,
    ].some((value) => npmSpecMatchesPackage(value, packageName))
  ) {
    return true;
  }
  if (
    installRecord.source === "clawhub" &&
    resolveTrustedSourceLinkedOfficialClawHubInstall({
      pluginId: params.pluginId,
      record: installRecord,
    })
  ) {
    return true;
  }
  return false;
}
