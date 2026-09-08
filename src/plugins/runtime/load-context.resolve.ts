// Resolves config and metadata before publishing prepared plugin runtime load facts.
import { getRuntimeConfig } from "../../config/config.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../../config/io.plugin-metadata.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePluginActivationSourceConfig } from "../activation-source-config.js";
import { resolvePluginControlPlaneWorkspace } from "../control-plane-workspace.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../installed-plugin-index-install-records.js";
import type { PluginManifestRegistry } from "../manifest-registry.js";
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
  const rawWorkspaceDir = resolvePluginControlPlaneWorkspace({
    config: rawConfig,
    env,
    workspaceDir: options?.workspaceDir,
  }).workspaceDir;
  const metadataSnapshot =
    options?.metadataSnapshot ??
    (options?.manifestRegistry !== undefined
      ? undefined
      : options?.workspaceDir === undefined
        ? projectPluginMetadataSnapshot(
            resolveConfigWidePluginMetadataSnapshot({ config: rawConfig, env }),
            options?.onlyPluginIds,
          )
        : resolvePluginMetadataSnapshot({
            config: rawConfig,
            env,
            workspaceDir: rawWorkspaceDir,
            allowWorkspaceScopedCurrent: true,
            ...(options?.onlyPluginIds !== undefined ? { pluginIds: options.onlyPluginIds } : {}),
          }));
  const manifestRegistry = options?.manifestRegistry ?? metadataSnapshot?.manifestRegistry;
  const activationSourceConfig = resolvePluginActivationSourceConfig({
    config: rawConfig,
    activationSourceConfig: options?.activationSourceConfig,
  });
  const autoEnabled = applyPluginAutoEnable({
    config: rawConfig,
    env,
    manifestRegistry,
    discovery: metadataSnapshot?.discovery,
  });
  const config = autoEnabled.config;
  const workspaceDir = resolvePluginControlPlaneWorkspace({
    config,
    env,
    workspaceDir: options?.workspaceDir,
  }).workspaceDir;
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
    preferBuiltPluginArtifacts: options?.preferBuiltPluginArtifacts,
  };
}
