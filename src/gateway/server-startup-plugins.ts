import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { initSubagentRegistry } from "../agents/subagent-registry.js";
import { runChannelPluginStartupMaintenance } from "../channels/plugins/lifecycle-startup.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpan } from "../infra/diagnostics-timeline.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { registerBundledRuntimeDependencyJitiAliases } from "../plugins/bundled-runtime-deps-jiti-aliases.js";
import {
  isSourceCheckoutRoot,
  pruneUnknownBundledRuntimeDepsRoots,
} from "../plugins/bundled-runtime-deps-roots.js";
import { repairBundledRuntimeDepsPackagePlanAsync } from "../plugins/bundled-runtime-deps.js";
import { prepareBundledPluginRuntimeLoadRoot } from "../plugins/bundled-runtime-root.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { mergeActivationSectionsIntoRuntimeConfig } from "./plugin-activation-runtime-config.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { loadGatewayStartupPlugins } from "./server-plugin-bootstrap.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

type GatewayPluginBootstrapLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

type GatewayBundledRuntimeDepsPrestageResult = {
  repairError?: unknown;
};

export function resolveGatewayStartupMaintenanceConfig(params: {
  cfgAtStart: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
}): OpenClawConfig {
  return params.cfgAtStart.channels === undefined &&
    params.startupRuntimeConfig.channels !== undefined
    ? {
        ...params.cfgAtStart,
        channels: params.startupRuntimeConfig.channels,
      }
    : params.cfgAtStart;
}

async function prestageGatewayBundledRuntimeDeps(params: {
  cfg: OpenClawConfig;
  manifestRegistry: PluginManifestRegistry;
  pluginIds: readonly string[];
  log: GatewayPluginBootstrapLog;
}): Promise<GatewayBundledRuntimeDepsPrestageResult> {
  return await measureDiagnosticsTimelineSpan(
    "runtimeDeps.stage",
    () => prestageGatewayBundledRuntimeDepsImpl(params),
    {
      phase: "startup",
      config: params.cfg,
      attributes: {
        pluginCount: params.pluginIds.length,
      },
    },
  );
}

async function prestageGatewayBundledRuntimeDepsImpl(params: {
  cfg: OpenClawConfig;
  manifestRegistry: PluginManifestRegistry;
  pluginIds: readonly string[];
  log: GatewayPluginBootstrapLog;
}): Promise<GatewayBundledRuntimeDepsPrestageResult> {
  if (params.pluginIds.length === 0) {
    return {};
  }
  let repairError: unknown;
  const packageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  if (packageRoot) {
    try {
      pruneUnknownBundledRuntimeDepsRoots({
        env: process.env,
        warn: (message) => params.log.warn(message),
      });
      const startedAt = Date.now();
      const result = await repairBundledRuntimeDepsPackagePlanAsync({
        packageRoot,
        config: params.cfg,
        exactPluginIds: params.pluginIds,
        env: process.env,
        warn: (message) => params.log.warn(message),
        onProgress: (message) => params.log.info(message),
      });
      if (result.repairedSpecs.length > 0) {
        params.log.info(
          `[plugins] prepared bundled runtime dependencies before gateway startup in ${Date.now() - startedAt}ms: ${result.repairedSpecs.join(", ")}`,
        );
      } else if (result.reusedSpecs && result.reusedSpecs.length > 0) {
        params.log.info(
          `[plugins] reused bundled runtime dependencies before gateway startup in ${Date.now() - startedAt}ms: ${result.reusedSpecs.join(", ")}`,
        );
      }
    } catch (error) {
      repairError = error;
      params.log.warn(
        `[plugins] bundled runtime dependency staging failed; plugin load will verify without synchronous repair: ${String(error)}`,
      );
    }
  }
  prestageGatewayBundledRuntimeMirrors({
    ...params,
    ...(packageRoot ? { packageRoot } : {}),
    previousRepairError: repairError,
  });
  return repairError === undefined ? {} : { repairError };
}

function prestageGatewayBundledRuntimeMirrors(params: {
  cfg: OpenClawConfig;
  manifestRegistry: PluginManifestRegistry;
  pluginIds: readonly string[];
  log: GatewayPluginBootstrapLog;
  packageRoot?: string;
  previousRepairError?: unknown;
}): void {
  const pluginIdSet = new Set(params.pluginIds);
  const allowSourceCheckoutRepair =
    params.previousRepairError === undefined &&
    typeof params.packageRoot === "string" &&
    isSourceCheckoutRoot(params.packageRoot);
  const startedAt = Date.now();
  const preparedPluginIds: string[] = [];
  for (const record of params.manifestRegistry.plugins) {
    if (record.origin !== "bundled" || !pluginIdSet.has(record.id)) {
      continue;
    }
    try {
      prepareBundledPluginRuntimeLoadRoot({
        pluginId: record.id,
        pluginRoot: record.rootDir,
        modulePath: record.source,
        ...(record.setupSource ? { setupModulePath: record.setupSource } : {}),
        env: process.env,
        config: params.cfg,
        installMissingDeps: allowSourceCheckoutRepair,
        previousRepairError: params.previousRepairError,
        memoizePreparedRoot: true,
        registerRuntimeAliasRoot: registerBundledRuntimeDependencyJitiAliases,
        logInstalled: (installedSpecs) => {
          params.log.info(
            `[plugins] ${record.id} installed bundled runtime deps in source checkout pre-stage: ${installedSpecs.join(", ")}`,
          );
        },
      });
      preparedPluginIds.push(record.id);
    } catch (error) {
      params.log.warn(
        `[plugins] bundled runtime mirror prep for ${record.id} failed; plugin load will verify without synchronous repair: ${String(error)}`,
      );
    }
  }
  if (preparedPluginIds.length > 0) {
    params.log.info(
      `[plugins] prepared bundled runtime roots before gateway startup in ${Date.now() - startedAt}ms: ${preparedPluginIds.join(", ")}`,
    );
  }
}

