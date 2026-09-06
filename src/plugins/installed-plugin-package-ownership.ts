import path from "node:path";
import type { Result } from "@openclaw/normalization-core/result";
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
  realpathCache: Map<string, string>,
): Set<string> {
  const ownersByPath = new Map<string, string>();
  const duplicateOwners = new Set<string>();
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

type InstalledPluginPackageOwnershipResult = Result<InstalledPluginPackageOwnership, string>;

type InstalledPluginLifecycleOwnershipResult = Result<InstalledPluginLifecycleOwnership, string>;

function ownershipError(pluginId: string, detail: string): InstalledPluginPackageOwnershipResult {
  return {
    ok: false,
    error:
      `Plugin "${pluginId}" ${detail}. ` +
      "Refresh the plugin registry, then reinstall the package or run openclaw doctor before retrying.",
  };
}

// Reuse only while the index and package paths are unchanged in one synchronous
// phase. After yielding or replacing paths, create a fresh resolver.
export function createInstalledPluginOwnershipResolver(
  index: InstalledPluginIndex,
  env: NodeJS.ProcessEnv = process.env,
) {
  const targets = new Map<string, InstalledPluginIndex["plugins"][number]>();
  const childrenByOwner = new Map<string, string[]>();
  for (const entry of index.plugins) {
    if (!targets.has(entry.pluginId)) {
      targets.set(entry.pluginId, entry);
    }
    const installOwner = resolveInstalledPluginIndexInstallOwner(entry);
    if (installOwner) {
      const children = childrenByOwner.get(installOwner) ?? [];
      children.push(entry.pluginId);
      childrenByOwner.set(installOwner, children);
    }
  }
  for (const children of childrenByOwner.values()) {
    children.sort();
  }
  const realpathCache = new Map<string, string>();
  let duplicateOwners: Set<string> | undefined;
  const duplicates = () =>
    (duplicateOwners ??= collectDuplicateInstallRecordOwners(index, env, realpathCache));
  const unsafeOwners = new Map<string, boolean>();

  function resolvePackage(pluginId: string): InstalledPluginPackageOwnershipResult {
    const target = targets.get(pluginId);
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
    if (duplicates().has(installOwner)) {
      return ownershipError(pluginId, `shares package path ownership with "${installOwner}"`);
    }

    const [firstPluginId, ...remainingPluginIds] = childrenByOwner.get(installOwner) ?? [];
    if (!firstPluginId) {
      return ownershipError(
        pluginId,
        `package owner "${installOwner}" has no authoritative runtime child list`,
      );
    }
    // Each result owns its child list; callers cannot mutate the prepared order.
    const pluginIds: [string, ...string[]] = [firstPluginId, ...remainingPluginIds];
    const hasUnsafePackageEntry =
      unsafeOwners.get(installOwner) ??
      index.plugins.some(
        (entry) =>
          installRecordPathMatchesPluginRoot(installRecord, entry.rootDir, env, realpathCache) &&
          resolveInstalledPluginIndexInstallOwner(entry) !== installOwner,
      );
    unsafeOwners.set(installOwner, hasUnsafePackageEntry);
    if (hasUnsafePackageEntry) {
      return ownershipError(pluginId, `package owner "${installOwner}" has conflicting child rows`);
    }
    return {
      ok: true,
      value: { installOwner, installRecord, pluginIds },
    };
  }

  function resolveLifecycle(pluginId: string): InstalledPluginLifecycleOwnershipResult {
    const ownership = resolvePackage(pluginId);
    if (ownership.ok) {
      return { ok: true, value: { kind: "package", ...ownership.value } };
    }
    const installRecord = index.installRecords[pluginId];
    if (
      !Object.hasOwn(index.installRecords, pluginId) ||
      !installRecord ||
      duplicates().has(pluginId)
    ) {
      return ownership;
    }
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
  return { resolvePackage, resolveLifecycle };
}

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
  const realpathCache = new Map<string, string>();
  if (collectDuplicateInstallRecordOwners(index, env, realpathCache).size > 0) {
    return true;
  }
  const installRecords = Object.entries(index.installRecords);
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
