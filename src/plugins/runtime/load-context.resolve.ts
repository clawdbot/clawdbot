// Resolves config and metadata before publishing prepared plugin runtime load facts.
import { getRuntimeConfig } from "../../config/config.js";
import { resolveConfigWidePluginManifestRegistry } from "../../config/io.plugin-metadata.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginActivationSourceConfig } from "../activation-source-config.js";
import { resolvePluginControlPlaneWorkspace } from "../control-plane-workspace.js";
import {
  getCurrentPluginMetadataSnapshot,
  isScopedPluginMetadataSnapshotRuntimeGeneration,
} from "../current-plugin-metadata-snapshot.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../installed-plugin-index-install-records.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
import {
  getCurrentPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
  getScopedPluginMetadata,
  preparePluginMetadata,
  withPluginMetadataCollectionScope,
} from "../plugin-metadata-collection.js";
import {
  projectPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
} from "../plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugin-metadata-snapshot.types.js";
import type { PluginLogger } from "../types.js";
import { createPluginRuntimeLoaderLogger, type PluginRuntimeLoadContext } from "./load-context.js";

/** Options accepted while resolving plugin runtime load context. */
type PluginRuntimeLoadContextOptions = {
  config?: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  onlyPluginIds?: readonly string[];
  logger?: PluginLogger;
  manifestRegistry?: PluginManifestRegistry;
  metadataSnapshot?: PluginMetadataSnapshot;
  preferBuiltPluginArtifacts?: boolean;
};

/** Resolves config, manifests, install records, and auto-enable state for runtime loads. */
export function resolvePluginRuntimeLoadContext(
  options?: PluginRuntimeLoadContextOptions,
): PluginRuntimeLoadContext {
  const env = options?.env ?? process.env;
  const rawConfig = options?.config ?? getRuntimeConfig();
  const workspaceDir = resolvePluginControlPlaneWorkspace({
    config: rawConfig,
    env,
    workspaceDir: options?.workspaceDir,
  }).workspaceDir;
  const ownsPreparation = !options?.metadataSnapshot && !options?.manifestRegistry;
  const current = ownsPreparation
    ? getCurrentPluginMetadataSnapshot({
        config: rawConfig,
        env,
        workspaceDir,
        allowScopedSnapshot: true,
        allowWorkspaceScopedSnapshot: true,
      })
    : undefined;
  const runtimeScoped =
    current !== undefined && isScopedPluginMetadataSnapshotRuntimeGeneration(current);
  const operationMetadata =
    ownsPreparation && !runtimeScoped && !getCurrentPluginMetadataOwner()
      ? (getScopedPluginMetadata(env) ??
        preparePluginMetadata({ config: rawConfig, env, workspaceDir }))
      : undefined;
  const metadataSnapshot =
    options?.metadataSnapshot ??
    (runtimeScoped && current
      ? options?.onlyPluginIds !== undefined
        ? projectPluginMetadataSnapshot(current, options.onlyPluginIds)
        : current
      : undefined) ??
    (operationMetadata
      ? getPluginMetadataWorkspaceSnapshot(operationMetadata, {
          workspaceDir,
          pluginIds: options?.onlyPluginIds,
        })
      : undefined) ??
    (options?.manifestRegistry === undefined
      ? resolvePluginMetadataSnapshot({
          config: rawConfig,
          env,
          workspaceDir,
          allowWorkspaceScopedCurrent: true,
          ...(options?.onlyPluginIds !== undefined ? { pluginIds: options.onlyPluginIds } : {}),
        })
      : undefined);
  const manifestRegistry = options?.manifestRegistry ?? metadataSnapshot?.manifestRegistry;
  // Config-wide policy may inspect all configured workspaces, but execution keeps
  // the exact workspace inventory. Auto-enable never changes discovery roots.
  const autoEnableManifestRegistry =
    options?.workspaceDir === undefined && ownsPreparation && !runtimeScoped
      ? resolveConfigWidePluginManifestRegistry({
          config: rawConfig,
          env,
          metadata: operationMetadata,
          ...(options?.onlyPluginIds !== undefined ? { pluginIds: options.onlyPluginIds } : {}),
        })
      : manifestRegistry;
  const activationSourceConfig = resolvePluginActivationSourceConfig({
    config: rawConfig,
    activationSourceConfig: options?.activationSourceConfig,
  });
  const applyAutoEnable = () =>
    applyPluginAutoEnable({
      config: rawConfig,
      env,
      manifestRegistry: autoEnableManifestRegistry,
      discovery: metadataSnapshot?.discovery,
    });
  const autoEnabled = operationMetadata
    ? withPluginMetadataCollectionScope(operationMetadata, applyAutoEnable, {
        config: rawConfig,
        env,
        workspaceDir,
      })
    : applyAutoEnable();
  const config = autoEnabled.config;
  const installRecords = metadataSnapshot
    ? extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index)
    : undefined;
  return {
    rawConfig,
    config,
    activationSourceConfig,
    autoEnabledReasons: autoEnabled.autoEnabledReasons,
    workspaceDir,
    env,
    logger: options?.logger ?? createPluginRuntimeLoaderLogger(),
    ...(manifestRegistry ? { manifestRegistry } : {}),
    ...(metadataSnapshot ? { metadataSnapshot } : {}),
    installRecords,
    preferBuiltPluginArtifacts: options?.preferBuiltPluginArtifacts === true,
  };
}
