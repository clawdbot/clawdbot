// Gateway plugin startup bootstrap.
// Runs startup maintenance, loads plugin runtime, and prepares advertised methods.
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectRegisteredEmbeddingProviderIds,
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
  listAmbientOnlyConfiguredChannelIds,
} from "../plugins/channel-plugin-ids.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginRegistry, PluginRegistryParams } from "../plugins/registry-types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { listCoreGatewayMethodNames } from "./methods/core-descriptors.js";
import { resolveGatewayStartupPluginActivationConfig } from "./plugin-activation-runtime-config.js";
import { listGatewayMethods } from "./server-methods-list.js";

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

/** Builds plugin startup state and gateway method lists before the server binds. */
export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
  loadRuntimePlugins?: boolean;
  loadSetupRuntimePlugins?: boolean;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfgAtStart;
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
  const defaultAgentId = resolveDefaultAgentId(gatewayPluginConfig);
  const defaultWorkspaceDir = resolveAgentWorkspaceDir(gatewayPluginConfig, defaultAgentId);
  const pluginLookUpTable =
    params.minimalTestGateway || pluginsGloballyDisabled
      ? undefined
      : loadPluginLookUpTable({
          config: gatewayPluginConfig,
          workspaceDir: defaultWorkspaceDir,
          env: process.env,
          activationSourceConfig,
          metadataSnapshot: params.pluginMetadataSnapshot,
          workerProviderIds: params.workerProviderIds ?? [],
          ambientEnvTriggers: params.ambientEnvTriggers,
        });
  const deferredConfiguredChannelPluginIds = [
    ...(pluginLookUpTable?.startup.configuredDeferredChannelPluginIds ?? []),
  ];
  const startupPluginIds = [...(pluginLookUpTable?.startup.pluginIds ?? [])];
  const ambientAutostartSuppressedChannelIds =
    params.ambientEnvTriggers === "suppress"
      ? new Set(
          listAmbientOnlyConfiguredChannelIds({
            config: params.cfgAtStart,
            activationSourceConfig,
            env: process.env,
            includePersistedAuthState: false,
            ...(pluginLookUpTable?.manifestRegistry.plugins
              ? { manifestRecords: pluginLookUpTable.manifestRegistry.plugins }
              : {}),
          }),
        )
      : new Set<string>();

  const baseMethods = listGatewayMethods();
  const coreGatewayMethodNames = listCoreGatewayMethodNames();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  let pluginRegistry;
  let baseGatewayMethods = baseMethods;
  const shouldLoadRuntimePlugins = params.loadRuntimePlugins !== false;
  const shouldLoadSetupRuntimePlugins =
    params.loadSetupRuntimePlugins === true && deferredConfiguredChannelPluginIds.length > 0;

  if (!params.minimalTestGateway && shouldLoadSetupRuntimePlugins) {
    // Pre-bind bootstrap only loads deferred channel plugins that expose setup runtime hooks.
    // Full plugin handlers are loaded later so startup does not register duplicate methods.
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = await loadGatewayStartupPluginRuntime(
      {
        cfg: gatewayPluginConfig,
        activationSourceConfig,
        workspaceDir: defaultWorkspaceDir,
        log: params.log,
        baseMethods,
        coreGatewayMethodNames,
        startupPluginIds: deferredConfiguredChannelPluginIds,
        pluginLookUpTable,
        preferSetupRuntimeForChannelPlugins: true,
        suppressPluginInfoLogs: true,
        ambientEnvTriggers: params.ambientEnvTriggers,
      },
    ));
  } else if (!params.minimalTestGateway && shouldLoadRuntimePlugins) {
    // Normal bootstrap loads every startup plugin and records that runtime handlers are ready
    // before the gateway exposes the method list.
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = await loadGatewayStartupPluginRuntime(
      {
        cfg: gatewayPluginConfig,
        activationSourceConfig,
        workspaceDir: defaultWorkspaceDir,
        log: params.log,
        baseMethods,
        coreGatewayMethodNames,
        startupPluginIds,
        pluginLookUpTable,
        preferSetupRuntimeForChannelPlugins: false,
        suppressPluginInfoLogs: false,
        ambientEnvTriggers: params.ambientEnvTriggers,
      },
    ));
  } else {
    // Minimal gateway tests reuse an already-active registry when present; production no-load
    // paths install a fresh empty registry so stale plugin handlers cannot leak across starts.
    pluginRegistry = params.minimalTestGateway
      ? (getActivePluginRegistry() ?? emptyPluginRegistry)
      : emptyPluginRegistry;
    setActivePluginRegistry(pluginRegistry);
  }

  const runtimePluginsLoaded =
    !params.minimalTestGateway && shouldLoadRuntimePlugins && !shouldLoadSetupRuntimePlugins;

  return {
    gatewayPluginConfigAtStart: gatewayPluginConfig,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    pluginLookUpTable,
    baseMethods,
    pluginRegistry,
    baseGatewayMethods,
    runtimePluginsLoaded,
    ambientAutostartSuppressedChannelIds,
  };
}

