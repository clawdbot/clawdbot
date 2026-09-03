import path from "node:path";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import {
  isInstalledPluginIndexInstallOwnerAmbiguous,
  resolveInstalledPluginIndexInstallOwner,
} from "./installed-plugin-index-install-owner.js";
import type {
  InstalledPluginIndex,
  InstalledPluginInstallRecordInfo,
} from "./installed-plugin-index-types.js";
import { safeRealpathSync } from "./path-safety.js";

function collectDuplicateInstallRecordOwners(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv,
): Set<string> {
  const ownersByPath = new Map<string, string>();
  const duplicateOwners = new Set<string>();
  const realpathCache = new Map<string, string>();
  for (const [installOwner, record] of Object.entries(index.installRecords)) {
    const rawPath = record.installPath?.trim() || record.sourcePath?.trim();
    if (!rawPath) {
      continue;
    }
    const resolved = path.resolve(resolveUserPath(rawPath, env));
    const pathKey = safeRealpathSync(resolved, realpathCache) ?? resolved;
    const existingOwner = ownersByPath.get(pathKey);
    if (existingOwner && existingOwner !== installOwner) {
      duplicateOwners.add(existingOwner);
      duplicateOwners.add(installOwner);
    }
    ownersByPath.set(pathKey, installOwner);
  }
  return duplicateOwners;
}

export type InstalledPluginPackageOwnership = {
  installOwner: string;
  installRecord: InstalledPluginInstallRecordInfo;
  pluginIds: [string, ...string[]];
};

export type InstalledPluginLifecycleOwnership =
  | ({ kind: "package" } & InstalledPluginPackageOwnership)
  | {
      kind: "orphan";
      installOwner: string;
      installRecord: InstalledPluginInstallRecordInfo;
      pluginIds: [];
    };

type InstalledPluginPackageOwnershipResult =
  | { ok: true; value: InstalledPluginPackageOwnership }
  | { ok: false; error: string };

type InstalledPluginLifecycleOwnershipResult =
  | { ok: true; value: InstalledPluginLifecycleOwnership }
  | { ok: false; error: string };

function ownershipError(pluginId: string, detail: string): InstalledPluginPackageOwnershipResult {
  return {
    ok: false,
    error:
      `Plugin "${pluginId}" ${detail}. ` +
      "Refresh the plugin registry, then reinstall the package or run openclaw doctor before retrying.",
  };
}

export function resolveInstalledPluginPackageOwnership(
  index: InstalledPluginIndex,
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
): InstalledPluginPackageOwnershipResult {
  const target = index.plugins.find((entry) => entry.pluginId === pluginId);
  if (target && isInstalledPluginIndexInstallOwnerAmbiguous(target)) {
    return ownershipError(pluginId, "has ambiguous package ownership");
  }
  const ownerFromTarget = target ? resolveInstalledPluginIndexInstallOwner(target) : undefined;
  if (target && !ownerFromTarget) {
    return ownershipError(pluginId, "has no authoritative package-owner metadata");
  }

  const ownerFromRecord = Object.hasOwn(index.installRecords, pluginId) ? pluginId : undefined;
  const installOwner = ownerFromTarget ?? ownerFromRecord;
  if (!installOwner) {
    return ownershipError(pluginId, "is not associated with a tracked package install");
  }
  if (ownerFromTarget && ownerFromRecord && ownerFromTarget !== ownerFromRecord) {
    return ownershipError(pluginId, "matches conflicting package owners");
  }
  const installRecord = index.installRecords[installOwner];
  if (!installRecord) {
    return ownershipError(pluginId, `references missing package owner "${installOwner}"`);
  }
  if (collectDuplicateInstallRecordOwners(index, env).has(installOwner)) {
    return ownershipError(pluginId, `shares package path ownership with "${installOwner}"`);
  }

  const [firstPluginId, ...remainingPluginIds] = index.plugins
    .filter(
      (entry) =>
        resolveInstalledPluginIndexInstallOwner(entry) === installOwner &&
        !isInstalledPluginIndexInstallOwnerAmbiguous(entry),
    )
    .map((entry) => entry.pluginId)
    .toSorted();
  if (!firstPluginId) {
    return ownershipError(
      pluginId,
      `package owner "${installOwner}" has no authoritative runtime child list`,
    );
  }
  const pluginIds: [string, ...string[]] = [firstPluginId, ...remainingPluginIds];
  if (target && !pluginIds.includes(target.pluginId)) {
    return ownershipError(pluginId, `does not belong to package owner "${installOwner}"`);
  }

  const realpathCache = new Map<string, string>();
  const hasUnsafePackageEntry = index.plugins.some(
    (entry) =>
      installRecordPathMatchesPluginRoot(installRecord, entry.rootDir, env, realpathCache) &&
      (isInstalledPluginIndexInstallOwnerAmbiguous(entry) ||
        resolveInstalledPluginIndexInstallOwner(entry) !== installOwner),
  );
  if (hasUnsafePackageEntry) {
    return ownershipError(pluginId, `package owner "${installOwner}" has conflicting child rows`);
  }
  return {
    ok: true,
    value: { installOwner, installRecord, pluginIds },
  };
}

