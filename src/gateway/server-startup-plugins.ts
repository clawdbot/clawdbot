// Gateway plugin startup bootstrap and adjacent startup maintenance.
import { tryResolveConfiguredAgentWorkspaceDir } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagents/registry/subagent-registry.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectRegisteredEmbeddingProviderIds,
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
  listAmbientOnlyConfiguredChannelIds,
} from "../plugins/channel-plugin-ids.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../plugins/installed-plugin-index-install-records.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import {
  completePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import type { PluginRegistry, PluginRegistryParams } from "../plugins/registry-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { resolveGatewayStartupPluginActivationConfig } from "./plugin-activation-runtime-config.js";
import { listGatewayMethods } from "./server-methods-list.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";

type GatewayPluginBootstrapLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

type GatewayStartupTrace = {
  detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
};

/** Returns the config snapshot used by channel/plugin startup maintenance. */
export function resolveGatewayStartupMaintenanceConfig(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
}): OpenClawConfig {
  // Early config recovery may supply channel blocks after the start snapshot; startup
  // maintenance needs those owner configs even when the original snapshot was sparse.
  return params.cfgAtStart.channels === undefined &&
    params.startupRuntimeConfig.channels !== undefined
    ? {
        ...params.cfgAtStart,
        channels: params.startupRuntimeConfig.channels,
      }
    : params.cfgAtStart;
}

/** Runs channel, session, and pairing maintenance before plugin bootstrap. */
export async function runGatewayStartupMaintenance(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
}): Promise<void> {
  const startupMaintenanceConfig = resolveGatewayStartupMaintenanceConfig({
    cfgAtStart: params.cfgAtStart,
    startupRuntimeConfig: params.startupRuntimeConfig,
  });

  const shouldRunStartupMaintenance =
    !params.minimalTestGateway || startupMaintenanceConfig.channels !== undefined;
  if (shouldRunStartupMaintenance) {
    const { runChannelPluginStartupMaintenance } =
      await import("../channels/plugins/lifecycle-startup.js");
    const startupTasks = [
      runChannelPluginStartupMaintenance({
        cfg: startupMaintenanceConfig,
        env: process.env,
        log: params.log,
      }),
    ];
    if (!params.minimalTestGateway) {
      const { runStartupSessionMigration } = await import("./server-startup-session-migration.js");
      startupTasks.push(
        runStartupSessionMigration({
          cfg: params.cfgAtStart,
          env: process.env,
          log: params.log,
        }),
      );
      const { migrateLegacyDevicePairingStore } =
        await import("../infra/device-pairing-migration.js");
      const { migrateLegacyNodePairingStore } = await import("../infra/node-pairing-migration.js");
      startupTasks.push(
        // The device store import must complete before the node-surface fold:
        // the fold writes onto device records in SQLite and would drop every
        // legacy node row as an orphan if the devices were not imported yet.
        migrateLegacyDevicePairingStore({ log: params.log }).then(
          () =>
            migrateLegacyNodePairingStore({ log: params.log }).then(
              () => undefined,
              (error: unknown) => {
                // A failed fold must not block gateway startup; the legacy
                // files stay in place and the next boot retries.
                params.log.warn(`node pairing store migration failed: ${String(error)}`);
              },
            ),
          (error: unknown) => {
            params.log.warn(`device pairing store migration failed: ${String(error)}`);
          },
        ),
      );
    }
    await Promise.all(startupTasks);
  }
}

/** Builds plugin startup state and gateway method lists before the server binds. */
export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfgAtStart;
  initSubagentRegistry();

  // Activation uses the pre-runtime source so auto-enable policy cannot be skewed by
  // defaults injected while loading runtime config; runtime-only plugin config still merges in.
  const gatewayPluginConfig = params.minimalTestGateway
    ? params.cfgAtStart
    : resolveGatewayStartupPluginActivationConfig({
        runtimeConfig: params.cfgAtStart,
        activationSourceConfig,
        env: process.env,
        ...(params.pluginMetadataSnapshot?.manifestRegistry
          ? { manifestRegistry: params.pluginMetadataSnapshot.manifestRegistry }
          : {}),
        discovery: params.pluginMetadataSnapshot?.discovery,
        ambientEnvTriggers: params.ambientEnvTriggers,
      });
  const pluginsGloballyDisabled = gatewayPluginConfig.plugins?.enabled === false;
  const pluginWorkspaceDir = tryResolveConfiguredAgentWorkspaceDir(gatewayPluginConfig);
  const defaultWorkspaceDir = pluginWorkspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const pluginLookUpTable =
    params.minimalTestGateway || pluginsGloballyDisabled
      ? undefined
      : loadPluginLookUpTable({
          config: gatewayPluginConfig,
          workspaceDir: pluginWorkspaceDir,
          env: process.env,
          activationSourceConfig,
          metadataSnapshot: params.pluginMetadataSnapshot,
          workerProviderIds: params.workerProviderIds ?? [],
          ambientEnvTriggers: params.ambientEnvTriggers,
        });
  // Startup logging and lifecycle publication consume the process-stable metadata snapshot.
  // Minimal gateways skip runtime lookup-table construction, not metadata ownership.
  const pluginManifestRecords =
    pluginLookUpTable?.manifestRegistry.plugins ??
    params.pluginMetadataSnapshot?.manifestRegistry.plugins ??
    [];
  const startupPluginIds = [...(pluginLookUpTable?.startup.pluginIds ?? [])];
  const ambientAutostartSuppressedChannelIds =
    params.ambientEnvTriggers === "suppress"
      ? new Set(
          listAmbientOnlyConfiguredChannelIds({
            config: params.cfgAtStart,
            activationSourceConfig,
            env: process.env,
            includePersistedAuthState: false,
            manifestRecords: pluginManifestRecords,
          }),
        )
      : new Set<string>();

  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  // Minimal tests may reuse an active registry only while plugins are enabled. Production
  // publishes an empty pre-bind registry; startup plugin runtimes attach after the listener binds.
  const pluginRegistry =
    params.minimalTestGateway && !pluginsGloballyDisabled
      ? (getActivePluginRegistry() ?? emptyPluginRegistry)
      : emptyPluginRegistry;
  const metadataSnapshot =
    getGatewayPluginMetadataSnapshot() ??
    completePluginMetadataSnapshot({
      snapshot: pluginLookUpTable ?? params.pluginMetadataSnapshot,
      config: activationSourceConfig,
      env: process.env,
      workspaceDir: defaultWorkspaceDir,
    });
  // Requests can reach this registry before runtime attachment (or without it).
  // Carry the complete boot generation so cold capabilities never rediscover source plugins.
  setPluginRuntimeLoadContext(pluginRegistry, {
    rawConfig: params.cfgAtStart,
    config: gatewayPluginConfig,
    activationSourceConfig,
    autoEnabledReasons: {},
    workspaceDir: pluginWorkspaceDir,
    env: process.env,
    logger: params.log,
    metadataSnapshot,
    manifestRegistry: metadataSnapshot?.manifestRegistry,
    installRecords: metadataSnapshot
      ? extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index)
      : undefined,
    preferBuiltPluginArtifacts: true,
  });
  setActivePluginRegistry(pluginRegistry);

  return {
    gatewayPluginConfigAtStart: gatewayPluginConfig,
    defaultWorkspaceDir,
    pluginWorkspaceDir,
    startupPluginIds,
    pluginManifestRecords,
    pluginMetadataSnapshot: metadataSnapshot,
    pluginLookUpTable,
    baseMethods,
    pluginRegistry,
    baseGatewayMethods: baseMethods,
    ambientAutostartSuppressedChannelIds,
  };
}