/**
 * Warn when `agents.*.memorySearch.provider` selects a memory embedding provider
 * that no loaded plugin registered. Without the owning plugin, `active-memory`
 * cannot embed and silently falls back to keyword/FTS-only recall.
 */
export function warnUnregisteredConfiguredMemoryEmbeddingProviders(params: {
  config: OpenClawConfig;
  pluginRegistry: Partial<Pick<PluginRegistry, "embeddingProviders" | "memoryEmbeddingProviders">>;
  log: Pick<GatewayPluginBootstrapLog, "warn">;
}): void {
  const unregistered = collectUnregisteredConfiguredMemoryEmbeddingProviders({
    config: params.config,
    registeredProviderIds: collectRegisteredEmbeddingProviderIds(params.pluginRegistry),
  });
  for (const provider of unregistered) {
    const path = `memorySearch.${provider.source}`;
    params.log.warn(
      `${path}="${provider.configuredId}" is configured, but no loaded plugin registered a memory embedding provider that can serve "${provider.configuredId}". Semantic memory recall will fall back to keyword/FTS-only search. Ensure the plugin that provides "${provider.configuredId}" is installed and enabled.`,
    );
  }
}

/** Loads startup plugin runtimes through the deferred bootstrap boundary. */
export async function loadGatewayStartupPluginRuntime(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir: string;
  log: GatewayPluginBootstrapLog;
  baseMethods: string[];
  coreGatewayMethodNames?: readonly string[];
  hostServices?: PluginRegistryParams["hostServices"];
  startupPluginIds: string[];
  pluginLookUpTable?: ReturnType<typeof loadPluginLookUpTable>;
  preferSetupRuntimeForChannelPlugins?: boolean;
  suppressPluginInfoLogs?: boolean;
  startupTrace?: GatewayStartupTrace;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}) {
  // Keep server-plugin-bootstrap behind one lazy boundary; startup config tests can exercise
  // planning without importing plugin package runtimes.
  const { loadGatewayStartupPlugins } = await import("./server-plugin-bootstrap.js");
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
    preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
    suppressPluginInfoLogs: params.suppressPluginInfoLogs,
    startupTrace: params.startupTrace,
    ambientEnvTriggers: params.ambientEnvTriggers,
  });
  if (params.preferSetupRuntimeForChannelPlugins !== true) {
    // Surface configured memory embedding providers after the full startup
    // runtime load; setup-runtime pre-bind loads intentionally register only
    // early channel hooks and would produce false missing-provider warnings.
    warnUnregisteredConfiguredMemoryEmbeddingProviders({
      config: params.cfg,
      pluginRegistry: loaded.pluginRegistry,
      log: params.log,
    });
  }
  return loaded;
}
