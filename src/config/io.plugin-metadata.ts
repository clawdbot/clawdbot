import {
  getCurrentPluginMetadataSnapshot,
  isScopedPluginMetadataSnapshotRuntimeGeneration,
} from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  createPluginMetadataOwner,
  getCurrentPluginMetadataOwner,
  getScopedPluginMetadata,
  type PreparedPluginMetadata,
} from "../plugins/plugin-metadata-collection.js";
import { resolvePluginMetadataEnvFingerprint } from "../plugins/plugin-metadata-env.js";
import { projectPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type {
  PluginMetadataSnapshot,
  PluginMetadataSnapshotPluginIdScope,
} from "../plugins/plugin-metadata-snapshot.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type ResolveConfigWidePluginMetadataParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  allowCurrent?: boolean;
  pluginIds?: readonly string[];
  pluginIdScope?: PluginMetadataSnapshotPluginIdScope;
  metadata?: PreparedPluginMetadata;
};

export function resolveConfigWidePluginMetadataSnapshot(
  params: ResolveConfigWidePluginMetadataParams,
): PluginMetadataSnapshot {
  const canUsePrepared = params.allowCurrent !== false && params.stateDir === undefined;
  const supplied = params.metadata;
  if (
    canUsePrepared &&
    supplied &&
    supplied.envFingerprint !== resolvePluginMetadataEnvFingerprint(params.env)
  ) {
    throw new Error("Config plugin metadata was prepared for a different environment");
  }
  if (canUsePrepared && !supplied) {
    // A retained run's metadata is paired with its executable registry. An ordinary
    // candidate scope may override that run, but a global union must never widen it.
    const current = getCurrentPluginMetadataSnapshot({
      env: params.env,
      allowScopedSnapshot: true,
      allowWorkspaceScopedSnapshot: true,
    });
    if (current && isScopedPluginMetadataSnapshotRuntimeGeneration(current)) {
      return projectPluginMetadataSnapshot(
        current,
        params.pluginIds ??
          (params.pluginIdScope
            ? params.pluginIdScope.resolve({ index: current.index })
            : current.pluginIds),
      );
    }
  }
  const scoped = canUsePrepared ? (supplied ?? getScopedPluginMetadata(params.env)) : undefined;
  const project = (metadata: PreparedPluginMetadata) =>
    projectPluginMetadataSnapshot(
      metadata.unionSnapshot,
      params.pluginIds ?? params.pluginIdScope?.resolve({ index: metadata.unionSnapshot.index }),
    );
  if (scoped) {
    return project(scoped);
  }
  const owner = canUsePrepared ? getCurrentPluginMetadataOwner() : undefined;
  if (owner) {
    if (params.config) {
      const prepared = owner.readConfigWide({
        config: params.config,
        env: params.env,
      });
      if (prepared) {
        return project(prepared);
      }
    } else {
      const active = owner.getActive();
      if (active && active.envFingerprint === resolvePluginMetadataEnvFingerprint(params.env)) {
        return project(active);
      }
    }
    throw new Error("Config plugin metadata must be prepared before runtime lookup");
  }
  const metadata = createPluginMetadataOwner().prepare({ ...params, config: params.config ?? {} });
  return project(metadata);
}

export function resolveConfigWidePluginManifestRegistry(
  params: ResolveConfigWidePluginMetadataParams,
): PluginManifestRegistry {
  return resolveConfigWidePluginMetadataSnapshot(params).manifestRegistry;
}
