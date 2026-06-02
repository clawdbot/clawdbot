import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGatewayStartupMetadataPluginIdScope,
  isMetadataSnapshotScopedForGatewayStartup,
  resolveGatewayStartupPluginPlanFromRegistry,
  type GatewayStartupPluginPlan,
} from "./channel-plugin-ids.js";
import {
  isPluginMetadataSnapshotCompatible,
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
  type PluginMetadataSnapshotOwnerMaps,
} from "./plugin-metadata-snapshot.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";

export type PluginLookUpTableOwnerMaps = PluginMetadataSnapshotOwnerMaps;

export type PluginLookUpTableStartupPlan = GatewayStartupPluginPlan;

export type PluginLookUpTableMetrics = {
  registrySnapshotMs: number;
  manifestRegistryMs: number;
  startupPlanMs: number;
  ownerMapsMs: number;
  totalMs: number;
  indexPluginCount: number;
  manifestPluginCount: number;
  startupPluginCount: number;
  deferredChannelPluginCount: number;
};

export type PluginLookUpTable = PluginMetadataSnapshot & {
  startup: PluginLookUpTableStartupPlan;
  metrics: PluginMetadataSnapshot["metrics"] &
    Pick<
      PluginLookUpTableMetrics,
      "startupPlanMs" | "startupPluginCount" | "deferredChannelPluginCount"
    >;
};

export type LoadPluginLookUpTableParams = {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  index?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
};

let lookupTableMemoBySnapshot = new WeakMap<
  PluginMetadataSnapshot,
  Map<string, PluginLookUpTable>
>();

export function clearPluginLookUpTableMemoForTest(): void {
  lookupTableMemoBySnapshot = new WeakMap<PluginMetadataSnapshot, Map<string, PluginLookUpTable>>();
}

export function loadPluginLookUpTable(params: LoadPluginLookUpTableParams): PluginLookUpTable {
  const requestedSnapshotConfig = params.activationSourceConfig ?? params.config;
  const pluginIdScope = createGatewayStartupMetadataPluginIdScope({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
  });
  const metadataSnapshot =
    params.metadataSnapshot &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: requestedSnapshotConfig,
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
          config: requestedSnapshotConfig,
          workspaceDir: params.workspaceDir,
          env: params.env,
          allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
          ...(params.index ? { index: params.index } : {}),
          pluginIdScope,
        });
  const memoKey = pluginIdScope.key;
  const memo = lookupTableMemoBySnapshot.get(metadataSnapshot)?.get(memoKey);
  if (memo) {
    return memo;
  }
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
  });
  const startupPlanMs = performance.now() - startupPlanStartedAt;

  const table: PluginLookUpTable = {
    ...metadataSnapshot,
    startup,
    metrics: {
      ...metadataSnapshot.metrics,
      startupPlanMs,
      totalMs: metadataSnapshot.metrics.totalMs + startupPlanMs,
      startupPluginCount: startup.pluginIds.length,
      deferredChannelPluginCount: startup.configuredDeferredChannelPluginIds.length,
    },
  };
  let memoByKey = lookupTableMemoBySnapshot.get(metadataSnapshot);
  if (!memoByKey) {
    memoByKey = new Map();
    lookupTableMemoBySnapshot.set(metadataSnapshot, memoByKey);
  }
  memoByKey.set(memoKey, table);
  return table;
}