export async function prepareGatewayPluginBootstrap(params: {
  cfgAtStart: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  startupRuntimeConfig: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  minimalTestGateway: boolean;
  log: GatewayPluginBootstrapLog;
  loadRuntimePlugins?: boolean;
}) {
  const activationSourceConfig = params.activationSourceConfig ?? params.cfgAtStart;
  const startupMaintenanceConfig = resolveGatewayStartupMaintenanceConfig({
    cfgAtStart: params.cfgAtStart,
    startupRuntimeConfig: params.startupRuntimeConfig,
  });

  const shouldRunStartupMaintenance =
    !params.minimalTestGateway || startupMaintenanceConfig.channels !== undefined;
  if (shouldRunStartupMaintenance) {
    const startupTasks = [
      runChannelPluginStartupMaintenance({
        cfg: startupMaintenanceConfig,
        env: process.env,
        log: params.log,
      }),
    ];
    if (!params.minimalTestGateway) {
      startupTasks.push(
        runStartupSessionMigration({
          cfg: params.cfgAtStart,
          env: process.env,
          log: params.log,
        }),
      );
    }
    await Promise.all(startupTasks);
  }

  initSubagentRegistry();

  const gatewayPluginConfig = params.minimalTestGateway
    ? params.cfgAtStart
    : mergeActivationSectionsIntoRuntimeConfig({
        runtimeConfig: params.cfgAtStart,
        activationConfig: applyPluginAutoEnable({
          config: activationSourceConfig,
          env: process.env,
          ...(params.pluginMetadataSnapshot?.manifestRegistry
            ? { manifestRegistry: params.pluginMetadataSnapshot.manifestRegistry }
            : {}),
        }).config,
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
        });
  const deferredConfiguredChannelPluginIds = [
    ...(pluginLookUpTable?.startup.configuredDeferredChannelPluginIds ?? []),
  ];
  const startupPluginIds = [...(pluginLookUpTable?.startup.pluginIds ?? [])];

  const baseMethods = listGatewayMethods();
  const emptyPluginRegistry = createEmptyPluginRegistry();
  let pluginRegistry = emptyPluginRegistry;
  let baseGatewayMethods = baseMethods;
  const shouldLoadRuntimePlugins = params.loadRuntimePlugins !== false;

  if (!params.minimalTestGateway && shouldLoadRuntimePlugins) {
    ({ pluginRegistry, gatewayMethods: baseGatewayMethods } = await loadGatewayStartupPluginRuntime(
      {
        cfg: gatewayPluginConfig,
        activationSourceConfig,
        workspaceDir: defaultWorkspaceDir,
        log: params.log,
        baseMethods,
        startupPluginIds,
        pluginLookUpTable,
        preferSetupRuntimeForChannelPlugins: deferredConfiguredChannelPluginIds.length > 0,
        suppressPluginInfoLogs: deferredConfiguredChannelPluginIds.length > 0,
      },
    ));
  } else {
    pluginRegistry = params.minimalTestGateway
      ? (getActivePluginRegistry() ?? emptyPluginRegistry)
      : emptyPluginRegistry;
    setActivePluginRegistry(pluginRegistry);
  }

  return {
    gatewayPluginConfigAtStart: gatewayPluginConfig,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    pluginLookUpTable,
    baseMethods,
    pluginRegistry,
    baseGatewayMethods,
    runtimePluginsLoaded: !params.minimalTestGateway && shouldLoadRuntimePlugins,
  };
}

export async function loadGatewayStartupPluginRuntime(params: {
  cfg: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir: string;
  log: GatewayPluginBootstrapLog;
  baseMethods: string[];
  startupPluginIds: string[];
  pluginLookUpTable?: ReturnType<typeof loadPluginLookUpTable>;
  preferSetupRuntimeForChannelPlugins?: boolean;
  suppressPluginInfoLogs?: boolean;
}) {
  const prestageResult = await prestageGatewayBundledRuntimeDeps({
    cfg: params.cfg,
    manifestRegistry: params.pluginLookUpTable?.manifestRegistry ?? {
      plugins: [],
      diagnostics: [],
    },
    pluginIds: params.startupPluginIds,
    log: params.log,
  });
  return loadGatewayStartupPlugins({
    cfg: params.cfg,
    activationSourceConfig: params.activationSourceConfig,
    workspaceDir: params.workspaceDir,
    log: params.log,
    coreGatewayMethodNames: params.baseMethods,
    baseMethods: params.baseMethods,
    pluginIds: params.startupPluginIds,
    pluginLookUpTable: params.pluginLookUpTable,
    installBundledRuntimeDeps: false,
    bundledRuntimeDepsRepairError: prestageResult.repairError,
    preferSetupRuntimeForChannelPlugins: params.preferSetupRuntimeForChannelPlugins,
    suppressPluginInfoLogs: params.suppressPluginInfoLogs,
  });
}
