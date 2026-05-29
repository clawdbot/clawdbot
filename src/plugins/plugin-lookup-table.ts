import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveGatewayStartupPluginPlanFromRegistry,
  type GatewayStartupPluginPlan,
} from "./channel-plugin-ids.js";
import { hashJson } from "./installed-plugin-index-hash.js";
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
  key: string;
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

function createPluginLookUpTableMemoKey(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  index?: PluginRegistrySnapshot;
}): string {
  return hashJson({
    activationSourceConfig: params.activationSourceConfig ?? null,
    config: params.config,
    env: params.env,
    indexPolicyHash: params.index?.policyHash ?? null,
    indexGeneratedAtMs: params.index?.generatedAtMs ?? null,
    indexPlugins:
      params.index?.plugins.map((plugin) => [
        plugin.pluginId,
        plugin.manifestHash,
        plugin.installRecordHash,
      ]) ?? null,
    workspaceDir: params.workspaceDir ?? null,
  });
}

export function loadPluginLookUpTable(params: LoadPluginLookUpTableParams): PluginLookUpTable {
  const requestedSnapshotConfig = params.activationSourceConfig ?? params.config;
  const metadataSnapshot =
    params.metadataSnapshot &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: requestedSnapshotConfig,
      env: params.env,
      workspaceDir: params.workspaceDir,
      index: params.index,
    })
      ? params.metadataSnapshot
      : resolvePluginMetadataSnapshot({
          config: requestedSnapshotConfig,
          workspaceDir: params.workspaceDir,
          env: params.env,
          allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
          ...(params.index ? { index: params.index } : {}),
        });
  const memoKey = createPluginLookUpTableMemoKey({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.index !== undefined ? { index: params.index } : {}),
  });
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
    key: hashJson({
      policyHash: index.policyHash,
      generatedAtMs: index.generatedAtMs,
      plugins: index.plugins.map((plugin) => [
        plugin.pluginId,
        plugin.manifestHash,
        plugin.installRecordHash,
      ]),
      startup,
    }),
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
