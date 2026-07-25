// Loads metadata snapshots and exposes Gateway startup planning entrypoints.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayStartupPluginPlan } from "./gateway-startup-plugin-contracts.js";
import {
  createGatewayStartupMetadataPluginIdScope,
  isMetadataSnapshotScopedForGatewayStartup,
} from "./gateway-startup-plugin-metadata.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import {
  isPluginMetadataSnapshotCompatible,
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";

export function resolveChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return [...loadGatewayStartupPluginPlan(params).channelPluginIds];
}

export function resolveConfiguredDeferredChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): string[] {
  return [...loadGatewayStartupPluginPlan(params).configuredDeferredChannelPluginIds];
}

export function resolveGatewayStartupPluginIdsFromRegistry(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: PluginRegistrySnapshot;
  manifestRegistry: PluginManifestRegistry;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
}): string[] {
  return [...resolveGatewayStartupPluginPlanFromRegistry(params).pluginIds];
}

export function loadGatewayStartupPluginPlan(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  index?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): GatewayStartupPluginPlan {
  const snapshotConfig = params.activationSourceConfig ?? params.config;
  const pluginIdScope = createGatewayStartupMetadataPluginIdScope({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    workerProviderIds: params.workerProviderIds ?? [],
    ...(params.platform !== undefined ? { platform: params.platform } : {}),
    ...(params.ambientEnvTriggers !== undefined
      ? { ambientEnvTriggers: params.ambientEnvTriggers }
      : {}),
  });
  const metadataSnapshot =
    params.metadataSnapshot &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: snapshotConfig,
      env: params.env,
      allowScopedSnapshot: true,
      workspaceDir: params.workspaceDir,
      index: params.index,
    }) &&
    isMetadataSnapshotScopedForGatewayStartup({
      metadataSnapshot: params.metadataSnapshot,
      pluginIdScope,
    })
      ? params.metadataSnapshot
      : resolvePluginMetadataSnapshot({
          config: snapshotConfig,
          workspaceDir: params.workspaceDir,
          env: params.env,
          allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
          ...(params.index ? { index: params.index } : {}),
          pluginIdScope,
        });
  return resolveGatewayStartupPluginPlanFromRegistry({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    index: metadataSnapshot.index,
    manifestRegistry: metadataSnapshot.manifestRegistry,
    workerProviderIds: params.workerProviderIds ?? [],
    platform: params.platform,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
}

export function resolveGatewayStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): string[] {
  return [...loadGatewayStartupPluginPlan(params).pluginIds];
}
