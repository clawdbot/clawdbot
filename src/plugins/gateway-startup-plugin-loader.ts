// Loads metadata snapshots and exposes Gateway startup planning entrypoints.
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayStartupPluginPlan } from "./gateway-startup-plugin-contracts.js";
import { createGatewayStartupMetadataPluginIdScope } from "./gateway-startup-plugin-metadata.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import {
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

type GatewayStartupPluginPlanParams = {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  index?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
};

export function loadGatewayStartupPluginPlanWithMetadata(params: GatewayStartupPluginPlanParams): {
  plan: GatewayStartupPluginPlan;
  metadataSnapshot: PluginMetadataSnapshot;
} {
  const snapshotConfig = params.activationSourceConfig ?? params.config;
  // Activation may change, but a supplied inventory still belongs to its boot.
  const metadataSnapshot =
    params.metadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: snapshotConfig,
      workspaceDir: params.workspaceDir,
      env: params.env,
      allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
      ...(params.index ? { index: params.index } : {}),
      pluginIdScope: createGatewayStartupMetadataPluginIdScope({
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
      }),
    });
  const plan = resolveGatewayStartupPluginPlanFromRegistry({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    index: metadataSnapshot.index,
    manifestRegistry: metadataSnapshot.manifestRegistry,
    discovery: metadataSnapshot.discovery,
    workerProviderIds: params.workerProviderIds ?? [],
    platform: params.platform,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  return { plan, metadataSnapshot };
}

export function loadGatewayStartupPluginPlan(
  params: GatewayStartupPluginPlanParams,
): GatewayStartupPluginPlan {
  return loadGatewayStartupPluginPlanWithMetadata(params).plan;
}