/**
 * Warn when `memory.search.provider` selects a memory embedding provider
 * that no loaded plugin registered. Without the owning plugin, `active-memory`
 * cannot embed and silently falls back to keyword/FTS-only recall.
 */
export function warnUnregisteredConfiguredMemoryEmbeddingProviders(params: {
  config: OpenClawConfig;
  pluginRegistry: Partial<Pick<PluginRegistry, "embeddingProviders">>;
  log: Pick<GatewayPluginBootstrapLog, "warn">;
}): void {
  const unregistered = collectUnregisteredConfiguredMemoryEmbeddingProviders({
    config: params.config,
    registeredProviderIds: collectRegisteredEmbeddingProviderIds(params.pluginRegistry),
  });
  for (const provider of unregistered) {
    const path = `memory.search.${provider.source}`;
    params.log.warn(
      `${path}="${provider.configuredId}" is configured, but no loaded plugin registered a memory embedding provider that can serve "${provider.configuredId}". Semantic memory recall will fall back to keyword/FTS-only search. Ensure the plugin that provides "${provider.configuredId}" is installed and enabled.`,
    );
  }
}

/** Loads startup plugin runtimes after the gateway listener binds. */
export async function loadGatewayStartupPluginRuntime(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  log: GatewayPluginBootstrapLog;
  baseMethods: string[];
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  startupPluginIds: string[];
  pluginLookUpTable?: ReturnType<typeof loadPluginLookUpTable>;
  startupTrace?: GatewayStartupTrace;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  resolveGatewayContext?: GatewayContextResolver;
  pluginRuntimeClaim?: GatewayPluginRuntimeClaim;
  getCurrentPluginRegistry?: () => PluginRegistry;
}) {
  // Keep server-plugin-bootstrap behind one lazy boundary; startup config tests can exercise
  // planning without importing plugin package runtimes.
  const { loadGatewayStartupPlugins } = await import("./server-plugin-bootstrap.js");
  await params.pluginRuntimeClaim?.waitForUnblocked();
  if (params.pluginRuntimeClaim && !params.pluginRuntimeClaim.isCurrent()) {
    const currentPluginRegistry = params.getCurrentPluginRegistry?.();
    if (!currentPluginRegistry) {
      throw new Error("superseded Gateway startup cannot resolve the current plugin runtime");
    }
    return {
      pluginRegistry: currentPluginRegistry,
      gatewayMethods: params.baseMethods,
    };
  }
  const loaded = loadGatewayStartupPlugins({
    cfg: params.cfg,
    activationSourceConfig: params.activationSourceConfig,
    workspaceDir: params.workspaceDir,
    log: params.log,
    coreGatewayMethodNames: params.coreGatewayMethodNames ?? params.baseMethods,
    baseMethods: params.baseMethods,
    ...(params.hostServices !== undefined && {
      hostServices: params.hostServices,
    }),
    pluginIds: params.startupPluginIds,
    pluginLookUpTable: params.pluginLookUpTable,
    channelPluginLoadIntent: "full",
    startupTrace: params.startupTrace,
    ambientEnvTriggers: params.ambientEnvTriggers,
    ...(params.resolveGatewayContext
      ? { resolveGatewayContext: params.resolveGatewayContext }
      : {}),
  });
  warnUnregisteredConfiguredMemoryEmbeddingProviders({
    config: params.cfg,
    pluginRegistry: loaded.pluginRegistry,
    log: params.log,
  });
  return loaded;
}