export function resolveInstalledPluginLifecycleOwnership(
  index: InstalledPluginIndex,
  pluginId: string,
  env: NodeJS.ProcessEnv = process.env,
): InstalledPluginLifecycleOwnershipResult {
  const ownership = resolveInstalledPluginPackageOwnership(index, pluginId, env);
  if (ownership.ok) {
    return { ok: true, value: { kind: "package", ...ownership.value } };
  }
  const installRecord = index.installRecords[pluginId];
  if (
    !Object.hasOwn(index.installRecords, pluginId) ||
    !installRecord ||
    collectDuplicateInstallRecordOwners(index, env).has(pluginId)
  ) {
    return ownership;
  }
  const realpathCache = new Map<string, string>();
  const hasConflictingEntry = index.plugins.some(
    (entry) =>
      entry.pluginId === pluginId ||
      installRecordPathMatchesPluginRoot(installRecord, entry.rootDir, env, realpathCache),
  );
  if (hasConflictingEntry) {
    return ownership;
  }
  // Cleanup and pre-update planning may act on an exact durable tombstone.
  // Replacement reconciliation keeps using the strict package resolver.
  return {
    ok: true,
    value: { kind: "orphan", installOwner: pluginId, installRecord, pluginIds: [] },
  };
}

// Share physical path facts only within one synchronous scan. A later lifecycle
// check gets a fresh map so replaced package paths are observed again.
function installRecordPathMatchesPluginRoot(
  record: InstalledPluginInstallRecordInfo,
  rootDir: string,
  env: NodeJS.ProcessEnv,
  realpathCache: Map<string, string>,
): boolean {
  const resolvedRoot =
    safeRealpathSync(path.resolve(rootDir), realpathCache) ?? path.resolve(rootDir);
  return [record.installPath, record.sourcePath].some((candidate) => {
    if (!candidate?.trim()) {
      return false;
    }
    const candidatePath = path.resolve(resolveUserPath(candidate, env));
    const resolvedCandidate = safeRealpathSync(candidatePath, realpathCache) ?? candidatePath;
    return isPathInside(resolvedCandidate, resolvedRoot);
  });
}

export function hasMissingInstalledPluginOwnerMetadata(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (collectDuplicateInstallRecordOwners(index, env).size > 0) {
    return true;
  }
  const installRecords = Object.entries(index.installRecords);
  const realpathCache = new Map<string, string>();
  // An orphaned owner record (for example, package code removed out of band) is
  // already closed by the lifecycle resolver. It must not make every unrelated
  // config read attempt an impossible registry migration with no discoverable rows.
  return index.plugins.some(
    (plugin) =>
      isInstalledPluginIndexInstallOwnerAmbiguous(plugin) ||
      (!resolveInstalledPluginIndexInstallOwner(plugin) &&
        installRecords.some(([, record]) =>
          installRecordPathMatchesPluginRoot(record, plugin.rootDir, env, realpathCache),
        )),
  );
}
