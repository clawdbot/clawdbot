import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasNodeErrorCode, isPathInside } from "../infra/path-guards.js";
import { normalizePluginsConfig } from "./config-state.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import { isManifestPluginAvailableForControlPlane } from "./manifest-contract-eligibility.js";
import { isActivatedManifestOwner } from "./manifest-owner-policy.js";
import type { PluginManifestBackupResource } from "./manifest-types.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

export type ResolvedPluginBackupResource = PluginManifestBackupResource & {
  pluginId: string;
};

export type ActivatedPluginBackupInventory = {
  pluginRoots: string[];
  resources: ResolvedPluginBackupResource[];
};

function listPluginInstallRoots(env: NodeJS.ProcessEnv | undefined): string[] {
  const extensionsDir = resolveDefaultPluginExtensionsDir(env);
  try {
    return fs
      .readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(extensionsDir, entry.name));
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

/** Resolves effective plugin-owned backup policy without importing or activating plugin runtime. */
export function resolveActivatedPluginBackupInventory(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  workspaceDirs?: readonly string[];
}): ActivatedPluginBackupInventory {
  const normalizedConfig = normalizePluginsConfig(params.config.plugins);
  const workspaceScopes = params.workspaceDirs?.length
    ? [...new Set(params.workspaceDirs)]
    : [undefined];
  const backupRoots = [params.stateDir, ...(params.workspaceDirs ?? [])]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.resolve(root));
  const pluginRoots = new Set<string>();
  const addPluginRoot = (pluginRoot: string): void => {
    const resolvedRoot = path.resolve(pluginRoot);
    if (
      backupRoots.some(
        (backupRoot) => resolvedRoot === backupRoot || isPathInside(backupRoot, resolvedRoot),
      )
    ) {
      pluginRoots.add(resolvedRoot);
    }
  };
  for (const pluginRoot of listPluginInstallRoots(params.env)) {
    addPluginRoot(pluginRoot);
  }
  const resources = new Map<string, ResolvedPluginBackupResource>();
  for (const workspaceDir of workspaceScopes) {
    const snapshot = resolvePluginMetadataSnapshot({
      config: params.config,
      env: params.env,
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    });
    for (const candidate of snapshot.discovery?.candidates ?? []) {
      addPluginRoot(candidate.rootDir);
    }
    const invalidDeclaration = normalizedConfig.enabled
      ? snapshot.diagnostics.find((diagnostic) => {
          if (diagnostic.code !== "backup-resource-declaration-invalid") {
            return false;
          }
          if (!diagnostic.pluginId) {
            return true;
          }
          const indexedOwner = snapshot.index.plugins.find(
            (owner) => owner.pluginId === diagnostic.pluginId,
          );
          const discoveredOwner = snapshot.discovery?.candidates.find(
            (owner) => (owner.diagnosticIdHint ?? owner.idHint) === diagnostic.pluginId,
          );
          const owner = indexedOwner ?? discoveredOwner;
          if (!owner) {
            return true;
          }
          const plugin = {
            id: diagnostic.pluginId,
            origin: owner.origin,
            enabledByDefault: indexedOwner?.enabledByDefault,
            enabledByDefaultOnPlatforms: indexedOwner?.enabledByDefaultOnPlatforms?.slice(),
          };
          return (
            isActivatedManifestOwner({ plugin, normalizedConfig, rootConfig: params.config }) &&
            (!indexedOwner ||
              isManifestPluginAvailableForControlPlane({ snapshot, plugin, config: params.config }))
          );
        })
      : undefined;
    if (invalidDeclaration) {
      throw new Error(invalidDeclaration.message);
    }
    for (const plugin of snapshot.plugins) {
      if (
        !normalizedConfig.enabled ||
        !plugin.backupResources?.length ||
        !isActivatedManifestOwner({ plugin, normalizedConfig, rootConfig: params.config }) ||
        !isManifestPluginAvailableForControlPlane({
          snapshot,
          plugin,
          config: params.config,
        })
      ) {
        continue;
      }
      for (const resource of plugin.backupResources) {
        const key = `${plugin.id}\0${resource.scope}\0${resource.relativePath}\0${resource.disposition}`;
        if (!resources.has(key)) {
          resources.set(key, { pluginId: plugin.id, ...resource });
        }
      }
    }
  }
  return {
    pluginRoots: [...pluginRoots].toSorted(),
    resources: [...resources.entries()]
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, resource]) => resource),
  };
}
