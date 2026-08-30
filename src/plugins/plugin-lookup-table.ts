/** Builds plugin lookup tables keyed by manifest ids, channels, providers, and commands. */
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGatewayStartupMetadataPluginIdScope,
  resolveGatewayStartupPluginPlanFromRegistry,
  type GatewayStartupPluginPlan,
} from "./channel-plugin-ids.js";
import { bindPluginMetadataSnapshotCache, getPluginMetadataSnapshotCache } from "./plugin-cache.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";
import { normalizeWorkerProviderIds } from "./worker-provider-id.js";

type PluginLookUpTableMetrics = PluginMetadataSnapshot["metrics"] & {
  startupPlanMs: number;
  startupPluginCount: number;
};

export type PluginLookUpTable = PluginMetadataSnapshot & {
  startup: GatewayStartupPluginPlan;
  workerProviderIds: readonly string[];
  metrics: PluginLookUpTableMetrics;
};

type LoadPluginLookUpTableParams = {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  index?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
};

export function loadPluginLookUpTable(params: LoadPluginLookUpTableParams): PluginLookUpTable {
  const requestedSnapshotConfig = params.activationSourceConfig ?? params.config;
  const workerProviderIds = normalizeWorkerProviderIds(params.workerProviderIds ?? []);
  const metadataSnapshot =
    // A caller-prepared inventory is authoritative. Startup activation selects
    // from it; policy changes never authorize discovering a replacement graph.
    params.metadataSnapshot ??
    resolvePluginMetadataSnapshot({
      config: requestedSnapshotConfig,
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
        workerProviderIds,
        ambientEnvTriggers: params.ambientEnvTriggers,
      }),
    });
  const { index, manifestRegistry } = metadataSnapshot;
  const startupPlanStartedAt = performance.now();
  const startup = resolveGatewayStartupPluginPlanFromRegistry({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    index,
    manifestRegistry,
    discovery: metadataSnapshot.discovery,
    workerProviderIds,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  const startupPlanMs = performance.now() - startupPlanStartedAt;

  const table: PluginLookUpTable = {
    ...metadataSnapshot,
    startup,
    workerProviderIds,
    metrics: {
      ...metadataSnapshot.metrics,
      startupPlanMs,
      totalMs: metadataSnapshot.metrics.totalMs + startupPlanMs,
      startupPluginCount: startup.pluginIds.length,
    },
  };
  bindPluginMetadataSnapshotCache(table, getPluginMetadataSnapshotCache(metadataSnapshot));
  return table;
}
